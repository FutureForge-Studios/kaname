//! SSH.
//!
//! ssh.config.apply is the second place in this agent that can lock an
//! operator out of their own machine, so it works the same way the
//! firewall does: write a candidate, prove it with `sshd -t`, reload, and
//! schedule a revert that only a matching confirm cancels. A config that
//! fails validation never reaches the running daemon at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{Local, NaiveDateTime, TimeZone};
use tokio_util::sync::CancellationToken;

use super::Shared;
use super::common::{is_not_exist, not_found, now_rfc3339, precondition, rfc3339, split_lines, unsupported};
use super::exec::{self, ExecOptions};
use crate::providers::*;

pub use render::*;

const SSH_CONFIG_PATH: &str = "/etc/ssh/sshd_config";
const SSH_DROP_IN_DIR: &str = "/etc/ssh/sshd_config.d";
const SSH_DROP_IN_FILE: &str = "50-kaname.conf";
const AUTHORIZED_KEYS: &str = ".ssh/authorized_keys";

pub struct SshOps(pub Arc<Shared>);

/// A POSIX account, as far as this module needs one.
struct Account {
    name: String,
    uid: u32,
    gid: u32,
    home: PathBuf,
}

fn tool(name: &str, args: &[&str]) -> ExecOptions {
    ExecOptions::new(name, args.iter().copied()).c_locale()
}

/// The context a scheduled revert runs under: nothing cancels it but its
/// own 60-second deadline.
fn revert_ctx() -> Ctx {
    Ctx::new(
        CancellationToken::new(),
        Some(Instant::now() + Duration::from_secs(60)),
    )
}

/// Maps the kernel's answers onto the provider sentinels so the panel can
/// say "not found" or "permission denied" rather than surfacing an errno.
fn wrap_fs_error(target: &Path, err: std::io::Error) -> ProviderError {
    let target = target.display();
    match err.kind() {
        std::io::ErrorKind::NotFound => not_found(target),
        std::io::ErrorKind::PermissionDenied => ProviderError::PermissionDenied(target.to_string()),
        std::io::ErrorKind::AlreadyExists => ProviderError::conflict(format!("{target} already exists")),
        _ => ProviderError::internal(format!("{target}: {err}")),
    }
}

/* --------------------------------- keys ------------------------------- */

#[async_trait]
impl Ssh for SshOps {
    async fn list_keys(&self, ctx: &Ctx, p: SshKeysListParams) -> PResult<Vec<SshKeyInfo>> {
        let accounts = login_accounts(p.user.as_deref().unwrap_or_default())?;

        let mut keys = Vec::with_capacity(16);
        for account in accounts {
            ctx.check()?;
            let Ok(raw) = std::fs::read(account.home.join(AUTHORIZED_KEYS)) else {
                continue;
            };
            let text = String::from_utf8_lossy(&raw);
            for line in split_lines(&text) {
                if let Some(key) = parse_authorized_key(line, &account.name) {
                    keys.push(key);
                }
            }
        }

        keys.sort_by(|a, b| a.user.cmp(&b.user).then_with(|| a.comment.cmp(&b.comment)));
        Ok(keys)
    }

    async fn apply_keys(&self, _ctx: &Ctx, p: SshKeysApplyParams) -> PResult<i64> {
        // The account is resolved first, so a key for a user this host does
        // not have fails the job by name rather than creating a home
        // directory for nobody.
        let account = lookup_account(&p.user)?;

        let mut b = String::from("# Managed by Kaname. Edits are overwritten on the next key apply.\n");
        let mut applied = 0i64;
        for key in &p.keys {
            let normalized = normalize_authorized_key(&key.public_key, &key.comment)?;
            b.push_str(&normalized);
            b.push('\n');
            applied += 1;
        }

        install_authorized_keys(&account.home, account.uid, account.gid, b.as_bytes())?;
        Ok(applied)
    }

    /* -------------------------------- config ------------------------------ */

    async fn read_config(&self, ctx: &Ctx) -> PResult<SshConfigInfo> {
        let mut config = SshConfigInfo {
            port: 22,
            permit_root_login: "prohibit-password".into(),
            password_authentication: true,
            pubkey_authentication: true,
            max_auth_tries: 6,
            allow_users: Vec::new(),
            allow_groups: Vec::new(),
            x11_forwarding: false,
        };

        // `sshd -T` prints the effective configuration, includes and all,
        // which is the only honest answer once drop-ins are in play.
        let directives = self.effective_config(ctx).await?;

        for (key, values) in &directives {
            let value = values.join(" ");
            match key.as_str() {
                "port" => {
                    if let Ok(port) = values[0].parse() {
                        config.port = port;
                    }
                }
                "permitrootlogin" => config.permit_root_login = value,
                "passwordauthentication" => config.password_authentication = value == "yes",
                "pubkeyauthentication" => config.pubkey_authentication = value == "yes",
                "maxauthtries" => {
                    if let Ok(tries) = values[0].parse() {
                        config.max_auth_tries = tries;
                    }
                }
                "allowusers" => config.allow_users = value.split_whitespace().map(str::to_string).collect(),
                "allowgroups" => config.allow_groups = value.split_whitespace().map(str::to_string).collect(),
                "x11forwarding" => config.x11_forwarding = value == "yes",
                _ => {}
            }
        }
        Ok(config)
    }

    async fn apply_config(&self, ctx: &Ctx, p: SshConfigApplyParams) -> PResult<SshConfigApplyResult> {
        let Some(binary) = sshd_binary() else {
            return Err(unsupported("sshd is not installed"));
        };

        let (target, use_drop_in) = ssh_target_file();
        let previous: Option<Vec<u8>> = match std::fs::read(&target) {
            Ok(raw) => Some(raw),
            Err(e) if is_not_exist(&e) => None,
            Err(e) => return Err(wrap_fs_error(&target, e)),
        };

        let previous_text = previous
            .as_deref()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        let rendered = self.render_config(ctx, &p, &previous_text, use_drop_in).await?;
        if use_drop_in {
            std::fs::create_dir_all(SSH_DROP_IN_DIR)
                .map_err(|e| wrap_fs_error(Path::new(SSH_DROP_IN_DIR), e))?;
        }
        exec::write_atomic(&target, rendered.as_bytes(), 0o600).map_err(|e| wrap_fs_error(&target, e))?;

        let restore = Arc::new(Restore {
            shared: self.0.clone(),
            target: target.clone(),
            previous,
        });

        // Validating before reloading is the whole point: a syntax error that
        // reaches sshd takes the only way back in with it.
        if let Err(err) = exec::run_combined(ctx, tool(&binary, &["-t"])).await {
            let _ = restore.run(ctx).await;
            let output = match err {
                ProviderError::Exec { output, .. } => output,
                other => other.to_string(),
            };
            return Err(ProviderError::Exec {
                op: "sshd -t".into(),
                message: "precondition failed".into(),
                output: exec::tail(&output, exec::EXEC_OUTPUT_LIMIT).to_string(),
            });
        }
        if let Err(err) = reload(&self.0, ctx).await {
            let _ = restore.run(ctx).await;
            return Err(err);
        }

        let token = self
            .0
            .rollback
            .arm(
                "ssh",
                p.rollback_seconds,
                Box::new(move || {
                    let restore = restore.clone();
                    Box::pin(async move { restore.run(&revert_ctx()).await })
                }),
            )
            .await?;
        Ok(SshConfigApplyResult {
            rollback_token: token,
        })
    }

    /* ------------------------------- sessions ----------------------------- */

    async fn sessions(&self, ctx: &Ctx) -> PResult<Vec<SshSessionInfo>> {
        let out = exec::run_with(ctx, tool("who", &["-u"])).await?;

        let mut sessions = Vec::with_capacity(8);
        for line in split_lines(&out) {
            // who -u: user tty date time idle pid (host)
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 {
                continue;
            }

            let mut session = SshSessionInfo {
                user: fields[0].to_string(),
                from_ip: String::new(),
                tty: fields[1].to_string(),
                pid: 0,
                started_at: parse_who_timestamp(fields[2], fields[3]),
                idle_seconds: parse_idle(fields[4]),
            };
            if let Ok(pid) = fields[5].parse() {
                session.pid = pid;
            }
            if fields.len() > 6 {
                session.from_ip = fields[6].trim_matches(['(', ')']).to_string();
            }
            // A row with no remote address is a local console login, which is
            // not an SSH session.
            if session.from_ip.is_empty() {
                continue;
            }
            sessions.push(session);
        }
        Ok(sessions)
    }
}

/// What puts the previous sshd configuration back: the bytes it held, or
/// its absence, plus a reload.
struct Restore {
    shared: Arc<Shared>,
    target: PathBuf,
    previous: Option<Vec<u8>>,
}

impl Restore {
    async fn run(&self, ctx: &Ctx) -> PResult<()> {
        match &self.previous {
            None => {
                if let Err(e) = std::fs::remove_file(&self.target) {
                    if !is_not_exist(&e) {
                        return Err(wrap_fs_error(&self.target, e));
                    }
                }
            }
            Some(previous) => {
                exec::write_atomic(&self.target, previous, 0o600)
                    .map_err(|e| wrap_fs_error(&self.target, e))?;
            }
        }
        reload(&self.shared, ctx).await
    }
}

impl SshOps {
    /// Decides what to write and then refuses the one shape that cannot be
    /// undone from the panel: a change that excludes the account currently
    /// holding the session applying it.
    async fn render_config(
        &self,
        ctx: &Ctx,
        p: &SshConfigApplyParams,
        previous: &str,
        use_drop_in: bool,
    ) -> PResult<String> {
        let directives = ssh_directives(&SshConfigChange::from_params(p))?;
        // Locking out the account that is currently connected is the failure
        // mode this whole method exists to prevent, so it is refused outright.
        self.check_not_self_locking(ctx, p).await?;
        if use_drop_in {
            // sshd adds up AllowUsers lines from every file, so leaving one out
            // of the drop-in cannot clear a list the operator's own file sets.
            // Say so rather than report a clear that did not happen.
            let main = std::fs::read(SSH_CONFIG_PATH)
                .map(|raw| String::from_utf8_lossy(&raw).into_owned())
                .unwrap_or_default();
            for (key, value) in &directives {
                if value.is_empty() && sets_directive(&main, key) {
                    return Err(precondition(format!(
                        "{key} is set in {SSH_CONFIG_PATH} itself; Kaname only manages its drop-in, so it cannot clear it"
                    )));
                }
            }
        }
        Ok(render_ssh_config(&directives, previous, use_drop_in))
    }

    /// Refuses a change that would exclude every account with an active
    /// session.
    async fn check_not_self_locking(&self, ctx: &Ctx, p: &SshConfigApplyParams) -> PResult<()> {
        // Omitted leaves AllowUsers as it is, and an empty list clears it so
        // every account may log in: neither can exclude a session.
        let Some(allow_users) = p.allow_users.as_ref().filter(|users| !users.is_empty()) else {
            return Ok(());
        };
        let sessions = match self.sessions(ctx).await {
            Ok(sessions) if !sessions.is_empty() => sessions,
            _ => return Ok(()),
        };

        if sessions.iter().any(|s| allow_users.contains(&s.user)) {
            return Ok(());
        }
        Err(precondition(
            "allow_users excludes every account with an open session",
        ))
    }

    async fn effective_config(&self, ctx: &Ctx) -> PResult<HashMap<String, Vec<String>>> {
        let mut directives: HashMap<String, Vec<String>> = HashMap::new();

        if let Some(binary) = sshd_binary() {
            if let Ok(out) = exec::run_with(ctx, tool(&binary, &["-T"])).await {
                for line in split_lines(&out) {
                    let Some((key, value)) = line.trim().split_once(' ') else {
                        continue;
                    };
                    directives
                        .entry(key.to_lowercase())
                        .or_default()
                        .push(value.trim().to_string());
                }
                return Ok(directives);
            }
        }

        // A host where sshd cannot be executed still has a config worth
        // reading, even if it is only the literal file.
        let raw = std::fs::read(SSH_CONFIG_PATH).map_err(|e| wrap_fs_error(Path::new(SSH_CONFIG_PATH), e))?;
        let text = String::from_utf8_lossy(&raw);
        for line in split_lines(&text) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 2 || fields[0].starts_with('#') {
                continue;
            }
            directives
                .entry(fields[0].to_lowercase())
                .or_default()
                .push(fields[1..].join(" "));
        }
        Ok(directives)
    }
}

async fn reload(shared: &Shared, ctx: &Ctx) -> PResult<()> {
    if !shared.has(cap::SYSTEMD) {
        return Err(unsupported("reloading sshd needs systemd on this host"));
    }
    // Debian calls the unit ssh, Red Hat calls it sshd, and a host may carry
    // an alias for the other.
    let mut last_err = None;
    for unit in ["ssh", "sshd"] {
        match exec::run_with(ctx, tool("systemctl", &["reload", unit])).await {
            Ok(_) => return Ok(()),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| ProviderError::internal("sshd could not be reloaded")))
}

/* -------------------------------- helpers ----------------------------- */

fn lookup_account(name: &str) -> PResult<Account> {
    let user = nix::unistd::User::from_name(name)
        .ok()
        .flatten()
        .ok_or_else(|| not_found(format!("no POSIX account named {name} on this host")))?;
    Ok(Account {
        name: user.name,
        uid: user.uid.as_raw(),
        gid: user.gid.as_raw(),
        home: user.dir,
    })
}

/// Writes `~user/.ssh/authorized_keys`: the directory 0700 and the file
/// 0600, both owned by the account, because sshd's StrictModes ignores a
/// key file it does not trust.
///
/// The account owns `~/.ssh`, so it can replace it — or the key file — with
/// a symlink to somewhere only root may write. Following one would let any
/// user with a shell have Kaname write and chown a root-owned file. So the
/// directory is refused if it is a symlink, then opened with O_NOFOLLOW,
/// and every later step goes through that descriptor (openat, fchown,
/// fchmod, renameat) rather than through a path that could be swapped
/// between the check and the write. No binary is run at all.
fn install_authorized_keys(home: &Path, uid: u32, gid: u32, content: &[u8]) -> PResult<()> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    use nix::fcntl::{OFlag, openat, renameat};
    use nix::sys::stat::Mode;
    use nix::unistd::{UnlinkatFlags, unlinkat};

    match std::fs::metadata(home) {
        Ok(meta) if meta.is_dir() => {}
        _ => {
            return Err(precondition(format!(
                "{} is not a directory on this host, so there is nowhere to put authorized_keys",
                home.display()
            )));
        }
    }

    let ssh_dir = home.join(".ssh");
    match std::fs::symlink_metadata(&ssh_dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(precondition(format!(
                "{} is a symbolic link; Kaname will not follow it",
                ssh_dir.display()
            )));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(precondition(format!("{} is not a directory", ssh_dir.display())));
        }
        Ok(_) => {}
        Err(e) if is_not_exist(&e) => std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&ssh_dir)
            .map_err(|e| wrap_fs_error(&ssh_dir, e))?,
        Err(e) => return Err(wrap_fs_error(&ssh_dir, e)),
    }

    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&ssh_dir)
        .map_err(|e| wrap_fs_error(&ssh_dir, e))?;
    std::os::unix::fs::fchown(&dir, Some(uid), Some(gid)).map_err(|e| wrap_fs_error(&ssh_dir, e))?;
    dir.set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| wrap_fs_error(&ssh_dir, e))?;

    let dirfd = dir.as_raw_fd();
    let target = ssh_dir.join("authorized_keys");
    let temp = format!(".authorized_keys.{}", uuid::Uuid::new_v4().simple());
    let fd = openat(
        Some(dirfd),
        temp.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(|e| wrap_fs_error(&target, e.into()))?;
    // SAFETY: openat has just returned this descriptor and nothing else
    // holds it, so the File becomes its only owner.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };

    let result = (|| -> std::io::Result<()> {
        file.write_all(content)?;
        std::os::unix::fs::fchown(&file, Some(uid), Some(gid))?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        // Rename over whatever is there, a planted symlink included: the
        // link itself is replaced, never written through.
        renameat(Some(dirfd), temp.as_str(), Some(dirfd), "authorized_keys")?;
        match dir.sync_all() {
            Err(e) if e.raw_os_error() == Some(libc::EINVAL) => Ok(()),
            other => other,
        }
    })();
    if result.is_err() {
        let _ = unlinkat(Some(dirfd), temp.as_str(), UnlinkatFlags::NoRemoveDir);
    }
    result.map_err(|e| wrap_fs_error(&target, e))
}

/// Lists the accounts worth inspecting: root plus the regular users, read
/// from /etc/passwd because the account database cannot be enumerated
/// otherwise.
fn login_accounts(only: &str) -> PResult<Vec<Account>> {
    if !only.is_empty() {
        return Ok(vec![lookup_account(only)?]);
    }

    let raw = std::fs::read("/etc/passwd").map_err(|e| wrap_fs_error(Path::new("/etc/passwd"), e))?;
    let text = String::from_utf8_lossy(&raw);

    let mut accounts = Vec::with_capacity(16);
    for line in split_lines(&text) {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 {
            continue;
        }
        let Ok(uid) = fields[2].parse::<u32>() else {
            continue;
        };
        if uid != 0 && uid < 1000 {
            continue;
        }
        if fields[6].ends_with("nologin") || fields[6].ends_with("false") {
            continue;
        }
        accounts.push(Account {
            name: fields[0].to_string(),
            uid,
            gid: fields[3].parse().unwrap_or(uid),
            home: PathBuf::from(fields[5]),
        });
    }
    Ok(accounts)
}

fn sshd_binary() -> Option<String> {
    if exec::has_binary("sshd") {
        return Some("sshd".to_string());
    }
    ["/usr/sbin/sshd", "/sbin/sshd", "/usr/bin/sshd"]
        .into_iter()
        .find(|candidate| exec::file_exists(candidate))
        .map(str::to_string)
}

/// Prefers a drop-in when the main config includes one, because writing
/// there leaves the operator's own file untouched.
fn ssh_target_file() -> (PathBuf, bool) {
    let main = PathBuf::from(SSH_CONFIG_PATH);
    let Ok(raw) = std::fs::read(&main) else {
        return (main, false);
    };
    let text = String::from_utf8_lossy(&raw);
    for line in split_lines(&text) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 || !fields[0].eq_ignore_ascii_case("Include") {
            continue;
        }
        if fields[1].starts_with(SSH_DROP_IN_DIR) {
            return (Path::new(SSH_DROP_IN_DIR).join(SSH_DROP_IN_FILE), true);
        }
    }
    (main, false)
}

fn parse_who_timestamp(date: &str, clock: &str) -> String {
    let Ok(naive) = NaiveDateTime::parse_from_str(&format!("{date} {clock}"), "%Y-%m-%d %H:%M") else {
        return now_rfc3339();
    };
    match Local.from_local_datetime(&naive).single() {
        Some(local) => rfc3339(local.with_timezone(&chrono::Utc)),
        None => now_rfc3339(),
    }
}

/* ------------------------------------------------------------------ *
 * sshd config rendering.
 *
 * Deciding what goes into sshd_config is separate from writing it,
 * because the writing half is the half that can strand an operator. What
 * is rendered here is either a self-contained drop-in or the operator's
 * own file with exactly the managed directives replaced — never a file
 * assembled from text the control plane supplied verbatim.
 * ------------------------------------------------------------------ */
pub mod render {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    use crate::providers::linux::common::invalid;
    use crate::providers::{PResult, SshConfigApplyParams, SshKeyInfo};

    /// The public key algorithms OpenSSH accepts in an authorized_keys line.
    const SSH_KEY_TYPES: &[&str] = &[
        "ssh-rsa",
        "ssh-ed25519",
        "ssh-dss",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ssh-ed25519@openssh.com",
        "sk-ecdsa-sha2-nistp256@openssh.com",
    ];

    fn is_key_type(field: &str) -> bool {
        SSH_KEY_TYPES.contains(&field)
    }

    /// One directive: canonical keyword and its value. An empty value means
    /// "remove this directive", which only the list directives can ask for.
    pub type Directive = (String, String);

    /// The partial config as the renderer sees it. `None` leaves a directive
    /// alone; for `allow_users`/`allow_groups`, `Some(vec![])` clears it,
    /// which sshd reads as "no restriction" (it has no spelling for "allow
    /// nobody": a bare `AllowUsers` is a syntax error).
    #[derive(Clone, Debug, Default)]
    pub struct SshConfigChange {
        pub port: Option<i64>,
        pub permit_root_login: Option<String>,
        pub password_authentication: Option<bool>,
        pub pubkey_authentication: Option<bool>,
        pub max_auth_tries: Option<i64>,
        pub allow_users: Option<Vec<String>>,
        pub allow_groups: Option<Vec<String>>,
        pub x11_forwarding: Option<bool>,
    }

    impl SshConfigChange {
        pub fn from_params(p: &SshConfigApplyParams) -> Self {
            Self {
                port: p.port,
                permit_root_login: p.permit_root_login.clone(),
                password_authentication: p.password_authentication,
                pubkey_authentication: p.pubkey_authentication,
                max_auth_tries: p.max_auth_tries,
                allow_users: p.allow_users.clone(),
                allow_groups: p.allow_groups.clone(),
                x11_forwarding: p.x11_forwarding,
            }
        }
    }

    /// Turns the partial config into the ordered list of directives to
    /// write, refusing the values sshd would reject and the ones that would
    /// leave nobody able to log in.
    pub fn ssh_directives(p: &SshConfigChange) -> PResult<Vec<Directive>> {
        let mut directives: Vec<Directive> = Vec::with_capacity(8);
        let mut add = |key: &str, value: String| directives.push((key.to_string(), value));

        if let Some(port) = p.port {
            add("Port", port.to_string());
        }
        if let Some(permit) = &p.permit_root_login {
            add("PermitRootLogin", permit.clone());
        }
        if let Some(v) = p.password_authentication {
            add("PasswordAuthentication", yes_no(v).into());
        }
        if let Some(v) = p.pubkey_authentication {
            add("PubkeyAuthentication", yes_no(v).into());
        }
        if let Some(tries) = p.max_auth_tries {
            if !(1..=100).contains(&tries) {
                return Err(invalid("max_auth_tries must be between 1 and 100"));
            }
            add("MaxAuthTries", tries.to_string());
        }
        // An empty list is a clear: rendered as the directive's removal,
        // never as a bare `AllowUsers` line, which sshd -t would reject.
        if let Some(users) = &p.allow_users {
            add("AllowUsers", users.join(" "));
        }
        if let Some(groups) = &p.allow_groups {
            add("AllowGroups", groups.join(" "));
        }
        if let Some(v) = p.x11_forwarding {
            add("X11Forwarding", yes_no(v).into());
        }
        if directives.is_empty() {
            return Err(invalid("no directive was supplied"));
        }
        Ok(directives)
    }

    /// Produces the file to write: a self-contained drop-in when the host
    /// supports one, or the original config with the touched directives
    /// replaced in place when it does not.
    pub fn render_ssh_config(directives: &[Directive], previous: &str, use_drop_in: bool) -> String {
        if use_drop_in {
            let mut b =
                String::from("# Managed by Kaname. Edits are overwritten on the next ssh config apply.\n");
            for (key, value) in directives {
                if value.is_empty() {
                    continue;
                }
                b.push_str(&format!("{key} {value}\n"));
            }
            return b;
        }
        merge_directives(previous, directives)
    }

    /// Whether a config file sets `key` on an uncommented line.
    pub fn sets_directive(text: &str, key: &str) -> bool {
        text.lines().any(|line| {
            line.split_whitespace()
                .next()
                .is_some_and(|first| first.eq_ignore_ascii_case(key))
        })
    }

    /// Replaces the directives Kaname manages and leaves every other line of
    /// the operator's config untouched.
    pub fn merge_directives(previous: &str, directives: &[Directive]) -> String {
        let managed: std::collections::HashMap<String, &str> = directives
            .iter()
            .map(|(k, v)| (k.to_lowercase(), v.as_str()))
            .collect();

        let mut lines: Vec<String> = previous.split('\n').map(str::to_string).collect();
        let mut applied: std::collections::HashSet<String> = std::collections::HashSet::new();
        for line in lines.iter_mut() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.is_empty() || fields[0].starts_with('#') {
                continue;
            }
            let key = fields[0].to_lowercase();
            let Some(value) = managed.get(&key) else { continue };
            if value.is_empty() {
                // Cleared: the operator's line is kept, commented out, so the
                // file still shows what used to be there.
                *line = format!("# {line}");
                applied.insert(key);
                continue;
            }
            if applied.contains(&key) {
                // A directive OpenSSH would ignore anyway (first one wins) is
                // commented out rather than left to confuse the next reader.
                *line = format!("# {line}");
                continue;
            }
            *line = format!("{} {}", proper_case(directives, &key), value);
            applied.insert(key);
        }

        let mut b = lines.join("\n");
        if !b.ends_with('\n') {
            b.push('\n');
        }
        for (key, value) in directives {
            if value.is_empty() || applied.contains(&key.to_lowercase()) {
                continue;
            }
            b.push_str(&format!("{key} {value}\n"));
        }
        b
    }

    fn proper_case<'a>(directives: &'a [Directive], key: &'a str) -> &'a str {
        directives
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(k, _)| k.as_str())
            .unwrap_or(key)
    }

    /* --------------------------------- keys ------------------------------- */

    pub fn parse_authorized_key(line: &str, owner: &str) -> Option<SshKeyInfo> {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }

        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        // An options prefix may precede the algorithm, so the key starts at
        // the first field that names one.
        let start = fields.iter().position(|f| is_key_type(f))?;
        if start + 1 >= fields.len() {
            return None;
        }

        let (algorithm, blob) = (fields[start], fields[start + 1]);
        let comment = fields[start + 2..].join(" ");
        let fingerprint = key_fingerprint(blob).ok()?;

        Some(SshKeyInfo {
            fingerprint,
            r#type: algorithm.to_string(),
            comment,
            public_key: format!("{algorithm} {blob}"),
            user: owner.to_string(),
        })
    }

    /// Re-parses a key before it is written, so a malformed or multi-line
    /// value can never land in authorized_keys.
    pub fn normalize_authorized_key(public_key: &str, comment: &str) -> PResult<String> {
        if public_key.contains(['\n', '\r']) || comment.contains(['\n', '\r']) {
            return Err(invalid("a public key and its comment must each be a single line"));
        }

        let fields: Vec<&str> = public_key.split_whitespace().collect();
        if fields.len() < 2 {
            return Err(invalid("public key must be `<type> <base64>`"));
        }
        if !is_key_type(fields[0]) {
            return Err(invalid(format!("{:?} is not a supported key type", fields[0])));
        }
        if key_fingerprint(fields[1]).is_err() {
            return Err(invalid("public key is not valid base64"));
        }

        let mut line = format!("{} {}", fields[0], fields[1]);
        let trimmed = comment.trim();
        if !trimmed.is_empty() {
            line.push(' ');
            line.push_str(trimmed);
        } else if fields.len() > 2 {
            line.push(' ');
            line.push_str(&fields[2..].join(" "));
        }
        Ok(line)
    }

    /// Produces the SHA256 form OpenSSH prints, so what the panel shows
    /// matches `ssh-keygen -lf`.
    pub fn key_fingerprint(blob: &str) -> Result<String, String> {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .map_err(|e| e.to_string())?;
        if decoded.is_empty() {
            return Err("empty key blob".into());
        }
        let sum = Sha256::digest(&decoded);
        Ok(format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(sum)
        ))
    }

    /* -------------------------------- helpers ----------------------------- */

    pub fn yes_no(value: bool) -> &'static str {
        if value { "yes" } else { "no" }
    }

    /// Reads who's idle column, which is "." for active, "old" for a very
    /// long idle, or HH:MM.
    pub fn parse_idle(value: &str) -> i64 {
        match value {
            "." | "?" => return 0,
            "old" => return 86400,
            _ => {}
        }
        let Some((hours, minutes)) = value.split_once(':') else {
            return 0;
        };
        let (Ok(h), Ok(m)) = (hours.parse::<i64>(), minutes.parse::<i64>()) else {
            return 0;
        };
        h * 3600 + m * 60
    }
}

#[cfg(test)]
mod tests {
    /* ------------------------------------------------------------------ *
     * sshd config rendering.
     *
     * The failure mode here is not a compromised host, it is an unreachable
     * one: a directive that sshd refuses, or an authorized_keys line with a
     * newline in it, and the operator's only way in is gone. Everything
     * below is about what gets written, never about writing it.
     * ------------------------------------------------------------------ */

    use super::render::*;
    use crate::providers::ProviderError;

    fn directive_value(directives: &[Directive], key: &str) -> String {
        directives
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("no {key} directive in {directives:?}"))
    }

    fn d(pairs: &[(&str, &str)]) -> Vec<Directive> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn is_invalid<T>(result: &Result<T, ProviderError>) -> bool {
        matches!(result, Err(ProviderError::InvalidParams(_)))
    }

    #[test]
    fn ssh_directives_renders_only_what_was_asked_for() {
        let directives = ssh_directives(&SshConfigChange {
            port: Some(2222),
            password_authentication: Some(false),
            permit_root_login: Some("prohibit-password".into()),
            max_auth_tries: Some(3),
            allow_users: Some(vec!["deploy".into(), "ops".into()]),
            x11_forwarding: Some(false),
            ..Default::default()
        })
        .unwrap();

        // An omitted field means "leave this directive alone", so a directive
        // nobody asked about must not appear at all — writing the default back
        // would quietly override whatever the operator had set by hand.
        for (key, _) in &directives {
            assert!(
                !key.eq_ignore_ascii_case("PubkeyAuthentication") && !key.eq_ignore_ascii_case("AllowGroups"),
                "an unset field produced the directive {key}"
            );
        }

        assert_eq!(directive_value(&directives, "Port"), "2222");
        assert_eq!(directive_value(&directives, "PasswordAuthentication"), "no");
        assert_eq!(
            directive_value(&directives, "PermitRootLogin"),
            "prohibit-password"
        );
        assert_eq!(directive_value(&directives, "MaxAuthTries"), "3");
        // sshd takes a space-separated list on one line, not one line per user.
        assert_eq!(directive_value(&directives, "AllowUsers"), "deploy ops");
        assert_eq!(directive_value(&directives, "X11Forwarding"), "no");
    }

    #[test]
    fn ssh_directives_refuses_the_values_sshd_would_reject() {
        let cases: Vec<(&str, SshConfigChange)> = vec![
            ("nothing at all", SshConfigChange::default()),
            (
                "max_auth_tries of zero",
                SshConfigChange {
                    max_auth_tries: Some(0),
                    ..Default::default()
                },
            ),
            (
                "negative max_auth_tries",
                SshConfigChange {
                    max_auth_tries: Some(-1),
                    ..Default::default()
                },
            ),
            (
                "absurd max_auth_tries",
                SshConfigChange {
                    max_auth_tries: Some(101),
                    ..Default::default()
                },
            ),
        ];
        for (name, params) in cases {
            assert!(
                is_invalid(&ssh_directives(&params)),
                "{name} was not rejected as invalid"
            );
        }
    }

    #[test]
    fn an_omitted_list_is_left_alone_and_an_empty_one_clears_it() {
        // Omitted: no AllowUsers directive is touched at all.
        let omitted = SshConfigChange::from_params(&crate::providers::SshConfigApplyParams {
            port: Some(2222),
            ..Default::default()
        });
        assert!(omitted.allow_users.is_none());
        assert!(omitted.allow_groups.is_none());
        let directives = ssh_directives(&omitted).unwrap();
        assert!(
            !directives
                .iter()
                .any(|(k, _)| k == "AllowUsers" || k == "AllowGroups")
        );

        // Empty: a removal, which is a directive in its own right (so a clear
        // alone is not "no directive was supplied").
        let cleared = SshConfigChange::from_params(&crate::providers::SshConfigApplyParams {
            allow_users: Some(vec![]),
            ..Default::default()
        });
        assert_eq!(cleared.allow_users, Some(vec![]));
        let directives = ssh_directives(&cleared).unwrap();
        assert_eq!(directives, d(&[("AllowUsers", "")]));
    }

    #[test]
    fn a_cleared_list_is_removed_from_the_file_never_written_bare() {
        let directives = d(&[("AllowUsers", ""), ("Port", "2222")]);

        // In the operator's own file: commented out, kept for the record.
        let previous = "Port 22\nAllowUsers root deploy\nPasswordAuthentication no\nallowusers extra\n";
        let merged = render_ssh_config(&directives, previous, false);
        assert!(merged.contains("# AllowUsers root deploy\n"), "{merged}");
        assert!(merged.contains("# allowusers extra\n"), "{merged}");
        assert!(merged.contains("Port 2222\n"), "{merged}");
        assert!(merged.contains("PasswordAuthentication no\n"), "{merged}");
        // A bare `AllowUsers` is a syntax error to sshd -t.
        for line in merged.lines() {
            assert_ne!(line.trim(), "AllowUsers", "{merged}");
        }
        assert!(!sets_directive(&merged, "AllowUsers"), "{merged}");

        // Nothing to clear is not an error: no line is invented either.
        let untouched = render_ssh_config(&directives, "Port 22\n", false);
        assert!(!sets_directive(&untouched, "AllowUsers"), "{untouched}");

        // In Kaname's drop-in: simply absent.
        let drop_in = render_ssh_config(&directives, "AllowUsers old\n", true);
        assert!(!sets_directive(&drop_in, "AllowUsers"), "{drop_in}");
        assert!(drop_in.contains("Port 2222\n"), "{drop_in}");
    }

    #[test]
    fn sets_directive_ignores_comments_and_case() {
        assert!(sets_directive("Port 22\nallowusers a b\n", "AllowUsers"));
        assert!(sets_directive("  AllowUsers a\n", "AllowUsers"));
        assert!(!sets_directive("# AllowUsers a\nPort 22\n", "AllowUsers"));
        assert!(!sets_directive("AllowUsersX a\n", "AllowUsers"));
    }

    #[test]
    fn render_ssh_config_writes_a_self_contained_drop_in() {
        let directives = d(&[("Port", "2222"), ("PasswordAuthentication", "no")]);
        let previous = "# somebody else's drop-in\nPort 9999\n";

        let rendered = render_ssh_config(&directives, previous, true);

        assert!(
            rendered.starts_with("# Managed by Kaname."),
            "the drop-in does not announce itself:\n{rendered}"
        );
        // A drop-in is rewritten wholesale, so nothing of the previous content
        // may survive — otherwise a directive removed from the panel would
        // linger on the host.
        assert!(
            !rendered.contains("9999") && !rendered.contains("somebody else"),
            "kept previous content"
        );
        assert!(rendered.contains("Port 2222\n") && rendered.contains("PasswordAuthentication no\n"));
    }

    /// The merge path is the one that touches an operator's own file, so what
    /// it must not do is more important than what it does.
    #[test]
    fn render_ssh_config_merges_into_the_operators_file() {
        let previous = [
            "# our hardening notes live here",
            "Port 22",
            "",
            "PasswordAuthentication yes",
            "KexAlgorithms curve25519-sha256",
            "Match User backup",
            "    PasswordAuthentication yes",
        ]
        .join("\n")
            + "\n";

        let rendered = render_ssh_config(
            &d(&[("Port", "2222"), ("PermitRootLogin", "no")]),
            &previous,
            false,
        );

        assert!(
            rendered.contains("Port 2222\n"),
            "the managed directive was not replaced:\n{rendered}"
        );
        assert!(
            !rendered.contains("Port 22\n"),
            "the old value survived the merge:\n{rendered}"
        );
        // Everything the panel does not manage is left exactly as it was.
        for keep in [
            "# our hardening notes live here",
            "PasswordAuthentication yes",
            "KexAlgorithms curve25519-sha256",
            "Match User backup",
        ] {
            assert!(rendered.contains(keep), "the merge dropped {keep:?}:\n{rendered}");
        }
        // A directive the file never had is appended rather than lost.
        assert!(
            rendered.contains("PermitRootLogin no\n"),
            "a new directive was not appended:\n{rendered}"
        );
        assert!(rendered.ends_with('\n'));
    }

    #[test]
    fn render_ssh_config_comments_out_a_duplicate_rather_than_leaving_it() {
        let previous = "Port 22\nPasswordAuthentication yes\nPort 2200\n";
        let rendered = render_ssh_config(&d(&[("Port", "2222")]), previous, false);

        // OpenSSH takes the first occurrence and ignores the rest. Rewriting
        // only the first and leaving the second would show a config that
        // disagrees with itself the next time somebody reads the file.
        assert!(
            rendered.contains("Port 2222"),
            "the first occurrence was not replaced:\n{rendered}"
        );
        assert!(
            rendered.contains("# Port 2200"),
            "the shadowed duplicate was not commented out:\n{rendered}"
        );
    }

    #[test]
    fn render_ssh_config_matches_directives_case_insensitively_and_writes_them_back_in_canonical_case() {
        // sshd_config keywords are case-insensitive, so a hand-edited file may
        // spell one any way at all. Missing that would append a second Port
        // line below the one already in effect, which OpenSSH would ignore.
        let previous = "port 22\nPASSWORDAUTHENTICATION yes\n";
        let rendered = render_ssh_config(
            &d(&[("Port", "2222"), ("PasswordAuthentication", "no")]),
            previous,
            false,
        );

        assert_eq!(
            rendered.matches("2222").count(),
            1,
            "Port was written more than once:\n{rendered}"
        );
        assert!(
            rendered.contains("Port 2222"),
            "the lowercase directive was not matched:\n{rendered}"
        );
        assert!(
            rendered.contains("PasswordAuthentication no"),
            "the uppercase directive was not matched"
        );
        assert!(!rendered.contains("yes"), "the old value survived:\n{rendered}");
    }

    #[test]
    fn render_ssh_config_ignores_commented_out_directives() {
        let previous = "# Port 22\n#PasswordAuthentication yes\nPort 22\n";
        let rendered = render_ssh_config(&d(&[("Port", "2222")]), previous, false);

        // The commented line is documentation, not configuration; rewriting it
        // would turn a note into a live directive.
        assert!(
            rendered.contains("# Port 22\n"),
            "a commented directive was rewritten:\n{rendered}"
        );
        assert!(
            rendered.contains("\nPort 2222"),
            "the live directive was not replaced:\n{rendered}"
        );
    }

    /* ------------------------------ authorized keys ---------------------- */

    /// A real ed25519 key, so the base64 and the fingerprint are genuine.
    const TEST_KEY_BLOB: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJ7z3vJ7CvLmQ0MEhJP1IcqTr5F7cLo3CzQRhDvJz3Nx";

    #[test]
    fn normalize_authorized_key_refuses_anything_that_could_forge_a_line() {
        let cases: Vec<(&str, String, String)> = vec![
            // A newline in either field would let one requested key become two
            // authorized ones — the second being whatever the caller wanted.
            (
                "newline in the key",
                format!("ssh-ed25519 {TEST_KEY_BLOB}\nssh-ed25519 {TEST_KEY_BLOB}"),
                "laptop".into(),
            ),
            (
                "carriage return in the key",
                format!("ssh-ed25519 {TEST_KEY_BLOB}\r\nssh-rsa AAAA"),
                "laptop".into(),
            ),
            (
                "newline in the comment",
                format!("ssh-ed25519 {TEST_KEY_BLOB}"),
                format!("laptop\nssh-ed25519 {TEST_KEY_BLOB}"),
            ),
            ("no blob", "ssh-ed25519".into(), "laptop".into()),
            ("empty", String::new(), String::new()),
            (
                "unknown algorithm",
                format!("ssh-rsa-but-not-really {TEST_KEY_BLOB}"),
                "laptop".into(),
            ),
            // An options prefix carries command= and permitopen=, so accepting
            // one on write would let a caller smuggle a forced command in.
            (
                "options prefix",
                format!("command=\"/bin/sh\" ssh-ed25519 {TEST_KEY_BLOB}"),
                "laptop".into(),
            ),
            (
                "not base64",
                "ssh-ed25519 ****not base64****".into(),
                "laptop".into(),
            ),
            ("empty blob", "ssh-ed25519 ''".into(), "laptop".into()),
        ];
        for (name, key, comment) in cases {
            let result = normalize_authorized_key(&key, &comment);
            assert!(
                is_invalid(&result),
                "{name}: normalize_authorized_key produced {result:?}"
            );
        }
    }

    #[test]
    fn normalize_authorized_key_produces_one_canonical_line() {
        let cases: Vec<(&str, String, &str, String)> = vec![
            (
                "type, blob and comment",
                format!("ssh-ed25519 {TEST_KEY_BLOB}"),
                "deploy@laptop",
                format!("ssh-ed25519 {TEST_KEY_BLOB} deploy@laptop"),
            ),
            (
                "surrounding whitespace is dropped",
                format!("  ssh-ed25519   {TEST_KEY_BLOB}  "),
                "  deploy@laptop  ",
                format!("ssh-ed25519 {TEST_KEY_BLOB} deploy@laptop"),
            ),
            // The comment already inside the key is kept when no separate one
            // is given, so re-applying a key does not lose its label.
            (
                "the key's own comment is kept",
                format!("ssh-ed25519 {TEST_KEY_BLOB} from-the-key"),
                "",
                format!("ssh-ed25519 {TEST_KEY_BLOB} from-the-key"),
            ),
            (
                "an explicit comment wins",
                format!("ssh-ed25519 {TEST_KEY_BLOB} from-the-key"),
                "from-the-panel",
                format!("ssh-ed25519 {TEST_KEY_BLOB} from-the-panel"),
            ),
        ];
        for (name, key, comment, want) in cases {
            let got = normalize_authorized_key(&key, comment).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(got, want, "{name}");
            assert!(
                !got.contains(['\n', '\r']),
                "the normalised line spans more than one line"
            );
        }
    }

    #[test]
    fn parse_authorized_key_reads_what_sshd_would_read() {
        let line = format!(
            "no-port-forwarding,command=\"/usr/bin/rrsync /srv\" ssh-ed25519 {TEST_KEY_BLOB} backup@nas"
        );

        let key =
            parse_authorized_key(&line, "deploy").expect("a key behind an options prefix was not recognised");
        // Reading is not writing: an existing line with options is reported so
        // the panel can show it, with the algorithm found past the options.
        assert_eq!(key.r#type, "ssh-ed25519");
        assert_eq!(key.public_key, format!("ssh-ed25519 {TEST_KEY_BLOB}"));
        assert_eq!(key.comment, "backup@nas");
        assert_eq!(key.user, "deploy");
        // ssh-keygen -lf prints the unpadded base64 form; matching it is how
        // an operator compares what the panel shows to what they have.
        assert!(
            key.fingerprint.starts_with("SHA256:") && !key.fingerprint.ends_with('='),
            "{}",
            key.fingerprint
        );
    }

    #[test]
    fn parse_authorized_key_skips_what_is_not_a_key() {
        for line in [
            "".to_string(),
            "   ".to_string(),
            "# a comment".to_string(),
            format!("# ssh-ed25519 {TEST_KEY_BLOB}"),
            "ssh-ed25519".to_string(),
            "nonsense entirely".to_string(),
            "ssh-ed25519 !!!not-base64!!!".to_string(),
        ] {
            assert!(
                parse_authorized_key(&line, "deploy").is_none(),
                "parse_authorized_key({line:?}) returned a key"
            );
        }
    }

    #[test]
    fn key_fingerprint_matches_openssh_form() {
        let fingerprint = key_fingerprint(TEST_KEY_BLOB).unwrap();
        // SHA-256 is 32 bytes, which is 43 unpadded base64 characters.
        assert_eq!(fingerprint.len(), "SHA256:".len() + 43, "{fingerprint}");
        assert!(
            key_fingerprint("").is_err(),
            "an empty blob produced a fingerprint"
        );
        assert!(
            key_fingerprint("!!!").is_err(),
            "a non-base64 blob produced a fingerprint"
        );
    }

    #[test]
    fn parse_idle_reads_whos_column() {
        let cases = [
            (".", 0),
            ("?", 0),
            ("old", 86400),
            ("00:00", 0),
            ("00:07", 420),
            ("02:30", 9000),
            ("", 0),
            ("junk", 0),
        ];
        for (raw, want) in cases {
            assert_eq!(parse_idle(raw), want, "parse_idle({raw:?})");
        }
    }
}

#[cfg(test)]
mod authorized_keys_tests {
    /* ------------------------------------------------------------------ *
     * Writing ~user/.ssh/authorized_keys.
     *
     * The account owns ~/.ssh, so everything here is about what a hostile
     * account could make the root agent do: follow a symlink out of the
     * home directory, or leave a file sshd will not trust.
     * ------------------------------------------------------------------ */

    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use super::{install_authorized_keys, lookup_account};
    use crate::providers::ProviderError;

    fn me() -> (u32, u32) {
        (nix::unistd::getuid().as_raw(), nix::unistd::getgid().as_raw())
    }

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[test]
    fn writes_the_file_0600_in_a_0700_directory_owned_by_the_account() {
        let home = tempfile::tempdir().unwrap();
        let (uid, gid) = me();
        install_authorized_keys(home.path(), uid, gid, b"ssh-ed25519 AAAA one\n").unwrap();

        let dir = home.path().join(".ssh");
        let file = dir.join("authorized_keys");
        assert_eq!(std::fs::read(&file).unwrap(), b"ssh-ed25519 AAAA one\n");
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&file), 0o600);
        let meta = std::fs::metadata(&file).unwrap();
        assert_eq!((meta.uid(), meta.gid()), (uid, gid));
        // No temp file is left beside it.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("authorized_keys")]);

        // A second apply replaces the set rather than appending to it.
        install_authorized_keys(home.path(), uid, gid, b"ssh-ed25519 BBBB two\n").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"ssh-ed25519 BBBB two\n");
    }

    #[test]
    fn tightens_a_directory_the_account_left_open() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".ssh");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let (uid, gid) = me();
        install_authorized_keys(home.path(), uid, gid, b"").unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn refuses_a_symlinked_ssh_directory_and_writes_nothing_through_it() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), home.path().join(".ssh")).unwrap();
        let (uid, gid) = me();

        let err = install_authorized_keys(home.path(), uid, gid, b"x\n").unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err:?}");
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }

    #[test]
    fn replaces_a_planted_authorized_keys_symlink_instead_of_writing_through_it() {
        let home = tempfile::tempdir().unwrap();
        let victim = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(victim.path(), b"precious\n").unwrap();
        let dir = home.path().join(".ssh");
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(victim.path(), dir.join("authorized_keys")).unwrap();
        let (uid, gid) = me();

        install_authorized_keys(home.path(), uid, gid, b"ssh-ed25519 AAAA k\n").unwrap();
        assert_eq!(std::fs::read(victim.path()).unwrap(), b"precious\n");
        let meta = std::fs::symlink_metadata(dir.join("authorized_keys")).unwrap();
        assert!(meta.file_type().is_file());
    }

    #[test]
    fn refuses_an_account_without_a_home_directory() {
        let missing = std::path::Path::new("/nonexistent/kaname-test-home");
        let (uid, gid) = me();
        let err = install_authorized_keys(missing, uid, gid, b"").unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err:?}");
    }

    #[test]
    fn an_unknown_account_is_not_found_by_name() {
        let err = lookup_account("kaname-no-such-user-e2e").err().unwrap();
        match err {
            ProviderError::NotFound(message) => assert!(message.contains("kaname-no-such-user-e2e")),
            other => panic!("expected not_found, got {other:?}"),
        }
        assert_eq!(lookup_account("root").ok().unwrap().uid, 0);
    }
}
