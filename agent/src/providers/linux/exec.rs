//! Child processes. There is no command-string field anywhere here on
//! purpose: a shell never sees any of this. Every helper takes a program
//! name and an argv slice.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::providers::{Ctx, Encoding, PResult, ProviderError, Stream};

/// Cap on the stderr excerpt attached to a failed exec; the contract caps
/// the wire field at 16 KiB.
pub const EXEC_OUTPUT_LIMIT: usize = 16 << 10;

/// One child process.
#[derive(Default, Clone, Debug)]
pub struct ExecOptions {
    pub name: String,
    pub args: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    /// Runs the child under a POSIX account via setuid credentials, which is
    /// how `psql` reaches a peer-authenticated cluster without a shell in
    /// between.
    pub user: Option<String>,
    pub dir: Option<PathBuf>,
    /// Extra environment on top of the agent's own, or a full replacement
    /// when `clear_env` is set.
    pub env: Vec<(String, String)>,
    pub clear_env: bool,
    /// Pin child output to the C locale so column headings, dates and
    /// yes/no words stay parseable on a host configured in any language.
    pub c_locale: bool,
}

impl ExecOptions {
    pub fn new(name: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            name: name.into(),
            args: args.into_iter().map(Into::into).collect(),
            ..Default::default()
        }
    }
    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }
    pub fn user(mut self, user: impl Into<String>) -> Self {
        self.user = Some(user.into());
        self
    }
    pub fn dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.dir = Some(dir.into());
        self
    }
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
    pub fn c_locale(mut self) -> Self {
        self.c_locale = true;
        self
    }
}

/// The outcome of a child that was allowed to finish.
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// Executes a real binary with an argv slice and returns its stdout. A
/// non-zero exit becomes `ProviderError::Exec` carrying the stderr tail.
pub async fn run(ctx: &Ctx, name: &str, args: &[&str]) -> PResult<String> {
    run_with(ctx, ExecOptions::new(name, args.iter().copied())).await
}

pub async fn run_with(ctx: &Ctx, o: ExecOptions) -> PResult<String> {
    let out = run_raw(ctx, &o).await?;
    if out.success() {
        Ok(out.stdout)
    } else {
        Err(exec_error(
            &o.name,
            pick_output(&out.stderr, &out.stdout),
            out.code,
        ))
    }
}

/// Like `run_with` but hands back the exit code and both streams, for the
/// tools that use exit statuses to mean things other than failure
/// (`yunori-mail doctor` exits 2 with a report, package managers say
/// "nothing to do" with 100).
pub async fn run_raw(ctx: &Ctx, o: &ExecOptions) -> PResult<Output> {
    let mut cmd = command(o)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if o.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| spawn_error(&o.name, e))?;
    if let (Some(data), Some(mut stdin)) = (o.stdin.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(&data).await;
            let _ = stdin.shutdown().await;
        });
    }
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| ProviderError::internal(format!("waiting for {}: {e}", o.name)))?,
        _ = ctx.done() => {
            let _ = child.start_kill();
            return Err(ctx.error());
        }
    };
    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();
    Ok(Output {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code: status.code(),
    })
}

/// Keeps a command's stdout and stderr in one string, for tools like
/// `nginx -t` and `sshd -t` that report their verdict on stderr whether
/// they pass or fail.
pub async fn run_combined(ctx: &Ctx, o: ExecOptions) -> PResult<String> {
    let out = run_raw(ctx, &o).await?;
    let combined = format!("{}{}", out.stdout, out.stderr);
    if out.success() {
        Ok(combined)
    } else {
        Err(exec_error(&o.name, tail(&combined, EXEC_OUTPUT_LIMIT), out.code))
    }
}

/// Relays a long job's output to the control plane as it happens — an
/// operator watching a package upgrade sees the same lines the machine is
/// printing — while still capturing its tail for parsing. `redact` lets a
/// caller keep a secret out of the stream (the setup token yunori prints).
pub async fn run_stream(
    ctx: &Ctx,
    stream: &dyn Stream,
    o: ExecOptions,
    redact: Option<&(dyn Fn(&str) -> String + Sync)>,
) -> PResult<Output> {
    let mut cmd = command(&o)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if o.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| spawn_error(&o.name, e))?;
    if let (Some(data), Some(mut stdin)) = (o.stdin.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(&data).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");

    // Both pipes are merged line by line into one ordered stream; the
    // capture keeps the tail so a failure can be explained without buffering
    // a whole `apt upgrade` in memory.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    let pump = |reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
                tx: tokio::sync::mpsc::Sender<String>| async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    };
    let t1 = tokio::spawn(pump(Box::new(stdout), tx.clone()));
    let t2 = tokio::spawn(pump(Box::new(stderr), tx));

    let mut captured = String::new();
    let relay = async {
        while let Some(line) = rx.recv().await {
            let shown = match redact {
                Some(f) => f(&line),
                None => line.clone(),
            };
            captured.push_str(&shown);
            captured.push('\n');
            if captured.len() > 2 * EXEC_OUTPUT_LIMIT {
                captured = tail(&captured, EXEC_OUTPUT_LIMIT).to_string();
            }
            let mut out = shown;
            out.push('\n');
            if stream.send(out.as_bytes(), Encoding::Utf8).await.is_err() {
                break;
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
    Ok(Output {
        stdout: captured,
        stderr: String::new(),
        code: status.code(),
    })
}

fn command(o: &ExecOptions) -> PResult<Command> {
    let path = which(&o.name)
        .ok_or_else(|| ProviderError::unsupported_because(format!("{} is not installed", o.name)))?;
    let mut cmd = Command::new(path);
    cmd.args(&o.args);
    if let Some(dir) = &o.dir {
        cmd.current_dir(dir);
    }
    if o.clear_env {
        cmd.env_clear();
        cmd.env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/sbin:/usr/bin:/sbin:/bin".into()),
        );
    }
    if o.c_locale {
        cmd.env("LC_ALL", "C").env("LANG", "C");
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    if let Some(user) = &o.user {
        let (uid, gid, groups) = credential(user)?;
        cmd.uid(uid).gid(gid);
        // Supplementary groups are set in the child before exec, which is
        // the moment `su -c "..."` — and its shell string — would otherwise
        // be needed for.
        unsafe {
            cmd.pre_exec(move || {
                let gids: Vec<libc::gid_t> = groups.iter().map(|g| *g as libc::gid_t).collect();
                if libc::setgroups(gids.len(), gids.as_ptr()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    Ok(cmd)
}

/// Resolves a POSIX account to the uid/gid set a child should run with.
pub fn credential(name: &str) -> PResult<(u32, u32, Vec<u32>)> {
    let account = nix::unistd::User::from_name(name)
        .ok()
        .flatten()
        .ok_or_else(|| ProviderError::not_found(format!("look up user {name}")))?;
    let uid = account.uid.as_raw();
    let gid = account.gid.as_raw();
    let groups = nix::unistd::getgrouplist(
        &std::ffi::CString::new(name).map_err(|_| ProviderError::invalid("user name contains a NUL byte"))?,
        account.gid,
    )
    .map(|gs| gs.into_iter().map(|g| g.as_raw()).collect())
    .unwrap_or_else(|_| vec![gid]);
    Ok((uid, gid, groups))
}

fn spawn_error(name: &str, e: std::io::Error) -> ProviderError {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            ProviderError::unsupported_because(format!("{name} is not installed"))
        }
        std::io::ErrorKind::PermissionDenied => {
            ProviderError::PermissionDenied(format!("cannot run {name}: {e}"))
        }
        _ => ProviderError::internal(format!("starting {name}: {e}")),
    }
}

pub fn exec_error(op: &str, output: &str, code: Option<i32>) -> ProviderError {
    let message = match code {
        Some(c) => format!("exited with status {c}"),
        None => "was killed by a signal".to_string(),
    };
    ProviderError::exec(op, message, output.trim())
}

fn pick_output<'a>(stderr: &'a str, stdout: &'a str) -> &'a str {
    if !stderr.trim().is_empty() {
        tail(stderr, EXEC_OUTPUT_LIMIT)
    } else {
        tail(stdout, EXEC_OUTPUT_LIMIT)
    }
}

/// The last `limit` bytes of `s`, cut at a character boundary.
pub fn tail(s: &str, limit: usize) -> &str {
    if s.len() <= limit {
        return s;
    }
    let mut cut = s.len() - limit;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    &s[cut..]
}

/* ------------------------------- helpers ----------------------------- */

/// `exec.LookPath`: an absolute path is accepted as is, a bare name is
/// searched on PATH plus the sbin directories a root agent should see.
pub fn which(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() {
        return is_executable(p).then(|| p.to_path_buf());
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    for extra in [
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
    ] {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    dirs.into_iter().map(|d| d.join(name)).find(|c| is_executable(c))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

pub fn has_binary(name: &str) -> bool {
    which(name).is_some()
}

pub fn file_exists(path: &str) -> bool {
    std::fs::metadata(path).map(|m| !m.is_dir()).unwrap_or(false)
}

pub fn dir_exists(path: &str) -> bool {
    std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

pub fn read_trimmed(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The first candidate that is present, which is how this module copes
/// with distributions disagreeing about paths.
pub fn first_existing<'a>(candidates: &[&'a str]) -> Option<&'a str> {
    candidates.iter().copied().find(|c| Path::new(c).exists())
}

/// Whether an exec failure carried a specific exit status, which several
/// package managers use to mean "nothing to do" rather than "failed".
pub fn is_exit_code(err: &ProviderError, code: i32) -> bool {
    matches!(err, ProviderError::Exec { message, .. } if *message == format!("exited with status {code}"))
}

/// Replaces a file in one step: a temp file in the same directory,
/// fsynced, then renamed over the target. A crash mid-write therefore
/// leaves the old file, never half the new one.
pub fn write_atomic(path: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let dir = path.parent().unwrap_or(Path::new("/"));
    let base = path.file_name().and_then(OsStr::to_str).unwrap_or("file");
    let temp = dir.join(format!(".{base}.{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)?;
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode_u32(mode))?;
        std::fs::rename(&temp, path)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Persists the rename itself, not just the bytes it points at.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    let handle = std::fs::File::open(dir)?;
    match handle.sync_all() {
        Err(e) if e.raw_os_error() == Some(libc::EINVAL) => Ok(()),
        other => other,
    }
}

trait PermissionsFromMode {
    fn from_mode_u32(mode: u32) -> std::fs::Permissions;
}

impl PermissionsFromMode for std::fs::Permissions {
    fn from_mode_u32(mode: u32) -> std::fs::Permissions {
        use std::os::unix::fs::PermissionsExt;
        std::fs::Permissions::from_mode(mode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_cuts_at_char_boundary() {
        let s = "héllo wörld";
        let t = tail(s, 5);
        assert!(s.ends_with(t));
        assert!(t.len() <= 6);
    }

    #[tokio::test]
    async fn run_captures_stdout_and_maps_exit_codes() {
        let ctx = Ctx::background();
        let out = run(&ctx, "sh", &["-c", "echo hi"]).await.unwrap();
        assert_eq!(out.trim(), "hi");
        let err = run(&ctx, "sh", &["-c", "echo bad >&2; exit 3"])
            .await
            .unwrap_err();
        assert!(is_exit_code(&err, 3));
        match err {
            ProviderError::Exec { output, .. } => assert_eq!(output, "bad"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn missing_binary_is_unsupported() {
        let ctx = Ctx::background();
        let err = run(&ctx, "definitely-not-a-binary-kaname", &[])
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Unsupported(_)));
    }

    #[test]
    fn write_atomic_replaces_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("f");
        std::fs::write(&target, "old").unwrap();
        write_atomic(&target, b"new", 0o600).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
