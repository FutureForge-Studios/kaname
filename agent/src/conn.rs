//! The multiplexed agent connection.
//!
//! The agent dials out and never listens, so its internet-facing attack
//! surface is nothing at all (KD-002). One socket carries typed
//! request/response, chunk streams in both directions, unsolicited events
//! and heartbeats. Exactly one task owns the socket's write side; everything
//! else hands it frames through a channel.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use async_trait::async_trait;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::CancellationToken;

use crate::providers::{Ctx, Encoding, HostInfo, PResult, ProviderError, Stream};
use crate::registry::{Registry, Request, StreamMode};
use crate::wire::{self, *};

/// How long an inbound chunk may wait for its handler before the whole
/// connection is declared stuck. Dropping the chunk instead would silently
/// corrupt an upload, so a stalled stream fails loudly.
const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// A frame is one chunk plus envelope; twice the chunk cap leaves room for
/// base64 growth and the JSON wrapper.
const READ_LIMIT: usize = 2 * MAX_CHUNK_BYTES;

/// Everything `dial` needs to reach the control plane and identify itself.
pub struct Options {
    pub server_id: String,
    pub control_plane_url: String,
    pub connect_url: String,
    pub tls: Arc<rustls::ClientConfig>,
    /// Proves possession of the enrolled identity when asking for a connect
    /// token. It never leaves the host.
    pub private_key: SigningKey,
    pub agent_version: String,
    pub capabilities: Vec<String>,
    pub host: HostInfo,
    pub registry: Arc<Registry>,
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Inflight {
    cancel: CancellationToken,
    stream: Option<Arc<ConnStream>>,
}

struct Shared {
    out: mpsc::Sender<Message>,
    inflight: Mutex<HashMap<String, Inflight>>,
    /// Trips when the connection dies, for everyone blocked on a window or a
    /// read.
    closed: CancellationToken,
    close_err: Mutex<Option<String>>,
    missed_pongs: AtomicU32,
    handlers: Arc<Mutex<tokio::task::JoinSet<()>>>,
}

impl Shared {
    fn fail(&self, reason: impl Into<String>) {
        if !self.closed.is_cancelled() {
            *self.close_err.lock() = Some(reason.into());
            self.closed.cancel();
        }
    }

    /// Queues a frame for the writer. Returns an error once the connection
    /// is gone, which is how a handler mid-stream learns to stop.
    async fn write<T: Serialize>(&self, frame: &T) -> PResult<()> {
        let raw = serde_json::to_string(frame).map_err(ProviderError::from)?;
        tokio::select! {
            sent = self.out.send(Message::Text(raw.into())) => sent.map_err(|_| ProviderError::internal("agent connection is closed")),
            _ = self.closed.cancelled() => Err(ProviderError::internal("agent connection is closed")),
        }
    }

    fn stream(&self, id: &str) -> Option<Arc<ConnStream>> {
        self.inflight.lock().get(id).and_then(|i| i.stream.clone())
    }
}

pub struct Conn {
    opts: Options,
    ws: Option<WsStream>,
    shared: Arc<Shared>,
    out_rx: Option<mpsc::Receiver<Message>>,
}

/* --------------------------------- dial ------------------------------ */

/// Fetches a short-lived bearer over the TLS-authenticated token endpoint,
/// upgrades the WebSocket with it and announces the host.
pub async fn dial(opts: Options) -> anyhow::Result<Conn> {
    let client = reqwest::Client::builder()
        .use_preconfigured_tls((*opts.tls).clone())
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .build()
        .context("build http client")?;

    let token = fetch_token(&client, &opts).await?;

    let mut request = tungstenite::client::IntoClientRequest::into_client_request(opts.connect_url.as_str())
        .with_context(|| format!("connect url {}", opts.connect_url))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .context("authorization header")?,
    );
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        SUBPROTOCOL.parse().context("subprotocol header")?,
    );

    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(READ_LIMIT))
        .max_frame_size(Some(READ_LIMIT));
    let connector = tokio_tungstenite::Connector::Rustls(opts.tls.clone());
    let (ws, response) =
        tokio_tungstenite::connect_async_tls_with_config(request, Some(config), true, Some(connector))
            .await
            .map_err(|e| match &e {
                tungstenite::Error::Http(resp) => {
                    anyhow::anyhow!("connect {}: http {}", opts.connect_url, resp.status())
                }
                _ => anyhow::anyhow!("connect {}: {e}", opts.connect_url),
            })?;
    if let Some(proto) = response.headers().get("Sec-WebSocket-Protocol") {
        if proto.to_str().unwrap_or_default() != SUBPROTOCOL {
            bail!("control plane negotiated subprotocol {proto:?}, wanted {SUBPROTOCOL}");
        }
    }

    let (out_tx, out_rx) = mpsc::channel(256);
    let shared = Arc::new(Shared {
        out: out_tx,
        inflight: Mutex::new(HashMap::new()),
        closed: CancellationToken::new(),
        close_err: Mutex::new(None),
        missed_pongs: AtomicU32::new(0),
        handlers: Arc::new(Mutex::new(tokio::task::JoinSet::new())),
    });

    let mut conn = Conn {
        opts,
        ws: Some(ws),
        shared,
        out_rx: Some(out_rx),
    };

    // Written directly: the writer task only starts in `serve`, so there is
    // no second owner of the socket yet.
    let hello = HelloFrame {
        t: tag::HELLO,
        proto: PROTOCOL_VERSION,
        agent_version: conn.opts.agent_version.clone(),
        capabilities: conn.opts.capabilities.clone(),
        host: conn.opts.host.clone(),
    };
    let raw = serde_json::to_string(&hello).context("marshal hello")?;
    conn.ws
        .as_mut()
        .expect("socket")
        .send(Message::Text(raw.into()))
        .await
        .context("send hello")?;
    Ok(conn)
}

/* --------------------------------- serve ----------------------------- */

impl Conn {
    /// A handle for pushing events and closing from outside `serve`.
    pub fn handle(&self) -> ConnHandle {
        ConnHandle {
            shared: self.shared.clone(),
        }
    }

    /// Runs the connection until the socket dies or `stop` is cancelled.
    pub async fn serve(mut self, stop: CancellationToken) -> anyhow::Result<()> {
        let ws = self.ws.take().expect("serve called twice");
        let mut out_rx = self.out_rx.take().expect("serve called twice");
        let (mut sink, mut source) = ws.split();
        let shared = self.shared.clone();

        // Writer: the one owner of the socket's write side.
        let writer_shared = shared.clone();
        let writer = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = writer_shared.closed.cancelled() => break,
                    frame = out_rx.recv() => match frame {
                        Some(frame) => {
                            if let Err(e) = sink.send(frame).await {
                                writer_shared.fail(format!("write: {e}"));
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
            let _ = sink.close().await;
        });

        // Heartbeat.
        let ping_shared = shared.clone();
        let pinger = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(PING_INTERVAL);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = ping_shared.closed.cancelled() => break,
                    _ = ticker.tick() => {
                        if ping_shared.missed_pongs.load(Ordering::Relaxed) >= PING_TIMEOUT_MULTIPLIER {
                            ping_shared.fail("control plane missed heartbeats");
                            break;
                        }
                        ping_shared.missed_pongs.fetch_add(1, Ordering::Relaxed);
                        let ping = PingFrame { t: tag::PING.into(), ts: chrono::Utc::now().timestamp_millis() };
                        if ping_shared.write(&ping).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Reader, on this task.
        let serve_ctx = CancellationToken::new();
        let outcome: anyhow::Result<()> = loop {
            tokio::select! {
                _ = stop.cancelled() => {
                    // Only a shutdown deserves a clean close frame; a dead socket is already gone.
                    let _ = shared.out.send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                        code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                        reason: "agent shutting down".into(),
                    }))).await;
                    break Ok(());
                }
                _ = shared.closed.cancelled() => {
                    break Err(anyhow::anyhow!(shared.close_err.lock().clone().unwrap_or_else(|| "connection closed".into())));
                }
                frame = source.next() => match frame {
                    Some(Ok(Message::Text(text))) => self.route(&serve_ctx, text.as_str()).await,
                    Some(Ok(Message::Close(_))) | None => break Err(anyhow::anyhow!("control plane closed the socket")),
                    Some(Ok(_)) => tracing::debug!("ignoring non-text frame"),
                    Some(Err(e)) => break Err(anyhow::anyhow!("read: {e}")),
                }
            }
        };

        // Shutdown: cancel every in-flight call, close their streams, give
        // the handlers a moment to settle, then let the writer drain.
        serve_ctx.cancel();
        let inflight: Vec<Inflight> = shared.inflight.lock().drain().map(|(_, v)| v).collect();
        for call in inflight {
            call.cancel.cancel();
            if let Some(s) = call.stream {
                s.close_input();
            }
        }
        let handlers = shared.handlers.clone();
        let settled = tokio::time::timeout(SHUTDOWN_GRACE, async move {
            loop {
                let next = { handlers.lock().try_join_next() };
                match next {
                    Some(_) => continue,
                    None => {
                        let empty = handlers.lock().is_empty();
                        if empty {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        })
        .await;
        if settled.is_err() {
            tracing::warn!("handlers did not stop within the shutdown grace period");
        }
        shared.fail("closed");
        let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
        pinger.abort();
        outcome
    }

    async fn route(&self, serve_ctx: &CancellationToken, raw: &str) {
        let Ok(env) = serde_json::from_str::<Envelope>(raw) else {
            tracing::warn!("malformed frame from control plane");
            return;
        };
        let shared = &self.shared;
        match env.t.as_str() {
            tag::REQUEST => self.handle_request(serve_ctx, raw).await,
            tag::CANCEL => {
                if let Ok(frame) = serde_json::from_str::<CancelFrame>(raw) {
                    if let Some(call) = shared.inflight.lock().get(&frame.id) {
                        call.cancel.cancel();
                    }
                }
            }
            tag::CHUNK => {
                if let Ok(frame) = serde_json::from_str::<ChunkFrame>(raw) {
                    if let Some(s) = shared.stream(&frame.id) {
                        s.deliver(frame).await;
                    }
                }
            }
            tag::ACK => {
                if let Ok(frame) = serde_json::from_str::<AckFrame>(raw) {
                    if let Some(s) = shared.stream(&frame.id) {
                        s.acknowledge(frame.seq);
                    }
                }
            }
            tag::END => {
                if let Ok(frame) = serde_json::from_str::<EndFrame>(raw) {
                    if let Some(s) = shared.stream(&frame.id) {
                        s.close_input();
                    }
                }
            }
            tag::PING => {
                if let Ok(frame) = serde_json::from_str::<PingFrame>(raw) {
                    let _ = shared
                        .write(&PingFrame {
                            t: tag::PONG.into(),
                            ts: frame.ts,
                        })
                        .await;
                }
            }
            tag::PONG => shared.missed_pongs.store(0, Ordering::Relaxed),
            other => tracing::debug!(t = other, "ignoring unknown frame"),
        }
    }

    async fn handle_request(&self, serve_ctx: &CancellationToken, raw: &str) {
        let shared = self.shared.clone();
        let frame: RequestFrame = match serde_json::from_str(raw) {
            Ok(f) => f,
            Err(_) => {
                tracing::warn!("malformed request frame");
                return;
            }
        };
        if frame.id.is_empty() {
            tracing::warn!(method = frame.method, "request without an id");
            return;
        }

        let method = match self.opts.registry.resolve(&frame.method) {
            Ok(m) => m.clone(),
            Err(err) => {
                finish(&shared, &frame.id, StreamMode::None, Err(err)).await;
                return;
            }
        };

        // Deadlines are mandatory: an RPC with no bound is a leak waiting
        // for a host that has gone away.
        if frame.deadline_ms <= 0 {
            finish(
                &shared,
                &frame.id,
                method.mode,
                Err(WireError::invalid("deadline_ms is required")),
            )
            .await;
            return;
        }
        let deadline = Duration::from_millis(frame.deadline_ms as u64).clamp(MIN_DEADLINE, MAX_DEADLINE);

        let cancel = serve_ctx.child_token();
        let stream = (method.mode != StreamMode::None)
            .then(|| Arc::new(ConnStream::new(frame.id.clone(), shared.clone())));
        // Decided under the lock, acted on after it: a guard that reached the
        // await below would hold every other request's dispatch hostage.
        let registered = {
            let mut inflight = shared.inflight.lock();
            if inflight.contains_key(&frame.id) {
                false
            } else {
                inflight.insert(
                    frame.id.clone(),
                    Inflight {
                        cancel: cancel.clone(),
                        stream: stream.clone(),
                    },
                );
                true
            }
        };
        if !registered {
            finish(
                &shared,
                &frame.id,
                method.mode,
                Err(WireError::new(
                    ErrorCode::Conflict,
                    format!("request id {} is already in flight", frame.id),
                )),
            )
            .await;
            return;
        }

        let ctx = Ctx::new(cancel.clone(), Some(Instant::now() + deadline));
        let req = Request {
            id: frame.id.clone(),
            method: frame.method.clone(),
            params: frame.params,
            stream: stream.clone().map(|s| s as crate::providers::StreamRef),
        };
        let id = frame.id.clone();
        let mode = method.mode;
        let handler = method.handler.clone();
        let handlers = shared.handlers.clone();
        handlers.lock().spawn(async move {
            let result = tokio::select! {
                out = handler(ctx.clone(), req) => out,
                _ = ctx.done() => Err(WireError::from(ctx.error())),
            };
            shared.inflight.lock().remove(&id);
            if let Some(s) = &stream {
                s.close_input();
            }
            finish(&shared, &id, mode, result).await;
        });
    }
}

/// Settles one request. A streaming method also gets an end frame: the res
/// carries the value the method declares, the end closes the chunk stream.
async fn finish(shared: &Shared, id: &str, mode: StreamMode, result: Result<Value, WireError>) {
    match result {
        Ok(value) => {
            let _ = shared
                .write(&ResponseFrame {
                    t: tag::RESPONSE,
                    id: id.into(),
                    ok: true,
                    result: Some(value),
                    error: None,
                })
                .await;
            if mode != StreamMode::None {
                let _ = shared
                    .write(&EndFrame {
                        t: tag::END.into(),
                        id: id.into(),
                        ok: true,
                        error: None,
                    })
                    .await;
            }
        }
        Err(err) => {
            let _ = shared
                .write(&ResponseFrame {
                    t: tag::RESPONSE,
                    id: id.into(),
                    ok: false,
                    result: None,
                    error: Some(err.clone()),
                })
                .await;
            if mode != StreamMode::None {
                let _ = shared
                    .write(&EndFrame {
                        t: tag::END.into(),
                        id: id.into(),
                        ok: false,
                        error: Some(err),
                    })
                    .await;
            }
        }
    }
}

/// Pushes events and reports liveness from outside `serve`.
#[derive(Clone)]
pub struct ConnHandle {
    shared: Arc<Shared>,
}

impl ConnHandle {
    /// Pushes an unsolicited event: metrics, state changes, threats.
    pub async fn emit(&self, topic: &'static str, data: Value) -> PResult<()> {
        self.shared
            .write(&EventFrame {
                t: tag::EVENT,
                topic,
                ts: wire::now_rfc3339(),
                data,
            })
            .await
    }

    pub fn closed(&self) -> CancellationToken {
        self.shared.closed.clone()
    }
}

/* -------------------------------- streams ---------------------------- */

/// One request's chunk traffic. Outbound chunks respect the contract's
/// 32-chunk window; inbound chunks are acknowledged every half window,
/// which is what the control plane's sender waits on.
pub struct ConnStream {
    id: String,
    shared: Arc<Shared>,
    next: AtomicU64,
    acked: AtomicU64,
    ack_signal: Notify,
    inbox: Mutex<std::collections::VecDeque<Vec<u8>>>,
    inbox_signal: Notify,
    received: AtomicU64,
    in_closed: CancellationToken,
}

impl ConnStream {
    fn new(id: String, shared: Arc<Shared>) -> Self {
        Self {
            id,
            shared,
            next: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            ack_signal: Notify::new(),
            inbox: Mutex::new(std::collections::VecDeque::new()),
            inbox_signal: Notify::new(),
            received: AtomicU64::new(0),
            in_closed: CancellationToken::new(),
        }
    }

    async fn emit(&self, payload: String, enc: Encoding) -> PResult<()> {
        self.await_window().await?;
        let seq = self.next.fetch_add(1, Ordering::SeqCst);
        self.shared
            .write(&ChunkFrame {
                t: tag::CHUNK.into(),
                id: self.id.clone(),
                seq,
                data: payload,
                encoding: enc,
            })
            .await
    }

    async fn await_window(&self) -> PResult<()> {
        loop {
            let in_flight = self.next.load(Ordering::SeqCst) - self.acked.load(Ordering::SeqCst);
            if in_flight < STREAM_WINDOW {
                return Ok(());
            }
            tokio::select! {
                _ = self.ack_signal.notified() => {}
                _ = self.shared.closed.cancelled() => return Err(ProviderError::internal("agent connection is closed")),
            }
        }
    }

    fn acknowledge(&self, seq: u64) {
        // An ack for seq N means everything through N arrived, and acks can
        // arrive out of order, so the count only ever moves forward.
        self.acked.fetch_max(seq + 1, Ordering::SeqCst);
        self.ack_signal.notify_waiters();
    }

    async fn deliver(&self, frame: ChunkFrame) {
        let data = match frame.encoding {
            Encoding::Base64 => match base64::engine::general_purpose::STANDARD.decode(&frame.data) {
                Ok(d) => d,
                Err(_) => {
                    tracing::warn!(id = self.id, seq = frame.seq, "undecodable chunk");
                    return;
                }
            },
            Encoding::Utf8 => frame.data.into_bytes(),
        };

        // Backpressure: hold the socket's reader until the handler has taken
        // the window's worth of chunks it already has, and declare the whole
        // connection stuck rather than drop bytes.
        let deadline = Instant::now() + STREAM_STALL_TIMEOUT;
        loop {
            if self.in_closed.is_cancelled() || self.shared.closed.is_cancelled() {
                return;
            }
            let len = self.inbox.lock().len() as u64;
            if len < STREAM_WINDOW {
                break;
            }
            tokio::select! {
                _ = self.inbox_signal.notified() => {}
                _ = tokio::time::sleep_until(deadline.into()) => {
                    self.shared.fail(format!("stream {} stalled with a full window", self.id));
                    return;
                }
                _ = self.in_closed.cancelled() => return,
            }
        }
        self.inbox.lock().push_back(data);
        self.inbox_signal.notify_waiters();

        let received = self.received.fetch_add(1, Ordering::SeqCst) + 1;
        if received % (STREAM_WINDOW / 2) == 0 {
            let _ = self
                .shared
                .write(&AckFrame {
                    t: tag::ACK.into(),
                    id: self.id.clone(),
                    seq: frame.seq,
                })
                .await;
        }
    }

    fn close_input(&self) {
        self.in_closed.cancel();
        self.inbox_signal.notify_waiters();
    }
}

#[async_trait]
impl Stream for ConnStream {
    /// Writes data to the control plane, splitting it into chunks that fit
    /// the frame cap and pausing when the window is full.
    async fn send(&self, data: &[u8], enc: Encoding) -> PResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        match enc {
            Encoding::Base64 => {
                // 3 raw bytes become 4 encoded ones; stay under the frame cap.
                const RAW: usize = MAX_CHUNK_BYTES / 4 * 3;
                for piece in data.chunks(RAW) {
                    self.emit(
                        base64::engine::general_purpose::STANDARD.encode(piece),
                        Encoding::Base64,
                    )
                    .await?;
                }
                Ok(())
            }
            Encoding::Utf8 => {
                let mut rest = data;
                while !rest.is_empty() {
                    let n = if rest.len() > MAX_CHUNK_BYTES {
                        rune_boundary(rest, MAX_CHUNK_BYTES)
                    } else {
                        rest.len()
                    };
                    let piece = String::from_utf8_lossy(&rest[..n]).into_owned();
                    self.emit(piece, Encoding::Utf8).await?;
                    rest = &rest[n..];
                }
                Ok(())
            }
        }
    }

    /// Reads the next inbound chunk; `None` once the control plane has
    /// closed its side.
    async fn recv(&self) -> PResult<Option<Vec<u8>>> {
        loop {
            if let Some(data) = self.inbox.lock().pop_front() {
                self.inbox_signal.notify_waiters();
                return Ok(Some(data));
            }
            if self.in_closed.is_cancelled() {
                return Ok(None);
            }
            if self.shared.closed.is_cancelled() {
                return Err(ProviderError::internal("agent connection is closed"));
            }
            tokio::select! {
                _ = self.inbox_signal.notified() => {}
                _ = self.in_closed.cancelled() => {}
                _ = self.shared.closed.cancelled() => {}
            }
        }
    }
}

/// Backs a split point up to the start of a character so a chunk never
/// carries half a code point into JSON.
fn rune_boundary(data: &[u8], limit: usize) -> usize {
    let mut n = limit;
    while n > 0 && (data[n] & 0b1100_0000) == 0b1000_0000 {
        n -= 1;
    }
    if n == 0 { limit } else { n }
}

/* --------------------------------- token ----------------------------- */

#[derive(Serialize)]
struct TokenRequest<'a> {
    server_id: &'a str,
    nonce: String,
    timestamp: i64,
    signature: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
    #[allow(dead_code)]
    expires_at: Option<String>,
}

/// Proves possession of the enrolled private key and exchanges that proof
/// for a five-minute bearer. A revoked certificate therefore fails within
/// one token lifetime, with no CRL round-trip.
async fn fetch_token(client: &reqwest::Client, opts: &Options) -> anyhow::Result<String> {
    let mut nonce_bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce_bytes);
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce_bytes);
    let timestamp = chrono::Utc::now().timestamp_millis();

    let signature = sign_challenge(
        &opts.private_key,
        &format!("{}|{nonce}|{timestamp}", opts.server_id),
    );
    let endpoint = join_url(&opts.control_plane_url, "/agent/v1/token")?;

    let response = client
        .post(&endpoint)
        .json(&TokenRequest {
            server_id: &opts.server_id,
            nonce,
            timestamp,
            signature,
        })
        .send()
        .await
        .context("request connect token")?;
    let status = response.status();
    let payload = response.bytes().await.context("read token response")?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&payload);
        bail!(
            "connect token rejected (http {}): {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        );
    }
    let parsed: TokenResponse = serde_json::from_slice(&payload).context("decode token response")?;
    if parsed.token.is_empty() {
        bail!("control plane returned an empty connect token");
    }
    Ok(parsed.token)
}

/// A raw r||s P-256 signature over SHA-256 of the message. WebCrypto, which
/// is what verifies it, rejects the ASN.1 form.
pub fn sign_challenge(key: &SigningKey, message: &str) -> String {
    let signature: p256::ecdsa::Signature = key.sign(message.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

pub fn join_url(base: &str, path: &str) -> anyhow::Result<String> {
    let base = base.trim_end_matches('/');
    let parsed =
        url::Url::parse(&format!("{base}{path}")).with_context(|| format!("build url {base}{path}"))?;
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;

    #[test]
    fn challenge_signature_is_raw_64_bytes_and_verifies() {
        let key = SigningKey::random(&mut rand::thread_rng());
        let sig = sign_challenge(&key, "server|nonce|123");
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(sig)
            .unwrap();
        assert_eq!(raw.len(), 64);
        let parsed = p256::ecdsa::Signature::from_slice(&raw).unwrap();
        key.verifying_key().verify(b"server|nonce|123", &parsed).unwrap();
    }

    #[test]
    fn rune_boundary_never_splits_a_code_point() {
        let s = "aé".repeat(100);
        let b = s.as_bytes();
        let n = rune_boundary(b, 7);
        assert!(std::str::from_utf8(&b[..n]).is_ok());
    }

    #[test]
    fn urls_join_without_double_slashes() {
        assert_eq!(
            join_url("https://panel.example/", "/agent/v1/token").unwrap(),
            "https://panel.example/agent/v1/token"
        );
    }
}
