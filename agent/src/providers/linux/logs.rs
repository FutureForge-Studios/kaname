//! Logs.
//!
//! journald is read through `journalctl --output=json` invoked with an
//! argv slice — never a shell string, because a unit name is attacker
//! influenced. Plain files are tailed directly, with rotation detected by
//! inode identity rather than by guessing from the size.
//!
//! Streamed lines travel as newline-delimited JSON records; the settled
//! result carries the backlog that was already there when the tail began.

use std::collections::BTreeMap;
use std::io::SeekFrom;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};

use super::Shared;
use super::common::{epoch_rfc3339, invalid, not_found, now_rfc3339, split_lines};
use super::exec::{ExecOptions, run_stream};
use super::paths::validate_path;
use super::services::{check_unit_pattern, qualify};
use crate::providers::*;

/// How long a file tail sleeps between polls when it is caught up.
const TAIL_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Bound on a single log line, so one runaway process cannot make the
/// agent allocate without limit.
const MAX_LOG_LINE: usize = 1 << 20;

/// Well-known files worth offering even before anything has been
/// configured. Anything absent is simply not advertised.
const WELL_KNOWN_LOG_FILES: &[(&str, &str, &str)] = &[
    ("/var/log/syslog", "System log", "file"),
    ("/var/log/messages", "System messages", "file"),
    ("/var/log/auth.log", "Authentication", "file"),
    ("/var/log/secure", "Authentication", "file"),
    ("/var/log/kern.log", "Kernel", "file"),
    ("/var/log/mail.log", "Mail transport", "mail"),
    ("/var/log/maillog", "Mail transport", "mail"),
    ("/var/log/nginx/access.log", "nginx access", "nginx_access"),
    ("/var/log/nginx/error.log", "nginx error", "nginx_error"),
    ("/var/log/apache2/access.log", "Apache access", "nginx_access"),
    ("/var/log/apache2/error.log", "Apache error", "nginx_error"),
];

pub struct LogOps(pub Arc<Shared>);

#[async_trait]
impl Logs for LogOps {
    async fn sources(&self, ctx: &Ctx) -> PResult<Vec<LogSource>> {
        let mut sources = Vec::with_capacity(16);

        if self.0.has(cap::SYSTEMD) {
            sources.push(LogSource {
                id: "journald".into(),
                label: "System journal".into(),
                kind: "journald".into(),
                r#ref: String::new(),
                size: None,
                supports_follow: true,
            });
        }

        let mut seen = std::collections::HashSet::new();
        let mut add_file = |path: &str, label: String, kind: &str, sources: &mut Vec<LogSource>| {
            if seen.contains(path) {
                return;
            }
            let Ok(meta) = std::fs::metadata(path) else { return };
            if meta.is_dir() {
                return;
            }
            seen.insert(path.to_string());
            sources.push(LogSource {
                id: format!("file:{path}"),
                label,
                kind: kind.into(),
                r#ref: path.into(),
                size: Some(meta.len() as i64),
                supports_follow: true,
            });
        };

        for (path, label, kind) in WELL_KNOWN_LOG_FILES {
            add_file(path, label.to_string(), kind, &mut sources);
        }
        for dir in ["/var/log/nginx", "/var/log/apache2", "/var/log/caddy"] {
            let Ok(matches) = glob::glob(&format!("{dir}/*.log")) else {
                continue;
            };
            let base_dir = Path::new(dir).file_name().and_then(|n| n.to_str()).unwrap_or(dir);
            for entry in matches.flatten() {
                let path = entry.to_string_lossy().into_owned();
                let kind = if path.contains("error") {
                    "nginx_error"
                } else if path.contains("access") {
                    "nginx_access"
                } else {
                    "file"
                };
                let base = entry
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                add_file(&path, format!("{base_dir} {base}"), kind, &mut sources);
            }
        }

        if self.0.docker.is_some() {
            let containers = super::containers::ContainerOps(self.0.clone());
            if let Ok(list) = containers.list(ctx, ContainerListParams::default()).await {
                for container in list {
                    sources.push(LogSource {
                        id: format!("container:{}", container.id),
                        label: container.name,
                        kind: "container".into(),
                        r#ref: container.id,
                        size: None,
                        supports_follow: true,
                    });
                }
            }
        }
        Ok(sources)
    }

    async fn tail(&self, ctx: &Ctx, p: LogTailParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        let (kind, r#ref) = parse_log_source(&p.source)?;

        let filter = RecordFilter {
            level: p.level.clone().unwrap_or_default(),
            query: p.query.clone().unwrap_or_default(),
        };
        filter.validate()?;

        match kind {
            "journald" => {
                self.0.require(cap::SYSTEMD)?;
                let mut query = JournalQuery {
                    args: Vec::new(),
                    source: p.source.clone(),
                    lines: p.lines,
                    follow: p.follow,
                    filter,
                };
                if !r#ref.is_empty() {
                    query.args.push(format!("--unit={}", qualify(&r#ref)));
                }
                if let Some(since) = p.since.as_deref().filter(|s| !s.is_empty()) {
                    query.args.push(format!("--since={}", journal_since(since)?));
                }
                journal(ctx, query, Some(s)).await
            }
            "container" => {
                super::containers::ContainerOps(self.0.clone())
                    .logs(
                        ctx,
                        ContainerLogsParams {
                            id: r#ref,
                            lines: p.lines,
                            follow: p.follow,
                            since: p.since.clone(),
                        },
                        s,
                    )
                    .await
            }
            "file" => tail_file(ctx, &r#ref, p.lines, p.follow, &filter, Some(s)).await,
            _ => Err(invalid(format!("unknown log source {:?}", p.source))),
        }
    }
}

/* ------------------------------- journald ---------------------------- */

pub struct JournalQuery {
    /// Extra journalctl selectors, already built as argv items.
    pub args: Vec<String>,
    pub source: String,
    pub lines: i64,
    pub follow: bool,
    pub filter: RecordFilter,
}

/// Runs journalctl and returns the backlog it printed first, streaming
/// everything after that as it arrives.
pub async fn journal(ctx: &Ctx, q: JournalQuery, stream: Option<StreamRef>) -> PResult<Vec<LogRecord>> {
    let lines = if q.lines <= 0 { 200 } else { q.lines as usize };

    let mut args = vec![
        "--no-pager".to_string(),
        "--output=json".to_string(),
        format!("--lines={lines}"),
    ];
    if let Some(priority) = journal_priority(&q.filter.level) {
        args.push(format!("--priority={priority}"));
    }
    args.extend(q.args.iter().cloned());
    if q.follow {
        args.push("--follow".into());
    }

    // journalctl --follow never ends on its own, so the child context is
    // what ends it: run_stream kills the process when the context is done,
    // whether because the caller cancelled or because the stream closed.
    let child = ctx.child();
    let sink = Arc::new(JournalSink {
        inner: if q.follow { stream } else { None },
        source: q.source.clone(),
        lines,
        filter: q.filter,
        backlog: Mutex::new(Vec::with_capacity(lines)),
        failure: Mutex::new(None),
        cancel: child.clone(),
    });

    let result = run_stream(
        &child,
        sink.as_ref(),
        ExecOptions::new("journalctl", args).c_locale(),
        None,
    )
    .await;
    let backlog = std::mem::take(&mut *sink.backlog.lock());
    if let Some(err) = sink.failure.lock().take() {
        return Err(err);
    }
    match result {
        Ok(out) => {
            // A journalctl that exits non-zero printed its complaint on
            // stderr, which the merged capture holds; without any records
            // that complaint is the answer.
            if !out.success() && backlog.is_empty() && !ctx.is_cancelled() {
                return Err(super::exec::exec_error("journalctl", &out.stdout, out.code));
            }
            Ok(backlog)
        }
        // The caller going away is the normal end of a followed journal,
        // not a failure of it.
        Err(ProviderError::Cancelled) | Err(ProviderError::Timeout) => Ok(backlog),
        Err(err) => Err(err),
    }
}

/// Receives journalctl's output a line at a time, keeps the first `lines`
/// records as the backlog and relays the rest to the real stream.
struct JournalSink {
    inner: Option<StreamRef>,
    source: String,
    lines: usize,
    filter: RecordFilter,
    backlog: Mutex<Vec<LogRecord>>,
    failure: Mutex<Option<ProviderError>>,
    cancel: Ctx,
}

#[async_trait]
impl Stream for JournalSink {
    async fn send(&self, data: &[u8], _enc: Encoding) -> PResult<()> {
        for line in data.split(|b| *b == b'\n') {
            if line.is_empty() || line.len() > MAX_LOG_LINE {
                continue;
            }
            let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(line) else {
                continue;
            };
            let record = journal_record(&parsed, &self.source);
            if !self.filter.matches(&record) {
                continue;
            }
            {
                let mut backlog = self.backlog.lock();
                if backlog.len() < self.lines {
                    backlog.push(record);
                    continue;
                }
            }
            let Some(inner) = &self.inner else { continue };
            if let Err(err) = send_record(inner.as_ref(), &record).await {
                *self.failure.lock() = Some(err);
                self.cancel.cancel();
                return Ok(());
            }
        }
        Ok(())
    }

    async fn recv(&self) -> PResult<Option<Vec<u8>>> {
        Ok(None)
    }
}

/// One journald JSON export line as the panel sees it.
pub fn journal_record(parsed: &serde_json::Value, source: &str) -> LogRecord {
    let text = |key: &str| parsed.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut record = LogRecord {
        ts: now_rfc3339(),
        level: journal_level(&text("PRIORITY")).to_string(),
        source: source.to_string(),
        message: decode_journal_message(parsed.get("MESSAGE")),
        fields: BTreeMap::new(),
        cursor: Some(text("__CURSOR")).filter(|c| !c.is_empty()),
    };
    if let Ok(micros) = text("__REALTIME_TIMESTAMP").parse::<i64>() {
        if micros > 0 {
            record.ts = epoch_rfc3339(micros / 1_000_000);
        }
    }

    for (key, field) in [
        ("_SYSTEMD_UNIT", "unit"),
        ("SYSLOG_IDENTIFIER", "identifier"),
        ("_PID", "pid"),
        ("_TRANSPORT", "transport"),
    ] {
        let value = text(key);
        if !value.is_empty() {
            record.fields.insert(field.to_string(), value);
        }
    }
    record
}

/// Copes with journald exporting a non-UTF8 message as an array of byte
/// values rather than as a string.
fn decode_journal_message(raw: Option<&serde_json::Value>) -> String {
    match raw {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(items)) => {
            let octets: Vec<u8> = items.iter().filter_map(|v| v.as_u64()).map(|v| v as u8).collect();
            String::from_utf8_lossy(&octets).into_owned()
        }
        Some(other) => other.to_string(),
    }
}

pub fn journal_level(priority: &str) -> &'static str {
    match priority {
        "0" | "1" | "2" => "fatal",
        "3" => "error",
        "4" => "warn",
        "5" => "notice",
        "7" => "debug",
        _ => "info",
    }
}

/// Turns a requested level into journald's "this severity or worse"
/// selector, which is the filter an operator actually wants.
pub fn journal_priority(level: &str) -> Option<i32> {
    match level {
        "fatal" => Some(2),
        "error" => Some(3),
        "warn" => Some(4),
        "notice" => Some(5),
        "info" => Some(6),
        "debug" | "trace" => Some(7),
        _ => None,
    }
}

/* ------------------------------ file tails --------------------------- */

/// Returns the last `lines` of a file and, when following, streams what is
/// appended after that. A rotation — the path pointing at a different
/// inode, or the file having been truncated — reopens from the top instead
/// of silently tailing a deleted file forever.
pub async fn tail_file(
    ctx: &Ctx,
    path: &str,
    lines: i64,
    follow: bool,
    filter: &RecordFilter,
    stream: Option<StreamRef>,
) -> PResult<Vec<LogRecord>> {
    let lines = if lines <= 0 { 200 } else { lines as usize };

    let source = format!("file:{path}");
    let (tail, offset) = last_lines(path, lines)?;

    let backlog: Vec<LogRecord> = tail
        .into_iter()
        .map(|line| file_record(&source, line))
        .filter(|record| filter.matches(record))
        .collect();
    let (true, Some(stream)) = (follow, stream) else {
        return Ok(backlog);
    };

    let mut handle = tokio::fs::File::open(path)
        .await
        .map_err(|e| ProviderError::internal(format!("open {path}: {e}")))?;
    handle
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| ProviderError::internal(format!("seek {path}: {e}")))?;
    let mut known = handle
        .metadata()
        .await
        .map_err(|e| ProviderError::internal(format!("stat {path}: {e}")))?;

    let mut reader = BufReader::with_capacity(64 << 10, handle);
    let mut position = offset;
    let mut pending = String::new();

    loop {
        if ctx.is_cancelled() {
            return Ok(backlog);
        }

        let mut line = String::new();
        let read = match reader.read_line(&mut line).await {
            Ok(n) => n,
            Err(e) => return Err(ProviderError::internal(format!("read {path}: {e}"))),
        };
        position += read as u64;
        if read > 0 && line.ends_with('\n') {
            let full = format!("{pending}{}", line.trim_end_matches(['\r', '\n']));
            pending.clear();
            let record = file_record(&source, full);
            if filter.matches(&record) {
                send_record(stream.as_ref(), &record).await?;
            }
            continue;
        }
        // A partial line is held until its newline arrives, so a log
        // writer's non-atomic append is never split into two records.
        pending.push_str(&line);

        tokio::select! {
            _ = ctx.done() => return Ok(backlog),
            _ = tokio::time::sleep(TAIL_POLL_INTERVAL) => {}
        }

        if let Some((reopened, current)) = detect_rotation(path, &known, position).await {
            reader = BufReader::with_capacity(64 << 10, reopened);
            known = current;
            position = 0;
            pending.clear();
        }
    }
}

/// Reports whether the path now names a different file, or the same file
/// truncated, and hands back a handle positioned at its start.
async fn detect_rotation(
    path: &str,
    known: &std::fs::Metadata,
    position: u64,
) -> Option<(tokio::fs::File, std::fs::Metadata)> {
    let current = tokio::fs::metadata(path).await.ok()?;
    let truncated = current.len() < position;
    let same = current.dev() == known.dev() && current.ino() == known.ino();
    if same && !truncated {
        return None;
    }
    let reopened = tokio::fs::File::open(path).await.ok()?;
    Some((reopened, current))
}

/// Reads the tail of a file by walking backwards in blocks, so a
/// multi-gigabyte access log costs one seek rather than a full read.
pub fn last_lines(path: &str, count: usize) -> PResult<(Vec<String>, u64)> {
    use std::io::{Read, Seek};

    let mut handle = match std::fs::File::open(path) {
        Ok(h) => h,
        Err(e) if super::common::is_not_exist(&e) => return Err(not_found(format!("log file {path}"))),
        Err(e) => return Err(ProviderError::internal(format!("open {path}: {e}"))),
    };
    let size = handle
        .metadata()
        .map_err(|e| ProviderError::internal(format!("stat {path}: {e}")))?
        .len();
    if size == 0 {
        return Ok((Vec::new(), 0));
    }

    const BLOCK: u64 = 64 << 10;
    let mut collected: Vec<u8> = Vec::new();
    let mut offset = size;
    let mut newlines = 0usize;
    let limit = (MAX_LOG_LINE as u64) * (count as u64 + 1);

    while offset > 0 && newlines <= count && (collected.len() as u64) < limit {
        let chunk = BLOCK.min(offset);
        offset -= chunk;
        let mut buffer = vec![0u8; chunk as usize];
        handle
            .seek(SeekFrom::Start(offset))
            .map_err(|e| ProviderError::internal(format!("read {path}: {e}")))?;
        let mut filled = 0;
        while filled < buffer.len() {
            match handle.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(ProviderError::internal(format!("read {path}: {e}"))),
            }
        }
        buffer.truncate(filled);
        buffer.extend_from_slice(&collected);
        collected = buffer;
        newlines = collected.iter().filter(|b| **b == b'\n').count();
    }

    let text = String::from_utf8_lossy(&collected).replace("\r\n", "\n");
    let mut all: Vec<String> = split_lines(&text).into_iter().map(str::to_string).collect();
    if offset > 0 && !all.is_empty() {
        // The first line of the window is probably a fragment.
        all.remove(0);
    }
    if all.len() > count {
        all = all.split_off(all.len() - count);
    }
    Ok((all, size))
}

fn file_record(source: &str, line: String) -> LogRecord {
    LogRecord {
        ts: now_rfc3339(),
        level: guess_level(&line).to_string(),
        source: source.to_string(),
        message: line,
        fields: BTreeMap::new(),
        cursor: None,
    }
}

/// Reads a severity out of an unstructured line. It is a hint for the log
/// viewer's filter, never a claim about the writer's intent.
pub fn guess_level(line: &str) -> &'static str {
    let lowered = line.to_lowercase();
    if lowered.contains("emerg") || lowered.contains("fatal") || lowered.contains("panic") {
        "fatal"
    } else if lowered.contains("error") || lowered.contains("[crit") || lowered.contains(" err ") {
        "error"
    } else if lowered.contains("warn") {
        "warn"
    } else if lowered.contains("notice") {
        "notice"
    } else if lowered.contains("debug") {
        "debug"
    } else {
        "info"
    }
}

/* ------------------------------- filtering --------------------------- */

/// The server-side half of the log viewer's controls: filtering here is
/// what keeps a chatty host from saturating the socket.
#[derive(Clone, Debug, Default)]
pub struct RecordFilter {
    pub level: String,
    pub query: String,
}

impl RecordFilter {
    pub fn validate(&self) -> PResult<()> {
        if self.level.is_empty() {
            return Ok(());
        }
        match self.level.as_str() {
            "trace" | "debug" | "info" | "notice" | "warn" | "error" | "fatal" => Ok(()),
            other => Err(invalid(format!("level {other:?} is not a log level"))),
        }
    }

    pub fn matches(&self, record: &LogRecord) -> bool {
        if !self.level.is_empty() && severity(&record.level) > severity(&self.level) {
            return false;
        }
        if !self.query.is_empty() && !record.message.to_lowercase().contains(&self.query.to_lowercase()) {
            return false;
        }
        true
    }
}

/// Orders the contract's levels so "warn and worse" is a comparison rather
/// than a set membership test.
fn severity(level: &str) -> i32 {
    match level {
        "fatal" => 0,
        "error" => 1,
        "warn" => 2,
        "notice" => 3,
        "info" => 4,
        "debug" => 5,
        _ => 6,
    }
}

/* -------------------------------- shared ----------------------------- */

/// Puts one record on the wire as a newline-delimited JSON object, which
/// is the framing every log stream in this agent uses.
pub async fn send_record(stream: &dyn Stream, record: &LogRecord) -> PResult<()> {
    let mut encoded = serde_json::to_vec(record)?;
    encoded.push(b'\n');
    stream.send(&encoded, Encoding::Utf8).await
}

/// `(kind, ref)` of a log source id.
pub fn parse_log_source(source: &str) -> PResult<(&'static str, String)> {
    if source.is_empty() {
        return Err(invalid("source is required"));
    }
    if source.starts_with('/') {
        return Ok(("file", validate_path(source)?));
    }

    let Some((kind, r#ref)) = source.split_once(':') else {
        if source == "journald" {
            return Ok(("journald", String::new()));
        }
        return Err(invalid(format!(
            "source {source:?} must be journald, journald:<unit>, file:<path> or container:<id>"
        )));
    };

    match kind {
        "journald" => {
            if !r#ref.is_empty() {
                check_unit_pattern(r#ref)?;
            }
            Ok(("journald", r#ref.to_string()))
        }
        "file" => Ok(("file", validate_path(r#ref)?)),
        "container" => {
            if r#ref.is_empty() {
                return Err(invalid("container source needs an id"));
            }
            Ok(("container", r#ref.to_string()))
        }
        other => Err(invalid(format!("unknown log source kind {other:?}"))),
    }
}

/// Accepts an absolute RFC3339 stamp, epoch seconds, or a relative window
/// like "-2h", because all three shapes reach the agent from different UI
/// controls.
pub fn parse_since(value: &str) -> PResult<chrono::DateTime<chrono::Utc>> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&chrono::Utc));
    }
    if let Ok(seconds) = value.parse::<i64>() {
        if seconds > 0 {
            if let Some(t) = chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0) {
                return Ok(t);
            }
        }
    }

    let window = value.strip_prefix('-').unwrap_or(value);
    let elapsed = humantime::parse_duration(window)
        .map_err(|_| invalid("since must be an RFC3339 timestamp or a duration like 2h"))?;
    let elapsed = chrono::Duration::from_std(elapsed)
        .map_err(|_| invalid("since must be an RFC3339 timestamp or a duration like 2h"))?;
    Ok(chrono::Utc::now() - elapsed)
}

/// Renders a timestamp in the only form journalctl parses unambiguously
/// across versions.
pub fn journal_since(value: &str) -> PResult<String> {
    let parsed = parse_since(value)?;
    Ok(parsed
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_records_carry_time_level_and_fields() {
        let line = r#"{"__CURSOR":"s=abc;i=1","__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"3","MESSAGE":"upstream timed out","_SYSTEMD_UNIT":"nginx.service","SYSLOG_IDENTIFIER":"nginx","_PID":"1234","_TRANSPORT":"stdout","_HOSTNAME":"web1"}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let record = journal_record(&parsed, "journald:nginx");
        assert_eq!(record.ts, "2023-11-14T22:13:20Z");
        assert_eq!(record.level, "error");
        assert_eq!(record.source, "journald:nginx");
        assert_eq!(record.message, "upstream timed out");
        assert_eq!(record.cursor.as_deref(), Some("s=abc;i=1"));
        assert_eq!(record.fields["unit"], "nginx.service");
        assert_eq!(record.fields["identifier"], "nginx");
        assert_eq!(record.fields["pid"], "1234");
        assert_eq!(record.fields["transport"], "stdout");
        assert!(!record.fields.contains_key("hostname"));
    }

    #[test]
    fn journal_messages_may_arrive_as_byte_arrays() {
        let parsed: serde_json::Value = serde_json::from_str(r#"{"MESSAGE":[104,105]}"#).unwrap();
        assert_eq!(journal_record(&parsed, "journald").message, "hi");
        let parsed: serde_json::Value = serde_json::from_str(r#"{"MESSAGE":null}"#).unwrap();
        assert_eq!(journal_record(&parsed, "journald").message, "");
    }

    #[test]
    fn journal_priorities_map_both_ways() {
        assert_eq!(journal_level("0"), "fatal");
        assert_eq!(journal_level("2"), "fatal");
        assert_eq!(journal_level("4"), "warn");
        assert_eq!(journal_level("6"), "info");
        assert_eq!(journal_level(""), "info");
        assert_eq!(journal_priority("warn"), Some(4));
        assert_eq!(journal_priority("trace"), Some(7));
        assert_eq!(journal_priority(""), None);
    }

    #[test]
    fn levels_are_guessed_from_the_text() {
        assert_eq!(guess_level("kernel: panic - not syncing"), "fatal");
        assert_eq!(
            guess_level("2024/01/01 [crit] 1#1: *2 SSL_do_handshake()"),
            "error"
        );
        assert_eq!(guess_level("[warn] something"), "warn");
        assert_eq!(guess_level("sshd: Accepted publickey"), "info");
        assert_eq!(guess_level("DEBUG trace"), "debug");
    }

    #[test]
    fn filters_compare_severity_and_search_the_message() {
        let filter = RecordFilter {
            level: "warn".into(),
            query: "disk".into(),
        };
        let record = |level: &str, message: &str| LogRecord {
            level: level.into(),
            message: message.into(),
            ..Default::default()
        };
        assert!(filter.matches(&record("error", "Disk full")));
        assert!(!filter.matches(&record("info", "disk ok")));
        assert!(!filter.matches(&record("error", "network down")));
        assert!(RecordFilter::default().validate().is_ok());
        assert!(
            RecordFilter {
                level: "loud".into(),
                query: String::new()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn log_sources_parse_into_kind_and_ref() {
        assert_eq!(parse_log_source("journald").unwrap(), ("journald", String::new()));
        assert_eq!(
            parse_log_source("journald:nginx").unwrap(),
            ("journald", "nginx".into())
        );
        assert_eq!(
            parse_log_source("container:abc").unwrap(),
            ("container", "abc".into())
        );
        assert_eq!(
            parse_log_source("file:/var/log/syslog").unwrap(),
            ("file", "/var/log/syslog".into())
        );
        assert_eq!(
            parse_log_source("/var/log/syslog").unwrap(),
            ("file", "/var/log/syslog".into())
        );
        assert!(parse_log_source("").is_err());
        assert!(parse_log_source("bogus").is_err());
        assert!(parse_log_source("journald:--all").is_err());
        assert!(parse_log_source("container:").is_err());
        assert!(parse_log_source("file:../etc").is_err());
    }

    #[test]
    fn since_accepts_stamps_seconds_and_windows() {
        assert_eq!(
            parse_since("2024-01-02T03:04:05Z").unwrap().timestamp(),
            1704164645
        );
        assert_eq!(parse_since("1704164645").unwrap().timestamp(), 1704164645);
        let now = chrono::Utc::now();
        let two_hours = parse_since("-2h").unwrap();
        let delta = (now - two_hours).num_seconds();
        assert!((7199..=7201).contains(&delta), "{delta}");
        assert!(parse_since("yesterday-ish").is_err());
        assert_eq!(journal_since("2024-01-02T03:04:05Z").unwrap().len(), 19);
    }

    #[test]
    fn last_lines_walks_backwards_and_drops_fragments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let mut content = String::new();
        for i in 0..5000 {
            content.push_str(&format!(
                "line {i} with some padding to cross a block boundary\r\n"
            ));
        }
        std::fs::write(&path, &content).unwrap();
        let (lines, offset) = last_lines(path.to_str().unwrap(), 3).unwrap();
        assert_eq!(offset, content.len() as u64);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2], "line 4999 with some padding to cross a block boundary");
        assert_eq!(lines[0], "line 4997 with some padding to cross a block boundary");

        std::fs::write(&path, "").unwrap();
        assert_eq!(last_lines(path.to_str().unwrap(), 3).unwrap(), (Vec::new(), 0));
        assert!(matches!(
            last_lines(dir.path().join("missing").to_str().unwrap(), 3),
            Err(ProviderError::NotFound(_))
        ));
    }

    struct Capture(Mutex<Vec<String>>);

    #[async_trait]
    impl Stream for Capture {
        async fn send(&self, data: &[u8], _enc: Encoding) -> PResult<()> {
            self.0.lock().push(String::from_utf8_lossy(data).into_owned());
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn journal_sink_splits_backlog_from_live_lines() {
        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let sink = JournalSink {
            inner: Some(capture.clone()),
            source: "journald".into(),
            lines: 1,
            filter: RecordFilter::default(),
            backlog: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            cancel: Ctx::background(),
        };
        sink.send(br#"{"MESSAGE":"first","PRIORITY":"6"}"#, Encoding::Utf8)
            .await
            .unwrap();
        sink.send(b"not json\n", Encoding::Utf8).await.unwrap();
        sink.send(br#"{"MESSAGE":"second","PRIORITY":"4"}"#, Encoding::Utf8)
            .await
            .unwrap();
        assert_eq!(sink.backlog.lock().len(), 1);
        assert_eq!(sink.backlog.lock()[0].message, "first");
        let sent = capture.0.lock();
        assert_eq!(sent.len(), 1);
        let record: LogRecord = serde_json::from_str(sent[0].trim()).unwrap();
        assert_eq!(record.message, "second");
        assert_eq!(record.level, "warn");
    }

    #[tokio::test]
    async fn tail_file_streams_appended_lines_and_follows_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rot.log");
        std::fs::write(&path, "old line 1\nold line 2\n").unwrap();
        let path_str = path.to_str().unwrap().to_string();

        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let ctx = Ctx::background();
        let stop = ctx.clone();
        let stream: StreamRef = capture.clone();
        let filter = RecordFilter::default();
        let tail = tokio::spawn({
            let path_str = path_str.clone();
            async move { tail_file(&ctx, &path_str, 10, true, &filter, Some(stream)).await }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"appended\n").unwrap();
        }
        tokio::time::sleep(Duration::from_millis(700)).await;

        // Rotate: a different inode behind the same path.
        std::fs::rename(&path, dir.path().join("rot.log.1")).unwrap();
        std::fs::write(&path, "after rotation\n").unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;

        stop.cancel();
        let backlog = tail.await.unwrap().unwrap();
        assert_eq!(backlog.len(), 2);
        let sent: Vec<String> = capture
            .0
            .lock()
            .iter()
            .map(|s| serde_json::from_str::<LogRecord>(s.trim()).unwrap().message)
            .collect();
        assert_eq!(sent, vec!["appended", "after rotation"]);
    }
}
