//! Containers.
//!
//! The Engine API is spoken directly over the local unix socket with a
//! bare HTTP/1.1 client (hyper, which is already in the dependency tree)
//! rather than by importing a Docker client crate: the handful of
//! endpoints below are stable, and the alternative drags a very large
//! dependency tree into a binary whose whole pitch is that it is small and
//! auditable.
//!
//! The socket is reached only from here. It is never exposed over the
//! network — a reachable container socket is a root shell, and not
//! exposing it is the entire reason this agent exists.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio_util::sync::CancellationToken;

use super::Shared;
use super::common::{
    epoch_rfc3339, invalid, not_found, now_rfc3339, precondition, rfc3339, split_lines, unsupported,
};
use crate::providers::*;

/// v1.40 is the newest version every supported Docker (20.10+) and Podman
/// compatibility socket both accept.
const DOCKER_API_PREFIX: &str = "/v1.40";
/// The daemon ignores Host on a unix socket, but HTTP/1.1 insists on one.
const DOCKER_HOST: &str = "kaname";

const DOCKER_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounds a single log frame so a malformed header cannot make the agent
/// allocate an arbitrary buffer.
const MAX_CONTAINER_FRAME: usize = 8 << 20;

const DOCKER_SOCKETS: &[(&str, &str)] = &[
    ("/var/run/docker.sock", cap::DOCKER),
    ("/run/docker.sock", cap::DOCKER),
    ("/run/podman/podman.sock", cap::PODMAN),
    ("/var/run/podman/podman.sock", cap::PODMAN),
];

pub struct ContainerOps(pub Arc<Shared>);

/// The container runtime's HTTP-over-unix-socket client.
pub struct DockerClient {
    socket: String,
    runtime: &'static str,
}

/// Prefers Docker and falls back to Podman's compatibility socket, which
/// speaks the same API.
pub async fn discover_container_runtime() -> Option<DockerClient> {
    use std::os::unix::fs::FileTypeExt;
    for (path, runtime) in DOCKER_SOCKETS {
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        if !meta.file_type().is_socket() {
            continue;
        }
        let client = DockerClient::new(path, runtime);
        let probe = Ctx::new(
            CancellationToken::new(),
            Some(Instant::now() + Duration::from_secs(3)),
        );
        if client
            .call(&probe, Method::GET, "/_ping", None, false)
            .await
            .is_err()
        {
            continue;
        }
        return Some(client);
    }
    None
}

/* --------------------------- wire structures -------------------------- */

#[derive(Debug, Default, Deserialize)]
struct DockerPort {
    #[serde(rename = "IP", default)]
    ip: String,
    #[serde(rename = "PrivatePort", default)]
    private_port: i64,
    #[serde(rename = "PublicPort", default)]
    public_port: i64,
    #[serde(rename = "Type", default)]
    kind: String,
}

#[derive(Debug, Default, Deserialize)]
struct DockerMount {
    #[serde(rename = "Source", default)]
    source: String,
    #[serde(rename = "Destination", default)]
    destination: String,
    #[serde(rename = "RW", default)]
    rw: bool,
}

#[derive(Debug, Default, Deserialize)]
struct NetworkSettingsList {
    #[serde(rename = "Networks", default)]
    networks: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct DockerContainer {
    #[serde(rename = "Id", default)]
    id: String,
    #[serde(rename = "Names", default)]
    names: Vec<String>,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "ImageID", default)]
    image_id: String,
    #[serde(rename = "Created", default)]
    created: i64,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: Vec<DockerPort>,
    #[serde(rename = "Labels", default)]
    labels: Option<BTreeMap<String, String>>,
    #[serde(rename = "Mounts", default)]
    mounts: Vec<DockerMount>,
    #[serde(rename = "NetworkSettings", default)]
    network_settings: NetworkSettingsList,
}

#[derive(Debug, Default, Deserialize)]
struct InspectState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "StartedAt", default)]
    started_at: String,
}

#[derive(Debug, Default, Deserialize)]
struct InspectConfig {
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Labels", default)]
    labels: Option<BTreeMap<String, String>>,
    #[serde(rename = "Tty", default)]
    tty: bool,
}

#[derive(Debug, Default, Deserialize)]
struct InspectHostConfig {
    #[serde(rename = "Memory", default)]
    memory: i64,
}

#[derive(Debug, Default, Deserialize)]
struct PortBinding {
    #[serde(rename = "HostIp", default)]
    host_ip: String,
    #[serde(rename = "HostPort", default)]
    host_port: String,
}

#[derive(Debug, Default, Deserialize)]
struct InspectNetworkSettings {
    #[serde(rename = "Ports", default)]
    ports: Option<BTreeMap<String, Option<Vec<PortBinding>>>>,
    #[serde(rename = "Networks", default)]
    networks: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct DockerInspect {
    #[serde(rename = "Id", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Created", default)]
    created: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: InspectState,
    #[serde(rename = "RestartCount", default)]
    restart_count: i64,
    #[serde(rename = "Config", default)]
    config: InspectConfig,
    #[serde(rename = "HostConfig", default)]
    host_config: InspectHostConfig,
    #[serde(rename = "NetworkSettings", default)]
    network_settings: InspectNetworkSettings,
    #[serde(rename = "Mounts", default)]
    mounts: Vec<DockerMount>,
}

#[derive(Debug, Default, Deserialize)]
struct CpuUsage {
    #[serde(default)]
    total_usage: u64,
    #[serde(default)]
    percpu_usage: Option<Vec<u64>>,
}

#[derive(Debug, Default, Deserialize)]
struct CpuStats {
    #[serde(default)]
    cpu_usage: CpuUsage,
    #[serde(default)]
    system_cpu_usage: u64,
    #[serde(default)]
    online_cpus: u64,
}

#[derive(Debug, Default, Deserialize)]
struct MemoryStats {
    #[serde(default)]
    usage: u64,
    #[serde(default)]
    limit: u64,
    #[serde(default)]
    stats: Option<BTreeMap<String, u64>>,
}

#[derive(Debug, Default, Deserialize)]
struct DockerStats {
    #[serde(default)]
    cpu_stats: CpuStats,
    #[serde(default)]
    precpu_stats: CpuStats,
    #[serde(default)]
    memory_stats: MemoryStats,
}

#[derive(Debug, Default, Deserialize)]
struct DockerImage {
    #[serde(rename = "Id", default)]
    id: String,
    #[serde(rename = "RepoTags", default)]
    repo_tags: Option<Vec<String>>,
    #[serde(rename = "Size", default)]
    size: i64,
    #[serde(rename = "Created", default)]
    created: i64,
    #[serde(rename = "Containers", default)]
    containers: i64,
}

#[derive(Debug, Default, Deserialize)]
struct DockerActor {
    #[serde(rename = "ID", default)]
    id: String,
}

#[derive(Debug, Default, Deserialize)]
struct DockerEvent {
    #[serde(rename = "Type", default)]
    kind: String,
    #[serde(rename = "Action", default)]
    action: String,
    #[serde(rename = "Actor", default)]
    actor: DockerActor,
}

/* ------------------------------ transport ---------------------------- */

impl DockerClient {
    fn new(socket: &str, runtime: &'static str) -> Self {
        Self {
            socket: socket.to_string(),
            runtime,
        }
    }

    /// "docker" or "podman": the capability name of the runtime whose socket
    /// answered.
    pub fn runtime(&self) -> &'static str {
        self.runtime
    }

    async fn get<T: DeserializeOwned>(&self, ctx: &Ctx, path: &str) -> PResult<T> {
        let body = self.call(ctx, Method::GET, path, None, true).await?;
        serde_json::from_slice(&body).map_err(|e| ProviderError::internal(format!("decode GET {path}: {e}")))
    }

    async fn post<T: DeserializeOwned>(
        &self,
        ctx: &Ctx,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> PResult<T> {
        let raw = self.call(ctx, Method::POST, path, body, true).await?;
        serde_json::from_slice(&raw).map_err(|e| ProviderError::internal(format!("decode POST {path}: {e}")))
    }

    async fn post_empty(&self, ctx: &Ctx, path: &str, body: Option<serde_json::Value>) -> PResult<()> {
        self.call(ctx, Method::POST, path, body, false).await.map(|_| ())
    }

    /// Performs a request and reads the whole body (when wanted), bounded
    /// by the caller's context.
    async fn call(
        &self,
        ctx: &Ctx,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        want_body: bool,
    ) -> PResult<Bytes> {
        let (response, _conn) = ctx.run(self.open(method.clone(), path, body)).await??;
        if !want_body {
            return Ok(Bytes::new());
        }
        let collected = ctx
            .run(response.into_body().collect())
            .await?
            .map_err(|e| ProviderError::internal(format!("read {method} {path}: {e}")))?;
        Ok(collected.to_bytes())
    }

    /// Dials the socket, performs the request and maps the daemon's own
    /// error shape onto the provider sentinels, so "no such container"
    /// reaches the panel as not_found rather than as an opaque exec failure.
    /// The returned task drives the connection and must stay alive for as
    /// long as the body is read.
    async fn open(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> PResult<(Response<Incoming>, tokio::task::JoinHandle<()>)> {
        let stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|e| ProviderError::internal(format!("{method} {path} on {}: {e}", self.socket)))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| ProviderError::internal(format!("{method} {path} on {}: {e}", self.socket)))?;
        let conn_task = tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });

        let mut request = Request::builder()
            .method(method.clone())
            .uri(format!("{DOCKER_API_PREFIX}{path}"))
            .header(hyper::header::HOST, DOCKER_HOST);
        let payload = match body {
            Some(value) => {
                request = request.header(hyper::header::CONTENT_TYPE, "application/json");
                Bytes::from(serde_json::to_vec(&value)?)
            }
            None => Bytes::new(),
        };
        let request = request
            .body(Full::new(payload))
            .map_err(|e| ProviderError::internal(format!("build {method} {path}: {e}")))?;

        let response = sender
            .send_request(request)
            .await
            .map_err(|e| ProviderError::internal(format!("{method} {path} on {}: {e}", self.socket)))?;
        if response.status().as_u16() >= 400 {
            let status = response.status();
            let raw = read_limited(response.into_body(), 8 << 10).await;
            conn_task.abort();
            return Err(docker_error(status, &raw));
        }
        Ok((response, conn_task))
    }

    /// Upgrades a request to a raw bidirectional stream, which is how the
    /// Engine API carries an interactive exec.
    async fn hijack(
        &self,
        ctx: &Ctx,
        path: &str,
        body: serde_json::Value,
    ) -> PResult<TokioIo<hyper::upgrade::Upgraded>> {
        let stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|e| ProviderError::internal(format!("dial {}: {e}", self.socket)))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| ProviderError::internal(format!("dial {}: {e}", self.socket)))?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });

        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("{DOCKER_API_PREFIX}{path}"))
            .header(hyper::header::HOST, DOCKER_HOST)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .header(hyper::header::CONNECTION, "Upgrade")
            .header(hyper::header::UPGRADE, "tcp")
            .body(Full::new(Bytes::from(serde_json::to_vec(&body)?)))
            .map_err(|e| ProviderError::internal(format!("build {path}: {e}")))?;

        let response = ctx
            .run(sender.send_request(request))
            .await?
            .map_err(|e| ProviderError::internal(format!("send {path}: {e}")))?;
        let status = response.status();
        if status != StatusCode::SWITCHING_PROTOCOLS && status != StatusCode::OK {
            let raw = read_limited(response.into_body(), 8 << 10).await;
            return Err(docker_error(status, &raw));
        }
        let upgraded = ctx
            .run(hyper::upgrade::on(response))
            .await?
            .map_err(|e| ProviderError::internal(format!("upgrade {path}: {e}")))?;
        Ok(TokioIo::new(upgraded))
    }

    /// Relays container state changes so the control plane's cached
    /// container table does not have to be polled (KD-012).
    pub async fn watch_events(self: Arc<Self>, shared: Arc<Shared>, cancel: CancellationToken) {
        let filters: String = url::form_urlencoded::byte_serialize(br#"{"type":["container"]}"#).collect();
        let path = format!("/events?filters={filters}");

        while !cancel.is_cancelled() {
            let opened = tokio::select! {
                r = self.open(Method::GET, &path, None) => r,
                _ = cancel.cancelled() => return,
            };
            let (response, conn_task) = match opened {
                Ok(opened) => opened,
                Err(_) => {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                    }
                    continue;
                }
            };

            let mut body = response.into_body();
            let mut buffer: Vec<u8> = Vec::new();
            loop {
                let frame = tokio::select! {
                    f = body.frame() => f,
                    _ = cancel.cancelled() => { conn_task.abort(); return; }
                };
                let Some(Ok(frame)) = frame else { break };
                let Ok(data) = frame.into_data() else { continue };
                buffer.extend_from_slice(&data);

                // Events arrive one JSON object per line, possibly split across
                // chunks; a partial line waits for the rest.
                while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=end).collect();
                    let Ok(event) = serde_json::from_slice::<DockerEvent>(&line) else {
                        continue;
                    };
                    if event.kind != "container" || event.actor.id.is_empty() {
                        continue;
                    }
                    match event.action.as_str() {
                        "start" | "stop" | "die" | "kill" | "pause" | "unpause" | "restart" | "destroy"
                        | "health_status" => {}
                        _ => continue,
                    }

                    let lookup = Ctx::new(cancel.child_token(), Some(Instant::now() + DOCKER_CALL_TIMEOUT));
                    if let Ok(info) = self.inspect(&lookup, &event.actor.id).await {
                        shared.emit(topic::CONTAINER_CHANGED, &info);
                    }
                }
            }
            conn_task.abort();
        }
    }
}

/// Reads at most `limit` bytes of a body, for error envelopes.
async fn read_limited(mut body: Incoming, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(data) = frame.into_data() {
            out.extend_from_slice(&data);
            if out.len() >= limit {
                out.truncate(limit);
                break;
            }
        }
    }
    out
}

fn docker_error(status: StatusCode, raw: &[u8]) -> ProviderError {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        message: String,
    }
    let mut message = String::from_utf8_lossy(raw).trim().to_string();
    if let Ok(envelope) = serde_json::from_slice::<Envelope>(raw) {
        if !envelope.message.is_empty() {
            message = envelope.message;
        }
    }

    match status {
        StatusCode::NOT_FOUND => not_found(message),
        StatusCode::CONFLICT => ProviderError::conflict(message),
        StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => ProviderError::PermissionDenied(message),
        StatusCode::NOT_IMPLEMENTED => unsupported(message),
        _ => ProviderError::exec("container runtime", format!("http {}", status.as_u16()), message),
    }
}

/* ------------------------------ operations --------------------------- */

impl ContainerOps {
    fn client(&self) -> PResult<Arc<DockerClient>> {
        self.0
            .docker
            .clone()
            .ok_or_else(|| unsupported("no container runtime socket on this host"))
    }
}

#[async_trait]
impl Containers for ContainerOps {
    async fn list(&self, ctx: &Ctx, p: ContainerListParams) -> PResult<Vec<ContainerInfo>> {
        let client = self.client()?;

        let raw: Vec<DockerContainer> = client
            .get(ctx, &format!("/containers/json?all={}", p.all))
            .await?;

        let mut containers = Vec::with_capacity(raw.len());
        for entry in raw {
            let mut info = client.info_from_list(&entry);
            if p.with_stats && info.state == "running" {
                if let Ok((cpu, memory, limit)) = client.stats(ctx, &entry.id).await {
                    info.cpu_percent = Some(cpu);
                    info.memory_usage = Some(memory);
                    info.memory_limit = Some(limit);
                }
            }
            containers.push(info);
        }
        containers.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(containers)
    }

    async fn inspect(&self, ctx: &Ctx, id: &str) -> PResult<ContainerInspectResult> {
        let client = self.client()?;

        let raw = client
            .call(
                ctx,
                Method::GET,
                &format!("/containers/{}/json", path_escape(id)),
                None,
                true,
            )
            .await?;
        if raw.len() > 4 << 20 {
            return Err(precondition("inspect body exceeds the cap"));
        }
        let parsed: DockerInspect = serde_json::from_slice(&raw)
            .map_err(|e| ProviderError::internal(format!("decode inspect body: {e}")))?;
        let value: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| ProviderError::internal(format!("decode inspect body: {e}")))?;
        Ok(ContainerInspectResult {
            container: client.info_from_inspect(&parsed),
            raw: value,
        })
    }

    async fn start(&self, ctx: &Ctx, id: &str) -> PResult<ContainerInfo> {
        let client = self.client()?;
        client
            .post_empty(ctx, &format!("/containers/{}/start", path_escape(id)), None)
            .await?;
        client.inspect(ctx, id).await
    }

    async fn stop(&self, ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        let client = self.client()?;
        let path = format!("/containers/{}/stop?t={}", path_escape(&p.id), p.timeout_seconds);
        client.post_empty(ctx, &path, None).await?;
        client.inspect(ctx, &p.id).await
    }

    async fn restart(&self, ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        let client = self.client()?;
        let path = format!(
            "/containers/{}/restart?t={}",
            path_escape(&p.id),
            p.timeout_seconds
        );
        client.post_empty(ctx, &path, None).await?;
        client.inspect(ctx, &p.id).await
    }

    async fn remove(&self, ctx: &Ctx, p: ContainerRemoveParams) -> PResult<()> {
        let client = self.client()?;
        let path = format!(
            "/containers/{}?force={}&v={}",
            path_escape(&p.id),
            p.force,
            p.remove_volumes
        );
        client
            .call(ctx, Method::DELETE, &path, None, false)
            .await
            .map(|_| ())
    }

    async fn logs(&self, ctx: &Ctx, p: ContainerLogsParams, stream: StreamRef) -> PResult<Vec<LogRecord>> {
        let client = self.client()?;

        // A container started with a TTY produces a raw stream; without one
        // the daemon frames stdout and stderr, and reading it as raw text
        // would leave the 8-byte headers in the operator's log view.
        let tty = client
            .inspect_raw(ctx, &p.id)
            .await
            .map(|i| i.config.tty)
            .unwrap_or(false);

        let lines = if p.lines <= 0 { 200 } else { p.lines as usize };

        // The serializer is not `Send`, so it lives and dies before the
        // first await.
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("stdout", "1");
            query.append_pair("stderr", "1");
            query.append_pair("timestamps", "1");
            query.append_pair("tail", &lines.to_string());
            query.append_pair("follow", if p.follow { "true" } else { "false" });
            if let Some(since) = p.since.as_deref().filter(|s| !s.is_empty()) {
                let since = parse_since(since)?;
                query.append_pair("since", &since.timestamp().to_string());
            }
            query.finish()
        };
        let path = format!("/containers/{}/logs?{}", path_escape(&p.id), query);

        let (response, conn_task) = ctx.run(client.open(Method::GET, &path, None)).await??;
        let body = response.into_body();

        let source = format!("container:{}", p.id);
        let mut backlog: Vec<LogRecord> = Vec::with_capacity(lines);
        let follow = p.follow;
        let mut emit = |line: &str| -> BoxedEmit {
            let record = container_log_record(&source, line);
            if backlog.len() < lines {
                backlog.push(record);
                return Box::pin(async { Ok::<(), ProviderError>(()) });
            }
            if !follow {
                return Box::pin(async { Ok::<(), ProviderError>(()) });
            }
            let stream = stream.clone();
            Box::pin(async move { send_record(stream.as_ref(), &record).await })
        };

        let result = if tty {
            scan_lines(ctx, body, &mut emit).await
        } else {
            demultiplex(ctx, body, &mut emit).await
        };
        conn_task.abort();
        match result {
            Err(err) if !ctx.is_cancelled() => Err(err),
            _ => Ok(backlog),
        }
    }

    async fn exec(&self, ctx: &Ctx, p: ContainerExecParams, stream: StreamRef) -> PResult<()> {
        let client = self.client()?;

        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "Id", default)]
            id: String,
        }
        // The command is a fixed argv, not a string: container.exec gives an
        // operator a shell inside the container, it does not let the caller
        // choose an arbitrary command line from the wire.
        let body = serde_json::json!({
            "AttachStdin": true,
            "AttachStdout": true,
            "AttachStderr": true,
            "Tty": true,
            "Cmd": ["/bin/sh"],
            "Env": ["TERM=xterm-256color"],
        });
        let created: Created = client
            .post(
                ctx,
                &format!("/containers/{}/exec", path_escape(&p.id)),
                Some(body),
            )
            .await?;
        if created.id.is_empty() {
            return Err(ProviderError::conflict("container runtime returned no exec id"));
        }

        let conn = client
            .hijack(
                ctx,
                &format!("/exec/{}/start", path_escape(&created.id)),
                serde_json::json!({"Detach": false, "Tty": true}),
            )
            .await?;

        // The daemon only accepts a resize once the exec is running, and the
        // hijack response is what says it is.
        if let Err(err) = client.resize_exec(ctx, &created.id, p.cols, p.rows).await {
            tracing::debug!(container = %p.id, error = %err, "exec resize refused");
        }

        pump_stream(ctx, stream, conn).await
    }

    async fn images(&self, ctx: &Ctx) -> PResult<Vec<ImageInfo>> {
        let client = self.client()?;

        let raw: Vec<DockerImage> = client.get(ctx, "/images/json").await?;

        // The daemon only fills `Containers` when asked for shared sizes, so
        // usage is derived from the container table instead.
        let mut used = std::collections::HashSet::new();
        if let Ok(containers) = client
            .get::<Vec<DockerContainer>>(ctx, "/containers/json?all=1")
            .await
        {
            for container in containers {
                used.insert(container.image_id);
            }
        }

        let mut images: Vec<ImageInfo> = raw
            .into_iter()
            .map(|entry| ImageInfo {
                in_use: used.contains(&entry.id) || entry.containers > 0,
                id: entry.id,
                tags: entry.repo_tags.unwrap_or_default(),
                size: entry.size,
                created_at: epoch_rfc3339(entry.created),
            })
            .collect();
        images.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(images)
    }

    async fn prune(&self, ctx: &Ctx, p: ContainerPruneParams) -> PResult<ContainerPruneResult> {
        let mut result = ContainerPruneResult::default();
        let client = self.client()?;

        #[derive(Deserialize)]
        struct ContainersPruned {
            #[serde(rename = "ContainersDeleted", default)]
            containers_deleted: Option<Vec<String>>,
            #[serde(rename = "SpaceReclaimed", default)]
            space_reclaimed: i64,
        }
        let containers: ContainersPruned = client.post(ctx, "/containers/prune", None).await?;
        result
            .removed
            .extend(containers.containers_deleted.unwrap_or_default());
        result.reclaimed_bytes += containers.space_reclaimed;

        if p.include_images {
            #[derive(Deserialize)]
            struct ImageDeleted {
                #[serde(rename = "Deleted", default)]
                deleted: String,
            }
            #[derive(Deserialize)]
            struct ImagesPruned {
                #[serde(rename = "ImagesDeleted", default)]
                images_deleted: Option<Vec<ImageDeleted>>,
                #[serde(rename = "SpaceReclaimed", default)]
                space_reclaimed: i64,
            }
            let images: ImagesPruned = client.post(ctx, "/images/prune", None).await?;
            for image in images.images_deleted.unwrap_or_default() {
                if !image.deleted.is_empty() {
                    result.removed.push(image.deleted);
                }
            }
            result.reclaimed_bytes += images.space_reclaimed;
        }

        if p.include_volumes {
            #[derive(Deserialize)]
            struct VolumesPruned {
                #[serde(rename = "VolumesDeleted", default)]
                volumes_deleted: Option<Vec<String>>,
                #[serde(rename = "SpaceReclaimed", default)]
                space_reclaimed: i64,
            }
            let volumes: VolumesPruned = client.post(ctx, "/volumes/prune", None).await?;
            result.removed.extend(volumes.volumes_deleted.unwrap_or_default());
            result.reclaimed_bytes += volumes.space_reclaimed;
        }
        Ok(result)
    }

    async fn pull_image(&self, ctx: &Ctx, p: ImagePullParams, stream: StreamRef) -> PResult<ImagePullResult> {
        let client = self.client()?;
        let (from, tag) = managed::pull_query(&p.image);
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("fromImage", &from);
            if let Some(tag) = &tag {
                query.append_pair("tag", tag);
            }
            query.finish()
        };
        say(stream.as_ref(), format!("pulling {}", p.image)).await;
        let (response, conn_task) = ctx
            .run(client.open(Method::POST, &format!("/images/create?{query}"), None))
            .await??;

        // Progress arrives one JSON object per line. Byte counters are
        // dropped: a layer's status changing is worth a line, its
        // percentage ticking is not.
        let mut body = response.into_body();
        let mut buffer: Vec<u8> = Vec::new();
        let mut last = String::new();
        let mut failure: Option<String> = None;
        loop {
            let frame = tokio::select! {
                f = body.frame() => f,
                _ = ctx.done() => { conn_task.abort(); return Err(ctx.error()); }
            };
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|e| ProviderError::internal(format!("read pull progress: {e}")))?;
            let Ok(data) = frame.into_data() else { continue };
            buffer.extend_from_slice(&data);
            if buffer.len() > MAX_CONTAINER_FRAME {
                conn_task.abort();
                return Err(precondition("image pull progress line exceeds the cap"));
            }
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buffer.drain(..=end).collect();
                let Ok(progress) = serde_json::from_slice::<PullProgress>(&line) else {
                    continue;
                };
                if !progress.error.is_empty() {
                    failure = Some(progress.error);
                    continue;
                }
                if progress.status.is_empty()
                    || progress.status == "Downloading"
                    || progress.status == "Extracting"
                {
                    continue;
                }
                let text = if progress.id.is_empty() {
                    progress.status
                } else {
                    format!("{}: {}", progress.id, progress.status)
                };
                if text != last {
                    say(stream.as_ref(), &text).await;
                    last = text;
                }
            }
        }
        conn_task.abort();
        if let Some(error) = failure {
            return Err(ProviderError::exec(
                "image pull",
                format!("could not pull {}", p.image),
                error,
            ));
        }

        #[derive(Deserialize)]
        struct Inspected {
            #[serde(rename = "Id", default)]
            id: String,
        }
        let inspected: Inspected = client
            .get(ctx, &format!("/images/{}/json", path_escape(&p.image)))
            .await?;
        Ok(ImagePullResult {
            image: p.image,
            id: inspected.id,
        })
    }

    async fn create_network(&self, ctx: &Ctx, install_id: &str) -> PResult<ManagedNetworkResult> {
        let client = self.client()?;
        let name = managed::network_name(install_id);
        if let Some(existing) = self.find_network(ctx, &client, &name).await? {
            if !managed::is_managed_by(existing.labels.as_ref().unwrap_or(&BTreeMap::new()), install_id) {
                return Err(ProviderError::conflict(format!(
                    "a network named {name} exists and was not created by Kaname"
                )));
            }
            return Ok(ManagedNetworkResult {
                name: existing.name,
                id: existing.id,
                created: false,
            });
        }

        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "Id", default)]
            id: String,
        }
        let body = serde_json::json!({
            "Name": name,
            "Driver": "bridge",
            "CheckDuplicate": true,
            "Internal": false,
            "Attachable": false,
            "Labels": managed::install_labels(install_id),
        });
        let created: Created = client.post(ctx, "/networks/create", Some(body)).await?;
        Ok(ManagedNetworkResult {
            name,
            id: created.id,
            created: true,
        })
    }

    async fn create_managed(&self, ctx: &Ctx, spec: ManagedContainerSpec) -> PResult<ContainerInfo> {
        let client = self.client()?;
        let name = self.prepare_managed(ctx, &client, &spec, spec.replace).await?;

        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "Id", default)]
            id: String,
        }
        let created: Created = client
            .post(
                ctx,
                &format!("/containers/create?name={}", path_escape(&name)),
                Some(managed::create_body(&spec)),
            )
            .await?;
        if let Err(err) = client
            .post_empty(
                ctx,
                &format!("/containers/{}/start", path_escape(&created.id)),
                None,
            )
            .await
        {
            // A container that was created but cannot start (a port taken by
            // something else) is removed, so a retry starts clean.
            let _ = client
                .call(
                    ctx,
                    Method::DELETE,
                    &format!("/containers/{}?force=true&v=true", path_escape(&created.id)),
                    None,
                    false,
                )
                .await;
            return Err(err);
        }
        client.inspect(ctx, &created.id).await
    }

    async fn run_task(&self, ctx: &Ctx, p: ManagedTaskParams) -> PResult<ManagedTaskResult> {
        let client = self.client()?;
        let spec = p.spec;
        // A task of the same role left by an interrupted run is replaced.
        let name = self.prepare_managed(ctx, &client, &spec, true).await?;

        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "Id", default)]
            id: String,
        }
        #[derive(Deserialize)]
        struct Waited {
            #[serde(rename = "StatusCode", default)]
            status_code: i64,
        }
        let created: Created = client
            .post(
                ctx,
                &format!("/containers/create?name={}", path_escape(&name)),
                Some(managed::task_body(&spec)),
            )
            .await?;
        let id = path_escape(&created.id);
        let remove = format!("/containers/{id}?force=true&v=true");

        let outcome: PResult<i64> = async {
            client.post_empty(ctx, &format!("/containers/{id}/start"), None).await?;
            let wait_path = format!("/containers/{id}/wait?condition=not-running");
            let wait = client.post::<Waited>(ctx, &wait_path, None);
            match tokio::time::timeout(Duration::from_secs(p.timeout_seconds as u64), wait).await {
                Ok(waited) => Ok(waited?.status_code),
                Err(_) => Err(ProviderError::Timeout),
            }
        }
        .await;

        let output = client
            .call(ctx, Method::GET, &format!("/containers/{id}/logs?stdout=1&stderr=1&tail=64"), None, true)
            .await
            .map(|raw| demultiplex_bytes(&raw))
            .unwrap_or_default();
        let _ = client.call(ctx, Method::DELETE, &remove, None, false).await;
        Ok(ManagedTaskResult {
            exit_code: outcome?,
            output: truncate_output(output),
        })
    }

    async fn app_status(&self, ctx: &Ctx, install_id: &str) -> PResult<ManagedAppStatus> {
        let client = self.client()?;
        let mut status = ManagedAppStatus::default();
        for entry in self.managed_containers(ctx, &client, install_id).await? {
            let info = client.info_from_list(&entry);
            let role = info.labels.get(managed::LABEL_ROLE).cloned().unwrap_or_default();
            for port in &info.ports {
                let Some(host_port) = port.host_port else { continue };
                let (reachable, http_status) = if info.state == "running" {
                    probe_http(host_port).await
                } else {
                    (false, None)
                };
                status.endpoints.push(ManagedEndpoint {
                    role: role.clone(),
                    host_port,
                    container_port: port.container_port,
                    reachable,
                    http_status,
                });
            }
            status.containers.push(ManagedContainerState {
                role,
                name: info.name,
                state: info.state,
                status: info.status,
            });
        }
        status.containers.sort_by(|a, b| a.role.cmp(&b.role));
        Ok(status)
    }

    async fn remove_app(&self, ctx: &Ctx, p: ManagedAppRemoveParams) -> PResult<ManagedAppRemoveResult> {
        let client = self.client()?;
        let mut result = ManagedAppRemoveResult::default();
        for entry in self.managed_containers(ctx, &client, &p.install_id).await? {
            let path = format!("/containers/{}?force=true&v=true", path_escape(&entry.id));
            match client.call(ctx, Method::DELETE, &path, None, false).await {
                Ok(_) | Err(ProviderError::NotFound(_)) => {
                    result.containers.push(container_name(&entry.names))
                }
                Err(err) => return Err(err),
            }
        }
        for network in self.managed_networks(ctx, &client, &p.install_id).await? {
            let path = format!("/networks/{}", path_escape(&network.id));
            match client.call(ctx, Method::DELETE, &path, None, false).await {
                Ok(_) | Err(ProviderError::NotFound(_)) => result.networks.push(network.name),
                Err(err) => return Err(err),
            }
        }
        if p.remove_data {
            let dir = managed::install_dir(managed::MANAGED_APPS_ROOT, &p.install_id);
            match std::fs::symlink_metadata(&dir) {
                // remove_dir_all does not follow symlinks below the top; the
                // top itself is refused if it is one.
                Ok(meta) if meta.file_type().is_dir() => {
                    std::fs::remove_dir_all(&dir)?;
                    result.data_removed = true;
                }
                Ok(_) => {
                    return Err(precondition(format!(
                        "{dir} is not a directory; leaving it alone"
                    )));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(result)
    }
}

/* ----------------------- managed app containers --------------------- */

#[derive(Debug, Default, Deserialize)]
struct DockerNetwork {
    #[serde(rename = "Id", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Labels", default)]
    labels: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Default, Deserialize)]
struct PullProgress {
    #[serde(default)]
    status: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    error: String,
}

/// A label filter for the managed resources of one install, url-encoded.
fn install_filter(install_id: &str) -> String {
    let filter = serde_json::json!({
        "label": [
            format!("{}=true", managed::LABEL_MANAGED),
            format!("{}={install_id}", managed::LABEL_INSTALL),
        ]
    });
    url::form_urlencoded::byte_serialize(filter.to_string().as_bytes()).collect()
}

/// Creates a bind source (and the install directory above it, private to
/// root) and re-checks it once it exists: the check before creation
/// covered the parts that existed, this one covers what mkdir made.
fn prepare_source(mount: &ManagedMount, install_id: &str) -> PResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = managed::MANAGED_APPS_ROOT;
    for dir in [root.to_string(), managed::install_dir(root, install_id)] {
        if std::fs::symlink_metadata(&dir).is_err() {
            std::fs::create_dir_all(&dir)?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    std::fs::create_dir_all(&mount.source)?;
    managed::check_source(root, install_id, &mount.source)?;
    if mount.uid.is_some() || mount.gid.is_some() {
        std::os::unix::fs::chown(&mount.source, mount.uid, mount.gid)?;
    }
    Ok(())
}

/// Writes one configuration file under the install's directory. The path
/// was checked by the handler; it is checked again once its parents exist,
/// and the file is opened without following a symlink at its name.
fn write_managed_file(file: &ManagedFile, install_id: &str) -> PResult<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let root = managed::MANAGED_APPS_ROOT;
    let target = managed::file_source(root, install_id, &file.path);
    if let Some(parent) = std::path::Path::new(&target).parent() {
        prepare_source(
            &ManagedMount {
                source: parent.to_string_lossy().into_owned(),
                ..Default::default()
            },
            install_id,
        )
        .or_else(|err| {
            // The install directory itself is a valid parent of a top-level file.
            if parent.to_string_lossy() == managed::install_dir(root, install_id) {
                Ok(())
            } else {
                Err(err)
            }
        })?;
    }
    managed::check_source(root, install_id, &target)?;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&target)?;
    out.write_all(file.content.as_bytes())?;
    Ok(())
}

/// Decodes a whole framed (non-TTY) log body into text.
fn demultiplex_bytes(mut raw: &[u8]) -> String {
    let mut out = Vec::new();
    while raw.len() >= 8 {
        let size = u32::from_be_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
        let end = (8 + size).min(raw.len());
        out.extend_from_slice(&raw[8..end]);
        raw = &raw[end..];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Sends `GET /` to a loopback port and reads the status line, so the
/// install's health check means "the app answers HTTP", not "a socket is
/// open". The address is fixed; only the port comes from the container.
async fn probe_http(port: i64) -> (bool, Option<i64>) {
    let Ok(Ok(mut stream)) = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect((managed::LOOPBACK, port as u16)),
    )
    .await
    else {
        return (false, None);
    };
    let request = b"GET / HTTP/1.0\r\nHost: localhost\r\nUser-Agent: kaname-agent\r\n\r\n";
    if stream.write_all(request).await.is_err() {
        return (true, None);
    }
    let mut head = vec![0u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut head)).await;
    let Ok(Ok(n)) = read else { return (true, None) };
    (true, parse_status_line(&head[..n]))
}

fn parse_status_line(head: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(head).ok()?;
    let mut parts = text.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts
        .next()?
        .parse::<i64>()
        .ok()
        .filter(|c| (100..600).contains(c))
}

impl ContainerOps {
    /// Everything before the create call, shared by services and tasks:
    /// the install's network must be Kaname's, a same-named container must
    /// be this install's (and is replaced only when asked), and every bind
    /// source and file is put in place under the managed root.
    async fn prepare_managed(&self, ctx: &Ctx, client: &DockerClient, spec: &ManagedContainerSpec, replace: bool) -> PResult<String> {
        let network = managed::network_name(&spec.install_id);
        match self.find_network(ctx, client, &network).await? {
            Some(n)
                if managed::is_managed_by(
                    n.labels.as_ref().unwrap_or(&BTreeMap::new()),
                    &spec.install_id,
                ) => {}
            Some(_) => {
                return Err(precondition(format!("{network} was not created by Kaname")));
            }
            None => {
                return Err(precondition(format!(
                    "the install's network {network} does not exist; create it first"
                )));
            }
        }

        let name = managed::container_name(&spec.install_id, &spec.role);
        match client.inspect_raw(ctx, &name).await {
            Ok(existing) => {
                let labels = existing.config.labels.clone().unwrap_or_default();
                let ours = managed::is_managed_by(&labels, &spec.install_id)
                    && labels.get(managed::LABEL_ROLE) == Some(&spec.role);
                if !ours {
                    return Err(ProviderError::conflict(format!(
                        "a container named {name} exists and was not created by Kaname"
                    )));
                }
                if !replace {
                    return Err(ProviderError::conflict(format!(
                        "container {name} already exists"
                    )));
                }
                client
                    .call(
                        ctx,
                        Method::DELETE,
                        &format!("/containers/{}?force=true&v=true", path_escape(&existing.id)),
                        None,
                        false,
                    )
                    .await?;
            }
            Err(ProviderError::NotFound(_)) => {}
            Err(err) => return Err(err),
        }

        for mount in &spec.mounts {
            prepare_source(mount, &spec.install_id)?;
        }
        for file in &spec.files {
            write_managed_file(file, &spec.install_id)?;
        }
        Ok(name)
    }

    async fn managed_containers(
        &self,
        ctx: &Ctx,
        client: &DockerClient,
        install_id: &str,
    ) -> PResult<Vec<DockerContainer>> {
        let all: Vec<DockerContainer> = client
            .get(
                ctx,
                &format!("/containers/json?all=1&filters={}", install_filter(install_id)),
            )
            .await?;
        // The daemon filtered on labels already; checking again here is what
        // keeps the destructive verb honest if a runtime ignores a filter.
        Ok(all
            .into_iter()
            .filter(|c| managed::is_managed_by(c.labels.as_ref().unwrap_or(&BTreeMap::new()), install_id))
            .collect())
    }

    async fn managed_networks(
        &self,
        ctx: &Ctx,
        client: &DockerClient,
        install_id: &str,
    ) -> PResult<Vec<DockerNetwork>> {
        let all: Vec<DockerNetwork> = client
            .get(ctx, &format!("/networks?filters={}", install_filter(install_id)))
            .await?;
        Ok(all
            .into_iter()
            .filter(|n| managed::is_managed_by(n.labels.as_ref().unwrap_or(&BTreeMap::new()), install_id))
            .collect())
    }

    async fn find_network(
        &self,
        ctx: &Ctx,
        client: &DockerClient,
        name: &str,
    ) -> PResult<Option<DockerNetwork>> {
        match client
            .get::<DockerNetwork>(ctx, &format!("/networks/{}", path_escape(name)))
            .await
        {
            Ok(network) => Ok(Some(network)),
            Err(ProviderError::NotFound(_)) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

/* ------------------------------- mapping ----------------------------- */

impl DockerClient {
    async fn inspect(&self, ctx: &Ctx, id: &str) -> PResult<ContainerInfo> {
        let parsed = self.inspect_raw(ctx, id).await?;
        Ok(self.info_from_inspect(&parsed))
    }

    async fn inspect_raw(&self, ctx: &Ctx, id: &str) -> PResult<DockerInspect> {
        self.get(ctx, &format!("/containers/{}/json", path_escape(id)))
            .await
    }

    fn info_from_list(&self, entry: &DockerContainer) -> ContainerInfo {
        let ports = entry
            .ports
            .iter()
            .map(|port| {
                let mut mapped = ContainerPort {
                    container_port: port.private_port,
                    host_port: None,
                    host_ip: None,
                    protocol: normalize_protocol(&port.kind).into(),
                };
                if port.public_port > 0 {
                    mapped.host_port = Some(port.public_port);
                    mapped.host_ip = Some(port.ip.clone());
                }
                mapped
            })
            .collect();

        ContainerInfo {
            id: entry.id.clone(),
            name: container_name(&entry.names),
            image: entry.image.clone(),
            image_id: entry.image_id.clone(),
            state: container_state(&entry.state).into(),
            status: entry.status.clone(),
            created_at: epoch_rfc3339(entry.created),
            started_at: None,
            ports,
            labels: entry.labels.clone().unwrap_or_default(),
            networks: network_names(entry.network_settings.networks.as_ref()),
            mounts: mounts(&entry.mounts),
            restart_count: 0,
            cpu_percent: None,
            memory_usage: None,
            memory_limit: None,
            runtime: self.runtime.to_string(),
        }
    }

    fn info_from_inspect(&self, parsed: &DockerInspect) -> ContainerInfo {
        let mut ports: Vec<ContainerPort> = Vec::new();
        for (spec, bindings) in parsed.network_settings.ports.iter().flatten() {
            let (number, protocol) = split_port_spec(spec);
            if number == 0 {
                continue;
            }
            match bindings {
                Some(bindings) if !bindings.is_empty() => {
                    for binding in bindings {
                        let mut mapped = ContainerPort {
                            container_port: number,
                            host_port: None,
                            host_ip: None,
                            protocol: protocol.into(),
                        };
                        if let Ok(host) = binding.host_port.parse::<i64>() {
                            mapped.host_port = Some(host);
                            mapped.host_ip = Some(binding.host_ip.clone());
                        }
                        ports.push(mapped);
                    }
                }
                _ => ports.push(ContainerPort {
                    container_port: number,
                    host_port: None,
                    host_ip: None,
                    protocol: protocol.into(),
                }),
            }
        }
        ports.sort_by_key(|p| p.container_port);

        let mut info = ContainerInfo {
            id: parsed.id.clone(),
            name: parsed.name.strip_prefix('/').unwrap_or(&parsed.name).to_string(),
            image: parsed.config.image.clone(),
            image_id: parsed.image.clone(),
            state: container_state(&parsed.state.status).into(),
            status: parsed.state.status.clone(),
            created_at: normalize_timestamp(&parsed.created),
            started_at: None,
            ports,
            labels: parsed.config.labels.clone().unwrap_or_default(),
            networks: network_names(parsed.network_settings.networks.as_ref()),
            mounts: mounts(&parsed.mounts),
            restart_count: parsed.restart_count,
            cpu_percent: None,
            memory_usage: None,
            memory_limit: None,
            runtime: self.runtime.to_string(),
        };
        let started = normalize_timestamp(&parsed.state.started_at);
        if !started.is_empty() && !parsed.state.started_at.starts_with("0001-") {
            info.started_at = Some(started);
        }
        if parsed.host_config.memory > 0 {
            info.memory_limit = Some(parsed.host_config.memory);
        }
        info
    }

    /// Takes one non-streaming sample and turns the two cumulative readings
    /// the daemon returns into a percentage.
    async fn stats(&self, ctx: &Ctx, id: &str) -> PResult<(f64, i64, i64)> {
        let parsed: DockerStats = tokio::time::timeout(
            DOCKER_CALL_TIMEOUT,
            self.get(
                ctx,
                &format!("/containers/{}/stats?stream=false", path_escape(id)),
            ),
        )
        .await
        .map_err(|_| ProviderError::Timeout)??;

        let cpu_delta =
            parsed.cpu_stats.cpu_usage.total_usage as f64 - parsed.precpu_stats.cpu_usage.total_usage as f64;
        let system_delta =
            parsed.cpu_stats.system_cpu_usage as f64 - parsed.precpu_stats.system_cpu_usage as f64;
        let mut cores = parsed.cpu_stats.online_cpus as usize;
        if cores == 0 {
            cores = parsed
                .cpu_stats
                .cpu_usage
                .percpu_usage
                .as_ref()
                .map(Vec::len)
                .unwrap_or(0);
        }

        let mut percent = 0.0;
        if cpu_delta > 0.0 && system_delta > 0.0 && cores > 0 {
            percent = (cpu_delta / system_delta * cores as f64 * 100.0).clamp(0.0, 100.0 * cores as f64);
        }

        // The kernel counts page cache as container memory; subtracting it is
        // what makes the figure match what an operator sees in `docker stats`.
        let mut usage = parsed.memory_stats.usage;
        let stats = parsed.memory_stats.stats.unwrap_or_default();
        if let Some(cache) = stats.get("inactive_file").filter(|c| **c < usage) {
            usage -= cache;
        } else if let Some(cache) = stats.get("cache").filter(|c| **c < usage) {
            usage -= cache;
        }
        Ok((percent, usage as i64, parsed.memory_stats.limit as i64))
    }

    async fn resize_exec(&self, ctx: &Ctx, exec_id: &str, cols: i64, rows: i64) -> PResult<()> {
        let path = format!("/exec/{}/resize?h={rows}&w={cols}", path_escape(exec_id));
        self.post_empty(ctx, &path, None).await
    }
}

/* ------------------------------- streams ----------------------------- */

type BoxedEmit = std::pin::Pin<Box<dyn std::future::Future<Output = PResult<()>> + Send>>;

/// Decodes the daemon's framed log stream: an 8-byte header carrying the
/// stream id and payload length, then the payload.
async fn demultiplex(
    ctx: &Ctx,
    mut body: Incoming,
    emit: &mut (dyn FnMut(&str) -> BoxedEmit + Send),
) -> PResult<()> {
    let mut buffer: Vec<u8> = Vec::with_capacity(64 << 10);
    loop {
        ctx.check()?;
        // Drain every complete frame the buffer holds.
        loop {
            if buffer.len() < 8 {
                break;
            }
            let size = u32::from_be_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]) as usize;
            if size == 0 {
                buffer.drain(..8);
                continue;
            }
            if size > MAX_CONTAINER_FRAME {
                return Err(precondition(format!(
                    "container log frame of {size} bytes exceeds the cap"
                )));
            }
            if buffer.len() < 8 + size {
                break;
            }
            let payload: Vec<u8> = buffer.drain(..8 + size).skip(8).collect();
            let text = String::from_utf8_lossy(&payload);
            for line in split_lines(&text) {
                emit(line).await?;
            }
        }

        let frame = tokio::select! {
            f = body.frame() => f,
            _ = ctx.done() => return Err(ctx.error()),
        };
        match frame {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    buffer.extend_from_slice(&data);
                }
            }
            Some(Err(e)) => return Err(ProviderError::internal(format!("read container logs: {e}"))),
            None => return Ok(()),
        }
    }
}

async fn scan_lines(
    ctx: &Ctx,
    mut body: Incoming,
    emit: &mut (dyn FnMut(&str) -> BoxedEmit + Send),
) -> PResult<()> {
    let mut buffer: Vec<u8> = Vec::with_capacity(64 << 10);
    loop {
        let frame = tokio::select! {
            f = body.frame() => f,
            _ = ctx.done() => return Err(ctx.error()),
        };
        match frame {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    buffer.extend_from_slice(&data);
                }
            }
            Some(Err(e)) => return Err(ProviderError::internal(format!("read container logs: {e}"))),
            None => {
                if !buffer.is_empty() {
                    emit(&String::from_utf8_lossy(&buffer)).await?;
                }
                return Ok(());
            }
        }
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            emit(text.strip_suffix('\r').unwrap_or(&text)).await?;
        }
        if buffer.len() > MAX_CONTAINER_FRAME {
            return Err(precondition("container log line exceeds the cap"));
        }
    }
}

/// Wires a hijacked connection to the RPC stream in both directions and
/// tears both down as soon as either side ends.
async fn pump_stream(ctx: &Ctx, stream: StreamRef, conn: TokioIo<hyper::upgrade::Upgraded>) -> PResult<()> {
    let (mut reader, mut writer) = tokio::io::split(conn);

    let outbound = {
        let stream = stream.clone();
        async move {
            let mut buffer = vec![0u8; 32 << 10];
            loop {
                let n = match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => return Ok(()),
                    Ok(n) => n,
                };
                stream.send(&buffer[..n], Encoding::Base64).await?;
            }
        }
    };
    let inbound = async move {
        loop {
            match stream.recv().await {
                Ok(Some(data)) => {
                    if let Err(e) = writer.write_all(&data).await {
                        return Err(ProviderError::internal(format!("write to exec: {e}")));
                    }
                }
                Ok(None) | Err(_) => return Ok::<(), ProviderError>(()),
            }
        }
    };

    tokio::select! {
        r = outbound => r,
        r = inbound => r,
        _ = ctx.done() => Ok(()),
    }
}

/* ------------------------------- helpers ----------------------------- */

/// Puts one record on the wire as a newline-delimited JSON object, which is
/// the framing every log stream in this agent uses.
async fn send_record(stream: &dyn Stream, record: &LogRecord) -> PResult<()> {
    let mut encoded = serde_json::to_vec(record)?;
    encoded.push(b'\n');
    stream.send(&encoded, Encoding::Utf8).await
}

fn container_log_record(source: &str, line: &str) -> LogRecord {
    // `timestamps=1` prefixes every line with an RFC3339Nano stamp.
    let Some((ts, message)) = line.split_once(' ') else {
        return LogRecord {
            ts: now_rfc3339(),
            level: "info".into(),
            source: source.to_string(),
            message: line.to_string(),
            ..Default::default()
        };
    };
    match chrono::DateTime::parse_from_rfc3339(ts) {
        Ok(parsed) => LogRecord {
            ts: rfc3339(parsed.with_timezone(&chrono::Utc)),
            level: guess_level(message).into(),
            source: source.to_string(),
            message: message.to_string(),
            ..Default::default()
        },
        Err(_) => LogRecord {
            ts: now_rfc3339(),
            level: "info".into(),
            source: source.to_string(),
            message: line.to_string(),
            ..Default::default()
        },
    }
}

/// Reads a severity out of an unstructured line. It is a hint for the log
/// viewer's filter, never a claim about the writer's intent.
fn guess_level(line: &str) -> &'static str {
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

/// Accepts an absolute RFC3339 stamp, an epoch or a relative window like
/// "-2h", because all three shapes reach the agent from different UI
/// controls.
fn parse_since(value: &str) -> PResult<chrono::DateTime<chrono::Utc>> {
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
    let elapsed = chrono::Duration::from_std(elapsed).map_err(|_| invalid("since is out of range"))?;
    Ok(chrono::Utc::now() - elapsed)
}

fn container_name(names: &[String]) -> String {
    names
        .first()
        .map(|n| n.strip_prefix('/').unwrap_or(n).to_string())
        .unwrap_or_default()
}

fn container_state(state: &str) -> &'static str {
    match state {
        "created" => "created",
        "running" => "running",
        "paused" => "paused",
        "restarting" => "restarting",
        "removing" => "removing",
        "exited" => "exited",
        "dead" => "dead",
        _ => "unknown",
    }
}

fn normalize_protocol(protocol: &str) -> &'static str {
    if protocol == "udp" { "udp" } else { "tcp" }
}

fn split_port_spec(spec: &str) -> (i64, &'static str) {
    match spec.split_once('/') {
        Some((number, protocol)) => match number.parse::<i64>() {
            Ok(parsed) => (parsed, normalize_protocol(protocol)),
            Err(_) => (0, "tcp"),
        },
        None => (spec.parse::<i64>().unwrap_or(0), "tcp"),
    }
}

fn network_names(networks: Option<&BTreeMap<String, serde_json::Value>>) -> Vec<String> {
    // A BTreeMap already iterates in sorted order.
    networks.map(|n| n.keys().cloned().collect()).unwrap_or_default()
}

fn mounts(entries: &[DockerMount]) -> Vec<ContainerMount> {
    entries
        .iter()
        .map(|entry| ContainerMount {
            source: entry.source.clone(),
            destination: entry.destination.clone(),
            rw: entry.rw,
        })
        .collect()
}

fn normalize_timestamp(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(parsed) => rfc3339(parsed.with_timezone(&chrono::Utc)),
        Err(_) => value.to_string(),
    }
}

/// `url.PathEscape`: a container id or name as one path segment, so a
/// name carrying `/` or `?` cannot reach a different endpoint.
fn path_escape(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_'
                    | b'.'
                    | b'~'
                    | b':'
                    | b'@'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b'='
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_records_split_the_timestamp_prefix() {
        let record = container_log_record("container:web", "2024-05-01T10:00:00.123456789Z GET /health 200");
        assert_eq!(record.ts, "2024-05-01T10:00:00Z");
        assert_eq!(record.message, "GET /health 200");
        assert_eq!(record.level, "info");

        let record = container_log_record("container:web", "no timestamp here");
        assert_eq!(record.message, "no timestamp here");
        assert_eq!(record.level, "info");

        let record = container_log_record("container:web", "2024-05-01T10:00:00Z ERROR boom");
        assert_eq!(record.level, "error");
    }

    #[test]
    fn port_specs_and_states_normalise() {
        assert_eq!(split_port_spec("80/tcp"), (80, "tcp"));
        assert_eq!(split_port_spec("53/udp"), (53, "udp"));
        assert_eq!(split_port_spec("8080"), (8080, "tcp"));
        assert_eq!(split_port_spec("x/tcp"), (0, "tcp"));
        assert_eq!(container_state("running"), "running");
        assert_eq!(container_state("weird"), "unknown");
        assert_eq!(container_name(&["/web".to_string()]), "web");
        assert_eq!(container_name(&[]), "");
    }

    #[test]
    fn path_escape_keeps_an_id_in_one_segment() {
        assert_eq!(path_escape("abc123"), "abc123");
        assert_eq!(path_escape("web/../x?y"), "web%2F..%2Fx%3Fy");
        assert_eq!(path_escape("name with space"), "name%20with%20space");
    }

    #[test]
    fn inspect_mapping_reads_ports_and_started_at() {
        let raw = serde_json::json!({
            "Id": "abc",
            "Name": "/web",
            "Created": "2024-05-01T10:00:00.5Z",
            "Image": "sha256:deadbeef",
            "State": {"Status": "running", "StartedAt": "2024-05-01T10:00:01Z"},
            "RestartCount": 2,
            "Config": {"Image": "nginx:latest", "Labels": {"a": "b"}, "Tty": false},
            "HostConfig": {"Memory": 1024},
            "NetworkSettings": {
                "Ports": {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}], "443/tcp": null},
                "Networks": {"bridge": {}}
            },
            "Mounts": [{"Source": "/srv", "Destination": "/data", "RW": true}]
        });
        let parsed: DockerInspect = serde_json::from_value(raw).unwrap();
        let client = DockerClient::new("/nonexistent", cap::DOCKER);
        let info = client.info_from_inspect(&parsed);
        assert_eq!(info.name, "web");
        assert_eq!(info.image, "nginx:latest");
        assert_eq!(info.created_at, "2024-05-01T10:00:00Z");
        assert_eq!(info.started_at.as_deref(), Some("2024-05-01T10:00:01Z"));
        assert_eq!(info.memory_limit, Some(1024));
        assert_eq!(info.restart_count, 2);
        assert_eq!(info.ports.len(), 2);
        assert_eq!(info.ports[0].container_port, 80);
        assert_eq!(info.ports[0].host_port, Some(8080));
        assert_eq!(info.ports[1].container_port, 443);
        assert_eq!(info.ports[1].host_port, None);
        assert_eq!(info.networks, vec!["bridge"]);
        assert_eq!(info.mounts[0].destination, "/data");
        assert_eq!(info.runtime, "docker");

        let never_started: DockerInspect =
            serde_json::from_value(serde_json::json!({"State": {"StartedAt": "0001-01-01T00:00:00Z"}}))
                .unwrap();
        assert!(client.info_from_inspect(&never_started).started_at.is_none());
    }

    #[test]
    fn docker_errors_map_onto_the_provider_sentinels() {
        assert!(matches!(
            docker_error(StatusCode::NOT_FOUND, br#"{"message":"No such container: x"}"#),
            ProviderError::NotFound(m) if m == "No such container: x"
        ));
        assert!(matches!(
            docker_error(StatusCode::CONFLICT, b"busy"),
            ProviderError::Conflict(_)
        ));
        assert!(matches!(
            docker_error(StatusCode::FORBIDDEN, b""),
            ProviderError::PermissionDenied(_)
        ));
        assert!(matches!(
            docker_error(StatusCode::NOT_IMPLEMENTED, b""),
            ProviderError::Unsupported(_)
        ));
        assert!(matches!(
            docker_error(StatusCode::INTERNAL_SERVER_ERROR, b"boom"),
            ProviderError::Exec { output, .. } if output == "boom"
        ));
    }

    /// A fake Engine API on a unix socket: enough HTTP/1.1 to prove the
    /// client dials, frames a request, maps the daemon's errors and reads a
    /// chunked, multiplexed log stream.
    async fn fake_daemon(dir: &std::path::Path) -> String {
        use tokio::io::AsyncBufReadExt;
        let path = dir.join("docker.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let (reader, mut writer) = tokio::io::split(stream);
                    let mut lines = tokio::io::BufReader::new(reader).lines();
                    let request = lines.next_line().await.ok().flatten().unwrap_or_default();
                    let mut saw_host = false;
                    while let Ok(Some(line)) = lines.next_line().await {
                        if line.to_lowercase().starts_with("host:") {
                            saw_host = true;
                        }
                        if line.is_empty() {
                            break;
                        }
                    }
                    assert!(saw_host, "the request carried no Host header: {request}");
                    let target = request.split_whitespace().nth(1).unwrap_or_default().to_string();
                    let response: Vec<u8> = if target == "/v1.40/_ping" {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK".to_vec()
                    } else if target.starts_with("/v1.40/containers/missing/") {
                        let body = br#"{"message":"No such container: missing"}"#;
                        let mut r = format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        r.extend_from_slice(body);
                        r
                    } else if target.starts_with("/v1.40/containers/web/logs") {
                        // Two frames (stdout then stderr) split unevenly across
                        // three chunks, plus a zero-length frame to skip.
                        let mut frames = Vec::new();
                        let a = b"2024-05-01T10:00:00Z hello\n2024-05-01T10:00:01Z world\n";
                        frames.extend_from_slice(&[1, 0, 0, 0]);
                        frames.extend_from_slice(&(a.len() as u32).to_be_bytes());
                        frames.extend_from_slice(a);
                        frames.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 0]);
                        let b = b"2024-05-01T10:00:02Z ERROR boom\n";
                        frames.extend_from_slice(&[2, 0, 0, 0]);
                        frames.extend_from_slice(&(b.len() as u32).to_be_bytes());
                        frames.extend_from_slice(b);
                        let mut r = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
                        for chunk in [&frames[..5], &frames[5..30], &frames[30..]] {
                            r.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                            r.extend_from_slice(chunk);
                            r.extend_from_slice(b"\r\n");
                        }
                        r.extend_from_slice(b"0\r\n\r\n");
                        r
                    } else {
                        b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\n\r\nboom".to_vec()
                    };
                    let _ = writer.write_all(&response).await;
                    let _ = writer.shutdown().await;
                });
            }
        });
        path.display().to_string()
    }

    #[tokio::test]
    async fn the_client_speaks_http_over_the_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket = fake_daemon(dir.path()).await;
        let client = DockerClient::new(&socket, cap::DOCKER);
        let ctx = Ctx::background();

        let body = client
            .call(&ctx, Method::GET, "/_ping", None, true)
            .await
            .unwrap();
        assert_eq!(&body[..], b"OK");

        // The daemon's own error envelope reaches the panel as not_found, not
        // as an opaque failure.
        let err = client.inspect(&ctx, "missing").await.unwrap_err();
        assert!(
            matches!(err, ProviderError::NotFound(ref m) if m == "No such container: missing"),
            "{err:?}"
        );

        let err = client
            .call(&ctx, Method::GET, "/explode", None, true)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::Exec { ref output, .. } if output == "boom"),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn framed_logs_are_demultiplexed_across_chunk_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let socket = fake_daemon(dir.path()).await;
        let client = DockerClient::new(&socket, cap::DOCKER);
        let ctx = Ctx::background();

        let (response, conn) = client
            .open(Method::GET, "/containers/web/logs?stdout=1", None)
            .await
            .unwrap();
        let mut seen: Vec<String> = Vec::new();
        let mut emit = |line: &str| -> BoxedEmit {
            seen.push(line.to_string());
            Box::pin(async { Ok::<(), ProviderError>(()) })
        };
        demultiplex(&ctx, response.into_body(), &mut emit).await.unwrap();
        conn.abort();
        assert_eq!(
            seen,
            vec![
                "2024-05-01T10:00:00Z hello",
                "2024-05-01T10:00:01Z world",
                "2024-05-01T10:00:02Z ERROR boom"
            ]
        );
        let record = container_log_record("container:web", &seen[2]);
        assert_eq!(
            (record.level.as_str(), record.message.as_str()),
            ("error", "ERROR boom")
        );
    }

    #[tokio::test]
    async fn discovery_ignores_a_socket_that_does_not_answer() {
        // No runtime on this machine answers, and a missing or dead socket must
        // never be reported as one.
        let dir = tempfile::tempdir().unwrap();
        let client = DockerClient::new(&dir.path().join("none.sock").display().to_string(), cap::DOCKER);
        let probe = Ctx::new(
            CancellationToken::new(),
            Some(Instant::now() + Duration::from_secs(1)),
        );
        assert!(
            client
                .call(&probe, Method::GET, "/_ping", None, false)
                .await
                .is_err()
        );
    }

    #[test]
    fn since_accepts_the_three_shapes() {
        assert!(parse_since("2024-05-01T10:00:00Z").is_ok());
        assert_eq!(parse_since("1700000000").unwrap().timestamp(), 1700000000);
        assert!(parse_since("-2h").is_ok());
        assert!(parse_since("yesterday-ish").is_err());
    }

    #[test]
    fn the_health_probe_reads_only_a_real_status_line() {
        assert_eq!(
            parse_status_line(b"HTTP/1.1 301 Moved Permanently\r\n"),
            Some(301)
        );
        assert_eq!(parse_status_line(b"HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH_9.6\r\n"), None);
        assert_eq!(parse_status_line(b"HTTP/1.1 999 Nope\r\n"), None);
        assert_eq!(parse_status_line(b""), None);
    }

    #[test]
    fn the_install_filter_names_both_labels() {
        let decoded: String = url::form_urlencoded::parse(format!("f={}", install_filter("abc")).as_bytes())
            .map(|(_, v)| v.into_owned())
            .collect();
        assert!(decoded.contains("io.kaname.managed=true"), "{decoded}");
        assert!(decoded.contains("io.kaname.install=abc"), "{decoded}");
    }

    #[test]
    fn a_task_log_body_is_demultiplexed_whole() {
        let mut raw = vec![1, 0, 0, 0, 0, 0, 0, 6];
        raw.extend_from_slice(b"hello\n");
        raw.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 4]);
        raw.extend_from_slice(b"oops");
        assert_eq!(demultiplex_bytes(&raw), "hello\noops");
    }
}
