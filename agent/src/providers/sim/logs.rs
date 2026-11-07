//! Logs.
//!
//! Lines are a pure function of (source, index): line n happens at a time
//! derived from the source's rate plus a deterministic jitter, and its
//! contents come from the same seed. That gives three properties at once —
//! history reaches arbitrarily far back without a ring buffer, a
//! follow-tail produces a few lines a second in real time, and two runs on
//! the same host produce the same log.
//!
//! The wire format is newline-delimited JSON records, which is what the
//! control plane's decoder expects; a chunk boundary mid-record is safe
//! because it reassembles on newlines.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::containers::find_container;
use super::firewall::THREAT_SOURCES;
use super::state::{Sim, hash_string, lattice, mix, parse_stamp, pick, stamp};
use crate::providers::{
    Ctx, Encoding, LogRecord, LogSource, LogTailParams, Logs, PResult, ProviderError, Stream, StreamRef,
};

pub const SOURCE_JOURNAL: &str = "journal";
pub const SOURCE_SYSLOG: &str = "syslog";
pub const SOURCE_AUTH: &str = "auth";
pub const SOURCE_NGINX_ACCESS: &str = "nginx-access";
pub const SOURCE_NGINX_ERROR: &str = "nginx-error";
pub const SOURCE_MAIL: &str = "mail";
pub const SOURCE_CONTAINER: &str = "container";

#[derive(Clone, Debug)]
pub enum Renderer {
    Journal(String),
    Syslog,
    Auth,
    NginxAccess,
    NginxError,
    Mail,
    Container { name: String, image: String },
}

/// One generator: a rate and a renderer.
#[derive(Clone, Debug)]
pub struct LogStream {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub r#ref: String,
    pub size: i64,
    pub rate: f64,
    pub render: Renderer,
}

impl LogStream {
    /// Places line n on the clock. The jitter stays inside the interval so
    /// the sequence is still strictly increasing.
    pub fn at(&self, origin: DateTime<Utc>, n: i64) -> DateTime<Utc> {
        let seed = hash_string(&self.id);
        let step = n as f64 / self.rate;
        let jitter = 0.4 * lattice(seed, n) / self.rate;
        origin + chrono::Duration::milliseconds(((step + jitter) * 1000.0) as i64)
    }

    pub fn index_at(&self, origin: DateTime<Utc>, t: DateTime<Utc>) -> i64 {
        let secs = (t - origin).num_milliseconds() as f64 / 1000.0;
        ((secs * self.rate) as i64).max(0)
    }

    pub fn render(&self, sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
        match &self.render {
            Renderer::Journal(unit) => render_journal(sim, unit, n, at),
            Renderer::Syslog => render_syslog(sim, n, at),
            Renderer::Auth => render_auth(sim, n, at),
            Renderer::NginxAccess => render_nginx_access(sim, n, at),
            Renderer::NginxError => render_nginx_error(sim, n, at),
            Renderer::Mail => render_mail(sim, n, at),
            Renderer::Container { name, image } => render_container(sim, name, image, n, at),
        }
    }
}

/* ------------------------------ catalogue ---------------------------- */

fn stream(
    id: &str,
    label: &str,
    kind: &str,
    r#ref: &str,
    size: i64,
    rate: f64,
    render: Renderer,
) -> LogStream {
    LogStream {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        r#ref: r#ref.into(),
        size,
        rate,
        render,
    }
}

pub fn log_streams(sim: &Sim) -> Vec<LogStream> {
    let mut streams = vec![
        stream(
            SOURCE_JOURNAL,
            "systemd journal",
            "journald",
            "*",
            117_440_512,
            1.6,
            Renderer::Journal(String::new()),
        ),
        stream(
            SOURCE_SYSLOG,
            "/var/log/syslog",
            "file",
            "/var/log/syslog",
            18_432_112,
            0.9,
            Renderer::Syslog,
        ),
        stream(
            SOURCE_AUTH,
            "/var/log/auth.log",
            "file",
            "/var/log/auth.log",
            2_884_213,
            0.35,
            Renderer::Auth,
        ),
        stream(
            SOURCE_NGINX_ACCESS,
            "nginx access",
            "nginx_access",
            "/var/log/nginx/access.log",
            214_884_112,
            3.4,
            Renderer::NginxAccess,
        ),
        stream(
            SOURCE_NGINX_ERROR,
            "nginx error",
            "nginx_error",
            "/var/log/nginx/error.log",
            4_118_223,
            0.14,
            Renderer::NginxError,
        ),
        stream(
            SOURCE_MAIL,
            "Yunori Mail (Stalwart)",
            "journald",
            "stalwart-mail.service",
            9_442_881,
            1.0,
            Renderer::Mail,
        ),
    ];

    let w = sim.world.lock();
    for c in &w.containers {
        if c.info.state != "running" {
            continue;
        }
        streams.push(container_stream(&c.info.name, &c.info.image));
    }
    streams
}

fn container_stream(name: &str, image: &str) -> LogStream {
    LogStream {
        id: format!("{SOURCE_CONTAINER}:{name}"),
        label: format!("container {name}"),
        kind: "container".into(),
        r#ref: name.into(),
        size: 12_884_901,
        rate: 0.45,
        render: Renderer::Container {
            name: name.into(),
            image: image.into(),
        },
    }
}

/// Resolves a source id. `journal:<unit>` narrows the journal to one unit,
/// which is what service.logs needs.
pub fn stream_for(sim: &Sim, id: &str) -> PResult<LogStream> {
    if let Some(unit) = id.strip_prefix(&format!("{SOURCE_JOURNAL}:")) {
        return Ok(LogStream {
            id: id.into(),
            label: format!("journal {unit}"),
            kind: "journald".into(),
            r#ref: unit.into(),
            size: 12_582_912,
            rate: 0.5,
            render: Renderer::Journal(unit.into()),
        });
    }
    if let Some(name) = id.strip_prefix(&format!("{SOURCE_CONTAINER}:")) {
        let w = sim.world.lock();
        let Some(idx) = find_container(&w, name) else {
            return Err(ProviderError::not_found(format!("log source {id}")));
        };
        let c = &w.containers[idx];
        return Ok(container_stream(&c.info.name, &c.info.image));
    }
    log_streams(sim)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| ProviderError::not_found(format!("log source {id}")))
}

/// Lets `cat` and `tail` in the fake shell reach the generated streams, so
/// /var/log/nginx/access.log is not a dead blob in the terminal.
pub fn stream_for_path(sim: &Sim, p: &str) -> Option<LogStream> {
    let id = match p {
        "/var/log/nginx/access.log" => SOURCE_NGINX_ACCESS,
        "/var/log/nginx/error.log" => SOURCE_NGINX_ERROR,
        "/var/log/syslog" => SOURCE_SYSLOG,
        "/var/log/auth.log" => SOURCE_AUTH,
        _ => return None,
    };
    stream_for(sim, id).ok()
}

/* ------------------------------- tailing ----------------------------- */

#[derive(Clone, Debug, Default)]
pub struct TailRequest {
    pub source: String,
    pub unit: String,
    pub container: String,
    pub lines: i64,
    pub follow: bool,
    pub level: Option<String>,
    pub query: Option<String>,
    pub since: Option<String>,
}

/// Returns the backlog for a settled read, and streams backlog then live
/// lines for a follow. It never does both: the control plane prefers
/// streamed records over the settled result, so sending each line once
/// keeps the two paths from disagreeing.
pub async fn tail(sim: &Sim, ctx: &Ctx, stream: &dyn Stream, req: TailRequest) -> PResult<Vec<LogRecord>> {
    let id = if !req.unit.is_empty() {
        format!("{SOURCE_JOURNAL}:{}", req.unit)
    } else if !req.container.is_empty() {
        format!("{SOURCE_CONTAINER}:{}", req.container)
    } else {
        req.source.clone()
    };

    let generator = stream_for(sim, &id)?;
    let lines = if req.lines <= 0 { 200 } else { req.lines };
    let origin = sim.boot_time();
    let now = Utc::now();
    let last = generator.index_at(origin, now);

    let mut first = last - lines;
    if let Some(since) = req
        .since
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(parse_stamp)
    {
        let from = generator.index_at(origin, since);
        if from > first {
            first = from;
        }
    }
    let first = first.max(0);

    let level = req.level.as_deref().unwrap_or_default();
    let query = req.query.as_deref().unwrap_or_default();

    let mut backlog = Vec::with_capacity(lines as usize);
    for n in first..=last {
        let record = generator.render(sim, n, generator.at(origin, n));
        if matches_filter(&record, level, query) {
            backlog.push(record);
        }
    }

    if !req.follow {
        return Ok(backlog);
    }

    for record in &backlog {
        send_record(stream, record).await?;
    }

    let mut n = last + 1;
    loop {
        let at = generator.at(origin, n);
        let wait = at - Utc::now();
        if wait > chrono::Duration::zero() {
            let wait = wait.to_std().unwrap_or_default();
            ctx.run(tokio::time::sleep(wait)).await?;
        }
        ctx.check()?;
        let record = generator.render(sim, n, at);
        if matches_filter(&record, level, query) {
            send_record(stream, &record).await?;
        }
        n += 1;
    }
}

pub async fn send_record(stream: &dyn Stream, record: &LogRecord) -> PResult<()> {
    let mut payload = serde_json::to_vec(record)?;
    payload.push(b'\n');
    stream.send(&payload, Encoding::Utf8).await
}

fn matches_filter(record: &LogRecord, level: &str, query: &str) -> bool {
    if !level.is_empty() && record.level != level {
        return false;
    }
    if !query.is_empty() && !record.message.to_lowercase().contains(&query.to_lowercase()) {
        return false;
    }
    true
}

/* -------------------------------- logs ------------------------------- */

pub struct SimLogs(pub Arc<Sim>);

#[async_trait]
impl Logs for SimLogs {
    async fn sources(&self, _ctx: &Ctx) -> PResult<Vec<LogSource>> {
        Ok(log_streams(&self.0)
            .into_iter()
            .map(|s| LogSource {
                id: s.id,
                label: s.label,
                kind: s.kind,
                r#ref: s.r#ref,
                size: Some(s.size),
                supports_follow: true,
            })
            .collect())
    }

    async fn tail(&self, ctx: &Ctx, p: LogTailParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        tail(
            &self.0,
            ctx,
            &*s,
            TailRequest {
                source: p.source,
                lines: p.lines,
                follow: p.follow,
                level: p.level,
                query: p.query,
                since: p.since,
                ..Default::default()
            },
        )
        .await
    }
}

/* ----------------------------- renderers ----------------------------- */

fn fields(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// Weights the distribution the way a healthy host reads: mostly
/// information, a steady trickle of warnings, the occasional error.
fn pick_level(seed: u64, n: i64) -> &'static str {
    let roll = (lattice(seed, n) + 1.0) / 2.0;
    if roll < 0.005 {
        "debug"
    } else if roll < 0.83 {
        "info"
    } else if roll < 0.90 {
        "notice"
    } else if roll < 0.972 {
        "warn"
    } else {
        "error"
    }
}

const JOURNAL_UNITS: &[&str] = &[
    "nginx",
    "postgresql@16-main",
    "dockerd",
    "containerd",
    "stalwart-mail",
    "yunori-mail",
    "sshd",
    "CRON",
    "systemd",
    "fail2ban.actions",
    "kanamed",
    "systemd-timesyncd",
];

fn render_journal(sim: &Sim, unit: &str, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(&format!("journal|{unit}"));
    let name = if unit.is_empty() {
        pick(seed, n, JOURNAL_UNITS).to_string()
    } else {
        unit.to_string()
    };
    let name = name.trim_end_matches(".service").to_string();

    let (level, message) = journal_message(sim, seed, &name, n);
    let pid = 300 + (mix(seed ^ n as u64 ^ 0x1a) % 28000) as i64;

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_JOURNAL.into(),
        message: format!("{} {}[{}]: {}", sim.short_host(), name, pid, message),
        fields: fields(&[
            ("_SYSTEMD_UNIT", format!("{name}.service")),
            ("_PID", pid.to_string()),
            ("_HOSTNAME", sim.id.hostname.clone()),
        ]),
        cursor: Some(format!("journal:{n}")),
    }
}

fn journal_message(sim: &Sim, seed: u64, unit: &str, n: i64) -> (&'static str, String) {
    let level = pick_level(seed ^ 0x9, n);
    let mail_domain = &sim.id.mail_domain;

    match unit {
        "nginx" => {
            if level == "error" {
                return (
                    "error",
                    format!(
                        "upstream timed out (110: Connection timed out) while reading response header from upstream, client: {}",
                        pick(seed, n, THREAT_SOURCES)
                    ),
                );
            }
            (
                level,
                pick(
                    seed,
                    n,
                    &[
                        "signal process started".to_string(),
                        "reopening logs".to_string(),
                        format!("worker process {} exited with code 0", 1200 + n % 40),
                        "gracefully shutting down worker".to_string(),
                    ],
                ),
            )
        }
        "postgresql@16-main" => {
            if level == "warn" {
                return (
                    "warn",
                    format!(
                        "checkpoints are occurring too frequently ({} seconds apart)",
                        18 + n % 12
                    ),
                );
            }
            (
                level,
                pick(
                    seed,
                    n,
                    &[
                        "checkpoint starting: time".to_string(),
                        format!("checkpoint complete: wrote {} buffers (2.1%)", 400 + n % 900),
                        "automatic vacuum of table \"kaname.public.jobs\": index scans: 1".to_string(),
                        "received SIGHUP, reloading configuration files".to_string(),
                    ],
                ),
            )
        }
        "dockerd" | "containerd" => (
            level,
            pick(
                seed,
                n,
                &[
                    "loading containers: start.".to_string(),
                    format!("shim disconnected id={:016x}", mix(seed ^ n as u64)),
                    "API listen on /run/docker.sock".to_string(),
                    "cleaning up dead shim".to_string(),
                ],
            ),
        ),
        "stalwart-mail" => (
            level,
            pick(
                seed,
                n,
                &[
                    format!(
                        "INFO SMTP connection started (smtp.connection-start) remoteIp = {}, remotePort = {}",
                        pick(seed, n, THREAT_SOURCES),
                        40000 + n % 20000
                    ),
                    format!(
                        "INFO Message delivered (delivery.completed) host = mx1.example.net, to = \"anna@example.net\", elapsed = {}ms",
                        180 + n % 900
                    ),
                    format!(
                        "WARN Authentication failed (auth.failed) accountName = \"ops@{mail_domain}\", remoteIp = {}",
                        pick(seed ^ 0x7, n, THREAT_SOURCES)
                    ),
                    "INFO Housekeeper task completed (housekeeper.run) task = \"purge-blobs\"".to_string(),
                ],
            ),
        ),
        "yunori-mail" => (
            level,
            pick(
                seed,
                n,
                &[
                    "console: session opened for admin".to_string(),
                    format!("doctor: reverse DNS still points away from mail.{mail_domain}"),
                    "tls: certificate check passed, next renewal in 30 days".to_string(),
                    "edge: HTTPS listener healthy on :443".to_string(),
                ],
            ),
        ),
        "sshd" => {
            if level == "warn" || level == "error" {
                return (
                    "warn",
                    format!(
                        "Failed password for invalid user {} from {} port {} ssh2",
                        pick(seed, n, &["admin", "test", "ubuntu", "oracle", "postgres"]),
                        pick(seed, n, THREAT_SOURCES),
                        40000 + n % 20000
                    ),
                );
            }
            (
                "info",
                format!(
                    "Accepted publickey for deploy from {} port {} ssh2: ED25519 SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5o",
                    sim.id.private_ip,
                    50000 + n % 12000
                ),
            )
        }
        "CRON" => (
            "info",
            format!(
                "({}) CMD ({})",
                pick(seed, n, &["root", "deploy"]),
                pick(
                    seed,
                    n,
                    &[
                        "cd / && run-parts --report /etc/cron.hourly",
                        "/usr/local/bin/kaname-nightly.sh >/dev/null 2>&1",
                        "test -x /usr/sbin/anacron || run-parts --report /etc/cron.daily",
                    ],
                )
            ),
        ),
        "fail2ban.actions" => ("notice", format!("[sshd] Ban {}", pick(seed, n, THREAT_SOURCES))),
        "kanamed" => (
            level,
            pick(
                seed,
                n,
                &[
                    "metrics sample pushed",
                    "connected url=wss://panel.kaname.internal/agent/v1/connect",
                    "reconcile complete units=34 containers=6",
                ],
            )
            .to_string(),
        ),
        "systemd-timesyncd" => (
            "info",
            "Contacted time server 185.125.190.56:123 (ntp.ubuntu.com).".into(),
        ),
        _ => (
            level,
            pick(
                seed,
                n,
                &[
                    "Starting Daily apt download activities...".to_string(),
                    "Finished Daily apt download activities.".to_string(),
                    format!("Started Session {} of User deploy.", 400 + n % 80),
                    "Reloading.".to_string(),
                ],
            ),
        ),
    }
}

const ACCESS_PATHS: &[&str] = &[
    "/",
    "/index.html",
    "/assets/app.css",
    "/assets/app.js",
    "/favicon.ico",
    "/api/v1/status",
    "/api/v1/servers",
    "/api/v1/jobs?page=1",
    "/robots.txt",
    "/blog/2026/08/shipping-kaname",
    "/pricing",
    "/docs/getting-started",
    "/wp-login.php",
    "/.env",
    "/admin/config.php",
    "/api/v1/metrics?range=24h",
];

const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "curl/8.5.0",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "python-requests/2.32.3",
    "Go-http-client/2.0",
];

const VISITOR_IPS: &[&str] = &[
    "81.2.69.142",
    "24.48.0.1",
    "203.0.113.24",
    "198.51.100.77",
    "192.0.2.211",
    "91.198.174.192",
    "8.8.8.8",
    "45.33.32.156",
    "104.28.14.10",
    "34.107.221.82",
];

fn render_nginx_access(sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(SOURCE_NGINX_ACCESS);
    let path = pick(seed, n, ACCESS_PATHS);
    let method = pick(seed ^ 0x5, n, &["GET", "GET", "GET", "GET", "POST", "HEAD"]);

    let (mut status, mut level) = (200, "info");
    if path.starts_with("/wp-login") || path == "/.env" || path.starts_with("/admin") {
        status = 404;
        level = "warn";
    } else if mix(seed ^ n as u64 ^ 0x77) % 50 == 0 {
        status = 502;
        level = "error";
    } else if mix(seed ^ n as u64 ^ 0x31) % 17 == 0 {
        status = 304;
    } else if method == "POST" && mix(seed ^ n as u64) % 9 == 0 {
        status = 401;
        level = "warn";
    }

    let client = pick(seed ^ 0xa, n, VISITOR_IPS);
    let bytes = 180 + mix(seed ^ n as u64 ^ 0x44) % 48_000;
    let referer = if mix(seed ^ n as u64 ^ 0x55) % 3 == 0 {
        format!("https://{}/", sim.id.domain)
    } else {
        "-".into()
    };

    let message = format!(
        "{client} - - [{}] \"{method} {path} HTTP/1.1\" {status} {bytes} \"{referer}\" \"{}\"",
        at.format("%d/%b/%Y:%H:%M:%S +0000"),
        pick(seed ^ 0xb, n, USER_AGENTS)
    );

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_NGINX_ACCESS.into(),
        message,
        fields: fields(&[
            ("status", status.to_string()),
            ("method", method.to_string()),
            ("path", path.to_string()),
            ("remote_addr", client.to_string()),
        ]),
        cursor: Some(format!("{SOURCE_NGINX_ACCESS}:{n}")),
    }
}

fn render_nginx_error(sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(SOURCE_NGINX_ERROR);
    let client = pick(seed, n, THREAT_SOURCES);
    let pid = 1040 + (mix(seed ^ n as u64) % 4) as i64;
    let domain = &sim.id.domain;
    let probe = pick(
        seed ^ 0x2,
        n,
        &["/wp-login.php", "/.env", "/phpmyadmin/index.php"],
    );

    let variants = [
        format!(
            "*{} open() \"/var/www/{domain}/public{probe}\" failed (2: No such file or directory), client: {client}, server: {domain}, request: \"GET {probe} HTTP/1.1\", host: \"{domain}\"",
            30000 + n
        ),
        format!(
            "*{} upstream timed out (110: Connection timed out) while reading response header from upstream, client: {client}, server: api.{domain}, request: \"GET /api/v1/servers HTTP/1.1\", upstream: \"http://127.0.0.1:3000/api/v1/servers\"",
            30000 + n
        ),
        format!(
            "*{} client intended to send too large body: {} bytes, client: {client}, server: {domain}",
            30000 + n,
            12_582_912 + n * 17
        ),
    ];

    let level = if mix(seed ^ n as u64 ^ 0x91) % 3 == 0 {
        "warn"
    } else {
        "error"
    };

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_NGINX_ERROR.into(),
        message: format!(
            "{} [{level}] {pid}#{pid}: {}",
            at.format("%Y/%m/%d %H:%M:%S"),
            pick(seed ^ 0x3, n, &variants)
        ),
        fields: fields(&[("client", client.to_string())]),
        cursor: Some(format!("{SOURCE_NGINX_ERROR}:{n}")),
    }
}

/// Stalwart's journal, as Yunori ships it: one event per line in the
/// `LEVEL Description (event.id) key = value, ...` shape, so the panel's
/// mail log page reads like the real `journalctl -u stalwart-mail`.
pub fn render_mail(sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(SOURCE_MAIL);
    let domain = &sim.id.mail_domain;
    let queue_id = 1_000_000 + (mix(seed ^ n as u64) % 9_000_000) as i64;
    let local = pick(seed, n, &["hello", "ops", "alice", "billing", "noreply"]);
    let remote_user = pick(seed ^ 0x3, n, &["anna", "sam", "billing", "hello", "noreply"]);
    let remote_domain = pick(
        seed ^ 0x4,
        n,
        &["example.net", "example.org", "mail.example.co", "contoso.example"],
    );
    let remote_ip = pick(seed ^ 0x5, n, THREAT_SOURCES);
    let pid = 1_180 + (n % 3);

    let (level, event, body) = match mix(seed ^ n as u64 ^ 0x66) % 20 {
        0 | 1 => (
            "warn",
            "delivery.connect-error",
            format!(
                "Connection error (delivery.connect-error) queueId = {queue_id}, host = \"mx1.{remote_domain}\", to = \"{remote_user}@{remote_domain}\", reason = \"Connection timed out\", nextRetry = \"{}m\"",
                15 + n % 45
            ),
        ),
        2 => (
            "error",
            "delivery.failed",
            format!(
                "Delivery failed (delivery.failed) queueId = {queue_id}, host = \"mx2.{remote_domain}\", to = \"{remote_user}@{remote_domain}\", code = 550, response = \"5.1.1 <{remote_user}@{remote_domain}>: Recipient address rejected: User unknown\""
            ),
        ),
        3 | 4 => (
            "info",
            "smtp.connection-start",
            format!(
                "SMTP connection started (smtp.connection-start) listenerId = \"smtp\", remoteIp = {remote_ip}, remotePort = {}",
                40000 + n % 20000
            ),
        ),
        5 => (
            "warn",
            "auth.failed",
            format!(
                "Authentication failed (auth.failed) listenerId = \"imaptls\", accountName = \"{local}@{domain}\", remoteIp = {remote_ip}"
            ),
        ),
        6 => (
            "info",
            "dkim.pass",
            format!(
                "DKIM verification passed (dkim.pass) queueId = {queue_id}, domain = \"{remote_domain}\", selector = \"s1\""
            ),
        ),
        7 => (
            "notice",
            "spam.listed",
            format!(
                "IP listed in DNSBL (spam.listed) remoteIp = {remote_ip}, list = \"zen.spamhaus.org\", result = \"127.0.0.4\""
            ),
        ),
        8 | 9 => (
            "info",
            "queue.queue-message",
            format!(
                "Message queued (queue.queue-message) queueId = {queue_id}, from = \"{local}@{domain}\", to = [\"{remote_user}@{remote_domain}\"], size = {}",
                2_048 + mix(seed ^ n as u64 ^ 0x12) % 400_000
            ),
        ),
        10 => (
            "info",
            "imap.login",
            format!(
                "IMAP login (imap.login) listenerId = \"imaptls\", accountName = \"{local}@{domain}\", remoteIp = {}",
                sim.id.private_ip
            ),
        ),
        _ => (
            "info",
            "delivery.completed",
            format!(
                "Message delivered (delivery.completed) queueId = {queue_id}, host = \"mx1.{remote_domain}\", to = \"{remote_user}@{remote_domain}\", code = 250, elapsed = {}ms",
                120 + mix(seed ^ n as u64 ^ 0x13) % 2_400
            ),
        ),
    };

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_MAIL.into(),
        message: format!(
            "{} stalwart-mail[{pid}]: {} {body}",
            sim.short_host(),
            level.to_uppercase()
        ),
        fields: fields(&[
            ("event", event.to_string()),
            ("queue_id", queue_id.to_string()),
            ("_SYSTEMD_UNIT", "stalwart-mail.service".to_string()),
        ]),
        cursor: Some(format!("{SOURCE_MAIL}:{n}")),
    }
}

fn render_auth(sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(SOURCE_AUTH);
    let pid = 28000 + (mix(seed ^ n as u64) % 900) as i64;

    let (level, message) = match mix(seed ^ n as u64 ^ 0x24) % 10 {
        0..=5 => (
            "warn",
            format!(
                "sshd[{pid}]: Failed password for invalid user {} from {} port {} ssh2",
                pick(seed, n, &["admin", "test", "ubuntu", "oracle", "git", "pi"]),
                pick(seed ^ 0x7, n, THREAT_SOURCES),
                40000 + n % 20000
            ),
        ),
        6 => (
            "error",
            format!(
                "sshd[{pid}]: error: maximum authentication attempts exceeded for invalid user admin from {} port {} ssh2 [preauth]",
                pick(seed ^ 0x7, n, THREAT_SOURCES),
                40000 + n % 20000
            ),
        ),
        7 => ("info", "sudo: deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl reload nginx".into()),
        8 => (
            "info",
            format!(
                "sshd[{pid}]: Accepted publickey for deploy from {} port {} ssh2: ED25519 SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5o",
                sim.id.private_ip,
                50000 + n % 12000
            ),
        ),
        _ => ("info", format!("systemd-logind[{}]: New session {} of user deploy.", 700 + n % 9, 400 + n % 120)),
    };

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_AUTH.into(),
        message: format!("{} {} {message}", at.format("%b %e %H:%M:%S"), sim.short_host()),
        fields: BTreeMap::new(),
        cursor: Some(format!("{SOURCE_AUTH}:{n}")),
    }
}

fn render_syslog(sim: &Sim, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(SOURCE_SYSLOG);
    let (level, message) = journal_message(sim, seed, pick(seed, n, JOURNAL_UNITS), n);
    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: SOURCE_SYSLOG.into(),
        message: format!("{} {} {message}", at.format("%b %e %H:%M:%S"), sim.short_host()),
        fields: BTreeMap::new(),
        cursor: Some(format!("{SOURCE_SYSLOG}:{n}")),
    }
}

fn render_container(sim: &Sim, name: &str, image: &str, n: i64, at: DateTime<Utc>) -> LogRecord {
    let seed = hash_string(&format!("container|{name}"));
    let level = pick_level(seed, n);
    let domain = &sim.id.domain;

    let message = if image.starts_with("redis") {
        let ts = at.format("%d %b %Y %H:%M:%S%.3f");
        pick(
            seed,
            n,
            &[
                format!("1:M {ts} * Background saving terminated with success"),
                format!("1:M {ts} * DB saved on disk"),
                format!("1:M {ts} # Warning: 12 clients connected"),
            ],
        )
    } else if image.starts_with("minio") {
        pick(
            seed,
            n,
            &[
                format!(
                    "API: SYSTEM.scanner  Time: {}",
                    at.format("%H:%M:%S UTC %m/%d/%Y")
                ),
                format!(
                    "PUT /kaname-backups/2026/08/snapshot-{:04}.tar.zst 200 OK",
                    n % 9999
                ),
                "Automatically configured API requests per node based on available memory".to_string(),
            ],
        )
    } else if image.contains("uptime-kuma") {
        pick(
            seed,
            n,
            &[
                format!("[Monitor] [#{} api.{domain}] Down: connect ETIMEDOUT", 3 + n % 6),
                format!(
                    "[Monitor] [#{} {domain}] Up: 200 - OK ({}ms)",
                    1 + n % 9,
                    40 + n % 320
                ),
                "Adding a new monitor to the queue".to_string(),
            ],
        )
    } else if image.contains("n8n") {
        pick(
            seed,
            n,
            &[
                "Workflow execution finished successfully".to_string(),
                format!(
                    "Workflow execution {} failed: ECONNREFUSED 127.0.0.1:5432",
                    1200 + n
                ),
            ],
        )
    } else {
        pick(
            seed,
            n,
            &[
                "listening on 0.0.0.0",
                "health check ok",
                "reloading configuration",
            ],
        )
        .to_string()
    };

    LogRecord {
        ts: stamp(at),
        level: level.into(),
        source: format!("{SOURCE_CONTAINER}:{name}"),
        message,
        fields: fields(&[("container", name.to_string()), ("image", image.to_string())]),
        cursor: Some(format!("container:{name}:{n}")),
    }
}
