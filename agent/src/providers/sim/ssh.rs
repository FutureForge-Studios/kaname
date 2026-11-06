//! SSH keys, sshd configuration and sessions.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use super::files::uid_for;
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
    b.push_str(&format!("PubkeyAuthentication {}\n", yes_no(config.pubkey_authentication)));
    b.push_str(&format!("PasswordAuthentication {}\n", yes_no(config.password_authentication)));
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
        let mut keys = Vec::with_capacity(p.keys.len());
        let mut authorized = String::new();

        for key in &p.keys {
            let fields: Vec<&str> = key.public_key.split_whitespace().collect();
            if fields.len() < 2 {
                return Err(ProviderError::invalid(format!("public key for {} is malformed", p.user)));
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

        let home = if p.user == "root" { "/root".to_string() } else { format!("/home/{}", p.user) };
        let mut fs = self.0.fs.write();
        fs.dir_as(&format!("{home}/.ssh"), "0700", &p.user, uid_for(&p.user));
        fs.file_as(&format!("{home}/.ssh/authorized_keys"), &authorized, "0600", &p.user, uid_for(&p.user));
        Ok(count)
    }

    async fn read_config(&self, _ctx: &Ctx) -> PResult<SshConfigInfo> {
        Ok(self.0.world.lock().ssh_config.clone())
    }

    async fn apply_config(&self, _ctx: &Ctx, p: SshConfigApplyParams) -> PResult<SshConfigApplyResult> {
        let token = {
            let mut w = self.0.world.lock();
            let previous = RollbackWindow::Ssh { config: w.ssh_config.clone() };
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
            if !p.allow_users.is_empty() {
                next.allow_users = p.allow_users;
            }
            if !p.allow_groups.is_empty() {
                next.allow_groups = p.allow_groups;
            }
            if let Some(v) = p.x11_forwarding {
                next.x11_forwarding = v;
            }

            if p.rollback_seconds > 0 {
                let issued = format!("ssh-{:016x}", mix(self.0.seed ^ Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64));
                w.rollbacks.insert(issued.clone(), previous);
                Some(issued)
            } else {
                None
            }
        };

        write_sshd_config(&self.0);
        if let Some(token) = &token {
            schedule_rollback(&self.0, token.clone(), Duration::from_secs(p.rollback_seconds as u64));
        }
        Ok(SshConfigApplyResult { rollback_token: token })
    }

    async fn sessions(&self, _ctx: &Ctx) -> PResult<Vec<SshSessionInfo>> {
        Ok(self.0.world.lock().ssh_sessions.clone())
    }
}
