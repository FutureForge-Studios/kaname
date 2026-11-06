//! Processes.
//!
//! Everything here reads procfs directly. The only write is
//! process.signal, and it takes an enumerated signal name rather than a
//! number, so there is no path from the panel to `kill -9 1` by typo.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use nix::sys::signal::Signal;

use super::Shared;
use super::common::{epoch_rfc3339, invalid, not_found, now_rfc3339};
use super::system::{clamp_percent, parse_meminfo};
use crate::providers::*;

/// The signal set the contract exposes. A name outside this list never
/// reaches a syscall.
fn signal_named(name: &str) -> Option<Signal> {
    Some(match name {
        "SIGTERM" => Signal::SIGTERM,
        "SIGKILL" => Signal::SIGKILL,
        "SIGHUP" => Signal::SIGHUP,
        "SIGINT" => Signal::SIGINT,
        "SIGUSR1" => Signal::SIGUSR1,
        "SIGUSR2" => Signal::SIGUSR2,
        "SIGSTOP" => Signal::SIGSTOP,
        "SIGCONT" => Signal::SIGCONT,
        _ => return None,
    })
}

/// Keeps one pathological java invocation from dominating a process list
/// frame.
const CMDLINE_LIMIT: usize = 2048;

pub struct ProcessOps(pub Arc<Shared>);

#[async_trait]
impl Processes for ProcessOps {
    async fn list(&self, ctx: &Ctx, p: ProcessListParams) -> PResult<ProcessListResult> {
        let mut all = self.snapshot(ctx)?;

        if let Some(user) = p.user.as_deref().filter(|u| !u.is_empty()) {
            all.retain(|entry| entry.user == user);
        }
        let total = all.len() as i64;

        match p.sort.as_str() {
            "memory" => all.sort_by(|a, b| b.memory_rss.cmp(&a.memory_rss)),
            "pid" => all.sort_by(|a, b| a.pid.cmp(&b.pid)),
            "name" => all.sort_by(|a, b| a.command.cmp(&b.command)),
            _ => all.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent)),
        }

        if p.limit > 0 && all.len() as i64 > p.limit {
            all.truncate(p.limit as usize);
        }
        Ok(ProcessListResult {
            processes: all,
            total,
        })
    }

    async fn tree(&self, ctx: &Ctx, p: ProcessTreeParams) -> PResult<Vec<ProcessNode>> {
        let all = self.snapshot(ctx)?;
        build_tree(all, p.pid)
    }

    async fn signal(&self, _ctx: &Ctx, p: SignalParams) -> PResult<()> {
        let Some(signal) = signal_named(&p.signal) else {
            return Err(invalid(format!("{} is not a permitted signal", p.signal)));
        };
        // Signalling pid 1 would take the host down with a "restart this
        // service" click; the panel has system.reboot for that.
        if p.pid == 1 {
            return Err(invalid("pid 1 may not be signalled; use system.reboot"));
        }
        if p.pid <= 0 || p.pid > i32::MAX as i64 {
            return Err(invalid(format!("pid {} is out of range", p.pid)));
        }

        if !Path::new(&format!("/proc/{}", p.pid)).exists() {
            return Err(not_found(format!("process {}", p.pid)));
        }

        match nix::sys::signal::kill(nix::unistd::Pid::from_raw(p.pid as i32), signal) {
            Ok(()) => Ok(()),
            Err(nix::errno::Errno::ESRCH) => Err(not_found(format!("process {}", p.pid))),
            Err(nix::errno::Errno::EPERM) => {
                Err(ProviderError::PermissionDenied(format!("signal {}", p.pid)))
            }
            Err(e) => Err(ProviderError::internal(format!(
                "signal {} with {}: {e}",
                p.pid, p.signal
            ))),
        }
    }
}

/* ------------------------------- internals --------------------------- */

impl ProcessOps {
    /// Reads the whole process table once. A process that exits mid-walk is
    /// skipped rather than failing the call: the table is a sample, not a
    /// transaction.
    fn snapshot(&self, ctx: &Ctx) -> PResult<Vec<ProcessInfo>> {
        let dir = std::fs::read_dir("/proc")
            .map_err(|e| ProviderError::internal(format!("read process table: {e}")))?;
        let host = HostClock::read();

        let mut out = Vec::with_capacity(256);
        for entry in dir.flatten() {
            ctx.check()?;
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else {
                continue;
            };
            if let Some(info) = self.describe(pid, &host) {
                out.push(info);
            }
        }
        Ok(out)
    }

    fn describe(&self, pid: i32, host: &HostClock) -> Option<ProcessInfo> {
        let root = format!("/proc/{pid}");
        let stat = parse_stat(&std::fs::read_to_string(format!("{root}/stat")).ok()?)?;
        let status = std::fs::read_to_string(format!("{root}/status")).unwrap_or_default();
        let status = parse_status(&status);

        let name = status
            .name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| stat.comm.clone());
        let mut info = ProcessInfo {
            pid: pid as i64,
            ppid: stat.ppid as i64,
            command: name.clone(),
            state: process_state(stat.state).to_string(),
            threads: stat.num_threads,
            nice: stat.nice,
            started_at: now_rfc3339(),
            ..Default::default()
        };

        if let Some(uid) = status.uid {
            info.user = self.0.names.user(uid);
        }

        let cmdline = std::fs::read(format!("{root}/cmdline")).unwrap_or_default();
        info.cmdline = truncate_string(format_cmdline(&cmdline).trim(), CMDLINE_LIMIT);
        if info.cmdline.is_empty() {
            // Kernel threads have an empty cmdline; showing the bracketed name
            // is what ps does and what an operator expects to see.
            info.cmdline = format!("[{name}]");
        }

        info.memory_rss = (stat.rss_pages * host.page_size) as i64;
        if host.memory_total > 0 {
            info.memory_percent = clamp_percent(info.memory_rss as f64 / host.memory_total as f64 * 100.0);
        }

        // The share of its own lifetime this process has spent on a cpu,
        // which is what a single reading of the counters can say.
        if host.ticks > 0 && host.boot_secs > 0 {
            let started = host.boot_secs as f64 + stat.starttime as f64 / host.ticks as f64;
            let lifetime = host.now_secs - started;
            if lifetime > 0.0 {
                let cpu_secs = (stat.utime + stat.stime) as f64 / host.ticks as f64;
                info.cpu_percent = clamp_percent(cpu_secs / lifetime * 100.0);
            }
            info.started_at = epoch_rfc3339(started as i64);
        }
        Some(info)
    }
}

/// The host-wide figures every process row is derived against.
struct HostClock {
    ticks: u64,
    page_size: u64,
    boot_secs: u64,
    memory_total: u64,
    now_secs: f64,
}

impl HostClock {
    fn read() -> Self {
        let meminfo = std::fs::read_to_string("/proc/meminfo")
            .map(|s| parse_meminfo(&s))
            .unwrap_or_default();
        Self {
            ticks: nix::unistd::sysconf(nix::unistd::SysconfVar::CLK_TCK)
                .ok()
                .flatten()
                .map(|v| v as u64)
                .unwrap_or(100),
            page_size: nix::unistd::sysconf(nix::unistd::SysconfVar::PAGE_SIZE)
                .ok()
                .flatten()
                .map(|v| v as u64)
                .unwrap_or(4096),
            boot_secs: super::system::boot_time_secs(),
            memory_total: meminfo.get("MemTotal").copied().unwrap_or(0),
            now_secs: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0),
        }
    }
}

/// The fields of `/proc/<pid>/stat` a process row needs.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcStat {
    pub comm: String,
    pub state: char,
    pub ppid: i32,
    pub utime: u64,
    pub stime: u64,
    pub nice: i64,
    pub num_threads: i64,
    pub starttime: u64,
    pub rss_pages: u64,
}

/// Parses a stat line. The command sits in parentheses and may itself hold
/// spaces and parentheses, so the split is on the last `)`.
pub fn parse_stat(raw: &str) -> Option<ProcStat> {
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    let comm = raw[open + 1..close].to_string();
    let rest: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    // rest[0] is the state (field 3); field N of the file is rest[N - 3].
    if rest.len() < 22 {
        return None;
    }
    Some(ProcStat {
        comm,
        state: rest[0].chars().next()?,
        ppid: rest[1].parse().ok()?,
        utime: rest[11].parse().ok()?,
        stime: rest[12].parse().ok()?,
        nice: rest[16].parse().ok()?,
        num_threads: rest[17].parse().ok()?,
        starttime: rest[19].parse().ok()?,
        rss_pages: rest[21].parse().ok()?,
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProcStatus {
    pub name: Option<String>,
    /// The real uid, which is the account `ps` shows.
    pub uid: Option<u32>,
}

pub fn parse_status(raw: &str) -> ProcStatus {
    let mut status = ProcStatus::default();
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("Name:") {
            status.name = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("Uid:") {
            status.uid = value.split_whitespace().next().and_then(|v| v.parse().ok());
        }
    }
    status
}

/// `/proc/<pid>/cmdline` with its NUL separators turned into spaces, the
/// way `ps` prints it.
pub fn format_cmdline(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    text.trim_end_matches('\0')
        .split('\0')
        .collect::<Vec<_>>()
        .join(" ")
}

/// Narrows the kernel's state letters to the contract's enum.
pub fn process_state(state: char) -> &'static str {
    match state {
        'R' => "running",
        'S' | 'W' | 'L' => "sleeping",
        'D' => "disk_sleep",
        'T' | 't' => "stopped",
        'Z' | 'X' | 'x' => "zombie",
        'I' => "idle",
        _ => "unknown",
    }
}

pub fn truncate_string(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut cut = limit;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

/// Lays the table out depth-first from its roots (or from one pid), with
/// each node's depth below its root.
pub fn build_tree(all: Vec<ProcessInfo>, root_pid: Option<i64>) -> PResult<Vec<ProcessNode>> {
    let mut by_pid: HashMap<i64, ProcessInfo> = HashMap::with_capacity(all.len());
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for entry in &all {
        by_pid.insert(entry.pid, entry.clone());
        children.entry(entry.ppid).or_default().push(entry.pid);
    }
    for kids in children.values_mut() {
        kids.sort_unstable();
    }

    let mut roots: Vec<i64> = Vec::new();
    if let Some(pid) = root_pid {
        if !by_pid.contains_key(&pid) {
            return Err(not_found(format!("process {pid}")));
        }
        roots.push(pid);
    } else {
        for entry in &all {
            if !by_pid.contains_key(&entry.ppid) || entry.ppid == entry.pid {
                roots.push(entry.pid);
            }
        }
        roots.sort_unstable();
    }

    let mut nodes = Vec::with_capacity(all.len());
    // Iterative rather than recursive: a corrupted ppid chain on a busy
    // host must not be able to blow the stack of the agent.
    let mut visited: HashSet<i64> = HashSet::new();
    for root in roots.iter().rev() {
        let mut stack: Vec<(i64, i64)> = vec![(*root, 0)];
        while let Some((pid, depth)) = stack.pop() {
            if !visited.insert(pid) {
                continue;
            }
            let Some(info) = by_pid.get(&pid) else { continue };
            nodes.push(ProcessNode {
                process: info.clone(),
                depth,
            });
            if let Some(kids) = children.get(&pid) {
                for kid in kids.iter().rev() {
                    if *kid != pid {
                        stack.push((*kid, depth + 1));
                    }
                }
            }
        }
    }
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_lines_split_on_the_last_paren() {
        let raw = "1234 (tricky (name) x) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 -5 7 0 9000 123456 512 18446744073709551615 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21\n";
        let stat = parse_stat(raw).unwrap();
        assert_eq!(stat.comm, "tricky (name) x");
        assert_eq!(stat.state, 'S');
        assert_eq!(stat.ppid, 1);
        assert_eq!(stat.utime, 250);
        assert_eq!(stat.stime, 50);
        assert_eq!(stat.nice, -5);
        assert_eq!(stat.num_threads, 7);
        assert_eq!(stat.starttime, 9000);
        assert_eq!(stat.rss_pages, 512);
        assert!(parse_stat("garbage").is_none());
    }

    #[test]
    fn status_yields_name_and_real_uid() {
        let status = parse_status("Name:\tnginx\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t33\t33\t33\t33\n");
        assert_eq!(status.name.as_deref(), Some("nginx"));
        assert_eq!(status.uid, Some(33));
    }

    #[test]
    fn cmdlines_are_joined_and_truncated() {
        assert_eq!(
            format_cmdline(b"/usr/bin/python3\0app.py\0--port\08080\0"),
            "/usr/bin/python3 app.py --port 8080"
        );
        assert_eq!(format_cmdline(b""), "");
        assert_eq!(truncate_string("abcdef", 3), "abc…");
        assert_eq!(truncate_string("abc", 3), "abc");
    }

    #[test]
    fn states_narrow_to_the_contract() {
        assert_eq!(process_state('R'), "running");
        assert_eq!(process_state('D'), "disk_sleep");
        assert_eq!(process_state('t'), "stopped");
        assert_eq!(process_state('Z'), "zombie");
        assert_eq!(process_state('?'), "unknown");
    }

    #[test]
    fn signals_outside_the_contract_are_refused() {
        assert!(signal_named("SIGTERM").is_some());
        assert!(signal_named("SIGSEGV").is_none());
        assert!(signal_named("9").is_none());
    }

    fn proc(pid: i64, ppid: i64) -> ProcessInfo {
        ProcessInfo {
            pid,
            ppid,
            command: format!("p{pid}"),
            ..Default::default()
        }
    }

    #[test]
    fn tree_is_depth_first_with_depths_and_survives_cycles() {
        let all = vec![
            proc(1, 0),
            proc(2, 1),
            proc(3, 1),
            proc(4, 2),
            proc(7, 7),
            proc(9, 42),
        ];
        let nodes = build_tree(all.clone(), None).unwrap();
        let laid_out: Vec<(i64, i64)> = nodes.iter().map(|n| (n.process.pid, n.depth)).collect();
        assert_eq!(laid_out, vec![(1, 0), (2, 1), (4, 2), (3, 1), (7, 0), (9, 0)]);

        let sub = build_tree(all.clone(), Some(2)).unwrap();
        let laid_out: Vec<(i64, i64)> = sub.iter().map(|n| (n.process.pid, n.depth)).collect();
        assert_eq!(laid_out, vec![(2, 0), (4, 1)]);

        assert!(matches!(
            build_tree(all, Some(99)),
            Err(ProviderError::NotFound(_))
        ));
    }
}
