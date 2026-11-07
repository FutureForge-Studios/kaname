//! Host identity, telemetry and packages.
//!
//! Metrics are a pure function of wall-clock time rather than a mutable
//! counter, so an extra on-demand sample never perturbs the series and two
//! agents seeded alike produce byte-identical charts.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::processes;
use super::state::{GIB, KIB, MIB, Sim, clampf, day_cycle, drift, mix, pick, progress, round2, stamp};
use crate::providers::{
    Ctx, DiskUsage, MetricsSample, PResult, PackageInfo, PackagesListParams, PackagesUpgradeParams,
    PackagesUpgradeResult, ProviderError, SelfUpdateParams, SelfUpdateResult, StreamRef, System, SystemInfo,
    SystemRebootParams, topic,
};

#[derive(Clone, Debug)]
pub struct Identity {
    pub hostname: String,
    pub machine_id: String,
    pub os: String,
    pub os_version: String,
    pub os_family: String,
    pub arch: String,
    pub kernel: String,
    pub cpu_model: String,
    pub cpu_cores: i64,
    pub memory_total: i64,
    pub swap_total: i64,
    pub virtualization: String,
    pub timezone: String,
    pub private_ip: String,
    pub public_ip: String,
    pub domain: String,
    /// The domain Yunori Mail Server serves on this host.
    pub mail_domain: String,
    pub disks: Vec<DiskSpec>,
}

/// A mount as it was at agent start plus the rate it grows, which is what
/// makes "the disk is filling" visible on a chart instead of a static
/// number.
#[derive(Clone, Debug)]
pub struct DiskSpec {
    pub mount: &'static str,
    pub device: &'static str,
    pub fstype: &'static str,
    pub total: i64,
    pub used: i64,
    /// Bytes per second.
    pub fill_bytes: f64,
    pub inodes: i64,
    pub inodes_use: i64,
}

const HOSTNAME_POOL: &[&str] = &["web-01", "web-02", "app-01", "edge-01", "core-01", "node-01"];

const CPU_POOL: &[&str] = &[
    "AMD EPYC 7763 64-Core Processor",
    "Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz",
    "AMD EPYC 9354P 32-Core Processor",
    "Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz",
];

pub fn build_identity(seed: u64) -> Identity {
    let cores = [4i64, 8, 8, 16][(mix(seed ^ 0x21) % 4) as usize];
    let memory = [8i64, 16, 16, 32][(mix(seed ^ 0x22) % 4) as usize] * GIB;

    Identity {
        hostname: format!("{}.kaname.internal", pick(seed, 0x01, HOSTNAME_POOL)),
        machine_id: format!("{:016x}{:016x}", mix(seed ^ 0xa1), mix(seed ^ 0xa2)),
        os: "Debian GNU/Linux".into(),
        os_version: "12 (bookworm)".into(),
        os_family: "debian".into(),
        arch: "amd64".into(),
        kernel: "6.1.0-18-amd64".into(),
        cpu_model: pick(seed, 0x02, CPU_POOL).to_string(),
        cpu_cores: cores,
        memory_total: memory,
        swap_total: 2 * GIB,
        virtualization: "kvm".into(),
        timezone: "Etc/UTC".into(),
        private_ip: format!("10.20.30.{}", 11 + mix(seed ^ 0x31) % 40),
        public_ip: format!("192.0.2.{}", 20 + mix(seed ^ 0x32) % 80),
        domain: "example.com".into(),
        mail_domain: super::mail::PRIMARY_DOMAIN.into(),
        disks: vec![
            DiskSpec {
                mount: "/",
                device: "/dev/vda1",
                fstype: "ext4",
                total: 80 * GIB,
                used: 33 * GIB + (mix(seed ^ 0x41) % (4 * GIB as u64)) as i64,
                fill_bytes: 6.0 * KIB as f64,
                inodes: 5_242_880,
                inodes_use: 412_336,
            },
            DiskSpec {
                mount: "/boot",
                device: "/dev/vda2",
                fstype: "ext4",
                total: GIB,
                used: 233 * MIB,
                fill_bytes: 0.0,
                inodes: 65_536,
                inodes_use: 318,
            },
            DiskSpec {
                mount: "/srv",
                device: "/dev/vdb1",
                fstype: "xfs",
                total: 200 * GIB,
                used: 124 * GIB + (mix(seed ^ 0x42) % (9 * GIB as u64)) as i64,
                fill_bytes: 18.0 * KIB as f64,
                inodes: 104_857_600,
                inodes_use: 1_884_205,
            },
            // Deliberately hot: an operator should see the warning axis do
            // something on a fresh install rather than a wall of green.
            DiskSpec {
                mount: "/var/lib/docker",
                device: "/dev/vdc1",
                fstype: "ext4",
                total: 40 * GIB,
                used: 34 * GIB + 900 * MIB,
                fill_bytes: 2.0 * KIB as f64,
                inodes: 2_621_440,
                inodes_use: 743_119,
            },
        ],
    }
}

/* ------------------------------ telemetry ---------------------------- */

/// Synthesises one telemetry point: a daily sinusoid for the shape of a
/// working day, fractal drift for texture, and a cumulative network
/// counter that only ever goes up.
pub fn sample(sim: &Sim, now: DateTime<Utc>) -> MetricsSample {
    let seed = sim.seed;
    let id = &sim.id;
    let t = now.timestamp_millis() as f64 / 1000.0;
    let cycle = day_cycle(now);
    let mib = MIB as f64;
    let kib = KIB as f64;

    let cpu = clampf(
        19.0 + 13.0 * cycle
            + 14.0 * drift(seed ^ 0x100, t / 240.0, 3)
            + 5.0 * drift(seed ^ 0x101, t / 17.0, 2),
        0.6,
        99.0,
    );

    let per_core: Vec<f64> = (0..id.cpu_cores)
        .map(|core| {
            let jitter = 11.0 * drift(seed ^ 0x110 ^ core as u64, t / 23.0, 2);
            round2(clampf(cpu + jitter, 0.2, 100.0))
        })
        .collect();

    let mem_ratio = clampf(
        0.44 + 0.07 * cycle + 0.06 * drift(seed ^ 0x120, t / 900.0, 3),
        0.18,
        0.95,
    );
    let mem_used = (id.memory_total as f64 * mem_ratio) as i64;
    let mem_cached =
        (id.memory_total as f64 * clampf(0.19 + 0.04 * drift(seed ^ 0x121, t / 1200.0, 2), 0.05, 0.4)) as i64;
    let swap_used =
        (id.swap_total as f64 * clampf(0.04 + 0.03 * drift(seed ^ 0x122, t / 3600.0, 2), 0.0, 0.6)) as i64;

    let cores = id.cpu_cores as f64;
    let load1 = clampf(
        cores * cpu / 100.0 * (1.0 + 0.18 * drift(seed ^ 0x130, t / 60.0, 2)),
        0.01,
        cores * 3.0,
    );
    let load5 = clampf(
        cores * cpu / 100.0 * (1.0 + 0.12 * drift(seed ^ 0x131, t / 300.0, 2)),
        0.01,
        cores * 3.0,
    );
    let load15 = clampf(
        cores * cpu / 100.0 * (1.0 + 0.08 * drift(seed ^ 0x132, t / 900.0, 2)),
        0.01,
        cores * 3.0,
    );

    let rx_rate = clampf(
        1.6 * mib * (1.0 + 0.7 * cycle) + 0.9 * mib * drift(seed ^ 0x140, t / 45.0, 3),
        24.0 * kib,
        90.0 * mib,
    );
    let tx_rate = clampf(
        3.9 * mib * (1.0 + 0.8 * cycle) + 1.6 * mib * drift(seed ^ 0x141, t / 38.0, 3),
        40.0 * kib,
        180.0 * mib,
    );

    let (boot, processes) = {
        let w = sim.world.lock();
        (w.boot_time, w.procs.len() as i64)
    };
    let elapsed = (now - boot).num_milliseconds() as f64 / 1000.0;
    let rx_total = (1.7 * mib * elapsed) as i64 + (mix(seed ^ 0x150) % GIB as u64) as i64;
    let tx_total = (4.1 * mib * elapsed) as i64 + (mix(seed ^ 0x151) % GIB as u64) as i64;

    MetricsSample {
        ts: stamp(now),
        cpu_percent: round2(cpu),
        cpu_per_core: per_core,
        memory_used: mem_used,
        memory_total: id.memory_total,
        memory_cached: Some(mem_cached),
        swap_used,
        swap_total: id.swap_total,
        load1: round2(load1),
        load5: round2(load5),
        load15: round2(load15),
        processes,
        disks: disks(sim, now),
        net_rx_bytes: rx_total,
        net_tx_bytes: tx_total,
        net_rx_rate: round2(rx_rate),
        net_tx_rate: round2(tx_rate),
        disk_read_rate: Some(round2(clampf(
            2.4 * mib * (1.0 + cycle) + mib * drift(seed ^ 0x160, t / 70.0, 2),
            0.0,
            400.0 * mib,
        ))),
        disk_write_rate: Some(round2(clampf(
            6.1 * mib * (1.0 + cycle) + 2.0 * mib * drift(seed ^ 0x161, t / 55.0, 2),
            0.0,
            600.0 * mib,
        ))),
    }
}

/// Grows every writable mount at its own rate and adds whatever the panel
/// has written through the file manager, so deleting a large file really
/// does give space back.
pub fn disks(sim: &Sim, now: DateTime<Utc>) -> Vec<DiskUsage> {
    let written = sim.written.load(Ordering::Relaxed);
    let elapsed = (now - sim.started_at).num_milliseconds() as f64 / 1000.0;

    sim.id
        .disks
        .iter()
        .enumerate()
        .map(|(i, spec)| {
            let mut used = spec.used + (spec.fill_bytes * elapsed) as i64;
            if spec.mount == "/" {
                used += written;
            }
            used += ((64 * MIB) as f64
                * drift(sim.seed ^ 0x170 ^ i as u64, now.timestamp() as f64 / 600.0, 2))
                as i64;
            let used = used.clamp(0, spec.total);
            DiskUsage {
                mount: spec.mount.into(),
                device: spec.device.into(),
                fstype: spec.fstype.into(),
                total: spec.total,
                used,
                available: spec.total - used,
                used_percent: round2(used as f64 / spec.total as f64 * 100.0),
                inodes_total: Some(spec.inodes),
                inodes_used: Some(spec.inodes_use),
            }
        })
        .collect()
}

/* ------------------------------ packages ----------------------------- */

pub fn build_packages(sim: &Sim) {
    let catalogue: &[(&str, &str, &str, bool)] = &[
        ("base-files", "12.4+deb12u5", "", false),
        ("bash", "5.2.15-2+b7", "", false),
        ("ca-certificates", "20230311", "20240203", true),
        ("coreutils", "9.1-1", "", false),
        ("cron", "3.0pl1-162", "", false),
        ("curl", "7.88.1-10+deb12u5", "7.88.1-10+deb12u7", true),
        ("dbus", "1.14.10-1~deb12u1", "", false),
        (
            "docker-ce",
            "5:26.1.3-1~debian.12~bookworm",
            "5:26.1.4-1~debian.12~bookworm",
            false,
        ),
        (
            "docker-ce-cli",
            "5:26.1.3-1~debian.12~bookworm",
            "5:26.1.4-1~debian.12~bookworm",
            false,
        ),
        ("fail2ban", "1.0.2-2", "", false),
        ("git", "1:2.39.2-1.1", "1:2.39.5-0+deb12u1", true),
        ("gzip", "1.12-1", "", false),
        ("libc6", "2.36-9+deb12u7", "2.36-9+deb12u8", true),
        ("libssl3", "3.0.11-1~deb12u2", "3.0.13-1~deb12u1", true),
        ("linux-image-6.1.0-18-amd64", "6.1.76-1", "6.1.90-1", true),
        ("mariadb-server", "1:10.11.6-0+deb12u1", "", false),
        ("nftables", "1.0.6-2+deb12u2", "", false),
        ("nginx", "1.22.1-9", "1.22.1-9+deb12u1", false),
        ("openssh-server", "1:9.2p1-2+deb12u2", "1:9.2p1-2+deb12u3", true),
        ("openssl", "3.0.11-1~deb12u2", "3.0.13-1~deb12u1", true),
        ("php8.2-fpm", "8.2.20-1~deb12u1", "", false),
        ("postgresql-16", "16.3-1.pgdg120+1", "16.4-1.pgdg120+1", false),
        ("python3", "3.11.2-1+b1", "", false),
        ("restic", "0.14.0-2", "", false),
        ("rsyslog", "8.2302.0-1", "", false),
        ("systemd", "252.22-1~deb12u1", "252.26-1~deb12u2", false),
        ("tzdata", "2024a-0+deb12u1", "", false),
        ("unbound", "1.17.1-2+deb12u2", "", false),
        ("vim", "2:9.0.1378-2", "", false),
        ("yunori-mail", "0.1.0", "", false),
    ];

    let packages = catalogue
        .iter()
        .map(|(name, installed, available, security)| PackageInfo {
            name: name.to_string(),
            installed_version: installed.to_string(),
            available_version: if available.is_empty() {
                None
            } else {
                Some(available.to_string())
            },
            security: *security,
        })
        .collect();
    sim.world.lock().packages = packages;
}

/* ------------------------------- system ------------------------------ */

pub struct SimSystem(pub Arc<Sim>);

#[async_trait]
impl System for SimSystem {
    async fn info(&self, _ctx: &Ctx) -> PResult<SystemInfo> {
        let s = &self.0;
        let boot = s.boot_time();
        Ok(SystemInfo {
            hostname: s.id.hostname.clone(),
            machine_id: s.id.machine_id.clone(),
            os: s.id.os.clone(),
            os_version: s.id.os_version.clone(),
            os_family: s.id.os_family.clone(),
            arch: s.id.arch.clone(),
            kernel: s.id.kernel.clone(),
            boot_time: stamp(boot),
            uptime_seconds: (Utc::now() - boot).num_seconds(),
            cpu_model: s.id.cpu_model.clone(),
            cpu_cores: s.id.cpu_cores,
            memory_total: s.id.memory_total,
            swap_total: s.id.swap_total,
            virtualization: Some(s.id.virtualization.clone()),
            timezone: s.id.timezone.clone(),
            agent_version: s.opts.agent_version.clone(),
            simulated: true,
        })
    }

    async fn metrics(&self, _ctx: &Ctx) -> PResult<MetricsSample> {
        Ok(sample(&self.0, Utc::now()))
    }

    /// Honoured rather than faked away: the boot time moves, every enabled
    /// unit comes back up and the process table is rebuilt, so the panel
    /// sees exactly what a real reboot looks like.
    async fn reboot(&self, _ctx: &Ctx, p: SystemRebootParams) -> PResult<()> {
        let sim = self.0.clone();
        let delay = Duration::from_secs(p.delay_seconds.max(0) as u64);
        self.0.spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = sim.cancel.cancelled() => return,
            }

            {
                let mut w = sim.world.lock();
                w.boot_time = Utc::now();
                let boot = w.boot_time;
                for u in &mut w.units {
                    if u.info.enabled {
                        u.info.active_state = "active".into();
                        u.info.sub_state = "running".into();
                        u.info.restart_count = 0;
                        u.info.active_since = Some(stamp(boot));
                    } else {
                        u.info.active_state = "inactive".into();
                        u.info.sub_state = "dead".into();
                        u.info.main_pid = None;
                        u.info.active_since = None;
                    }
                }
                w.procs.clear();
                w.pid_seq = 0;
            }

            processes::build_processes(&sim);
            tracing::info!(provider = "sim", "simulated host rebooted");
            sim.emit(
                topic::SERVICE_CHANGED,
                serde_json::json!({"unit": "*", "state": "active"}),
            );
        });
        Ok(())
    }

    async fn list_packages(&self, _ctx: &Ctx, p: PackagesListParams) -> PResult<Vec<PackageInfo>> {
        let w = self.0.world.lock();
        Ok(w.packages
            .iter()
            .filter(|pkg| !(p.upgradable_only && pkg.available_version.is_none()))
            .cloned()
            .collect())
    }

    async fn upgrade_packages(
        &self,
        ctx: &Ctx,
        p: PackagesUpgradeParams,
        s: StreamRef,
    ) -> PResult<PackagesUpgradeResult> {
        let sim = &self.0;
        let targets: Vec<usize> = {
            let w = sim.world.lock();
            w.packages
                .iter()
                .enumerate()
                .filter(|(_, pkg)| pkg.available_version.is_some())
                .filter(|(_, pkg)| p.names.is_empty() || p.names.contains(&pkg.name))
                .filter(|(_, pkg)| !p.security_only || pkg.security)
                .map(|(i, _)| i)
                .collect()
        };

        progress(ctx, &*s, Duration::ZERO, "Reading package lists... Done").await?;
        progress(
            ctx,
            &*s,
            Duration::from_millis(180),
            "Building dependency tree... Done",
        )
        .await?;
        if targets.is_empty() {
            let _ = progress(
                ctx,
                &*s,
                Duration::ZERO,
                "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
            )
            .await;
            return Ok(PackagesUpgradeResult {
                upgraded: vec![],
                reboot_required: false,
            });
        }

        let mut upgraded = Vec::new();
        let mut reboot_required = false;

        for index in targets {
            let (name, previous, next) = {
                let mut w = sim.world.lock();
                let pkg = &mut w.packages[index];
                let next = pkg.available_version.take().unwrap_or_default();
                let previous = std::mem::replace(&mut pkg.installed_version, next.clone());
                pkg.security = false;
                (pkg.name.clone(), previous, next)
            };

            upgraded.push(name.clone());
            if name.starts_with("linux-image") || name == "libc6" || name == "systemd" {
                reboot_required = true;
            }

            for line in [
                format!(
                    "Get:{} http://deb.debian.org/debian bookworm/main amd64 {} amd64 {}",
                    upgraded.len(),
                    name,
                    next
                ),
                format!("Preparing to unpack .../{name}_{next}_amd64.deb ..."),
                format!("Unpacking {name} ({next}) over ({previous}) ..."),
                format!("Setting up {name} ({next}) ..."),
            ] {
                progress(ctx, &*s, Duration::from_millis(120), line).await?;
            }
        }

        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            "Processing triggers for man-db (2.11.2-2) ...",
        )
        .await;
        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!(
                "{} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
                upgraded.len()
            ),
        )
        .await;
        if reboot_required {
            let _ = progress(ctx, &*s, Duration::ZERO, "*** System restart required ***").await;
        }

        Ok(PackagesUpgradeResult {
            upgraded,
            reboot_required,
        })
    }

    /// Refused outright. A simulated host has no binary to replace, and
    /// answering "restarting" would make the development fleet lie about
    /// a destructive operation — which is exactly the operation where a
    /// lie costs the most.
    async fn self_update(
        &self,
        _ctx: &Ctx,
        _p: SelfUpdateParams,
        _s: StreamRef,
    ) -> PResult<SelfUpdateResult> {
        Err(ProviderError::unsupported_because(
            "this is a simulated host with no agent binary to replace",
        ))
    }
}
