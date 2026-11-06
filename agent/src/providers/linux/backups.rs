//! Backups.
//!
//! restic does the work. The interesting decision here is where the
//! repository password comes from: the control plane sends a *reference*,
//! never the secret itself, and the agent resolves it against files in
//! its own state directory. A compromised control plane therefore cannot
//! read a repository it does not already have the key for, and the
//! password never travels over the socket or appears in an argv.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use super::Shared;
use super::common::{invalid, not_found, now_rfc3339, precondition, rfc3339, split_lines};
use super::databases::{DatabaseOps, piped_command, spawn_error};
use super::exec::{self, ExecOptions};
use crate::providers::*;

/// Where password references resolve to, under the agent's state dir.
const BACKUP_SECRETS_DIR: &str = "backup-secrets";
/// How often a running backup reports progress upward.
const BACKUP_PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// The longest line restic's JSON protocol is allowed to print.
const MAX_LOG_LINE: usize = 1 << 20;

static RESTORED_SUMMARY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"restored\s+(\d+)\s+files?.*?\(([0-9.]+)\s*([KMGT]?i?B)\)").unwrap());

pub struct BackupOps(pub Arc<Shared>);

type Environment = Vec<(String, String)>;

fn restic(args: &[&str], environment: &Environment) -> ExecOptions {
    let mut options = ExecOptions::new("restic", args.iter().copied()).c_locale();
    for (k, v) in environment {
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
        let options = ExecOptions::new("restic", args.iter().cloned()).c_locale();
        let mut options = options;
        for (k, v) in environment {
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
        check_secret_ref(password_ref)?;

        let secrets_dir = self.0.opts.state_dir.join(BACKUP_SECRETS_DIR);
        let password_file = secrets_dir.join(password_ref);
        if !exec::file_exists(&password_file.display().to_string()) {
            return Err(precondition(format!(
                "no backup secret named {password_ref:?} in {}; install it on the host before running a backup",
                secrets_dir.display()
            )));
        }

        let mut environment: Environment = vec![
            ("RESTIC_REPOSITORY".into(), repository.to_string()),
            ("RESTIC_PASSWORD_FILE".into(), password_file.display().to_string()),
        ];

        // An object-store repository also needs credentials, which live beside
        // the password under the same reference and never cross the socket.
        let extra_path = PathBuf::from(format!("{}.env", password_file.display()));
        if let Ok(extra) = std::fs::read_to_string(&extra_path) {
            for line in split_lines(&extra) {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    if !key.is_empty() {
                        environment.push((key.to_string(), value.to_string()));
                    }
                }
            }
        }
        Ok(environment)
    }
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

/// Keeps a password reference a bare name, so it can only ever resolve
/// inside the agent's own secrets directory.
pub fn check_secret_ref(reference: &str) -> PResult<()> {
    if reference.is_empty() || reference.len() > 128 {
        return Err(invalid("password_ref must be between 1 and 128 characters"));
    }
    if reference.contains(['/', '\\']) || reference.contains("..") || reference.contains('\0') {
        return Err(invalid("password_ref must be a bare name, not a path"));
    }
    if !reference
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
    {
        return Err(invalid("password_ref contains an illegal character"));
    }
    Ok(())
}

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
    fn a_password_ref_is_a_bare_name() {
        assert!(check_secret_ref("nightly").is_ok());
        assert!(check_secret_ref("site-a.v2_key").is_ok());
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
            assert!(check_secret_ref(hostile).is_err(), "{hostile:?} was accepted");
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
}
