//! Firewall.
//!
//! nftables is preferred, iptables and ufw are the fallbacks, and the
//! backend is decided once by what is actually installed.
//!
//! The important part of this file is the rollback window. fw.apply
//! snapshots the live ruleset, installs the new one, and schedules a
//! revert. Only an fw.confirm carrying the matching token cancels it. An
//! operator who firewalls themselves out therefore gets their box back in
//! under a minute instead of needing console access — which is the single
//! most common way a panel bricks a remote server.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::common::{invalid, not_found, now_rfc3339, precondition, rfc3339, split_lines, unsupported};
use super::exec::{self, ExecOptions};
use super::Shared;
use crate::providers::*;

pub use render::*;

static IPV4_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b").unwrap());
static IPV6_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\b").unwrap());
static UFW_RULE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\[\s*(\d+)\]\s+(.*?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s*(.*)$").unwrap());

pub struct FirewallOps(pub Arc<Shared>);

/// `ExecOptions` for a firewall tool: argv only, C locale so the output
/// parses the same on every host.
fn tool(name: &str, args: &[&str]) -> ExecOptions {
    ExecOptions::new(name, args.iter().copied()).c_locale()
}

/// The context a scheduled revert runs under: nothing cancels it but its
/// own deadline, mirroring the 60-second budget the Go guard gave it.
fn revert_ctx() -> Ctx {
    Ctx::new(CancellationToken::new(), Some(Instant::now() + Duration::from_secs(60)))
}

impl FirewallOps {
    /// Picks the mechanism this host will be managed through. It is derived
    /// from what is installed rather than configured, because a backend that
    /// is not present cannot be made to work.
    fn backend(&self) -> PResult<&'static str> {
        if self.0.has(cap::NFTABLES) {
            Ok(cap::NFTABLES)
        } else if self.0.has(cap::IPTABLES) {
            Ok(cap::IPTABLES)
        } else if self.0.has(cap::UFW) {
            Ok(cap::UFW)
        } else {
            Err(unsupported("no firewall backend on this host"))
        }
    }
}

/* -------------------------------- status ------------------------------ */

#[async_trait]
impl Firewall for FirewallOps {
    async fn status(&self, ctx: &Ctx) -> PResult<FirewallStatus> {
        let backend = self.backend()?;

        let mut status = FirewallStatus {
            backend: backend.to_string(),
            enabled: false,
            default_inbound: "allow".into(),
            default_outbound: "allow".into(),
            rule_count: 0,
        };
        let rules = self.list(ctx).await?;
        status.rule_count = rules.len() as i64;

        match backend {
            cap::NFTABLES => {
                let Ok(out) = exec::run_with(ctx, tool("nft", &["list", "table", "inet", NFT_TABLE])).await else {
                    return Ok(status);
                };
                status.enabled = true;
                status.default_inbound = policy_from_nft(&out, "input").into();
                status.default_outbound = policy_from_nft(&out, "output").into();
            }
            cap::IPTABLES => {
                let out = exec::run_with(ctx, tool("iptables", &["-S"])).await?;
                status.enabled = true;
                for line in split_lines(&out) {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    if fields.len() != 3 || fields[0] != "-P" {
                        continue;
                    }
                    match fields[1] {
                        "INPUT" => status.default_inbound = policy_from_iptables(fields[2]).into(),
                        "OUTPUT" => status.default_outbound = policy_from_iptables(fields[2]).into(),
                        _ => {}
                    }
                }
            }
            _ => {
                let out = exec::run_with(ctx, tool("ufw", &["status", "verbose"])).await?;
                status.enabled = out.contains("Status: active");
                for line in split_lines(&out) {
                    if !line.starts_with("Default:") {
                        continue;
                    }
                    if line.contains("deny (incoming)") || line.contains("reject (incoming)") {
                        status.default_inbound = "deny".into();
                    }
                    if line.contains("deny (outgoing)") || line.contains("reject (outgoing)") {
                        status.default_outbound = "deny".into();
                    }
                }
            }
        }
        Ok(status)
    }

    /* --------------------------------- list ------------------------------- */

    async fn list(&self, ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        match self.backend()? {
            cap::NFTABLES => self.list_nft(ctx).await,
            cap::IPTABLES => self.list_iptables(ctx).await,
            _ => self.list_ufw(ctx).await,
        }
    }

    /* -------------------------------- apply ------------------------------- */

    async fn apply(&self, ctx: &Ctx, p: FwApplyParams) -> PResult<FwApplyResult> {
        let backend = self.backend()?;
        for rule in &p.rules {
            check_rule(rule)?;
        }

        // The snapshot is taken before anything changes, because it is the
        // only thing that can put the host back.
        let snapshot = Arc::new(self.snapshot(ctx, backend).await?);

        let outcome = match backend {
            cap::NFTABLES => self.apply_nft(ctx, &p).await,
            cap::IPTABLES => self.apply_iptables(ctx, &p).await,
            _ => self.apply_ufw(ctx, &p).await,
        };
        if let Err(err) = outcome {
            // A half-applied rule set is worse than the old one, so the
            // snapshot goes back immediately rather than after the window.
            if let Err(restore_err) = restore(ctx, &snapshot).await {
                tracing::error!(error = %restore_err, "could not restore the firewall after a failed apply");
            }
            return Err(err);
        }

        let revert_snapshot = snapshot.clone();
        let token = self
            .0
            .rollback
            .arm(
                "firewall",
                p.rollback_seconds,
                Box::new(move || {
                    let snapshot = revert_snapshot.clone();
                    Box::pin(async move { restore(&revert_ctx(), &snapshot).await })
                }),
            )
            .await?;
        Ok(FwApplyResult {
            applied: p.rules.len() as i64,
            rollback_token: token,
        })
    }

    async fn confirm(&self, _ctx: &Ctx, p: FwConfirmParams) -> PResult<()> {
        self.0.rollback.confirm(&p.rollback_token).await
    }

    /* --------------------------------- bans ------------------------------- */

    async fn ban(&self, ctx: &Ctx, p: FwBanParams) -> PResult<()> {
        let backend = self.backend()?;
        let (target, family) = parse_target(&p.target)?;

        match backend {
            cap::NFTABLES => {
                self.ensure_ban_table(ctx).await?;
                let mut element = target;
                if p.duration_seconds > 0 {
                    element.push_str(&format!(" timeout {}s", p.duration_seconds));
                }
                exec::run_with(
                    ctx,
                    tool(
                        "nft",
                        &["add", "element", "inet", NFT_BAN_TABLE, ban_set(family), &format!("{{ {element} }}")],
                    ),
                )
                .await?;
                Ok(())
            }
            cap::IPTABLES => {
                let binary = if family == "ip6" { "ip6tables" } else { "iptables" };
                exec::run_with(
                    ctx,
                    tool(
                        binary,
                        &["-I", "INPUT", "1", "-s", &target, "-m", "comment", "--comment", IPTABLES_BAN_COMMENT, "-j", "DROP"],
                    ),
                )
                .await?;
                Ok(())
            }
            _ => {
                exec::run_with(ctx, tool("ufw", &["insert", "1", "deny", "from", &target])).await?;
                Ok(())
            }
        }
    }

    async fn unban(&self, ctx: &Ctx, p: FwUnbanParams) -> PResult<()> {
        let backend = self.backend()?;
        let (target, family) = parse_target(&p.target)?;

        match backend {
            cap::NFTABLES => {
                exec::run_with(
                    ctx,
                    tool(
                        "nft",
                        &["delete", "element", "inet", NFT_BAN_TABLE, ban_set(family), &format!("{{ {target} }}")],
                    ),
                )
                .await?;
                Ok(())
            }
            cap::IPTABLES => {
                let binary = if family == "ip6" { "ip6tables" } else { "iptables" };
                exec::run_with(
                    ctx,
                    tool(
                        binary,
                        &["-D", "INPUT", "-s", &target, "-m", "comment", "--comment", IPTABLES_BAN_COMMENT, "-j", "DROP"],
                    ),
                )
                .await?;
                Ok(())
            }
            _ => {
                exec::run_with(ctx, tool("ufw", &["--force", "delete", "deny", "from", &target])).await?;
                Ok(())
            }
        }
    }

    async fn bans(&self, ctx: &Ctx) -> PResult<Vec<BanEntry>> {
        let mut bans = Vec::with_capacity(32);

        if self.0.has(cap::NFTABLES) {
            if let Ok(out) = exec::run_with(ctx, tool("nft", &["-j", "list", "table", "inet", NFT_BAN_TABLE])).await {
                bans.extend(parse_nft_bans(&out));
            }
        }
        if self.0.has(cap::FAIL2BAN) {
            bans.extend(self.fail2ban_bans(ctx).await);
        }

        bans.sort_by(|a, b| a.ip.cmp(&b.ip));
        Ok(bans)
    }

    /* -------------------------------- threats ----------------------------- */

    async fn threats(&self, ctx: &Ctx, p: FwThreatsParams) -> PResult<Vec<ThreatObservation>> {
        let records = self.auth_records(ctx, &p).await?;

        let mut seen: HashMap<String, Observation> = HashMap::new();
        for record in records {
            let Some((kind, target)) = classify_threat(&record.message) else { continue };
            let address = IPV4_PATTERN
                .find(&record.message)
                .or_else(|| IPV6_PATTERN.find(&record.message))
                .map(|m| m.as_str().to_string());
            let Some(address) = address else { continue };
            if address.parse::<std::net::IpAddr>().is_err() {
                continue;
            }

            let timestamp = DateTime::parse_from_rfc3339(&record.ts)
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let entry = seen.entry(format!("{address}{kind}")).or_insert_with(|| Observation {
                kind,
                target,
                address: address.clone(),
                attempts: 0,
                first_seen: timestamp,
                last_seen: timestamp,
                sample: record.message.clone(),
            });
            entry.attempts += 1;
            entry.last_seen = timestamp;
            if timestamp < entry.first_seen {
                entry.first_seen = timestamp;
            }
        }

        let mut observations: Vec<ThreatObservation> = seen
            .into_values()
            .map(|entry| ThreatObservation {
                kind: entry.kind.to_string(),
                source_ip: entry.address,
                target: entry.target.to_string(),
                attempts: entry.attempts,
                first_seen: rfc3339(entry.first_seen),
                last_seen: rfc3339(entry.last_seen),
                sample: Some(truncate_string(&entry.sample, 500)),
            })
            .collect();

        observations.sort_by(|a, b| b.attempts.cmp(&a.attempts).then_with(|| a.source_ip.cmp(&b.source_ip)));
        if p.limit > 0 && observations.len() > p.limit as usize {
            observations.truncate(p.limit as usize);
        }
        Ok(observations)
    }
}

/* --------------------------------- list ------------------------------- */

impl FirewallOps {
    async fn list_nft(&self, ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        let out = exec::run_with(ctx, tool("nft", &["-j", "list", "ruleset"])).await?;

        // The subset of `nft -j list ruleset` this agent reads.
        let parsed: Value =
            serde_json::from_str(&out).map_err(|e| ProviderError::internal(format!("decode nft ruleset: {e}")))?;

        let mut rules = Vec::with_capacity(32);
        let mut priority = 0;
        for node in parsed["nftables"].as_array().into_iter().flatten() {
            let Some(rule) = node.get("rule") else { continue };
            priority += 1;
            let table = rule["table"].as_str().unwrap_or_default();
            let chain = rule["chain"].as_str().unwrap_or_default();
            let handle = rule["handle"].as_i64().unwrap_or_default();
            let mut info = FirewallRuleInfo {
                id: format!("nft:{table}:{chain}:{handle}"),
                priority,
                action: "allow".into(),
                direction: direction_from_chain(chain).into(),
                protocol: "any".into(),
                enabled: true,
                backend: cap::NFTABLES.into(),
                ..Default::default()
            };
            if let Some(comment) = rule["comment"].as_str().filter(|c| !c.is_empty()) {
                info.comment = Some(comment.to_string());
            }
            if let Some(expressions) = rule["expr"].as_array() {
                describe_nft_expressions(expressions, &mut info);
            }
            rules.push(info);
        }
        Ok(rules)
    }

    async fn list_iptables(&self, ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        let out = exec::run_with(ctx, tool("iptables", &["-S"])).await?;

        let mut rules = Vec::with_capacity(32);
        let mut priority = 0;
        for line in split_lines(&out) {
            if !line.starts_with("-A ") {
                continue;
            }
            priority += 1;
            rules.push(parse_iptables_rule(line, priority));
        }
        Ok(rules)
    }

    async fn list_ufw(&self, ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        let out = exec::run_with(ctx, tool("ufw", &["status", "numbered"])).await?;

        let mut rules = Vec::with_capacity(32);
        for line in split_lines(&out) {
            let Some(m) = UFW_RULE.captures(line.trim()) else { continue };
            let priority: i64 = m[1].parse().unwrap_or_default();

            let mut rule = FirewallRuleInfo {
                id: format!("ufw:{}", &m[1]),
                priority,
                action: action_from_target(&m[3]).into(),
                direction: "inbound".into(),
                protocol: "any".into(),
                enabled: true,
                backend: cap::UFW.into(),
                ..Default::default()
            };
            if &m[4] == "OUT" {
                rule.direction = "outbound".into();
            }
            let (port, protocol) = split_ufw_target(&m[2]);
            if !port.is_empty() {
                rule.port_spec = Some(port.to_string());
            }
            if !protocol.is_empty() {
                rule.protocol = protocol.to_string();
            }
            let source = m[5].trim();
            if !source.is_empty() && source != "Anywhere" {
                rule.source = Some(source.to_string());
            }
            rules.push(rule);
        }
        Ok(rules)
    }
}

/// Reduces one rule's expression list to the flat shape the panel renders.
/// Anything it does not recognise is left at its default rather than
/// guessed at.
fn describe_nft_expressions(expressions: &[Value], rule: &mut FirewallRuleInfo) {
    for raw in expressions {
        let Some(node) = raw.as_object() else { continue };
        for (key, value) in node {
            match key.as_str() {
                "accept" => rule.action = "allow".into(),
                "drop" => rule.action = "deny".into(),
                "reject" => rule.action = "reject".into(),
                "match" => describe_nft_match(value, rule),
                _ => {}
            }
        }
    }
}

fn describe_nft_match(m: &Value, rule: &mut FirewallRuleInfo) {
    let value = render_nft_value(&m["right"]);
    let left = &m["left"];

    if left["meta"]["key"].as_str() == Some("l4proto") {
        rule.protocol = normalize_firewall_protocol(&value).into();
        return;
    }
    let Some(payload) = left.get("payload").filter(|p| p.is_object()) else { return };
    match payload["field"].as_str().unwrap_or_default() {
        "dport" => {
            rule.port_spec = Some(value);
            rule.protocol = normalize_firewall_protocol(payload["protocol"].as_str().unwrap_or_default()).into();
        }
        "sport" => rule.port_spec = Some(value),
        "saddr" => rule.source = Some(value),
        "daddr" => rule.destination = Some(value),
        _ => {}
    }
}

/// Flattens the several shapes nft uses for the right side of a match: a
/// scalar, a set, a range or a prefix.
fn render_nft_value(raw: &Value) -> String {
    match raw {
        Value::String(s) => s.clone(),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .map(|v| v.to_string())
            .unwrap_or_default(),
        Value::Array(items) => items.iter().map(render_nft_value).collect::<Vec<_>>().join(","),
        Value::Object(map) => {
            // A set element with a timeout is wrapped twice: {"elem":{"val":…}}.
            for key in ["set", "elem", "val"] {
                if let Some(nested) = map.get(key) {
                    return render_nft_value(nested);
                }
            }
            if let Some(prefix) = map.get("prefix").and_then(Value::as_object) {
                return format!("{}/{}", scalar_text(&prefix["addr"]), scalar_text(&prefix["len"]));
            }
            if let Some(window) = map.get("range").and_then(Value::as_array).filter(|w| w.len() == 2) {
                return format!("{}-{}", scalar_text(&window[0]), scalar_text(&window[1]));
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// How Go's `%v` prints a JSON scalar: strings bare, numbers as numbers.
fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "<nil>".into(),
        other => other.to_string(),
    }
}

fn parse_iptables_rule(line: &str, priority: i64) -> FirewallRuleInfo {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let mut rule = FirewallRuleInfo {
        id: format!("iptables:{priority}"),
        priority,
        action: "allow".into(),
        direction: "inbound".into(),
        protocol: "any".into(),
        enabled: true,
        backend: cap::IPTABLES.into(),
        ..Default::default()
    };

    for i in 0..fields.len() {
        let next = fields.get(i + 1).copied();
        match (fields[i], next) {
            ("-A", Some(v)) => rule.direction = direction_from_chain(v).into(),
            ("-p", Some(v)) => rule.protocol = normalize_firewall_protocol(v).into(),
            ("--dport" | "--dports", Some(v)) => rule.port_spec = Some(v.to_string()),
            ("-s", Some(v)) => rule.source = Some(v.to_string()),
            ("-d", Some(v)) => rule.destination = Some(v.to_string()),
            ("-j", Some(v)) => rule.action = action_from_target(v).into(),
            ("--comment", Some(v)) => rule.comment = Some(v.trim_matches('"').to_string()),
            _ => {}
        }
    }
    rule
}

/* -------------------------------- apply ------------------------------- */

impl FirewallOps {
    /// Loads the whole table in one atomic transaction: nft either takes the
    /// entire script or leaves the kernel untouched, so there is no window
    /// in which half the rules are live. The argv is a constant; the rule
    /// set travels on stdin.
    async fn apply_nft(&self, ctx: &Ctx, p: &FwApplyParams) -> PResult<()> {
        exec::run_with(ctx, tool("nft", &["-f", "-"]).stdin(render_nft_script(p).into_bytes())).await?;
        Ok(())
    }

    async fn apply_iptables(&self, ctx: &Ctx, p: &FwApplyParams) -> PResult<()> {
        for args in iptables_prelude(p) {
            exec::run_with(ctx, ExecOptions::new("iptables", args).c_locale()).await?;
        }
        for rule in ordered_rules(&p.rules) {
            let Some(args) = iptables_args(&rule) else { continue };
            exec::run_with(ctx, ExecOptions::new("iptables", args).c_locale()).await?;
        }
        Ok(())
    }

    async fn apply_ufw(&self, ctx: &Ctx, p: &FwApplyParams) -> PResult<()> {
        for args in ufw_prelude(p) {
            exec::run_with(ctx, ExecOptions::new("ufw", args).c_locale()).await?;
        }
        for rule in ordered_rules(&p.rules) {
            let Some(args) = ufw_args(&rule) else { continue };
            exec::run_with(ctx, ExecOptions::new("ufw", args).c_locale()).await?;
        }
        exec::run_with(ctx, tool("ufw", &["--force", "enable"])).await?;
        Ok(())
    }
}

/* ------------------------------ snapshots ----------------------------- */

/// Everything needed to put the previous rule set back, held in memory for
/// the duration of the rollback window.
pub struct FirewallSnapshot {
    backend: &'static str,
    ruleset: Vec<u8>,
    rules6: Vec<u8>,
}

impl FirewallOps {
    async fn snapshot(&self, ctx: &Ctx, backend: &'static str) -> PResult<FirewallSnapshot> {
        let mut snapshot = FirewallSnapshot {
            backend,
            ruleset: Vec::new(),
            rules6: Vec::new(),
        };

        match backend {
            cap::NFTABLES => {
                snapshot.ruleset = exec::run_with(ctx, tool("nft", &["list", "ruleset"])).await?.into_bytes();
            }
            cap::IPTABLES => {
                snapshot.ruleset = exec::run_with(ctx, tool("iptables-save", &[])).await?.into_bytes();
                if let Ok(out6) = exec::run_with(ctx, tool("ip6tables-save", &[])).await {
                    snapshot.rules6 = out6.into_bytes();
                }
            }
            _ => {
                // ufw keeps its rule set on disk, so the files are the snapshot.
                let user_rules = Path::new(UFW_RULES_DIR).join("user.rules");
                snapshot.ruleset =
                    std::fs::read(&user_rules).map_err(|e| wrap_fs_error(&user_rules.display().to_string(), e))?;
                if let Ok(raw6) = std::fs::read(Path::new(UFW_RULES_DIR).join("user6.rules")) {
                    snapshot.rules6 = raw6;
                }
            }
        }
        Ok(snapshot)
    }

    /// Creates the ban table on demand, so fw.ban works on a host whose rule
    /// set Kaname has never applied.
    async fn ensure_ban_table(&self, ctx: &Ctx) -> PResult<()> {
        let script = format!(
            "table inet {NFT_BAN_TABLE} {{\n  set banned4 {{ type ipv4_addr; flags interval,timeout; }}\n  set banned6 {{ type ipv6_addr; flags interval,timeout; }}\n  chain input {{\n    type filter hook input priority -10; policy accept;\n    ip saddr @banned4 drop\n    ip6 saddr @banned6 drop\n  }}\n}}\n"
        );
        exec::run_with(ctx, tool("nft", &["-f", "-"]).stdin(script.into_bytes())).await?;
        Ok(())
    }

    async fn fail2ban_bans(&self, ctx: &Ctx) -> Vec<BanEntry> {
        let Ok(out) = exec::run_with(ctx, tool("fail2ban-client", &["status"])).await else {
            return Vec::new();
        };

        let mut jails = Vec::new();
        for line in split_lines(&out) {
            if !line.contains("Jail list:") {
                continue;
            }
            let list = line.split_once(':').map(|(_, l)| l).unwrap_or_default();
            jails.extend(list.split(',').map(str::trim).filter(|j| !j.is_empty()).map(str::to_string));
        }

        let mut bans = Vec::with_capacity(16);
        for jail in jails {
            let Ok(status) = exec::run_with(ctx, tool("fail2ban-client", &["status", &jail])).await else {
                continue;
            };
            let mut attempts = 0i64;
            for line in split_lines(&status) {
                if line.contains("Total failed:") {
                    let value = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or_default();
                    attempts = value.parse().unwrap_or(0);
                }
                if !line.contains("Banned IP list:") {
                    continue;
                }
                let list = line.split_once(':').map(|(_, l)| l).unwrap_or_default();
                for address in list.split_whitespace() {
                    bans.push(BanEntry {
                        ip: address.to_string(),
                        jail: jail.clone(),
                        banned_at: now_rfc3339(),
                        expires_at: None,
                        attempts,
                    });
                }
            }
        }
        bans
    }
}

async fn restore(ctx: &Ctx, snapshot: &FirewallSnapshot) -> PResult<()> {
    match snapshot.backend {
        cap::NFTABLES => {
            let mut script = b"flush ruleset\n".to_vec();
            script.extend_from_slice(&snapshot.ruleset);
            exec::run_with(ctx, tool("nft", &["-f", "-"]).stdin(script)).await?;
            Ok(())
        }
        cap::IPTABLES => {
            exec::run_with(ctx, tool("iptables-restore", &[]).stdin(snapshot.ruleset.clone())).await?;
            if !snapshot.rules6.is_empty() {
                exec::run_with(ctx, tool("ip6tables-restore", &[]).stdin(snapshot.rules6.clone())).await?;
            }
            Ok(())
        }
        cap::UFW => {
            exec::write_atomic(&Path::new(UFW_RULES_DIR).join("user.rules"), &snapshot.ruleset, 0o640)?;
            if !snapshot.rules6.is_empty() {
                exec::write_atomic(&Path::new(UFW_RULES_DIR).join("user6.rules"), &snapshot.rules6, 0o640)?;
            }
            exec::run_with(ctx, tool("ufw", &["reload"])).await?;
            Ok(())
        }
        _ => Ok(()),
    }
}

fn parse_nft_bans(out: &str) -> Vec<BanEntry> {
    let Ok(parsed) = serde_json::from_str::<Value>(out) else { return Vec::new() };

    let mut bans = Vec::with_capacity(16);
    for node in parsed["nftables"].as_array().into_iter().flatten() {
        let Some(set) = node.get("set") else { continue };
        for element in set["elem"].as_array().into_iter().flatten() {
            let address = render_nft_value(element);
            if address.is_empty() {
                continue;
            }
            bans.push(BanEntry {
                ip: address,
                jail: "kaname".into(),
                banned_at: now_rfc3339(),
                expires_at: None,
                attempts: 0,
            });
        }
    }
    bans
}

/* -------------------------------- threats ----------------------------- */

/// Accumulates repeated failures from one address, because a single failed
/// login is noise and forty in a minute is an incident.
struct Observation {
    kind: &'static str,
    target: &'static str,
    address: String,
    attempts: i64,
    first_seen: DateTime<Utc>,
    last_seen: DateTime<Utc>,
    sample: String,
}

impl FirewallOps {
    /// Reads the authentication trail, from journald where there is one and
    /// from the traditional log file otherwise.
    async fn auth_records(&self, ctx: &Ctx, p: &FwThreatsParams) -> PResult<Vec<LogRecord>> {
        // Four log lines per observation is a generous ceiling on how much
        // history a limit of N observations needs.
        let mut lines = p.limit * 4;
        if lines <= 0 || lines > 20000 {
            lines = 2000;
        }

        if self.0.has(cap::SYSTEMD) {
            let mut args = vec![
                "--no-pager".to_string(),
                "--output=json".to_string(),
                format!("--lines={lines}"),
                "--unit=ssh.service".to_string(),
                "--unit=sshd.service".to_string(),
                "--unit=dovecot.service".to_string(),
                "--unit=postfix.service".to_string(),
            ];
            if let Some(since) = p.since.as_deref().filter(|s| !s.is_empty()) {
                args.push(format!("--since={}", journal_since(since)?));
            }
            let out = exec::run_with(ctx, ExecOptions::new("journalctl", args).c_locale()).await?;
            return Ok(split_lines(&out).into_iter().filter_map(journal_record).collect());
        }

        let Some(target) = exec::first_existing(&["/var/log/auth.log", "/var/log/secure"]) else {
            return Err(unsupported("no authentication log on this host"));
        };
        let raw = std::fs::read(target).map_err(|e| wrap_fs_error(target, e))?;
        let text = String::from_utf8_lossy(&raw);
        let all = split_lines(&text);
        let start = all.len().saturating_sub(lines as usize);
        Ok(all[start..]
            .iter()
            .map(|line| LogRecord {
                ts: now_rfc3339(),
                level: "info".into(),
                source: "auth".into(),
                message: line.to_string(),
                ..Default::default()
            })
            .collect())
    }
}

/// One line of `journalctl --output=json`, reduced to what threats need:
/// the message and when it was written.
fn journal_record(line: &str) -> Option<LogRecord> {
    let parsed: Value = serde_json::from_str(line).ok()?;
    let message = match &parsed["MESSAGE"] {
        Value::String(s) => s.clone(),
        // journald exports a non-UTF8 message as an array of byte values.
        Value::Array(octets) => {
            String::from_utf8_lossy(&octets.iter().filter_map(|o| o.as_u64().map(|b| b as u8)).collect::<Vec<u8>>())
                .into_owned()
        }
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let ts = parsed["__REALTIME_TIMESTAMP"]
        .as_str()
        .and_then(|micros| micros.parse::<i64>().ok())
        .filter(|m| *m > 0)
        .and_then(DateTime::<Utc>::from_timestamp_micros)
        .map(rfc3339)
        .unwrap_or_else(now_rfc3339);
    Some(LogRecord {
        ts,
        level: "info".into(),
        source: "auth".into(),
        message,
        ..Default::default()
    })
}

/// Accepts an absolute RFC3339 stamp, an epoch or a relative window like
/// "-2h", because all three shapes reach the agent from different UI
/// controls.
fn parse_since(value: &str) -> PResult<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    if let Ok(seconds) = value.parse::<i64>() {
        if seconds > 0 {
            if let Some(t) = DateTime::<Utc>::from_timestamp(seconds, 0) {
                return Ok(t);
            }
        }
    }
    let window = value.strip_prefix('-').unwrap_or(value);
    let elapsed = humantime::parse_duration(window)
        .map_err(|_| invalid("since must be an RFC3339 timestamp or a duration like 2h"))?;
    let elapsed = chrono::Duration::from_std(elapsed).map_err(|_| invalid("since is out of range"))?;
    Ok(Utc::now() - elapsed)
}

/// Renders a timestamp in the only form journalctl parses unambiguously
/// across versions.
fn journal_since(value: &str) -> PResult<String> {
    let parsed = parse_since(value)?;
    Ok(parsed.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
}

/// Recognises the failure shapes worth reporting. Anything unrecognised is
/// dropped rather than filed under a guess.
fn classify_threat(message: &str) -> Option<(&'static str, &'static str)> {
    let lowered = message.to_lowercase();
    if lowered.contains("failed password")
        || lowered.contains("invalid user")
        || lowered.contains("failed publickey")
        || lowered.contains("authentication failure")
    {
        Some(("ssh_bruteforce", "sshd"))
    } else if lowered.contains("auth failed") || lowered.contains("aborted login") {
        Some(("mail_bruteforce", "dovecot"))
    } else if lowered.contains("sasl login authentication failed") {
        Some(("mail_bruteforce", "postfix"))
    } else if lowered.contains("did not receive identification string") {
        Some(("port_scan", "sshd"))
    } else {
        None
    }
}

fn truncate_string(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut cut = limit;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

/// Maps the kernel's answers onto the provider sentinels so the panel can
/// say "not found" or "permission denied" rather than surfacing an errno.
fn wrap_fs_error(target: &str, err: std::io::Error) -> ProviderError {
    match err.kind() {
        std::io::ErrorKind::NotFound => not_found(target),
        std::io::ErrorKind::PermissionDenied => ProviderError::PermissionDenied(target.to_string()),
        std::io::ErrorKind::AlreadyExists => ProviderError::conflict(format!("{target} already exists")),
        _ if err.raw_os_error() == Some(libc::ENOTEMPTY) => precondition(format!("{target} is not empty")),
        _ if err.raw_os_error() == Some(libc::ENOSPC) => precondition(format!("no space left for {target}")),
        _ => ProviderError::internal(format!("{target}: {err}")),
    }
}

/* ------------------------------------------------------------------ *
 * Firewall rendering.
 *
 * Turning a rule set into something a backend understands is the part of
 * the firewall that has no business touching the host, so it does not.
 * nftables is fed a script over stdin with a fixed argv; iptables and ufw
 * are fed argv slices. In all three cases nothing an operator typed is
 * ever concatenated into a command line, which is why a comment reading
 * `x; nft flush ruleset` is one comment and not two commands.
 * ------------------------------------------------------------------ */
pub mod render {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use once_cell::sync::Lazy;
    use regex_lite::Regex;

    use crate::providers::linux::common::{invalid, split_lines};
    use crate::providers::{FirewallRule, FwApplyParams, PResult};

    /// The table Kaname owns. Nothing outside it is ever rewritten.
    pub const NFT_TABLE: &str = "kaname";
    /// Bans live in their own table so replacing the rule set does not
    /// quietly unban everything.
    pub const NFT_BAN_TABLE: &str = "kaname_bans";

    pub const IPTABLES_BAN_COMMENT: &str = "kaname-ban";
    pub const UFW_RULES_DIR: &str = "/etc/ufw";

    static PORT_SPEC_OK: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^[0-9]{1,5}(?:[-:][0-9]{1,5})?(?:,[0-9]{1,5}(?:[-:][0-9]{1,5})?)*$").unwrap());

    fn present(value: &Option<String>) -> Option<&str> {
        value.as_deref().filter(|v| !v.is_empty())
    }

    /// Sorts a rule set by priority without disturbing the caller's slice, so
    /// every backend installs rules in the same order.
    pub fn ordered_rules(rules: &[FirewallRule]) -> Vec<FirewallRule> {
        let mut ordered = rules.to_vec();
        ordered.sort_by_key(|r| r.priority);
        ordered
    }

    /* ------------------------------ nftables ----------------------------- */

    /// Builds the whole table as one script. nft either takes all of it or
    /// leaves the kernel untouched, so there is no window in which half the
    /// rules are live.
    pub fn render_nft_script(p: &FwApplyParams) -> String {
        let mut b = String::new();
        // Declaring the table before deleting it makes the delete succeed on a
        // host where it does not exist yet.
        b.push_str(&format!("table inet {NFT_TABLE}\n"));
        b.push_str(&format!("delete table inet {NFT_TABLE}\n"));
        b.push_str(&format!("table inet {NFT_TABLE} {{\n"));

        let ordered = ordered_rules(&p.rules);
        for (name, hook, policy, direction) in [
            ("input", "input", nft_policy(&p.default_inbound), "inbound"),
            ("output", "output", nft_policy(&p.default_outbound), "outbound"),
        ] {
            b.push_str(&format!("  chain {name} {{\n"));
            // Numeric priority rather than the `filter` keyword: the keyword
            // only arrived in nft 0.9 and this has to load on an older host too.
            b.push_str(&format!("    type filter hook {hook} priority 0; policy {policy};\n"));
            b.push_str("    ct state established,related accept\n");
            b.push_str("    ct state invalid drop\n");
            if name == "input" {
                b.push_str("    iif lo accept\n");
            } else {
                b.push_str("    oif lo accept\n");
            }

            for rule in ordered.iter().filter(|r| r.direction == direction) {
                b.push_str("    ");
                b.push_str(&render_nft_rule(rule));
                b.push('\n');
            }
            b.push_str("  }\n");
        }
        b.push_str("}\n");
        b
    }

    pub fn render_nft_rule(rule: &FirewallRule) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(6);

        let mut address_family = "ip";
        if present(&rule.source).is_some_and(|s| s.contains(':')) {
            address_family = "ip6";
        }
        if present(&rule.destination).is_some_and(|d| d.contains(':')) {
            address_family = "ip6";
        }

        match rule.protocol.as_str() {
            "tcp" | "udp" => match present(&rule.port_spec) {
                Some(spec) => parts.push(format!("{} dport {}", rule.protocol, nft_port_spec(spec))),
                None => parts.push(format!("meta l4proto {}", rule.protocol)),
            },
            "icmp" => {
                if address_family == "ip6" {
                    parts.push("meta l4proto ipv6-icmp".into());
                } else {
                    parts.push("meta l4proto icmp".into());
                }
            }
            _ => {}
        }
        if let Some(source) = present(&rule.source) {
            parts.push(format!("{address_family} saddr {source}"));
        }
        if let Some(destination) = present(&rule.destination) {
            parts.push(format!("{address_family} daddr {destination}"));
        }

        parts.push(nft_verdict(&rule.action).into());
        if let Some(comment) = present(&rule.comment) {
            parts.push(format!("comment \"{}\"", sanitize_comment(comment)));
        }
        parts.join(" ")
    }

    /* ------------------------------ iptables ----------------------------- */

    /// The fixed part of an apply. iptables has no atomic transaction, so the
    /// order matters: the established-connection and loopback rules go in
    /// before the default policy flips, or the operator's own session is
    /// dropped in the gap.
    pub fn iptables_prelude(p: &FwApplyParams) -> Vec<Vec<String>> {
        let s = |items: &[&str]| items.iter().map(|i| i.to_string()).collect::<Vec<String>>();
        vec![
            s(&["-F"]),
            s(&["-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]),
            s(&["-A", "INPUT", "-i", "lo", "-j", "ACCEPT"]),
            s(&["-P", "INPUT", iptables_policy(&p.default_inbound)]),
            s(&["-P", "OUTPUT", iptables_policy(&p.default_outbound)]),
            s(&["-P", "FORWARD", "DROP"]),
        ]
    }

    /// The argv for one rule, or `None` when iptables cannot express it.
    pub fn iptables_args(rule: &FirewallRule) -> Option<Vec<String>> {
        let chain = if rule.direction == "outbound" { "OUTPUT" } else { "INPUT" };
        let mut args: Vec<String> = vec!["-A".into(), chain.into()];

        if rule.protocol != "any" {
            args.push("-p".into());
            args.push(rule.protocol.clone());
        }
        if let Some(spec) = present(&rule.port_spec) {
            if rule.protocol != "tcp" && rule.protocol != "udp" {
                return None;
            }
            if spec.contains(',') {
                args.extend(["-m".to_string(), "multiport".into(), "--dports".into(), spec.to_string()]);
            } else {
                args.extend(["--dport".to_string(), spec.replace('-', ":")]);
            }
        }
        if let Some(source) = present(&rule.source) {
            args.extend(["-s".to_string(), source.to_string()]);
        }
        if let Some(destination) = present(&rule.destination) {
            args.extend(["-d".to_string(), destination.to_string()]);
        }
        if let Some(comment) = present(&rule.comment) {
            args.extend(["-m".to_string(), "comment".into(), "--comment".into(), sanitize_comment(comment)]);
        }
        args.extend(["-j".to_string(), iptables_target(&rule.action).into()]);
        Some(args)
    }

    /* --------------------------------- ufw -------------------------------- */

    pub fn ufw_prelude(p: &FwApplyParams) -> Vec<Vec<String>> {
        vec![
            vec!["--force".into(), "reset".into()],
            vec!["default".into(), p.default_inbound.clone(), "incoming".into()],
            vec!["default".into(), p.default_outbound.clone(), "outgoing".into()],
        ]
    }

    pub fn ufw_args(rule: &FirewallRule) -> Option<Vec<String>> {
        let mut args: Vec<String> = vec![rule.action.clone()];
        args.push(if rule.direction == "outbound" { "out".into() } else { "in".into() });
        match present(&rule.source) {
            Some(source) => args.extend(["from".to_string(), source.to_string()]),
            None => args.extend(["from".to_string(), "any".into()]),
        }
        if let Some(spec) = present(&rule.port_spec) {
            if rule.protocol != "tcp" && rule.protocol != "udp" {
                return None;
            }
            args.extend([
                "to".to_string(),
                "any".into(),
                "port".into(),
                spec.to_string(),
                "proto".into(),
                rule.protocol.clone(),
            ]);
        } else if rule.protocol == "tcp" || rule.protocol == "udp" {
            args.extend(["to".to_string(), "any".into(), "proto".into(), rule.protocol.clone()]);
        }
        if let Some(comment) = present(&rule.comment) {
            args.extend(["comment".to_string(), sanitize_comment(comment)]);
        }
        Some(args)
    }

    /* ------------------------------ validation ---------------------------- */

    pub fn check_rule(rule: &FirewallRule) -> PResult<()> {
        if let Some(spec) = present(&rule.port_spec) {
            if !PORT_SPEC_OK.is_match(spec) {
                return Err(invalid(format!(
                    "port_spec {spec:?} must be a port, range or comma-separated list"
                )));
            }
            if rule.protocol != "tcp" && rule.protocol != "udp" {
                return Err(invalid("a port_spec needs protocol tcp or udp"));
            }
        }
        for address in [&rule.source, &rule.destination] {
            if let Some(address) = present(address) {
                parse_target(address)?;
            }
        }
        if rule.comment.as_ref().is_some_and(|c| c.len() > 200) {
            return Err(invalid("comment may not exceed 200 characters"));
        }
        Ok(())
    }

    /// Normalises an address or CIDR and reports its family, so a v6 ban
    /// never lands in a v4 set. A host bit left set in a CIDR is masked off
    /// rather than refused, so the rule installed is the rule that was meant.
    pub fn parse_target(target: &str) -> PResult<(String, &'static str)> {
        let reject = || invalid(format!("{target:?} is not an address or CIDR range"));

        if let Some((address, length)) = target.split_once('/') {
            let address: IpAddr = address.parse().map_err(|_| reject())?;
            let length: u32 = length.parse().map_err(|_| reject())?;
            return match unmap(address) {
                IpAddr::V4(v4) => {
                    if length > 32 {
                        return Err(reject());
                    }
                    let mask = if length == 0 { 0 } else { u32::MAX << (32 - length) };
                    let network = Ipv4Addr::from(u32::from(v4) & mask);
                    Ok((format!("{network}/{length}"), "ip"))
                }
                IpAddr::V6(v6) => {
                    if length > 128 {
                        return Err(reject());
                    }
                    let mask = if length == 0 { 0 } else { u128::MAX << (128 - length) };
                    let network = Ipv6Addr::from(u128::from(v6) & mask);
                    Ok((format!("{network}/{length}"), "ip6"))
                }
            };
        }

        let address: IpAddr = target.parse().map_err(|_| reject())?;
        match unmap(address) {
            IpAddr::V4(v4) => Ok((v4.to_string(), "ip")),
            IpAddr::V6(v6) => Ok((v6.to_string(), "ip6")),
        }
    }

    /// A v4-mapped v6 address is a v4 address, as Go's `To4` treats it.
    fn unmap(address: IpAddr) -> IpAddr {
        match address {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
            v4 => v4,
        }
    }

    /* -------------------------------- shapes ------------------------------ */

    pub fn ban_set(family: &str) -> &'static str {
        if family == "ip6" { "banned6" } else { "banned4" }
    }

    pub fn nft_port_spec(spec: &str) -> String {
        let normalized = spec.replace(':', "-");
        if normalized.contains(',') {
            format!("{{ {normalized} }}")
        } else {
            normalized
        }
    }

    pub fn nft_policy(value: &str) -> &'static str {
        if value == "deny" { "drop" } else { "accept" }
    }

    pub fn nft_verdict(action: &str) -> &'static str {
        match action {
            "deny" => "drop",
            "reject" => "reject",
            _ => "accept",
        }
    }

    pub fn iptables_policy(value: &str) -> &'static str {
        if value == "deny" { "DROP" } else { "ACCEPT" }
    }

    pub fn iptables_target(action: &str) -> &'static str {
        match action {
            "deny" => "DROP",
            "reject" => "REJECT",
            _ => "ACCEPT",
        }
    }

    pub fn policy_from_nft(ruleset: &str, chain: &str) -> &'static str {
        for line in split_lines(ruleset) {
            if !line.contains(&format!("hook {chain} ")) {
                continue;
            }
            if line.contains("policy drop") {
                return "deny";
            }
            return "allow";
        }
        "allow"
    }

    pub fn policy_from_iptables(policy: &str) -> &'static str {
        if policy == "DROP" || policy == "REJECT" { "deny" } else { "allow" }
    }

    pub fn direction_from_chain(chain: &str) -> &'static str {
        match chain.to_lowercase().as_str() {
            "output" | "postrouting" => "outbound",
            _ => "inbound",
        }
    }

    pub fn action_from_target(target: &str) -> &'static str {
        match target.to_uppercase().as_str() {
            "DROP" | "DENY" => "deny",
            "REJECT" => "reject",
            _ => "allow",
        }
    }

    pub fn normalize_firewall_protocol(value: &str) -> &'static str {
        match value.to_lowercase().as_str() {
            "tcp" => "tcp",
            "udp" => "udp",
            "icmp" | "ipv6-icmp" | "icmpv6" => "icmp",
            _ => "any",
        }
    }

    pub fn split_ufw_target(target: &str) -> (&str, &'static str) {
        let Some(first) = target.split_whitespace().next() else { return ("", "") };
        match first.split_once('/') {
            Some((port, protocol)) => (port, normalize_firewall_protocol(protocol)),
            None => (first, ""),
        }
    }

    /// Strips the characters that would end a quoted nft comment or confuse
    /// an iptables match.
    pub fn sanitize_comment(comment: &str) -> String {
        comment
            .chars()
            .filter(|c| !matches!(c, '"' | '\\' | '\n' | '\r' | ';' | '\0'))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    /* ------------------------------------------------------------------ *
     * Firewall rendering.
     *
     * The security thesis says a rule value can never become a second
     * command. These tests hold the agent to it structurally: the iptables
     * and ufw backends are asserted as argv slices, so a value carrying
     * `; nft flush ruleset` is one element of that slice and not a shell
     * fragment, and the nftables backend is asserted to travel on stdin
     * under a constant argv.
     * ------------------------------------------------------------------ */

    use super::render::*;
    use crate::providers::{FirewallRule, FwApplyParams, ProviderError};

    fn rule(mutate: impl FnOnce(&mut FirewallRule)) -> FirewallRule {
        let mut r = FirewallRule {
            priority: 10,
            action: "allow".into(),
            direction: "inbound".into(),
            protocol: "tcp".into(),
            ..Default::default()
        };
        mutate(&mut r);
        r
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    fn assert_args(got: Option<Vec<String>>, want: &[&str]) {
        let got = got.unwrap_or_else(|| panic!("the rule was dropped, want argv {want:?}"));
        assert_eq!(got, argv(want));
    }

    fn is_invalid<T>(result: &Result<T, ProviderError>) -> bool {
        matches!(result, Err(ProviderError::InvalidParams(_)))
    }

    /* ------------------------------ iptables ----------------------------- */

    #[test]
    fn iptables_args_are_exactly_the_expected_argv() {
        let cases: Vec<(&str, FirewallRule, Vec<&str>)> = vec![
            (
                "a single inbound port",
                rule(|r| r.port_spec = s("22")),
                vec!["-A", "INPUT", "-p", "tcp", "--dport", "22", "-j", "ACCEPT"],
            ),
            // iptables spells a range with a colon, the contract with a
            // hyphen. Getting this backwards opens one port instead of a
            // thousand, silently.
            (
                "a port range is rewritten for iptables",
                rule(|r| r.port_spec = s("6000-6010")),
                vec!["-A", "INPUT", "-p", "tcp", "--dport", "6000:6010", "-j", "ACCEPT"],
            ),
            (
                "a port list needs the multiport match",
                rule(|r| r.port_spec = s("80,443")),
                vec!["-A", "INPUT", "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "ACCEPT"],
            ),
            (
                "an outbound deny with a source",
                rule(|r| {
                    r.action = "deny".into();
                    r.direction = "outbound".into();
                    r.source = s("10.0.0.0/8");
                    r.port_spec = None;
                }),
                vec!["-A", "OUTPUT", "-p", "tcp", "-s", "10.0.0.0/8", "-j", "DROP"],
            ),
            (
                "a reject with a destination",
                rule(|r| {
                    r.action = "reject".into();
                    r.destination = s("192.0.2.10");
                    r.port_spec = s("25");
                }),
                vec!["-A", "INPUT", "-p", "tcp", "--dport", "25", "-d", "192.0.2.10", "-j", "REJECT"],
            ),
            // Protocol "any" means the -p flag is left off entirely rather
            // than passed as the literal word "any".
            (
                "protocol any omits the flag",
                rule(|r| {
                    r.protocol = "any".into();
                    r.port_spec = None;
                    r.source = s("203.0.113.0/24");
                }),
                vec!["-A", "INPUT", "-s", "203.0.113.0/24", "-j", "ACCEPT"],
            ),
            (
                "a comment becomes its own argv elements",
                rule(|r| {
                    r.port_spec = s("443");
                    r.comment = s("https for the storefront");
                }),
                vec![
                    "-A",
                    "INPUT",
                    "-p",
                    "tcp",
                    "--dport",
                    "443",
                    "-m",
                    "comment",
                    "--comment",
                    "https for the storefront",
                    "-j",
                    "ACCEPT",
                ],
            ),
        ];

        for (name, rule, want) in cases {
            let got = iptables_args(&rule);
            assert!(got.is_some(), "{name}: the rule was dropped");
            assert_eq!(got.unwrap(), argv(&want), "{name}");
        }
    }

    #[test]
    fn iptables_drops_a_port_spec_it_cannot_express() {
        // A port on a protocol iptables has no port concept for is refused
        // rather than emitted without --dport, which would silently widen the
        // rule from "port 22" to "all icmp".
        let args = iptables_args(&rule(|r| {
            r.protocol = "icmp".into();
            r.port_spec = s("22");
        }));
        assert!(args.is_none(), "an icmp rule with a port produced {args:?}, want it dropped");
    }

    #[test]
    fn iptables_prelude_keeps_the_session_alive_before_the_policy_flips() {
        let prelude = iptables_prelude(&FwApplyParams {
            default_inbound: "deny".into(),
            default_outbound: "allow".into(),
            ..Default::default()
        });

        let want = vec![
            argv(&["-F"]),
            argv(&["-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]),
            argv(&["-A", "INPUT", "-i", "lo", "-j", "ACCEPT"]),
            argv(&["-P", "INPUT", "DROP"]),
            argv(&["-P", "OUTPUT", "ACCEPT"]),
            argv(&["-P", "FORWARD", "DROP"]),
        ];
        assert_eq!(prelude, want);

        // The ordering is the whole point: iptables has no transaction, so an
        // ESTABLISHED accept installed *after* `-P INPUT DROP` would cut the
        // operator's own ssh session in the gap between the two calls.
        let established = prelude.iter().position(|args| args.iter().any(|a| a == "ESTABLISHED,RELATED"));
        let policy = prelude.iter().position(|args| args.len() == 3 && args[0] == "-P" && args[1] == "INPUT");
        match (established, policy) {
            (Some(e), Some(p)) if e < p => {}
            other => panic!("the established rule and the INPUT policy are at {other:?}; the rule must come first"),
        }
    }

    /* --------------------------------- ufw -------------------------------- */

    #[test]
    fn ufw_args_are_exactly_the_expected_argv() {
        assert_args(
            ufw_args(&rule(|r| r.port_spec = s("22"))),
            &["allow", "in", "from", "any", "to", "any", "port", "22", "proto", "tcp"],
        );
        assert_args(
            ufw_args(&rule(|r| {
                r.action = "deny".into();
                r.direction = "outbound".into();
                r.source = s("10.0.0.0/8");
                r.port_spec = s("25");
            })),
            &["deny", "out", "from", "10.0.0.0/8", "to", "any", "port", "25", "proto", "tcp"],
        );
        assert_args(
            ufw_args(&rule(|r| {
                r.protocol = "udp".into();
                r.port_spec = None;
            })),
            &["allow", "in", "from", "any", "to", "any", "proto", "udp"],
        );
        assert_args(
            ufw_args(&rule(|r| {
                r.port_spec = s("443");
                r.comment = s("https");
            })),
            &["allow", "in", "from", "any", "to", "any", "port", "443", "proto", "tcp", "comment", "https"],
        );
    }

    #[test]
    fn ufw_prelude_resets_before_setting_defaults() {
        let prelude = ufw_prelude(&FwApplyParams {
            default_inbound: "deny".into(),
            default_outbound: "allow".into(),
            ..Default::default()
        });
        assert_eq!(
            prelude,
            vec![
                argv(&["--force", "reset"]),
                argv(&["default", "deny", "incoming"]),
                argv(&["default", "allow", "outgoing"]),
            ]
        );
    }

    /* ------------------------------ nftables ----------------------------- */

    #[test]
    fn render_nft_rule_produces_the_expected_expression() {
        let cases: Vec<(&str, FirewallRule, &str)> = vec![
            ("a tcp port", rule(|r| r.port_spec = s("22")), "tcp dport 22 accept"),
            (
                "a port range uses nft's hyphen",
                rule(|r| r.port_spec = s("6000:6010")),
                "tcp dport 6000-6010 accept",
            ),
            (
                "a port list becomes an anonymous set",
                rule(|r| r.port_spec = s("80,443")),
                "tcp dport { 80,443 } accept",
            ),
            (
                "a protocol with no port",
                rule(|r| {
                    r.protocol = "udp".into();
                    r.port_spec = None;
                }),
                "meta l4proto udp accept",
            ),
            (
                "a v4 source",
                rule(|r| {
                    r.port_spec = None;
                    r.source = s("203.0.113.0/24");
                    r.protocol = "any".into();
                }),
                "ip saddr 203.0.113.0/24 accept",
            ),
            // The address family has to follow the address, or nft rejects
            // the whole script and the apply fails atomically.
            (
                "a v6 source switches the family keyword",
                rule(|r| {
                    r.port_spec = None;
                    r.source = s("2001:db8::/32");
                    r.protocol = "any".into();
                    r.action = "deny".into();
                }),
                "ip6 saddr 2001:db8::/32 drop",
            ),
            (
                "icmp over v6 is a different protocol number",
                rule(|r| {
                    r.protocol = "icmp".into();
                    r.port_spec = None;
                    r.source = s("2001:db8::1");
                }),
                "meta l4proto ipv6-icmp ip6 saddr 2001:db8::1 accept",
            ),
            (
                "reject is its own verdict",
                rule(|r| {
                    r.action = "reject".into();
                    r.port_spec = s("25");
                }),
                "tcp dport 25 reject",
            ),
        ];
        for (name, rule, want) in cases {
            assert_eq!(render_nft_rule(&rule), want, "{name}");
        }
    }

    #[test]
    fn render_nft_script_builds_one_atomic_table() {
        let port = |priority, action: &str, direction: &str, spec: &str| FirewallRule {
            priority,
            action: action.into(),
            direction: direction.into(),
            protocol: "tcp".into(),
            port_spec: s(spec),
            ..Default::default()
        };
        let script = render_nft_script(&FwApplyParams {
            default_inbound: "deny".into(),
            default_outbound: "allow".into(),
            rules: vec![
                port(20, "allow", "inbound", "443"),
                port(10, "allow", "inbound", "22"),
                port(30, "deny", "outbound", "25"),
            ],
            rollback_seconds: 0,
        });

        for want in [
            "table inet kaname\n",
            "delete table inet kaname\n",
            "type filter hook input priority 0; policy drop;",
            "type filter hook output priority 0; policy accept;",
            "ct state established,related accept",
            "iif lo accept",
            "oif lo accept",
        ] {
            assert!(script.contains(want), "the script is missing {want:?}:\n{script}");
        }

        // Priority is what an operator uses to put a deny in front of an
        // allow, so the order in the script has to follow it rather than the
        // order the rules happened to arrive in.
        let port22 = script.find("tcp dport 22").expect("port 22 rendered");
        let port443 = script.find("tcp dport 443").expect("port 443 rendered");
        assert!(port22 < port443, "rules are not ordered by priority:\n{script}");

        // A rule belongs to exactly one chain: an outbound rule leaking into
        // the input chain would open a port nobody asked to open.
        let input = &script[script.find("chain input").unwrap()..script.find("chain output").unwrap()];
        assert!(!input.contains("dport 25"), "the outbound rule was rendered into the input chain:\n{script}");
    }

    #[test]
    fn render_nft_script_declares_the_table_before_deleting_it() {
        let script = render_nft_script(&FwApplyParams {
            default_inbound: "allow".into(),
            default_outbound: "allow".into(),
            ..Default::default()
        });
        let declare = script.find("table inet kaname\n").expect("declared");
        let remove = script.find("delete table inet kaname").expect("deleted");
        // Without the declaration first, the delete fails on a host Kaname
        // has never applied to, and the very first fw.apply errors out.
        assert!(declare < remove, "the table is not declared before it is deleted:\n{script}");
    }

    /* ------------------------------ injection ---------------------------- */

    /// The one that matters. Every one of these values is an attempt to end
    /// the current command and start another; none of them may survive into a
    /// position where a backend would read it as one.
    #[test]
    fn a_rule_value_cannot_become_a_second_command() {
        let hostile = [
            "22; nft flush ruleset",
            "22\nflush ruleset",
            "22\" ; rm -rf /; echo \"",
            "22 && reboot",
            "22 | tee /etc/passwd",
            "$(reboot)",
            "`reboot`",
            "22\x00; reboot",
        ];

        for value in hostile {
            // A hostile port spec never reaches a backend at all: the
            // grammar admits digits, commas, hyphens and colons only.
            assert!(
                check_rule(&rule(|r| r.port_spec = s(value))).is_err(),
                "port_spec {value:?} was accepted"
            );
            // Same for an address, which must parse as an IP or a CIDR.
            for field in ["source", "destination"] {
                let mut r = rule(|r| r.port_spec = None);
                if field == "source" {
                    r.source = s(value);
                } else {
                    r.destination = s(value);
                }
                assert!(is_invalid(&check_rule(&r)), "{field} {value:?} was not rejected as invalid");
            }
        }
    }

    /// A comment is the one free-text field a rule carries, so it is the one
    /// value that cannot simply be rejected. It is stripped instead, and what
    /// survives has to be inert in all three backends.
    #[test]
    fn a_hostile_comment_is_stripped_rather_than_escaped() {
        let hostile = "storefront\"; drop table kaname; #\n\r\\ end\x00";

        let sanitized = sanitize_comment(hostile);
        for forbidden in ["\"", "\\", "\n", "\r", ";", "\x00"] {
            assert!(!sanitized.contains(forbidden), "sanitize_comment kept {forbidden:?} in {sanitized:?}");
        }

        // In nft the comment is written inside quotes, so a surviving quote or
        // semicolon would end the comment and start a statement.
        let nft = render_nft_rule(&rule(|r| {
            r.port_spec = s("443");
            r.comment = s(hostile);
        }));
        assert_eq!(nft.matches('"').count(), 2, "not exactly one quoted comment: {nft:?}");
        assert!(!nft.contains(['\n', '\r', ';']), "the rendered rule carries a statement separator: {nft:?}");

        // In iptables and ufw the comment is a single argv element, so even an
        // unsanitised one could not become a command — but it must still be
        // exactly one element, not several.
        let args = iptables_args(&rule(|r| {
            r.port_spec = s("443");
            r.comment = s(hostile);
        }))
        .expect("the rule was dropped");
        let index = args.iter().position(|a| a == "--comment").map(|i| i + 1).expect("no comment element");
        assert_eq!(args[index], sanitized, "the comment argument is not the sanitised one");
        assert_eq!(args.len(), index + 3, "the comment produced more argv elements than expected: {args:?}");
    }

    #[test]
    fn check_rule_accepts_the_shapes_the_contract_allows() {
        let cases = vec![
            rule(|r| r.port_spec = s("22")),
            rule(|r| r.port_spec = s("6000-6010")),
            rule(|r| r.port_spec = s("6000:6010")),
            rule(|r| r.port_spec = s("80,443,8080-8090")),
            rule(|r| {
                r.port_spec = None;
                r.source = s("203.0.113.4");
            }),
            rule(|r| {
                r.port_spec = None;
                r.source = s("2001:db8::/32");
            }),
            rule(|r| {
                r.port_spec = None;
                r.destination = s("10.0.0.0/8");
            }),
            rule(|r| {
                r.port_spec = None;
                r.comment = Some("a".repeat(200));
            }),
        ];
        for c in cases {
            assert!(check_rule(&c).is_ok(), "a legitimate rule {c:?} was rejected");
        }
    }

    #[test]
    fn check_rule_refuses_a_port_without_a_transport_protocol() {
        // nft and iptables both need to know tcp or udp before a port means
        // anything; accepting this would render a rule that matches nothing.
        let result = check_rule(&rule(|r| {
            r.protocol = "any".into();
            r.port_spec = s("22");
        }));
        assert!(is_invalid(&result), "a port on protocol any produced {result:?}");
    }

    #[test]
    fn check_rule_refuses_an_overlong_comment() {
        let result = check_rule(&rule(|r| {
            r.port_spec = None;
            r.comment = Some("a".repeat(201));
        }));
        assert!(is_invalid(&result), "a 201-character comment produced {result:?}");
    }

    #[test]
    fn parse_target_normalises_and_reports_the_family() {
        let cases = [
            ("203.0.113.4", "203.0.113.4", "ip"),
            ("203.0.113.0/24", "203.0.113.0/24", "ip"),
            // A host bit left set in a CIDR is masked off rather than refused,
            // so the rule that is installed is the rule that was meant.
            ("203.0.113.7/24", "203.0.113.0/24", "ip"),
            ("2001:db8::1", "2001:db8::1", "ip6"),
            ("2001:db8:abcd::/48", "2001:db8:abcd::/48", "ip6"),
            ("::1", "::1", "ip6"),
        ];
        for (raw, want, family) in cases {
            let (got, got_family) = parse_target(raw).unwrap_or_else(|e| panic!("parse_target({raw:?}) failed: {e}"));
            assert_eq!((got.as_str(), got_family), (want, family), "parse_target({raw:?})");
            // A v6 ban landing in the v4 set is a ban that silently does
            // nothing, so the set name has to follow the family.
            let want_set = if family == "ip" { "banned4" } else { "banned6" };
            assert_eq!(ban_set(got_family), want_set);
        }

        for raw in ["", "example.com", "999.1.1.1", "203.0.113.0/33", "10.0.0.1 -j ACCEPT", "*"] {
            assert!(parse_target(raw).is_err(), "parse_target({raw:?}) was accepted");
        }
    }

    #[test]
    fn ordered_rules_leaves_the_callers_slice_alone() {
        let rules = vec![
            FirewallRule {
                priority: 30,
                action: "deny".into(),
                ..Default::default()
            },
            FirewallRule {
                priority: 10,
                action: "allow".into(),
                ..Default::default()
            },
            FirewallRule {
                priority: 20,
                action: "reject".into(),
                ..Default::default()
            },
        ];

        let ordered = ordered_rules(&rules);
        assert_eq!(
            ordered.iter().map(|r| r.priority).collect::<Vec<_>>(),
            vec![10, 20, 30],
            "ordered_rules did not sort by priority"
        );
        // fw.apply hands the same slice to a backend and then to the snapshot
        // path; sorting in place would reorder it under the caller.
        assert_eq!(rules[0].priority, 30, "ordered_rules mutated the caller's slice");
    }

    #[test]
    fn classify_threat_recognises_the_known_shapes() {
        assert_eq!(super::classify_threat("Failed password for root from 1.2.3.4"), Some(("ssh_bruteforce", "sshd")));
        assert_eq!(super::classify_threat("dovecot: auth failed"), Some(("mail_bruteforce", "dovecot")));
        assert_eq!(super::classify_threat("Did not receive identification string"), Some(("port_scan", "sshd")));
        assert_eq!(super::classify_threat("Accepted publickey for deploy"), None);
    }

    #[test]
    fn nft_values_flatten_every_shape() {
        use serde_json::json;
        assert_eq!(super::render_nft_value(&json!(22)), "22");
        assert_eq!(super::render_nft_value(&json!("tcp")), "tcp");
        assert_eq!(super::render_nft_value(&json!({"set": [80, 443]})), "80,443");
        assert_eq!(super::render_nft_value(&json!({"prefix": {"addr": "10.0.0.0", "len": 8}})), "10.0.0.0/8");
        assert_eq!(super::render_nft_value(&json!({"range": [6000, 6010]})), "6000-6010");
        assert_eq!(super::render_nft_value(&json!({"elem": {"val": "203.0.113.4"}})), "203.0.113.4");
    }
}
