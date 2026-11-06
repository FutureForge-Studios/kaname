//! systemd.
//!
//! Driven through systemctl with argv slices rather than the dbus
//! bindings: the dependency surface stays at zero and the machine-readable
//! output (`show` returns Key=Value, `list-units --plain` returns fixed
//! columns) is stable enough to parse without a library.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use super::common::{epoch_rfc3339, invalid, not_found, split_lines};
use super::exec::{ExecOptions, run_with};
use super::logs::{JournalQuery, journal, journal_since};
use crate::providers::*;

/// The property set behind every ServiceInfo. Requesting them explicitly
/// keeps `systemctl show` output small and its column order ours.
const UNIT_PROPERTIES: &[&str] = &[
    "Id",
    "Description",
    "LoadState",
    "ActiveState",
    "SubState",
    "UnitFileState",
    "MainPID",
    "MemoryCurrent",
    "CPUUsageNSec",
    "ActiveEnterTimestampMonotonic",
    "NRestarts",
];

/// systemd reports "[not set]" for a counter it has no value for, and
/// 2^64-1 for an unset 64-bit property.
const UNSET_PROPERTY: &str = "18446744073709551615";

pub struct ServiceOps(pub Arc<Shared>);

#[async_trait]
impl Services for ServiceOps {
    async fn list(&self, ctx: &Ctx, p: ServiceListParams) -> PResult<Vec<ServiceInfo>> {
        self.0.require(cap::SYSTEMD)?;

        let mut args: Vec<String> = [
            "list-units",
            "--type=service",
            "--all",
            "--full",
            "--plain",
            "--no-legend",
            "--no-pager",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if let Some(state) = p.state.as_deref().filter(|s| !s.is_empty()) {
            check_unit_state(state)?;
            args.push(format!("--state={state}"));
        }
        if let Some(pattern) = p.pattern.as_deref().filter(|s| !s.is_empty()) {
            check_unit_pattern(pattern)?;
            args.push(pattern.to_string());
        }

        let out = run_with(ctx, ExecOptions::new("systemctl", args).c_locale()).await?;
        let (names, descriptions) = parse_list_units(&out);
        if names.is_empty() {
            return Ok(Vec::new());
        }

        let enabled = self.enabled_states(ctx).await?;
        let units = self.show(ctx, &names).await?;

        let mut services = Vec::with_capacity(names.len());
        for name in &names {
            let mut info = units.get(name).cloned().unwrap_or_else(|| ServiceInfo {
                unit: name.clone(),
                active_state: "unknown".into(),
                load_state: "not-found".into(),
                ..Default::default()
            });
            if info.description.is_empty() {
                info.description = descriptions.get(name).cloned().unwrap_or_default();
            }
            info.enabled = enabled.get(name).copied().unwrap_or(false);
            services.push(info);
        }
        services.sort_by(|a, b| a.unit.cmp(&b.unit));
        Ok(services)
    }

    async fn status(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.0.require(cap::SYSTEMD)?;

        let name = qualify(unit);
        let units = self.show(ctx, std::slice::from_ref(&name)).await?;
        let Some(mut info) = units.get(&name).cloned() else {
            return Err(not_found(format!("unit {name}")));
        };
        if info.load_state == "not-found" {
            return Err(not_found(format!("unit {name}")));
        }

        if let Ok(enabled) = self.enabled_states(ctx).await {
            info.enabled = enabled.get(&name).copied().unwrap_or(false);
        }
        Ok(info)
    }

    async fn start(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "start", unit).await
    }
    async fn stop(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "stop", unit).await
    }
    async fn restart(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "restart", unit).await
    }
    async fn reload(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "reload", unit).await
    }
    async fn enable(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "enable", unit).await
    }
    async fn disable(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.act(ctx, "disable", unit).await
    }

    async fn logs(&self, ctx: &Ctx, p: ServiceLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        self.0.require(cap::SYSTEMD)?;

        let name = qualify(&p.unit);
        let mut args = vec![format!("--unit={name}")];
        if let Some(since) = p.since.as_deref().filter(|s| !s.is_empty()) {
            args.push(format!("--since={}", journal_since(since)?));
        }
        journal(
            ctx,
            JournalQuery {
                args,
                source: name,
                lines: p.lines,
                follow: p.follow,
                filter: Default::default(),
            },
            Some(s),
        )
        .await
    }
}

/* ------------------------------- internals --------------------------- */

impl ServiceOps {
    async fn act(&self, ctx: &Ctx, verb: &str, unit: &str) -> PResult<ServiceInfo> {
        self.0.require(cap::SYSTEMD)?;

        let name = qualify(unit);
        run_with(ctx, ExecOptions::new("systemctl", [verb, name.as_str()]).c_locale()).await?;
        // The unit's own state is what the panel renders, so report it as it
        // is now rather than assuming the verb's intent took effect.
        self.status(ctx, &name).await
    }

    /// Reads the property block for a batch of units in one exec. Blocks
    /// are separated by a blank line and keyed by Id.
    async fn show(&self, ctx: &Ctx, names: &[String]) -> PResult<HashMap<String, ServiceInfo>> {
        let mut args: Vec<String> = vec!["show".into(), "--no-pager".into()];
        for property in UNIT_PROPERTIES {
            args.push(format!("--property={property}"));
        }
        args.extend(names.iter().cloned());

        let out = run_with(ctx, ExecOptions::new("systemctl", args).c_locale()).await?;
        Ok(parse_show(&out, super::system::boot_time_secs()))
    }

    /// Reads the unit-file table once, because asking `is-enabled` per
    /// unit would be one exec per row.
    async fn enabled_states(&self, ctx: &Ctx) -> PResult<HashMap<String, bool>> {
        let out = run_with(
            ctx,
            ExecOptions::new(
                "systemctl",
                ["list-unit-files", "--type=service", "--full", "--plain", "--no-legend", "--no-pager"],
            )
            .c_locale(),
        )
        .await?;
        Ok(parse_unit_files(&out))
    }
}

/// `(unit names, descriptions)` from `systemctl list-units --plain`.
pub fn parse_list_units(out: &str) -> (Vec<String>, HashMap<String, String>) {
    let mut names = Vec::with_capacity(64);
    let mut descriptions = HashMap::new();
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        // A unit systemd cannot find is prefixed with a bullet in some
        // versions; the name is still the first real field.
        let name = fields[0].trim_start_matches('●');
        if name.is_empty() || !name.ends_with(".service") {
            continue;
        }
        names.push(name.to_string());
        if fields.len() > 4 {
            descriptions.insert(name.to_string(), fields[4..].join(" "));
        }
    }
    (names, descriptions)
}

pub fn parse_show(out: &str, boot_secs: u64) -> HashMap<String, ServiceInfo> {
    let mut units = HashMap::new();
    let mut block: HashMap<String, String> = HashMap::new();

    let mut flush = |block: &mut HashMap<String, String>| {
        if block.is_empty() {
            return;
        }
        if let Some(info) = unit_from_properties(block, boot_secs) {
            units.insert(info.unit.clone(), info);
        }
        block.clear();
    };

    for line in out.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            flush(&mut block);
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        block.insert(key.to_string(), value.to_string());
    }
    flush(&mut block);
    units
}

fn unit_from_properties(block: &HashMap<String, String>, boot_secs: u64) -> Option<ServiceInfo> {
    let name = block.get("Id").filter(|n| !n.is_empty())?;
    let get = |k: &str| block.get(k).map(String::as_str).unwrap_or("");

    let mut info = ServiceInfo {
        unit: name.clone(),
        description: get("Description").to_string(),
        load_state: get("LoadState").to_string(),
        active_state: active_state(get("ActiveState")).to_string(),
        sub_state: get("SubState").to_string(),
        ..Default::default()
    };
    if let Ok(pid) = get("MainPID").parse::<i64>() {
        if pid > 0 {
            info.main_pid = Some(pid);
        }
    }
    if let Some(memory) = parse_unsigned(get("MemoryCurrent")) {
        info.memory_current = Some(memory);
    }
    if let Some(cpu_ns) = parse_unsigned(get("CPUUsageNSec")) {
        info.cpu_usage_ns = Some(cpu_ns as f64);
    }
    if let Ok(restarts) = get("NRestarts").parse::<i64>() {
        if restarts >= 0 {
            info.restart_count = restarts;
        }
    }
    // The monotonic timestamp is locale-independent, unlike the human form
    // systemctl prints beside it.
    if let Some(since) = parse_unsigned(get("ActiveEnterTimestampMonotonic")) {
        if since > 0 && boot_secs > 0 {
            info.active_since = Some(epoch_rfc3339(boot_secs as i64 + since / 1_000_000));
        }
    }
    Some(info)
}

pub fn parse_unit_files(out: &str) -> HashMap<String, bool> {
    let mut states = HashMap::new();
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        let enabled = match fields[1] {
            "enabled" | "enabled-runtime" => true,
            _ => false,
        };
        states.insert(fields[0].to_string(), enabled);
    }
    states
}

/// Narrows systemd's vocabulary to the contract's enum, so an unfamiliar
/// value renders as `unknown` instead of breaking validation.
pub fn active_state(value: &str) -> &str {
    match value {
        "active" | "reloading" | "inactive" | "failed" | "activating" | "deactivating" => value,
        _ => "unknown",
    }
}

/// Defaults a bare name to a .service unit, which is what an operator
/// means when they type "nginx".
pub fn qualify(unit: &str) -> String {
    if unit.contains('.') { unit.to_string() } else { format!("{unit}.service") }
}

fn parse_unsigned(value: &str) -> Option<i64> {
    if value.is_empty() || value == UNSET_PROPERTY || value == "[not set]" {
        return None;
    }
    value.parse::<u64>().ok().map(|v| v as i64)
}

pub fn check_unit_state(state: &str) -> PResult<()> {
    match state {
        "active" | "reloading" | "inactive" | "failed" | "activating" | "deactivating" | "running" | "exited"
        | "dead" | "enabled" | "disabled" | "static" => Ok(()),
        _ => Err(invalid(format!("state {state:?} is not a systemd unit state"))),
    }
}

/// Allows a systemd glob and nothing that would confuse systemctl into
/// reading it as an option.
pub fn check_unit_pattern(pattern: &str) -> PResult<()> {
    if pattern.starts_with('-') {
        return Err(invalid("pattern may not start with a dash"));
    }
    for c in pattern.bytes() {
        match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'_' | b'@' | b'*' | b'?' | b'\\' => {}
            _ => return Err(invalid("pattern contains an illegal character")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_units_keeps_service_names_and_descriptions() {
        let out = "nginx.service loaded active running A high performance web server\n\
● ghost.service not-found inactive dead ghost.service\n\
cron.service loaded active running Regular background program processing daemon\n\
dev-sda1.device loaded active plugged /dev/sda1\n";
        let (names, descriptions) = parse_list_units(out);
        assert_eq!(names, vec!["nginx.service", "ghost.service", "cron.service"]);
        assert_eq!(descriptions["nginx.service"], "A high performance web server");
        assert_eq!(descriptions["ghost.service"], "ghost.service");
    }

    #[test]
    fn show_blocks_become_service_infos() {
        let out = "Id=nginx.service\nDescription=nginx\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1234\nMemoryCurrent=10485760\nCPUUsageNSec=5000000\nActiveEnterTimestampMonotonic=60000000\nNRestarts=2\n\nId=cron.service\nDescription=cron\nLoadState=loaded\nActiveState=weird\nSubState=dead\nMainPID=0\nMemoryCurrent=[not set]\nCPUUsageNSec=18446744073709551615\nActiveEnterTimestampMonotonic=0\nNRestarts=0\n";
        let units = parse_show(out, 1_700_000_000);
        assert_eq!(units.len(), 2);
        let nginx = &units["nginx.service"];
        assert_eq!(nginx.main_pid, Some(1234));
        assert_eq!(nginx.memory_current, Some(10485760));
        assert_eq!(nginx.cpu_usage_ns, Some(5_000_000.0));
        assert_eq!(nginx.restart_count, 2);
        assert_eq!(nginx.active_since.as_deref(), Some("2023-11-14T22:14:20Z"));
        let cron = &units["cron.service"];
        assert_eq!(cron.active_state, "unknown");
        assert_eq!(cron.main_pid, None);
        assert_eq!(cron.memory_current, None);
        assert_eq!(cron.cpu_usage_ns, None);
        assert_eq!(cron.active_since, None);
    }

    #[test]
    fn unit_file_states_reduce_to_enabled_or_not() {
        let out = "nginx.service enabled enabled\ncron.service static -\nssh.service enabled-runtime enabled\napt.service disabled enabled\n";
        let states = parse_unit_files(out);
        assert!(states["nginx.service"]);
        assert!(!states["cron.service"]);
        assert!(states["ssh.service"]);
        assert!(!states["apt.service"]);
    }

    #[test]
    fn bare_names_become_service_units() {
        assert_eq!(qualify("nginx"), "nginx.service");
        assert_eq!(qualify("nginx.service"), "nginx.service");
        assert_eq!(qualify("tmp.mount"), "tmp.mount");
    }

    #[test]
    fn patterns_and_states_are_validated() {
        assert!(check_unit_pattern("nginx*").is_ok());
        assert!(check_unit_pattern("getty@*.service").is_ok());
        assert!(check_unit_pattern("--all").is_err());
        assert!(check_unit_pattern("a b").is_err());
        assert!(check_unit_state("failed").is_ok());
        assert!(check_unit_state("bogus").is_err());
    }
}
