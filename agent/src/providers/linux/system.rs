//! Host identity, resource sampling and packages.
//!
//! Identity and metrics come straight from procfs and sysfs: the Go
//! original read them through gopsutil, this port reads the same files
//! itself. Packages go through whichever package manager the distribution
//! actually ships, always as an argv slice — an upgrade is the one
//! operation where a smuggled shell metacharacter would be running as root
//! by design.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;

use super::Shared;
use super::common::{epoch_rfc3339, invalid, now_rfc3339, split_lines, unsupported};
use super::exec::{
    self, ExecOptions, has_binary, is_exit_code, read_trimmed, run, run_raw, run_stream, run_with,
};
use crate::providers::*;

/// Pseudo filesystems carry no capacity an operator can act on, so they
/// are left out of every disk figure rather than inflating the list.
const PSEUDO_FILESYSTEMS: &[&str] = &[
    "autofs",
    "binfmt_misc",
    "bpf",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fuse.gvfsd-fuse",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "overlay",
    "proc",
    "pstore",
    "ramfs",
    "rpc_pipefs",
    "securityfs",
    "selinuxfs",
    "squashfs",
    "sysfs",
    "tracefs",
];

const OS_FAMILIES: &[&str] = &["debian", "ubuntu", "rhel", "fedora", "alpine", "arch"];

/// The previous sample, kept so counters become rates. Without it the
/// panel would plot monotonically rising byte totals.
#[derive(Clone, Debug, Default)]
pub struct MetricsSnapshot {
    pub at: Option<Instant>,
    pub net_rx: u64,
    pub net_tx: u64,
    pub disk_read: u64,
    pub disk_write: u64,
    /// `/proc/stat` jiffies, aggregate first and then one entry per core,
    /// so a cpu percentage is the busy share of the interval rather than
    /// of the whole uptime.
    pub cpu: Vec<CpuTimes>,
}

/// One `cpu` line of `/proc/stat`, reduced to what a percentage needs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

pub struct SystemOps(pub Arc<Shared>);

#[async_trait]
impl System for SystemOps {
    async fn info(&self, ctx: &Ctx) -> PResult<SystemInfo> {
        ctx.check()?;
        let release = read_os_release();
        let platform = release.get("ID").map(|s| s.to_lowercase()).unwrap_or_default();
        let boot = boot_time_secs();
        let uptime = read_uptime_secs();
        let (cpu_model, cpu_cores) = read_cpuinfo();
        let meminfo = read_meminfo();

        Ok(SystemInfo {
            hostname: hostname(),
            machine_id: machine_id(),
            os: platform.clone(),
            os_version: release.get("VERSION_ID").cloned().unwrap_or_default(),
            os_family: os_family(&platform, &release),
            arch: crate::enroll::hostprobe::go_arch(std::env::consts::ARCH).to_string(),
            kernel: kernel_version(),
            boot_time: epoch_rfc3339(boot as i64),
            uptime_seconds: uptime as i64,
            cpu_model,
            cpu_cores: cpu_cores as i64,
            memory_total: meminfo.get("MemTotal").copied().unwrap_or(0) as i64,
            swap_total: meminfo.get("SwapTotal").copied().unwrap_or(0) as i64,
            virtualization: virtualization(),
            timezone: timezone(),
            agent_version: self.0.opts.agent_version.clone(),
            simulated: false,
        })
    }

    async fn metrics(&self, ctx: &Ctx) -> PResult<MetricsSample> {
        ctx.check()?;
        let mut sample = MetricsSample {
            ts: now_rfc3339(),
            disks: Vec::new(),
            ..Default::default()
        };

        let mut current = MetricsSnapshot {
            at: Some(Instant::now()),
            ..Default::default()
        };
        current.cpu = std::fs::read_to_string("/proc/stat")
            .map(|s| parse_cpu_times(&s))
            .unwrap_or_default();

        let meminfo = read_meminfo();
        let (used, total, cached) = memory_figures(&meminfo);
        sample.memory_used = used as i64;
        sample.memory_total = total as i64;
        sample.memory_cached = Some(cached as i64);
        let swap_total = meminfo.get("SwapTotal").copied().unwrap_or(0);
        let swap_free = meminfo.get("SwapFree").copied().unwrap_or(0);
        sample.swap_total = swap_total as i64;
        sample.swap_used = swap_total.saturating_sub(swap_free) as i64;

        if let Ok(raw) = std::fs::read_to_string("/proc/loadavg") {
            if let Some((l1, l5, l15)) = parse_loadavg(&raw) {
                sample.load1 = l1;
                sample.load5 = l5;
                sample.load15 = l15;
            }
        }
        sample.processes = count_processes() as i64;
        if let Ok(disks) = collect_disks(ctx).await {
            sample.disks = disks;
        }

        if let Ok(raw) = std::fs::read_to_string("/proc/net/dev") {
            let (rx, tx) = parse_net_dev(&raw);
            current.net_rx = rx;
            current.net_tx = tx;
        }
        if let Ok(raw) = std::fs::read_to_string("/proc/diskstats") {
            let (read, write) = parse_diskstats(&raw, &block_devices());
            current.disk_read = read;
            current.disk_write = write;
        }
        sample.net_rx_bytes = current.net_rx as i64;
        sample.net_tx_bytes = current.net_tx as i64;

        let previous = self.0.last_metrics.lock().replace(current.clone());

        // Interval 0 in the Go original measured against gopsutil's previous
        // call, which is the agent's own 15-second cadence rather than a
        // blocking sleep here. The first sample has nothing to compare with
        // and reports the share of the whole uptime instead.
        let baseline: Vec<CpuTimes> = previous
            .as_ref()
            .map(|p| p.cpu.clone())
            .filter(|cpu| cpu.len() == current.cpu.len())
            .unwrap_or_else(|| vec![CpuTimes::default(); current.cpu.len()]);
        if let (Some(now), Some(then)) = (current.cpu.first(), baseline.first()) {
            sample.cpu_percent = cpu_percent(*then, *now);
        }
        if current.cpu.len() > 1 {
            sample.cpu_per_core = current.cpu[1..]
                .iter()
                .zip(baseline[1..].iter())
                .map(|(now, then)| cpu_percent(*then, *now))
                .collect();
        }

        if let Some(previous) = previous {
            if let (Some(then), Some(now)) = (previous.at, current.at) {
                let elapsed = now.duration_since(then).as_secs_f64();
                if elapsed > 0.0 {
                    sample.net_rx_rate = rate(previous.net_rx, current.net_rx, elapsed);
                    sample.net_tx_rate = rate(previous.net_tx, current.net_tx, elapsed);
                    sample.disk_read_rate = Some(rate(previous.disk_read, current.disk_read, elapsed));
                    sample.disk_write_rate = Some(rate(previous.disk_write, current.disk_write, elapsed));
                }
            }
        }
        Ok(sample)
    }

    async fn reboot(&self, ctx: &Ctx, p: SystemRebootParams) -> PResult<()> {
        if p.delay_seconds <= 0 {
            if self.0.has(cap::SYSTEMD) {
                run(ctx, "systemctl", &["reboot"]).await?;
                return Ok(());
            }
            run(ctx, "shutdown", &["-r", "now"]).await?;
            return Ok(());
        }

        // A transient timer gives second granularity; `shutdown` only speaks
        // whole minutes, so it rounds up rather than rebooting early.
        if self.0.has(cap::SYSTEMD) && has_binary("systemd-run") {
            let on_active = format!("--on-active={}s", p.delay_seconds);
            run(
                ctx,
                "systemd-run",
                &[
                    &on_active,
                    "--timer-property=AccuracySec=1s",
                    "systemctl",
                    "reboot",
                ],
            )
            .await?;
            return Ok(());
        }

        let minutes = (p.delay_seconds + 59) / 60;
        run(ctx, "shutdown", &["-r", &format!("+{minutes}")]).await?;
        Ok(())
    }

    async fn list_packages(&self, ctx: &Ctx, p: PackagesListParams) -> PResult<Vec<PackageInfo>> {
        let Some(manager) = detect_package_manager() else {
            return Err(unsupported("no supported package manager on this host"));
        };

        let upgradable = upgradable_packages(ctx, manager).await?;
        if p.upgradable_only {
            let mut out: Vec<PackageInfo> = upgradable.into_values().collect();
            sort_packages(&mut out);
            return Ok(out);
        }

        let mut installed = installed_packages(ctx, manager).await?;
        for entry in installed.iter_mut() {
            if let Some(pending) = upgradable.get(&entry.name) {
                entry.available_version = pending.available_version.clone();
                entry.security = pending.security;
            }
        }
        sort_packages(&mut installed);
        Ok(installed)
    }

    async fn upgrade_packages(
        &self,
        ctx: &Ctx,
        p: PackagesUpgradeParams,
        s: StreamRef,
    ) -> PResult<PackagesUpgradeResult> {
        let Some(manager) = detect_package_manager() else {
            return Err(unsupported("no supported package manager on this host"));
        };

        let mut names = p.names.clone();
        if p.security_only && names.is_empty() {
            let pending = upgradable_packages(ctx, manager).await?;
            for (name, entry) in pending {
                if entry.security {
                    names.push(name);
                }
            }
            if names.is_empty() {
                return Ok(PackagesUpgradeResult {
                    upgraded: Vec::new(),
                    reboot_required: reboot_required(ctx).await,
                });
            }
        }
        for name in &names {
            check_package_name(name)?;
        }

        let mut options = ExecOptions::default()
            .c_locale()
            .env("DEBIAN_FRONTEND", "noninteractive");
        match manager {
            PackageManager::Apt => {
                options.name = "apt-get".into();
                // `upgrade` takes no package list, so a targeted upgrade is an
                // `install --only-upgrade` instead.
                let mut args: Vec<String> = ["-y", "-o", "Dpkg::Options::=--force-confold"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                if !names.is_empty() {
                    args.push("install".into());
                    args.push("--only-upgrade".into());
                    args.extend(names.iter().cloned());
                } else {
                    args.push("upgrade".into());
                }
                options.args = args;
            }
            PackageManager::Dnf | PackageManager::Yum => {
                options.name = manager.binary().into();
                let mut args = vec!["-y".to_string(), "upgrade".to_string()];
                args.extend(names.iter().cloned());
                if p.security_only && p.names.is_empty() {
                    args = vec!["-y".into(), "--security".into(), "upgrade".into()];
                }
                options.args = args;
            }
            PackageManager::Apk => {
                options.name = "apk".into();
                let mut args = vec!["upgrade".to_string()];
                args.extend(names.iter().cloned());
                options.args = args;
            }
            PackageManager::Pacman => {
                options.name = "pacman".into();
                let mut args = vec!["--noconfirm".to_string(), "-Syu".to_string()];
                args.extend(names.iter().cloned());
                options.args = args;
            }
        }

        let out = run_stream(ctx, s.as_ref(), options.clone(), None).await?;
        if !out.success() {
            return Err(exec::exec_error(&options.name, &out.stdout, out.code));
        }

        Ok(PackagesUpgradeResult {
            upgraded: names,
            reboot_required: reboot_required(ctx).await,
        })
    }

    async fn self_update(&self, ctx: &Ctx, p: SelfUpdateParams, s: StreamRef) -> PResult<SelfUpdateResult> {
        super::selfupdate::self_update(&self.0, ctx, p, s).await
    }
}

/* ------------------------------ packages ----------------------------- */

/// The distribution's own tool. Detection is by binary rather than by
/// /etc/os-release, because that is what actually decides whether a
/// command will work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Apt,
    Dnf,
    Yum,
    Apk,
    Pacman,
}

impl PackageManager {
    fn binary(self) -> &'static str {
        match self {
            PackageManager::Apt => "apt",
            PackageManager::Dnf => "dnf",
            PackageManager::Yum => "yum",
            PackageManager::Apk => "apk",
            PackageManager::Pacman => "pacman",
        }
    }
}

pub fn detect_package_manager() -> Option<PackageManager> {
    if has_binary("apt-get") && has_binary("dpkg-query") {
        Some(PackageManager::Apt)
    } else if has_binary("dnf") {
        Some(PackageManager::Dnf)
    } else if has_binary("yum") {
        Some(PackageManager::Yum)
    } else if has_binary("apk") {
        Some(PackageManager::Apk)
    } else if has_binary("pacman") {
        Some(PackageManager::Pacman)
    } else {
        None
    }
}

async fn installed_packages(ctx: &Ctx, manager: PackageManager) -> PResult<Vec<PackageInfo>> {
    match manager {
        PackageManager::Apt => {
            let out = run(ctx, "dpkg-query", &["-W", "-f=${binary:Package}\t${Version}\n"]).await?;
            Ok(parse_tabbed_packages(&out))
        }
        PackageManager::Dnf | PackageManager::Yum => {
            let out = run(ctx, "rpm", &["-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"]).await?;
            Ok(parse_tabbed_packages(&out))
        }
        PackageManager::Apk => {
            let out = run(ctx, "apk", &["info", "-v"]).await?;
            Ok(parse_apk_installed(&out))
        }
        PackageManager::Pacman => {
            let out = run(ctx, "pacman", &["-Q"]).await?;
            Ok(parse_pacman_installed(&out))
        }
    }
}

async fn upgradable_packages(ctx: &Ctx, manager: PackageManager) -> PResult<HashMap<String, PackageInfo>> {
    match manager {
        PackageManager::Apt => {
            // `apt-get -s upgrade` is a dry run whose `Inst` lines carry the
            // origin, which is the only place the security suite is visible.
            let out = run_with(
                ctx,
                ExecOptions::new("apt-get", ["-s", "-q", "-o", "Debug::NoLocking=true", "upgrade"])
                    .c_locale()
                    .env("DEBIAN_FRONTEND", "noninteractive"),
            )
            .await?;
            Ok(parse_apt_upgradable(&out))
        }
        PackageManager::Dnf | PackageManager::Yum => {
            // check-update exits 100 when updates exist, which is success here.
            let bin = manager.binary();
            let out = match run_with(ctx, ExecOptions::new(bin, ["-q", "check-update"]).c_locale()).await {
                Ok(out) => out,
                Err(err) if is_exit_code(&err, 100) => exec_output_of(&err),
                Err(err) => return Err(err),
            };
            let secure = match run_with(
                ctx,
                ExecOptions::new(bin, ["-q", "--security", "check-update"]).c_locale(),
            )
            .await
            {
                Ok(out) => Some(out),
                Err(err) if is_exit_code(&err, 100) => Some(exec_output_of(&err)),
                Err(_) => None,
            };
            Ok(parse_rpm_check_update(&out, secure.as_deref()))
        }
        PackageManager::Apk => {
            let out = run(ctx, "apk", &["version", "-l", "<"]).await?;
            Ok(parse_apk_upgradable(&out))
        }
        PackageManager::Pacman => {
            let out = match run_with(ctx, ExecOptions::new("pacman", ["-Qu"])).await {
                Ok(out) => out,
                Err(err) if is_exit_code(&err, 1) => exec_output_of(&err),
                Err(err) => return Err(err),
            };
            Ok(parse_pacman_upgradable(&out))
        }
    }
}

/// The captured output of a failed exec. A package manager that exits
/// non-zero to mean "there are updates" still printed its list, and
/// `run_with` keeps it in the error (stderr first, else stdout).
fn exec_output_of(err: &ProviderError) -> String {
    match err {
        ProviderError::Exec { output, .. } => output.clone(),
        _ => String::new(),
    }
}

/// Answers the question a package upgrade leaves open, in whichever way
/// the distribution records it.
async fn reboot_required(ctx: &Ctx) -> bool {
    if exec::file_exists("/var/run/reboot-required") || exec::file_exists("/run/reboot-required") {
        return true;
    }
    if has_binary("needs-restarting") {
        return match run_raw(ctx, &ExecOptions::new("needs-restarting", ["-r"])).await {
            Ok(out) => out.code == Some(1),
            Err(_) => false,
        };
    }
    false
}

pub fn parse_tabbed_packages(out: &str) -> Vec<PackageInfo> {
    let mut packages = Vec::with_capacity(128);
    for line in split_lines(out) {
        let Some((name, version)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        packages.push(PackageInfo {
            name: name.to_string(),
            installed_version: version.trim().to_string(),
            available_version: None,
            security: false,
        });
    }
    packages
}

pub fn parse_apk_installed(out: &str) -> Vec<PackageInfo> {
    let mut packages = Vec::with_capacity(64);
    for line in split_lines(out) {
        let Some((name, version)) = split_apk_version(line.trim()) else {
            continue;
        };
        packages.push(PackageInfo {
            name: name.to_string(),
            installed_version: version.to_string(),
            available_version: None,
            security: false,
        });
    }
    packages
}

pub fn parse_pacman_installed(out: &str) -> Vec<PackageInfo> {
    let mut packages = Vec::with_capacity(64);
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        packages.push(PackageInfo {
            name: fields[0].to_string(),
            installed_version: fields[1].to_string(),
            available_version: None,
            security: false,
        });
    }
    packages
}

pub fn parse_apt_upgradable(out: &str) -> HashMap<String, PackageInfo> {
    let mut pending = HashMap::new();
    for line in split_lines(out) {
        if !line.starts_with("Inst ") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let name = fields[1];
        let installed = fields[2].trim_matches(|c| c == '[' || c == ']');
        let mut available = String::new();
        if let Some(open) = line.find('(') {
            if let Some(first) = line[open + 1..].split_whitespace().next() {
                available = first.to_string();
            }
        }
        pending.insert(
            name.to_string(),
            PackageInfo {
                name: name.to_string(),
                installed_version: installed.to_string(),
                available_version: Some(available),
                security: line.contains("-security") || line.contains("Debian-Security"),
            },
        );
    }
    pending
}

pub fn parse_rpm_check_update(out: &str, secure: Option<&str>) -> HashMap<String, PackageInfo> {
    let mut security: HashSet<String> = HashSet::new();
    if let Some(secure) = secure {
        for line in split_lines(secure) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 2 {
                security.insert(trim_rpm_arch(fields[0]).to_string());
            }
        }
    }
    let mut pending = HashMap::new();
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || line.ends_with(':') {
            continue;
        }
        let name = trim_rpm_arch(fields[0]).to_string();
        let is_security = security.contains(&name);
        pending.insert(
            name.clone(),
            PackageInfo {
                name,
                installed_version: String::new(),
                available_version: Some(fields[1].to_string()),
                security: is_security,
            },
        );
    }
    pending
}

pub fn parse_apk_upgradable(out: &str) -> HashMap<String, PackageInfo> {
    let mut pending = HashMap::new();
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || fields[1] != "<" {
            continue;
        }
        let Some((name, installed)) = split_apk_version(fields[0]) else {
            continue;
        };
        pending.insert(
            name.to_string(),
            PackageInfo {
                name: name.to_string(),
                installed_version: installed.to_string(),
                available_version: Some(fields[2].to_string()),
                security: false,
            },
        );
    }
    pending
}

pub fn parse_pacman_upgradable(out: &str) -> HashMap<String, PackageInfo> {
    let mut pending = HashMap::new();
    for line in split_lines(out) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        pending.insert(
            fields[0].to_string(),
            PackageInfo {
                name: fields[0].to_string(),
                installed_version: fields[1].to_string(),
                available_version: Some(fields[3].to_string()),
                security: false,
            },
        );
    }
    pending
}

/// Splits apk's `name-1.2.3-r0` on the last two dashes, which is the only
/// place the version reliably begins.
pub fn split_apk_version(entry: &str) -> Option<(&str, &str)> {
    let release = entry.rfind('-')?;
    if release == 0 {
        return None;
    }
    let version = entry[..release].rfind('-')?;
    if version == 0 {
        return None;
    }
    Some((&entry[..version], &entry[version + 1..]))
}

pub fn trim_rpm_arch(entry: &str) -> &str {
    match entry.rfind('.') {
        Some(dot) if dot > 0 => &entry[..dot],
        _ => entry,
    }
}

fn sort_packages(packages: &mut [PackageInfo]) {
    packages.sort_by(|a, b| a.name.cmp(&b.name));
}

/// Keeps an option-looking argument out of the package list; argv already
/// prevents a shell, this prevents a flag.
pub fn check_package_name(name: &str) -> PResult<()> {
    if name.is_empty() || name.len() > 128 || name.starts_with('-') {
        return Err(invalid(format!("package name {name:?} is not usable")));
    }
    for c in name.bytes() {
        match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'_' | b'+' | b':' => {}
            _ => {
                return Err(invalid(format!(
                    "package name {name:?} contains an illegal character"
                )));
            }
        }
    }
    Ok(())
}

/* ------------------------------- disks ------------------------------- */

/// Every real filesystem with its capacity, from `/proc/mounts` and
/// `statvfs`. Pseudo filesystems and repeated mountpoints are skipped, and
/// so is anything that reports zero capacity.
pub async fn collect_disks(ctx: &Ctx) -> PResult<Vec<DiskUsage>> {
    ctx.check()?;
    let mounts = std::fs::read_to_string("/proc/mounts")
        .map_err(|e| ProviderError::internal(format!("read partitions: {e}")))?;
    let partitions = parse_mounts(&mounts);

    let mut seen = HashSet::new();
    let mut disks = Vec::with_capacity(partitions.len());
    for (device, mount, fstype) in partitions {
        if PSEUDO_FILESYSTEMS.contains(&fstype.as_str()) {
            continue;
        }
        if seen.contains(&mount) {
            continue;
        }
        let Ok(stat) = nix::sys::statvfs::statvfs(mount.as_str()) else {
            continue;
        };
        let block = stat.fragment_size() as u64;
        let total = stat.blocks() as u64 * block;
        if total == 0 {
            continue;
        }
        seen.insert(mount.clone());

        // gopsutil's figures: `free` is what an unprivileged user may still
        // write, `used` is what is gone from the whole device, and the
        // percentage is of the space a user can reach at all.
        let free = stat.blocks_available() as u64 * block;
        let used = total.saturating_sub(stat.blocks_free() as u64 * block);
        let reachable = used + free;
        let used_percent = if reachable > 0 {
            clamp_percent(used as f64 / reachable as f64 * 100.0)
        } else {
            0.0
        };

        let mut entry = DiskUsage {
            mount,
            device,
            fstype,
            total: total as i64,
            used: used as i64,
            available: free as i64,
            used_percent,
            inodes_total: None,
            inodes_used: None,
        };
        let inodes_total = stat.files() as u64;
        if inodes_total > 0 {
            entry.inodes_total = Some(inodes_total as i64);
            entry.inodes_used = Some(inodes_total.saturating_sub(stat.files_free() as u64) as i64);
        }
        disks.push(entry);
    }
    Ok(disks)
}

/// `(device, mountpoint, fstype)` for each line of `/proc/mounts`, with
/// the octal escapes the kernel uses for spaces in mountpoints decoded.
pub fn parse_mounts(raw: &str) -> Vec<(String, String, String)> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let device = fields.next()?;
            let mount = fields.next()?;
            let fstype = fields.next()?;
            Some((unescape_mount(device), unescape_mount(mount), fstype.to_string()))
        })
        .collect()
}

fn unescape_mount(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            if let Ok(code) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 4]).unwrap_or("x"), 8)
            {
                out.push(code);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ------------------------------ identity ----------------------------- */

pub fn read_os_release() -> HashMap<String, String> {
    for candidate in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(raw) = std::fs::read_to_string(candidate) {
            return super::common::parse_kv(&raw);
        }
    }
    HashMap::new()
}

fn hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| read_trimmed("/proc/sys/kernel/hostname"))
}

fn kernel_version() -> String {
    nix::sys::utsname::uname()
        .ok()
        .and_then(|u| u.release().to_str().map(str::to_string))
        .unwrap_or_else(|| read_trimmed("/proc/sys/kernel/osrelease"))
}

fn machine_id() -> String {
    for candidate in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        let id = read_trimmed(candidate);
        if !id.is_empty() {
            return id;
        }
    }
    // gopsutil's HostID fallback: the firmware's product uuid.
    read_trimmed("/sys/class/dmi/id/product_uuid").to_lowercase()
}

/// Narrows the distribution to the contract's family enum. The platform
/// itself wins when it is a family name; otherwise the parents it declares
/// in ID_LIKE decide, and anything else is `other`.
pub fn os_family(platform: &str, release: &HashMap<String, String>) -> String {
    let platform = platform.to_lowercase();
    if OS_FAMILIES.contains(&platform.as_str()) {
        return platform;
    }
    // The distributions gopsutil folds into a family by name.
    let family = match platform.as_str() {
        "linuxmint" | "raspbian" | "pop" | "kali" | "devuan" | "elementary" | "neon" | "zorin" => "debian",
        "centos" | "rocky" | "almalinux" | "ol" | "oracle" | "amzn" | "scientific" | "cloudlinux"
        | "redhat" => "rhel",
        "manjaro" | "endeavouros" | "artix" | "garuda" => "arch",
        "postmarketos" => "alpine",
        _ => "",
    };
    if !family.is_empty() {
        return family.to_string();
    }
    if let Some(like) = release.get("ID_LIKE") {
        for candidate in like.to_lowercase().split_whitespace() {
            if OS_FAMILIES.contains(&candidate) {
                return candidate.to_string();
            }
        }
    }
    "other".to_string()
}

fn timezone() -> String {
    let zone = read_trimmed("/etc/timezone");
    if !zone.is_empty() {
        return zone;
    }
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let target = target.to_string_lossy();
        if let Some(index) = target.find("zoneinfo/") {
            return target[index + "zoneinfo/".len()..].to_string();
        }
    }
    std::env::var("TZ")
        .ok()
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "UTC".to_string())
}

/// The hypervisor or container runtime this host runs under, read the way
/// gopsutil does: from the kernel's own traces of it.
fn virtualization() -> Option<String> {
    let system = detect_virtualization(&|p| std::fs::read_to_string(p).unwrap_or_default(), &|p| {
        Path::new(p).exists()
    });
    if system.is_empty() { None } else { Some(system) }
}

pub fn detect_virtualization(read: &dyn Fn(&str) -> String, exists: &dyn Fn(&str) -> bool) -> String {
    if exists("/proc/xen") {
        return "xen".into();
    }
    let modules = read("/proc/modules");
    if modules.contains("kvm") {
        return "kvm".into();
    }
    if modules.contains("vboxdrv") || modules.contains("vboxguest") {
        return "vbox".into();
    }
    if modules.contains("vmwgfx") || modules.contains("vmw_vsock") {
        return "vmware".into();
    }
    let cpuinfo = read("/proc/cpuinfo");
    if cpuinfo.contains("QEMU Virtual CPU")
        || cpuinfo.contains("Common KVM processor")
        || cpuinfo.contains("Common 32-bit KVM processor")
    {
        return "kvm".into();
    }
    if exists("/proc/bc") && !exists("/proc/vz") {
        return "openvz".into();
    }
    if exists("/proc/vz") {
        return "openvz".into();
    }
    let status = read("/proc/self/status");
    if status
        .lines()
        .any(|l| l.starts_with("VxID:") && l.split_whitespace().nth(1).is_some_and(|v| v != "0"))
    {
        return "linux-vserver".into();
    }
    let cgroup = read("/proc/1/cgroup");
    if cgroup.contains("lxc") {
        return "lxc".into();
    }
    if cgroup.contains("docker") {
        return "docker".into();
    }
    if exists("/.dockerenv") {
        return "docker".into();
    }
    let product = read("/sys/class/dmi/id/product_name").to_lowercase();
    let vendor = read("/sys/class/dmi/id/sys_vendor").to_lowercase();
    if product.contains("vmware") || vendor.contains("vmware") {
        return "vmware".into();
    }
    if product.contains("virtualbox") {
        return "vbox".into();
    }
    if product.contains("kvm") || product.contains("openstack") || vendor.contains("qemu") {
        return "kvm".into();
    }
    if product.contains("virtual machine") || vendor.contains("microsoft") {
        return "hyperv".into();
    }
    if product.contains("hvm domu") || vendor.contains("xen") {
        return "xen".into();
    }
    if product.contains("bochs") {
        return "bochs".into();
    }
    String::new()
}

/* ------------------------------- procfs ------------------------------ */

pub fn boot_time_secs() -> u64 {
    std::fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|s| parse_btime(&s))
        .unwrap_or(0)
}

pub fn parse_btime(stat: &str) -> Option<u64> {
    stat.lines()
        .find_map(|l| l.strip_prefix("btime "))
        .and_then(|v| v.trim().parse().ok())
}

fn read_uptime_secs() -> u64 {
    read_trimmed("/proc/uptime")
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v as u64)
        .unwrap_or(0)
}

/// `(model name, logical cores)` from `/proc/cpuinfo`, falling back to the
/// scheduler's view of the core count when the file has no `processor`
/// lines (some arm64 kernels).
fn read_cpuinfo() -> (String, usize) {
    let raw = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let (model, cores) = parse_cpuinfo(&raw);
    let cores = if cores > 0 {
        cores
    } else {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    };
    (model, cores)
}

pub fn parse_cpuinfo(raw: &str) -> (String, usize) {
    let mut model = String::new();
    let mut cores = 0;
    for line in raw.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "processor" => cores += 1,
            "model name" | "Model" | "cpu model" | "Hardware" if model.is_empty() => {
                model = value.trim().to_string()
            }
            _ => {}
        }
    }
    (model, cores)
}

/// `/proc/meminfo` in bytes.
fn read_meminfo() -> HashMap<String, u64> {
    std::fs::read_to_string("/proc/meminfo")
        .map(|s| parse_meminfo(&s))
        .unwrap_or_default()
}

pub fn parse_meminfo(raw: &str) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    for line in raw.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let Some(value) = fields.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let multiplier = match fields.next() {
            Some("kB") => 1024,
            Some("mB") => 1024 * 1024,
            _ => 1,
        };
        out.insert(key.trim().to_string(), value * multiplier);
    }
    out
}

/// `(used, total, cached)` the way gopsutil derives them: used is what is
/// left after free memory, buffers and the reclaimable cache are set aside.
pub fn memory_figures(meminfo: &HashMap<String, u64>) -> (u64, u64, u64) {
    let get = |k: &str| meminfo.get(k).copied().unwrap_or(0);
    let total = get("MemTotal");
    let cached = get("Cached") + get("SReclaimable");
    let used = total
        .saturating_sub(get("MemFree"))
        .saturating_sub(get("Buffers"))
        .saturating_sub(cached);
    (used, total, cached)
}

pub fn parse_loadavg(raw: &str) -> Option<(f64, f64, f64)> {
    let mut fields = raw.split_whitespace();
    let l1 = fields.next()?.parse().ok()?;
    let l5 = fields.next()?.parse().ok()?;
    let l15 = fields.next()?.parse().ok()?;
    Some((l1, l5, l15))
}

/// How many processes there are, which is how many numeric entries `/proc`
/// has.
fn count_processes() -> usize {
    std::fs::read_dir("/proc")
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
                })
                .count()
        })
        .unwrap_or(0)
}

/// The `cpu` lines of `/proc/stat`: the aggregate first, then one per
/// core. Busy time is everything but idle and iowait, as gopsutil counts it.
pub fn parse_cpu_times(stat: &str) -> Vec<CpuTimes> {
    let mut out = Vec::new();
    for line in stat.lines() {
        if !line.starts_with("cpu") {
            if !out.is_empty() {
                break;
            }
            continue;
        }
        let values: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .filter_map(|v| v.parse().ok())
            .collect();
        if values.len() < 4 {
            continue;
        }
        let total: u64 = values.iter().take(8).sum();
        let idle = values[3] + values.get(4).copied().unwrap_or(0);
        out.push(CpuTimes {
            busy: total.saturating_sub(idle),
            total,
        });
    }
    out
}

pub fn cpu_percent(previous: CpuTimes, current: CpuTimes) -> f64 {
    let total = current.total.saturating_sub(previous.total);
    if total == 0 {
        return 0.0;
    }
    let busy = current.busy.saturating_sub(previous.busy);
    clamp_percent(busy as f64 / total as f64 * 100.0)
}

/// `(bytes received, bytes sent)` summed over every interface, loopback
/// included, as gopsutil's non-per-nic counters are.
pub fn parse_net_dev(raw: &str) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in raw.lines().skip(2) {
        let Some((_, rest)) = line.split_once(':') else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        rx += fields[0].parse::<u64>().unwrap_or(0);
        tx += fields[8].parse::<u64>().unwrap_or(0);
    }
    (rx, tx)
}

/// `(bytes read, bytes written)` summed over the named whole devices;
/// partitions are left out so a disk is not counted once per partition.
pub fn parse_diskstats(raw: &str, devices: &HashSet<String>) -> (u64, u64) {
    let mut read = 0u64;
    let mut write = 0u64;
    for line in raw.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        if !devices.is_empty() && !devices.contains(fields[2]) {
            continue;
        }
        // Sectors are always 512 bytes in diskstats regardless of the
        // device's own sector size.
        read += fields[5].parse::<u64>().unwrap_or(0) * 512;
        write += fields[9].parse::<u64>().unwrap_or(0) * 512;
    }
    (read, write)
}

/// The whole block devices worth counting I/O for. Loop and ram devices
/// carry no spinning or flash medium behind them.
fn block_devices() -> HashSet<String> {
    std::fs::read_dir("/sys/block")
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with("loop") && !n.starts_with("ram"))
                .collect()
        })
        .unwrap_or_default()
}

/* ------------------------------- numbers ----------------------------- */

/// Turns two counter readings into bytes per second, treating a counter
/// that went backwards as a reset rather than a negative rate.
pub fn rate(previous: u64, current: u64, seconds: f64) -> f64 {
    if current < previous || seconds <= 0.0 {
        return 0.0;
    }
    ((current - previous) as f64 / seconds * 100.0).round() / 100.0
}

pub fn clamp_percent(value: f64) -> f64 {
    if value.is_nan() || value < 0.0 {
        return 0.0;
    }
    if value > 100.0 {
        return 100.0;
    }
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apk_versions_split_on_the_last_two_dashes() {
        assert_eq!(
            split_apk_version("openssl-3.1.4-r5"),
            Some(("openssl", "3.1.4-r5"))
        );
        assert_eq!(
            split_apk_version("py3-pip-23.3.1-r0"),
            Some(("py3-pip", "23.3.1-r0"))
        );
        assert_eq!(split_apk_version("nodash"), None);
        assert_eq!(split_apk_version("one-dash"), None);
    }

    #[test]
    fn rpm_arch_suffix_is_trimmed() {
        assert_eq!(trim_rpm_arch("openssl.x86_64"), "openssl");
        assert_eq!(trim_rpm_arch("kernel-core.noarch"), "kernel-core");
        assert_eq!(trim_rpm_arch("plain"), "plain");
    }

    #[test]
    fn package_names_reject_flags_and_metacharacters() {
        assert!(check_package_name("nginx").is_ok());
        assert!(check_package_name("libssl3:amd64").is_ok());
        assert!(check_package_name("g++").is_ok());
        assert!(check_package_name("-y").is_err());
        assert!(check_package_name("nginx; rm -rf /").is_err());
        assert!(check_package_name("").is_err());
    }

    #[test]
    fn tabbed_package_lines_parse() {
        let out = "nginx\t1.24.0-2\nopenssl\t3.0.11-1~deb12u2\n\tbroken\n";
        let packages = parse_tabbed_packages(out);
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0].name, "nginx");
        assert_eq!(packages[1].installed_version, "3.0.11-1~deb12u2");
    }

    #[test]
    fn apt_dry_run_marks_security_updates() {
        let out = "Reading package lists...\n\
Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])\n\
Inst nginx [1.22.1-9] (1.22.1-9+deb12u1 Debian:12.5/stable [amd64])\n\
Conf libssl3 (3.0.11-1~deb12u2 Debian-Security:12/stable-security [amd64])\n";
        let pending = parse_apt_upgradable(out);
        assert_eq!(pending.len(), 2);
        let ssl = &pending["libssl3"];
        assert_eq!(ssl.installed_version, "3.0.11-1~deb12u1");
        assert_eq!(ssl.available_version.as_deref(), Some("3.0.11-1~deb12u2"));
        assert!(ssl.security);
        assert!(!pending["nginx"].security);
    }

    #[test]
    fn dnf_check_update_skips_headings_and_flags_security() {
        let out = "\nopenssl.x86_64    1:3.0.7-24.el9    baseos\nvim-minimal.x86_64   2:8.2.2637-20.el9   baseos\nObsoleting Packages:\n";
        let secure = "openssl.x86_64    1:3.0.7-24.el9    baseos\n";
        let pending = parse_rpm_check_update(out, Some(secure));
        assert_eq!(pending.len(), 2);
        assert!(pending["openssl"].security);
        assert!(!pending["vim-minimal"].security);
        assert_eq!(
            pending["openssl"].available_version.as_deref(),
            Some("1:3.0.7-24.el9")
        );
    }

    #[test]
    fn apk_and_pacman_upgrade_lists_parse() {
        let apk = parse_apk_upgradable("busybox-1.36.1-r15 < 1.36.1-r19\nmusl-1.2.4-r2 = 1.2.4-r2\n");
        assert_eq!(apk.len(), 1);
        assert_eq!(apk["busybox"].installed_version, "1.36.1-r15");
        assert_eq!(apk["busybox"].available_version.as_deref(), Some("1.36.1-r19"));

        let pacman = parse_pacman_upgradable("linux 6.6.1.arch1-1 -> 6.6.2.arch1-1\n");
        assert_eq!(pacman["linux"].installed_version, "6.6.1.arch1-1");
        assert_eq!(
            pacman["linux"].available_version.as_deref(),
            Some("6.6.2.arch1-1")
        );
    }

    #[test]
    fn mounts_decode_octal_escapes_and_keep_fields() {
        let raw = "/dev/sda1 / ext4 rw,relatime 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n";
        let mounts = parse_mounts(raw);
        assert_eq!(mounts.len(), 3);
        assert_eq!(mounts[0], ("/dev/sda1".into(), "/".into(), "ext4".into()));
        assert_eq!(mounts[2].1, "/mnt/my disk");
    }

    #[test]
    fn cpu_times_turn_into_interval_percentages() {
        let before = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nintr 1 2 3\n";
        let after =
            "cpu  200 0 200 1400 0 0 0 0 0 0\ncpu0 150 0 150 500 0 0 0 0 0 0\ncpu1 50 0 50 900 0 0 0 0 0 0\n";
        let then = parse_cpu_times(before);
        let now = parse_cpu_times(after);
        assert_eq!(then.len(), 3);
        assert_eq!(cpu_percent(then[0], now[0]), 25.0);
        assert_eq!(cpu_percent(then[1], now[1]), 66.67);
        assert_eq!(cpu_percent(then[2], now[2]), 0.0);
        assert_eq!(cpu_percent(now[0], then[0]), 0.0);
    }

    #[test]
    fn meminfo_is_in_bytes_and_used_excludes_cache() {
        let raw = "MemTotal:       16000 kB\nMemFree:         4000 kB\nBuffers:          500 kB\nCached:          2000 kB\nSReclaimable:     500 kB\nSwapTotal:       1000 kB\nSwapFree:         800 kB\nHugePages_Total:       0\n";
        let mem = parse_meminfo(raw);
        assert_eq!(mem["MemTotal"], 16000 * 1024);
        assert_eq!(mem["HugePages_Total"], 0);
        let (used, total, cached) = memory_figures(&mem);
        assert_eq!(total, 16000 * 1024);
        assert_eq!(cached, 2500 * 1024);
        assert_eq!(used, 9000 * 1024);
    }

    #[test]
    fn loadavg_btime_netdev_and_diskstats_parse() {
        assert_eq!(
            parse_loadavg("0.52 0.58 0.59 2/1234 5678\n"),
            Some((0.52, 0.58, 0.59))
        );
        assert_eq!(
            parse_btime("cpu 1 2 3 4\nbtime 1700000000\nprocesses 5\n"),
            Some(1700000000)
        );

        let net = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0\n";
        assert_eq!(parse_net_dev(net), (6000, 9000));

        let disk = "   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0 0 0 0 0 0 0\n   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0 0 0 0 0 0 0\n   7       0 loop0 1 0 16 0 0 0 0 0 0 0 0\n";
        let devices: HashSet<String> = ["sda".to_string()].into_iter().collect();
        assert_eq!(parse_diskstats(disk, &devices), (2000 * 512, 4000 * 512));
    }

    #[test]
    fn rates_treat_a_counter_reset_as_zero() {
        assert_eq!(rate(100, 300, 2.0), 100.0);
        assert_eq!(rate(300, 100, 2.0), 0.0);
        assert_eq!(rate(100, 300, 0.0), 0.0);
        assert_eq!(rate(0, 1, 3.0), 0.33);
    }

    #[test]
    fn percentages_are_clamped_and_rounded() {
        assert_eq!(clamp_percent(-1.0), 0.0);
        assert_eq!(clamp_percent(101.0), 100.0);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
        assert_eq!(clamp_percent(33.3333), 33.33);
    }

    #[test]
    fn os_family_uses_the_platform_then_its_parents() {
        let mut release = HashMap::new();
        assert_eq!(os_family("ubuntu", &release), "ubuntu");
        assert_eq!(os_family("rocky", &release), "rhel");
        release.insert("ID_LIKE".to_string(), "arch".to_string());
        assert_eq!(os_family("endeavouros", &release), "arch");
        release.insert("ID_LIKE".to_string(), "suse opensuse".to_string());
        assert_eq!(os_family("sles", &release), "other");
    }

    #[test]
    fn cpuinfo_yields_model_and_core_count() {
        let raw =
            "processor\t: 0\nmodel name\t: AMD EPYC 7B13\nprocessor\t: 1\nmodel name\t: AMD EPYC 7B13\n";
        assert_eq!(parse_cpuinfo(raw), ("AMD EPYC 7B13".to_string(), 2));
    }

    #[test]
    fn virtualization_reads_the_kernels_traces() {
        let files: HashMap<&str, &str> = [("/proc/modules", "kvm_intel 1 0\nkvm 2 1\n")]
            .into_iter()
            .collect();
        let read = |p: &str| files.get(p).map(|s| s.to_string()).unwrap_or_default();
        let exists = |p: &str| p == "/.dockerenv";
        // The module list is checked before the docker marker, as gopsutil does.
        assert_eq!(detect_virtualization(&read, &exists), "kvm");
        let none = |_: &str| String::new();
        assert_eq!(detect_virtualization(&none, &exists), "docker");
        let nothing = |_: &str| false;
        assert_eq!(detect_virtualization(&none, &nothing), "");
    }
}
