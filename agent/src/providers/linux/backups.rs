//! Backups.
//!
//! restic does the work. The repository password and the destination's
//! credentials live in files under the agent's state directory
//! (`backup-secrets/<ref>` and `backup-secrets/<ref>.env`, root-owned,
//! 0600 in a 0700 directory), and the restic verbs name them only by
//! reference. The control plane, which keeps them envelope-encrypted at
//! rest, sends them once per job over the mTLS socket in the typed,
//! write-only `backup.secret_put`, right before the restic verbs run:
//! nothing ever returns them, they never appear in an argv (restic reads
//! `RESTIC_PASSWORD_FILE` and its environment), and the `.env` file holds
//! only a closed set of keys. Keeping the files on the host is deliberate:
//! a host whose control plane is gone can still be restored by hand.
//!
//! Every write goes through a descriptor for the secrets directory opened
//! with `O_NOFOLLOW`, into a fresh temporary file that is renamed over the
//! target, so a symlink planted at either name is replaced, never followed.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use super::Shared;
use super::common::{invalid, not_found, now_rfc3339, precondition, rfc3339};
use super::databases::{DatabaseOps, piped_command, spawn_error};
use super::exec::{self, ExecOptions};
pub use crate::providers::backup_secret::check_secret_ref;
use crate::providers::backup_secret::{
    BACKUP_SECRETS_DIR, BUCKET_LOOKUP_KEY, BUCKET_LOOKUP_VALUES, ENV_SUFFIX, MAX_SECRET_VALUE,
    check_secret_put, parse_env, password_change_refused, password_matches, render_env,
};
use crate::providers::*;

/// How often a running backup reports progress upward.
const BACKUP_PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// The longest line restic's JSON protocol is allowed to print.
const MAX_LOG_LINE: usize = 1 << 20;

static RESTORED_SUMMARY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"restored\s+(\d+)\s+files?.*?\(([0-9.]+)\s*([KMGT]?i?B)\)").unwrap());

pub struct BackupOps(pub Arc<Shared>);

type Environment = Vec<(String, String)>;

/// Leading `-o` options derived from the environment, and the environment
/// without the keys that became options. Unknown values are dropped.
fn split_options(environment: &Environment) -> (Vec<String>, Environment) {
    let mut options = Vec::new();
    let mut rest = Environment::new();
    for (k, v) in environment {
        if k == BUCKET_LOOKUP_KEY {
            if BUCKET_LOOKUP_VALUES.contains(&v.as_str()) {
                options.push("-o".to_string());
                options.push(format!("s3.bucket-lookup={v}"));
            }
            continue;
        }
        rest.push((k.clone(), v.clone()));
    }
    (options, rest)
}

fn restic(args: &[&str], environment: &Environment) -> ExecOptions {
    let (leading, environment) = split_options(environment);
    let argv: Vec<String> = leading
        .into_iter()
        .chain(args.iter().map(|a| a.to_string()))
        .collect();
    let mut options = ExecOptions::new("restic", argv).c_locale();
    for (k, v) in &environment {
        options = options.env(k.clone(), v.clone());
    }
    options
}

/// Maps the kernel's answers onto the provider sentinels so the panel can
/// say "not found" or "permission denied" rather than surfacing an errno.
fn wrap_fs_error(target: &str, err: std::io::Error) -> ProviderError {
    match err.kind() {
        std::io::ErrorKind::NotFound => not_found(target),
        std::io::ErrorKind::PermissionDenied => ProviderError::PermissionDenied(target.to_string()),
        std::io::ErrorKind::AlreadyExists => ProviderError::conflict(format!("{target} already exists")),
        _ if err.raw_os_error() == Some(libc::ENOSPC) => precondition(format!("no space left for {target}")),
        _ => ProviderError::internal(format!("{target}: {err}")),
    }
}

/// A staging directory that is removed when dropped, so a failed dump does
/// not leave a database export lying around in /tmp.
struct Staging(PathBuf);

impl Staging {
    fn create() -> PResult<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("kaname-backup-{}", uuid::Uuid::new_v4().simple()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| ProviderError::internal(format!("create staging directory: {e}")))?;
        Ok(Staging(dir))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/* --------------------------------- run -------------------------------- */

#[async_trait]
impl Backups for BackupOps {
    async fn run(&self, ctx: &Ctx, p: BackupRunParams, stream: StreamRef) -> PResult<BackupSnapshotInfo> {
        let environment = self.environment(&p.repository, &p.password_ref)?;

        let mut paths = p.paths.clone();

        // Databases are dumped to a staging directory and backed up with the
        // files, so one snapshot is a consistent picture of the whole host.
        let _staging = if p.databases.is_empty() {
            None
        } else {
            let staging = Staging::create()?;
            for database in &p.databases {
                check_engine_name(&database.engine)?;
                check_sql_identifier(&database.name)?;
                let destination = staging
                    .0
                    .join(format!("{}-{}.sql", database.engine, database.name));
                DatabaseOps(self.0.clone())
                    .dump(
                        ctx,
                        DbDumpParams {
                            engine: database.engine.clone(),
                            name: database.name.clone(),
                            destination: destination.display().to_string(),
                            compress: true,
                        },
                        stream.clone(),
                    )
                    .await?;
            }
            paths.push(staging.0.display().to_string());
            Some(staging)
        };

        if paths.is_empty() {
            return Err(invalid("a backup needs at least one path or database"));
        }
        self.ensure_repository(ctx, &environment).await?;

        let mut args: Vec<String> = vec!["backup".into(), "--json".into()];
        for exclude in &p.exclude {
            if exclude.contains('\0') {
                return Err(invalid("exclude patterns may not contain a null byte"));
            }
            args.push("--exclude".into());
            args.push(exclude.clone());
        }
        for tag in &p.tags {
            check_tag(tag)?;
            args.push("--tag".into());
            args.push(tag.clone());
        }
        args.extend(paths.iter().cloned());

        let mut snapshot = BackupSnapshotInfo {
            taken_at: now_rfc3339(),
            paths: paths.clone(),
            tags: p.tags.clone(),
            ..Default::default()
        };

        self.stream(
            ctx,
            Some(stream.as_ref()),
            &environment,
            &args,
            |message, raw| match message.message_type.as_str() {
                "summary" => {
                    snapshot.id = message.snapshot_id.clone();
                    snapshot.bytes = message.total_bytes_processed;
                    snapshot.file_count = message.total_files_processed;
                }
                "error" => tracing::warn!(message = %truncate_string(raw, 500), "restic reported an error"),
                _ => {}
            },
        )
        .await?;

        if snapshot.id.is_empty() {
            return Err(precondition("restic finished without reporting a snapshot id"));
        }
        Ok(snapshot)
    }

    /* -------------------------------- list -------------------------------- */

    async fn list(&self, ctx: &Ctx, p: BackupListParams) -> PResult<Vec<BackupSnapshotInfo>> {
        let environment = self.environment(&p.repository, &p.password_ref)?;

        let out = exec::run_with(ctx, restic(&["snapshots", "--json"], &environment)).await?;

        #[derive(Deserialize)]
        struct Summary {
            #[serde(default)]
            total_bytes_processed: i64,
            #[serde(default)]
            total_files_processed: i64,
        }
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            id: String,
            #[serde(default)]
            time: String,
            #[serde(default)]
            paths: Vec<String>,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(default)]
            summary: Option<Summary>,
        }
        let raw: Vec<Raw> = serde_json::from_str(&out)
            .map_err(|e| ProviderError::internal(format!("decode restic snapshots: {e}")))?;

        let mut snapshots: Vec<BackupSnapshotInfo> = raw
            .into_iter()
            .map(|entry| {
                let mut snapshot = BackupSnapshotInfo {
                    id: entry.id,
                    taken_at: normalize_timestamp(&entry.time),
                    paths: entry.paths,
                    tags: entry.tags,
                    ..Default::default()
                };
                // restic only records a summary from 0.17 onward; an older
                // repository reports the snapshot without inventing figures for it.
                if let Some(summary) = entry.summary {
                    snapshot.bytes = summary.total_bytes_processed;
                    snapshot.file_count = summary.total_files_processed;
                }
                snapshot
            })
            .collect();

        snapshots.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));
        Ok(snapshots)
    }

    /* ------------------------------- restore ------------------------------ */

    async fn restore(
        &self,
        ctx: &Ctx,
        p: BackupRestoreParams,
        stream: StreamRef,
    ) -> PResult<BackupRestoreResult> {
        let environment = self.environment(&p.repository, &p.password_ref)?;
        check_snapshot_id(&p.snapshot_id)?;
        std::fs::create_dir_all(&p.target).map_err(|e| wrap_fs_error(&p.target, e))?;
        if !p.overwrite {
            if let Ok(mut entries) = std::fs::read_dir(&p.target) {
                if entries.next().is_some() {
                    return Err(ProviderError::conflict(format!(
                        "{} is not empty and overwrite was not requested",
                        p.target
                    )));
                }
            }
        }

        let mut args: Vec<String> = vec![
            "restore".into(),
            p.snapshot_id.clone(),
            "--target".into(),
            p.target.clone(),
            "--json".into(),
        ];
        for include in &p.include {
            if include.contains('\0') {
                return Err(invalid("include patterns may not contain a null byte"));
            }
            args.push("--include".into());
            args.push(include.clone());
        }

        let mut result = BackupRestoreResult::default();
        self.stream(ctx, Some(stream.as_ref()), &environment, &args, |message, raw| {
            if message.message_type == "summary" {
                result.restored_files = message.files_restored;
                result.bytes = message.total_bytes;
            }
            // Older restic prints a plain sentence instead of a summary object.
            if let Some(m) = RESTORED_SUMMARY.captures(raw) {
                if result.restored_files == 0 {
                    result.restored_files = m[1].parse().unwrap_or(0);
                    result.bytes = parse_human_bytes(&m[2], &m[3]);
                }
            }
        })
        .await?;
        Ok(result)
    }

    /* -------------------------------- verify ------------------------------ */

    async fn verify(
        &self,
        ctx: &Ctx,
        p: BackupVerifyParams,
        stream: StreamRef,
    ) -> PResult<BackupVerifyResult> {
        let environment = self.environment(&p.repository, &p.password_ref)?;
        check_snapshot_id(&p.snapshot_id)?;

        let mut result = BackupVerifyResult {
            ok: true,
            errors: Vec::new(),
        };

        // `check` proves the repository's structure; reading a subset proves
        // the packs actually decrypt. Neither alone is a verification.
        let check: Vec<String> = ["check", "--read-data-subset=5%"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        if let Err(err) = self.relay(ctx, stream.as_ref(), &environment, &check).await {
            result.ok = false;
            result.errors.push(err.to_string());
        }

        let stats: Vec<String> = ["stats", "--json", "--mode", "raw-data", p.snapshot_id.as_str()]
            .iter()
            .map(|s| s.to_string())
            .collect();
        if let Err(err) = self.relay(ctx, stream.as_ref(), &environment, &stats).await {
            result.ok = false;
            result.errors.push(err.to_string());
        }
        Ok(result)
    }

    /* -------------------------------- prune ------------------------------- */

    async fn prune(&self, ctx: &Ctx, p: BackupPruneParams, stream: StreamRef) -> PResult<BackupPruneResult> {
        let environment = self.environment(&p.repository, &p.password_ref)?;

        let mut args: Vec<String> = vec!["forget".into(), "--prune".into(), "--json".into()];
        for (flag, value) in [
            ("--keep-last", p.keep_last),
            ("--keep-daily", p.keep_daily),
            ("--keep-weekly", p.keep_weekly),
            ("--keep-monthly", p.keep_monthly),
        ] {
            if value > 0 {
                args.push(flag.into());
                args.push(value.to_string());
            }
        }
        if args.len() == 3 {
            return Err(invalid("a retention policy needs at least one keep rule"));
        }

        // Repository size before and after is the only figure restic reports
        // consistently across versions, so reclaimed space is measured rather
        // than parsed out of prose.
        let before = self.repository_size(ctx, &environment).await;

        let out = self.relay(ctx, stream.as_ref(), &environment, &args).await?;

        let after = self.repository_size(ctx, &environment).await;
        let reclaimed = (before - after).max(0);
        Ok(BackupPruneResult {
            removed: count_forgotten(&out),
            reclaimed_bytes: reclaimed,
        })
    }

    /* ------------------------------- secrets ------------------------------ */

    /// Needs no restic: the control plane provisions the secret before the
    /// first backup, which may be what installs restic in the first place.
    async fn secret_put(&self, _ctx: &Ctx, p: BackupSecretPutParams) -> PResult<BackupSecretPutResult> {
        write_secret(&self.0.opts.state_dir, &p)?;
        Ok(BackupSecretPutResult {
            reference: p.reference,
        })
    }

    async fn secret_delete(
        &self,
        _ctx: &Ctx,
        p: BackupSecretDeleteParams,
    ) -> PResult<BackupSecretDeleteResult> {
        let removed = delete_secret(&self.0.opts.state_dir, &p.reference)?;
        Ok(BackupSecretDeleteResult {
            reference: p.reference,
            removed,
        })
    }
}

/* ------------------------------- internals ---------------------------- */

/// The subset of restic's JSON protocol the agent reads.
#[derive(Debug, Default, Deserialize)]
struct ResticMessage {
    #[serde(default)]
    message_type: String,
    #[serde(default)]
    percent_done: f64,
    #[serde(default)]
    snapshot_id: String,
    #[serde(default)]
    total_bytes_processed: i64,
    #[serde(default)]
    total_files_processed: i64,
    #[serde(default)]
    files_restored: i64,
    #[serde(default)]
    total_bytes: i64,
}

impl BackupOps {
    /// Runs restic and relays its progress, throttling the status firehose to
    /// something a human can read while letting every error and summary
    /// through untouched.
    async fn stream(
        &self,
        ctx: &Ctx,
        out: Option<&dyn Stream>,
        environment: &Environment,
        args: &[String],
        mut observe: impl FnMut(&ResticMessage, &str),
    ) -> PResult<String> {
        self.0.require(cap::RESTIC)?;
        let (leading, environment) = split_options(environment);
        let argv: Vec<String> = leading.into_iter().chain(args.iter().cloned()).collect();
        let mut options = ExecOptions::new("restic", argv).c_locale();
        for (k, v) in &environment {
            options = options.env(k.clone(), v.clone());
        }

        let mut cmd = piped_command(&options)?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| spawn_error("restic", e))?;
        let stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let mut lines = BufReader::with_capacity(64 << 10, stdout).lines();
        let mut last_report: Option<Instant> = None;
        let mut captured = String::new();

        let relay = async {
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(e) => return Err(ProviderError::internal(format!("read restic output: {e}"))),
                };
                if line.len() > MAX_LOG_LINE {
                    return Err(precondition("restic printed a line longer than the cap"));
                }

                let message: ResticMessage = serde_json::from_str(&line).unwrap_or(ResticMessage {
                    message_type: "text".into(),
                    ..Default::default()
                });
                observe(&message, &line);
                captured.push_str(&line);
                captured.push('\n');
                if captured.len() > 2 * exec::EXEC_OUTPUT_LIMIT {
                    captured = exec::tail(&captured, exec::EXEC_OUTPUT_LIMIT).to_string();
                }

                let Some(out) = out else { continue };
                let mut shown = line;
                if message.message_type == "status" {
                    if last_report.is_some_and(|t| t.elapsed() < BACKUP_PROGRESS_INTERVAL) {
                        continue;
                    }
                    last_report = Some(Instant::now());
                    shown = format!("{:.1}% complete", message.percent_done * 100.0);
                }
                shown.push('\n');
                // If the socket is gone, restic is stopped rather than left
                // writing into a pipe nobody will ever read again.
                out.send(shown.as_bytes(), Encoding::Utf8).await?;
            }
            Ok::<(), ProviderError>(())
        };

        let status = tokio::select! {
            r = relay => match r {
                Ok(()) => child.wait().await.map_err(|e| ProviderError::internal(format!("waiting for restic: {e}")))?,
                Err(e) => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(e);
                }
            },
            _ = ctx.done() => {
                let _ = child.start_kill();
                return Err(ctx.error());
            }
        };
        let stderr_text = stderr_task.await.unwrap_or_default();
        if !status.success() {
            return Err(exec::exec_error(
                "restic",
                exec::tail(&stderr_text, exec::EXEC_OUTPUT_LIMIT),
                status.code(),
            ));
        }
        Ok(captured)
    }

    /// Relays every line restic prints, for the verbs whose output is for the
    /// operator rather than for parsing.
    async fn relay(
        &self,
        ctx: &Ctx,
        out: &dyn Stream,
        environment: &Environment,
        args: &[String],
    ) -> PResult<String> {
        self.stream(ctx, Some(out), environment, args, |_, _| {}).await
    }

    /// Initialises a repository the first time it is used, so a new
    /// destination does not need a manual `restic init` on the host.
    async fn ensure_repository(&self, ctx: &Ctx, environment: &Environment) -> PResult<()> {
        if exec::run_with(ctx, restic(&["cat", "config"], environment))
            .await
            .is_ok()
        {
            return Ok(());
        }
        exec::run_with(ctx, restic(&["init"], environment)).await?;
        Ok(())
    }

    async fn repository_size(&self, ctx: &Ctx, environment: &Environment) -> i64 {
        let Ok(out) = exec::run_with(
            ctx,
            restic(&["stats", "--json", "--mode", "raw-data"], environment),
        )
        .await
        else {
            return 0;
        };
        #[derive(Deserialize)]
        struct Stats {
            #[serde(default)]
            total_size: i64,
        }
        serde_json::from_str::<Stats>(&out)
            .map(|s| s.total_size)
            .unwrap_or(0)
    }

    /// Resolves the password reference to a file the agent holds and builds
    /// restic's environment. The reference is a name, never a path: a control
    /// plane must not be able to point it at /etc/shadow.
    fn environment(&self, repository: &str, password_ref: &str) -> PResult<Environment> {
        self.0.require(cap::RESTIC)?;
        check_repository_uri(repository)?;
        check_secret_ref("password_ref", password_ref)?;
        resolve_secret(&self.0.opts.state_dir, repository, password_ref)
    }
}

/* ---------------------------- backup secrets -------------------------- */

/// Builds restic's environment from `<ref>` and `<ref>.env`. Either one
/// being a symbolic link is refused rather than followed, and the `.env`
/// file contributes only the closed set of keys.
fn resolve_secret(state_dir: &Path, repository: &str, password_ref: &str) -> PResult<Environment> {
    let secrets_dir = state_dir.join(BACKUP_SECRETS_DIR);
    match std::fs::symlink_metadata(&secrets_dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(precondition(format!(
                "{} is a symbolic link; Kaname will not follow it",
                secrets_dir.display()
            )));
        }
        _ => {}
    }

    let password_file = secrets_dir.join(password_ref);
    match std::fs::symlink_metadata(&password_file) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(precondition(format!(
                "backup secret {password_ref:?} is a symbolic link; Kaname will not follow it"
            )));
        }
        Ok(meta) if meta.is_file() => {}
        Ok(_) => {
            return Err(precondition(format!(
                "backup secret {password_ref:?} is not a regular file"
            )));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(precondition(format!(
                "no backup secret named {password_ref:?} in {}; the control plane provisions it \
                 (backup.secret_put) before each backup job",
                secrets_dir.display()
            )));
        }
        Err(e) => return Err(wrap_fs_error(&password_file.display().to_string(), e)),
    }

    let mut environment: Environment = vec![
        ("RESTIC_REPOSITORY".into(), repository.to_string()),
        ("RESTIC_PASSWORD_FILE".into(), password_file.display().to_string()),
    ];

    // An object-store repository also needs credentials, which live beside
    // the password under the same reference.
    let extra_path = secrets_dir.join(format!("{password_ref}{ENV_SUFFIX}"));
    match std::fs::symlink_metadata(&extra_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(precondition(format!(
                "the credentials for backup secret {password_ref:?} are a symbolic link; Kaname will not follow it"
            )));
        }
        Ok(meta) if meta.is_file() => {
            let extra = std::fs::read_to_string(&extra_path)
                .map_err(|e| wrap_fs_error(&extra_path.display().to_string(), e))?;
            environment.extend(parse_env(&extra));
        }
        Ok(_) => {
            return Err(precondition(format!(
                "the credentials for backup secret {password_ref:?} are not a regular file"
            )));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(wrap_fs_error(&extra_path.display().to_string(), e)),
    }
    Ok(environment)
}

/// Opens `state_dir/backup-secrets` with `O_NOFOLLOW`, creating it 0700 when
/// `create` is set. `None` means it does not exist and was not created.
fn open_secrets_dir(state_dir: &Path, create: bool) -> PResult<Option<File>> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    let dir_path = state_dir.join(BACKUP_SECRETS_DIR);
    let shown = dir_path.display().to_string();
    match std::fs::symlink_metadata(&dir_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(precondition(format!(
                "{shown} is a symbolic link; Kaname will not follow it"
            )));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(precondition(format!("{shown} is not a directory")));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir_path)
                .map_err(|e| wrap_fs_error(&shown, e))?;
        }
        Err(e) => return Err(wrap_fs_error(&shown, e)),
    }

    // O_NOFOLLOW closes the window between the check above and this open:
    // a symlink swapped in meanwhile is ELOOP, not a redirect.
    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&dir_path)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => precondition(format!(
                "{shown} is not a plain directory; Kaname will not follow it"
            )),
            _ => wrap_fs_error(&shown, e),
        })?;
    dir.set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| wrap_fs_error(&shown, e))?;
    Ok(Some(dir))
}

/// Replaces `name` in `dir` atomically: a fresh 0600 temporary created with
/// `O_EXCL | O_NOFOLLOW`, written, synced and renamed over the target.
/// The rename replaces whatever is there, a planted symlink included, and
/// never writes through it.
fn replace_at(dir: &File, dir_path: &Path, name: &str, content: &[u8]) -> PResult<()> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::PermissionsExt;

    use nix::fcntl::{OFlag, openat, renameat};
    use nix::sys::stat::Mode;
    use nix::unistd::{UnlinkatFlags, unlinkat};

    let dirfd = dir.as_raw_fd();
    let target = dir_path.join(name).display().to_string();
    let temp = format!(".{name}.{}", uuid::Uuid::new_v4().simple());
    let fd = openat(
        Some(dirfd),
        temp.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(|e| wrap_fs_error(&target, e.into()))?;
    // SAFETY: openat has just returned this descriptor and nothing else
    // holds it, so the File becomes its only owner.
    let mut file = unsafe { File::from_raw_fd(fd) };

    let result = (|| -> std::io::Result<()> {
        file.write_all(content)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        renameat(Some(dirfd), temp.as_str(), Some(dirfd), name)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = unlinkat(Some(dirfd), temp.as_str(), UnlinkatFlags::NoRemoveDir);
    }
    result.map_err(|e| wrap_fs_error(&target, e))
}

/// Makes a rename or an unlink in `dir` durable. A filesystem that cannot
/// sync a directory answers EINVAL, which is not a failure here.
fn sync_dir(dir: &File) -> std::io::Result<()> {
    match dir.sync_all() {
        Err(e) if e.raw_os_error() == Some(libc::EINVAL) => Ok(()),
        other => other,
    }
}

/// Removes `name` from `dir`; true when something was there. The removal
/// is synced, so a crash cannot bring a deleted secret back.
fn remove_at(dir: &File, dir_path: &Path, name: &str) -> PResult<bool> {
    use std::os::fd::AsRawFd;

    use nix::unistd::{UnlinkatFlags, unlinkat};

    let shown = || dir_path.join(name).display().to_string();
    match unlinkat(Some(dir.as_raw_fd()), name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) => {
            sync_dir(dir).map_err(|e| wrap_fs_error(&shown(), e))?;
            Ok(true)
        }
        Err(nix::errno::Errno::ENOENT) => Ok(false),
        Err(e) => Err(wrap_fs_error(&shown(), e.into())),
    }
}

/// What is at `name` in `dir`, without following a symbolic link.
enum Entry {
    Missing,
    /// A regular file (its content is read separately when it matters).
    File,
    /// A symbolic link: never followed, and replaced by the next write.
    Symlink,
    /// A directory, a FIFO, a socket or a device: nothing Kaname wrote.
    Other,
}

fn entry_at(dir: &File, dir_path: &Path, name: &str) -> PResult<Entry> {
    use std::os::fd::AsRawFd;

    use nix::fcntl::AtFlags;
    use nix::sys::stat::{SFlag, fstatat};

    match fstatat(Some(dir.as_raw_fd()), name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(st) => {
            let kind = SFlag::from_bits_truncate(st.st_mode) & SFlag::S_IFMT;
            Ok(if kind == SFlag::S_IFREG {
                Entry::File
            } else if kind == SFlag::S_IFLNK {
                Entry::Symlink
            } else {
                Entry::Other
            })
        }
        Err(nix::errno::Errno::ENOENT) => Ok(Entry::Missing),
        Err(e) => Err(wrap_fs_error(
            &dir_path.join(name).display().to_string(),
            e.into(),
        )),
    }
}

/// Refuses up front when `<ref>` or `<ref>.env` is something a rename or an
/// unlink cannot replace (a directory, say), so neither verb leaves half
/// its work done and then fails on it every time after.
fn check_replaceable(dir: &File, dir_path: &Path, reference: &str) -> PResult<()> {
    for (name, what) in [
        (reference.to_string(), "backup secret"),
        (
            format!("{reference}{ENV_SUFFIX}"),
            "the credentials for backup secret",
        ),
    ] {
        if let Entry::Other = entry_at(dir, dir_path, &name)? {
            return Err(precondition(format!(
                "{what} {reference:?} is not a regular file; remove {} by hand",
                dir_path.join(&name).display()
            )));
        }
    }
    Ok(())
}

/// The password `<ref>` holds now, when it is a regular file. A symbolic
/// link is never opened (it holds no password Kaname wrote).
fn current_password(dir: &File, dir_path: &Path, reference: &str) -> PResult<Option<Vec<u8>>> {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};

    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;

    let shown = || dir_path.join(reference).display().to_string();
    let fd = match openat(
        Some(dir.as_raw_fd()),
        reference,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(nix::errno::Errno::ENOENT) | Err(nix::errno::Errno::ELOOP) => return Ok(None),
        Err(e) => return Err(wrap_fs_error(&shown(), e.into())),
    };
    // SAFETY: openat has just returned this descriptor and nothing else
    // holds it, so the File becomes its only owner.
    let file = unsafe { File::from_raw_fd(fd) };
    if !file.metadata().map_err(|e| wrap_fs_error(&shown(), e))?.is_file() {
        return Ok(None);
    }
    let mut content = Vec::new();
    // A password is at most MAX_SECRET_VALUE bytes plus a line break; read
    // a little past that, so a longer file never compares equal.
    file.take(MAX_SECRET_VALUE as u64 + 4)
        .read_to_end(&mut content)
        .map_err(|e| wrap_fs_error(&shown(), e))?;
    Ok(Some(content))
}

/// Whether `name` is a temporary `replace_at` left behind for `reference`
/// (`.<ref>.<uuid>` or `.<ref>.env.<uuid>`, the uuid as 32 lowercase hex
/// digits). References never start with a dot, so no live file matches.
fn is_leftover_temp(name: &str, reference: &str) -> bool {
    let Some(rest) = name
        .strip_prefix('.')
        .and_then(|n| n.strip_prefix(reference))
        .and_then(|n| n.strip_prefix('.'))
    else {
        return false;
    };
    let rest = rest.strip_prefix("env.").unwrap_or(rest);
    rest.len() == 32 && rest.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Removes the temporaries an interrupted write left for `reference`,
/// listing and unlinking through the directory descriptor. Best effort: a
/// leftover is harmless (0600, never read), so a failure here is not one
/// of the verb's.
fn remove_leftover_temps(dir: &File, reference: &str) {
    use std::os::fd::AsRawFd;

    use nix::dir::Dir;
    use nix::fcntl::OFlag;
    use nix::sys::stat::Mode;
    use nix::unistd::{UnlinkatFlags, unlinkat};

    let Ok(mut listing) = Dir::openat(
        Some(dir.as_raw_fd()),
        ".",
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) else {
        return;
    };
    let leftovers: Vec<String> = listing
        .iter()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().ok().map(str::to_string))
        .filter(|name| is_leftover_temp(name, reference))
        .collect();
    let mut removed = false;
    for name in leftovers {
        removed |= unlinkat(Some(dir.as_raw_fd()), name.as_str(), UnlinkatFlags::NoRemoveDir).is_ok();
    }
    if removed {
        let _ = sync_dir(dir);
    }
}

/// One writer or remover at a time in this process: the leftover sweep
/// must never take a temporary another call is about to rename, and the
/// password comparison must not race a concurrent write.
static SECRETS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Writes `<ref>` (the password and a newline) and `<ref>.env` (the
/// credentials, or nothing: an empty set removes a stale file).
///
/// A repository password is never changed: when `<ref>` already holds a
/// different one the call is refused and nothing is written, because the
/// repository that password opens would be lost. The same password is
/// written again (a no-op) and the credentials beside it can still rotate.
fn write_secret(state_dir: &Path, p: &BackupSecretPutParams) -> PResult<()> {
    let entries = check_secret_put(p)?;
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir_path = state_dir.join(BACKUP_SECRETS_DIR);
    let dir = open_secrets_dir(state_dir, true)?.expect("created");
    remove_leftover_temps(&dir, &p.reference);
    check_replaceable(&dir, &dir_path, &p.reference)?;
    if let Some(current) = current_password(&dir, &dir_path, &p.reference)? {
        if !password_matches(&current, &p.password) {
            return Err(password_change_refused(&p.reference));
        }
    }

    let mut password = Vec::with_capacity(p.password.len() + 1);
    password.extend_from_slice(p.password.as_bytes());
    password.push(b'\n');
    replace_at(&dir, &dir_path, &p.reference, &password)?;

    let env_name = format!("{}{ENV_SUFFIX}", p.reference);
    if entries.is_empty() {
        remove_at(&dir, &dir_path, &env_name)?;
    } else {
        replace_at(&dir, &dir_path, &env_name, render_env(&entries).as_bytes())?;
    }
    Ok(())
}

fn delete_secret(state_dir: &Path, reference: &str) -> PResult<bool> {
    check_secret_ref("ref", reference)?;
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir_path = state_dir.join(BACKUP_SECRETS_DIR);
    let Some(dir) = open_secrets_dir(state_dir, false)? else {
        return Ok(false);
    };
    remove_leftover_temps(&dir, reference);
    check_replaceable(&dir, &dir_path, reference)?;
    let password = remove_at(&dir, &dir_path, reference)?;
    let env = remove_at(&dir, &dir_path, &format!("{reference}{ENV_SUFFIX}"))?;
    Ok(password || env)
}

fn count_forgotten(out: &str) -> i64 {
    #[derive(Deserialize)]
    struct Removed {
        #[serde(default)]
        #[allow(dead_code)]
        id: String,
    }
    #[derive(Deserialize)]
    struct Group {
        #[serde(default)]
        remove: Option<Vec<Removed>>,
    }
    // forget prints a JSON array before prune's own output, so only the
    // leading array is decoded.
    let mut stream = serde_json::Deserializer::from_str(out).into_iter::<Vec<Group>>();
    let Some(Ok(groups)) = stream.next() else { return 0 };
    groups
        .iter()
        .map(|g| g.remove.as_ref().map(Vec::len).unwrap_or(0) as i64)
        .sum()
}

fn parse_human_bytes(value: &str, unit: &str) -> i64 {
    let Ok(amount) = value.parse::<f64>() else {
        return 0;
    };
    let multiplier: f64 = match unit {
        "B" => 1.0,
        "KiB" => (1u64 << 10) as f64,
        "MiB" => (1u64 << 20) as f64,
        "GiB" => (1u64 << 30) as f64,
        "TiB" => (1u64 << 40) as f64,
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => return amount as i64,
    };
    (amount * multiplier) as i64
}

fn normalize_timestamp(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(parsed) => rfc3339(parsed.with_timezone(&chrono::Utc)),
        Err(_) => value.to_string(),
    }
}

fn truncate_string(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut cut = limit;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

/* ------------------------------ validation ---------------------------- */

pub fn check_repository_uri(repository: &str) -> PResult<()> {
    if repository.is_empty() || repository.len() > 512 {
        return Err(invalid("repository must be between 1 and 512 characters"));
    }
    if repository.contains(['\n', '\r', '\0']) || repository.starts_with('-') {
        return Err(invalid("repository contains an illegal character"));
    }
    Ok(())
}

pub fn check_snapshot_id(id: &str) -> PResult<()> {
    if id.is_empty() || id.len() > 128 {
        return Err(invalid("snapshot_id must be between 1 and 128 characters"));
    }
    if id == "latest" {
        return Ok(());
    }
    if !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid("snapshot_id must be a hex identifier or `latest`"));
    }
    Ok(())
}

pub fn check_tag(tag: &str) -> PResult<()> {
    if tag.is_empty() || tag.len() > 64 {
        return Err(invalid("tags must be between 1 and 64 characters"));
    }
    if tag.contains([' ', ',', '\n', '\r', '\0']) {
        return Err(invalid(format!("tag {tag:?} contains an illegal character")));
    }
    Ok(())
}

fn check_engine_name(engine: &str) -> PResult<()> {
    match engine {
        "mysql" | "mariadb" | "postgres" => Ok(()),
        _ => Err(invalid(format!("engine {engine:?} is not supported"))),
    }
}

/// Re-applies the RPC layer's identifier rule to names that arrive nested
/// inside another parameter and were never checked.
fn check_sql_identifier(name: &str) -> PResult<()> {
    if name.is_empty() || name.len() > 63 {
        return Err(invalid("database name must be between 1 and 63 characters"));
    }
    if !name
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return Err(invalid("database name contains an illegal character"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_lookup_becomes_an_option_and_never_an_env_var() {
        let env: Environment = vec![
            ("AWS_ACCESS_KEY_ID".into(), "k".into()),
            (BUCKET_LOOKUP_KEY.into(), "path".into()),
        ];
        let (options, rest) = split_options(&env);
        assert_eq!(
            options,
            vec!["-o".to_string(), "s3.bucket-lookup=path".to_string()]
        );
        assert_eq!(rest, vec![("AWS_ACCESS_KEY_ID".to_string(), "k".to_string())]);
        let (options, _) = split_options(&vec![(BUCKET_LOOKUP_KEY.into(), "path --x".into())]);
        assert!(options.is_empty(), "an unknown value is dropped");
    }

    #[test]
    fn a_password_ref_is_a_bare_name() {
        assert!(check_secret_ref("password_ref", "nightly").is_ok());
        assert!(check_secret_ref("password_ref", "site-a.v2_key").is_ok());
        for hostile in [
            "",
            "../shadow",
            "/etc/shadow",
            "a/b",
            "a\\b",
            "a b",
            "ref\0",
            "$(x)",
        ] {
            assert!(
                check_secret_ref("password_ref", hostile).is_err(),
                "{hostile:?} was accepted"
            );
        }
    }

    #[test]
    fn repository_uris_cannot_become_flags_or_lines() {
        assert!(check_repository_uri("/srv/backups").is_ok());
        assert!(check_repository_uri("s3:s3.amazonaws.com/bucket").is_ok());
        assert!(check_repository_uri("--password-command=reboot").is_err());
        assert!(check_repository_uri("a\nb").is_err());
        assert!(check_repository_uri("").is_err());
    }

    #[test]
    fn snapshot_ids_are_hex_or_latest() {
        assert!(check_snapshot_id("latest").is_ok());
        assert!(check_snapshot_id("deadBEEF01").is_ok());
        assert!(check_snapshot_id("latest; reboot").is_err());
        assert!(check_snapshot_id("").is_err());
    }

    #[test]
    fn tags_and_identifiers_are_checked() {
        assert!(check_tag("nightly").is_ok());
        assert!(check_tag("a,b").is_err());
        assert!(check_tag("a b").is_err());
        assert!(check_engine_name("postgres").is_ok());
        assert!(check_engine_name("sqlite").is_err());
        assert!(check_sql_identifier("app_db-1").is_ok());
        assert!(check_sql_identifier("app;drop").is_err());
    }

    #[test]
    fn human_bytes_follow_restic_units() {
        assert_eq!(parse_human_bytes("1.5", "KiB"), 1536);
        assert_eq!(parse_human_bytes("2", "MB"), 2_000_000);
        assert_eq!(parse_human_bytes("7", "B"), 7);
        assert_eq!(parse_human_bytes("x", "B"), 0);
        assert_eq!(parse_human_bytes("3", "parsecs"), 3);
    }

    #[test]
    fn forget_counts_only_the_leading_array() {
        let out = r#"[{"remove":[{"id":"a"},{"id":"b"}]},{"remove":null},{"remove":[{"id":"c"}]}]
repository contains 3 packs
"#;
        assert_eq!(count_forgotten(out), 3);
        assert_eq!(count_forgotten("not json"), 0);
    }

    #[test]
    fn the_restored_sentence_is_parsed_when_there_is_no_summary() {
        let m = RESTORED_SUMMARY
            .captures("restored 12 files/dirs (3.5 MiB) in 1s")
            .unwrap();
        assert_eq!(&m[1], "12");
        assert_eq!(parse_human_bytes(&m[2], &m[3]), (3.5 * 1048576.0) as i64);
    }

    #[test]
    fn restic_messages_decode_loosely() {
        let m: ResticMessage = serde_json::from_str(
            r#"{"message_type":"summary","snapshot_id":"abc","total_bytes_processed":10}"#,
        )
        .unwrap();
        assert_eq!(m.message_type, "summary");
        assert_eq!(m.snapshot_id, "abc");
        assert_eq!(m.total_bytes_processed, 10);
        assert!(serde_json::from_str::<ResticMessage>("plain text").is_err());
    }

    /* ---------------------------- backup secrets -------------------------- */

    use crate::providers::BackupSecretEnv;
    use std::os::unix::fs::PermissionsExt;

    const PASSWORD: &str = "correct-horse-battery-staple";
    const REF: &str = "backup_schedule.0d6c3a52-8a9b-4c5e-9f00-1234567890ab";

    fn put(reference: &str, password: &str, env: BackupSecretEnv) -> BackupSecretPutParams {
        BackupSecretPutParams {
            reference: reference.into(),
            password: password.into(),
            env,
        }
    }

    fn s3_env() -> BackupSecretEnv {
        BackupSecretEnv {
            aws_access_key_id: Some("AKIDEXAMPLE".into()),
            aws_secret_access_key: Some("wJalr/XUtnFEMI=K7MDENG".into()),
            kaname_s3_bucket_lookup: Some("path".into()),
            ..Default::default()
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn secret_put_writes_private_files_the_reader_understands() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        write_secret(&state, &put(REF, PASSWORD, s3_env())).unwrap();

        let dir = state.join(BACKUP_SECRETS_DIR);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(REF)), 0o600);
        assert_eq!(mode(&dir.join(format!("{REF}.env"))), 0o600);
        assert_eq!(
            std::fs::read_to_string(dir.join(REF)).unwrap(),
            format!("{PASSWORD}\n")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("{REF}.env"))).unwrap(),
            "AWS_ACCESS_KEY_ID=AKIDEXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalr/XUtnFEMI=K7MDENG\nKANAME_S3_BUCKET_LOOKUP=path\n"
        );
        // No temporary is left behind.
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");

        let environment = resolve_secret(&state, "s3:s3.example.com/bucket", REF).unwrap();
        assert!(environment.contains(&(
            "RESTIC_PASSWORD_FILE".to_string(),
            dir.join(REF).display().to_string()
        )));
        assert!(environment.contains(&("AWS_ACCESS_KEY_ID".to_string(), "AKIDEXAMPLE".to_string())));
        let (options, _) = split_options(&environment);
        assert_eq!(
            options,
            vec!["-o".to_string(), "s3.bucket-lookup=path".to_string()]
        );
    }

    #[test]
    fn secret_put_rotates_credentials_and_an_empty_env_removes_them() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let dir = state.join(BACKUP_SECRETS_DIR);
        write_secret(state, &put(REF, PASSWORD, s3_env())).unwrap();
        let rotated = BackupSecretEnv {
            aws_secret_access_key: Some("rotated-key".into()),
            ..s3_env()
        };
        write_secret(state, &put(REF, PASSWORD, rotated)).unwrap();
        assert!(
            std::fs::read_to_string(dir.join(format!("{REF}.env")))
                .unwrap()
                .contains("rotated-key")
        );
        write_secret(state, &put(REF, PASSWORD, BackupSecretEnv::default())).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(REF)).unwrap(),
            format!("{PASSWORD}\n")
        );
        assert!(!dir.join(format!("{REF}.env")).exists());
        // And again with nothing to remove.
        write_secret(state, &put(REF, PASSWORD, BackupSecretEnv::default())).unwrap();
        assert_eq!(mode(&dir.join(REF)), 0o600);
    }

    #[test]
    fn secret_put_never_changes_a_repository_password() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let dir = state.join(BACKUP_SECRETS_DIR);
        write_secret(state, &put(REF, PASSWORD, BackupSecretEnv::default())).unwrap();
        let err = write_secret(state, &put(REF, "a-different-password", s3_env())).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        let shown = err.to_string();
        assert!(
            !shown.contains(PASSWORD) && !shown.contains("a-different-password"),
            "{shown}"
        );
        // Nothing was written: neither the password nor the credentials.
        assert_eq!(
            std::fs::read_to_string(dir.join(REF)).unwrap(),
            format!("{PASSWORD}\n")
        );
        assert!(!dir.join(format!("{REF}.env")).exists());

        // A password installed by hand, without the line break, is the same one.
        std::fs::write(dir.join("by-hand"), "hand-made").unwrap();
        write_secret(state, &put("by-hand", "hand-made", s3_env())).unwrap();
        assert!(write_secret(state, &put("by-hand", "hand-made-2", s3_env())).is_err());
    }

    #[test]
    fn leftover_temporaries_are_swept_for_that_reference_only() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let dir = state.join(BACKUP_SECRETS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let uuid = "0123456789abcdef0123456789abcdef";
        let ours = [format!(".{REF}.{uuid}"), format!(".{REF}.env.{uuid}")];
        let theirs = [
            format!(".nightly.{uuid}"),
            format!(".{REF}.j0123456789ab.{uuid}"),
            format!(".{REF}.{}", &uuid[..31]),
            format!(".{REF}.{}", uuid.to_uppercase()),
        ];
        for name in ours.iter().chain(theirs.iter()) {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        write_secret(state, &put(REF, PASSWORD, Default::default())).unwrap();
        for name in &ours {
            assert!(!dir.join(name).exists(), "{name} was left");
        }
        for name in &theirs {
            assert!(dir.join(name).exists(), "{name} was taken");
        }

        for name in &ours {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        assert!(delete_secret(state, REF).unwrap());
        for name in &ours {
            assert!(!dir.join(name).exists(), "{name} was left by delete");
        }
        assert!(is_leftover_temp(&format!(".{REF}.{uuid}"), REF));
        assert!(!is_leftover_temp(&format!("{REF}.{uuid}"), REF));
    }

    #[test]
    fn a_credentials_path_that_is_not_a_file_is_refused_up_front() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let dir = state.join(BACKUP_SECRETS_DIR);
        std::fs::create_dir_all(dir.join(format!("{REF}.env"))).unwrap();

        let err = write_secret(state, &put(REF, PASSWORD, s3_env())).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        assert!(!dir.join(REF).exists(), "nothing was written before the refusal");

        // A password written before the directory appeared stays put: the
        // delete refuses instead of removing half the secret.
        std::fs::write(dir.join(REF), format!("{PASSWORD}\n")).unwrap();
        let err = delete_secret(state, REF).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        assert!(dir.join(REF).exists());
    }

    #[test]
    fn secret_put_refuses_bad_input_before_touching_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        for bad in ["", "../x", "a/b", ".hidden", "x.env", "a:b", "a b", "a\0b"] {
            assert!(
                write_secret(state, &put(bad, PASSWORD, Default::default())).is_err(),
                "{bad:?}"
            );
        }
        for bad in ["a\nb", "a\rb", "a\0b", ""] {
            let err = write_secret(state, &put(REF, bad, Default::default())).unwrap_err();
            assert!(bad.is_empty() || !err.to_string().contains(bad), "{err}");
        }
        let env = BackupSecretEnv {
            b2_account_key: Some("secret-value\nLD_PRELOAD=/x".into()),
            ..Default::default()
        };
        let err = write_secret(state, &put(REF, PASSWORD, env))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("B2_ACCOUNT_KEY") && !err.contains("secret-value"),
            "{err}"
        );
        assert!(!state.join(BACKUP_SECRETS_DIR).exists(), "nothing was created");
    }

    #[test]
    fn a_symlinked_secrets_directory_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, state.join(BACKUP_SECRETS_DIR)).unwrap();

        let err = write_secret(&state, &put(REF, PASSWORD, Default::default())).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        assert!(delete_secret(&state, REF).is_err());
        assert!(resolve_secret(&state, "/srv/r", REF).is_err());
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);

        // A plain file in its place is refused too.
        let other = tmp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(BACKUP_SECRETS_DIR), "x").unwrap();
        assert!(write_secret(&other, &put(REF, PASSWORD, Default::default())).is_err());
    }

    #[test]
    fn a_planted_symlink_is_replaced_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let dir = state.join(BACKUP_SECRETS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let outside = tmp.path().join("shadow");
        std::fs::write(&outside, "untouched").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(REF)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(format!("{REF}.env"))).unwrap();

        // The reader refuses to follow either one.
        let err = resolve_secret(&state, "/srv/r", REF).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err}");
        std::fs::remove_file(dir.join(REF)).unwrap();
        std::fs::write(dir.join(REF), "pw\n").unwrap();
        let err = resolve_secret(&state, "/srv/r", REF).unwrap_err();
        assert!(err.to_string().contains("symbolic link"), "{err}");
        std::fs::remove_file(dir.join(REF)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(REF)).unwrap();

        // The writer replaces both links.
        write_secret(&state, &put(REF, PASSWORD, s3_env())).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
        for name in [REF.to_string(), format!("{REF}.env")] {
            let meta = std::fs::symlink_metadata(dir.join(&name)).unwrap();
            assert!(meta.is_file() && !meta.file_type().is_symlink(), "{name}");
        }
        assert!(resolve_secret(&state, "/srv/r", REF).is_ok());
    }

    #[test]
    fn the_reader_drops_keys_outside_the_closed_set() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(BACKUP_SECRETS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nightly"), "pw\n").unwrap();
        std::fs::write(
            dir.join("nightly.env"),
            "B2_ACCOUNT_ID=id\nLD_PRELOAD=/tmp/evil.so\nRESTIC_PASSWORD_COMMAND=reboot\nPATH=/tmp\n",
        )
        .unwrap();
        let environment = resolve_secret(tmp.path(), "b2:bucket:path", "nightly").unwrap();
        let keys: Vec<&str> = environment.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec!["RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "B2_ACCOUNT_ID"]
        );

        let err = resolve_secret(tmp.path(), "/srv/r", "missing").unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)));
        assert!(err.to_string().contains("control plane provisions it"), "{err}");
    }

    #[test]
    fn secret_delete_removes_both_files_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        assert!(!delete_secret(state, REF).unwrap(), "no directory yet");
        write_secret(state, &put(REF, PASSWORD, s3_env())).unwrap();
        write_secret(state, &put("nightly", PASSWORD, Default::default())).unwrap();
        assert!(delete_secret(state, REF).unwrap());
        let dir = state.join(BACKUP_SECRETS_DIR);
        assert!(!dir.join(REF).exists() && !dir.join(format!("{REF}.env")).exists());
        assert!(dir.join("nightly").exists(), "other references are left alone");
        assert!(!delete_secret(state, REF).unwrap());
        assert!(delete_secret(state, "../nightly").is_err());
    }
}
