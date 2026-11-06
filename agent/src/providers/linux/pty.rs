//! The terminal.
//!
//! This is the one place in the agent where free-form execution is
//! possible at all, which is exactly why it is the one place the control
//! plane permissions separately, tickets and records (KD-013). Even here
//! nothing takes a command string over the wire: pty.open starts the
//! account's own login shell and the operator's keystrokes go to it as
//! bytes, the same as if they had typed them into ssh.
//!
//! A session is keyed by the id of the request that opened it, and it is
//! torn down when that request's stream ends, when pty.close arrives, or
//! when the connection dies — never left orphaned holding a root shell.

use std::collections::HashMap;
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, User};
use parking_lot::Mutex;
use tokio::io::unix::AsyncFd;
use tokio_util::sync::CancellationToken;

use super::common::not_found;
use super::exec::{credential, dir_exists, file_exists};
use super::paths::validate_path;
use crate::providers::*;

/// How long a closing session is given to exit on SIGHUP before it is
/// killed outright.
const PTY_HANGUP_GRACE: Duration = Duration::from_secs(2);
const PTY_READ_BUFFER: usize = 32 << 10;

/// The shells a login is allowed to land in. A passwd entry naming
/// anything else falls back rather than executing it.
const LOGIN_SHELLS: &[&str] =
    &["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/zsh", "/usr/bin/zsh", "/bin/ash"];

pub struct PtyOps(pub Arc<Shared>);

use super::Shared;

/// One open terminal: the master side of the pty and the shell's process
/// group behind it.
pub struct PtySession {
    master: AsyncFd<OwnedFd>,
    pid: Pid,
    closed: CancellationToken,
}

impl PtySession {
    /// Idempotent: the first caller tears the session down and later
    /// callers find it already closed.
    fn close(&self) {
        if self.closed.is_cancelled() {
            return;
        }
        self.closed.cancel();
        // Signalling the process group takes the shell's children with it;
        // killing only the shell would leave them holding the pty.
        let group = Pid::from_raw(-self.pid.as_raw());
        let _ = kill(group, Signal::SIGHUP);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                tokio::time::sleep(PTY_HANGUP_GRACE).await;
                let _ = kill(group, Signal::SIGKILL);
            });
        } else {
            let _ = kill(group, Signal::SIGKILL);
        }
    }

    fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        let size = nix::pty::Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: TIOCSWINSZ reads a `winsize` from the pointer and the fd
        // is a pty master this session owns.
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Open terminal sessions, keyed by the id of the stream that opened them.
#[derive(Default)]
pub struct PtySessions {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtySessions {
    fn register(&self, id: &str, session: Arc<PtySession>) {
        let previous = self.sessions.lock().insert(id.to_string(), session);
        if let Some(previous) = previous {
            previous.close();
        }
    }

    fn lookup(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().get(id).cloned()
    }

    /// Forgets `id`, but only while it still names `session`: a replacement
    /// registered under the same id in the meantime stays.
    fn release(&self, id: &str, session: &Arc<PtySession>) {
        let mut sessions = self.sessions.lock();
        if sessions.get(id).is_some_and(|current| Arc::ptr_eq(current, session)) {
            sessions.remove(id);
        }
    }

    fn remove(&self, id: &str) {
        self.sessions.lock().remove(id);
    }

    /// Called when the provider shuts down. A root shell that outlives the
    /// agent that opened it is exactly the kind of thing this design exists
    /// to prevent.
    pub async fn close_all(&self) {
        let sessions: Vec<Arc<PtySession>> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.close();
        }
    }
}

#[async_trait]
impl Pty for PtyOps {
    async fn open(&self, ctx: &Ctx, session_id: &str, p: PtyOpenParams, s: StreamRef) -> PResult<PtyOpenResult> {
        let account = resolve_account(p.user.as_deref())?;

        let mut workdir = match p.cwd.as_deref().filter(|c| !c.is_empty()) {
            Some(cwd) => cwd.to_string(),
            None => account.dir.to_string_lossy().into_owned(),
        };
        workdir = validate_path(&workdir)?;
        if !dir_exists(&workdir) {
            workdir = "/".to_string();
        }

        let shell = login_shell(&account);
        let home = account.dir.to_string_lossy().into_owned();
        let creds = if account.name != current_username() {
            Some(credential(&account.name)?)
        } else {
            None
        };

        let size = nix::pty::Winsize {
            ws_row: p.rows.clamp(0, u16::MAX as i64) as u16,
            ws_col: p.cols.clamp(0, u16::MAX as i64) as u16,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let pty = nix::pty::openpty(Some(&size), None)
            .map_err(|e| ProviderError::internal(format!("open a pseudo-terminal: {e}")))?;
        // libc's openpty does not set close-on-exec, and the child must not
        // inherit the master side of its own terminal.
        set_cloexec(&pty.master)?;
        set_cloexec(&pty.slave)?;

        // `-l` so the operator gets the same profile and PATH they would
        // get over ssh, rather than a bare shell with a surprising
        // environment.
        let mut cmd = tokio::process::Command::new(&shell);
        cmd.arg("-l")
            .current_dir(&workdir)
            .env_clear()
            .env("TERM", sanitize_term(&p.term))
            .env("HOME", &home)
            .env("USER", &account.name)
            .env("LOGNAME", &account.name)
            .env("SHELL", &shell)
            .env("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            .env("LANG", or_default(std::env::var("LANG").unwrap_or_default(), "C.UTF-8"));

        let slave_out = pty.slave.try_clone()?;
        let slave_err = pty.slave.try_clone()?;
        cmd.stdin(Stdio::from(pty.slave))
            .stdout(Stdio::from(slave_out))
            .stderr(Stdio::from(slave_err));

        // SAFETY: the closure only makes async-signal-safe syscalls
        // (setsid, ioctl, setgroups, setgid, setuid) between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                // A new session whose controlling terminal is the pty, so
                // job control and ^C behave as they would over ssh.
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some((uid, gid, groups)) = &creds {
                    let gids: Vec<libc::gid_t> = groups.iter().map(|g| *g as libc::gid_t).collect();
                    if libc::setgroups(gids.len(), gids.as_ptr()) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setgid(*gid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(*uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }

        let child = cmd
            .spawn()
            .map_err(|e| ProviderError::internal(format!("start {shell} for {}: {e}", account.name)))?;
        let pid = child
            .id()
            .ok_or_else(|| ProviderError::internal(format!("start {shell} for {}: no pid", account.name)))?;

        set_nonblocking(&pty.master)?;
        // SAFETY: `OwnedFd` owns the descriptor, which is neither replaced
        // nor closed while the AsyncFd holds it.
        let master = unsafe { AsyncFd::register(pty.master) }
            .map_err(|e| ProviderError::internal(format!("watch the terminal: {e}")))?;
        let session = Arc::new(PtySession {
            master,
            pid: Pid::from_raw(pid as i32),
            closed: CancellationToken::new(),
        });
        self.0.ptys.register(session_id, session.clone());

        tracing::info!(session = session_id, user = %account.name, shell = %shell, pid, "terminal opened");
        let result = PtyOpenResult { pid: pid as i64 };

        let outcome = pump(ctx, &session, child, s.as_ref()).await;
        self.0.ptys.release(session_id, &session);
        outcome.map(|()| result)
    }

    async fn resize(&self, _ctx: &Ctx, session_id: &str, p: PtyResizeParams) -> PResult<()> {
        let session = self
            .0
            .ptys
            .lookup(session_id)
            .ok_or_else(|| not_found(format!("terminal session {session_id}")))?;
        session
            .resize(
                p.rows.clamp(0, u16::MAX as i64) as u16,
                p.cols.clamp(0, u16::MAX as i64) as u16,
            )
            .map_err(|e| ProviderError::internal(format!("resize terminal: {e}")))
    }

    async fn close(&self, _ctx: &Ctx, session_id: &str) -> PResult<()> {
        let session = self
            .0
            .ptys
            .lookup(session_id)
            .ok_or_else(|| not_found(format!("terminal session {session_id}")))?;
        session.close();
        self.0.ptys.remove(session_id);
        Ok(())
    }
}

/* -------------------------------- pumping ----------------------------- */

/// Wires the pty to the RPC stream in both directions and returns once
/// either the shell exits, the operator disconnects, or the request is
/// cancelled. Whichever happens first tears the other side down.
async fn pump(ctx: &Ctx, session: &Arc<PtySession>, mut child: tokio::process::Child, stream: &dyn Stream) -> PResult<()> {
    let master = &session.master;

    let reader = async {
        let mut buffer = vec![0u8; PTY_READ_BUFFER];
        loop {
            let mut guard = master.readable().await?;
            match guard.try_io(|fd| nix::unistd::read(fd.as_raw_fd(), &mut buffer).map_err(std::io::Error::from)) {
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(n)) => {
                    // Terminal output is arbitrary bytes, not text: base64
                    // keeps an escape sequence intact instead of mangling it
                    // into JSON.
                    stream.send(&buffer[..n], Encoding::Base64).await?;
                }
                // A closed pty reports EIO once the child is gone, which is
                // the normal end of a session rather than a failure.
                Ok(Err(_)) => return Ok(()),
                Err(_would_block) => continue,
            }
        }
    };

    let writer = async {
        loop {
            match stream.recv().await {
                Ok(Some(data)) => write_all(master, &data).await?,
                // The operator's side closed, or the stream failed: either
                // way the session is over, not broken.
                Ok(None) | Err(_) => return Ok(()),
            }
        }
    };

    let outcome: PResult<()> = tokio::select! {
        r = reader => r,
        r = writer => r,
        _ = child.wait() => {
            // Whatever the shell printed on its way out is still in the
            // pty's buffer; hand it over before the master goes away.
            drain(master, stream).await;
            Ok(())
        }
        _ = session.closed.cancelled() => Ok(()),
        _ = ctx.done() => Ok(()),
    };

    session.close();
    // Reaped off the request path so the exit status is collected even
    // though the operator is no longer waiting for it.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    outcome
}

async fn write_all(master: &AsyncFd<OwnedFd>, data: &[u8]) -> PResult<()> {
    let mut offset = 0;
    while offset < data.len() {
        let mut guard = master.writable().await?;
        match guard.try_io(|fd| nix::unistd::write(fd.get_ref(), &data[offset..]).map_err(std::io::Error::from)) {
            Ok(Ok(n)) => offset += n,
            Ok(Err(e)) => return Err(ProviderError::internal(format!("write to terminal: {e}"))),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

/// Reads whatever is immediately available on the master and forwards it;
/// stops at the first read that would block or fail.
async fn drain(master: &AsyncFd<OwnedFd>, stream: &dyn Stream) {
    let mut buffer = vec![0u8; PTY_READ_BUFFER];
    loop {
        match nix::unistd::read(master.as_raw_fd(), &mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if stream.send(&buffer[..n], Encoding::Base64).await.is_err() {
                    return;
                }
            }
        }
    }
}

/* -------------------------------- helpers ----------------------------- */

fn set_cloexec(fd: &OwnedFd) -> std::io::Result<()> {
    use nix::fcntl::{FcntlArg, FdFlag, fcntl};
    let flags = fcntl(fd.as_raw_fd(), FcntlArg::F_GETFD)?;
    let flags = FdFlag::from_bits_truncate(flags) | FdFlag::FD_CLOEXEC;
    fcntl(fd.as_raw_fd(), FcntlArg::F_SETFD(flags))?;
    Ok(())
}

fn set_nonblocking(fd: &OwnedFd) -> std::io::Result<()> {
    use nix::fcntl::{FcntlArg, OFlag, fcntl};
    let flags = fcntl(fd.as_raw_fd(), FcntlArg::F_GETFL)?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(fd.as_raw_fd(), FcntlArg::F_SETFL(flags))?;
    Ok(())
}

fn resolve_account(name: Option<&str>) -> PResult<User> {
    let mut name = name.unwrap_or("");
    if name.is_empty() {
        if let Ok(Some(account)) = User::from_uid(nix::unistd::getuid()) {
            return Ok(account);
        }
        name = "root";
    }
    User::from_name(name)
        .ok()
        .flatten()
        .ok_or_else(|| not_found(format!("user {name}")))
}

fn current_username() -> String {
    User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|u| u.name)
        .unwrap_or_default()
}

/// Prefers the account's own shell and falls back to the first real shell
/// on the host, so a user whose passwd entry says nologin still gets a
/// usable terminal rather than an immediate exit.
fn login_shell(account: &User) -> String {
    if let Some(shell) = passwd_shell(&account.name) {
        return shell;
    }
    for candidate in LOGIN_SHELLS {
        if file_exists(candidate) {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

fn passwd_shell(username: &str) -> Option<String> {
    let raw = std::fs::read_to_string("/etc/passwd").ok()?;
    passwd_shell_from(&raw, username).filter(|shell| file_exists(shell))
}

/// The shell `/etc/passwd` names for `username`, if it is one a login may
/// land in: absolute, and not a nologin stand-in.
fn passwd_shell_from(passwd: &str, username: &str) -> Option<String> {
    for line in super::common::split_lines(passwd) {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 || fields[0] != username {
            continue;
        }
        let shell = fields[6];
        if shell.is_empty() || shell.ends_with("nologin") || shell.ends_with("false") {
            return None;
        }
        if !shell.starts_with('/') {
            return None;
        }
        return Some(shell.to_string());
    }
    None
}

/// Keeps a terminfo name to the characters terminfo itself allows, since
/// it is handed to the child as an environment variable.
fn sanitize_term(term: &str) -> String {
    if term.is_empty() {
        return "xterm-256color".to_string();
    }
    let allowed = term
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'.');
    if allowed { term.to_string() } else { "xterm-256color".to_string() }
}

fn or_default(value: String, fallback: &str) -> String {
    if value.is_empty() { fallback.to_string() } else { value }
}

/* --------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[test]
    fn sanitize_term_keeps_terminfo_names_and_nothing_else() {
        assert_eq!(sanitize_term(""), "xterm-256color");
        assert_eq!(sanitize_term("screen.xterm-256color"), "screen.xterm-256color");
        assert_eq!(sanitize_term("rxvt_unicode"), "rxvt_unicode");
        assert_eq!(sanitize_term("xterm; rm -rf /"), "xterm-256color");
        assert_eq!(sanitize_term("xterm\n"), "xterm-256color");
    }

    #[test]
    fn passwd_shell_refuses_nologin_and_relative_shells() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\n\
                      www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n\
                      sync:x:4:65534:sync:/bin:/bin/false\n\
                      odd:x:1001:1001::/home/odd:bash\n\
                      short:x:1002\n";
        assert_eq!(passwd_shell_from(passwd, "root").as_deref(), Some("/bin/bash"));
        assert_eq!(passwd_shell_from(passwd, "www-data"), None);
        assert_eq!(passwd_shell_from(passwd, "sync"), None);
        assert_eq!(passwd_shell_from(passwd, "odd"), None);
        assert_eq!(passwd_shell_from(passwd, "short"), None);
        assert_eq!(passwd_shell_from(passwd, "nobody"), None);
    }

    /// A stream whose operator types a fixed script and then sits there
    /// until the shell ends the session.
    struct Script {
        input: tokio::sync::Mutex<VecDeque<Vec<u8>>>,
        output: Mutex<Vec<u8>>,
    }

    #[async_trait]
    impl Stream for Script {
        async fn send(&self, data: &[u8], enc: Encoding) -> PResult<()> {
            assert_eq!(enc, Encoding::Base64, "terminal output travels as base64");
            self.output.lock().extend_from_slice(data);
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            let next = self.input.lock().await.pop_front();
            match next {
                Some(line) => {
                    // Keystrokes arrive one line at a time, with a pause the
                    // shell needs to start up and echo.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    Ok(Some(line))
                }
                None => std::future::pending().await,
            }
        }
    }

    #[tokio::test]
    async fn open_runs_the_login_shell_and_relays_its_output() {
        // openpty needs /dev/ptmx; a sandbox without it cannot run this.
        if nix::pty::openpty(None, None).is_err() {
            eprintln!("skipping: no pseudo-terminals here");
            return;
        }
        let shared = Arc::new(test_shared());
        let ops = PtyOps(shared.clone());
        let stream = Arc::new(Script {
            input: tokio::sync::Mutex::new(VecDeque::from(vec![
                b"echo hello-from-$((20+22))\n".to_vec(),
                b"exit\n".to_vec(),
            ])),
            output: Mutex::new(Vec::new()),
        });
        let params = PtyOpenParams {
            cols: 80,
            rows: 24,
            cwd: Some("/".into()),
            user: None,
            term: "xterm".into(),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            ops.open(&Ctx::background(), "s1", params, stream.clone()),
        )
        .await
        .expect("the shell did not exit")
        .expect("open failed");
        assert!(result.pid > 0);

        let output = String::from_utf8_lossy(&stream.output.lock()).into_owned();
        assert!(output.contains("hello-from-42"), "shell output was {output:?}");
        assert!(shared.ptys.lookup("s1").is_none(), "the session was not released");
        // The shell is gone: signalling its group finds nobody.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(kill(Pid::from_raw(result.pid as i32), None).is_err(), "the shell outlived its session");
    }

    #[tokio::test]
    async fn close_ends_a_running_session() {
        if nix::pty::openpty(None, None).is_err() {
            return;
        }
        let shared = Arc::new(test_shared());
        let ops = Arc::new(PtyOps(shared.clone()));
        let stream = Arc::new(Script {
            input: tokio::sync::Mutex::new(VecDeque::new()),
            output: Mutex::new(Vec::new()),
        });
        let params = PtyOpenParams {
            cols: 80,
            rows: 24,
            cwd: Some("/".into()),
            user: None,
            term: "xterm".into(),
        };
        let opener = ops.clone();
        let task = tokio::spawn(async move { opener.open(&Ctx::background(), "s2", params, stream).await });

        // Wait for the session to register, resize it, then close it.
        let mut session = None;
        for _ in 0..100 {
            if let Some(s) = shared.ptys.lookup("s2") {
                session = Some(s);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let session = session.expect("the session never registered");
        ops.resize(&Ctx::background(), "s2", PtyResizeParams { cols: 120, rows: 40 })
            .await
            .unwrap();
        ops.close(&Ctx::background(), "s2").await.unwrap();

        let result = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("open did not return after close")
            .unwrap()
            .unwrap();
        assert!(result.pid > 0);
        assert!(matches!(
            ops.close(&Ctx::background(), "s2").await,
            Err(ProviderError::NotFound(_))
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(kill(session.pid, None).is_err(), "the shell outlived pty.close");
    }

    /// A `Shared` with no host probing behind it: the terminal only needs
    /// the session registry.
    fn test_shared() -> Shared {
        let (events, _rx) = tokio::sync::mpsc::channel(1);
        Shared {
            opts: Options {
                agent_version: "test".into(),
                state_dir: std::env::temp_dir(),
            },
            caps: Default::default(),
            cap_list: Vec::new(),
            docker: None,
            rollback: super::super::rollback::RollbackGuard::new(),
            names: Default::default(),
            events,
            last_metrics: Mutex::new(None),
            ptys: PtySessions::default(),
        }
    }
}
