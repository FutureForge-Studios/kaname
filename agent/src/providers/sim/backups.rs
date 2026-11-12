//! Backups.
//!
//! A restic-shaped repository with a month of history, so retention
//! policies have something to bite on and a restore has somewhere to
//! restore from. A repository the panel has never mentioned before is
//! seeded on first contact rather than answered with an empty list: an
//! operator wiring up a new destination should see what a populated one
//! looks like.
//!
//! The restic verbs refuse a `password_ref` that `backup.secret_put` has
//! not provisioned, as the real agent does when the file is missing, so a
//! control plane that forgets to provision fails in development rather
//! than first on a real host. Only the reference is remembered.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use super::databases::find_database;
use super::files::{MemFs, Node, clean_path, count_nodes, path_base, path_dir, path_join, tree_size};
use super::state::{GIB, MIB, Sim, World, hash_string, mix, progress, stamp};
use crate::providers::backup_secret::{check_secret_put, check_secret_ref};
use crate::providers::{
    BackupListParams, BackupPruneParams, BackupPruneResult, BackupRestoreParams, BackupRestoreResult,
    BackupRunParams, BackupSecretDeleteParams, BackupSecretDeleteResult, BackupSecretPutParams,
    BackupSecretPutResult, BackupSnapshotInfo, BackupVerifyParams, BackupVerifyResult, Backups, Ctx, PResult,
    ProviderError, StreamRef,
};

const SEEDED_SNAPSHOTS: usize = 14;

pub fn build_backups(sim: &Sim) {
    sim.world.lock().snapshots.clear();
}

/// Materialises a repository's history the first time it is asked for.
fn snapshots_for(sim: &Sim, w: &mut World, repository: &str) -> Vec<BackupSnapshotInfo> {
    if let Some(existing) = w.snapshots.get(repository) {
        return existing.clone();
    }

    let now = Utc::now();
    let seed = sim.seed ^ hash_string(repository);
    let history: Vec<BackupSnapshotInfo> = (0..SEEDED_SNAPSHOTS)
        .map(|i| {
            let iu = i as u64;
            let taken = now
                - chrono::Duration::days(i as i64)
                - chrono::Duration::seconds((mix(seed ^ iu) % 5400) as i64);
            let tags: Vec<String> = if i == 0 {
                vec!["nightly".into(), "latest".into()]
            } else if i % 7 == 0 {
                vec!["weekly".into()]
            } else {
                vec!["nightly".into()]
            };
            BackupSnapshotInfo {
                id: format!("{:016x}{:016x}", mix(seed ^ iu ^ 0xe1), mix(seed ^ iu ^ 0xe2)),
                taken_at: stamp(taken),
                bytes: 18 * GIB - i as i64 * (mix(seed ^ iu ^ 0xe3) % (512 * MIB) as u64) as i64,
                file_count: 184_000 + (mix(seed ^ iu ^ 0xe4) % 22_000) as i64,
                paths: vec!["/etc".into(), "/var/www".into(), "/srv".into(), "/home".into()],
                tags,
                verified: i % 7 == 0,
            }
        })
        .collect();

    w.snapshots.insert(repository.to_string(), history.clone());
    history
}

fn excluded(target: &str, patterns: &[String]) -> bool {
    patterns
        .iter()
        .filter(|p| !p.is_empty())
        .any(|p| target.starts_with(p.trim_end_matches('*')))
}

fn find_snapshot(history: &[BackupSnapshotInfo], id: &str) -> Option<usize> {
    history
        .iter()
        .position(|s| s.id == id || (!id.is_empty() && s.id.starts_with(id)))
}

/// What one restore wrote and what it left alone.
#[derive(Default, Debug)]
struct Merge {
    written: i64,
    kept: i64,
    bytes: i64,
}

/// The part of a captured snapshot that `member` names: the captured
/// root itself, or a subtree of it when `include` asked for less.
fn snapshot_member(trees: &[(String, Node)], member: &str) -> Option<Node> {
    for (root, tree) in trees {
        if member == root {
            return Some(tree.clone());
        }
        let prefix = if root == "/" {
            "/".to_string()
        } else {
            format!("{root}/")
        };
        if let Some(rest) = member.strip_prefix(&prefix) {
            let mut cur = tree;
            for segment in rest.split('/').filter(|s| !s.is_empty()) {
                cur = cur.children.get(segment)?;
            }
            return Some(cur.clone());
        }
    }
    None
}

/// Writes `source` at `dest` the way `restic restore` does: directories
/// are merged rather than replaced, files the host already has are only
/// replaced when `overwrite` is set, and nothing extra is ever deleted.
/// Ignoring `overwrite` here is what made the "safe" restore in the panel
/// a lie: it said existing files were kept and then wrote over them.
fn merge_into(fs: &mut MemFs, source: &Node, dest: &str, overwrite: bool, out: &mut Merge) {
    let existing_kind = fs.lookup(dest, false).ok().map(|(n, _)| n.kind.clone());
    if source.is_dir() {
        match existing_kind.as_deref() {
            Some("directory") | None => {}
            Some(_) if !overwrite => {
                out.kept += 1;
                return;
            }
            Some(_) => {
                fs.detach(dest);
            }
        }
        let dir = fs.mkdir_all(dest);
        dir.mode = source.mode.clone();
        dir.owner = source.owner.clone();
        dir.group = source.group.clone();
        dir.uid = source.uid;
        dir.gid = source.gid;
        for (name, child) in &source.children {
            merge_into(fs, child, &path_join(dest, name), overwrite, out);
        }
        return;
    }

    if existing_kind.is_some() && !overwrite {
        out.kept += 1;
        return;
    }
    let mut copy = source.clone();
    copy.name = path_base(dest);
    out.bytes += copy.size();
    out.written += 1;
    fs.mkdir_all(&path_dir(dest))
        .children
        .insert(path_base(dest), copy);
}

/// The restore's own marker obeys the same rule as every other file, but
/// is not counted: it is the simulator's evidence, not snapshot content.
fn write_marker(fs: &mut MemFs, path: &str, content: &str, overwrite: bool) {
    if fs.lookup(path, false).is_ok() && !overwrite {
        return;
    }
    fs.file(path, content);
}

pub struct SimBackups(pub Arc<Sim>);

impl SimBackups {
    /// The simulator's `environment()`: the same reference rules, and the
    /// same refusal when nothing was provisioned under that name.
    fn require_secret(&self, password_ref: &str) -> PResult<()> {
        check_secret_ref(password_ref)?;
        if self.0.world.lock().backup_secrets.contains(password_ref) {
            return Ok(());
        }
        Err(ProviderError::PreconditionFailed(format!(
            "no backup secret named {password_ref:?} provisioned on this host; the control plane \
             provisions it (backup.secret_put) before each backup job"
        )))
    }
}

#[async_trait]
impl Backups for SimBackups {
    async fn run(&self, ctx: &Ctx, p: BackupRunParams, s: StreamRef) -> PResult<BackupSnapshotInfo> {
        self.require_secret(&p.password_ref)?;
        let paths = if p.paths.is_empty() {
            vec!["/etc".to_string(), "/var/www".to_string()]
        } else {
            p.paths.clone()
        };

        progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("open repository {}", p.repository),
        )
        .await?;
        progress(ctx, &*s, Duration::from_millis(240), "lock repository").await?;
        progress(ctx, &*s, Duration::from_millis(240), "load index files").await?;

        let mut files: i64 = 0;
        let mut bytes: i64 = 0;
        let mut captured: Vec<(String, Node)> = Vec::new();
        for target in &paths {
            let cleaned = clean_path(target)?;
            if excluded(&cleaned, &p.exclude) {
                let _ = progress(ctx, &*s, Duration::ZERO, format!("skipping {cleaned} (excluded)")).await;
                continue;
            }
            // The tree is kept, not just counted: a restore has to be able
            // to tell "this file was in the snapshot" from "this file is on
            // the host now" for `overwrite` to mean anything.
            let (count, size) = {
                let fs = self.0.fs.read();
                let (n, _) = fs.lookup(&cleaned, true)?;
                captured.push((cleaned.clone(), n.clone()));
                (count_nodes(n), tree_size(n))
            };
            files += count;
            bytes += size;
            progress(
                ctx,
                &*s,
                Duration::from_millis(260),
                format!("scan {cleaned}: {count} files, {size} bytes"),
            )
            .await?;
        }

        for database in &p.databases {
            progress(
                ctx,
                &*s,
                Duration::from_millis(300),
                format!(
                    "dump {} database {:?} into the snapshot",
                    database.engine, database.name
                ),
            )
            .await?;
            let w = self.0.world.lock();
            if let Some(db) = find_database(&w, &database.engine, &database.name) {
                bytes += db.size_bytes / 8;
                files += 1;
            }
        }

        let now = Utc::now();
        let nanos = now.timestamp_nanos_opt().unwrap_or(0) as u64;
        let snapshot = BackupSnapshotInfo {
            id: format!(
                "{:016x}{:016x}",
                mix(self.0.seed ^ nanos),
                mix(self.0.seed ^ nanos ^ 0x77)
            ),
            taken_at: stamp(now),
            bytes,
            file_count: files,
            paths,
            tags: p.tags.clone(),
            verified: false,
        };

        {
            let mut w = self.0.world.lock();
            let mut history = snapshots_for(&self.0, &mut w, &p.repository);
            history.insert(0, snapshot.clone());
            w.snapshots.insert(p.repository.clone(), history);
            w.snapshot_trees.insert(snapshot.id.clone(), captured);
        }

        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("processed {files} files, {bytes} bytes"),
        )
        .await;
        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("snapshot {} saved", &snapshot.id[..8]),
        )
        .await;
        Ok(snapshot)
    }

    async fn list(&self, _ctx: &Ctx, p: BackupListParams) -> PResult<Vec<BackupSnapshotInfo>> {
        self.require_secret(&p.password_ref)?;
        let mut w = self.0.world.lock();
        let mut out = snapshots_for(&self.0, &mut w, &p.repository);
        out.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
        Ok(out)
    }

    async fn restore(&self, ctx: &Ctx, p: BackupRestoreParams, s: StreamRef) -> PResult<BackupRestoreResult> {
        self.require_secret(&p.password_ref)?;
        let target = clean_path(&p.target)?;

        let snapshot = {
            let mut w = self.0.world.lock();
            let history = snapshots_for(&self.0, &mut w, &p.repository);
            match find_snapshot(&history, &p.snapshot_id) {
                Some(idx) => history[idx].clone(),
                None => return Err(ProviderError::not_found(format!("snapshot {}", p.snapshot_id))),
            }
        };

        let restoring = if p.include.is_empty() {
            snapshot.paths.clone()
        } else {
            p.include.clone()
        };

        progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("repository {} opened successfully", p.repository),
        )
        .await?;
        progress(
            ctx,
            &*s,
            Duration::from_millis(220),
            format!("restoring snapshot {} to {target}", &snapshot.id[..8]),
        )
        .await?;

        // What the snapshot holds for each member, resolved before the
        // filesystem lock is taken (the world lock always comes first).
        let trees = self
            .0
            .world
            .lock()
            .snapshot_trees
            .get(&snapshot.id)
            .cloned()
            .unwrap_or_default();

        let mut outcome = Merge::default();
        for member in &restoring {
            progress(
                ctx,
                &*s,
                Duration::from_millis(280),
                format!("restoring {member}"),
            )
            .await?;

            let before = (outcome.written, outcome.kept);
            {
                let mut fs = self.0.fs.write();
                let destination = if &target == member {
                    target.clone()
                } else {
                    format!("{target}{member}")
                };
                // A snapshot taken by this agent restores what it captured.
                // The seeded history captured nothing, so it restores what
                // is on the host at that path now, which is the closest
                // honest stand-in for "the files as they were".
                let source = snapshot_member(&trees, member)
                    .or_else(|| fs.lookup(member, true).ok().map(|(n, _)| n.clone()));
                if let Some(source) = source {
                    merge_into(&mut fs, &source, &destination, p.overwrite, &mut outcome);
                } else {
                    fs.mkdir_all(&destination);
                }
                let marker = format!("{destination}/.restored-from");
                let content = format!("snapshot {} taken {}\n", snapshot.id, snapshot.taken_at);
                write_marker(&mut fs, &marker, &content, p.overwrite);
            }
            let _ = progress(
                ctx,
                &*s,
                Duration::ZERO,
                format!(
                    "{member}: {} written, {} already present and kept",
                    outcome.written - before.0,
                    outcome.kept - before.1
                ),
            )
            .await;
        }

        let files = outcome.written;
        let bytes = outcome.bytes;
        let kept = if p.overwrite {
            String::new()
        } else {
            format!(
                "; {} existing file(s) kept because overwrite is off",
                outcome.kept
            )
        };
        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("restored {files} files ({bytes} bytes) to {target}{kept}"),
        )
        .await;
        Ok(BackupRestoreResult {
            restored_files: files,
            bytes,
        })
    }

    async fn verify(&self, ctx: &Ctx, p: BackupVerifyParams, s: StreamRef) -> PResult<BackupVerifyResult> {
        self.require_secret(&p.password_ref)?;
        let (index, snapshot) = {
            let mut w = self.0.world.lock();
            let history = snapshots_for(&self.0, &mut w, &p.repository);
            match find_snapshot(&history, &p.snapshot_id) {
                Some(idx) => (idx, history[idx].clone()),
                None => return Err(ProviderError::not_found(format!("snapshot {}", p.snapshot_id))),
            }
        };

        for step in [
            "create exclusive lock for repository".to_string(),
            "load indexes".to_string(),
            "check all packs".to_string(),
            "check snapshots, trees and blobs".to_string(),
            format!(
                "read {} blobs of snapshot {}",
                snapshot.file_count / 40,
                &snapshot.id[..8]
            ),
        ] {
            progress(ctx, &*s, Duration::from_millis(260), step).await?;
        }

        {
            let mut w = self.0.world.lock();
            if let Some(history) = w.snapshots.get_mut(&p.repository) {
                if let Some(entry) = history.get_mut(index) {
                    entry.verified = true;
                }
            }
        }

        let _ = progress(ctx, &*s, Duration::ZERO, "no errors were found").await;
        Ok(BackupVerifyResult {
            ok: true,
            errors: vec![],
        })
    }

    /// Applies the retention policy for real, newest first, so a policy
    /// that would delete everything visibly does.
    async fn prune(&self, ctx: &Ctx, p: BackupPruneParams, s: StreamRef) -> PResult<BackupPruneResult> {
        self.require_secret(&p.password_ref)?;
        progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("repository {} opened successfully", p.repository),
        )
        .await?;
        progress(
            ctx,
            &*s,
            Duration::from_millis(240),
            format!(
                "applying retention policy: last={} daily={} weekly={} monthly={}",
                p.keep_last, p.keep_daily, p.keep_weekly, p.keep_monthly
            ),
        )
        .await?;

        let removed: Vec<BackupSnapshotInfo> = {
            let mut w = self.0.world.lock();
            let mut sorted = snapshots_for(&self.0, &mut w, &p.repository);
            sorted.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));

            let mut keep = p.keep_last + p.keep_daily;
            if p.keep_weekly > 0 {
                keep += p.keep_weekly;
            }
            if p.keep_monthly > 0 {
                keep += p.keep_monthly;
            }
            let keep = keep.clamp(0, sorted.len() as i64) as usize;
            let removed = sorted.split_off(keep);
            w.snapshots.insert(p.repository.clone(), sorted);
            for gone in &removed {
                w.snapshot_trees.remove(&gone.id);
            }
            removed
        };

        let mut reclaimed: i64 = 0;
        for snapshot in &removed {
            // Deduplication means removing a snapshot frees far less than
            // it claims to hold; reporting the full size would flatter the
            // number.
            reclaimed += snapshot.bytes / 12;
            progress(
                ctx,
                &*s,
                Duration::from_millis(90),
                format!("remove snapshot {}", &snapshot.id[..8]),
            )
            .await?;
        }

        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("removed {} snapshots, {reclaimed} bytes reclaimed", removed.len()),
        )
        .await;
        Ok(BackupPruneResult {
            removed: removed.len() as i64,
            reclaimed_bytes: reclaimed,
        })
    }

    async fn secret_put(&self, _ctx: &Ctx, p: BackupSecretPutParams) -> PResult<BackupSecretPutResult> {
        check_secret_put(&p)?;
        self.0.world.lock().backup_secrets.insert(p.reference.clone());
        Ok(BackupSecretPutResult {
            reference: p.reference,
        })
    }

    async fn secret_delete(
        &self,
        _ctx: &Ctx,
        p: BackupSecretDeleteParams,
    ) -> PResult<BackupSecretDeleteResult> {
        check_secret_ref(&p.reference)?;
        let removed = self.0.world.lock().backup_secrets.remove(&p.reference);
        Ok(BackupSecretDeleteResult {
            reference: p.reference,
            removed,
        })
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::providers::{Encoding, Options, Stream, StreamRef};

    /// Swallows the narration; these tests read the filesystem instead.
    struct Quiet;

    #[async_trait]
    impl Stream for Quiet {
        async fn send(&self, _data: &[u8], _enc: Encoding) -> PResult<()> {
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    fn quiet() -> StreamRef {
        Arc::new(Quiet)
    }

    fn read(sim: &Sim, path: &str) -> String {
        let fs = sim.fs.read();
        let (node, _) = fs.lookup(path, true).expect(path);
        String::from_utf8_lossy(&node.data).into_owned()
    }

    async fn provision(backups: &SimBackups, reference: &str) {
        backups
            .secret_put(
                &Ctx::background(),
                BackupSecretPutParams {
                    reference: reference.into(),
                    password: "correct-horse-battery-staple".into(),
                    env: Default::default(),
                },
            )
            .await
            .expect("secret_put");
    }

    fn restore(snapshot_id: &str, target: &str, overwrite: bool) -> BackupRestoreParams {
        BackupRestoreParams {
            repository: "/var/backups/test".into(),
            password_ref: "nightly".into(),
            snapshot_id: snapshot_id.into(),
            target: target.into(),
            include: vec![],
            overwrite,
        }
    }

    /// packages/db/src/seed.ts (`simSnapshotId`) writes restore points
    /// naming these exact ids for the seeded schedules; if this history
    /// changes shape, the seed must change with it or every seeded point
    /// fails to verify. The expected values are what seed.ts computes.
    #[tokio::test]
    async fn seeded_history_matches_the_demo_seed() {
        for (host, index, expected) in [
            ("forge-01", 0, "7785b13c60c5778f86d54ded9b8521aa"),
            ("db-01", 3, "91408c93699609398cfc4f52b21831dc"),
        ] {
            let sim = Sim::new(Options {
                agent_version: "0.1.0".into(),
                state_dir: std::env::temp_dir().join(host),
            });
            let repository = format!("b2:futureforge-backups:kaname/{host}");
            let history = snapshots_for(&sim, &mut sim.world.lock(), &repository);
            assert_eq!(history[index].id, expected, "{host} snapshot {index}");
        }
    }

    /// `overwrite: false` keeps what the host already has and only fills
    /// the gaps; `overwrite: true` puts the snapshot's own bytes back, even
    /// over a file edited after the snapshot was taken.
    #[tokio::test]
    async fn restore_honours_overwrite() {
        let sim = Sim::new(Options {
            agent_version: "0.1.0".into(),
            state_dir: std::env::temp_dir().join("kaname-sim-test-restore-overwrite"),
        });
        let backups = SimBackups(sim.clone());
        let ctx = Ctx::background();
        let original = read(&sim, "/etc/hostname");
        provision(&backups, "nightly").await;

        let snapshot = backups
            .run(
                &ctx,
                BackupRunParams {
                    repository: "/var/backups/test".into(),
                    password_ref: "nightly".into(),
                    paths: vec!["/etc".into()],
                    exclude: vec![],
                    tags: vec![],
                    databases: vec![],
                },
                quiet(),
            )
            .await
            .expect("backup runs");

        // After the snapshot: the live file changes, and the restore target
        // already holds a file of its own at the same relative path.
        sim.fs.write().file("/etc/hostname", "edited-after-backup\n");
        sim.fs.write().file("/srv/r/etc/hostname", "already-here\n");

        let kept = backups
            .restore(&ctx, restore(&snapshot.id, "/srv/r", false), quiet())
            .await
            .expect("restore without overwrite");
        assert_eq!(read(&sim, "/srv/r/etc/hostname"), "already-here\n");
        assert!(kept.restored_files > 0, "the missing files are still written");
        assert!(sim.fs.read().lookup("/srv/r/etc/os-release", true).is_ok());

        let replaced = backups
            .restore(&ctx, restore(&snapshot.id, "/srv/r", true), quiet())
            .await
            .expect("restore with overwrite");
        assert_eq!(read(&sim, "/srv/r/etc/hostname"), original);
        assert!(replaced.restored_files > kept.restored_files);

        // In place: without overwrite the edit survives, with it the
        // snapshot's content comes back rather than today's.
        backups
            .restore(&ctx, restore(&snapshot.id, "/etc", false), quiet())
            .await
            .expect("in-place restore without overwrite");
        assert_eq!(read(&sim, "/etc/hostname"), "edited-after-backup\n");
        backups
            .restore(&ctx, restore(&snapshot.id, "/etc", true), quiet())
            .await
            .expect("in-place restore with overwrite");
        assert_eq!(read(&sim, "/etc/hostname"), original);
    }

    /// A reference nobody provisioned is refused the way a missing file is
    /// on a real host; after `secret_put` the same call goes through, and
    /// after `secret_delete` it is refused again.
    #[tokio::test]
    async fn restic_verbs_need_a_provisioned_secret() {
        let sim = Sim::new(Options {
            agent_version: "0.1.0".into(),
            state_dir: std::env::temp_dir().join("kaname-sim-test-backup-secret"),
        });
        let backups = SimBackups(sim.clone());
        let ctx = Ctx::background();
        let reference = "backup_schedule.0d6c3a52-8a9b-4c5e-9f00-1234567890ab";
        let list = || BackupListParams {
            repository: "/var/backups/test".into(),
            password_ref: reference.into(),
        };

        let err = backups.list(&ctx, list()).await.expect_err("unprovisioned");
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        assert!(err.to_string().contains("no backup secret"), "{err}");
        let err = backups
            .prune(
                &ctx,
                BackupPruneParams {
                    repository: "/var/backups/test".into(),
                    password_ref: reference.into(),
                    keep_last: 1,
                    ..Default::default()
                },
                quiet(),
            )
            .await
            .expect_err("unprovisioned prune");
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");

        // The reference rules are the real agent's.
        for bad in ["backup_schedule:1", "../x", ".hidden", "x.env"] {
            let err = backups
                .list(
                    &ctx,
                    BackupListParams {
                        repository: "r".into(),
                        password_ref: bad.into(),
                    },
                )
                .await
                .expect_err(bad);
            assert!(matches!(err, ProviderError::InvalidParams(_)), "{bad}: {err}");
        }

        let put = backups
            .secret_put(
                &ctx,
                BackupSecretPutParams {
                    reference: reference.into(),
                    password: "p\nq".into(),
                    env: Default::default(),
                },
            )
            .await
            .expect_err("a password with a line break");
        assert!(!put.to_string().contains("p\nq"));

        provision(&backups, reference).await;
        assert!(!backups.list(&ctx, list()).await.expect("provisioned").is_empty());

        let removed = backups
            .secret_delete(
                &ctx,
                BackupSecretDeleteParams {
                    reference: reference.into(),
                },
            )
            .await
            .unwrap();
        assert!(removed.removed);
        let again = backups
            .secret_delete(
                &ctx,
                BackupSecretDeleteParams {
                    reference: reference.into(),
                },
            )
            .await
            .unwrap();
        assert!(!again.removed, "deleting twice is not an error");
        assert!(backups.list(&ctx, list()).await.is_err());
    }
}
