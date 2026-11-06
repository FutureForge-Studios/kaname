//! systemd.
//!
//! Units are real state: starting one adds its processes to the table and
//! pushes a service.changed event, stopping one takes them away again, and
//! killing a unit's main pid drops it into `failed`. The fleet ships with
//! one genuinely failed unit, because a wall of green teaches an operator
//! nothing about what a problem looks like.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::logs::{self, TailRequest};
use super::processes::{ProcSpec, add_process};
use super::state::{MIB, Sim, World, mix, stamp};
use crate::providers::{
    Ctx, LogRecord, PResult, ProviderError, ServiceInfo, ServiceListParams, ServiceLogsParams, Services, StreamRef,
    topic,
};

/// A systemd unit plus the resident memory it reports while up.
pub struct Unit {
    pub info: ServiceInfo,
    pub memory: i64,
}

struct UnitSeed {
    name: &'static str,
    description: &'static str,
    enabled: bool,
    active: &'static str,
    sub: &'static str,
    memory: i64,
    restarts: i64,
}

macro_rules! unit {
    ($name:expr, $desc:expr, $enabled:expr, $active:expr, $sub:expr, $mem:expr, $restarts:expr) => {
        UnitSeed {
            name: $name,
            description: $desc,
            enabled: $enabled,
            active: $active,
            sub: $sub,
            memory: $mem,
            restarts: $restarts,
        }
    };
}

const UNIT_CATALOGUE: &[UnitSeed] = &[
    unit!("systemd-journald.service", "Journal Service", true, "active", "running", 78 * MIB, 0),
    unit!("systemd-udevd.service", "Rule-based Manager for Device Events and Files", true, "active", "running", 9 * MIB, 0),
    unit!("systemd-logind.service", "User Login Management", true, "active", "running", 7 * MIB, 0),
    unit!("systemd-resolved.service", "Network Name Resolution", true, "active", "running", 14 * MIB, 0),
    unit!("systemd-timesyncd.service", "Network Time Synchronization", true, "active", "running", 5 * MIB, 0),
    unit!("systemd-networkd.service", "Network Configuration", true, "active", "running", 8 * MIB, 0),
    unit!("dbus.service", "D-Bus System Message Bus", true, "active", "running", 6 * MIB, 0),
    unit!("cron.service", "Regular background program processing daemon", true, "active", "running", 4 * MIB, 0),
    unit!("rsyslog.service", "System Logging Service", true, "active", "running", 11 * MIB, 0),
    unit!("ssh.service", "OpenBSD Secure Shell server", true, "active", "running", 34 * MIB, 0),
    unit!("nginx.service", "A high performance web server and a reverse proxy server", true, "active", "running", 97 * MIB, 2),
    unit!("php8.2-fpm.service", "The PHP 8.2 FastCGI Process Manager", true, "active", "running", 374 * MIB, 1),
    unit!("postgresql.service", "PostgreSQL RDBMS", true, "active", "exited", 0, 0),
    unit!("postgresql@16-main.service", "PostgreSQL Cluster 16-main", true, "active", "running", 218 * MIB, 0),
    unit!("mariadb.service", "MariaDB 10.11.6 database server", true, "active", "running", 412 * MIB, 0),
    unit!("docker.socket", "Docker Socket for the API", true, "active", "listening", 0, 0),
    unit!("docker.service", "Docker Application Container Engine", true, "active", "running", 118 * MIB, 0),
    unit!("containerd.service", "containerd container runtime", true, "active", "running", 152 * MIB, 0),
    unit!("stalwart-mail.service", "Stalwart Mail Server", true, "active", "running", 186 * MIB, 0),
    unit!("yunori-mail.service", "Yunori Mail Server console and edge", true, "active", "running", 38 * MIB, 0),
    unit!("unbound.service", "Unbound DNS server", true, "active", "running", 21 * MIB, 0),
    unit!("fail2ban.service", "Fail2Ban Service", true, "active", "running", 31 * MIB, 0),
    unit!("nftables.service", "nftables", true, "active", "exited", 0, 0),
    unit!("kanamed.service", "Kaname agent", true, "active", "running", 26 * MIB, 0),
    unit!("unattended-upgrades.service", "Unattended Upgrades Shutdown", true, "active", "running", 22 * MIB, 0),
    unit!("clamav-freshclam.service", "ClamAV virus database updater", true, "failed", "failed", 0, 5),
    unit!("ufw.service", "Uncomplicated firewall", false, "inactive", "dead", 0, 0),
    unit!("redis-server.service", "Advanced key-value store", false, "inactive", "dead", 0, 0),
    unit!("apt-daily.timer", "Daily apt download activities", true, "active", "waiting", 0, 0),
    unit!("apt-daily-upgrade.timer", "Daily apt upgrade and clean activities", true, "active", "waiting", 0, 0),
    unit!("certbot.timer", "Run certbot twice daily", true, "active", "waiting", 0, 0),
    unit!("logrotate.timer", "Daily rotation of log files", true, "active", "waiting", 0, 0),
    unit!("e2scrub_all.timer", "Periodic ext4 Online Metadata Check for All Filesystems", true, "active", "waiting", 0, 0),
    unit!("man-db.timer", "Daily man-db regeneration", true, "active", "waiting", 0, 0),
];

pub fn build_units(sim: &Sim) {
    let mut w = sim.world.lock();
    let boot = w.boot_time;
    w.units = UNIT_CATALOGUE
        .iter()
        .enumerate()
        .map(|(i, seed)| {
            let mut info = ServiceInfo {
                unit: seed.name.into(),
                description: seed.description.into(),
                load_state: "loaded".into(),
                active_state: seed.active.into(),
                sub_state: seed.sub.into(),
                enabled: seed.enabled,
                main_pid: None,
                memory_current: None,
                cpu_usage_ns: None,
                active_since: None,
                restart_count: seed.restarts,
            };
            if seed.active == "active" {
                let since = boot + chrono::Duration::seconds(3 + (mix(sim.seed ^ i as u64 ^ 0x81) % 180) as i64);
                info.active_since = Some(stamp(since));
                info.cpu_usage_ns = Some((mix(sim.seed ^ i as u64 ^ 0x82) % 900_000_000_000) as f64);
                if seed.memory > 0 {
                    info.memory_current = Some(seed.memory);
                }
            }
            Unit { info, memory: seed.memory }
        })
        .collect();
}

pub fn unit_active(w: &World, name: &str) -> bool {
    w.units.iter().find(|u| u.info.unit == name).is_some_and(|u| u.info.active_state == "active")
}

pub fn find_unit(w: &World, name: &str) -> Option<usize> {
    w.units.iter().position(|u| u.info.unit == name)
}

/// Points every running unit at the first process it owns, which is what
/// `MainPID` means on a real host.
pub fn sync_unit_pids(w: &mut World) {
    let mut owned: HashMap<String, i64> = HashMap::new();
    for proc in &w.procs {
        if proc.unit.is_empty() {
            continue;
        }
        owned.entry(proc.unit.clone()).or_insert(proc.info.pid);
    }
    for u in &mut w.units {
        match owned.get(&u.info.unit) {
            None => u.info.main_pid = None,
            Some(&pid) => {
                u.info.main_pid = Some(pid);
                if u.memory > 0 {
                    u.info.memory_current = Some(u.memory);
                }
            }
        }
    }
}

/* ------------------------- unit process table ------------------------ */

/// The process table a unit owns while it is up. It is the single
/// definition used both when the fleet is built and when a unit is
/// started later, so a restarted nginx comes back with the same worker
/// count it had.
pub fn unit_process_specs(_sim: &Sim, w: &World, name: &str, systemd: i64) -> Vec<ProcSpec> {
    let one = |command: &str, cmdline: &str, user: &str, rss: i64, threads: i64, cpu: f64| {
        vec![ProcSpec::new(command, cmdline, user).unit(name).ppid(systemd).rss(rss).threads(threads).cpu(cpu)]
    };
    let proc = |command: &str, cmdline: &str, user: &str, rss: i64, threads: i64, cpu: f64| {
        ProcSpec::new(command, cmdline, user).unit(name).ppid(systemd).rss(rss).threads(threads).cpu(cpu)
    };

    match name {
        "systemd-journald.service" => one("systemd-journal", "/lib/systemd/systemd-journald", "root", 78 * MIB, 1, 0.4),
        "systemd-udevd.service" => one("systemd-udevd", "/lib/systemd/systemd-udevd", "root", 9 * MIB, 1, 0.0),
        "systemd-logind.service" => one("systemd-logind", "/lib/systemd/systemd-logind", "root", 7 * MIB, 1, 0.0),
        "systemd-resolved.service" => {
            one("systemd-resolve", "/lib/systemd/systemd-resolved", "systemd-resolve", 14 * MIB, 1, 0.0)
        }
        "systemd-timesyncd.service" => {
            one("systemd-timesyn", "/lib/systemd/systemd-timesyncd", "systemd-timesync", 5 * MIB, 2, 0.0)
        }
        "systemd-networkd.service" => {
            one("systemd-network", "/lib/systemd/systemd-networkd", "systemd-network", 8 * MIB, 1, 0.0)
        }
        "dbus.service" => one(
            "dbus-daemon",
            "/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only",
            "messagebus",
            6 * MIB,
            1,
            0.0,
        ),
        "cron.service" => one("cron", "/usr/sbin/cron -f", "root", 4 * MIB, 1, 0.0),
        "rsyslog.service" => one("rsyslogd", "/usr/sbin/rsyslogd -n -iNONE", "root", 11 * MIB, 4, 0.2),
        "kanamed.service" => one("kanamed", "/usr/local/bin/kanamed run --simulate", "root", 26 * MIB, 9, 0.6),
        "unattended-upgrades.service" => one(
            "unattended-upgr",
            "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal",
            "root",
            22 * MIB,
            1,
            0.0,
        ),
        "unbound.service" => one("unbound", "/usr/sbin/unbound -d -p", "unbound", 21 * MIB, 4, 0.1),
        "fail2ban.service" => {
            one("fail2ban-server", "/usr/bin/python3 /usr/bin/fail2ban-server -xf start", "root", 31 * MIB, 7, 0.5)
        }
        "mariadb.service" => one("mariadbd", "/usr/sbin/mariadbd", "mysql", 412 * MIB, 21, 1.8),
        "redis-server.service" => one("redis-server", "/usr/bin/redis-server 127.0.0.1:6379", "redis", 46 * MIB, 5, 0.7),
        "clamav-freshclam.service" => {
            one("freshclam", "/usr/bin/freshclam -d --foreground=true", "clamav", 88 * MIB, 1, 0.0)
        }
        "ufw.service" => vec![],

        "ssh.service" => vec![
            proc("sshd", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", "root", 12 * MIB, 1, 0.0),
            proc("sshd", "sshd: deploy [priv]", "root", 14 * MIB, 1, 0.0),
            proc("sshd", "sshd: deploy@pts/0", "deploy", 8 * MIB, 1, 0.0),
        ],

        "nginx.service" => {
            let mut specs = vec![proc(
                "nginx",
                "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;",
                "root",
                9 * MIB,
                1,
                0.0,
            )];
            for _ in 0..4 {
                specs.push(proc("nginx", "nginx: worker process", "www-data", 22 * MIB, 1, 1.4));
            }
            specs
        }

        "php8.2-fpm.service" => {
            let mut specs =
                vec![proc("php-fpm8.2", "php-fpm: master process (/etc/php/8.2/fpm/php-fpm.conf)", "root", 34 * MIB, 1, 0.0)];
            for _ in 0..5 {
                specs.push(proc("php-fpm8.2", "php-fpm: pool www", "www-data", 68 * MIB, 1, 2.1));
            }
            specs
        }

        "postgresql@16-main.service" => {
            let mut specs = vec![proc(
                "postgres",
                "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf",
                "postgres",
                44 * MIB,
                1,
                0.9,
            )];
            for aux in [
                "checkpointer",
                "background writer",
                "walwriter",
                "autovacuum launcher",
                "logical replication launcher",
            ] {
                specs.push(proc("postgres", &format!("postgres: 16/main: {aux}"), "postgres", 18 * MIB, 1, 0.0));
            }
            for i in 0..6 {
                specs.push(proc(
                    "postgres",
                    &format!("postgres: 16/main: kaname kaname 127.0.0.1(5{:04}) idle", 1000 + i * 37),
                    "postgres",
                    26 * MIB,
                    1,
                    0.7,
                ));
            }
            specs
        }

        "docker.service" => one(
            "dockerd",
            "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
            "root",
            118 * MIB,
            24,
            1.1,
        ),

        "containerd.service" => {
            let mut specs = vec![proc("containerd", "/usr/bin/containerd", "root", 74 * MIB, 18, 0.8)];
            for c in &w.containers {
                if c.info.state != "running" {
                    continue;
                }
                specs.push(proc(
                    "containerd-shim",
                    &format!(
                        "/usr/bin/containerd-shim-runc-v2 -namespace moby -id {} -address /run/containerd/containerd.sock",
                        c.info.id
                    ),
                    "root",
                    12 * MIB,
                    12,
                    0.0,
                ));
                specs.push(proc(&c.process, &c.process_args, &c.process_user, c.rss_base, 6, 1.6));
            }
            specs
        }

        "stalwart-mail.service" => vec![
            proc("stalwart-mail", "/opt/stalwart/bin/stalwart-mail --config /opt/stalwart/etc/config.toml", "stalwart", 186 * MIB, 14, 1.2),
        ],

        "yunori-mail.service" => vec![
            proc("yunori-mail", "/usr/local/bin/yunori-mail serve", "root", 38 * MIB, 6, 0.3),
        ],

        _ => vec![],
    }
}

/* ------------------------------ services ----------------------------- */

fn matches_unit(info: &ServiceInfo, pattern: &str) -> bool {
    let pattern = pattern.trim_end_matches('*');
    info.unit.to_lowercase().contains(pattern) || info.description.to_lowercase().contains(pattern)
}

/// The whole unit state machine in one place, so start and restart
/// cannot drift apart in what they do to the process table.
pub fn transition(sim: &Sim, name: &str, action: &str) -> PResult<ServiceInfo> {
    let (info, before) = {
        let mut w = sim.world.lock();
        let Some(idx) = find_unit(&w, name) else {
            return Err(ProviderError::not_found(format!("unit {name}")));
        };
        let before = w.units[idx].info.active_state.clone();
        let now = Utc::now();

        match action {
            "start" => {
                if w.units[idx].info.active_state != "active" {
                    bring_up(sim, &mut w, idx, now);
                }
            }
            "stop" => {
                if w.units[idx].info.active_state != "inactive" {
                    bring_down(&mut w, idx, "inactive", "dead");
                }
            }
            "restart" => {
                bring_down(&mut w, idx, "inactive", "dead");
                bring_up(sim, &mut w, idx, now);
                w.units[idx].info.restart_count += 1;
            }
            "reload" => {
                if w.units[idx].info.active_state != "active" {
                    return Err(ProviderError::PreconditionFailed(format!("unit {name} is not running")));
                }
            }
            "enable" => w.units[idx].info.enabled = true,
            "disable" => w.units[idx].info.enabled = false,
            _ => {}
        }
        (w.units[idx].info.clone(), before)
    };

    if info.active_state != before {
        sim.emit(
            topic::SERVICE_CHANGED,
            serde_json::json!({"unit": name, "state": info.active_state}),
        );
    }
    Ok(info)
}

pub fn bring_up(sim: &Sim, w: &mut World, idx: usize, now: DateTime<Utc>) {
    let name = w.units[idx].info.unit.clone();
    {
        let u = &mut w.units[idx];
        u.info.active_state = "active".into();
        u.info.sub_state = "running".into();
        u.info.active_since = Some(stamp(now));
        if u.memory > 0 {
            u.info.memory_current = Some(u.memory);
        }
        if u.info.cpu_usage_ns.is_none() {
            u.info.cpu_usage_ns = Some(0.0);
        }
    }

    let specs = unit_process_specs(sim, w, &name, 1);
    if specs.is_empty() {
        // Oneshot units and timers reach `active` without a process.
        let u = &mut w.units[idx];
        u.info.sub_state = if name.ends_with(".timer") { "waiting".into() } else { "exited".into() };
        return;
    }
    for spec in specs {
        add_process(sim, w, spec);
    }
    sync_unit_pids(w);
}

pub fn bring_down(w: &mut World, idx: usize, active: &str, sub: &str) {
    let name = w.units[idx].info.unit.clone();
    w.procs.retain(|p| p.unit != name);
    let u = &mut w.units[idx];
    u.info.active_state = active.into();
    u.info.sub_state = sub.into();
    u.info.main_pid = None;
    u.info.memory_current = None;
    u.info.active_since = None;
}

pub struct SimServices(pub Arc<Sim>);

impl SimServices {
    fn status_of(&self, name: &str) -> PResult<ServiceInfo> {
        let w = self.0.world.lock();
        find_unit(&w, name)
            .map(|i| w.units[i].info.clone())
            .ok_or_else(|| ProviderError::not_found(format!("unit {name}")))
    }
}

#[async_trait]
impl Services for SimServices {
    async fn list(&self, _ctx: &Ctx, p: ServiceListParams) -> PResult<Vec<ServiceInfo>> {
        let pattern = p.pattern.unwrap_or_default().trim().to_lowercase();
        let state = p.state.unwrap_or_default();
        let w = self.0.world.lock();
        let mut out: Vec<ServiceInfo> = w
            .units
            .iter()
            .filter(|u| pattern.is_empty() || matches_unit(&u.info, &pattern))
            .filter(|u| state.is_empty() || u.info.active_state == state)
            .map(|u| u.info.clone())
            .collect();
        out.sort_by(|a, b| a.unit.cmp(&b.unit));
        Ok(out)
    }

    async fn status(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        self.status_of(unit)
    }
    async fn start(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "start")
    }
    async fn stop(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "stop")
    }
    async fn restart(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "restart")
    }
    async fn reload(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "reload")
    }
    async fn enable(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "enable")
    }
    async fn disable(&self, _ctx: &Ctx, unit: &str) -> PResult<ServiceInfo> {
        transition(&self.0, unit, "disable")
    }

    async fn logs(&self, ctx: &Ctx, p: ServiceLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        let known = find_unit(&self.0.world.lock(), &p.unit).is_some();
        if !known {
            return Err(ProviderError::not_found(format!("unit {}", p.unit)));
        }
        logs::tail(
            &self.0,
            ctx,
            &*s,
            TailRequest {
                source: logs::SOURCE_JOURNAL.into(),
                unit: p.unit,
                lines: p.lines,
                follow: p.follow,
                since: p.since,
                ..Default::default()
            },
        )
        .await
    }
}
