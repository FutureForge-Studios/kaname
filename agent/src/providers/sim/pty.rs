//! The fake shell.
//!
//! This is the one place the real provider hands a caller free-form
//! execution, so the simulation has to answer in kind — but over the
//! in-memory filesystem rather than a process. It speaks enough of a
//! terminal to convince xterm.js: it echoes what you type, handles
//! backspace, Ctrl+C and Ctrl+D, swallows arrow keys instead of printing
//! escape garbage, and colours its output.
//!
//! There is still no command string anywhere in the RPC surface: what
//! arrives here is keystrokes on a stream that the control plane has
//! separately permissioned, ticketed and recorded (KD-013).

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use super::files::{FsRef, path_clean, path_ext, path_join};
use super::logs::{self, LogStream};
use super::processes::{live, sort_processes};
use super::services::find_unit;
use super::state::{GIB, KIB, MIB, Sim, human_duration, mix, parse_stamp};
use super::system::{disks, sample};
use crate::providers::{
    Ctx, Encoding, FileEntry, PResult, ProcessInfo, ProviderError, Pty, PtyOpenParams, PtyOpenResult,
    PtyResizeParams, Stream, StreamRef,
};

const CTRL_C: u8 = 0x03;
const CTRL_D: u8 = 0x04;
const CTRL_L: u8 = 0x0c;
const CTRL_U: u8 = 0x15;
const BACKSPACE: u8 = 0x7f;
const ESC: u8 = 0x1b;

// ANSI colours, kept in one place so the shell and `ls` cannot drift.
const ANSI_RESET: &str = "\x1b[0m";
const ANSI_DIR: &str = "\x1b[1;34m";
const ANSI_LINK: &str = "\x1b[1;36m";
const ANSI_EXEC: &str = "\x1b[1;32m";
const ANSI_ARCHIVE: &str = "\x1b[1;31m";
const ANSI_USER: &str = "\x1b[1;32m";
const ANSI_ROOT: &str = "\x1b[1;31m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_WARN: &str = "\x1b[33m";
const ANSI_ERR: &str = "\x1b[31m";
const ANSI_BOLD: &str = "\x1b[1m";

struct PtyState {
    cwd: String,
    previous: String,
    cols: i64,
    rows: i64,
    line: Vec<char>,
    escape: u32,
}

pub struct PtySession {
    sim: Arc<Sim>,
    fs: FsRef,
    who: String,
    user: String,
    /// What `hostname` answers. A container is its own UTS namespace, so
    /// a shell inside one names the container, not the host it runs on.
    hostname: String,
    /// The container this shell is inside, for the banner; None on the host.
    container: Option<String>,
    pub pid: i64,
    #[allow(dead_code)]
    start: DateTime<Utc>,
    state: Mutex<PtyState>,
    cancel: CancellationToken,
}

impl PtySession {
    pub fn new(sim: Arc<Sim>, fs: FsRef, who: &str, cwd: &str, cols: i64, rows: i64) -> Arc<PtySession> {
        let user = who.split('@').next().unwrap_or_default().to_string();
        let cwd = if cwd.is_empty() {
            "/root".to_string()
        } else {
            cwd.to_string()
        };
        let now = Utc::now();
        let pid = 4000 + (mix(sim.seed ^ now.timestamp_nanos_opt().unwrap_or(0) as u64) % 20000) as i64;
        Arc::new(PtySession {
            hostname: sim.id.hostname.clone(),
            container: None,
            sim,
            fs,
            who: who.into(),
            user,
            pid,
            start: now,
            state: Mutex::new(PtyState {
                previous: cwd.clone(),
                cwd,
                cols: if cols <= 0 { 80 } else { cols },
                rows: if rows <= 0 { 24 } else { rows },
                line: Vec::new(),
                escape: 0,
            }),
            cancel: CancellationToken::new(),
        })
    }

    /// A shell inside a container (`container.exec`): rooted in the
    /// container's own filesystem, named after the container's short id the
    /// way Docker names its hostname, and saying so in the banner.
    pub fn for_container(
        sim: Arc<Sim>,
        fs: FsRef,
        name: &str,
        short_id: &str,
        cols: i64,
        rows: i64,
    ) -> Arc<PtySession> {
        let base = PtySession::new(sim, fs, &format!("root@{short_id}"), "/", cols, rows);
        let mut session = Arc::into_inner(base).expect("a session nobody else holds yet");
        session.hostname = short_id.to_string();
        session.container = Some(name.to_string());
        Arc::new(session)
    }

    pub fn resize(&self, cols: i64, rows: i64) {
        let mut st = self.state.lock();
        st.cols = cols;
        st.rows = rows;
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }

    /* ------------------------------ loop ----------------------------- */

    pub async fn run(&self, ctx: &Ctx, stream: &dyn Stream) -> PResult<i64> {
        self.write(stream, &format!("{}{}", self.banner(), self.prompt()))
            .await?;

        loop {
            let chunk = tokio::select! {
                r = stream.recv() => r,
                _ = self.cancel.cancelled() => return Ok(self.pid),
                _ = ctx.done() => return Ok(self.pid),
            };
            let chunk = match chunk {
                Ok(Some(chunk)) => chunk,
                Ok(None) => return Ok(self.pid),
                Err(_) if ctx.is_cancelled() || self.cancel.is_cancelled() => return Ok(self.pid),
                Err(e) => return Err(ProviderError::internal(format!("read terminal input: {e}"))),
            };

            let (out, quit) = self.consume(&chunk);
            if !out.is_empty() {
                self.write(stream, &out).await?;
            }
            if quit {
                return Ok(self.pid);
            }
        }
    }

    async fn write(&self, stream: &dyn Stream, text: &str) -> PResult<()> {
        if text.is_empty() {
            return Ok(());
        }
        stream.send(text.as_bytes(), Encoding::Base64).await
    }

    /// Feeds one chunk of keystrokes through the line editor and returns
    /// everything the terminal should render for them.
    fn consume(&self, chunk: &[u8]) -> (String, bool) {
        let mut out = String::new();

        for &b in chunk {
            // Arrow keys and friends arrive as escape sequences; a terminal
            // that printed them raw would look broken, so they are swallowed.
            {
                let mut st = self.state.lock();
                if st.escape > 0 {
                    st.escape -= 1;
                    if st.escape == 0 && !(b'@'..=b'~').contains(&b) {
                        st.escape = 1;
                    }
                    continue;
                }
            }

            match b {
                ESC => self.state.lock().escape = 2,
                b'\r' | b'\n' => {
                    let line: String = {
                        let mut st = self.state.lock();
                        let line: String = st.line.iter().collect();
                        st.line.clear();
                        line.trim().to_string()
                    };
                    out.push_str("\r\n");
                    if line == "exit" || line == "logout" {
                        out.push_str("logout\r\n");
                        return (out, true);
                    }
                    out.push_str(&self.execute(&line));
                    out.push_str(&self.prompt());
                }
                BACKSPACE | 0x08 => {
                    let mut st = self.state.lock();
                    if st.line.pop().is_some() {
                        out.push_str("\x08 \x08");
                    }
                }
                CTRL_C => {
                    self.state.lock().line.clear();
                    out.push_str("^C\r\n");
                    out.push_str(&self.prompt());
                }
                CTRL_D => {
                    if self.state.lock().line.is_empty() {
                        out.push_str("exit\r\n");
                        return (out, true);
                    }
                }
                CTRL_U => {
                    let mut st = self.state.lock();
                    for _ in 0..st.line.len() {
                        out.push_str("\x08 \x08");
                    }
                    st.line.clear();
                }
                CTRL_L => {
                    let line: String = self.state.lock().line.iter().collect();
                    out.push_str("\x1b[2J\x1b[H");
                    out.push_str(&self.prompt());
                    out.push_str(&line);
                }
                b'\t' => {
                    // No completion; a tab that moved the cursor without
                    // completing anything would be worse than one that does
                    // nothing.
                }
                _ => {
                    if b < 0x20 {
                        continue;
                    }
                    self.state.lock().line.push(b as char);
                    out.push(b as char);
                }
            }
        }
        (out, false)
    }

    fn banner(&self) -> String {
        if let Some(name) = &self.container {
            return format!(
                "{ANSI_DIM}Inside container {ANSI_RESET}{ANSI_BOLD}{name}{ANSI_RESET}{ANSI_DIM} on {}. This is a simulated container; nothing you type here reaches a real machine.{ANSI_RESET}\r\nType {ANSI_BOLD}help{ANSI_RESET} for the commands it understands.\r\n\r\n",
                self.sim.id.hostname
            );
        }
        format!(
            "Linux {} {} #1 SMP PREEMPT_DYNAMIC x86_64\r\n\r\n{ANSI_DIM}This is a simulated host. Nothing you type here reaches a real machine.{ANSI_RESET}\r\nType {ANSI_BOLD}help{ANSI_RESET} for the commands it understands.\r\n\r\n",
            self.sim.id.hostname, self.sim.id.kernel
        )
    }

    fn prompt(&self) -> String {
        let mut cwd = self.current_dir();
        let (colour, sigil) = if self.user == "root" {
            (ANSI_ROOT, "#")
        } else {
            (ANSI_USER, "$")
        };
        if cwd == "/root" || cwd == format!("/home/{}", self.user) {
            cwd = "~".into();
        }
        format!(
            "{colour}{}{ANSI_RESET}:{ANSI_DIR}{cwd}{ANSI_RESET}{sigil} ",
            self.who
        )
    }

    /* ---------------------------- commands --------------------------- */

    fn execute(&self, line: &str) -> String {
        if line.is_empty() {
            return String::new();
        }
        let argv = split_args(line);
        let Some(cmd) = argv.first() else {
            return String::new();
        };
        let args: Vec<String> = argv[1..].to_vec();

        match cmd.as_str() {
            "help" => self.help(),
            "pwd" => format!("{}\r\n", self.current_dir()),
            "whoami" => format!("{}\r\n", self.user),
            "hostname" => format!("{}\r\n", self.hostname),
            "clear" => "\x1b[2J\x1b[H".into(),
            "echo" => format!("{}\r\n", args.join(" ")),
            "cd" => self.cd(&args),
            "ls" | "dir" => self.ls(&args),
            "ll" => {
                let mut ll = vec!["-l".to_string()];
                ll.extend(args);
                self.ls(&ll)
            }
            "cat" => self.cat(&args),
            "tail" => self.tail(&args),
            "uname" => self.uname(&args),
            "uptime" => self.uptime(),
            "df" => self.df(&args),
            "free" => self.free(&args),
            "ps" => self.ps(&args),
            "systemctl" => self.systemctl(&args),
            "exit" | "logout" => String::new(),
            other => format!("{ANSI_ERR}bash: {other}: command not found{ANSI_RESET}\r\n"),
        }
    }

    fn help(&self) -> String {
        let rows: &[(&str, &str)] = &[
            ("cd [dir]", "change directory (- goes back)"),
            ("ls [-l] [-a] [path]", "list a directory"),
            ("pwd", "print the working directory"),
            ("cat <file>...", "print a file"),
            ("tail [-n N] <file>", "print the end of a file or log"),
            ("echo <text>", "print text"),
            ("whoami", "print the current user"),
            ("uname [-a|-r|-s]", "print kernel information"),
            ("uptime", "how long the host has been up"),
            ("df [-h]", "filesystem usage"),
            ("free [-h]", "memory usage"),
            ("ps [aux]", "process table"),
            ("systemctl status <unit>", "unit state"),
            ("clear", "clear the screen"),
            ("exit", "close the session"),
        ];
        let mut b = format!("{ANSI_BOLD}Available commands{ANSI_RESET}\r\n");
        for (cmd, desc) in rows {
            b.push_str(&format!("  {ANSI_EXEC}{cmd:<26}{ANSI_RESET} {desc}\r\n"));
        }
        b
    }

    fn current_dir(&self) -> String {
        self.state.lock().cwd.clone()
    }

    fn home(&self) -> String {
        if self.user == "root" {
            "/root".into()
        } else {
            format!("/home/{}", self.user)
        }
    }

    fn resolve(&self, arg: &str) -> String {
        if arg.is_empty() || arg == "~" {
            self.home()
        } else if let Some(rest) = arg.strip_prefix("~/") {
            path_join(&self.home(), rest)
        } else if arg.starts_with('/') {
            path_clean(arg)
        } else {
            path_join(&self.current_dir(), arg)
        }
    }

    fn cd(&self, args: &[String]) -> String {
        let target = args.first().map(String::as_str).unwrap_or("");
        if target == "-" {
            let mut guard = self.state.lock();
            let st = &mut *guard;
            std::mem::swap(&mut st.cwd, &mut st.previous);
            return format!("{}\r\n", st.cwd);
        }

        let resolved = self.resolve(target);
        let actual = {
            let fs = self.fs.read();
            match fs.lookup(&resolved, true) {
                Err(_) => {
                    return format!(
                        "{ANSI_ERR}bash: cd: {resolved}: No such file or directory{ANSI_RESET}\r\n"
                    );
                }
                Ok((n, _)) if !n.is_dir() => {
                    return format!("{ANSI_ERR}bash: cd: {resolved}: Not a directory{ANSI_RESET}\r\n");
                }
                Ok((_, actual)) => actual,
            }
        };

        let mut guard = self.state.lock();
        let st = &mut *guard;
        st.previous = std::mem::replace(&mut st.cwd, actual);
        String::new()
    }

    fn ls(&self, args: &[String]) -> String {
        let (mut long, mut all, mut target) = (false, false, "");
        for arg in args {
            if arg.starts_with('-') {
                long = long || arg.contains('l');
                all = all || arg.contains('a') || arg.contains('A');
                continue;
            }
            target = arg;
        }

        let resolved = if target.is_empty() {
            self.current_dir()
        } else {
            self.resolve(target)
        };

        let fs = self.fs.read();
        let (n, actual) = match fs.lookup(&resolved, true) {
            Ok(v) => v,
            Err(_) => {
                return format!(
                    "{ANSI_ERR}ls: cannot access '{resolved}': No such file or directory{ANSI_RESET}\r\n"
                );
            }
        };
        if !n.is_dir() {
            return format!("{}\r\n", render_entry(&fs.entry(n, &actual), long));
        }

        let mut entries: Vec<FileEntry> = n
            .children
            .iter()
            .filter(|(name, _)| all || !name.starts_with('.'))
            .map(|(name, child)| fs.entry(child, &path_join(&actual, name)))
            .collect();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        let mut b = String::new();
        if long {
            b.push_str(&format!("total {}\r\n", entries.len() * 4));
            for entry in &entries {
                b.push_str(&render_entry(entry, true));
                b.push_str("\r\n");
            }
            return b;
        }

        // Four columns is what an 80-column terminal fits comfortably.
        const COLUMNS: usize = 4;
        let width = entries.iter().map(|e| e.name.chars().count()).max().unwrap_or(0);
        for (i, entry) in entries.iter().enumerate() {
            b.push_str(&format!(
                "{}{:<width$}{ANSI_RESET}  ",
                colour_for(entry),
                entry.name,
                width = width
            ));
            if (i + 1) % COLUMNS == 0 {
                b.push_str("\r\n");
            }
        }
        if entries.len() % COLUMNS != 0 {
            b.push_str("\r\n");
        }
        b
    }

    fn cat(&self, args: &[String]) -> String {
        if args.is_empty() {
            return "usage: cat <file>...\r\n".into();
        }
        let mut b = String::new();
        for arg in args {
            let resolved = self.resolve(arg);
            let looked = {
                let fs = self.fs.read();
                fs.lookup(&resolved, true).ok().map(|(n, _)| n.clone())
            };
            match looked {
                None => b.push_str(&format!(
                    "{ANSI_ERR}cat: {resolved}: No such file or directory{ANSI_RESET}\r\n"
                )),
                Some(n) if n.is_dir() => b.push_str(&format!(
                    "{ANSI_ERR}cat: {resolved}: Is a directory{ANSI_RESET}\r\n"
                )),
                Some(n) if n.is_virtual() => {
                    if let Some(stream) = logs::stream_for_path(&self.sim, &resolved) {
                        b.push_str(&self.render_log_lines(&stream, 20));
                        continue;
                    }
                    b.push_str(&format!(
                        "{ANSI_WARN}cat: {resolved}: binary file ({} bytes){ANSI_RESET}\r\n",
                        n.size()
                    ));
                }
                Some(n) => b.push_str(&crlf(&String::from_utf8_lossy(&n.data))),
            }
        }
        b
    }

    fn tail(&self, args: &[String]) -> String {
        let (mut lines, mut target) = (10i64, String::new());
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];
            if arg == "-n" && i + 1 < args.len() {
                if let Ok(parsed) = args[i + 1].parse::<i64>() {
                    lines = parsed;
                }
                i += 1;
            } else if let Some(rest) = arg.strip_prefix("-n") {
                if let Ok(parsed) = rest.parse::<i64>() {
                    lines = parsed;
                }
            } else if arg.starts_with("-f") {
                // Following would hold the line editor hostage; the Logs
                // module is where a live tail belongs.
            } else {
                target = arg.clone();
            }
            i += 1;
        }
        if target.is_empty() {
            return "usage: tail [-n lines] <file>\r\n".into();
        }
        if !(1..=500).contains(&lines) {
            lines = 10;
        }

        let resolved = self.resolve(&target);
        if let Some(stream) = logs::stream_for_path(&self.sim, &resolved) {
            return self.render_log_lines(&stream, lines);
        }

        let n = {
            let fs = self.fs.read();
            match fs.lookup(&resolved, true) {
                Ok((n, _)) => n.clone(),
                Err(_) => {
                    return format!(
                        "{ANSI_ERR}tail: cannot open '{resolved}' for reading: No such file or directory{ANSI_RESET}\r\n"
                    );
                }
            }
        };
        if n.is_virtual() {
            return format!(
                "{ANSI_WARN}tail: {resolved}: binary file ({} bytes){ANSI_RESET}\r\n",
                n.size()
            );
        }

        let text = String::from_utf8_lossy(&n.data);
        let all: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
        let start = all.len().saturating_sub(lines as usize);
        crlf(&format!("{}\n", all[start..].join("\n")))
    }

    /// Lets `cat` and `tail` reach the generated log streams, so
    /// /var/log/nginx/access.log is not a dead blob in the terminal.
    fn render_log_lines(&self, stream: &LogStream, lines: i64) -> String {
        let origin = self.sim.boot_time();
        let last = stream.index_at(origin, Utc::now());
        let first = (last - lines).max(0);

        let mut b = String::new();
        for n in first..=last {
            let record = stream.render(&self.sim, n, stream.at(origin, n));
            let colour = match record.level.as_str() {
                "warn" => ANSI_WARN,
                "error" => ANSI_ERR,
                _ => "",
            };
            b.push_str(&format!("{colour}{}{ANSI_RESET}\r\n", record.message));
        }
        b
    }

    fn uname(&self, args: &[String]) -> String {
        let id = &self.sim.id;
        match args.first().map(String::as_str) {
            None => "Linux\r\n".into(),
            Some("-a") => format!(
                "Linux {} {} #1 SMP PREEMPT_DYNAMIC Debian 6.1.76-1 (2024-02-01) x86_64 GNU/Linux\r\n",
                id.hostname, id.kernel
            ),
            Some("-r") => format!("{}\r\n", id.kernel),
            Some("-n") => format!("{}\r\n", id.hostname),
            Some("-m") => "x86_64\r\n".into(),
            _ => "Linux\r\n".into(),
        }
    }

    fn uptime(&self) -> String {
        let now = Utc::now();
        let s = sample(&self.sim, now);
        let (boot, sessions) = {
            let w = self.sim.world.lock();
            (w.boot_time, w.ssh_sessions.len())
        };
        let up = (now - boot).num_seconds().max(0);
        let days = up / 86400;
        let hours = (up / 3600) % 24;
        let minutes = (up / 60) % 60;
        format!(
            " {} up {days} days, {hours:>2}:{minutes:02},  {sessions} users,  load average: {:.2}, {:.2}, {:.2}\r\n",
            now.format("%H:%M:%S"),
            s.load1,
            s.load5,
            s.load15
        )
    }

    fn df(&self, args: &[String]) -> String {
        let human = args.iter().any(|a| a.contains('h'));
        let mut b = format!(
            "{:<18} {:>10} {:>10} {:>10} {:>5} {}\r\n",
            "Filesystem",
            if human { "Size" } else { "1K-blocks" },
            "Used",
            "Avail",
            "Use%",
            "Mounted on"
        );
        for disk in disks(&self.sim, Utc::now()) {
            b.push_str(&format!(
                "{:<18} {:>10} {:>10} {:>10} {:>4.0}% {}\r\n",
                disk.device,
                block_size(disk.total, human),
                block_size(disk.used, human),
                block_size(disk.available, human),
                disk.used_percent,
                disk.mount
            ));
        }
        b
    }

    fn free(&self, args: &[String]) -> String {
        let human = args.iter().any(|a| a.contains('h'));
        let s = sample(&self.sim, Utc::now());
        let cached = s.memory_cached.unwrap_or(0);
        let free = (s.memory_total - s.memory_used - cached).max(0);
        let format = |v: i64| {
            if human {
                human_bytes(v)
            } else {
                (v / KIB).to_string()
            }
        };

        let mut b = format!(
            "{:>15} {:>11} {:>11} {:>11} {:>11} {:>11}\r\n",
            "total", "used", "free", "shared", "buff/cache", "available"
        );
        b.push_str(&format!(
            "Mem:   {:>8} {:>11} {:>11} {:>11} {:>11} {:>11}\r\n",
            format(s.memory_total),
            format(s.memory_used),
            format(free),
            format(s.memory_total / 64),
            format(cached),
            format(free + cached)
        ));
        b.push_str(&format!(
            "Swap:  {:>8} {:>11} {:>11}\r\n",
            format(s.swap_total),
            format(s.swap_used),
            format(s.swap_total - s.swap_used)
        ));
        b
    }

    fn ps(&self, args: &[String]) -> String {
        let joined = args.join("");
        let full = joined.chars().any(|c| "aeuxf".contains(c));
        let now = Utc::now();

        let (mut rows, total): (Vec<ProcessInfo>, usize) = {
            let w = self.sim.world.lock();
            let rows: Vec<ProcessInfo> = w.procs.iter().map(|p| live(&self.sim, p, now)).collect();
            let total = rows.len();
            (rows, total)
        };

        sort_processes(&mut rows, "cpu");
        let limit = if full { 24 } else { 6 };
        rows.truncate(limit);

        let mut b = format!(
            "{ANSI_BOLD}{:<9} {:>6} {:>5} {:>5} {:>8} {:<8} {}{ANSI_RESET}\r\n",
            "USER", "PID", "%CPU", "%MEM", "RSS", "STAT", "COMMAND"
        );
        for row in &rows {
            b.push_str(&format!(
                "{:<9} {:>6} {:>5.1} {:>5.1} {:>8} {:<8} {}\r\n",
                truncate_text(&row.user, 9),
                row.pid,
                row.cpu_percent,
                row.memory_percent,
                row.memory_rss / KIB,
                stat_letter(&row.state),
                truncate_text(&row.cmdline, 46)
            ));
        }
        if !full {
            b.push_str(&format!(
                "{ANSI_DIM}(showing {} of {total}; try `ps aux`){ANSI_RESET}\r\n",
                rows.len()
            ));
        }
        b
    }

    fn systemctl(&self, args: &[String]) -> String {
        if args.is_empty() {
            return "systemctl: try `systemctl status <unit>`\r\n".into();
        }
        if args[0] != "status" || args.len() < 2 {
            return format!(
                "{ANSI_WARN}systemctl: only `status <unit>` is available in this shell{ANSI_RESET}\r\n"
            );
        }

        let mut name = args[1].clone();
        if !name.contains('.') {
            name.push_str(".service");
        }

        let (info, pids) = {
            let w = self.sim.world.lock();
            let Some(idx) = find_unit(&w, &name) else {
                return format!("{ANSI_ERR}Unit {name} could not be found.{ANSI_RESET}\r\n");
            };
            let info = w.units[idx].info.clone();
            let pids: Vec<ProcessInfo> = w
                .procs
                .iter()
                .filter(|p| p.unit == name)
                .map(|p| p.info.clone())
                .collect();
            (info, pids)
        };

        let colour = match info.active_state.as_str() {
            "failed" => ANSI_ERR,
            "inactive" => ANSI_DIM,
            _ => ANSI_EXEC,
        };

        let mut b = format!("{colour}●{ANSI_RESET} {} - {}\r\n", info.unit, info.description);
        b.push_str(&format!(
            "     Loaded: {} (/lib/systemd/system/{}; {}; preset: enabled)\r\n",
            info.load_state,
            info.unit,
            if info.enabled { "enabled" } else { "disabled" }
        ));

        let since = match info.active_since.as_deref().and_then(parse_stamp) {
            Some(parsed) => format!(
                "{}; {} ago",
                parsed.format("%a %Y-%m-%d %H:%M:%S UTC"),
                human_duration(Utc::now() - parsed)
            ),
            None => "n/a".into(),
        };
        b.push_str(&format!(
            "     Active: {colour}{} ({}){ANSI_RESET} since {since}\r\n",
            info.active_state, info.sub_state
        ));

        if let Some(pid) = info.main_pid {
            b.push_str(&format!("   Main PID: {pid}\r\n"));
        }
        if let Some(mem) = info.memory_current {
            b.push_str(&format!("     Memory: {}\r\n", human_bytes(mem)));
        }
        b.push_str(&format!("      Tasks: {}\r\n", pids.len()));

        if !pids.is_empty() {
            b.push_str(&format!("     CGroup: /system.slice/{}\r\n", info.unit));
            for (i, proc) in pids.iter().enumerate() {
                let branch = if i == pids.len() - 1 { "└─" } else { "├─" };
                b.push_str(&format!(
                    "             {branch}{} {}\r\n",
                    proc.pid,
                    truncate_text(&proc.cmdline, 52)
                ));
            }
        }
        b
    }
}

/* ------------------------------ rendering ---------------------------- */

fn render_entry(entry: &FileEntry, long: bool) -> String {
    if !long {
        return format!("{}{}{ANSI_RESET}", colour_for(entry), entry.name);
    }
    let modified = parse_stamp(&entry.modified_at).unwrap_or_else(Utc::now);
    let mut name = format!("{}{}{ANSI_RESET}", colour_for(entry), entry.name);
    if entry.kind == "symlink" {
        if let Some(target) = &entry.link_target {
            name.push_str(&format!(" -> {target}"));
        }
    }
    format!(
        "{} {:>2} {:<9} {:<9} {:>8} {} {}",
        mode_string(&entry.kind, &entry.mode),
        link_count(entry),
        entry.owner,
        entry.group,
        entry.size,
        modified.format("%b %e %H:%M"),
        name
    )
}

fn link_count(entry: &FileEntry) -> i64 {
    match (entry.kind.as_str(), entry.child_count) {
        ("directory", Some(count)) => count + 2,
        _ => 1,
    }
}

fn mode_string(kind: &str, octal: &str) -> String {
    let prefix = match kind {
        "directory" => "d",
        "symlink" => "l",
        "socket" => "s",
        "fifo" => "p",
        "device" => "c",
        _ => "-",
    };
    let mut digits: String = if octal.len() == 4 {
        octal[1..].to_string()
    } else {
        octal.to_string()
    };
    while digits.len() < 3 {
        digits.insert(0, '0');
    }
    let mut b = String::from(prefix);
    for digit in digits.chars() {
        let value = digit.to_digit(10).unwrap_or(0);
        for (mask, letter) in [(4, 'r'), (2, 'w'), (1, 'x')] {
            b.push(if value & mask != 0 { letter } else { '-' });
        }
    }
    b
}

fn colour_for(entry: &FileEntry) -> &'static str {
    if entry.kind == "directory" {
        return ANSI_DIR;
    }
    if entry.kind == "symlink" {
        return ANSI_LINK;
    }
    if (entry.mode.starts_with("07") || entry.mode.ends_with("755") || entry.mode.ends_with("775"))
        && entry.kind == "file"
    {
        return ANSI_EXEC;
    }
    match path_ext(&entry.name).as_str() {
        ".gz" | ".zst" | ".zip" | ".tar" | ".deb" => ANSI_ARCHIVE,
        _ => "",
    }
}

fn block_size(bytes: i64, human: bool) -> String {
    if human {
        human_bytes(bytes)
    } else {
        (bytes / KIB).to_string()
    }
}

pub fn human_bytes(bytes: i64) -> String {
    if bytes >= GIB {
        format!("{:.1}G", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1}M", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1}K", bytes as f64 / KIB as f64)
    } else {
        bytes.to_string()
    }
}

fn stat_letter(state: &str) -> &'static str {
    match state {
        "running" => "R",
        "sleeping" => "S",
        "disk_sleep" => "D",
        "stopped" => "T",
        "zombie" => "Z",
        "idle" => "I",
        _ => "?",
    }
}

/// Handles the quoting a shell user expects without pretending to be a
/// shell: no expansion, no substitution, no operators.
pub fn split_args(line: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for r in line.chars() {
        match quote {
            Some(q) => {
                if r == q {
                    quote = None;
                } else {
                    current.push(r);
                }
            }
            None => match r {
                '\'' | '"' => quote = Some(r),
                ' ' | '\t' => {
                    if !current.is_empty() {
                        args.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(r),
            },
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// Converts to the line endings a raw terminal needs; a bare \n leaves the
/// cursor in the middle of the screen.
fn crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn truncate_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

/* --------------------------------- pty ------------------------------- */

pub struct SimPty(pub Arc<Sim>);

#[async_trait]
impl Pty for SimPty {
    async fn open(
        &self,
        ctx: &Ctx,
        session_id: &str,
        p: PtyOpenParams,
        s: StreamRef,
    ) -> PResult<PtyOpenResult> {
        let user = p.user.filter(|u| !u.is_empty()).unwrap_or_else(|| "root".into());
        let cwd = p.cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| {
            if user == "root" {
                "/root".to_string()
            } else {
                format!("/home/{user}")
            }
        });

        let who = format!("{user}@{}", self.0.short_host());
        let session = PtySession::new(self.0.clone(), self.0.fs.clone(), &who, &cwd, p.cols, p.rows);
        self.0
            .world
            .lock()
            .ptys
            .insert(session_id.to_string(), session.clone());

        let result = session.run(ctx, &*s).await;
        self.0.world.lock().ptys.remove(session_id);
        result.map(|pid| PtyOpenResult { pid })
    }

    async fn resize(&self, _ctx: &Ctx, session_id: &str, p: PtyResizeParams) -> PResult<()> {
        let session = self.0.world.lock().ptys.get(session_id).cloned();
        match session {
            Some(session) => {
                session.resize(p.cols, p.rows);
                Ok(())
            }
            None => Err(ProviderError::not_found(format!("terminal session {session_id}"))),
        }
    }

    async fn close(&self, _ctx: &Ctx, session_id: &str) -> PResult<()> {
        let session = self.0.world.lock().ptys.remove(session_id);
        match session {
            Some(session) => {
                session.stop();
                Ok(())
            }
            None => Err(ProviderError::not_found(format!("terminal session {session_id}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_args_honours_quotes() {
        assert_eq!(
            split_args("echo 'hello world' \"a b\" c"),
            vec!["echo", "hello world", "a b", "c"]
        );
        assert_eq!(split_args("   "), Vec::<String>::new());
    }

    #[test]
    fn mode_string_renders_octal() {
        assert_eq!(mode_string("directory", "0755"), "drwxr-xr-x");
        assert_eq!(mode_string("file", "0600"), "-rw-------");
        assert_eq!(mode_string("symlink", "0777"), "lrwxrwxrwx");
    }
}
