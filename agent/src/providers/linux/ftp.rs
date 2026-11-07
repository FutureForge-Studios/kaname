//! Transfer accounts on a real host.
//!
//! Every change goes through the shadow-utils binaries (useradd, usermod,
//! userdel, groupadd, chpasswd) with an argv slice, so the host's own
//! locking of /etc/passwd and /etc/shadow is respected and nothing here
//! edits those files by hand. The password reaches chpasswd on stdin and
//! never sits in an argv, where any local user could read it from
//! /proc/<pid>/cmdline.
//!
//! The rules shared with the simulator (which users may be touched, what
//! a home may be, how quota is decided, what the daemon config says) live
//! in `providers::ftp` and are tested there; what is here is the order of
//! operations and the argv each step runs.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use super::exec::{self, ExecOptions};
use crate::providers::ftp::{
    self, ACCOUNT_MARKER, FtpAccountInfo, FtpAccountParams, FtpPasswdParams, FtpUserParams, NOLOGIN_SHELL,
    SFTP_GROUP, SFTP_WRITABLE_DIR, SSHD_DROP_IN, SSHD_DROP_IN_DIR, SSHD_MAIN_CONFIG,
    VSFTPD_CONFIG_CANDIDATES, VSFTPD_USER_DIR, VSFTPD_USER_LIST,
};
use crate::providers::{Ctx, PResult, ProviderError, cap};

pub struct FtpOps(pub Arc<Shared>);

fn tool(name: &str, args: &[&str]) -> ExecOptions {
    ExecOptions::new(name, args.iter().copied()).c_locale()
}

fn fs_error(path: &str, err: std::io::Error) -> ProviderError {
    match err.kind() {
        std::io::ErrorKind::NotFound => ProviderError::not_found(path.to_string()),
        std::io::ErrorKind::PermissionDenied => ProviderError::PermissionDenied(path.to_string()),
        _ => ProviderError::internal(format!("{path}: {err}")),
    }
}

fn read_text(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/* ------------------------------ argv builders ------------------------ */

/// `useradd` for a new transfer account: no home created by useradd (the
/// agent shapes it per protocol), a refusing shell, a private group, and
/// the marker that lets every later call prove the user is Kaname's.
pub fn useradd_args(user: &str, home: &str, sftp: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "--comment",
        ACCOUNT_MARKER,
        "--home-dir",
        home,
        "--no-create-home",
        "--shell",
        NOLOGIN_SHELL,
        "--user-group",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if sftp {
        args.push("--groups".into());
        args.push(SFTP_GROUP.into());
    }
    args.push(user.into());
    args
}

/// Re-points an existing account. `--groups` replaces the supplementary
/// list, which is how a switch to FTPS drops the SFTP group.
pub fn usermod_args(user: &str, home: &str, sftp: bool) -> Vec<String> {
    let groups = if sftp { SFTP_GROUP } else { "" };
    [
        "--comment",
        ACCOUNT_MARKER,
        "--home",
        home,
        "--shell",
        NOLOGIN_SHELL,
        "--groups",
        groups,
        user,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Locking the password alone would leave key logins working, so a
/// suspension also expires the account, which PAM refuses for every
/// method. Resuming clears both.
pub fn suspend_args(user: &str, suspended: bool) -> Vec<String> {
    if suspended {
        vec!["--lock".into(), "--expiredate".into(), "1".into(), user.into()]
    } else {
        vec![
            "--unlock".into(),
            "--expiredate".into(),
            String::new(),
            user.into(),
        ]
    }
}

/// `setquota -u <user> <soft> <hard> 0 0 <mount>`: block limits only, soft
/// equal to hard, inode limits untouched. Zero clears the limit.
pub fn setquota_args(user: &str, quota_bytes: i64, mount: &str) -> Vec<String> {
    let blocks = ftp::quota_blocks(quota_bytes).to_string();
    vec![
        "-u".into(),
        user.into(),
        blocks.clone(),
        blocks,
        "0".into(),
        "0".into(),
        mount.into(),
    ]
}

async fn run(ctx: &Ctx, name: &str, args: &[String]) -> PResult<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run_with(ctx, tool(name, &refs)).await
}

/* -------------------------------- steps ------------------------------ */

impl FtpOps {
    fn require_protocol(&self, protocol: &str) -> PResult<()> {
        if self.0.has(ftp::protocol_capability(protocol)) {
            Ok(())
        } else {
            Err(ftp::protocol_unsupported(protocol))
        }
    }

    fn quota_tool(&self) -> bool {
        exec::has_binary("setquota")
    }

    /// The sshd drop-in, written only when it differs, proven with
    /// `sshd -t` and rolled back if sshd refuses it, because a broken
    /// sshd config takes the operator's own way in with it.
    async fn ensure_sshd(&self, ctx: &Ctx) -> PResult<()> {
        if !ftp::sshd_includes_drop_ins(&read_text(SSHD_MAIN_CONFIG)) {
            return Err(ProviderError::PreconditionFailed(format!(
                "{SSHD_MAIN_CONFIG} does not include {SSHD_DROP_IN_DIR}; add `Include {SSHD_DROP_IN_DIR}/*.conf` so the SFTP chroot applies"
            )));
        }
        let wanted = ftp::render_sshd_drop_in();
        let previous = std::fs::read_to_string(SSHD_DROP_IN).ok();
        if previous.as_deref() == Some(wanted.as_str()) {
            return Ok(());
        }
        std::fs::create_dir_all(SSHD_DROP_IN_DIR).map_err(|e| fs_error(SSHD_DROP_IN_DIR, e))?;
        exec::write_atomic(Path::new(SSHD_DROP_IN), wanted.as_bytes(), 0o644)
            .map_err(|e| fs_error(SSHD_DROP_IN, e))?;
        let restore = || match &previous {
            Some(text) => {
                let _ = exec::write_atomic(Path::new(SSHD_DROP_IN), text.as_bytes(), 0o644);
            }
            None => {
                let _ = std::fs::remove_file(SSHD_DROP_IN);
            }
        };
        let sshd = exec::first_existing(&["/usr/sbin/sshd", "/usr/bin/sshd"]).unwrap_or("sshd");
        if let Err(err) = exec::run_combined(ctx, tool(sshd, &["-t"])).await {
            restore();
            return Err(err);
        }
        if self.0.has(cap::SYSTEMD) {
            let mut last = None;
            for unit in ["ssh", "sshd"] {
                match exec::run_with(ctx, tool("systemctl", &["reload", unit])).await {
                    Ok(_) => return Ok(()),
                    Err(e) => last = Some(e),
                }
            }
            restore();
            return Err(last.unwrap_or_else(|| ProviderError::internal("sshd could not be reloaded")));
        }
        Ok(())
    }

    async fn ensure_sftp_group(&self, ctx: &Ctx) -> PResult<()> {
        let present = read_text("/etc/group")
            .lines()
            .any(|l| l.starts_with(&format!("{SFTP_GROUP}:")));
        if !present {
            run(ctx, "groupadd", &["--system".into(), SFTP_GROUP.into()]).await?;
        }
        Ok(())
    }

    /// vsftpd's managed block. It reads its main config only at start, so
    /// a change restarts it; per-user files and the allowlist are read on
    /// every login and need nothing.
    async fn ensure_vsftpd(&self, ctx: &Ctx) -> PResult<()> {
        let path = exec::first_existing(VSFTPD_CONFIG_CANDIDATES).ok_or_else(|| {
            ProviderError::PreconditionFailed("vsftpd is installed but has no vsftpd.conf".into())
        })?;
        let current = read_text(path);
        let wanted = ftp::with_managed_block(&current, &ftp::vsftpd_managed_block());
        std::fs::create_dir_all(VSFTPD_USER_DIR).map_err(|e| fs_error(VSFTPD_USER_DIR, e))?;
        if wanted != current {
            exec::write_atomic(Path::new(path), wanted.as_bytes(), 0o644).map_err(|e| fs_error(path, e))?;
            if self.0.has(cap::SYSTEMD) {
                if let Err(err) = exec::run_with(ctx, tool("systemctl", &["restart", "vsftpd"])).await {
                    let _ = exec::write_atomic(Path::new(path), current.as_bytes(), 0o644);
                    return Err(err);
                }
            }
        }
        Ok(())
    }

    fn set_vsftpd_entry(&self, user: &str, home: Option<&str>, listed: bool) -> PResult<()> {
        let per_user = format!("{VSFTPD_USER_DIR}/{user}");
        match home {
            Some(home) => exec::write_atomic(
                Path::new(&per_user),
                ftp::render_vsftpd_user(home).as_bytes(),
                0o644,
            )
            .map_err(|e| fs_error(&per_user, e))?,
            None => {
                let _ = std::fs::remove_file(&per_user);
            }
        }
        let current = read_text(VSFTPD_USER_LIST);
        let wanted = ftp::user_list_with(&current, user, listed);
        if wanted != current && (listed || Path::new(VSFTPD_USER_LIST).exists()) {
            exec::write_atomic(Path::new(VSFTPD_USER_LIST), wanted.as_bytes(), 0o644)
                .map_err(|e| fs_error(VSFTPD_USER_LIST, e))?;
        }
        Ok(())
    }

    /// The home, shaped for the protocol: SFTP needs a root-owned chroot
    /// with a writable directory inside it; vsftpd's allow_writeable_chroot
    /// lets FTPS own its home outright.
    fn shape_home(&self, home: &str, uid: u32, gid: u32, sftp: bool) -> PResult<()> {
        std::fs::create_dir_all(home).map_err(|e| fs_error(home, e))?;
        let chown = |path: &str, uid: u32, gid: u32| {
            nix::unistd::chown(path, Some(uid.into()), Some(gid.into()))
                .map_err(|e| ProviderError::internal(format!("chown {path}: {e}")))
        };
        let chmod = |path: &str, mode: u32| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                .map_err(|e| fs_error(path, e))
        };
        if sftp {
            chown(home, 0, 0)?;
            chmod(home, 0o755)?;
            let inner = format!("{}/{SFTP_WRITABLE_DIR}", home.trim_end_matches('/'));
            std::fs::create_dir_all(&inner).map_err(|e| fs_error(&inner, e))?;
            chown(&inner, uid, gid)?;
            chmod(&inner, 0o750)?;
        } else {
            chown(home, uid, gid)?;
            chmod(home, 0o750)?;
        }
        Ok(())
    }

    fn install_key(&self, home: &str, uid: u32, gid: u32, key: &str) -> PResult<()> {
        let dir = format!("{}/.ssh", home.trim_end_matches('/'));
        let file = format!("{dir}/authorized_keys");
        std::fs::create_dir_all(&dir).map_err(|e| fs_error(&dir, e))?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| fs_error(&dir, e))?;
        exec::write_atomic(Path::new(&file), format!("{}\n", key.trim()).as_bytes(), 0o600)
            .map_err(|e| fs_error(&file, e))?;
        for path in [&dir, &file] {
            nix::unistd::chown(path.as_str(), Some(uid.into()), Some(gid.into()))
                .map_err(|e| ProviderError::internal(format!("chown {path}: {e}")))?;
        }
        Ok(())
    }

    async fn set_password(&self, ctx: &Ctx, user: &str, password: &str) -> PResult<()> {
        let line = ftp::chpasswd_line(user, password)?;
        exec::run_with(ctx, tool("chpasswd", &[]).stdin(line))
            .await
            .map(|_| ())
    }

    /// One convergent apply for create and update. Everything that can be
    /// refused is checked before the first change.
    async fn apply(&self, ctx: &Ctx, p: &FtpAccountParams, creating: bool) -> PResult<FtpAccountInfo> {
        self.require_protocol(&p.protocol)?;
        let user = p.username.as_str();
        let sftp = p.protocol == "sftp";

        let existing = ftp::owned_account(&read_text("/etc/passwd"), user)?;
        if !creating && existing.is_none() {
            return Err(ProviderError::not_found(format!("transfer account {user}")));
        }
        let plan = ftp::quota_plan(
            &read_text("/proc/mounts"),
            &p.home_dir,
            p.quota_bytes,
            self.quota_tool(),
        )?;
        if let Ok(meta) = std::fs::metadata(&p.home_dir) {
            if !meta.is_dir() {
                return Err(ProviderError::conflict(format!(
                    "{} exists and is not a directory",
                    p.home_dir
                )));
            }
            ftp::check_home_owner(&p.home_dir, meta.uid() as i64, existing.as_ref().map(|e| e.uid))?;
        }

        if sftp {
            self.ensure_sshd(ctx).await?;
            self.ensure_sftp_group(ctx).await?;
        } else {
            self.ensure_vsftpd(ctx).await?;
        }

        let fresh = existing.is_none();
        if fresh {
            run(ctx, "useradd", &useradd_args(user, &p.home_dir, sftp)).await?;
        } else {
            run(ctx, "usermod", &usermod_args(user, &p.home_dir, sftp)).await?;
        }

        // From here a failure on a brand-new user removes it again, so a
        // refused create never leaves a half-made login behind.
        let result = self
            .finish(ctx, p, creating, plan.as_ref().map(|m| m.point.clone()))
            .await;
        if result.is_err() && fresh {
            let _ = run(ctx, "userdel", &[user.to_string()]).await;
        }
        result
    }

    async fn finish(
        &self,
        ctx: &Ctx,
        p: &FtpAccountParams,
        creating: bool,
        quota_mount: Option<String>,
    ) -> PResult<FtpAccountInfo> {
        let user = p.username.as_str();
        let sftp = p.protocol == "sftp";
        let (uid, gid, _) = exec::credential(user)?;

        if creating {
            self.set_password(ctx, user, &p.password).await?;
        }
        run(ctx, "usermod", &suspend_args(user, p.suspended)).await?;
        self.shape_home(&p.home_dir, uid, gid, sftp)?;
        if let Some(key) = p.ssh_public_key.as_deref() {
            self.install_key(&p.home_dir, uid, gid, key)?;
        }
        if sftp {
            self.set_vsftpd_entry(user, None, false)?;
        } else {
            self.set_vsftpd_entry(user, Some(&p.home_dir), !p.suspended)?;
        }
        if let Some(mount) = &quota_mount {
            run(ctx, "setquota", &setquota_args(user, p.quota_bytes, mount)).await?;
        }

        let applied = p.quota_bytes > 0 && quota_mount.is_some();
        Ok(FtpAccountInfo {
            username: user.to_string(),
            uid: uid as i64,
            home_dir: p.home_dir.clone(),
            protocol: p.protocol.clone(),
            suspended: p.suspended,
            quota: if applied { "applied" } else { "unlimited" }.into(),
            quota_mount: if applied { quota_mount } else { None },
            quota_bytes: if applied {
                ftp::quota_blocks(p.quota_bytes) * 1024
            } else {
                0
            },
        })
    }
}

#[async_trait]
impl ftp::Ftp for FtpOps {
    async fn create(&self, ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo> {
        ftp::check_password(&p.password)?;
        self.apply(ctx, &p, true).await
    }

    async fn update(&self, ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo> {
        self.apply(ctx, &p, false).await
    }

    async fn passwd(&self, ctx: &Ctx, p: FtpPasswdParams) -> PResult<()> {
        if ftp::owned_account(&read_text("/etc/passwd"), &p.username)?.is_none() {
            return Err(ProviderError::not_found(format!(
                "transfer account {}",
                p.username
            )));
        }
        self.set_password(ctx, &p.username, &p.password).await
    }

    async fn delete(&self, ctx: &Ctx, p: FtpUserParams) -> PResult<()> {
        let user = p.username.as_str();
        let Some(entry) = ftp::owned_account(&read_text("/etc/passwd"), user)? else {
            return Err(ProviderError::not_found(format!("transfer account {user}")));
        };
        // A quota outlives its user (it is keyed by uid), so it is cleared
        // first or the next account handed that uid inherits it.
        if let Ok(Some(mount)) =
            ftp::quota_plan(&read_text("/proc/mounts"), &entry.home, 0, self.quota_tool())
        {
            let _ = run(ctx, "setquota", &setquota_args(user, 0, &mount.point)).await;
        }
        self.set_vsftpd_entry(user, None, false)?;
        let _ = std::fs::remove_file(format!(
            "{}/.ssh/authorized_keys",
            entry.home.trim_end_matches('/')
        ));
        // No --remove: the home and its files stay, as the panel promises.
        run(ctx, "userdel", &[user.to_string()]).await.map(|_| ())
    }
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn useradd_never_creates_a_shell_login_or_sees_the_password() {
        let args = useradd_args("ftp_a", "/srv/ftp/a", true);
        assert_eq!(
            args,
            [
                "--comment",
                ACCOUNT_MARKER,
                "--home-dir",
                "/srv/ftp/a",
                "--no-create-home",
                "--shell",
                "/usr/sbin/nologin",
                "--user-group",
                "--groups",
                "kaname-sftp",
                "ftp_a"
            ]
        );
        assert!(!useradd_args("ftp_a", "/srv/a", false).contains(&"--groups".to_string()));
        // No argv this module builds has a slot a password could go in.
        for argv in [
            useradd_args("u", "/h/u", true),
            usermod_args("u", "/h/u", false),
            suspend_args("u", true),
            setquota_args("u", 1, "/srv"),
        ] {
            assert!(!argv.iter().any(|a| a == "--password" || a == "-p"), "{argv:?}");
        }
    }

    #[test]
    fn switching_to_ftps_drops_the_sftp_group() {
        let args = usermod_args("u", "/h/u", false);
        let at = args.iter().position(|a| a == "--groups").unwrap();
        assert_eq!(args[at + 1], "");
        let args = usermod_args("u", "/h/u", true);
        let at = args.iter().position(|a| a == "--groups").unwrap();
        assert_eq!(args[at + 1], "kaname-sftp");
    }

    #[test]
    fn suspension_locks_and_expires_so_keys_stop_too() {
        assert_eq!(suspend_args("u", true), ["--lock", "--expiredate", "1", "u"]);
        assert_eq!(suspend_args("u", false), ["--unlock", "--expiredate", "", "u"]);
    }

    #[test]
    fn setquota_sets_block_limits_in_kib_and_leaves_inodes_alone() {
        assert_eq!(
            setquota_args("u", 1 << 30, "/srv"),
            ["-u", "u", "1048576", "1048576", "0", "0", "/srv"]
        );
        assert_eq!(
            setquota_args("u", 0, "/srv"),
            ["-u", "u", "0", "0", "0", "0", "/srv"]
        );
        assert_eq!(setquota_args("u", 1500, "/srv")[2], "2");
    }
}
