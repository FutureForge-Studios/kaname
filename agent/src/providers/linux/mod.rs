//! The real provider: the only code in Kaname that ever touches systemd,
//! the container socket, procfs, the firewall, the filesystem or the
//! `yunori-mail` CLI of a managed host.
//!
//! Two rules hold everywhere in this module. Every exec goes through an
//! argv slice, never a string handed to a shell, so command injection is
//! structurally impossible rather than a code-review responsibility. And
//! anything the host cannot serve returns `ProviderError::Unsupported`, so
//! the panel greys the feature out instead of showing a failure.

pub mod backups;
pub mod capabilities;
pub mod certs;
pub mod common;
pub mod containers;
pub mod databases;
pub mod dns;
pub mod exec;
pub mod files;
pub mod firewall;
pub mod logs;
pub mod mail;
pub mod paths;
pub mod processes;
pub mod pty;
pub mod rollback;
pub mod selfupdate;
pub mod services;
pub mod sites;
pub mod ssh;
pub mod system;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    Backups, Certs, Containers, Ctx, Databases, Dns, Event, Files, Firewall, HostInfo, Logs, Mail, Options,
    PResult, Processes, Provider, ProviderError, ProviderRef, Pty, Services, Sites, Ssh, System, cap, emit,
    topic,
};

/// How often the background watcher re-samples the host for the state
/// changes the control plane should not have to poll for.
const WATCH_INTERVAL: Duration = Duration::from_secs(30);
/// A filesystem past this mark raises disk.pressure once, and again only
/// after it has dropped back below it.
const DISK_PRESSURE_PERCENT: f64 = 90.0;

/// State every sub-operation shares. Each `*Ops` struct holds an `Arc` of
/// this, which is how `firewall` and `ssh` share one rollback guard and
/// how the watcher reaches the container runtime.
pub struct Shared {
    pub opts: Options,
    caps: HashSet<String>,
    cap_list: Vec<String>,
    pub docker: Option<Arc<containers::DockerClient>>,
    pub rollback: rollback::RollbackGuard,
    pub names: NameCache,
    pub events: mpsc::Sender<Event>,
    /// Counters only become rates against a previous reading, so the last
    /// sample outlives the call that took it.
    pub last_metrics: Mutex<Option<system::MetricsSnapshot>>,
    pub ptys: pty::PtySessions,
}

impl Shared {
    pub fn has(&self, capability: &str) -> bool {
        self.caps.contains(capability)
    }

    /// The single gate every sub-operation uses, so a host without a daemon
    /// answers `unsupported` instead of failing somewhere deeper.
    pub fn require(&self, capability: &str) -> PResult<()> {
        if self.has(capability) {
            Ok(())
        } else {
            Err(ProviderError::unsupported_because(format!(
                "{capability} is not installed"
            )))
        }
    }

    pub fn emit(&self, topic: &'static str, data: impl serde::Serialize) {
        emit(&self.events, topic, data);
    }
}

pub struct LinuxProvider {
    shared: Arc<Shared>,
    events: Arc<tokio::sync::Mutex<mpsc::Receiver<Event>>>,
    watcher: CancellationToken,
    system: system::SystemOps,
    services: services::ServiceOps,
    processes: processes::ProcessOps,
    containers: containers::ContainerOps,
    files: files::FileOps,
    logs: logs::LogOps,
    certs: certs::CertOps,
    sites: sites::SiteOps,
    dns: dns::DnsOps,
    mail: mail::MailOps,
    databases: databases::DatabaseOps,
    firewall: firewall::FirewallOps,
    ssh: ssh::SshOps,
    backups: backups::BackupOps,
    pty: pty::PtyOps,
}

pub async fn open(opts: Options) -> anyhow::Result<ProviderRef> {
    let docker = containers::discover_container_runtime().await.map(Arc::new);
    let runtime = docker.as_ref().map(|d| d.runtime());
    let cap_list = capabilities::detect_capabilities(&capabilities::HostProbe {
        has_binary: &exec::has_binary,
        file_exists: &exec::file_exists,
        dir_exists: &exec::dir_exists,
        container_runtime: runtime,
    });

    let (tx, rx) = mpsc::channel(64);
    let shared = Arc::new(Shared {
        opts,
        caps: cap_list.iter().cloned().collect(),
        cap_list,
        docker,
        rollback: rollback::RollbackGuard::new(),
        names: NameCache::default(),
        events: tx,
        last_metrics: Mutex::new(None),
        ptys: pty::PtySessions::default(),
    });

    let watcher = CancellationToken::new();
    tokio::spawn(watch(shared.clone(), watcher.clone()));

    tracing::info!(capabilities = ?shared.cap_list, "linux provider ready");
    Ok(Arc::new(LinuxProvider {
        system: system::SystemOps(shared.clone()),
        services: services::ServiceOps(shared.clone()),
        processes: processes::ProcessOps(shared.clone()),
        containers: containers::ContainerOps(shared.clone()),
        files: files::FileOps(shared.clone()),
        logs: logs::LogOps(shared.clone()),
        certs: certs::CertOps(shared.clone()),
        sites: sites::SiteOps(shared.clone()),
        dns: dns::DnsOps(shared.clone()),
        mail: mail::MailOps(shared.clone()),
        databases: databases::DatabaseOps(shared.clone()),
        firewall: firewall::FirewallOps(shared.clone()),
        ssh: ssh::SshOps(shared.clone()),
        backups: backups::BackupOps(shared.clone()),
        pty: pty::PtyOps(shared.clone()),
        shared,
        events: Arc::new(tokio::sync::Mutex::new(rx)),
        watcher,
    }))
}

#[async_trait]
impl Provider for LinuxProvider {
    fn capabilities(&self) -> Vec<String> {
        self.shared.cap_list.clone()
    }

    /// The identity block of the hello frame: the subset of the system
    /// info that names this machine to the control plane.
    async fn host(&self, ctx: &Ctx) -> PResult<HostInfo> {
        let info = self.system.info(ctx).await?;
        Ok(HostInfo {
            hostname: info.hostname,
            machine_id: info.machine_id,
            os: info.os,
            os_version: info.os_version,
            arch: info.arch,
            kernel: info.kernel,
            boot_time: info.boot_time,
            simulated: false,
        })
    }

    fn events(&self) -> Option<Arc<tokio::sync::Mutex<mpsc::Receiver<Event>>>> {
        Some(self.events.clone())
    }

    fn system(&self) -> &dyn System {
        &self.system
    }
    fn services(&self) -> &dyn Services {
        &self.services
    }
    fn processes(&self) -> &dyn Processes {
        &self.processes
    }
    fn containers(&self) -> &dyn Containers {
        &self.containers
    }
    fn files(&self) -> &dyn Files {
        &self.files
    }
    fn logs(&self) -> &dyn Logs {
        &self.logs
    }
    fn certs(&self) -> &dyn Certs {
        &self.certs
    }
    fn sites(&self) -> &dyn Sites {
        &self.sites
    }
    fn dns(&self) -> &dyn Dns {
        &self.dns
    }
    fn mail(&self) -> &dyn Mail {
        &self.mail
    }
    fn databases(&self) -> &dyn Databases {
        &self.databases
    }
    fn firewall(&self) -> &dyn Firewall {
        &self.firewall
    }
    fn ssh(&self) -> &dyn Ssh {
        &self.ssh
    }
    fn backups(&self) -> &dyn Backups {
        &self.backups
    }
    fn pty(&self) -> &dyn Pty {
        &self.pty
    }

    async fn close(&self) {
        self.watcher.cancel();
        self.shared.ptys.close_all().await;
        self.shared.rollback.stop().await;
    }
}

/* ------------------------------ watching ----------------------------- */

/// Pushes the state changes the control plane would otherwise poll for. A
/// change nobody is listening for is dropped rather than queued, because
/// the provider must never block on a send.
async fn watch(shared: Arc<Shared>, cancel: CancellationToken) {
    if let Some(docker) = shared.docker.clone() {
        let shared = shared.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move { docker.watch_events(shared, cancel).await });
    }

    let ctx = Ctx::new(cancel.child_token(), None);
    let mut pressured: HashMap<String, bool> = HashMap::new();
    let mut failed: HashSet<String> = HashSet::new();
    let mut ticker = tokio::time::interval(WATCH_INTERVAL);

    loop {
        sample_disk_pressure(&shared, &ctx, &mut pressured).await;
        if shared.has(cap::SYSTEMD) {
            sample_failed_units(&shared, &ctx, &mut failed).await;
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = ticker.tick() => {}
        }
    }
}

async fn sample_disk_pressure(shared: &Arc<Shared>, ctx: &Ctx, pressured: &mut HashMap<String, bool>) {
    let Ok(disks) = system::collect_disks(ctx).await else {
        return;
    };
    for d in disks {
        let over = d.used_percent >= DISK_PRESSURE_PERCENT;
        if over && !pressured.get(&d.mount).copied().unwrap_or(false) {
            shared.emit(topic::DISK_PRESSURE, &d);
        }
        pressured.insert(d.mount.clone(), over);
    }
}

async fn sample_failed_units(shared: &Arc<Shared>, ctx: &Ctx, failed: &mut HashSet<String>) {
    let ops = services::ServiceOps(shared.clone());
    let params = super::ServiceListParams {
        state: Some("failed".into()),
        ..Default::default()
    };
    let Ok(units) = ops.list(ctx, params).await else {
        return;
    };

    let mut current = HashSet::new();
    for unit in &units {
        current.insert(unit.unit.clone());
        if !failed.contains(&unit.unit) {
            shared.emit(topic::SERVICE_CHANGED, unit);
        }
    }
    for name in failed.iter() {
        if !current.contains(name) {
            if let Ok(unit) = ops.status(ctx, name).await {
                shared.emit(topic::SERVICE_CHANGED, &unit);
            }
        }
    }
    *failed = current;
}

/* ------------------------------ name cache --------------------------- */

/// Resolves uid/gid to names. A directory listing asks for the same handful
/// of owners thousands of times, and /etc/passwd lookups are not free.
#[derive(Default)]
pub struct NameCache {
    users: Mutex<HashMap<u32, String>>,
    groups: Mutex<HashMap<u32, String>>,
}

impl NameCache {
    pub fn user(&self, uid: u32) -> String {
        if let Some(name) = self.users.lock().get(&uid) {
            return name.clone();
        }
        let name = nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid))
            .ok()
            .flatten()
            .map(|u| u.name)
            .unwrap_or_else(|| uid.to_string());
        self.users.lock().insert(uid, name.clone());
        name
    }

    pub fn group(&self, gid: u32) -> String {
        if let Some(name) = self.groups.lock().get(&gid) {
            return name.clone();
        }
        let name = nix::unistd::Group::from_gid(nix::unistd::Gid::from_raw(gid))
            .ok()
            .flatten()
            .map(|g| g.name)
            .unwrap_or_else(|| gid.to_string());
        self.groups.lock().insert(gid, name.clone());
        name
    }
}
