//! Simulated transfer accounts.
//!
//! Mirrors the Linux provider step for step against the fake filesystem,
//! so every job has an effect the panel (and e2e) can read back through
//! `fs.read`: the user lands in /etc/passwd and /etc/group, a salted hash
//! (never the password) in /etc/shadow, the sshd drop-in or the vsftpd
//! allowlist and per-user file appear, and the home is owned the way the
//! protocol needs. Quotas live in this struct, keyed by user, because the
//! fake host has no quota files to keep them in; the account result
//! reports them.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use rand::Rng;
use sha2::{Digest, Sha512};

use super::files::{MemFs, path_join, uid_for};
use super::state::Sim;
use crate::providers::ftp::{
    self, ACCOUNT_MARKER, FtpAccountInfo, FtpAccountParams, FtpPasswdParams, FtpUserParams, NOLOGIN_SHELL,
    SFTP_GROUP, SFTP_WRITABLE_DIR, SSHD_DROP_IN, SSHD_MAIN_CONFIG, VSFTPD_USER_DIR, VSFTPD_USER_LIST,
};
use crate::providers::{Ctx, PResult, ProviderError, cap};

const PASSWD: &str = "/etc/passwd";
const GROUP: &str = "/etc/group";
const SHADOW: &str = "/etc/shadow";
const MOUNTS: &str = "/proc/mounts";
const VSFTPD_CONF: &str = "/etc/vsftpd.conf";
const SFTP_GID: i64 = 990;

/// Which transfer daemons a simulated host runs. An edge proxy runs
/// neither, so the fleet always holds a host where `ftp.account.*` fails
/// at the gate; mail and database hosts carry sshd only, which makes FTPS
/// a clear `unsupported` there; everything else serves both.
pub fn transfer_capabilities(identity: &str) -> &'static [&'static str] {
    if identity.starts_with("edge-") {
        &[]
    } else if identity.starts_with("mail-") || identity.starts_with("db-") {
        &[cap::SFTP]
    } else {
        &[cap::SFTP, cap::VSFTPD]
    }
}

#[derive(Clone, Debug)]
struct Quota {
    mount: String,
    bytes: i64,
}

pub struct SimFtp {
    sim: Arc<Sim>,
    quotas: Mutex<HashMap<String, Quota>>,
}

impl SimFtp {
    pub fn new(sim: Arc<Sim>) -> SimFtp {
        SimFtp {
            sim,
            quotas: Mutex::new(HashMap::new()),
        }
    }

    fn require_protocol(&self, protocol: &str) -> PResult<()> {
        let needed = ftp::protocol_capability(protocol);
        if transfer_capabilities(&self.sim.identity).contains(&needed) {
            Ok(())
        } else {
            Err(ftp::protocol_unsupported(protocol))
        }
    }

    /// Create and update are one convergent apply: whatever state the user
    /// was in, it ends exactly as `p` describes. `password` is set on
    /// create and left alone on update.
    fn apply(&self, p: &FtpAccountParams, creating: bool) -> PResult<FtpAccountInfo> {
        self.require_protocol(&p.protocol)?;
        let user = p.username.as_str();
        let mut fs = self.sim.fs.write();

        let existing = ftp::owned_account(&read(&fs, PASSWD), user)?;
        if !creating && existing.is_none() {
            return Err(ProviderError::not_found(format!("transfer account {user}")));
        }
        // Every refusal happens before the first write, so a create that
        // cannot be honoured leaves nothing half-made behind.
        let plan = ftp::quota_plan(&read(&fs, MOUNTS), &p.home_dir, p.quota_bytes, true)?;
        let uid = existing.as_ref().map_or_else(|| uid_for(user), |e| e.uid);
        if let Ok((node, _)) = fs.lookup(&p.home_dir, true) {
            if !node.is_dir() {
                return Err(ProviderError::conflict(format!(
                    "{} exists and is not a directory",
                    p.home_dir
                )));
            }
            ftp::check_home_owner(&p.home_dir, node.uid, Some(uid))?;
        }
        if p.protocol == "sftp" && !ftp::sshd_includes_drop_ins(&read(&fs, SSHD_MAIN_CONFIG)) {
            return Err(ProviderError::PreconditionFailed(format!(
                "{SSHD_MAIN_CONFIG} does not include {}; add `Include {}/*.conf` so the chroot applies",
                ftp::SSHD_DROP_IN_DIR,
                ftp::SSHD_DROP_IN_DIR
            )));
        }

        // The account database.
        let line = format!(
            "{user}:x:{uid}:{uid}:{ACCOUNT_MARKER}:{}:{NOLOGIN_SHELL}",
            p.home_dir
        );
        let passwd = upsert_record(&read(&fs, PASSWD), user, Some(&line));
        write(&mut fs, PASSWD, &passwd, "0644");
        let mut group = upsert_record(&read(&fs, GROUP), user, Some(&format!("{user}:x:{uid}:")));
        group = group_with_member(&group, SFTP_GROUP, SFTP_GID, user, p.protocol == "sftp");
        write(&mut fs, GROUP, &group, "0644");

        let shadow = read(&fs, SHADOW);
        let hash = if creating {
            hash_password(&p.password)
        } else {
            shadow_hash(&shadow, user)
                .map(unlocked)
                .unwrap_or_else(|| "!".to_string())
        };
        let record = shadow_record(user, &hash, p.suspended);
        write(
            &mut fs,
            SHADOW,
            &upsert_record(&shadow, user, Some(&record)),
            "0640",
        );

        // The home, owned the way the protocol needs it.
        if p.protocol == "sftp" {
            fs.dir_as(&p.home_dir, "0755", "root", 0);
            fs.dir_as(&path_join(&p.home_dir, SFTP_WRITABLE_DIR), "0750", user, uid);
            write(&mut fs, SSHD_DROP_IN, &ftp::render_sshd_drop_in(), "0644");
        } else {
            fs.dir_as(&p.home_dir, "0750", user, uid);
            let conf = ftp::with_managed_block(&read(&fs, VSFTPD_CONF), &ftp::vsftpd_managed_block());
            write(&mut fs, VSFTPD_CONF, &conf, "0644");
        }

        // vsftpd: listed only while the account is FTPS and not suspended.
        let per_user = format!("{VSFTPD_USER_DIR}/{user}");
        let listed = p.protocol == "ftps" && !p.suspended;
        let list = ftp::user_list_with(&read(&fs, VSFTPD_USER_LIST), user, listed);
        if p.protocol == "ftps" {
            write(&mut fs, &per_user, &ftp::render_vsftpd_user(&p.home_dir), "0644");
            write(&mut fs, VSFTPD_USER_LIST, &list, "0644");
        } else {
            fs.detach(&per_user);
            if fs.lookup(VSFTPD_USER_LIST, false).is_ok() {
                write(&mut fs, VSFTPD_USER_LIST, &list, "0644");
            }
        }

        // An update without a key leaves an installed one alone: the
        // panel only ever sends a key when the operator gives one.
        if let Some(key) = p.ssh_public_key.as_deref() {
            let keys = path_join(&p.home_dir, ".ssh/authorized_keys");
            fs.dir_as(&path_join(&p.home_dir, ".ssh"), "0700", user, uid);
            fs.file_as(&keys, &format!("{}\n", key.trim()), "0600", user, uid);
        }
        drop(fs);

        let mut quotas = self.quotas.lock();
        match &plan {
            Some(mount) if p.quota_bytes > 0 => {
                quotas.insert(
                    user.to_string(),
                    Quota {
                        mount: mount.point.clone(),
                        bytes: ftp::quota_blocks(p.quota_bytes) * 1024,
                    },
                );
            }
            _ => {
                quotas.remove(user);
            }
        }
        let quota = quotas.get(user).cloned();
        Ok(FtpAccountInfo {
            username: user.to_string(),
            uid,
            home_dir: p.home_dir.clone(),
            protocol: p.protocol.clone(),
            suspended: p.suspended,
            quota: if quota.is_some() { "applied" } else { "unlimited" }.into(),
            quota_mount: quota.as_ref().map(|q| q.mount.clone()),
            quota_bytes: quota.map_or(0, |q| q.bytes),
        })
    }

    fn require_any_daemon(&self) -> PResult<()> {
        if transfer_capabilities(&self.sim.identity).is_empty() {
            Err(ProviderError::unsupported_because(
                "this host has no SFTP or FTPS daemon",
            ))
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl ftp::Ftp for SimFtp {
    async fn create(&self, _ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo> {
        ftp::check_password(&p.password)?;
        self.apply(&p, true)
    }

    async fn update(&self, _ctx: &Ctx, p: FtpAccountParams) -> PResult<FtpAccountInfo> {
        self.apply(&p, false)
    }

    async fn passwd(&self, _ctx: &Ctx, p: FtpPasswdParams) -> PResult<()> {
        self.require_any_daemon()?;
        // The same rules chpasswd's stdin line is built under on Linux.
        ftp::chpasswd_line(&p.username, &p.password)?;
        let mut fs = self.sim.fs.write();
        if ftp::owned_account(&read(&fs, PASSWD), &p.username)?.is_none() {
            return Err(ProviderError::not_found(format!(
                "transfer account {}",
                p.username
            )));
        }
        let shadow = read(&fs, SHADOW);
        let suspended = shadow_hash(&shadow, &p.username).is_some_and(|h| h.starts_with('!'));
        let record = shadow_record(&p.username, &hash_password(&p.password), suspended);
        write(
            &mut fs,
            SHADOW,
            &upsert_record(&shadow, &p.username, Some(&record)),
            "0640",
        );
        Ok(())
    }

    async fn delete(&self, _ctx: &Ctx, p: FtpUserParams) -> PResult<()> {
        self.require_any_daemon()?;
        let user = p.username.as_str();
        let mut fs = self.sim.fs.write();
        let Some(entry) = ftp::owned_account(&read(&fs, PASSWD), user)? else {
            return Err(ProviderError::not_found(format!("transfer account {user}")));
        };
        let passwd = upsert_record(&read(&fs, PASSWD), user, None);
        write(&mut fs, PASSWD, &passwd, "0644");
        let group = upsert_record(&read(&fs, GROUP), user, None);
        write(
            &mut fs,
            GROUP,
            &group_with_member(&group, SFTP_GROUP, SFTP_GID, user, false),
            "0644",
        );
        let shadow = upsert_record(&read(&fs, SHADOW), user, None);
        write(&mut fs, SHADOW, &shadow, "0640");
        fs.detach(&format!("{VSFTPD_USER_DIR}/{user}"));
        if fs.lookup(VSFTPD_USER_LIST, false).is_ok() {
            let list = ftp::user_list_with(&read(&fs, VSFTPD_USER_LIST), user, false);
            write(&mut fs, VSFTPD_USER_LIST, &list, "0644");
        }
        // The home stays, as the panel promises; the key that opened it
        // does not, so a later account given the same home cannot inherit it.
        fs.detach(&path_join(&entry.home, ".ssh/authorized_keys"));
        drop(fs);
        self.quotas.lock().remove(user);
        Ok(())
    }
}

/* ------------------------------- helpers ----------------------------- */

fn read(fs: &MemFs, path: &str) -> String {
    fs.lookup(path, true)
        .map(|(n, _)| String::from_utf8_lossy(&n.data).into_owned())
        .unwrap_or_default()
}

fn write(fs: &mut MemFs, path: &str, content: &str, mode: &str) {
    fs.file_as(path, content, mode, "root", 0);
}

/// `text` with the colon-separated record named `name` replaced by `line`,
/// appended when absent, or removed when `line` is None.
pub fn upsert_record(text: &str, name: &str, line: Option<&str>) -> String {
    let prefix = format!("{name}:");
    let mut out: Vec<String> = Vec::new();
    let mut placed = false;
    for existing in text.lines() {
        if existing.starts_with(&prefix) {
            if let (Some(line), false) = (line, placed) {
                out.push(line.to_string());
                placed = true;
            }
            continue;
        }
        out.push(existing.to_string());
    }
    if let (Some(line), false) = (line, placed) {
        out.push(line.to_string());
    }
    let mut joined = out.join("\n");
    if !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

/// /etc/group with `user` added to or dropped from `group`'s member list,
/// creating the group (as `groupadd --system` would) when it is missing.
pub fn group_with_member(text: &str, group: &str, gid: i64, user: &str, present: bool) -> String {
    let prefix = format!("{group}:");
    let current = text.lines().find(|l| l.starts_with(&prefix));
    let line = match current {
        Some(line) => line.to_string(),
        None if present => format!("{group}:x:{gid}:"),
        None => return text.to_string(),
    };
    let mut fields: Vec<String> = line.splitn(4, ':').map(String::from).collect();
    fields.resize(4, String::new());
    let mut members: Vec<String> = fields[3]
        .split(',')
        .filter(|m| !m.is_empty() && *m != user)
        .map(String::from)
        .collect();
    if present {
        members.push(user.to_string());
    }
    fields[3] = members.join(",");
    upsert_record(text, group, Some(&fields.join(":")))
}

/// A salted SHA-512 in crypt's `$6$salt$digest` shape. It is not
/// sha512-crypt (the fake host has no login to check it against), but it
/// is what matters here: a one-way value, different on every reset, with
/// the password itself nowhere on the host.
fn hash_password(password: &str) -> String {
    let salt: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();
    let mut h = Sha512::new();
    h.update(salt.as_bytes());
    h.update(password.as_bytes());
    format!("$6${salt}${}", hex::encode(h.finalize()))
}

fn shadow_hash(shadow: &str, user: &str) -> Option<String> {
    let prefix = format!("{user}:");
    shadow
        .lines()
        .find(|l| l.starts_with(&prefix))
        .and_then(|l| l.split(':').nth(1))
        .map(String::from)
}

fn unlocked(hash: String) -> String {
    hash.trim_start_matches('!').to_string()
}

/// `usermod --lock --expiredate 1` in shadow form: a `!` before the hash
/// refuses passwords, and an expiry in 1970 refuses keys too.
fn shadow_record(user: &str, hash: &str, suspended: bool) -> String {
    let days = chrono::Utc::now().timestamp() / 86_400;
    if suspended {
        format!("{user}:!{hash}:{days}:0:99999:7::1:")
    } else {
        format!("{user}:{hash}:{days}:0:99999:7:::")
    }
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_are_replaced_appended_and_removed() {
        let text = "root:x:0:0\nalice:x:1001:1001\n";
        assert_eq!(
            upsert_record(text, "bob", Some("bob:x:2")),
            "root:x:0:0\nalice:x:1001:1001\nbob:x:2\n"
        );
        assert_eq!(
            upsert_record(text, "alice", Some("alice:y")),
            "root:x:0:0\nalice:y\n"
        );
        assert_eq!(upsert_record(text, "alice", None), "root:x:0:0\n");
        // A prefix of another name is not that name.
        assert_eq!(upsert_record("alicea:x\n", "alice", None), "alicea:x\n");
    }

    #[test]
    fn group_membership_is_added_and_dropped() {
        let g = group_with_member("root:x:0:\n", SFTP_GROUP, 990, "a", true);
        assert_eq!(g, "root:x:0:\nkaname-sftp:x:990:a\n");
        let g = group_with_member(&g, SFTP_GROUP, 990, "b", true);
        assert_eq!(g, "root:x:0:\nkaname-sftp:x:990:a,b\n");
        let g = group_with_member(&g, SFTP_GROUP, 990, "a", false);
        assert_eq!(g, "root:x:0:\nkaname-sftp:x:990:b\n");
        assert_eq!(
            group_with_member("root:x:0:\n", SFTP_GROUP, 990, "a", false),
            "root:x:0:\n"
        );
    }

    #[test]
    fn a_hash_never_contains_the_password_and_changes_every_time() {
        let a = hash_password("correct-horse-battery-staple");
        let b = hash_password("correct-horse-battery-staple");
        assert!(a.starts_with("$6$"));
        assert!(!a.contains("correct-horse"));
        assert_ne!(a, b, "a salt makes every reset a new value");
        assert!(shadow_record("u", &a, true).starts_with("u:!$6$"));
        assert!(shadow_record("u", &a, true).ends_with(":1:"));
        assert_eq!(unlocked(format!("!{a}")), a);
    }

    fn host(name: &str) -> SimFtp {
        let dir = std::env::temp_dir()
            .join(format!("kaname-sim-ftp-{}", uuid::Uuid::new_v4().simple()))
            .join(name);
        SimFtp::new(Sim::new(crate::providers::Options {
            agent_version: "0.1.0".into(),
            state_dir: dir,
        }))
    }

    fn text(f: &SimFtp, path: &str) -> String {
        read(&f.sim.fs.read(), path)
    }

    fn account(user: &str, home: &str, protocol: &str) -> FtpAccountParams {
        FtpAccountParams {
            username: user.into(),
            home_dir: home.into(),
            protocol: protocol.into(),
            password: "first-password-0001".into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn an_account_is_a_real_user_with_a_hash_a_chroot_and_a_quota() {
        use ftp::Ftp;
        let f = host("forge-01");
        let ctx = Ctx::background();

        let mut p = account("ftp_one", "/srv/ftp/one", "sftp");
        p.quota_bytes = 1 << 30;
        let info = f.create(&ctx, p.clone()).await.unwrap();
        assert_eq!(info.quota, "applied");
        assert_eq!(info.quota_mount.as_deref(), Some("/srv"));
        assert_eq!(info.quota_bytes, 1 << 30);

        let passwd = text(&f, PASSWD);
        assert!(passwd.contains(&format!(
            "ftp_one:x:{}:{}:{ACCOUNT_MARKER}:/srv/ftp/one:{NOLOGIN_SHELL}\n",
            info.uid, info.uid
        )));
        assert!(text(&f, GROUP).contains("kaname-sftp:x:990:ftp_one\n"));
        let shadow = text(&f, SHADOW);
        assert!(shadow.contains("ftp_one:$6$"));
        assert!(
            !shadow.contains("first-password"),
            "the password itself never reaches the host's files"
        );
        assert!(text(&f, SSHD_DROP_IN).contains("ChrootDirectory %h"));
        {
            let fs = f.sim.fs.read();
            let (home, _) = fs.lookup("/srv/ftp/one", true).unwrap();
            assert_eq!(
                (home.owner.as_str(), home.mode.as_str()),
                ("root", "0755"),
                "sshd only chroots into a root-owned home"
            );
            let (files, _) = fs.lookup("/srv/ftp/one/files", true).unwrap();
            assert_eq!(files.owner, "ftp_one");
        }

        // A reset is a new hash, never the old one, never the text.
        f.passwd(
            &ctx,
            FtpPasswdParams {
                username: "ftp_one".into(),
                password: "second-password-002".into(),
            },
        )
        .await
        .unwrap();
        let after = text(&f, SHADOW);
        assert_ne!(shadow_hash(&after, "ftp_one"), shadow_hash(&shadow, "ftp_one"));
        assert!(!after.contains("second-password"));

        // Update moves it to FTPS, suspends it and lifts the quota.
        let mut u = account("ftp_one", "/srv/ftp/one", "ftps");
        u.password.clear();
        u.suspended = true;
        let info = f.update(&ctx, u.clone()).await.unwrap();
        assert_eq!(info.quota, "unlimited");
        assert!(!text(&f, GROUP).contains("kaname-sftp:x:990:ftp_one"));
        assert!(text(&f, "/etc/vsftpd/kaname.d/ftp_one").contains("local_root=/srv/ftp/one"));
        assert!(
            !text(&f, VSFTPD_USER_LIST).contains("ftp_one"),
            "a suspended account is not listed"
        );
        assert!(
            shadow_hash(&text(&f, SHADOW), "ftp_one")
                .unwrap()
                .starts_with('!')
        );
        u.suspended = false;
        f.update(&ctx, u).await.unwrap();
        assert!(text(&f, VSFTPD_USER_LIST).contains("ftp_one\n"));
        assert!(
            !shadow_hash(&text(&f, SHADOW), "ftp_one")
                .unwrap()
                .starts_with('!')
        );

        // Delete removes the user and its daemon config, keeps the home.
        f.delete(
            &ctx,
            FtpUserParams {
                username: "ftp_one".into(),
            },
        )
        .await
        .unwrap();
        assert!(!text(&f, PASSWD).contains("ftp_one:"));
        assert!(!text(&f, SHADOW).contains("ftp_one:"));
        assert!(!text(&f, VSFTPD_USER_LIST).contains("ftp_one"));
        assert!(f.sim.fs.read().lookup("/srv/ftp/one", true).is_ok());
        assert!(matches!(
            f.delete(
                &ctx,
                FtpUserParams {
                    username: "ftp_one".into()
                }
            )
            .await,
            Err(ProviderError::NotFound(_))
        ));
        f.sim.close().await;
    }

    #[tokio::test]
    async fn refusals_happen_before_anything_is_written() {
        use ftp::Ftp;
        let f = host("forge-01");
        let ctx = Ctx::background();
        let before = text(&f, PASSWD);

        // / has no user quotas in the simulated fstab.
        let mut p = account("ftp_two", "/home/ftp_two", "sftp");
        p.quota_bytes = 1 << 20;
        assert!(
            matches!(f.create(&ctx, p).await, Err(ProviderError::Unsupported(Some(m))) if m.contains("usrquota"))
        );
        // deploy is a real user: never adopted, never re-passworded.
        assert!(matches!(
            f.create(&ctx, account("deploy", "/home/deploy", "sftp")).await,
            Err(ProviderError::Conflict(_))
        ));
        assert!(matches!(
            f.passwd(
                &ctx,
                FtpPasswdParams {
                    username: "deploy".into(),
                    password: "x".repeat(20)
                }
            )
            .await,
            Err(ProviderError::Conflict(_))
        ));
        // /home/alice is alice's.
        assert!(matches!(
            f.create(&ctx, account("ftp_three", "/home/alice", "ftps")).await,
            Err(ProviderError::Conflict(_))
        ));
        assert_eq!(text(&f, PASSWD), before);
        f.sim.close().await;

        // A database host has sshd but no vsftpd; an edge host has neither.
        let db = host("db-01");
        assert!(matches!(
            db.create(&ctx, account("ftp_four", "/srv/four", "ftps")).await,
            Err(ProviderError::Unsupported(Some(m))) if m.contains("vsftpd")
        ));
        db.sim.close().await;
        let edge = host("edge-01");
        assert!(matches!(
            edge.passwd(
                &ctx,
                FtpPasswdParams {
                    username: "ftp_four".into(),
                    password: "y".repeat(20)
                }
            )
            .await,
            Err(ProviderError::Unsupported(_))
        ));
        edge.sim.close().await;
    }

    #[test]
    fn an_edge_host_runs_no_transfer_daemon() {
        assert!(transfer_capabilities("edge-01").is_empty());
        assert_eq!(transfer_capabilities("mail-01"), &[cap::SFTP]);
        assert_eq!(transfer_capabilities("forge-01"), &[cap::SFTP, cap::VSFTPD]);
    }
}
