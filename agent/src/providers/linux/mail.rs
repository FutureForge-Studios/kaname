//! Mail on a real host: Yunori Mail Server (KD-023).
//!
//! The host runs the `yunori-mail` binary; this module drives it ONLY through
//! its command line, with an argv slice and never a shell. It never opens
//! Yunori's database or vault and never talks to Stalwart. Every parser in
//! `parse` reads the exact `println!` formats of yunori-mail's `src/cli.rs`
//! (its `Term` emits no ANSI codes when stdout is not a terminal or when
//! `NO_COLOR` is set; we set `NO_COLOR=1` and strip codes anyway).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::Shared;
use super::capabilities::YUNORI_BIN;
use super::exec::{self, ExecOptions};
use crate::providers::*;

/// The archive member install.sh extracts, and the only file we take.
const BINARY_MEMBER: &str = "yunori-mail";
/// Largest release archive we are willing to stream to disk.
const MAX_ARCHIVE_BYTES: u64 = 256 << 20;
/// The environment variable the relay password travels in (never argv).
const RELAY_PASSWORD_ENV: &str = "KANAME_RELAY_PASSWORD";
/// Units whose journal `mail.logs` reads.
const JOURNAL_UNITS: [&str; 2] = ["stalwart", "yunori-mail"];
/// Services `mail.status` reports on, in the order the panel shows them.
const SERVICES: [&str; 3] = ["stalwart", "yunori-mail", "unbound"];
/// Lines of a streamed command kept for parsing.
const MAX_CAPTURED_LINES: usize = 20_000;

pub struct MailOps(pub Arc<Shared>);

/* ------------------------------ plumbing ------------------------------ */

/// Where the yunori-mail binary is: the install path first, PATH second.
fn binary() -> Option<PathBuf> {
    exec::which(YUNORI_BIN).or_else(|| exec::which("yunori-mail"))
}

fn not_installed() -> ProviderError {
    ProviderError::unsupported_because("yunori-mail is not installed; deploy it first")
}

/// A `yunori-mail` invocation. Colour is off so the parsers see plain text.
fn yunori(bin: &Path, args: &[&str]) -> ExecOptions {
    ExecOptions::new(bin.to_string_lossy(), args.iter().copied())
        .env("NO_COLOR", "1")
        .c_locale()
}

/// How a CLI failure maps onto a provider error when its text matches.
#[derive(Clone, Copy)]
enum Kind {
    NotFound,
    Conflict,
    Invalid,
    Precondition,
}

/// Turns a failed `yunori-mail` run into the error the panel can act on.
/// `rules` are lower-case needles looked up in stderr and stdout, first
/// match wins; anything else is an `Exec` error carrying the output tail.
fn cli_failure(op: &str, out: &exec::Output, rules: &[(&str, Kind)]) -> ProviderError {
    let haystack = format!("{}\n{}", out.stderr, out.stdout).to_ascii_lowercase();
    let message = parse::error_message(&out.stderr, &out.stdout);
    for (needle, kind) in rules {
        if haystack.contains(needle) {
            return match kind {
                Kind::NotFound => ProviderError::NotFound(message),
                Kind::Conflict => ProviderError::Conflict(message),
                Kind::Invalid => ProviderError::InvalidParams(message),
                Kind::Precondition => ProviderError::PreconditionFailed(message),
            };
        }
    }
    let shown = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    exec::exec_error(op, exec::tail(shown, exec::EXEC_OUTPUT_LIMIT), out.code)
}

/// Output of a streamed child: every line with where it came from, so a
/// caller can parse stdout while the operator saw both.
struct Captured {
    /// `(is_stdout, line)`, ANSI stripped, unredacted.
    lines: Vec<(bool, String)>,
    code: Option<i32>,
}

impl Captured {
    fn stdout_lines(&self) -> Vec<String> {
        self.lines
            .iter()
            .filter(|(o, _)| *o)
            .map(|(_, l)| l.clone())
            .collect()
    }
    fn all_lines(&self) -> Vec<String> {
        self.lines.iter().map(|(_, l)| l.clone()).collect()
    }
    fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// Relays a long job's output line by line to the control plane, through
/// `redactor`, while keeping the raw lines for parsing. `exec::run_stream`
/// only hands back redacted text, and the setup link and the first
/// mailbox's password must reach the panel's result exactly once, so the
/// streaming is done here with the same shape.
async fn stream_command(
    ctx: &Ctx,
    stream: &dyn Stream,
    o: ExecOptions,
    redactor: &mut parse::Redactor,
) -> PResult<Captured> {
    let path = exec::which(&o.name).ok_or_else(not_installed)?;
    let mut cmd = Command::new(path);
    cmd.args(&o.args);
    if let Some(dir) = &o.dir {
        cmd.current_dir(dir);
    }
    if o.c_locale {
        cmd.env("LC_ALL", "C").env("LANG", "C");
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => not_installed(),
        std::io::ErrorKind::PermissionDenied => {
            ProviderError::PermissionDenied(format!("cannot run {}: {e}", o.name))
        }
        _ => ProviderError::internal(format!("starting {}: {e}", o.name)),
    })?;
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<(bool, String)>(256);
    let pump = |reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
                is_stdout: bool,
                tx: tokio::sync::mpsc::Sender<(bool, String)>| async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send((is_stdout, line)).await.is_err() {
                break;
            }
        }
    };
    let t1 = tokio::spawn(pump(Box::new(stdout), true, tx.clone()));
    let t2 = tokio::spawn(pump(Box::new(stderr), false, tx));

    let mut lines: Vec<(bool, String)> = Vec::new();
    let mut peer_open = true;
    let relay = async {
        while let Some((is_stdout, raw)) = rx.recv().await {
            let clean = parse::strip_ansi(&raw);
            let shown = redactor.line(&clean);
            if lines.len() < MAX_CAPTURED_LINES {
                lines.push((is_stdout, clean));
            }
            if peer_open {
                let mut out = shown;
                out.push('\n');
                if stream.send(out.as_bytes(), Encoding::Utf8).await.is_err() {
                    peer_open = false;
                }
            }
        }
    };

    let status = tokio::select! {
        _ = relay => child.wait().await.map_err(|e| ProviderError::internal(format!("waiting for {}: {e}", o.name)))?,
        _ = ctx.done() => {
            let _ = child.start_kill();
            return Err(ctx.error());
        }
    };
    let _ = t1.await;
    let _ = t2.await;
    Ok(Captured {
        lines,
        code: status.code(),
    })
}

/// A scratch directory removed when the deploy ends, whichever way.
struct TempDir(PathBuf);

impl TempDir {
    fn create() -> PResult<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("kaname-yunori-{}", uuid::Uuid::new_v4().simple()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Self(dir))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Streams `url` to `dest`, hashing as it writes, and refuses anything
/// whose SHA-256 is not `sha256` or that outgrows the cap. A rejected file
/// is deleted before returning.
async fn download_verified(ctx: &Ctx, url: &str, sha256: &str, dest: &Path) -> PResult<u64> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| ProviderError::internal(format!("http client: {e}")))?;
    let fetch = |e: reqwest::Error| ProviderError::exec("download", e.to_string(), url);
    let response = ctx.run(client.get(url).send()).await?.map_err(fetch)?;
    let mut response = response.error_for_status().map_err(fetch)?;
    if response.content_length().is_some_and(|n| n > MAX_ARCHIVE_BYTES) {
        return Err(ProviderError::PreconditionFailed(format!(
            "the release archive is larger than {} MiB",
            MAX_ARCHIVE_BYTES >> 20
        )));
    }

    let mut file = tokio::fs::File::create(dest).await?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let result: PResult<()> = async {
        while let Some(chunk) = ctx.run(response.chunk()).await?.map_err(fetch)? {
            written += chunk.len() as u64;
            if written > MAX_ARCHIVE_BYTES {
                return Err(ProviderError::PreconditionFailed(format!(
                    "the release archive is larger than {} MiB",
                    MAX_ARCHIVE_BYTES >> 20
                )));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        let digest = hex::encode(hasher.finalize());
        if digest != sha256.trim().to_ascii_lowercase() {
            return Err(ProviderError::PreconditionFailed(format!(
                "checksum mismatch: the archive hashes to {digest}, expected {sha256}; refusing to install"
            )));
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = std::fs::remove_file(dest);
        return Err(e);
    }
    Ok(written)
}

/// Pulls the `yunori-mail` member out of a release tarball into `dest`
/// (mode 0755). `Ok(false)` when the archive holds no such file.
fn extract_binary(archive: &Path, dest: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar.entries()? {
        let mut entry = entry?;
        let is_member = entry.path()?.file_name().and_then(|n| n.to_str()) == Some(BINARY_MEMBER);
        if !is_member || !entry.header().entry_type().is_file() {
            continue;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(dest)?;
        std::io::copy(&mut entry, &mut out)?;
        out.sync_all()?;
        return Ok(true);
    }
    Ok(false)
}

/// The swap install.sh does: copy next to the target, chmod 0755, rename.
/// A running service keeps its old binary until it restarts.
fn install_binary(src: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let target = Path::new(YUNORI_BIN);
    let dir = target.parent().unwrap_or(Path::new("/usr/local/bin"));
    std::fs::create_dir_all(dir)?;
    let staged = dir.join(".yunori-mail.new");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(src, &staged)?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(&staged, target)?;
    exec::sync_dir(dir)
}

/// `yunori-mail --version` of the binary at `bin`, as "0.1.0", or None
/// when it does not run here.
async fn binary_version(ctx: &Ctx, bin: &Path) -> Option<String> {
    let out = exec::run_raw(ctx, &yunori(bin, &["--version"])).await.ok()?;
    if !out.success() {
        return None;
    }
    parse::version(&out.stdout)
}

/// The argv of the unattended installer for `p`; the relay password is
/// not in it (it travels in `RELAY_PASSWORD_ENV`).
pub fn install_args(p: &MailDeployParams) -> PResult<Vec<String>> {
    let sending = match p.sending.as_str() {
        "direct" | "relay" => p.sending.as_str(),
        other => {
            return Err(ProviderError::invalid(format!(
                "sending must be \"direct\" or \"relay\", not {other:?}"
            )));
        }
    };
    let mut args: Vec<String> = vec![
        "install".into(),
        "--yes".into(),
        "--no-wait".into(),
        "--domain".into(),
        p.domain.clone(),
        "--hostname".into(),
        p.hostname.clone(),
        "--admin-email".into(),
        p.admin_email.clone(),
        "--first-mailbox".into(),
        p.first_mailbox.clone(),
        "--sending".into(),
        sending.into(),
    ];
    if sending == "relay" {
        let relay = p
            .relay
            .as_ref()
            .ok_or_else(|| ProviderError::invalid("relay sending needs the relay settings"))?;
        if !relay.provider.is_empty() {
            args.extend(["--relay-provider".to_string(), relay.provider.clone()]);
        }
        if let Some(host) = &relay.host {
            args.extend(["--relay-host".to_string(), host.clone()]);
        }
        if let Some(region) = &relay.region {
            args.extend(["--relay-region".to_string(), region.clone()]);
        }
        args.extend(["--relay-port".to_string(), relay.port.to_string()]);
        if let Some(user) = &relay.username {
            args.extend(["--relay-user".to_string(), user.clone()]);
        }
        if relay.password.is_some() {
            args.extend(["--relay-password-env".to_string(), RELAY_PASSWORD_ENV.to_string()]);
        }
    }
    if p.force {
        args.push("--force".into());
    }
    if p.skip_ptr {
        args.push("--skip-ptr".into());
    }
    Ok(args)
}

/// The journalctl argv behind `mail.logs`.
pub fn journal_args(p: &MailLogsParams) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for unit in JOURNAL_UNITS {
        args.extend(["-u".to_string(), unit.to_string()]);
    }
    args.extend(["-o".to_string(), "json".to_string(), "--no-pager".to_string()]);
    args.extend(["-n".to_string(), p.lines.clamp(1, 10_000).to_string()]);
    if p.follow {
        args.push("-f".into());
    }
    if let Some(q) = p.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        args.extend(["-g".to_string(), q.to_string()]);
    }
    args
}

impl MailOps {
    /// The binary to run, or `unsupported`. The live binary check comes
    /// first because a host deployed during this process's lifetime has the
    /// binary but not the start-up capability; the capability gate stays
    /// as the fallback answer.
    fn bin(&self) -> PResult<PathBuf> {
        match binary() {
            Some(b) => Ok(b),
            None => {
                self.0.require(cap::YUNORI)?;
                Err(not_installed())
            }
        }
    }

    async fn run(&self, ctx: &Ctx, args: &[&str]) -> PResult<String> {
        let bin = self.bin()?;
        let o = yunori(&bin, args);
        let out = exec::run_raw(ctx, &o).await?;
        if out.success() {
            Ok(out.stdout)
        } else {
            Err(cli_failure(
                &format!("yunori-mail {}", args.first().copied().unwrap_or("")),
                &out,
                &[],
            ))
        }
    }

    /// Runs a command whose failure text names the reason.
    async fn run_mapped(&self, ctx: &Ctx, args: &[&str], rules: &[(&str, Kind)]) -> PResult<String> {
        let bin = self.bin()?;
        let o = yunori(&bin, args);
        let out = exec::run_raw(ctx, &o).await?;
        if out.success() {
            Ok(out.stdout)
        } else {
            let op = format!(
                "yunori-mail {}",
                args.iter().take(2).copied().collect::<Vec<_>>().join(" ")
            );
            Err(cli_failure(&op, &out, rules))
        }
    }

    /// `preflight --json` / `doctor --json`: exit 2 means blocking failures
    /// but the report on stdout is still the answer, so the JSON decides
    /// and the exit status does not.
    async fn checks(&self, ctx: &Ctx, args: &[&str]) -> PResult<Vec<MailCheck>> {
        let bin = self.bin()?;
        let out = exec::run_raw(ctx, &yunori(&bin, args)).await?;
        match parse::checks_json(&out.stdout) {
            Ok(checks) if out.success() || out.code == Some(2) => Ok(checks),
            Ok(checks) if !out.stdout.trim().is_empty() => Ok(checks),
            _ => Err(cli_failure(&format!("yunori-mail {}", args[0]), &out, &[])),
        }
    }

    async fn service_active(&self, ctx: &Ctx, unit: &str) -> bool {
        let o = ExecOptions::new("systemctl", ["is-active", "--quiet", unit]).c_locale();
        matches!(exec::run_raw(ctx, &o).await, Ok(out) if out.success())
    }

    async fn stream_yunori(
        &self,
        ctx: &Ctx,
        stream: &dyn Stream,
        bin: &Path,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> PResult<Captured> {
        let mut o = yunori(bin, args);
        for (k, v) in env {
            o = o.env(*k, *v);
        }
        let mut redactor = parse::Redactor::new();
        stream_command(ctx, stream, o, &mut redactor).await
    }

    /// Everything `deploy` does before `yunori-mail install`: makes sure
    /// `/usr/local/bin/yunori-mail` is release `p.version`. Returns whether
    /// the binary was replaced.
    async fn ensure_release(&self, ctx: &Ctx, p: &MailDeployParams, stream: &dyn Stream) -> PResult<bool> {
        if let Some(bin) = exec::which(YUNORI_BIN) {
            if binary_version(ctx, &bin).await.as_deref() == Some(p.version.as_str()) {
                say(
                    stream,
                    format!(
                        "yunori-mail {} is already installed; skipping the download.",
                        p.version
                    ),
                )
                .await;
                return Ok(false);
            }
        }
        let tmp = TempDir::create()?;
        let archive = tmp.path().join("release.tar.gz");
        say(
            stream,
            format!("Downloading Yunori Mail Server {} from {}…", p.version, p.url),
        )
        .await;
        let bytes = download_verified(ctx, &p.url, &p.sha256, &archive).await?;
        say(stream, format!("Downloaded {} bytes; SHA-256 verified.", bytes)).await;

        let extracted = tmp.path().join(BINARY_MEMBER);
        let (archive_b, extracted_b) = (archive.clone(), extracted.clone());
        let found = ctx
            .run(tokio::task::spawn_blocking(move || {
                extract_binary(&archive_b, &extracted_b)
            }))
            .await?
            .map_err(|e| ProviderError::internal(format!("extracting the release: {e}")))??;
        if !found {
            return Err(ProviderError::PreconditionFailed(
                "the download is not a yunori-mail release (no yunori-mail member in the archive)".into(),
            ));
        }
        match binary_version(ctx, &extracted).await {
            Some(v) if v == p.version => {}
            Some(v) => {
                return Err(ProviderError::PreconditionFailed(format!(
                    "the downloaded binary is yunori-mail {v}, not {}",
                    p.version
                )));
            }
            None => {
                return Err(ProviderError::PreconditionFailed(
                    "the downloaded binary doesn't run on this server".into(),
                ));
            }
        }
        install_binary(&extracted)?;
        say(stream, format!("Installed {YUNORI_BIN} (checksum verified).")).await;
        Ok(true)
    }
}

#[async_trait]
impl Mail for MailOps {
    async fn status(&self, ctx: &Ctx) -> PResult<MailServerStatusInfo> {
        let Some(bin) = binary() else {
            return Ok(MailServerStatusInfo::default());
        };
        let version = binary_version(ctx, &bin).await;
        // `status` fails before the first install step has created the
        // database; that is "nothing done yet", not an error.
        let steps = match exec::run_raw(ctx, &yunori(&bin, &["status"])).await {
            Ok(out) if out.success() => parse::status_steps(&out.stdout),
            _ => Vec::new(),
        };
        let mut services = Vec::with_capacity(SERVICES.len());
        for name in SERVICES {
            services.push(MailServiceState {
                name: name.to_string(),
                active: self.service_active(ctx, name).await,
            });
        }
        let hostnames = match exec::run_raw(ctx, &yunori(&bin, &["certificate", "status"])).await {
            Ok(out) if out.success() => parse::certificate_status(&out.stdout).covers,
            _ => Vec::new(),
        };
        let console_url = hostnames.first().map(|h| format!("https://{h}/console"));
        let install_complete = !steps.is_empty()
            && steps.iter().all(|s| {
                matches!(
                    s.status,
                    MailInstallStepStatus::Done | MailInstallStepStatus::Skipped
                )
            });
        Ok(MailServerStatusInfo {
            installed: true,
            version,
            install_complete,
            steps,
            services,
            hostnames,
            console_url,
        })
    }

    async fn preflight(&self, ctx: &Ctx, p: MailPreflightParams) -> PResult<Vec<MailCheck>> {
        let mut args = vec!["preflight", "--json"];
        if let Some(h) = p.hostname.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
            args.extend(["--hostname", h]);
        }
        self.checks(ctx, &args).await
    }

    async fn doctor(&self, ctx: &Ctx) -> PResult<Vec<MailCheck>> {
        self.checks(ctx, &["doctor", "--json"]).await
    }

    async fn deploy(&self, ctx: &Ctx, p: MailDeployParams, s: StreamRef) -> PResult<MailDeployResult> {
        let stream: &dyn Stream = s.as_ref();
        if p.version.trim().is_empty() || p.url.trim().is_empty() || p.sha256.trim().is_empty() {
            return Err(ProviderError::invalid(
                "deploy needs the release's version, url and sha256",
            ));
        }
        let args = install_args(&p)?;
        if exec::which(YUNORI_BIN).is_some() {
            let current = self.status(ctx).await?;
            if current.install_complete {
                return Err(ProviderError::PreconditionFailed(
                    "Yunori Mail Server is already installed on this host; use update".into(),
                ));
            }
        }

        say(
            stream,
            format!(
                "Deploying Yunori Mail Server {} for {} (hostname {}): verified download, then the unattended installer.",
                p.version, p.domain, p.hostname
            ),
        )
        .await;
        let replaced = self.ensure_release(ctx, &p, stream).await?;
        let bin = exec::which(YUNORI_BIN).ok_or_else(not_installed)?;

        say(stream, "Running yunori-mail install…").await;
        let password = p
            .relay
            .as_ref()
            .and_then(|r| r.password.clone())
            .unwrap_or_default();
        let replaced_flag = if replaced { "1" } else { "0" };
        let mut env: Vec<(&str, &str)> = vec![("YUNORI_BINARY_REPLACED", replaced_flag)];
        if p.relay.as_ref().is_some_and(|r| r.password.is_some()) {
            env.push((RELAY_PASSWORD_ENV, password.as_str()));
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let captured = self.stream_yunori(ctx, stream, &bin, &argv, &env).await?;

        let lines = captured.all_lines();
        if captured.code == Some(2) {
            let sentence = parse::not_ready_sentence(&lines).unwrap_or_else(|| {
                "This server is not ready: the preflight checks refused the install.".into()
            });
            return Err(ProviderError::PreconditionFailed(sentence));
        }
        let summary = parse::install_output(&lines);
        let outcome = if captured.success() {
            summary.outcome
        } else {
            MailDeployOutcome::Failed
        };
        let steps = self.status(ctx).await.map(|s| s.steps).unwrap_or_default();
        Ok(MailDeployResult {
            outcome,
            version: p.version.clone(),
            paused_at: summary.paused_at,
            setup_url: summary.setup_url,
            console_url: summary.console_url,
            first_mailbox: summary.first_mailbox,
            first_mailbox_password: summary.first_mailbox_password,
            steps,
        })
    }

    async fn update(&self, ctx: &Ctx, s: StreamRef) -> PResult<()> {
        let bin = self.bin()?;
        let captured = self
            .stream_yunori(ctx, s.as_ref(), &bin, &["update"], &[])
            .await?;
        if captured.success() {
            Ok(())
        } else {
            let mut redactor = parse::Redactor::new();
            let shown: Vec<String> = captured.all_lines().iter().map(|l| redactor.line(l)).collect();
            Err(exec::exec_error(
                "yunori-mail update",
                exec::tail(&shown.join("\n"), exec::EXEC_OUTPUT_LIMIT),
                captured.code,
            ))
        }
    }

    async fn list_domains(&self, ctx: &Ctx) -> PResult<Vec<MailDomainEntry>> {
        let out = self.run(ctx, &["domain", "list"]).await?;
        Ok(parse::domain_list(&out))
    }

    async fn add_domain(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<()> {
        self.run_mapped(
            ctx,
            &["domain", "add", &p.name],
            &[
                ("invalid domain", Kind::Invalid),
                ("already exists", Kind::Conflict),
            ],
        )
        .await?;
        Ok(())
    }

    async fn remove_domain(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<()> {
        self.run_mapped(
            ctx,
            &["domain", "remove", &p.name],
            &[
                ("still has mailboxes", Kind::Conflict),
                ("is not on this server", Kind::NotFound),
                ("invalid domain", Kind::Invalid),
            ],
        )
        .await?;
        Ok(())
    }

    async fn domain_dns(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<MailDomainDnsResult> {
        let out = self
            .run_mapped(
                ctx,
                &["domain", "dns", &p.name],
                &[
                    ("is not on this server", Kind::NotFound),
                    ("invalid domain", Kind::Invalid),
                ],
            )
            .await?;
        Ok(parse::domain_dns(&out))
    }

    async fn list_mailboxes(&self, ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailboxEntry>> {
        let out = self.run(ctx, &["mailbox", "list"]).await?;
        let mut boxes = parse::mailbox_list(&out);
        if let Some(domain) = p.domain.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            boxes.retain(|m| parse::in_domain(&m.address, domain));
        }
        Ok(boxes)
    }

    async fn add_mailbox(&self, ctx: &Ctx, p: MailboxAddParams) -> PResult<MailPasswordResult> {
        let mut args = vec!["mailbox", "add", p.address.as_str()];
        let quota = p.quota_mb.map(|q| q.to_string());
        if let Some(name) = p.display_name.as_deref().filter(|n| !n.trim().is_empty()) {
            args.extend(["--name", name]);
        }
        if let Some(q) = quota.as_deref() {
            args.extend(["--quota-mb", q]);
        }
        let out = self
            .run_mapped(
                ctx,
                &args,
                &[
                    ("is not on this server", Kind::NotFound),
                    ("invalid mailbox name", Kind::Invalid),
                    ("expected an address like", Kind::Invalid),
                    ("already exists", Kind::Conflict),
                    ("conflict", Kind::Conflict),
                    ("exists", Kind::Conflict),
                ],
            )
            .await?;
        let password = parse::shown_once(&out)
            .ok_or_else(|| ProviderError::internal("yunori-mail did not print the mailbox password"))?;
        Ok(MailPasswordResult { password })
    }

    async fn mailbox_password(&self, ctx: &Ctx, p: MailAddressParams) -> PResult<MailPasswordResult> {
        let out = self
            .run_mapped(
                ctx,
                &["mailbox", "passwd", &p.address],
                &[("no such mailbox", Kind::NotFound)],
            )
            .await?;
        let password = parse::shown_once(&out)
            .ok_or_else(|| ProviderError::internal("yunori-mail did not print the new password"))?;
        Ok(MailPasswordResult { password })
    }

    async fn remove_mailbox(&self, ctx: &Ctx, p: MailAddressParams) -> PResult<()> {
        self.run_mapped(
            ctx,
            &["mailbox", "remove", &p.address, "--yes"],
            &[
                ("no such mailbox", Kind::NotFound),
                ("administrator account", Kind::Precondition),
            ],
        )
        .await?;
        Ok(())
    }

    async fn list_aliases(&self, ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailAliasEntry>> {
        let out = self.run(ctx, &["alias", "list"]).await?;
        let mut aliases = parse::alias_list(&out);
        if let Some(domain) = p.domain.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            aliases.retain(|a| parse::in_domain(&a.address, domain));
        }
        Ok(aliases)
    }

    async fn add_alias(&self, ctx: &Ctx, p: MailAliasAddParams) -> PResult<()> {
        self.run_mapped(
            ctx,
            &["alias", "add", &p.alias, &p.mailbox],
            &[
                ("an alias cannot shadow it", Kind::Conflict),
                ("no such mailbox", Kind::NotFound),
                ("is not on this server", Kind::NotFound),
                ("invalid mailbox name", Kind::Invalid),
                ("expected an address like", Kind::Invalid),
            ],
        )
        .await?;
        Ok(())
    }

    async fn remove_alias(&self, ctx: &Ctx, p: MailAliasRemoveParams) -> PResult<()> {
        self.run_mapped(
            ctx,
            &["alias", "remove", &p.alias],
            &[("no such alias", Kind::NotFound)],
        )
        .await?;
        Ok(())
    }

    async fn certificate_status(&self, ctx: &Ctx) -> PResult<MailCertificateStatus> {
        let out = self.run(ctx, &["certificate", "status"]).await?;
        Ok(parse::certificate_status(&out))
    }

    async fn certificate_renew(&self, ctx: &Ctx, s: StreamRef) -> PResult<MailCertificateRenewResult> {
        let bin = self.bin()?;
        let captured = self
            .stream_yunori(ctx, s.as_ref(), &bin, &["certificate", "renew"], &[])
            .await?;
        // Exit 1 is a reported failure ("Let's Encrypt could not …"): the
        // last sentence explains it, so it is the outcome, not an error.
        let mut outcome = parse::last_line(&captured.stdout_lines());
        if outcome.is_empty() {
            outcome = parse::last_line(&captured.all_lines());
        }
        if outcome.is_empty() {
            return Err(exec::exec_error(
                "yunori-mail certificate renew",
                "",
                captured.code,
            ));
        }
        Ok(MailCertificateRenewResult {
            outcome: outcome.trim_start_matches("error: ").to_string(),
        })
    }

    async fn logs(&self, ctx: &Ctx, p: MailLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        self.bin()?;
        if !exec::has_binary("journalctl") {
            return Err(ProviderError::unsupported_because("journalctl is not installed"));
        }
        let args = journal_args(&p);
        if !p.follow {
            let o = ExecOptions::new("journalctl", args.iter().map(String::as_str)).c_locale();
            let out = exec::run_raw(ctx, &o).await?;
            if !out.success() && out.stdout.trim().is_empty() {
                return Err(exec::exec_error("journalctl", out.stderr.trim(), out.code));
            }
            return Ok(out.stdout.lines().filter_map(parse::journal_record).collect());
        }

        let path =
            exec::which("journalctl").ok_or_else(|| ProviderError::unsupported_because("journalctl"))?;
        let mut cmd = Command::new(path);
        cmd.args(&args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| ProviderError::internal(format!("starting journalctl: {e}")))?;
        let stdout = child.stdout.take().expect("piped");
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let next = tokio::select! {
                line = lines.next_line() => line,
                _ = ctx.done() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(ctx.error());
                }
            };
            match next {
                Ok(Some(line)) => {
                    if let Some(record) = parse::journal_record(&line) {
                        let mut text = serde_json::to_string(&record)?;
                        text.push('\n');
                        if s.send(text.as_bytes(), Encoding::Utf8).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
        Ok(Vec::new())
    }
}

/* -------------------------------- parsing ----------------------------- */

/// Pure readers of yunori-mail's terminal output. Each one matches a
/// `println!` in yunori-mail's `src/cli.rs`; the tests feed them text in
/// exactly that shape.
pub mod parse {
    use serde::Deserialize;

    use crate::providers::*;

    /// Removes CSI sequences (`ESC [ … m` and friends), the only ANSI the
    /// CLI's `Term::paint` ever emits.
    pub fn strip_ansi(s: &str) -> String {
        if !s.contains('\x1b') {
            return s.to_string();
        }
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\x1b' {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c in chars.by_ref() {
                        if c.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                continue;
            }
            out.push(c);
        }
        out
    }

    /// `yunori-mail 0.1.0` → `0.1.0`.
    pub fn version(s: &str) -> Option<String> {
        let line = strip_ansi(s);
        let line = line.lines().find(|l| !l.trim().is_empty())?.trim();
        let rest = line.strip_prefix("yunori-mail")?.trim();
        if rest.is_empty() {
            None
        } else {
            Some(rest.to_string())
        }
    }

    /// Address `addr` is in `domain` (case-insensitive, exact domain).
    pub fn in_domain(addr: &str, domain: &str) -> bool {
        let domain = domain.trim().trim_start_matches('@').to_ascii_lowercase();
        addr.rsplit_once('@')
            .map(|(_, d)| d.eq_ignore_ascii_case(&domain))
            .unwrap_or(false)
    }

    /// The reason a failed command printed: `error: …` on stderr (how
    /// `main` prints an `anyhow` error), else the stderr tail, else stdout.
    pub fn error_message(stderr: &str, stdout: &str) -> String {
        let stderr = strip_ansi(stderr);
        if let Some(line) = stderr.lines().map(str::trim).find(|l| l.starts_with("error: ")) {
            return line.trim_start_matches("error: ").trim().to_string();
        }
        let err = stderr.trim();
        if !err.is_empty() {
            return err.lines().last().unwrap_or(err).trim().to_string();
        }
        strip_ansi(stdout)
            .trim()
            .lines()
            .last()
            .unwrap_or("")
            .trim()
            .to_string()
    }

    /* ---- status ---- */

    /// `  ✓ Title<pad to 32> detail` with the glyphs of `status()`:
    /// ✓ done, – skipped, … waiting, ✗ failed, › running, · pending.
    pub fn status_steps(s: &str) -> Vec<MailInstallStep> {
        let mut steps = Vec::new();
        for raw in s.lines() {
            let line = strip_ansi(raw);
            let line = line.trim_start();
            let mut chars = line.chars();
            let Some(glyph) = chars.next() else { continue };
            let status = match glyph {
                '✓' => MailInstallStepStatus::Done,
                '–' => MailInstallStepStatus::Skipped,
                '…' => MailInstallStepStatus::Waiting,
                '✗' => MailInstallStepStatus::Failed,
                '›' => MailInstallStepStatus::Running,
                '·' => MailInstallStepStatus::Pending,
                _ => continue,
            };
            let rest = chars.as_str();
            if !rest.starts_with(' ') {
                continue;
            }
            let rest = &rest[1..];
            // `{:<32}` pads by characters, so the title ends at column 32
            // unless it is longer, in which case there is no detail column.
            let (title, detail) = if rest.chars().count() > 32 {
                let cut: usize = rest.chars().take(32).map(char::len_utf8).sum();
                (rest[..cut].trim_end(), rest[cut..].trim())
            } else {
                (rest.trim_end(), "")
            };
            if title.is_empty() {
                continue;
            }
            steps.push(MailInstallStep {
                title: title.to_string(),
                status,
                detail: if detail.is_empty() {
                    None
                } else {
                    Some(detail.to_string())
                },
            });
        }
        steps
    }

    /* ---- checks ---- */

    /// `model::Check` as `--json` prints it (camelCase).
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CliCheck {
        id: String,
        label: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        detail: String,
        #[serde(default)]
        remedy: Option<String>,
        #[serde(default)]
        help_url: Option<String>,
    }

    /// The JSON array `preflight --json` and `doctor --json` print.
    pub fn checks_json(s: &str) -> Result<Vec<MailCheck>, serde_json::Error> {
        let start = s.find('[').unwrap_or(0);
        let raw: Vec<CliCheck> = serde_json::from_str(&s[start..])?;
        Ok(raw
            .into_iter()
            .map(|c| MailCheck {
                id: c.id,
                label: c.label,
                status: MailCheckStatus::from_tag(&c.status),
                detail: c.detail,
                remedy: c.remedy.filter(|r| !r.is_empty()),
                help_url: c.help_url.filter(|u| !u.is_empty()),
            })
            .collect())
    }

    /// `[  ok   ] rest` → `(tag, rest)`.
    fn tagged(line: &str) -> Option<(&str, &str)> {
        let line = line.trim_start();
        let inner = line.strip_prefix('[')?;
        let end = inner.find(']')?;
        Some((inner[..end].trim(), inner[end + 1..].trim()))
    }

    /* ---- domains ---- */

    /// `  [  ok   ] example.com<pad to 32> 3 mailbox(es)`.
    pub fn domain_list(s: &str) -> Vec<MailDomainEntry> {
        let mut out = Vec::new();
        for raw in s.lines() {
            let line = strip_ansi(raw);
            let Some((tag, rest)) = tagged(&line) else {
                continue;
            };
            let mut words = rest.split_whitespace();
            let Some(name) = words.next() else { continue };
            let count = words.next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
            out.push(MailDomainEntry {
                name: name.to_string(),
                dns_status: MailCheckStatus::from_tag(tag),
                mailbox_count: count,
            });
        }
        out
    }

    /// `print_records` followed by `Zone file:` and the zone text:
    /// `  [tag] TYPE  name  (optional)`, then optionally
    /// `            value: …` and `            found: a | b`.
    pub fn domain_dns(s: &str) -> MailDomainDnsResult {
        let text = strip_ansi(s);
        let mut records: Vec<MailDnsRecord> = Vec::new();
        let mut zone: Vec<&str> = Vec::new();
        let mut in_zone = false;
        for line in text.lines() {
            if in_zone {
                zone.push(line);
                continue;
            }
            if line.trim() == "Zone file:" {
                in_zone = true;
                continue;
            }
            let trimmed = line.trim();
            if let Some(value) = trimmed.strip_prefix("value:") {
                if let Some(last) = records.last_mut() {
                    last.expected = Some(value.trim().to_string());
                }
                continue;
            }
            if let Some(found) = trimmed.strip_prefix("found:") {
                if let Some(last) = records.last_mut() {
                    last.actual = found
                        .split(" | ")
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect();
                }
                continue;
            }
            let Some((tag, rest)) = tagged(line) else { continue };
            let required = !rest.ends_with("(optional)");
            let rest = rest.trim_end_matches("(optional)").trim();
            let mut words = rest.split_whitespace();
            let (Some(rtype), Some(name)) = (words.next(), words.next()) else {
                continue;
            };
            records.push(MailDnsRecord {
                id: format!("{rtype}:{name}"),
                rtype: rtype.to_string(),
                name: name.to_string(),
                expected: None,
                actual: Vec::new(),
                status: MailCheckStatus::from_tag(tag),
                required,
            });
        }
        let mut zone_file = zone.join("\n");
        while zone_file.ends_with('\n') {
            zone_file.pop();
        }
        MailDomainDnsResult { records, zone_file }
    }

    /* ---- mailboxes / aliases ---- */

    /// `  addr<pad to 36> Display Name  (aliases: a@x, b@y)`.
    pub fn mailbox_list(s: &str) -> Vec<MailboxEntry> {
        let mut out = Vec::new();
        for raw in s.lines() {
            let line = strip_ansi(raw);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let (address, rest) = match line.split_once(char::is_whitespace) {
                Some((a, r)) => (a, r.trim()),
                None => (line, ""),
            };
            if !address.contains('@') {
                continue;
            }
            let (display, aliases) = match rest.find("(aliases:") {
                Some(i) => {
                    let list = rest[i + "(aliases:".len()..].trim().trim_end_matches(')').trim();
                    (
                        rest[..i].trim(),
                        list.split(',')
                            .map(|a| a.trim().to_string())
                            .filter(|a| !a.is_empty())
                            .collect(),
                    )
                }
                None => (rest, Vec::new()),
            };
            out.push(MailboxEntry {
                address: address.to_string(),
                display_name: if display.is_empty() {
                    None
                } else {
                    Some(display.to_string())
                },
                aliases,
            });
        }
        out
    }

    /// `  alias@x<pad to 36> → mailbox@x`.
    pub fn alias_list(s: &str) -> Vec<MailAliasEntry> {
        let mut out = Vec::new();
        for raw in s.lines() {
            let line = strip_ansi(raw);
            let Some((alias, mailbox)) = line.split_once('→') else {
                continue;
            };
            let (alias, mailbox) = (alias.trim(), mailbox.trim());
            if alias.is_empty() || mailbox.is_empty() {
                continue;
            }
            out.push(MailAliasEntry {
                address: alias.to_string(),
                mailbox: mailbox.to_string(),
            });
        }
        out
    }

    /// The value after `(shown once): ` — `Password (shown once): X` and
    /// `New password for a@b (shown once): X`.
    pub fn shown_once(s: &str) -> Option<String> {
        strip_ansi(s)
            .lines()
            .find_map(|l| l.split_once("(shown once):").map(|(_, v)| v.trim().to_string()))
            .filter(|v| !v.is_empty())
    }

    /* ---- rows ---- */

    /// The value of a `  {:<14} {v}` row whose key is `key`, matched on
    /// the exact printed padding so "Mailbox" never claims "Mailbox portal".
    pub fn row<'a>(line: &'a str, key: &str) -> Option<&'a str> {
        let padded = format!("{key:<14} ");
        line.trim_start().strip_prefix(padded.as_str()).map(str::trim)
    }

    fn find_row(lines: &[String], key: &str) -> Option<String> {
        lines.iter().find_map(|l| row(l, key)).map(str::to_string)
    }

    /* ---- certificate ---- */

    /// `certificate status` rows: Certificate "none yet", or Covers /
    /// Issuer / Expires, then Authority, Renews from, Last attempt (+ CA
    /// said) and Next attempt.
    pub fn certificate_status(s: &str) -> MailCertificateStatus {
        let lines: Vec<String> = strip_ansi(s).lines().map(str::to_string).collect();
        let mut st = MailCertificateStatus {
            state: "unknown".into(),
            ..Default::default()
        };
        if find_row(&lines, "Certificate").is_some_and(|v| v == "none yet") {
            st.state = "missing".into();
        }
        if let Some(covers) = find_row(&lines, "Covers") {
            st.covers = covers
                .split(',')
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .collect();
        }
        st.issuer = find_row(&lines, "Issuer").filter(|v| v != "—" && !v.is_empty());
        if let Some(expires) = find_row(&lines, "Expires") {
            if expires.starts_with("— (temporary self-signed") {
                st.state = "self_signed".into();
            } else {
                let mut words = expires.split_whitespace();
                st.expires_at = words.next().filter(|w| *w != "—").map(str::to_string);
                st.days_left = expires
                    .split_once('(')
                    .and_then(|(_, r)| r.split_once(" day"))
                    .and_then(|(n, _)| n.trim().parse::<i64>().ok());
                st.state = if expires.contains("test certificate") {
                    "test".into()
                } else if expires.contains("EXPIRED") {
                    "expired".into()
                } else {
                    "valid".into()
                };
            }
        }
        st.authority = find_row(&lines, "Authority").filter(|v| !v.is_empty());
        st.renews_at = find_row(&lines, "Renews from").filter(|v| !v.is_empty());
        st.last_attempt = find_row(&lines, "Last attempt").filter(|v| !v.is_empty());
        if let (Some(last), Some(said)) = (st.last_attempt.as_mut(), find_row(&lines, "CA said")) {
            last.push_str(&format!(" (CA said: {said})"));
        }
        st.next_attempt = find_row(&lines, "Next attempt").filter(|v| !v.is_empty());
        st
    }

    /* ---- install ---- */

    /// What `yunori-mail install` printed, read back.
    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    pub struct InstallSummary {
        pub outcome: MailDeployOutcome,
        pub paused_at: Option<String>,
        pub setup_url: Option<String>,
        pub console_url: Option<String>,
        pub first_mailbox: Option<String>,
        pub first_mailbox_password: Option<String>,
    }

    /// Reads `install`'s output: the setup link (`Continue in your
    /// browser…` block or the `Finish setup` row), the first mailbox's
    /// password (`Password for a@b` block or `Password (shown once):`),
    /// the summary rows and the headline of `final_summary`.
    pub fn install_output(lines: &[String]) -> InstallSummary {
        let lines: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
        let mut out = InstallSummary::default();
        let mut password_next = false;
        let mut in_your_turn = false;
        for line in &lines {
            let trimmed = line.trim();
            if password_next {
                password_next = false;
                if !trimmed.is_empty() && out.first_mailbox_password.is_none() {
                    out.first_mailbox_password = Some(trimmed.to_string());
                    continue;
                }
            }
            if out.setup_url.is_none() {
                if let Some(url) = trimmed
                    .split_whitespace()
                    .find(|w| w.contains("/console/setup#token="))
                {
                    out.setup_url = Some(url.to_string());
                }
            }
            if trimmed.starts_with("Password for ") {
                password_next = true;
            } else if let Some((_, v)) = trimmed.split_once("Password (shown once):") {
                if out.first_mailbox_password.is_none() && !v.trim().is_empty() {
                    out.first_mailbox_password = Some(v.trim().to_string());
                }
            }
            if trimmed == "Yunori Mail Server is ready." {
                out.outcome = MailDeployOutcome::Ready;
            } else if trimmed.starts_with("Paused") {
                out.outcome = MailDeployOutcome::Paused;
                if let Some((_, rest)) = trimmed.split_once('“') {
                    if let Some((title, _)) = rest.split_once('”') {
                        out.paused_at = Some(title.to_string());
                    }
                }
            } else if trimmed == "The install stopped." || trimmed.starts_with("The install stopped:") {
                out.outcome = MailDeployOutcome::Failed;
            }
            if trimmed == "Your turn" {
                in_your_turn = true;
                continue;
            }
            if in_your_turn {
                if let Some(item) = trimmed.strip_prefix("· ") {
                    if out.paused_at.is_none() {
                        let title = item.split_once(": ").map(|(t, _)| t).unwrap_or(item);
                        out.paused_at = Some(title.trim().to_string());
                    }
                } else {
                    in_your_turn = false;
                }
            }
        }
        out.console_url = find_row(&lines, "Console");
        out.first_mailbox = find_row(&lines, "Mailbox");
        out
    }

    /// The preflight verdict that made `install` exit 2.
    pub fn not_ready_sentence(lines: &[String]) -> Option<String> {
        lines
            .iter()
            .map(|l| strip_ansi(l))
            .map(|l| l.trim().to_string())
            .find(|l| l.starts_with("This server is not ready"))
    }

    /// The last line with text on it.
    pub fn last_line(lines: &[String]) -> String {
        lines
            .iter()
            .rev()
            .map(|l| strip_ansi(l))
            .map(|l| l.trim().to_string())
            .find(|l| !l.is_empty())
            .unwrap_or_default()
    }

    /* ---- redaction ---- */

    /// Keeps the secrets yunori-mail shows once out of the relayed stream:
    /// the setup token in `#token=…`, anything after `(shown once):`, and
    /// the value line that follows a `Password for …` / recovery-key label
    /// (the installer's `secret()` prints the value on its own line).
    #[derive(Default)]
    pub struct Redactor {
        mask_next: bool,
    }

    impl Redactor {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn line(&mut self, line: &str) -> String {
            if self.mask_next {
                self.mask_next = false;
                if !line.trim().is_empty() {
                    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    return format!("{indent}…");
                }
            }
            let trimmed = line.trim();
            if trimmed.starts_with("Password for ") || trimmed.starts_with("Backup recovery key") {
                self.mask_next = true;
            }
            redact(line)
        }
    }

    /// The stateless part of redaction, for any single line.
    pub fn redact(line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let mut rest = line;
        while let Some(i) = rest.find("#token=") {
            let after = &rest[i + "#token=".len()..];
            let end = after.find(|c: char| c.is_whitespace()).unwrap_or(after.len());
            out.push_str(&rest[..i]);
            out.push_str("#token=…");
            rest = &after[end..];
        }
        out.push_str(rest);
        if let Some(i) = out.find("(shown once):") {
            out.truncate(i + "(shown once):".len());
            out.push_str(" …");
        }
        out
    }

    /* ---- journal ---- */

    fn json_text(v: Option<&serde_json::Value>) -> String {
        match v {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(bytes)) => {
                let raw: Vec<u8> = bytes.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect();
                String::from_utf8_lossy(&raw).into_owned()
            }
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    }

    /// syslog priority → the contract's level words.
    pub fn level_from_priority(p: &str) -> &'static str {
        match p.trim() {
            "0" | "1" | "2" | "3" => "error",
            "4" => "warn",
            "5" => "notice",
            "7" => "debug",
            _ => "info",
        }
    }

    /// One `journalctl -o json` line.
    pub fn journal_record(line: &str) -> Option<LogRecord> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        let obj = v.as_object()?;
        let ts = json_text(obj.get("__REALTIME_TIMESTAMP"))
            .parse::<i64>()
            .ok()
            .and_then(|us| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(
                    us.div_euclid(1_000_000),
                    (us.rem_euclid(1_000_000) * 1000) as u32,
                )
            })
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
        let source = {
            let unit = json_text(obj.get("_SYSTEMD_UNIT"));
            if unit.is_empty() {
                json_text(obj.get("SYSLOG_IDENTIFIER"))
            } else {
                unit
            }
        };
        Some(LogRecord {
            ts,
            level: level_from_priority(&json_text(obj.get("PRIORITY"))).to_string(),
            source,
            message: json_text(obj.get("MESSAGE")),
            fields: Default::default(),
            cursor: Some(json_text(obj.get("__CURSOR"))).filter(|c| !c.is_empty()),
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn lines(s: &str) -> Vec<String> {
            s.lines().map(str::to_string).collect()
        }

        #[test]
        fn strips_ansi_and_reads_version() {
            assert_eq!(strip_ansi("\x1b[32m✓\x1b[0m ok"), "✓ ok");
            assert_eq!(version("yunori-mail 0.1.0\n").as_deref(), Some("0.1.0"));
            assert_eq!(
                version("\x1b[1myunori-mail\x1b[0m 1.2.3").as_deref(),
                Some("1.2.3")
            );
            assert_eq!(version("something else"), None);
        }

        #[test]
        fn status_glyphs_titles_and_details() {
            // Exactly `println!("  {mark} {:<32} {}", title, detail)`.
            let text = format!(
                "  ✓ {:<32} {}\n  ✓ {:<32} {}\n  – {:<32} {}\n  … {:<32} {}\n  ✗ {:<32} {}\n  › {:<32} {}\n  · {:<32} {}\n  ✓ {:<32} {}\n",
                "Check this server",
                "All checks passed",
                "Your domain",
                "example.com",
                "Set reverse DNS",
                "skipped with --skip-ptr",
                "Publish DNS records",
                "Publish the MX record for example.com",
                "Get a trusted TLS certificate",
                "Let's Encrypt could not connect on port 80",
                "Create your first mailbox",
                "",
                "Finish",
                "",
                "Start the console and HTTPS edge",
                "https://mail.example.com/console",
            );
            let steps = status_steps(&text);
            assert_eq!(steps.len(), 8);
            assert_eq!(steps[0].title, "Check this server");
            assert_eq!(steps[0].status, MailInstallStepStatus::Done);
            assert_eq!(steps[0].detail.as_deref(), Some("All checks passed"));
            assert_eq!(steps[2].status, MailInstallStepStatus::Skipped);
            assert_eq!(steps[3].status, MailInstallStepStatus::Waiting);
            assert_eq!(steps[3].title, "Publish DNS records");
            assert_eq!(
                steps[3].detail.as_deref(),
                Some("Publish the MX record for example.com")
            );
            assert_eq!(steps[4].status, MailInstallStepStatus::Failed);
            assert_eq!(steps[5].status, MailInstallStepStatus::Running);
            assert_eq!(steps[5].detail, None);
            assert_eq!(steps[6].status, MailInstallStepStatus::Pending);
            assert_eq!(steps[6].title, "Finish");
            // A 32-character title has no padding before its detail.
            assert_eq!(steps[7].title, "Start the console and HTTPS edge");
            assert_eq!(
                steps[7].detail.as_deref(),
                Some("https://mail.example.com/console")
            );
            assert!(status_steps("error: no database\n").is_empty());
        }

        #[test]
        fn checks_json_maps_camel_case() {
            let json = r#"[
              {"id":"port25","label":"Outbound port 25","status":"fail","detail":"blocked","remedy":"Use relay mode","helpUrl":"https://yunori.email/help/port25"},
              {"id":"os","label":"Operating system","status":"pass","detail":"Debian 12"}
            ]"#;
            let checks = checks_json(json).unwrap();
            assert_eq!(checks.len(), 2);
            assert_eq!(checks[0].status, MailCheckStatus::Fail);
            assert_eq!(checks[0].remedy.as_deref(), Some("Use relay mode"));
            assert_eq!(
                checks[0].help_url.as_deref(),
                Some("https://yunori.email/help/port25")
            );
            assert_eq!(checks[1].status, MailCheckStatus::Pass);
            assert_eq!(checks[1].remedy, None);
            assert!(checks_json("not json").is_err());
        }

        #[test]
        fn domain_list_rows() {
            let text = format!(
                "  [{}] {:<32} {} mailbox(es)\n  [{}] {:<32} {} mailbox(es)\n  [{}] {:<32} {} mailbox(es)\n",
                "  ok   ", "example.com", 3, "problem", "example.org", 0, "  ?    ", "new.example", 1
            );
            let d = domain_list(&text);
            assert_eq!(d.len(), 3);
            assert_eq!(d[0].name, "example.com");
            assert_eq!(d[0].dns_status, MailCheckStatus::Pass);
            assert_eq!(d[0].mailbox_count, 3);
            assert_eq!(d[1].dns_status, MailCheckStatus::Fail);
            assert_eq!(d[1].mailbox_count, 0);
            assert_eq!(d[2].dns_status, MailCheckStatus::Unknown);
        }

        #[test]
        fn mailbox_list_with_and_without_aliases() {
            let text = format!(
                "  {:<36} {}{}\n  {:<36} {}{}\n  {:<36} {}{}\n",
                "ana@example.com",
                "Ana",
                "  (aliases: sales@example.com, info@example.com)",
                "hello@example.com",
                "",
                "",
                "bob@example.org",
                "Bob Builder",
                ""
            );
            let m = mailbox_list(&text);
            assert_eq!(m.len(), 3);
            assert_eq!(m[0].address, "ana@example.com");
            assert_eq!(m[0].display_name.as_deref(), Some("Ana"));
            assert_eq!(m[0].aliases, vec!["sales@example.com", "info@example.com"]);
            assert_eq!(m[1].display_name, None);
            assert!(m[1].aliases.is_empty());
            assert_eq!(m[2].display_name.as_deref(), Some("Bob Builder"));
            assert!(in_domain(&m[2].address, "example.org"));
            assert!(!in_domain(&m[2].address, "example.com"));
        }

        #[test]
        fn alias_list_rows() {
            let text = format!(
                "  {:<36} → {}\n  {:<36} → {}\n",
                "sales@example.com", "ana@example.com", "x@y.z", "a@y.z"
            );
            let a = alias_list(&text);
            assert_eq!(a.len(), 2);
            assert_eq!(a[0].address, "sales@example.com");
            assert_eq!(a[0].mailbox, "ana@example.com");
            assert_eq!(a[1].address, "x@y.z");
        }

        #[test]
        fn dns_records_with_value_found_optional_and_zone() {
            let text = format!(
                "  [{}] {:<5} {}{}\n  [{}] {:<5} {}{}\n            value: {}\n            found: {}\n  [{}] {:<5} {}{}\n            value: {}\n\nZone file:\nexample.com. 3600 IN MX 10 mail.example.com.\n_dmarc.example.com. 3600 IN TXT \"v=DMARC1; p=none\"\n",
                "  ok   ",
                "MX",
                "example.com",
                "",
                "problem",
                "TXT",
                "_dmarc.example.com",
                "",
                "v=DMARC1; p=none; rua=mailto:dmarc@example.com",
                "v=DMARC1; p=reject | v=spf1 -all",
                " warn  ",
                "CNAME",
                "autoconfig.example.com",
                "  (optional)",
                "mail.example.com",
            );
            let r = domain_dns(&text);
            assert_eq!(r.records.len(), 3);
            assert_eq!(r.records[0].id, "MX:example.com");
            assert_eq!(r.records[0].rtype, "MX");
            assert_eq!(r.records[0].status, MailCheckStatus::Pass);
            assert!(r.records[0].required);
            assert_eq!(r.records[0].expected, None);
            assert_eq!(r.records[1].id, "TXT:_dmarc.example.com");
            assert_eq!(r.records[1].status, MailCheckStatus::Fail);
            assert_eq!(
                r.records[1].expected.as_deref(),
                Some("v=DMARC1; p=none; rua=mailto:dmarc@example.com")
            );
            assert_eq!(r.records[1].actual, vec!["v=DMARC1; p=reject", "v=spf1 -all"]);
            assert_eq!(r.records[2].rtype, "CNAME");
            assert_eq!(r.records[2].name, "autoconfig.example.com");
            assert!(!r.records[2].required);
            assert_eq!(r.records[2].status, MailCheckStatus::Warn);
            assert_eq!(r.records[2].expected.as_deref(), Some("mail.example.com"));
            assert_eq!(
                r.zone_file,
                "example.com. 3600 IN MX 10 mail.example.com.\n_dmarc.example.com. 3600 IN TXT \"v=DMARC1; p=none\""
            );
        }

        fn rows(pairs: &[(&str, &str)]) -> String {
            pairs.iter().map(|(k, v)| format!("  {k:<14} {v}\n")).collect()
        }

        #[test]
        fn certificate_valid() {
            let text = rows(&[
                ("Covers", "mail.example.com, autoconfig.example.com"),
                ("Issuer", "R11"),
                ("Expires", "2026-12-01T10:00:00Z (25 days)"),
                ("Authority", "Let's Encrypt (automatic renewal)"),
                ("Renews from", "2026-11-01T10:00:00Z"),
                ("Next attempt", "in about 2 hours"),
            ]);
            let c = certificate_status(&text);
            assert_eq!(c.state, "valid");
            assert_eq!(c.covers, vec!["mail.example.com", "autoconfig.example.com"]);
            assert_eq!(c.issuer.as_deref(), Some("R11"));
            assert_eq!(c.expires_at.as_deref(), Some("2026-12-01T10:00:00Z"));
            assert_eq!(c.days_left, Some(25));
            assert_eq!(c.authority.as_deref(), Some("Let's Encrypt (automatic renewal)"));
            assert_eq!(c.renews_at.as_deref(), Some("2026-11-01T10:00:00Z"));
            assert_eq!(c.last_attempt, None);
            assert_eq!(c.next_attempt.as_deref(), Some("in about 2 hours"));
        }

        #[test]
        fn certificate_none_yet() {
            let text = rows(&[
                ("Certificate", "none yet"),
                ("Authority", "Let's Encrypt (automatic renewal)"),
                (
                    "Last attempt",
                    "Let's Encrypt could not connect to mail.example.com on port 80.",
                ),
                ("CA said", "Connection refused"),
                ("Next attempt", "in 4 minutes"),
            ]);
            let c = certificate_status(&text);
            assert_eq!(c.state, "missing");
            assert!(c.covers.is_empty());
            assert_eq!(c.expires_at, None);
            assert_eq!(
                c.last_attempt.as_deref(),
                Some(
                    "Let's Encrypt could not connect to mail.example.com on port 80. (CA said: Connection refused)"
                )
            );
            assert_eq!(c.next_attempt.as_deref(), Some("in 4 minutes"));
        }

        #[test]
        fn certificate_self_signed_test_and_expired() {
            let c = certificate_status(&rows(&[
                ("Covers", "mail.example.com"),
                ("Issuer", "—"),
                (
                    "Expires",
                    "— (temporary self-signed; replaced as soon as the real one is issued)",
                ),
                ("Authority", "Let's Encrypt (automatic renewal)"),
            ]));
            assert_eq!(c.state, "self_signed");
            assert_eq!(c.issuer, None);
            assert_eq!(c.expires_at, None);
            assert_eq!(c.days_left, None);

            let c = certificate_status(&rows(&[
                ("Covers", "mail.example.com"),
                ("Issuer", "(STAGING) Counterfeit Cashew R10"),
                ("Expires", "2027-01-15T00:00:00Z (70 days) — test certificate"),
                ("Authority", "Let's Encrypt staging (automatic renewal)"),
            ]));
            assert_eq!(c.state, "test");
            assert_eq!(c.days_left, Some(70));

            let c = certificate_status(&rows(&[
                ("Covers", "mail.example.com"),
                ("Issuer", "R11"),
                ("Expires", "2026-10-01T00:00:00Z (-36 days) — EXPIRED"),
                ("Authority", "Let's Encrypt (automatic renewal)"),
            ]));
            assert_eq!(c.state, "expired");
            assert_eq!(c.days_left, Some(-36));
            assert_eq!(c.expires_at.as_deref(), Some("2026-10-01T00:00:00Z"));

            assert_eq!(certificate_status("").state, "unknown");
        }

        #[test]
        fn row_matches_exact_padding() {
            assert_eq!(
                row("  Mailbox        hello@example.com", "Mailbox"),
                Some("hello@example.com")
            );
            assert_eq!(
                row("  Mailbox portal https://mail.example.com/account", "Mailbox"),
                None
            );
            assert_eq!(
                row(
                    "  Mailbox portal https://mail.example.com/account",
                    "Mailbox portal"
                ),
                Some("https://mail.example.com/account")
            );
        }

        /// What `install --yes --no-wait` prints when it pauses at the DNS
        /// gate with the console up: the setup link block, the summary.
        fn paused_install() -> Vec<String> {
            let mut text = String::new();
            text.push_str("Yunori Mail Server 0.1.0\n");
            text.push_str("\nChecking this server…\n");
            text.push_str(&format!(
                "  [{}] {:<20} {}\n",
                "  ok   ", "Operating system", "Debian 12"
            ));
            text.push_str("\n  This server is ready.\n");
            text.push_str("\n[ 7/12] Start the console and HTTPS edge\n");
            text.push_str(
                "\n  Continue in your browser: create the console owner (one-time link, valid 24 hours)\n",
            );
            text.push_str("    https://mail.example.com/console/setup#token=abcDEF123456\n");
            text.push_str("  Anyone with this link can claim the console until you do. Don't share it.\n");
            text.push_str("  ✓ Console at https://mail.example.com/console\n");
            text.push_str("\n[ 9/12] Publish DNS records\n");
            text.push_str("  … Publish the MX record for example.com\n");
            text.push_str(&format!("\n{}\n", "─".repeat(64)));
            text.push_str(
                "  Paused. The server finishes the remaining steps by itself once you have done the one below.\n",
            );
            text.push('\n');
            text.push_str(&rows(&[
                ("Console", "https://mail.example.com/console"),
                (
                    "Finish setup",
                    "https://mail.example.com/console/setup#token=abcDEF123456",
                ),
                ("Mailbox portal", "https://mail.example.com/account"),
            ]));
            text.push_str("\n  Your turn\n");
            text.push_str("    · Publish DNS records: Publish the MX record for example.com\n");
            text.push_str("    3 more steps follow after that.\n");
            text.push_str("  The console shows the same list and re-checks every minute; or run: sudo yunori-mail install --resume\n");
            text.push_str(&format!("{}\n", "─".repeat(64)));
            lines(&text)
        }

        #[test]
        fn install_output_paused_with_setup_link() {
            let s = install_output(&paused_install());
            assert_eq!(s.outcome, MailDeployOutcome::Paused);
            assert_eq!(
                s.setup_url.as_deref(),
                Some("https://mail.example.com/console/setup#token=abcDEF123456")
            );
            assert_eq!(s.console_url.as_deref(), Some("https://mail.example.com/console"));
            assert_eq!(s.paused_at.as_deref(), Some("Publish DNS records"));
            assert_eq!(s.first_mailbox, None);
            assert_eq!(s.first_mailbox_password, None);
        }

        #[test]
        fn install_output_ready_with_password() {
            let mut text = String::new();
            text.push_str("\n[11/12] Create your first mailbox\n");
            text.push_str("\n  Password for hello@example.com\n    Sup3r-Secret-Pass\n  Shown once — store it in your password manager.\n");
            text.push_str("  ✓ hello@example.com\n");
            text.push_str(&format!("\n{}\n", "─".repeat(64)));
            text.push_str("  Yunori Mail Server is ready.\n\n");
            text.push_str(&rows(&[
                ("Console", "https://mail.example.com/console"),
                (
                    "Finish setup",
                    "run `sudo yunori-mail setup-token` for a new link",
                ),
                ("Mailbox portal", "https://mail.example.com/account"),
                ("Mailbox", "hello@example.com"),
                (
                    "Mail apps",
                    "IMAP mail.example.com:993 (TLS) · SMTP mail.example.com:465 (TLS) or 587 (STARTTLS)",
                ),
                ("Yunori", "https://yunori.email/welcome?connect=hello@example.com"),
            ]));
            text.push_str(&format!("{}\n", "─".repeat(64)));
            let s = install_output(&lines(&text));
            assert_eq!(s.outcome, MailDeployOutcome::Ready);
            assert_eq!(s.first_mailbox.as_deref(), Some("hello@example.com"));
            assert_eq!(s.first_mailbox_password.as_deref(), Some("Sup3r-Secret-Pass"));
            assert_eq!(s.console_url.as_deref(), Some("https://mail.example.com/console"));
            assert_eq!(s.setup_url, None);
            assert_eq!(s.paused_at, None);

            // The `mailbox add` spelling is read too.
            let s = install_output(&lines(
                "Created a@b.c.\nPassword (shown once): Xyz123\n  Yunori Mail Server is ready.\n",
            ));
            assert_eq!(s.first_mailbox_password.as_deref(), Some("Xyz123"));
        }

        #[test]
        fn install_output_paused_at_title_and_failure() {
            let s = install_output(&lines("  Paused at “Point the mail hostname here”.\n"));
            assert_eq!(s.outcome, MailDeployOutcome::Paused);
            assert_eq!(s.paused_at.as_deref(), Some("Point the mail hostname here"));

            let s = install_output(&lines(
                "  The install stopped.\n  engine download failed\n  Fix the problem, then run: sudo yunori-mail install --resume\n",
            ));
            assert_eq!(s.outcome, MailDeployOutcome::Failed);
            assert_eq!(s.paused_at, None);

            let refused = lines(
                "  [problem] Outbound port 25     blocked\n\n  This server is not ready: fix Outbound port 25 first.\n  Fix the problems marked above, then run the installer again (or pass --force to continue anyway).\n",
            );
            assert_eq!(
                not_ready_sentence(&refused).as_deref(),
                Some("This server is not ready: fix Outbound port 25 first.")
            );
            assert_eq!(install_output(&refused).outcome, MailDeployOutcome::Failed);
        }

        #[test]
        fn redaction_hides_tokens_and_passwords() {
            assert_eq!(
                redact("    https://mail.example.com/console/setup#token=abcDEF123456"),
                "    https://mail.example.com/console/setup#token=…"
            );
            assert_eq!(
                redact("  Finish setup   https://x/console/setup#token=abc and more"),
                "  Finish setup   https://x/console/setup#token=… and more"
            );
            assert_eq!(redact("Password (shown once): Sup3r"), "Password (shown once): …");
            assert_eq!(
                redact("New password for a@b.c (shown once): Sup3r"),
                "New password for a@b.c (shown once): …"
            );
            assert_eq!(redact("  ✓ nothing secret here"), "  ✓ nothing secret here");

            let mut r = Redactor::new();
            assert_eq!(
                r.line("  Password for hello@example.com"),
                "  Password for hello@example.com"
            );
            assert_eq!(r.line("    Sup3r-Secret-Pass"), "    …");
            assert_eq!(
                r.line("  Shown once — store it in your password manager."),
                "  Shown once — store it in your password manager."
            );
            // The whole relayed install never carries the raw secrets.
            let mut r = Redactor::new();
            let shown: Vec<String> = paused_install().iter().map(|l| r.line(l)).collect();
            assert!(shown.iter().all(|l| !l.contains("abcDEF123456")));
            assert!(shown.iter().any(|l| l.contains("#token=…")));
        }

        #[test]
        fn shown_once_values() {
            assert_eq!(
                shown_once("Created ana@example.com.\nPassword (shown once): abc-def\n").as_deref(),
                Some("abc-def")
            );
            assert_eq!(
                shown_once("New password for ana@example.com (shown once): zzz\n").as_deref(),
                Some("zzz")
            );
            assert_eq!(shown_once("Deleted ana@example.com.\n"), None);
        }

        #[test]
        fn error_messages_and_last_line() {
            assert_eq!(
                error_message("error: example.org still has mailboxes; remove them first\n", ""),
                "example.org still has mailboxes; remove them first"
            );
            assert_eq!(error_message("", "Requesting a certificate…\nfailed\n"), "failed");
            assert_eq!(
                last_line(&lines(
                    "Requesting a certificate…\nIssued for mail.example.com.\n\n"
                )),
                "Issued for mail.example.com."
            );
            assert_eq!(last_line(&lines("\n\n")), "");
        }

        #[test]
        fn journal_records() {
            let line = r#"{"__CURSOR":"s=abc;i=1","__REALTIME_TIMESTAMP":"1762420000123456","PRIORITY":"4","_SYSTEMD_UNIT":"stalwart.service","MESSAGE":"TLS handshake failed"}"#;
            let r = journal_record(line).unwrap();
            assert_eq!(r.ts, "2025-11-06T09:06:40.123Z");
            assert_eq!(r.level, "warn");
            assert_eq!(r.source, "stalwart.service");
            assert_eq!(r.message, "TLS handshake failed");
            assert_eq!(r.cursor.as_deref(), Some("s=abc;i=1"));

            let bytes = r#"{"__REALTIME_TIMESTAMP":"0","PRIORITY":"6","_SYSTEMD_UNIT":"yunori-mail.service","MESSAGE":[104,105]}"#;
            let r = journal_record(bytes).unwrap();
            assert_eq!(r.message, "hi");
            assert_eq!(r.level, "info");
            assert_eq!(r.ts, "1970-01-01T00:00:00.000Z");
            assert_eq!(r.cursor, None);

            assert_eq!(level_from_priority("2"), "error");
            assert_eq!(level_from_priority("3"), "error");
            assert_eq!(level_from_priority("5"), "notice");
            assert_eq!(level_from_priority("7"), "debug");
            assert!(journal_record("not json").is_none());
            assert!(journal_record("").is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_argv_keeps_the_password_out() {
        let p = MailDeployParams {
            version: "0.1.0".into(),
            url: "https://yunori.email/server/v0.1.0/yunori-mail-x86_64-linux.tar.gz".into(),
            sha256: "0".repeat(64),
            domain: "example.com".into(),
            hostname: "mail.example.com".into(),
            admin_email: "you@gmail.com".into(),
            first_mailbox: "hello".into(),
            sending: "relay".into(),
            relay: Some(MailRelayParams {
                provider: "ses".into(),
                host: None,
                region: Some("eu-west-1".into()),
                port: 587,
                username: Some("AKIA".into()),
                password: Some("s3cret".into()),
            }),
            force: true,
            skip_ptr: true,
        };
        let args = install_args(&p).unwrap();
        assert_eq!(
            args,
            vec![
                "install",
                "--yes",
                "--no-wait",
                "--domain",
                "example.com",
                "--hostname",
                "mail.example.com",
                "--admin-email",
                "you@gmail.com",
                "--first-mailbox",
                "hello",
                "--sending",
                "relay",
                "--relay-provider",
                "ses",
                "--relay-region",
                "eu-west-1",
                "--relay-port",
                "587",
                "--relay-user",
                "AKIA",
                "--relay-password-env",
                RELAY_PASSWORD_ENV,
                "--force",
                "--skip-ptr",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("s3cret")));

        let direct = MailDeployParams {
            sending: "direct".into(),
            domain: "example.com".into(),
            hostname: "mail.example.com".into(),
            admin_email: "you@gmail.com".into(),
            ..Default::default()
        };
        let args = install_args(&direct).unwrap();
        assert!(args.ends_with(&["--sending".to_string(), "direct".to_string()]));
        assert!(!args.iter().any(|a| a.starts_with("--relay")));

        let bad = MailDeployParams {
            sending: "pigeon".into(),
            ..Default::default()
        };
        assert!(matches!(install_args(&bad), Err(ProviderError::InvalidParams(_))));
        let relay_without_settings = MailDeployParams {
            sending: "relay".into(),
            ..Default::default()
        };
        assert!(matches!(
            install_args(&relay_without_settings),
            Err(ProviderError::InvalidParams(_))
        ));
    }

    #[test]
    fn journal_argv() {
        let args = journal_args(&MailLogsParams {
            lines: 50,
            follow: true,
            query: Some("rejected".into()),
        });
        assert_eq!(
            args,
            vec![
                "-u",
                "stalwart",
                "-u",
                "yunori-mail",
                "-o",
                "json",
                "--no-pager",
                "-n",
                "50",
                "-f",
                "-g",
                "rejected"
            ]
        );
        let args = journal_args(&MailLogsParams {
            lines: 0,
            follow: false,
            query: Some("  ".into()),
        });
        assert!(args.ends_with(&["-n".to_string(), "1".to_string()]));
        assert!(!args.contains(&"-g".to_string()));
    }

    #[test]
    fn cli_failures_map_by_text() {
        let out = exec::Output {
            stdout: String::new(),
            stderr: "error: example.org still has mailboxes; remove them first\n".into(),
            code: Some(1),
        };
        let err = cli_failure(
            "yunori-mail domain remove",
            &out,
            &[
                ("still has mailboxes", Kind::Conflict),
                ("is not on this server", Kind::NotFound),
            ],
        );
        match err {
            ProviderError::Conflict(m) => assert_eq!(m, "example.org still has mailboxes; remove them first"),
            other => panic!("{other:?}"),
        }
        let out = exec::Output {
            stdout: String::new(),
            stderr: "error: nope.example is not on this server\n".into(),
            code: Some(1),
        };
        assert!(matches!(
            cli_failure("op", &out, &[("is not on this server", Kind::NotFound)]),
            ProviderError::NotFound(_)
        ));
        let out = exec::Output {
            stdout: String::new(),
            stderr: "error: engine unreachable\n".into(),
            code: Some(1),
        };
        match cli_failure("yunori-mail domain list", &out, &[("x", Kind::Invalid)]) {
            ProviderError::Exec { op, output, .. } => {
                assert_eq!(op, "yunori-mail domain list");
                assert_eq!(output, "error: engine unreachable");
            }
            other => panic!("{other:?}"),
        }
    }
}
