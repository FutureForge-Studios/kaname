//! Transfer accounts (`ftp.account.*`).
//!
//! A transfer account is a real POSIX user. SFTP rides sshd: the user is
//! put in [`SFTP_GROUP`], whose `Match Group` drop-in forces
//! `internal-sftp` and chroots the session into the home directory. FTPS
//! rides vsftpd: the user is listed in a Kaname-owned allowlist and gets a
//! per-user config that pins `local_root` to the home directory.
//!
//! Everything in this module is platform independent: the trait, the
//! payloads, and the pure renderers and parsers that both the Linux
//! provider and the simulator use, so the two write byte-identical config
//! and the rules (which users Kaname may touch, how quota is sized, what
//! makes a filesystem quota-capable) are pinned by one set of tests.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::{Ctx, PResult, ProviderError};

/* ------------------------------- payloads ---------------------------- */

/// `ftp.account.create` and `ftp.account.update` share one shape; create
/// carries a password, update carries the suspension flag.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FtpAccountParams {
    pub username: String,
    pub home_dir: String,
    pub protocol: String,
    pub quota_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_public_key: Option<String>,
    /// Create only. Never logged, never echoed, handed to chpasswd on stdin.
    #[serde(skip_serializing)]
    pub password: String,
    /// Update only.
    pub suspended: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FtpPasswdParams {
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FtpUserParams {
    pub username: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FtpAccountInfo {
    pub username: String,
    pub uid: i64,
    pub home_dir: String,
    pub protocol: String,
    pub suspended: bool,
    /// "applied" or "unlimited".
    pub quota: String,
    pub quota_mount: Option<String>,
    pub quota_bytes: i64,
}

#[async_trait]
pub trait Ftp: Send + Sync {
    async fn create(&self, ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo>;
    async fn update(&self, ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo>;
    async fn passwd(&self, ctx: &Ctx, p: FtpPasswdParams) -> PResult<()>;
    async fn delete(&self, ctx: &Ctx, p: FtpUserParams) -> PResult<()>;
}

/// What a provider without transfer support serves: every verb refuses.
/// The registry gate normally stops the call first; this is the backstop
/// for a provider that has not wired the trait.
pub struct NoFtp;

#[async_trait]
impl Ftp for NoFtp {
    async fn create(&self, _: &Ctx, _: FtpAccountParams) -> PResult<FtpAccountInfo> {
        Err(no_daemon())
    }
    async fn update(&self, _: &Ctx, _: FtpAccountParams) -> PResult<FtpAccountInfo> {
        Err(no_daemon())
    }
    async fn passwd(&self, _: &Ctx, _: FtpPasswdParams) -> PResult<()> {
        Err(no_daemon())
    }
    async fn delete(&self, _: &Ctx, _: FtpUserParams) -> PResult<()> {
        Err(no_daemon())
    }
}

pub static NO_FTP: NoFtp = NoFtp;

fn no_daemon() -> ProviderError {
    ProviderError::unsupported_because("this host has no SFTP or FTPS daemon")
}

/* -------------------------------- layout ----------------------------- */

/// The GECOS field every Kaname transfer user carries. It is how the agent
/// tells its own accounts from the host's: an `ftp.account.*` call naming
/// `root` or `deploy` must never reset that user's password or delete it.
pub const ACCOUNT_MARKER: &str = "Kaname transfer account";
/// The group sshd's Match block confines to a chrooted internal-sftp.
pub const SFTP_GROUP: &str = "kaname-sftp";
/// A login shell that refuses interactive use; the Match block's
/// ForceCommand is what actually serves SFTP.
pub const NOLOGIN_SHELL: &str = "/usr/sbin/nologin";
/// The writable directory inside an SFTP chroot. sshd refuses to chroot
/// into a directory the user can write, so the home itself is root's and
/// the account's files live one level down.
pub const SFTP_WRITABLE_DIR: &str = "files";

pub const SSHD_MAIN_CONFIG: &str = "/etc/ssh/sshd_config";
pub const SSHD_DROP_IN_DIR: &str = "/etc/ssh/sshd_config.d";
pub const SSHD_DROP_IN: &str = "/etc/ssh/sshd_config.d/kaname-sftp.conf";

pub const VSFTPD_CONFIG_CANDIDATES: &[&str] = &["/etc/vsftpd.conf", "/etc/vsftpd/vsftpd.conf"];
pub const VSFTPD_USER_DIR: &str = "/etc/vsftpd/kaname.d";
pub const VSFTPD_USER_LIST: &str = "/etc/vsftpd/kaname.users";

const BLOCK_BEGIN: &str = "# BEGIN kaname (managed: transfer accounts)";
const BLOCK_END: &str = "# END kaname";

/// The sshd drop-in. Written once and identical for every account, so
/// adding a user never touches sshd's configuration again.
pub fn render_sshd_drop_in() -> String {
    format!(
        "# Managed by Kaname. Transfer accounts are members of {SFTP_GROUP}.\n\
         Match Group {SFTP_GROUP}\n\
         \tChrootDirectory %h\n\
         \tForceCommand internal-sftp -d /{SFTP_WRITABLE_DIR}\n\
         \tPasswordAuthentication yes\n\
         \tAllowTcpForwarding no\n\
         \tAllowAgentForwarding no\n\
         \tPermitTunnel no\n\
         \tX11Forwarding no\n\
         # Back to the global context, so a directive sshd reads after this\n\
         # file is never silently scoped to transfer accounts.\n\
         Match all\n"
    )
}

/// sshd only reads the drop-in if the main config includes the directory,
/// which Debian and Ubuntu do by default and older RHEL does not.
pub fn sshd_includes_drop_ins(main_config: &str) -> bool {
    main_config.lines().any(|line| {
        let mut words = line.split_whitespace();
        matches!(words.next(), Some(w) if w.eq_ignore_ascii_case("include"))
            && words.any(|w| w.starts_with(SSHD_DROP_IN_DIR))
    })
}

/// The keys Kaname needs vsftpd to honour, as one marked block so a
/// re-apply replaces rather than accumulates. vsftpd has no include
/// directive, which is why this is a block in its own config at all.
pub fn vsftpd_managed_block() -> String {
    format!(
        "{BLOCK_BEGIN}\n\
         local_enable=YES\n\
         write_enable=YES\n\
         chroot_local_user=YES\n\
         allow_writeable_chroot=YES\n\
         userlist_enable=YES\n\
         userlist_deny=NO\n\
         userlist_file={VSFTPD_USER_LIST}\n\
         user_config_dir={VSFTPD_USER_DIR}\n\
         ssl_enable=YES\n\
         force_local_logins_ssl=YES\n\
         force_local_data_ssl=YES\n\
         {BLOCK_END}\n"
    )
}

/// `config` with the managed block replaced, or appended when absent.
pub fn with_managed_block(config: &str, block: &str) -> String {
    if let (Some(start), Some(end)) = (config.find(BLOCK_BEGIN), config.find(BLOCK_END)) {
        if start < end {
            let after = end + BLOCK_END.len();
            let after = config[after..].strip_prefix('\n').map_or(after, |_| after + 1);
            return format!("{}{}{}", &config[..start], block, &config[after..]);
        }
    }
    let mut out = config.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(block);
    out
}

/// One vsftpd per-user file: the chroot and nothing else.
pub fn render_vsftpd_user(home_dir: &str) -> String {
    format!("# Managed by Kaname.\nlocal_root={home_dir}\n")
}

/// A user list with `user` present or absent, one name per line, sorted
/// so the file is stable across re-applies.
pub fn user_list_with(list: &str, user: &str, present: bool) -> String {
    let mut names: Vec<&str> = list
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && *l != user)
        .collect();
    if present {
        names.push(user);
    }
    names.sort_unstable();
    names.dedup();
    let mut out = names.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/* -------------------------------- passwd ----------------------------- */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswdEntry {
    pub name: String,
    pub uid: i64,
    pub gid: i64,
    pub gecos: String,
    pub home: String,
    pub shell: String,
}

pub fn parse_passwd(text: &str) -> Vec<PasswdEntry> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(':').collect();
            if f.len() < 7 {
                return None;
            }
            Some(PasswdEntry {
                name: f[0].to_string(),
                uid: f[2].parse().ok()?,
                gid: f[3].parse().ok()?,
                gecos: f[4].to_string(),
                home: f[5].to_string(),
                shell: f[6].to_string(),
            })
        })
        .collect()
}

pub fn find_user(passwd: &str, name: &str) -> Option<PasswdEntry> {
    parse_passwd(passwd).into_iter().find(|e| e.name == name)
}

/// Whether Kaname created this user. Uid 0 is refused whatever its GECOS
/// says, because a second root that happens to carry the marker is
/// exactly what an attacker would plant.
pub fn is_kaname_account(entry: &PasswdEntry) -> bool {
    entry.uid != 0 && entry.gecos == ACCOUNT_MARKER
}

/// Resolves `name` to a Kaname-owned account, or explains why it is not
/// one. `missing` decides what an absent user is: an error for passwd and
/// update, nothing for delete.
pub fn owned_account(passwd: &str, name: &str) -> PResult<Option<PasswdEntry>> {
    match find_user(passwd, name) {
        None => Ok(None),
        Some(entry) if is_kaname_account(&entry) => Ok(Some(entry)),
        Some(_) => Err(ProviderError::conflict(format!(
            "{name} is an existing user on this host that Kaname did not create; it will not be managed as a transfer account"
        ))),
    }
}

/// The one line chpasswd reads from stdin. Built here so the rules about
/// what may not be in it live next to the format.
pub fn chpasswd_line(user: &str, password: &str) -> PResult<Vec<u8>> {
    check_password(password)?;
    if user.contains(':') || user.contains('\n') {
        return Err(ProviderError::invalid("username contains an illegal character"));
    }
    Ok(format!("{user}:{password}\n").into_bytes())
}

pub fn check_password(password: &str) -> PResult<()> {
    if !(16..=256).contains(&password.chars().count()) {
        return Err(ProviderError::invalid(
            "password must be between 16 and 256 characters",
        ));
    }
    if password.contains(['\n', '\r', '\0']) {
        return Err(ProviderError::invalid(
            "password may not contain a line break or NUL",
        ));
    }
    Ok(())
}

/// One OpenSSH public key, on one line, of a type sshd accepts.
pub fn check_public_key(key: &str) -> PResult<()> {
    let key = key.trim();
    if key.contains(['\n', '\r', '\0']) {
        return Err(ProviderError::invalid("ssh_public_key must be a single line"));
    }
    let mut parts = key.split_whitespace();
    let (Some(kind), Some(body)) = (parts.next(), parts.next()) else {
        return Err(ProviderError::invalid(
            "ssh_public_key must look like `<type> <base64> [comment]`",
        ));
    };
    let known = [
        "ssh-rsa",
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
    ];
    if !known.contains(&kind) {
        return Err(ProviderError::invalid(format!(
            "{kind} is not an accepted key type"
        )));
    }
    if !body
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
    {
        return Err(ProviderError::invalid("ssh_public_key body is not base64"));
    }
    Ok(())
}

/* -------------------------------- quota ------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    pub point: String,
    pub fstype: String,
    pub options: String,
}

/// The mount `path` lives on, by longest mount-point prefix, from
/// `/proc/mounts` text.
pub fn mount_for(mounts: &str, path: &str) -> Option<Mount> {
    mounts
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 4 {
                return None;
            }
            Some(Mount {
                point: f[1].to_string(),
                fstype: f[2].to_string(),
                options: f[3].to_string(),
            })
        })
        .filter(|m| {
            m.point == "/"
                || path == m.point
                || path
                    .strip_prefix(m.point.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|m| m.point.len())
}

/// Whether a mount enforces per-user block limits: ext4's usrquota or
/// journalled usrjquota, xfs's uquota/usrquota, or the legacy `quota`.
/// xfs's `uqnoenforce` only accounts, so a limit there would be a lie.
pub fn quota_enabled(options: &str) -> bool {
    options
        .split(',')
        .any(|o| matches!(o, "usrquota" | "uquota" | "quota") || o.starts_with("usrjquota="))
}

/// Quota limits are set in 1 KiB blocks; round up so a limit is never
/// tighter than the operator asked for.
pub fn quota_blocks(bytes: i64) -> i64 {
    if bytes <= 0 { 0 } else { (bytes + 1023) / 1024 }
}

/// Decides where a limit goes, or why it cannot. `has_tool` is whether
/// setquota is installed. Asking for no limit always succeeds: there is
/// nothing to enforce.
pub fn quota_plan(mounts: &str, home: &str, quota_bytes: i64, has_tool: bool) -> PResult<Option<Mount>> {
    let mount = mount_for(mounts, home);
    if quota_bytes <= 0 {
        return Ok(mount.filter(|m| has_tool && quota_enabled(&m.options)));
    }
    if !has_tool {
        return Err(ProviderError::unsupported_because(
            "quota needs setquota (the quota package), which is not installed",
        ));
    }
    match mount {
        Some(m) if quota_enabled(&m.options) => Ok(Some(m)),
        Some(m) => Err(ProviderError::unsupported_because(format!(
            "{home} is on {} ({}, mounted {}), which is not mounted with usrquota; remount it with user quotas or set the quota to 0",
            m.point, m.fstype, m.options
        ))),
        None => Err(ProviderError::unsupported_because(format!(
            "no mount found for {home}"
        ))),
    }
}

/// System directories a transfer home may not be, nor sit inside. A home
/// is chowned (FTPS) or re-owned to root and chrooted into (SFTP), so
/// `/etc` as a home would hand the account the host's configuration.
const SYSTEM_TREES: &[&str] = &[
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/sys",
    "/usr",
    "/tmp",
    "/var/lib",
    "/var/log",
    "/var/cache",
    "/var/spool",
    "/var/run",
    "/var/lock",
    "/var/mail",
    "/var/tmp",
];

/// A home is at least two levels deep (`/home/x`, `/srv/ftp`), never a
/// system tree, and already cleaned by the path guard.
pub fn check_home(home: &str) -> PResult<()> {
    let depth = home.split('/').filter(|s| !s.is_empty()).count();
    if depth < 2 {
        return Err(ProviderError::invalid(format!(
            "{home} is too close to / to be a transfer home; use a directory such as /home/<user> or /srv/<name>"
        )));
    }
    if let Some(tree) = SYSTEM_TREES
        .iter()
        .find(|t| home == **t || home.strip_prefix(**t).is_some_and(|r| r.starts_with('/')))
    {
        return Err(ProviderError::PermissionDenied(format!(
            "{home} is inside {tree}, a system directory, and cannot be a transfer home"
        )));
    }
    Ok(())
}

/// An existing home may only be taken over when root or the account itself
/// owns it; anything else is someone's directory.
pub fn check_home_owner(home: &str, owner_uid: i64, account_uid: Option<i64>) -> PResult<()> {
    if owner_uid == 0 || Some(owner_uid) == account_uid {
        return Ok(());
    }
    Err(ProviderError::conflict(format!(
        "{home} already exists and belongs to uid {owner_uid}; pick a directory nobody else owns"
    )))
}

pub fn check_protocol(protocol: &str) -> PResult<()> {
    match protocol {
        "sftp" | "ftps" => Ok(()),
        _ => Err(ProviderError::invalid("protocol must be one of sftp, ftps")),
    }
}

/// The capability a protocol needs on this host, so a create for FTPS on
/// a host with only sshd says that, not "useradd failed".
pub fn protocol_capability(protocol: &str) -> &'static str {
    match protocol {
        "ftps" => super::cap::VSFTPD,
        _ => super::cap::SFTP,
    }
}

pub fn protocol_unsupported(protocol: &str) -> ProviderError {
    match protocol {
        "ftps" => {
            ProviderError::unsupported_because("FTPS needs vsftpd, which is not installed on this host")
        }
        _ => ProviderError::unsupported_because("SFTP needs sshd, which is not installed on this host"),
    }
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
        deploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash\n\
        ftp_a:x:2001:2001:Kaname transfer account:/home/ftp_a:/usr/sbin/nologin\n\
        evil:x:0:0:Kaname transfer account:/root:/bin/bash\n";

    #[test]
    fn only_users_kaname_created_are_managed() {
        // A transfer username that collides with a real user must never
        // reach chpasswd or userdel for that user.
        assert!(owned_account(PASSWD, "deploy").is_err());
        assert!(owned_account(PASSWD, "root").is_err());
        // uid 0 is refused even when it wears the marker.
        assert!(owned_account(PASSWD, "evil").is_err());
        assert_eq!(owned_account(PASSWD, "ftp_a").unwrap().unwrap().uid, 2001);
        assert_eq!(owned_account(PASSWD, "nobody_here").unwrap(), None);
    }

    #[test]
    fn the_password_goes_to_chpasswd_as_one_line_and_cannot_inject_another() {
        assert_eq!(
            chpasswd_line("ftp_a", "correct-horse-battery").unwrap(),
            b"ftp_a:correct-horse-battery\n".to_vec()
        );
        // Colons are fine: chpasswd splits on the first one only.
        assert!(chpasswd_line("ftp_a", "a:b:c:d:e:f:g:h:i:j").is_ok());
        assert!(chpasswd_line("ftp_a", "sixteen-chars-ok\nroot:pwned-pwned").is_err());
        assert!(chpasswd_line("ftp_a", "sixteen-chars-ok\r").is_err());
        assert!(chpasswd_line("ftp_a", "short").is_err());
    }

    #[test]
    fn the_sshd_drop_in_chroots_and_forces_internal_sftp() {
        let conf = render_sshd_drop_in();
        assert!(conf.contains("Match Group kaname-sftp\n"));
        assert!(conf.contains("\tChrootDirectory %h\n"));
        assert!(conf.contains("\tForceCommand internal-sftp -d /files\n"));
        assert!(conf.contains("\tAllowTcpForwarding no\n"));
        assert!(conf.ends_with("Match all\n"), "the block must be closed: {conf}");
        assert!(sshd_includes_drop_ins(
            "Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n"
        ));
        assert!(sshd_includes_drop_ins(
            "  include   /etc/ssh/sshd_config.d/*.conf\n"
        ));
        assert!(!sshd_includes_drop_ins(
            "Port 22\n#Include /etc/ssh/sshd_config.d/*.conf\n"
        ));
    }

    #[test]
    fn the_vsftpd_block_is_replaced_not_accumulated() {
        let base = "listen=YES\nanonymous_enable=NO";
        let once = with_managed_block(base, &vsftpd_managed_block());
        assert!(once.starts_with("listen=YES\nanonymous_enable=NO\n# BEGIN kaname"));
        assert!(once.contains("userlist_deny=NO\n"));
        assert!(once.contains("user_config_dir=/etc/vsftpd/kaname.d\n"));
        let twice = with_managed_block(&once, &vsftpd_managed_block());
        assert_eq!(once, twice);
        assert_eq!(twice.matches("# BEGIN kaname").count(), 1);
        let trailing = format!("{once}pasv_enable=YES\n");
        let again = with_managed_block(&trailing, &vsftpd_managed_block());
        assert_eq!(again, trailing);
        assert_eq!(
            render_vsftpd_user("/srv/ftp/a"),
            "# Managed by Kaname.\nlocal_root=/srv/ftp/a\n"
        );
    }

    #[test]
    fn the_user_list_is_sorted_and_deduplicated() {
        let list = user_list_with("", "b", true);
        let list = user_list_with(&list, "a", true);
        let list = user_list_with(&list, "a", true);
        assert_eq!(list, "a\nb\n");
        assert_eq!(user_list_with(&list, "a", false), "b\n");
        assert_eq!(user_list_with("b\n", "b", false), "");
    }

    const MOUNTS: &str = "/dev/vda1 / ext4 rw,relatime 0 0\n\
        /dev/vdb1 /srv xfs rw,noatime,usrquota 0 0\n\
        /dev/vdc1 /srv/scratch ext4 rw,relatime 0 0\n\
        /dev/vdd1 /data ext4 rw,usrjquota=aquota.user,jqfmt=vfsv0 0 0\n";

    #[test]
    fn quota_is_applied_only_where_the_filesystem_enforces_it() {
        assert_eq!(mount_for(MOUNTS, "/srv/ftp/a").unwrap().point, "/srv");
        assert_eq!(mount_for(MOUNTS, "/srv/scratch/a").unwrap().point, "/srv/scratch");
        assert_eq!(mount_for(MOUNTS, "/srvx/a").unwrap().point, "/");
        assert_eq!(mount_for(MOUNTS, "/srv").unwrap().point, "/srv");

        assert_eq!(
            quota_plan(MOUNTS, "/srv/ftp/a", 1 << 30, true)
                .unwrap()
                .unwrap()
                .point,
            "/srv"
        );
        assert_eq!(
            quota_plan(MOUNTS, "/data/a", 1 << 30, true)
                .unwrap()
                .unwrap()
                .point,
            "/data"
        );

        // A limit on a filesystem without user quotas is refused, clearly,
        // before anything is created.
        let err = quota_plan(MOUNTS, "/home/a", 1 << 30, true).unwrap_err();
        assert!(
            matches!(err, ProviderError::Unsupported(Some(ref m)) if m.contains("usrquota")),
            "{err}"
        );
        let err = quota_plan(MOUNTS, "/srv/ftp/a", 1 << 30, false).unwrap_err();
        assert!(
            matches!(err, ProviderError::Unsupported(Some(ref m)) if m.contains("setquota")),
            "{err}"
        );

        // No limit asked for is never an error, and clears one where it can.
        assert_eq!(quota_plan(MOUNTS, "/home/a", 0, false).unwrap(), None);
        assert_eq!(
            quota_plan(MOUNTS, "/srv/a", 0, true).unwrap().unwrap().point,
            "/srv"
        );

        assert_eq!(quota_blocks(0), 0);
        assert_eq!(quota_blocks(1), 1);
        assert_eq!(quota_blocks(1024), 1);
        assert_eq!(quota_blocks(1025), 2);
        assert_eq!(quota_blocks(2 << 30), 2 << 20);
    }

    #[test]
    fn a_home_is_never_a_system_directory_or_someone_elses() {
        assert!(check_home("/home/ftp_a").is_ok());
        assert!(check_home("/srv/ftp/a").is_ok());
        assert!(check_home("/var/www/site").is_ok());
        assert!(check_home("/home").is_err());
        assert!(check_home("/etc/ssh").is_err());
        assert!(check_home("/root/x").is_err());
        assert!(check_home("/var/lib/kaname/agent").is_err());
        assert!(check_home("/usrx/a").is_ok());

        assert!(check_home_owner("/home/a", 0, None).is_ok());
        assert!(check_home_owner("/home/a", 2001, Some(2001)).is_ok());
        // /home/deploy belongs to deploy: an account must not take it.
        assert!(check_home_owner("/home/deploy", 1000, Some(2001)).is_err());
        assert!(check_home_owner("/home/deploy", 1000, None).is_err());
    }

    #[test]
    fn keys_are_one_line_of_a_known_type() {
        assert!(check_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== me@laptop").is_ok());
        assert!(check_public_key("ssh-dss AAAA").is_err());
        assert!(check_public_key("ssh-ed25519 AAAA\nssh-ed25519 BBBB").is_err());
        assert!(check_public_key("ssh-ed25519 not;base64").is_err());
        assert!(check_public_key("ssh-ed25519").is_err());
    }
}
