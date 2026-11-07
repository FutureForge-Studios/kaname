//! Backups.
//!
//! A restic-shaped repository with a month of history, so retention
//! policies have something to bite on and a restore has somewhere to
//! restore from. A repository the panel has never mentioned before is
//! seeded on first contact rather than answered with an empty list: an
//! operator wiring up a new destination should see what a populated one
//! looks like.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use super::databases::find_database;
use super::files::{clean_path, count_nodes, tree_size};
use super::state::{GIB, MIB, Sim, World, hash_string, mix, progress, stamp};
use crate::providers::{
    BackupListParams, BackupPruneParams, BackupPruneResult, BackupRestoreParams, BackupRestoreResult,
    BackupRunParams, BackupSnapshotInfo, BackupVerifyParams, BackupVerifyResult, Backups, Ctx, PResult,
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

pub struct SimBackups(pub Arc<Sim>);

#[async_trait]
impl Backups for SimBackups {
    async fn run(&self, ctx: &Ctx, p: BackupRunParams, s: StreamRef) -> PResult<BackupSnapshotInfo> {
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
        for target in &paths {
            let cleaned = clean_path(target)?;
            let (count, size) = {
                let fs = self.0.fs.read();
                let (n, _) = fs.lookup(&cleaned, true)?;
                (count_nodes(n), tree_size(n))
            };
            if excluded(&cleaned, &p.exclude) {
                let _ = progress(ctx, &*s, Duration::ZERO, format!("skipping {cleaned} (excluded)")).await;
                continue;
            }
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
        let mut w = self.0.world.lock();
        let mut out = snapshots_for(&self.0, &mut w, &p.repository);
        out.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
        Ok(out)
    }

    async fn restore(&self, ctx: &Ctx, p: BackupRestoreParams, s: StreamRef) -> PResult<BackupRestoreResult> {
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

        let mut files: i64 = 0;
        let mut bytes: i64 = 0;
        let members = restoring.len().max(1) as i64;
        let share = snapshot.file_count / members;

        for member in &restoring {
            progress(
                ctx,
                &*s,
                Duration::from_millis(280),
                format!("restoring {member}"),
            )
            .await?;
            files += share;
            bytes += snapshot.bytes / members;

            let mut fs = self.0.fs.write();
            let destination = if &target == member {
                target.clone()
            } else {
                format!("{target}{member}")
            };
            fs.mkdir_all(&destination);
            fs.file(
                &format!("{destination}/.restored-from"),
                &format!("snapshot {} taken {}\n", snapshot.id, snapshot.taken_at),
            );
        }

        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("restored {files} files ({bytes} bytes) to {target}"),
        )
        .await;
        Ok(BackupRestoreResult {
            restored_files: files,
            bytes,
        })
    }

    async fn verify(&self, ctx: &Ctx, p: BackupVerifyParams, s: StreamRef) -> PResult<BackupVerifyResult> {
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
}
