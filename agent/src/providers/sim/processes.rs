//! The process table.
//!
//! Rows carry a fixed half (pid, user, command) and a moving half (cpu,
//! rss) recomputed on read so `top`-style pages animate. Kernel threads
//! stay flat because a wobbling `[kswapd0]` is exactly the tell that a
//! table is fake.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::services;
use super::state::{MIB, Sim, World, clampf, drift, mix, round2, stamp};
use crate::providers::{
    Ctx, PResult, ProcessInfo, ProcessListParams, ProcessListResult, ProcessNode, ProcessTreeParams,
    Processes, ProviderError, SignalParams, topic,
};

pub struct Process {
    pub info: ProcessInfo,
    pub unit: String,
    pub cpu_base: f64,
    pub mem_base: i64,
    pub frozen: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ProcSpec {
    pub command: String,
    pub cmdline: String,
    pub user: String,
    pub unit: String,
    pub ppid: i64,
    pub rss: i64,
    pub threads: i64,
    pub state: String,
    pub nice: i64,
    pub cpu: f64,
}

impl ProcSpec {
    pub fn new(command: &str, cmdline: &str, user: &str) -> Self {
        ProcSpec {
            command: command.into(),
            cmdline: cmdline.into(),
            user: user.into(),
            ..Default::default()
        }
    }
    pub fn unit(mut self, unit: &str) -> Self {
        self.unit = unit.into();
        self
    }
    pub fn ppid(mut self, ppid: i64) -> Self {
        self.ppid = ppid;
        self
    }
    pub fn rss(mut self, rss: i64) -> Self {
        self.rss = rss;
        self
    }
    pub fn threads(mut self, threads: i64) -> Self {
        self.threads = threads;
        self
    }
    pub fn state(mut self, state: &str) -> Self {
        self.state = state.into();
        self
    }
    pub fn nice(mut self, nice: i64) -> Self {
        self.nice = nice;
        self
    }
    pub fn cpu(mut self, cpu: f64) -> Self {
        self.cpu = cpu;
        self
    }
}

const KERNEL_THREADS: &[&str] = &[
    "rcu_gp",
    "rcu_par_gp",
    "slub_flushwq",
    "netns",
    "mm_percpu_wq",
    "rcu_tasks_kthre",
    "rcu_tasks_rude_",
    "rcu_tasks_trace",
    "ksoftirqd/0",
    "rcu_preempt",
    "migration/0",
    "idle_inject/0",
    "cpuhp/0",
    "cpuhp/1",
    "idle_inject/1",
    "migration/1",
    "ksoftirqd/1",
    "kdevtmpfs",
    "inet_frag_wq",
    "kauditd",
    "khungtaskd",
    "oom_reaper",
    "writeback",
    "kcompactd0",
    "ksmd",
    "khugepaged",
    "kintegrityd",
    "kblockd",
    "blkcg_punt_bio",
    "tpm_dev_wq",
    "ata_sff",
    "md",
    "edac-poller",
    "devfreq_wq",
    "watchdogd",
    "kswapd0",
    "ecryptfs-kthread",
    "kthrotld",
    "acpi_thermal_pm",
    "vfio-irqfd-cleanup",
    "mld",
    "ipv6_addrconf",
    "kstrp",
    "zswap-shrink",
    "charger_manager",
    "scsi_eh_0",
    "scsi_tmf_0",
    "scsi_eh_1",
    "scsi_tmf_1",
    "jbd2/vda1-8",
    "ext4-rsv-conver",
    "jbd2/vdb1-8",
    "cryptd",
    "kaluad",
    "kmpath_rdacd",
    "kmpathd",
    "kmpath_handlerd",
];

/// Keeps the table around the size of a real busy host, which is what
/// makes the Processes page worth paginating.
const TARGET_PROCESSES: usize = 182;

pub fn build_processes(sim: &Sim) {
    let mut w = sim.world.lock();
    w.pid_seq = 0;
    w.procs.clear();

    add_process(
        sim,
        &mut w,
        ProcSpec::new("systemd", "/sbin/init", "root")
            .rss(12 * MIB)
            .threads(1)
            .state("sleeping")
            .cpu(0.1),
    );
    add_process(
        sim,
        &mut w,
        ProcSpec::new("kthreadd", "[kthreadd]", "root")
            .threads(1)
            .state("sleeping"),
    );
    for name in KERNEL_THREADS {
        add_process(
            sim,
            &mut w,
            ProcSpec::new(name, &format!("[{name}]"), "root")
                .ppid(2)
                .threads(1)
                .state("idle")
                .nice(-20),
        );
    }

    for spec in userland_processes(sim, &w, 1) {
        add_process(sim, &mut w, spec);
    }

    while w.procs.len() < TARGET_PROCESSES {
        let n = w.procs.len() as i64;
        let name = format!("kworker/u{}:{}-events_unbound", n % (2 * sim.id.cpu_cores), n % 9);
        add_process(
            sim,
            &mut w,
            ProcSpec::new(&name, &format!("[{name}]"), "root")
                .ppid(2)
                .threads(1)
                .state("idle"),
        );
    }

    services::sync_unit_pids(&mut w);
}

/// The unit-less processes plus whatever every active unit currently
/// owns, so a stopped unit really has no process and a running container
/// really has a shim.
fn userland_processes(sim: &Sim, w: &World, systemd: i64) -> Vec<ProcSpec> {
    let mut specs =
        vec![
        ProcSpec::new("bash", "-bash", "deploy").ppid(systemd).rss(6 * MIB).threads(1).state("sleeping"),
        ProcSpec::new("agetty", "/sbin/agetty -o -p -- \\u --noclear - linux", "root")
            .ppid(systemd)
            .rss(2 * MIB)
            .threads(1)
            .state("sleeping"),
        ProcSpec::new("polkitd", "/usr/libexec/polkitd --no-debug", "polkitd")
            .ppid(systemd)
            .rss(15 * MIB)
            .threads(3)
            .state("sleeping"),
        ProcSpec::new("irqbalance", "/usr/sbin/irqbalance --foreground", "root")
            .ppid(systemd)
            .rss(5 * MIB)
            .threads(2)
            .state("sleeping"),
        ProcSpec::new(
            "unattended-upgr",
            "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal",
            "root",
        )
        .ppid(systemd)
        .rss(22 * MIB)
        .threads(1)
        .state("sleeping"),
    ];
    for u in &w.units {
        if u.info.active_state != "active" || u.info.sub_state == "exited" {
            continue;
        }
        specs.extend(services::unit_process_specs(sim, w, &u.info.unit, systemd));
    }
    specs
}

pub fn add_process(sim: &Sim, w: &mut World, spec: ProcSpec) {
    w.pid_seq += 1;
    let mut pid = w.pid_seq;
    if pid > 2 {
        // Real pids are sparse; a dense 1..N table reads as generated.
        pid = 300 + pid * 7 + (mix(sim.seed ^ pid as u64) % 5) as i64;
    }

    let started = w.boot_time + chrono::Duration::seconds((mix(sim.seed ^ pid as u64 ^ 0x71) % 420) as i64);
    let state = if spec.state.is_empty() {
        "sleeping".to_string()
    } else {
        spec.state.clone()
    };
    let threads = if spec.threads == 0 { 1 } else { spec.threads };

    w.procs.push(Process {
        info: ProcessInfo {
            pid,
            ppid: spec.ppid,
            user: spec.user,
            command: spec.command,
            cmdline: spec.cmdline,
            state,
            cpu_percent: 0.0,
            memory_rss: spec.rss,
            memory_percent: 0.0,
            threads,
            started_at: stamp(started),
            nice: spec.nice,
        },
        unit: spec.unit,
        cpu_base: spec.cpu,
        mem_base: spec.rss,
        frozen: false,
    });
}

/// Recomputes the moving columns.
pub fn live(sim: &Sim, p: &Process, now: DateTime<Utc>) -> ProcessInfo {
    let mut info = p.info.clone();
    if p.frozen || p.mem_base == 0 {
        return info;
    }

    let t = now.timestamp_millis() as f64 / 1000.0;
    let seed = sim.seed ^ (p.info.pid as u64).wrapping_mul(0x9e3779b1);
    let cpu = clampf(
        p.cpu_base * (1.0 + 1.4 * drift(seed, t / 30.0, 2)) + 0.35 * drift(seed ^ 0x5, t / 7.0, 2).abs(),
        0.0,
        96.0,
    );
    let rss = p.mem_base as f64 * (1.0 + 0.09 * drift(seed ^ 0x9, t / 600.0, 2));

    info.cpu_percent = round2(cpu);
    info.memory_rss = rss as i64;
    info.memory_percent = round2(info.memory_rss as f64 / sim.id.memory_total as f64 * 100.0);
    info
}

pub fn sort_processes(rows: &mut [ProcessInfo], by: &str) {
    match by {
        "memory" => rows.sort_by(|a, b| b.memory_rss.cmp(&a.memory_rss)),
        "pid" => rows.sort_by_key(|r| r.pid),
        "name" => rows.sort_by(|a, b| a.command.cmp(&b.command).then(a.pid.cmp(&b.pid))),
        _ => rows.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    }
}

/// Marks the unit that owned `pid` as failed, returning its name.
fn fail_unit_for_pid(w: &mut World, pid: i64, name: &str) -> Option<String> {
    for u in &mut w.units {
        if u.info.unit != name || u.info.main_pid != Some(pid) {
            continue;
        }
        u.info.active_state = "failed".into();
        u.info.sub_state = "failed".into();
        u.info.main_pid = None;
        u.info.memory_current = None;
        u.info.active_since = None;
        return Some(u.info.unit.clone());
    }
    None
}

pub struct SimProcesses(pub Arc<Sim>);

#[async_trait]
impl Processes for SimProcesses {
    async fn list(&self, _ctx: &Ctx, p: ProcessListParams) -> PResult<ProcessListResult> {
        let now = Utc::now();
        let mut rows: Vec<ProcessInfo> = {
            let w = self.0.world.lock();
            w.procs
                .iter()
                .filter(|proc| {
                    p.user
                        .as_deref()
                        .map_or(true, |u| u.is_empty() || proc.info.user == u)
                })
                .map(|proc| live(&self.0, proc, now))
                .collect()
        };
        let total = rows.len() as i64;
        sort_processes(&mut rows, &p.sort);
        if p.limit > 0 && rows.len() as i64 > p.limit {
            rows.truncate(p.limit as usize);
        }
        Ok(ProcessListResult {
            processes: rows,
            total,
        })
    }

    async fn tree(&self, _ctx: &Ctx, p: ProcessTreeParams) -> PResult<Vec<ProcessNode>> {
        let now = Utc::now();
        let w = self.0.world.lock();

        let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
        let mut by_pid: HashMap<i64, usize> = HashMap::new();
        for (i, proc) in w.procs.iter().enumerate() {
            by_pid.insert(proc.info.pid, i);
            children.entry(proc.info.ppid).or_default().push(i);
        }

        let roots: Vec<usize> = match p.pid {
            Some(pid) => {
                let Some(&idx) = by_pid.get(&pid) else {
                    return Err(ProviderError::not_found(format!("pid {pid}")));
                };
                vec![idx]
            }
            None => children.get(&0).cloned().unwrap_or_default(),
        };

        let mut out = Vec::with_capacity(w.procs.len());
        fn walk(
            sim: &Sim,
            w: &World,
            children: &HashMap<i64, Vec<usize>>,
            procs: &[usize],
            depth: i64,
            now: DateTime<Utc>,
            out: &mut Vec<ProcessNode>,
        ) {
            for &i in procs {
                let proc = &w.procs[i];
                out.push(ProcessNode {
                    process: live(sim, proc, now),
                    depth,
                });
                if depth < 12 {
                    if let Some(kids) = children.get(&proc.info.pid) {
                        walk(sim, w, children, kids, depth + 1, now, out);
                    }
                }
            }
        }
        walk(&self.0, &w, &children, &roots, 0, now, &mut out);
        Ok(out)
    }

    /// Really removes the process, so killing a unit's main pid puts that
    /// unit into `failed` the way it would on a real host.
    async fn signal(&self, _ctx: &Ctx, p: SignalParams) -> PResult<()> {
        let unit = {
            let mut w = self.0.world.lock();
            let Some(index) = w.procs.iter().position(|proc| proc.info.pid == p.pid) else {
                return Err(ProviderError::not_found(format!("pid {}", p.pid)));
            };
            if p.pid == 1 {
                return Err(ProviderError::PermissionDenied("pid 1 is the init system".into()));
            }

            match p.signal.as_str() {
                "SIGSTOP" => {
                    let target = &mut w.procs[index];
                    target.info.state = "stopped".into();
                    target.frozen = true;
                    return Ok(());
                }
                "SIGCONT" => {
                    let target = &mut w.procs[index];
                    target.info.state = "sleeping".into();
                    target.frozen = false;
                    return Ok(());
                }
                "SIGHUP" | "SIGUSR1" | "SIGUSR2" => return Ok(()),
                _ => {}
            }

            let target = w.procs.remove(index);
            fail_unit_for_pid(&mut w, p.pid, &target.unit)
        };

        if let Some(unit) = unit {
            self.0.emit(
                topic::SERVICE_CHANGED,
                serde_json::json!({"unit": unit, "state": "failed"}),
            );
        }
        Ok(())
    }
}
