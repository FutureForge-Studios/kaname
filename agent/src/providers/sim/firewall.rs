//! Firewall and intrusion observations.
//!
//! The attackers are a fixed cast drawn from the documentation ranges (RFC
//! 5737), so a demo never points a finger at a real address. They keep
//! trying, their attempt counts accumulate, and once one crosses the jail
//! threshold it lands in the ban list on its own — which is the behaviour
//! the Security module exists to show.
//!
//! `fw.apply` and `ssh.config.apply` honour their rollback window for
//! real: forget to confirm and the previous rule set comes back, exactly
//! like the lockout guard on a live host.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::ssh;
use super::state::{Sim, mix, parse_stamp, pick, stamp};
use crate::providers::{
    BanEntry, Ctx, Firewall, FirewallRuleInfo, FirewallStatus, FwApplyParams, FwApplyResult, FwBanParams,
    FwConfirmParams, FwThreatsParams, FwUnbanParams, PResult, ProviderError, SshConfigInfo, SshKeyInfo,
    SshSessionInfo, ThreatObservation, topic,
};

/// Deliberately RFC 5737 documentation space. A simulated threat feed must
/// never name an address someone could go and block.
pub const THREAT_SOURCES: &[&str] = &[
    "203.0.113.7",
    "203.0.113.42",
    "203.0.113.88",
    "203.0.113.201",
    "203.0.113.240",
    "198.51.100.13",
    "198.51.100.66",
    "198.51.100.154",
    "198.51.100.219",
    "192.0.2.9",
    "192.0.2.77",
    "192.0.2.133",
];

/// Mirrors a fail2ban jail: enough failures in the window and the address
/// stops being an observation and becomes a ban.
pub const AUTO_BAN_THRESHOLD: i64 = 120;

/// A staged change that reverts itself unless confirmed.
#[derive(Clone, Debug)]
pub enum RollbackWindow {
    Firewall {
        rules: Vec<FirewallRuleInfo>,
        inbound: String,
        outbound: String,
    },
    Ssh {
        config: SshConfigInfo,
    },
}

pub fn build_security(sim: &Sim) {
    let now = Utc::now();
    let mut w = sim.world.lock();

    w.fw_enabled = true;
    w.fw_inbound = "deny".into();
    w.fw_outbound = "allow".into();
    w.rollbacks = HashMap::new();

    let seeds: &[(i64, &str, &str, &str, &str, &str)] = &[
        (10, "allow", "tcp", "22", "", "SSH"),
        (20, "allow", "tcp", "80", "", "HTTP"),
        (30, "allow", "tcp", "443", "", "HTTPS"),
        (40, "allow", "tcp", "25", "", "SMTP"),
        (45, "allow", "tcp", "465", "", "Submissions"),
        (50, "allow", "tcp", "587", "", "Submission"),
        (60, "allow", "tcp", "993", "", "IMAPS"),
        (70, "allow", "icmp", "", "", "ICMP echo"),
        (
            80,
            "allow",
            "tcp",
            "5432",
            "10.20.30.0/24",
            "PostgreSQL from the private network",
        ),
        (90, "deny", "tcp", "3306", "", "MariaDB is loopback only"),
    ];
    w.fw_rules = seeds
        .iter()
        .map(
            |(priority, action, protocol, ports, source, comment)| FirewallRuleInfo {
                id: format!("inet-filter-input-{priority}"),
                priority: *priority,
                action: action.to_string(),
                direction: "inbound".into(),
                protocol: protocol.to_string(),
                port_spec: if ports.is_empty() {
                    None
                } else {
                    Some(ports.to_string())
                },
                source: if source.is_empty() {
                    None
                } else {
                    Some(source.to_string())
                },
                destination: None,
                comment: Some(comment.to_string()),
                enabled: true,
                backend: "nftables".into(),
            },
        )
        .collect();

    w.bans = HashMap::new();
    w.threats = HashMap::new();
    for (i, ip) in THREAT_SOURCES.iter().enumerate() {
        let i = i as u64;
        let first = now - chrono::Duration::hours(2 + (mix(sim.seed ^ i ^ 0x91) % 70) as i64);
        let attempts = 6 + (mix(sim.seed ^ i ^ 0x92) % 240) as i64;
        let (kind, target) = match i % 5 {
            3 => ("web_bruteforce", "nginx:443/wp-login.php"),
            4 => ("mail_bruteforce", "stalwart:993"),
            _ => ("ssh_bruteforce", "sshd:22"),
        };

        w.threats.insert(
            ip.to_string(),
            ThreatObservation {
                kind: kind.into(),
                source_ip: ip.to_string(),
                target: target.into(),
                attempts,
                first_seen: stamp(first),
                last_seen: stamp(now - chrono::Duration::minutes((mix(sim.seed ^ i ^ 0x93) % 50) as i64)),
                sample: Some(threat_sample(kind, ip)),
            },
        );

        if attempts >= AUTO_BAN_THRESHOLD {
            let banned_at = now - chrono::Duration::minutes((mix(sim.seed ^ i ^ 0x94) % 180) as i64);
            w.bans.insert(
                ip.to_string(),
                BanEntry {
                    ip: ip.to_string(),
                    jail: jail_for(kind).into(),
                    banned_at: stamp(banned_at),
                    expires_at: Some(stamp(banned_at + chrono::Duration::hours(1))),
                    attempts,
                },
            );
        }
    }

    w.ssh_config = SshConfigInfo {
        port: 22,
        permit_root_login: "prohibit-password".into(),
        password_authentication: false,
        pubkey_authentication: true,
        max_auth_tries: 4,
        allow_users: vec!["root".into(), "deploy".into()],
        allow_groups: vec!["sudo".into()],
        x11_forwarding: false,
    };

    w.ssh_keys = HashMap::from([
        (
            "root".to_string(),
            vec![SshKeyInfo {
                fingerprint: "SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5oPqZrTvXyWkE".into(),
                r#type: "ssh-ed25519".into(),
                comment: "ops@kaname".into(),
                public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFq8xJ2vZ9nR0dTgY6mC1sL4pW7hB3eKuQaXrN5tOiVd ops@kaname".into(),
                user: "root".into(),
            }],
        ),
        (
            "deploy".to_string(),
            vec![
                SshKeyInfo {
                    fingerprint: "SHA256:a1Bc2DeFgH3iJkLmN4oPqRsT5uVwXyZ6AbCdEfGhIjK".into(),
                    r#type: "ssh-ed25519".into(),
                    comment: "deploy@workstation".into(),
                    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC7yQ4pXvR2mK9dLwB6nT1sZ0hEaJ3fUgMxOiPqV8rYd deploy@workstation".into(),
                    user: "deploy".into(),
                },
                SshKeyInfo {
                    fingerprint: "SHA256:z9Yx8Wv7Ut6Sr5Qp4On3Ml2Kj1Ih0Gf9Ed8Cb7Aa6Zy".into(),
                    r#type: "ssh-rsa".into(),
                    comment: "ci@build-runner".into(),
                    public_key: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC9mQ2xR4tYuI7oP0aSdFgHjKlZxCvBnM3qWeRtYuIoPaSdFgHjKlZxCvBnM ci@build-runner".into(),
                    user: "deploy".into(),
                },
            ],
        ),
    ]);

    w.ssh_sessions = vec![
        SshSessionInfo {
            user: "deploy".into(),
            from_ip: sim.id.private_ip.clone(),
            tty: "pts/0".into(),
            pid: 28194,
            started_at: stamp(now - chrono::Duration::minutes(94)),
            idle_seconds: 212,
        },
        SshSessionInfo {
            user: "root".into(),
            from_ip: "10.20.30.4".into(),
            tty: "pts/1".into(),
            pid: 28712,
            started_at: stamp(now - chrono::Duration::minutes(11)),
            idle_seconds: 8,
        },
    ];
}

pub fn jail_for(kind: &str) -> &'static str {
    match kind {
        "web_bruteforce" => "nginx-http-auth",
        "mail_bruteforce" => "stalwart-mail",
        _ => "sshd",
    }
}

fn threat_sample(kind: &str, ip: &str) -> String {
    match kind {
        "web_bruteforce" => format!("{ip} - - \"POST /wp-login.php HTTP/1.1\" 401 226"),
        "mail_bruteforce" => {
            format!("stalwart-mail: WARN Authentication failed (auth.failed) remoteIp = {ip}")
        }
        _ => format!("sshd: Failed password for invalid user admin from {ip} port 51234 ssh2"),
    }
}

/// Folds a new burst into the running observation and returns the delta.
/// The control plane adds attempts on conflict, so pushing the cumulative
/// figure would double-count every tick.
pub fn record_threat(sim: &Sim, ip: &str, burst: i64) -> ThreatObservation {
    let now = Utc::now();
    let mut w = sim.world.lock();

    let observation = w
        .threats
        .entry(ip.to_string())
        .or_insert_with(|| ThreatObservation {
            kind: "ssh_bruteforce".into(),
            source_ip: ip.to_string(),
            target: "sshd:22".into(),
            attempts: 0,
            first_seen: stamp(now),
            last_seen: stamp(now),
            sample: Some(threat_sample("ssh_bruteforce", ip)),
        });
    observation.attempts += burst;
    observation.last_seen = stamp(now);
    let mut delta = observation.clone();
    let (attempts, kind) = (observation.attempts, observation.kind.clone());

    if attempts >= AUTO_BAN_THRESHOLD && !w.bans.contains_key(ip) {
        w.bans.insert(
            ip.to_string(),
            BanEntry {
                ip: ip.to_string(),
                jail: jail_for(&kind).into(),
                banned_at: stamp(now),
                expires_at: Some(stamp(now + chrono::Duration::hours(1))),
                attempts,
            },
        );
    }

    delta.attempts = burst;
    delta
}

pub fn rotate_ssh_session(sim: &Sim, round: i64) {
    let now = Utc::now();
    let session = SshSessionInfo {
        user: pick(sim.seed, round, &["deploy", "root", "alice"]).into(),
        from_ip: pick(
            sim.seed ^ 0x3,
            round,
            &[sim.id.private_ip.as_str(), "10.20.30.4", "10.20.30.22"],
        )
        .into(),
        tty: format!("pts/{}", round % 4),
        pid: 29000 + (mix(sim.seed ^ round as u64) % 800) as i64,
        started_at: stamp(now),
        idle_seconds: 0,
    };

    {
        let mut w = sim.world.lock();
        if w.ssh_sessions.len() >= 3 {
            w.ssh_sessions.remove(0);
        }
        w.ssh_sessions.push(session.clone());
    }
    sim.emit(topic::SSH_SESSION, session);
}

/// The lockout guard: an unconfirmed rule set reverts itself, so a bad
/// `deny 22` costs a minute rather than the machine.
pub fn schedule_rollback(sim: &Arc<Sim>, token: String, after: Duration) {
    let sim = sim.clone();
    sim.clone().spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(after) => {}
            _ = sim.cancel.cancelled() => return,
        }

        let staged = {
            let mut w = sim.world.lock();
            let Some(staged) = w.rollbacks.remove(&token) else {
                return;
            };
            match &staged {
                RollbackWindow::Firewall {
                    rules,
                    inbound,
                    outbound,
                } => {
                    w.fw_rules = rules.clone();
                    w.fw_inbound = inbound.clone();
                    w.fw_outbound = outbound.clone();
                }
                RollbackWindow::Ssh { config } => w.ssh_config = config.clone(),
            }
            staged
        };

        match staged {
            RollbackWindow::Firewall { .. } => {
                tracing::warn!(
                    provider = "sim",
                    token,
                    kind = "firewall",
                    "rolled back an unconfirmed change"
                );
                write_nftables_config(&sim);
            }
            RollbackWindow::Ssh { .. } => {
                tracing::warn!(
                    provider = "sim",
                    token,
                    kind = "ssh",
                    "rolled back an unconfirmed change"
                );
                ssh::write_sshd_config(&sim);
            }
        }
    });
}

/// Keeps /etc/nftables.conf in step with the rule set, so reading the file
/// in the editor shows what `fw.list` reports.
pub fn write_nftables_config(sim: &Sim) {
    let (mut rules, inbound, outbound) = {
        let w = sim.world.lock();
        (w.fw_rules.clone(), w.fw_inbound.clone(), w.fw_outbound.clone())
    };
    rules.sort_by_key(|r| r.priority);

    let mut b = String::from("#!/usr/sbin/nft -f\nflush ruleset\n\ntable inet filter {\n");
    for (chain, direction, policy) in [("input", "inbound", &inbound), ("output", "outbound", &outbound)] {
        let policy = if policy == "deny" { "drop" } else { "accept" };
        b.push_str(&format!(
            "    chain {chain} {{\n        type filter hook {chain} priority 0; policy {policy};\n"
        ));
        if chain == "input" {
            b.push_str("        ct state established,related accept\n        iif \"lo\" accept\n");
        }
        for rule in &rules {
            if rule.direction != direction || !rule.enabled {
                continue;
            }
            b.push_str(&format!("        {}\n", nft_line(rule)));
        }
        b.push_str("    }\n\n");
    }
    b.push_str("}\n");

    sim.fs.write().file("/etc/nftables.conf", &b);
}

fn nft_line(rule: &FirewallRuleInfo) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(source) = rule.source.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("ip saddr {source}"));
    }
    if let Some(dest) = rule.destination.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!("ip daddr {dest}"));
    }
    match rule.protocol.as_str() {
        "icmp" => parts.push("ip protocol icmp".into()),
        "any" => {}
        proto => match rule.port_spec.as_deref().filter(|p| !p.is_empty()) {
            Some(ports) => parts.push(format!("{proto} dport {{ {ports} }}")),
            None => parts.push(format!("meta l4proto {proto}")),
        },
    }
    let verb = match rule.action.as_str() {
        "allow" => "accept",
        "deny" => "drop",
        "reject" => "reject",
        _ => "",
    };
    parts.push(verb.into());
    let mut line = parts.join(" ");
    if let Some(comment) = rule.comment.as_deref().filter(|c| !c.is_empty()) {
        line.push_str(&format!(" comment {comment:?}"));
    }
    line
}

/* ------------------------------ firewall ----------------------------- */

pub struct SimFirewall(pub Arc<Sim>);

#[async_trait]
impl Firewall for SimFirewall {
    async fn status(&self, _ctx: &Ctx) -> PResult<FirewallStatus> {
        let w = self.0.world.lock();
        Ok(FirewallStatus {
            backend: "nftables".into(),
            enabled: w.fw_enabled,
            default_inbound: w.fw_inbound.clone(),
            default_outbound: w.fw_outbound.clone(),
            rule_count: w.fw_rules.len() as i64,
        })
    }

    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        let mut out = self.0.world.lock().fw_rules.clone();
        out.sort_by_key(|r| r.priority);
        Ok(out)
    }

    async fn apply(&self, _ctx: &Ctx, p: FwApplyParams) -> PResult<FwApplyResult> {
        let rules: Vec<FirewallRuleInfo> = p
            .rules
            .iter()
            .map(|rule| FirewallRuleInfo {
                id: format!("inet-filter-{}-{}", rule.direction, rule.priority),
                priority: rule.priority,
                action: rule.action.clone(),
                direction: rule.direction.clone(),
                protocol: rule.protocol.clone(),
                port_spec: rule.port_spec.clone(),
                source: rule.source.clone(),
                destination: rule.destination.clone(),
                comment: rule.comment.clone(),
                enabled: true,
                backend: "nftables".into(),
            })
            .collect();

        let token = {
            let mut w = self.0.world.lock();
            let previous = RollbackWindow::Firewall {
                rules: std::mem::replace(&mut w.fw_rules, rules.clone()),
                inbound: std::mem::replace(&mut w.fw_inbound, p.default_inbound.clone()),
                outbound: std::mem::replace(&mut w.fw_outbound, p.default_outbound.clone()),
            };
            if p.rollback_seconds > 0 {
                let issued = format!(
                    "fw-{:016x}",
                    mix(self.0.seed ^ Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64)
                );
                w.rollbacks.insert(issued.clone(), previous);
                Some(issued)
            } else {
                None
            }
        };

        write_nftables_config(&self.0);
        if let Some(token) = &token {
            schedule_rollback(
                &self.0,
                token.clone(),
                Duration::from_secs(p.rollback_seconds as u64),
            );
        }
        Ok(FwApplyResult {
            applied: rules.len() as i64,
            rollback_token: token,
        })
    }

    async fn confirm(&self, _ctx: &Ctx, p: FwConfirmParams) -> PResult<()> {
        let mut w = self.0.world.lock();
        if w.rollbacks.remove(&p.rollback_token).is_none() {
            return Err(ProviderError::not_found(format!(
                "rollback token {} is unknown or already expired",
                p.rollback_token
            )));
        }
        Ok(())
    }

    async fn ban(&self, _ctx: &Ctx, p: FwBanParams) -> PResult<()> {
        let now = Utc::now();
        let mut w = self.0.world.lock();
        // The contract carries a single address, so a range is reported by
        // the address it starts at rather than by a string the panel
        // cannot parse.
        let address = p.target.split('/').next().unwrap_or_default().to_string();
        let mut entry = BanEntry {
            ip: address,
            jail: "manual".into(),
            banned_at: stamp(now),
            expires_at: None,
            attempts: 0,
        };
        if let Some(observation) = w.threats.get(&p.target) {
            entry.jail = jail_for(&observation.kind).into();
            entry.attempts = observation.attempts;
        }
        if p.duration_seconds > 0 {
            entry.expires_at = Some(stamp(now + chrono::Duration::seconds(p.duration_seconds)));
        }
        w.bans.insert(p.target, entry);
        Ok(())
    }

    async fn unban(&self, _ctx: &Ctx, p: FwUnbanParams) -> PResult<()> {
        let mut w = self.0.world.lock();
        if w.bans.remove(&p.target).is_none() {
            return Err(ProviderError::not_found(format!("{} is not banned", p.target)));
        }
        Ok(())
    }

    async fn bans(&self, _ctx: &Ctx) -> PResult<Vec<BanEntry>> {
        let now = Utc::now();
        let mut w = self.0.world.lock();
        w.bans.retain(|_, entry| {
            entry
                .expires_at
                .as_deref()
                .and_then(parse_stamp)
                .is_none_or(|expiry| expiry >= now)
        });
        let mut out: Vec<BanEntry> = w.bans.values().cloned().collect();
        out.sort_by(|a, b| b.banned_at.cmp(&a.banned_at));
        Ok(out)
    }

    async fn threats(&self, _ctx: &Ctx, p: FwThreatsParams) -> PResult<Vec<ThreatObservation>> {
        let since: Option<DateTime<Utc>> = match p.since.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => Some(
                parse_stamp(s).ok_or_else(|| ProviderError::invalid("since must be an RFC3339 timestamp"))?,
            ),
            None => None,
        };

        let w = self.0.world.lock();
        let mut out: Vec<ThreatObservation> = w
            .threats
            .values()
            .filter(|o| match since {
                Some(since) => parse_stamp(&o.last_seen).is_none_or(|last| last >= since),
                None => true,
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        if p.limit > 0 && out.len() as i64 > p.limit {
            out.truncate(p.limit as usize);
        }
        Ok(out)
    }
}
