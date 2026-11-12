//! The shared in-memory world behind the simulated host.
//!
//! A deterministic, stateful fake Debian host (KD-010). The same state
//! directory always produces the same fleet, so tests are reproducible;
//! starting a unit really changes its state, writing a file really
//! persists, stopping a container really updates its status. It exercises
//! the real protocol, the real hub and the real job worker with only the
//! syscalls faked.
//!
//! All mutable state lives in one `World` behind one `parking_lot::Mutex`
//! which is never held across an await, and the filesystem has its own
//! lock which is always taken *after* the world lock is released, the
//! same order the Go original used.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::backups;
use super::certs::Certificate;
use super::containers::Container;
use super::databases;
use super::files::{self, FsRef};
use super::firewall::{self, RollbackWindow};
use super::mail::MailWorld;
use super::processes::Process;
use super::pty::PtySession;
use super::services::Unit;
use super::sites::Site;
use super::system::{self, Identity};
use crate::providers::{
    BackupSnapshotInfo, BanEntry, Ctx, DbDatabaseInfo, DbUserInfo, Encoding, Event, FirewallRuleInfo,
    ImageInfo, Options, PResult, PackageInfo, SshConfigInfo, SshKeyInfo, SshSessionInfo, Stream,
    ThreatObservation, emit, topic,
};

/// Fixed so a given state directory always yields the same host. "kaname"
/// in ASCII, which makes an accidental change obvious.
pub const SIM_SEED: u64 = 0x6b616e616d65;

pub const EVENT_BUFFER: usize = 128;
pub const THREAT_INTERVAL: Duration = Duration::from_secs(45);
pub const HOUSEKEEPING_INTERVAL: Duration = Duration::from_secs(30);

/// Mounts above this fraction push a disk.pressure event.
pub const DISK_PRESSURE_RATIO: f64 = 0.85;
/// Certificates inside this window push a cert.expiring event.
pub const CERT_EXPIRY_WINDOW: chrono::Duration = chrono::Duration::days(21);

pub const KIB: i64 = 1 << 10;
pub const MIB: i64 = 1 << 20;
pub const GIB: i64 = 1 << 30;

/* ------------------------------- world ------------------------------- */

/// Everything that changes. One lock, one place.
pub struct World {
    pub boot_time: DateTime<Utc>,

    pub units: Vec<Unit>,
    pub procs: Vec<Process>,
    pub pid_seq: i64,

    pub containers: Vec<Container>,
    pub images: Vec<ImageInfo>,
    /// Networks created by `container.network.create`, with their labels.
    pub networks: Vec<(String, String, BTreeMap<String, String>)>,
    /// Install directories under the managed apps root that hold data.
    pub app_data: HashSet<String>,

    pub sites: Vec<Site>,
    pub certs: Vec<Certificate>,

    pub mail: MailWorld,

    pub databases: HashMap<String, Vec<DbDatabaseInfo>>,
    pub db_users: HashMap<String, Vec<DbUserInfo>>,
    pub db_grants: HashMap<String, Vec<String>>,

    pub fw_enabled: bool,
    pub fw_inbound: String,
    pub fw_outbound: String,
    pub fw_rules: Vec<FirewallRuleInfo>,
    pub rollbacks: HashMap<String, RollbackWindow>,
    pub bans: HashMap<String, BanEntry>,
    pub threats: HashMap<String, ThreatObservation>,

    pub ssh_keys: HashMap<String, Vec<SshKeyInfo>>,
    pub ssh_config: SshConfigInfo,
    pub ssh_sessions: Vec<SshSessionInfo>,

    pub snapshots: HashMap<String, Vec<BackupSnapshotInfo>>,
    /// What a snapshot taken by `backup.run` actually held, keyed by
    /// snapshot id: (path, tree) per backed-up path. A restore copies from
    /// here so it can honour `overwrite` against real file contents; the
    /// seeded history has none and falls back to the live tree.
    pub snapshot_trees: HashMap<String, Vec<(String, super::files::Node)>>,
    /// References `backup.secret_put` has provisioned. Only the names: the
    /// simulator never needs the password, so it never keeps it.
    pub backup_secrets: HashSet<String>,
    pub packages: Vec<PackageInfo>,

    pub ptys: HashMap<String, Arc<PtySession>>,

    /// Certificates already announced this run, so one expiry is reported
    /// once rather than every housekeeping tick.
    pub announced: HashSet<String>,

    /// Zones the control plane published with `dns.publish`, keyed by zone
    /// name: the sim's stand-in for what public DNS would serve once the
    /// operator (or the provider) published Kaname's records.
    pub published_zones: HashMap<String, Vec<crate::providers::DnsPublishedRecord>>,
}

/// One fake host. Every sub-trait is served by a small struct holding an
/// `Arc<Sim>`, so all state lives in one place.
pub struct Sim {
    pub opts: Options,
    /// The stable name the host was derived from (the state directory's
    /// name in a development fleet, e.g. `mail-01`).
    pub identity: String,
    pub seed: u64,
    pub id: Identity,
    pub fs: FsRef,
    pub started_at: DateTime<Utc>,
    pub world: Mutex<World>,
    /// Outside the world lock on purpose: the filesystem accounts for
    /// bytes while holding its own lock, and taking the host lock
    /// underneath it would invert the order every other path uses.
    pub written: AtomicI64,
    pub events_tx: mpsc::Sender<Event>,
    pub events_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Event>>>,
    pub cancel: CancellationToken,
    pub tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Sim {
    /// Builds the fake host. Its identity comes from the state directory
    /// rather than the machine hostname, because a development fleet runs
    /// several agents side by side on one box and four identical hosts is
    /// a worse demo than no demo.
    pub fn new(opts: Options) -> Arc<Sim> {
        let identity = identity_source(&opts.state_dir);
        let seed = seed_for(&identity);
        let now = Utc::now();
        let (tx, rx) = mpsc::channel(EVENT_BUFFER);

        let boot_time = now
            - chrono::Duration::days(11 + (mix(seed ^ 0x0b) % 37) as i64)
            - chrono::Duration::seconds((mix(seed ^ 0x0c) % 86400) as i64);

        let id = system::build_identity(&identity, seed);
        let world = World {
            boot_time,
            units: Vec::new(),
            procs: Vec::new(),
            pid_seq: 0,
            containers: Vec::new(),
            images: Vec::new(),
            networks: Vec::new(),
            app_data: HashSet::new(),
            sites: Vec::new(),
            certs: Vec::new(),
            mail: MailWorld::default(),
            databases: HashMap::new(),
            db_users: HashMap::new(),
            db_grants: HashMap::new(),
            fw_enabled: false,
            fw_inbound: String::new(),
            fw_outbound: String::new(),
            fw_rules: Vec::new(),
            rollbacks: HashMap::new(),
            bans: HashMap::new(),
            threats: HashMap::new(),
            ssh_keys: HashMap::new(),
            ssh_config: SshConfigInfo::default(),
            ssh_sessions: Vec::new(),
            snapshots: HashMap::new(),
            snapshot_trees: HashMap::new(),
            backup_secrets: HashSet::new(),
            packages: Vec::new(),
            ptys: HashMap::new(),
            announced: HashSet::new(),
            published_zones: HashMap::new(),
        };

        let fs = files::build_filesystem(&id);
        let sim = Arc::new(Sim {
            opts,
            identity,
            seed,
            id,
            fs,
            started_at: now,
            world: Mutex::new(world),
            written: AtomicI64::new(0),
            events_tx: tx,
            events_rx: Arc::new(tokio::sync::Mutex::new(rx)),
            cancel: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
        });

        super::services::build_units(&sim);
        super::containers::build_containers(&sim);
        super::processes::build_processes(&sim);
        super::sites::build_web(&sim);
        super::mail::build_mail(&sim);
        databases::build_databases(&sim);
        firewall::build_security(&sim);
        backups::build_backups(&sim);
        system::build_packages(&sim);

        sim.spawn(threat_loop(sim.clone()));
        sim.spawn(housekeeping_loop(sim.clone()));

        {
            let w = sim.world.lock();
            tracing::info!(
                provider = "sim",
                hostname = %sim.id.hostname,
                units = w.units.len(),
                processes = w.procs.len(),
                containers = w.containers.len(),
                "simulated host ready"
            );
        }
        sim
    }

    /// Runs a background task that stops with the provider.
    pub fn spawn(&self, fut: impl std::future::Future<Output = ()> + Send + 'static) {
        let handle = tokio::spawn(fut);
        self.tasks.lock().push(handle);
    }

    /// Never blocks: a state change nobody is listening for is dropped,
    /// which is what the Provider contract asks for.
    pub fn emit(&self, topic: &'static str, data: impl serde::Serialize) {
        emit(&self.events_tx, topic, data);
    }

    pub fn account_bytes(&self, delta: i64) {
        self.written.fetch_add(delta, Ordering::Relaxed);
    }

    pub fn boot_time(&self) -> DateTime<Utc> {
        self.world.lock().boot_time
    }

    pub fn short_host(&self) -> String {
        self.id.hostname.split('.').next().unwrap_or_default().to_string()
    }

    pub async fn close(&self) {
        self.cancel.cancel();
        let tasks: Vec<JoinHandle<()>> = std::mem::take(&mut *self.tasks.lock());
        for task in tasks {
            let _ = task.await;
        }

        let sessions: Vec<Arc<PtySession>> = {
            let mut w = self.world.lock();
            w.ptys.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            session.stop();
        }
    }
}

/* ---------------------------- background ----------------------------- */

/// The fake intrusion feed: a stable cast of source addresses keeps
/// hammering sshd, so the Security module has something honest to render
/// and the ban list has something to act on.
async fn threat_loop(sim: Arc<Sim>) {
    let mut round: i64 = 0;
    loop {
        tokio::select! {
            _ = sim.cancel.cancelled() => return,
            _ = tokio::time::sleep(THREAT_INTERVAL) => {}
        }
        round += 1;
        let sources = firewall::THREAT_SOURCES;
        let attacker = sources[(mix(sim.seed ^ round as u64) % sources.len() as u64) as usize];
        let burst = 3 + (mix(sim.seed ^ round as u64 ^ 0x51) % 22) as i64;
        let observation = firewall::record_threat(&sim, attacker, burst);
        sim.emit(topic::THREAT_DETECTED, observation);
    }
}

/// Watches the two conditions an operator wants pushed rather than
/// polled: a filling disk and a certificate running out.
async fn housekeeping_loop(sim: Arc<Sim>) {
    let mut round: i64 = 0;
    loop {
        tokio::select! {
            _ = sim.cancel.cancelled() => return,
            _ = tokio::time::sleep(HOUSEKEEPING_INTERVAL) => {}
        }
        round += 1;

        let now = Utc::now();
        for disk in system::disks(&sim, now) {
            if disk.used_percent >= DISK_PRESSURE_RATIO * 100.0 {
                sim.emit(
                    topic::DISK_PRESSURE,
                    serde_json::json!({
                        "mount": disk.mount,
                        "device": disk.device,
                        "used_percent": round2(disk.used_percent),
                        "available": disk.available,
                        "total": disk.total,
                    }),
                );
            }
        }

        let expiring: Vec<(String, DateTime<Utc>)> = {
            let mut w = sim.world.lock();
            let mut out = Vec::new();
            for cert in &w.certs {
                let remaining = cert.not_after - now;
                if remaining > CERT_EXPIRY_WINDOW || w.announced.contains(&cert.subject) {
                    continue;
                }
                out.push((cert.subject.clone(), cert.not_after));
            }
            for (subject, _) in &out {
                w.announced.insert(subject.clone());
            }
            out
        };
        for (subject, not_after) in expiring {
            let remaining = not_after - now;
            sim.emit(
                topic::CERT_EXPIRING,
                serde_json::json!({
                    "subject": subject,
                    "not_after": stamp(not_after),
                    "days_remaining": remaining.num_hours() / 24,
                }),
            );
        }

        // A login every few minutes keeps the SSH sessions list alive
        // instead of frozen at whatever the fleet was seeded with.
        if round % 10 == 0 {
            firewall::rotate_ssh_session(&sim, round);
        }
    }
}

/* --------------------------- determinism ----------------------------- */

/// Picks the most specific stable name available: the state directory
/// when the caller gave one, the machine hostname otherwise.
pub fn identity_source(state_dir: &Path) -> String {
    if let Some(base) = state_dir.file_name().and_then(|b| b.to_str()) {
        if !base.is_empty() && base != "." && base != "/" {
            return base.to_string();
        }
    }
    if let Ok(hostname) = nix::unistd::gethostname() {
        if let Some(name) = hostname.to_str() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    "kaname-sim".to_string()
}

pub fn seed_for(hostname: &str) -> u64 {
    hash_string(hostname) ^ SIM_SEED
}

/// FNV-1a, 64 bit: the same hash the Go original used, so a seeded host
/// keeps its identity across the port.
pub fn hash_string(value: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in value.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// splitmix64: a cheap, well-distributed integer hash. Everything
/// deterministic in this module ultimately comes from it.
pub fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e3779b97f4a7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

/// One deterministic sample in [-1, 1).
pub fn lattice(seed: u64, n: i64) -> f64 {
    (mix(seed ^ n as u64) >> 11) as f64 / (1u64 << 52) as f64 - 1.0
}

/// Smoothly interpolates the lattice, which is what turns a hash into
/// telemetry: charts read as movement rather than as noise.
pub fn wave(seed: u64, x: f64) -> f64 {
    let i = x.floor();
    let f = x - i;
    let t = f * f * (3.0 - 2.0 * f);
    let a = lattice(seed, i as i64);
    let b = lattice(seed, i as i64 + 1);
    a + (b - a) * t
}

/// Sums octaves of wave, giving a slow trend with fine texture on top —
/// the shape real CPU and network graphs have.
pub fn drift(seed: u64, mut x: f64, octaves: u32) -> f64 {
    let (mut sum, mut amp, mut norm) = (0.0, 1.0, 0.0);
    for i in 0..octaves {
        sum += amp * wave(seed.wrapping_add(i as u64 * 0x9e3779b9), x);
        norm += amp;
        amp /= 2.0;
        x *= 2.13;
    }
    sum / norm
}

/// The workload's daily component: peaks at 14:00 UTC, troughs at 02:00.
pub fn day_cycle(t: DateTime<Utc>) -> f64 {
    use chrono::Timelike;
    let secs = (t.hour() * 3600 + t.minute() * 60 + t.second()) as f64;
    (2.0 * std::f64::consts::PI * (secs / 86400.0 - 14.0 / 24.0) + std::f64::consts::PI / 2.0).sin()
}

/* ------------------------------ helpers ------------------------------ */

pub fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

pub fn parse_stamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

pub fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn pick<T: Clone>(seed: u64, n: i64, options: &[T]) -> T {
    options[(mix(seed ^ n as u64) % options.len() as u64) as usize].clone()
}

pub fn human_duration(d: chrono::Duration) -> String {
    let s = d.num_seconds().max(0);
    if s < 60 {
        format!("{s} seconds")
    } else if s < 3600 {
        format!("{} minutes", s / 60)
    } else if s < 48 * 3600 {
        format!("{} hours", s / 3600)
    } else {
        format!("{} days", s / 86400)
    }
}

/// Writes one line of human-readable output to a response stream after an
/// optional pause. Job handlers in the control plane split these on
/// newlines straight into the job log, so every line must stand on its
/// own.
pub async fn progress(ctx: &Ctx, stream: &dyn Stream, pause: Duration, line: impl AsRef<str>) -> PResult<()> {
    if !pause.is_zero() {
        ctx.run(tokio::time::sleep(pause)).await?;
    }
    ctx.check()?;
    let mut text = line.as_ref().to_string();
    text.push('\n');
    stream.send(text.as_bytes(), Encoding::Utf8).await
}

/// Sleeps unless the context ends first.
pub async fn pause(ctx: &Ctx, d: Duration) -> PResult<()> {
    ctx.run(tokio::time::sleep(d)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_matches_known_vector() {
        // FNV-1a 64 of "a" is 0xaf63dc4c8601ec8c.
        assert_eq!(hash_string("a"), 0xaf63dc4c8601ec8c);
        assert_eq!(hash_string(""), 0xcbf29ce484222325);
    }

    #[test]
    fn lattice_is_bounded_and_deterministic() {
        for n in 0..1000 {
            let v = lattice(42, n);
            assert!((-1.0..1.0).contains(&v));
            assert_eq!(v, lattice(42, n));
        }
    }

    #[test]
    fn identity_source_prefers_state_dir() {
        assert_eq!(identity_source(Path::new("/var/lib/kaname/web-01")), "web-01");
    }
}
