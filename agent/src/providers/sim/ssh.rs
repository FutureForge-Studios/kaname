//! SSH keys, sshd configuration and sessions.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use super::files::{FsRef, path_join};
use super::firewall::{RollbackWindow, schedule_rollback};
use super::state::{Sim, hash_string, mix};
use crate::providers::{
    Ctx, PResult, ProviderError, Ssh, SshConfigApplyParams, SshConfigApplyResult, SshConfigInfo, SshKeyInfo,
    SshKeysApplyParams, SshKeysListParams, SshSessionInfo,
};

/// A stand-in for a real SHA-256 of the decoded blob: it is stable per key,
/// which is the only property a listing depends on.
pub fn fingerprint_of(blob: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut seed = hash_string(blob);
    let mut b = String::from("SHA256:");
    for _ in 0..43 {
        seed = mix(seed);
        b.push(ALPHABET[(seed % ALPHABET.len() as u64) as usize] as char);
    }
    b
}

fn yes_no(v: bool) -> &'static str {
    if v { "yes" } else { "no" }
}

pub fn write_sshd_config(sim: &Sim) {
    let config = sim.world.lock().ssh_config.clone();

    let mut b = String::from("Include /etc/ssh/sshd_config.d/*.conf\n\n");
    b.push_str(&format!("Port {}\n", config.port));
    b.push_str("AddressFamily any\nListenAddress 0.0.0.0\n\n");
    b.push_str(&format!("PermitRootLogin {}\n", config.permit_root_login));
    b.push_str(&format!(
        "PubkeyAuthentication {}\n",
        yes_no(config.pubkey_authentication)
    ));
    b.push_str(&format!(
        "PasswordAuthentication {}\n",
        yes_no(config.password_authentication)
    ));
    b.push_str("KbdInteractiveAuthentication no\n");
    b.push_str(&format!("MaxAuthTries {}\n", config.max_auth_tries));
    if !config.allow_users.is_empty() {
        b.push_str(&format!("AllowUsers {}\n", config.allow_users.join(" ")));
    }
    if !config.allow_groups.is_empty() {
        b.push_str(&format!("AllowGroups {}\n", config.allow_groups.join(" ")));
    }
    b.push_str("\nUsePAM yes\n");
    b.push_str(&format!("X11Forwarding {}\n", yes_no(config.x11_forwarding)));
    b.push_str("PrintMotd no\nClientAliveInterval 300\nClientAliveCountMax 2\n\nAcceptEnv LANG LC_*\nSubsystem sftp /usr/lib/openssh/sftp-server\n");

    sim.fs.write().file("/etc/ssh/sshd_config", &b);
}

/// A POSIX account as the simulated host's /etc/passwd describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimAccount {
    pub name: String,
    pub uid: i64,
    pub gid: i64,
    pub home: String,
}

/// Reads one account out of passwd text, the way getpwnam would.
pub fn passwd_account(passwd: &str, name: &str) -> Option<SimAccount> {
    passwd.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 || fields[0] != name {
            return None;
        }
        Some(SimAccount {
            name: fields[0].to_string(),
            uid: fields[2].parse().ok()?,
            gid: fields[3].parse().ok()?,
            home: fields[5].to_string(),
        })
    })
}

/// Looks the account up in the simulated /etc/passwd, so the sim refuses
/// a key for an account the host does not have, exactly as the Linux
/// provider does, instead of conjuring a home directory for it.
fn lookup_account(fs: &FsRef, user: &str) -> PResult<SimAccount> {
    let fs = fs.read();
    let passwd = fs
        .lookup("/etc/passwd", true)
        .map(|(node, _)| String::from_utf8_lossy(&node.data).into_owned())
        .unwrap_or_default();
    let account = passwd_account(&passwd, user)
        .ok_or_else(|| ProviderError::not_found(format!("no POSIX account named {user} on this host")))?;
    match fs.lookup(&account.home, false) {
        Ok((node, _)) if node.is_dir() => Ok(account),
        _ => Err(ProviderError::PreconditionFailed(format!(
            "{user} has no home directory at {}",
            account.home
        ))),
    }
}

pub struct SimSsh(pub Arc<Sim>);

#[async_trait]
impl Ssh for SimSsh {
    async fn list_keys(&self, _ctx: &Ctx, p: SshKeysListParams) -> PResult<Vec<SshKeyInfo>> {
        let filter = p.user.filter(|u| !u.is_empty());
        let w = self.0.world.lock();
        let mut out: Vec<SshKeyInfo> = w
            .ssh_keys
            .iter()
            .filter(|(user, _)| filter.as_deref().is_none_or(|f| f == user.as_str()))
            .flat_map(|(_, keys)| keys.iter().cloned())
            .collect();
        out.sort_by(|a, b| a.user.cmp(&b.user).then(a.comment.cmp(&b.comment)));
        Ok(out)
    }

    async fn apply_keys(&self, _ctx: &Ctx, p: SshKeysApplyParams) -> PResult<i64> {
        // Before anything is recorded: a key for a user the host lacks is a
        // failed job, not a file in a home directory nobody owns.
        let account = lookup_account(&self.0.fs, &p.user)?;
        let mut keys = Vec::with_capacity(p.keys.len());
        let mut authorized = String::new();

        for key in &p.keys {
            let fields: Vec<&str> = key.public_key.split_whitespace().collect();
            if fields.len() < 2 {
                return Err(ProviderError::invalid(format!(
                    "public key for {} is malformed",
                    p.user
                )));
            }
            keys.push(SshKeyInfo {
                fingerprint: fingerprint_of(fields[1]),
                r#type: fields[0].into(),
                comment: key.comment.clone(),
                public_key: key.public_key.clone(),
                user: p.user.clone(),
            });
            authorized.push_str(&key.public_key);
            if !key.comment.is_empty() && !key.public_key.ends_with(&key.comment) {
                authorized.push(' ');
                authorized.push_str(&key.comment);
            }
            authorized.push('\n');
        }

        let count = keys.len() as i64;
        self.0.world.lock().ssh_keys.insert(p.user.clone(), keys);

        // ~user/.ssh at 0700 and authorized_keys at 0600, both owned by the
        // account: sshd's StrictModes refuses anything looser.
        let ssh_dir = path_join(&account.home, ".ssh");
        let mut fs = self.0.fs.write();
        fs.dir_as(&ssh_dir, "0700", &account.name, account.uid);
        fs.file_as(
            &path_join(&ssh_dir, "authorized_keys"),
            &authorized,
            "0600",
            &account.name,
            account.uid,
        );
        Ok(count)
    }

    async fn read_config(&self, _ctx: &Ctx) -> PResult<SshConfigInfo> {
        Ok(self.0.world.lock().ssh_config.clone())
    }

    async fn apply_config(&self, _ctx: &Ctx, p: SshConfigApplyParams) -> PResult<SshConfigApplyResult> {
        let token = {
            let mut w = self.0.world.lock();
            let previous = RollbackWindow::Ssh {
                config: w.ssh_config.clone(),
            };
            let next = &mut w.ssh_config;
            if let Some(port) = p.port {
                next.port = port;
            }
            if let Some(v) = p.permit_root_login {
                next.permit_root_login = v;
            }
            if let Some(v) = p.password_authentication {
                next.password_authentication = v;
            }
            if let Some(v) = p.pubkey_authentication {
                next.pubkey_authentication = v;
            }
            if let Some(v) = p.max_auth_tries {
                next.max_auth_tries = v;
            }
            // An omitted list leaves the directive alone; an empty one clears
            // it, as on Linux. Treating empty as "unchanged" meant clearing
            // AllowUsers in the panel did nothing on a simulated host.
            if let Some(users) = p.allow_users {
                next.allow_users = users;
            }
            if let Some(groups) = p.allow_groups {
                next.allow_groups = groups;
            }
            if let Some(v) = p.x11_forwarding {
                next.x11_forwarding = v;
            }

            if p.rollback_seconds > 0 {
                let issued = format!(
                    "ssh-{:016x}",
                    mix(self.0.seed ^ Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64)
                );
                w.rollbacks.insert(issued.clone(), previous);
                Some(issued)
            } else {
                None
            }
        };

        write_sshd_config(&self.0);
        if let Some(token) = &token {
            schedule_rollback(
                &self.0,
                token.clone(),
                Duration::from_secs(p.rollback_seconds as u64),
            );
        }
        Ok(SshConfigApplyResult {
            rollback_token: token,
        })
    }

    async fn sessions(&self, _ctx: &Ctx) -> PResult<Vec<SshSessionInfo>> {
        Ok(self.0.world.lock().ssh_sessions.clone())
    }
}

#[cfg(test)]
mod tests {
    use crate::providers::{
        Ctx, FsReadParams, Options, ProviderError, ProviderRef, SshAuthorizedKey, SshConfigApplyParams,
        SshKeysApplyParams,
    };

    use super::passwd_account;

    async fn sim() -> (ProviderRef, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let provider = super::super::open(Options {
            agent_version: "0.1.0".into(),
            state_dir: dir.path().to_path_buf(),
        })
        .await
        .expect("opening the simulator");
        (provider, dir)
    }

    async fn read(provider: &ProviderRef, path: &str) -> String {
        provider
            .files()
            .read(
                &Ctx::background(),
                FsReadParams {
                    path: path.into(),
                    max_bytes: 1 << 20,
                },
            )
            .await
            .unwrap()
            .content
    }

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtbVp8kR1oZ2mXs6aWq9QyU3nLd0vEcHfJ7tB4iY5Kp";

    #[test]
    fn passwd_lines_are_read_like_getpwnam() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\ndeploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash\n";
        let deploy = passwd_account(passwd, "deploy").unwrap();
        assert_eq!(
            (deploy.uid, deploy.gid, deploy.home.as_str()),
            (1000, 1000, "/home/deploy")
        );
        assert!(passwd_account(passwd, "dep").is_none());
        assert!(passwd_account("broken:x\n", "broken").is_none());
    }

    #[tokio::test]
    async fn keys_go_to_the_named_accounts_home_owned_by_it() {
        let (provider, _dir) = sim().await;
        let applied = provider
            .ssh()
            .apply_keys(
                &Ctx::background(),
                SshKeysApplyParams {
                    user: "alice".into(),
                    keys: vec![SshAuthorizedKey {
                        public_key: KEY.into(),
                        comment: "alice@laptop".into(),
                    }],
                },
            )
            .await
            .unwrap();
        assert_eq!(applied, 1);

        let content = read(&provider, "/home/alice/.ssh/authorized_keys").await;
        assert_eq!(content, format!("{KEY} alice@laptop\n"));
        let file = provider
            .files()
            .stat(&Ctx::background(), "/home/alice/.ssh/authorized_keys")
            .await
            .unwrap();
        assert_eq!(
            (file.owner.as_str(), file.uid, file.mode.as_str()),
            ("alice", 1001, "0600")
        );
        let dir = provider
            .files()
            .stat(&Ctx::background(), "/home/alice/.ssh")
            .await
            .unwrap();
        assert_eq!((dir.owner.as_str(), dir.mode.as_str()), ("alice", "0700"));

        // Root's own file is a different account's and is left alone.
        assert!(
            !read(&provider, "/root/.ssh/authorized_keys")
                .await
                .contains("alice@laptop")
        );
    }

    #[tokio::test]
    async fn an_account_the_host_does_not_have_is_refused_and_nothing_is_written() {
        let (provider, _dir) = sim().await;
        let err = provider
            .ssh()
            .apply_keys(
                &Ctx::background(),
                SshKeysApplyParams {
                    user: "mallory".into(),
                    keys: vec![SshAuthorizedKey {
                        public_key: KEY.into(),
                        comment: String::new(),
                    }],
                },
            )
            .await
            .unwrap_err();
        match err {
            ProviderError::NotFound(message) => assert!(message.contains("mallory"), "{message}"),
            other => panic!("expected not_found, got {other:?}"),
        }
        assert!(
            provider
                .files()
                .stat(&Ctx::background(), "/home/mallory")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_empty_allow_list_clears_the_directive_and_an_omitted_one_keeps_it() {
        let (provider, _dir) = sim().await;
        let ctx = Ctx::background();
        let before = provider.ssh().read_config(&ctx).await.unwrap();
        assert!(
            !before.allow_users.is_empty(),
            "the seeded host restricts AllowUsers"
        );

        // Omitted: untouched.
        provider
            .ssh()
            .apply_config(
                &ctx,
                SshConfigApplyParams {
                    max_auth_tries: Some(5),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let kept = provider.ssh().read_config(&ctx).await.unwrap();
        assert_eq!(kept.allow_users, before.allow_users);
        assert!(
            read(&provider, "/etc/ssh/sshd_config")
                .await
                .contains("AllowUsers ")
        );

        // Empty: cleared, in the reported config and in the file sshd reads.
        provider
            .ssh()
            .apply_config(
                &ctx,
                SshConfigApplyParams {
                    allow_users: Some(vec![]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let cleared = provider.ssh().read_config(&ctx).await.unwrap();
        assert!(cleared.allow_users.is_empty());
        assert_eq!(
            cleared.allow_groups, before.allow_groups,
            "only the named list is cleared"
        );
        let file = read(&provider, "/etc/ssh/sshd_config").await;
        assert!(!file.contains("AllowUsers"), "{file}");
        assert!(file.contains("MaxAuthTries 5"), "{file}");
    }
}
