//! Terminal tabs: one WebSocket per tab to the panel's
//! `/api/v1/terminal/:ticket`, owned by a task that forwards output to
//! the frontend's channel and takes input, resizes and close requests
//! from the commands.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::Connector;
use url::Url;
use zeroize::Zeroizing;

use crate::error::{DesktopError, Result};
use crate::http::{API_PREFIX, USER_AGENT};
use crate::tls;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const COMMAND_QUEUE: usize = 1024;
/// Largest single input write accepted from the frontend.
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalEvent {
    Data { b64: String },
    Closed { code: Option<u16>, reason: String },
    Error { message: String },
}

/// Where a terminal's events go: the Tauri channel in the app, a
/// collector in tests. Returns false once nobody is listening.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: TerminalEvent) -> bool;
}

impl EventSink for tauri::ipc::Channel<TerminalEvent> {
    fn emit(&self, event: TerminalEvent) -> bool {
        self.send(event).is_ok()
    }
}

enum Command {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct Handle {
    connection_id: String,
    tx: mpsc::Sender<Command>,
}

#[derive(Default, Clone)]
pub struct Terminals {
    map: Arc<Mutex<HashMap<String, Handle>>>,
}

pub struct Dial<'a> {
    pub connection_id: &'a str,
    pub url: Url,
    /// `name=value` session cookie. The ticket is the credential for the
    /// socket; the cookie rides along in case a proxy in front wants it.
    pub cookie: Option<&'a str>,
    pub origin: &'a str,
    pub tls: Arc<rustls::ClientConfig>,
}

impl Terminals {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Handle>> {
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Opens the socket and starts its task. Returns the local terminal id.
    pub async fn dial(&self, dial: Dial<'_>, sink: Arc<dyn EventSink>) -> Result<String> {
        let mut req =
            dial.url.as_str().into_client_request().map_err(|e| {
                DesktopError::invalid_response(format!("Bad terminal address: {e}"))
            })?;
        {
            let h = req.headers_mut();
            h.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
            if let Ok(v) = HeaderValue::from_str(dial.origin) {
                h.insert("Origin", v);
            }
            if let Some(c) = dial.cookie {
                if let Ok(mut v) = HeaderValue::from_str(c) {
                    v.set_sensitive(true);
                    h.insert("Cookie", v);
                }
            }
        }
        let connector = if dial.url.scheme() == "wss" {
            Connector::Rustls(dial.tls)
        } else {
            Connector::Plain
        };

        let (ws, _resp) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async_tls_with_config(req, None, false, Some(connector)),
        )
        .await
        .map_err(|_| DesktopError::network("The terminal connection timed out."))?
        .map_err(ws_error)?;

        let terminal_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel(COMMAND_QUEUE);
        self.lock().insert(
            terminal_id.clone(),
            Handle {
                connection_id: dial.connection_id.to_string(),
                tx,
            },
        );

        let map = self.clone();
        let id = terminal_id.clone();
        tokio::spawn(async move {
            run(ws, rx, sink).await;
            map.lock().remove(&id);
        });
        Ok(terminal_id)
    }

    fn sender(&self, terminal_id: &str) -> Result<mpsc::Sender<Command>> {
        self.lock()
            .get(terminal_id)
            .map(|h| h.tx.clone())
            .ok_or_else(|| DesktopError::not_found("That terminal is closed."))
    }

    pub async fn write(&self, terminal_id: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(DesktopError::invalid_input("That input is too large."));
        }
        self.sender(terminal_id)?
            .send(Command::Input(bytes))
            .await
            .map_err(|_| DesktopError::not_found("That terminal is closed."))
    }

    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        validate_size(cols, rows)?;
        self.sender(terminal_id)?
            .send(Command::Resize { cols, rows })
            .await
            .map_err(|_| DesktopError::not_found("That terminal is closed."))
    }

    /// Idempotent: closing a terminal that is already gone succeeds.
    pub async fn close(&self, terminal_id: &str) {
        if let Ok(tx) = self.sender(terminal_id) {
            let _ = tx.send(Command::Close).await;
        }
    }

    /// Closes every terminal opened through one connection.
    pub fn close_connection(&self, connection_id: &str) {
        for h in self.lock().values() {
            if h.connection_id == connection_id {
                // try_send: a full queue means the task is busy; it will
                // still see the channel drop when the app exits.
                let _ = h.tx.try_send(Command::Close);
            }
        }
    }

    pub fn count(&self) -> usize {
        self.lock().len()
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<()> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(DesktopError::invalid_input(
            "Terminal size must be between 1 and 1000 columns and rows.",
        ));
    }
    Ok(())
}

async fn run<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    mut rx: mpsc::Receiver<Command>,
    sink: Arc<dyn EventSink>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let (mut write, mut read) = ws.split();
    let b64 = base64::engine::general_purpose::STANDARD;

    let closed: (Option<u16>, String) = loop {
        tokio::select! {
            msg = read.next() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if !sink.emit(TerminalEvent::Data { b64: b64.encode(&b) }) {
                        // The tab is gone; hang up politely.
                        let _ = write.send(close_message()).await;
                        return;
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if !sink.emit(TerminalEvent::Data { b64: b64.encode(t.as_bytes()) }) {
                        let _ = write.send(close_message()).await;
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    break match frame {
                        Some(f) => (Some(u16::from(f.code)), f.reason.to_string()),
                        None => (None, "connection closed".to_string()),
                    };
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    sink.emit(TerminalEvent::Error { message: ws_error(e).message });
                    break (None, "connection lost".to_string());
                }
                None => break (None, "connection closed".to_string()),
            },
            cmd = rx.recv() => match cmd {
                Some(Command::Input(bytes)) => {
                    if let Err(e) = write.send(Message::binary(bytes)).await {
                        sink.emit(TerminalEvent::Error { message: ws_error(e).message });
                        break (None, "connection lost".to_string());
                    }
                }
                Some(Command::Resize { cols, rows }) => {
                    let text = serde_json::json!({ "t": "resize", "cols": cols, "rows": rows }).to_string();
                    if let Err(e) = write.send(Message::text(text)).await {
                        sink.emit(TerminalEvent::Error { message: ws_error(e).message });
                        break (None, "connection lost".to_string());
                    }
                }
                Some(Command::Close) | None => {
                    let _ = write.send(close_message()).await;
                    // Give the panel a moment to answer the close handshake.
                    let _ = tokio::time::timeout(CLOSE_GRACE, async {
                        while let Some(Ok(m)) = read.next().await {
                            if matches!(m, Message::Close(_)) { break; }
                        }
                    }).await;
                    break (Some(1000), "pane closed".to_string());
                }
            },
        }
    };

    sink.emit(TerminalEvent::Closed {
        code: closed.0,
        reason: closed.1,
    });
}

fn close_message() -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::Normal,
        reason: "pane closed".into(),
    }))
}

fn ws_error(e: tungstenite::Error) -> DesktopError {
    match e {
        tungstenite::Error::Http(resp) => {
            let status = resp.status().as_u16();
            let body = resp.body().clone().unwrap_or_default();
            DesktopError::from_panel(status, &body)
        }
        tungstenite::Error::Tls(t) => {
            if let Some(r) = tls::find_tls_error(&t) {
                tls::tls_error(r)
            } else {
                DesktopError::new("tls", format!("Secure connection failed: {t}"))
            }
        }
        tungstenite::Error::Io(io) => {
            if let Some(r) = tls::find_tls_error(&io) {
                tls::tls_error(r)
            } else {
                DesktopError::network(format!("The terminal connection failed: {io}"))
            }
        }
        other => DesktopError::network(format!("The terminal connection failed: {other}")),
    }
}

/// Puts the panel's `ws_url` onto the connection's own origin.
///
/// The panel builds `ws_url` from its configured public URL, which may be
/// an address only reachable from inside its network. The desktop keeps
/// the path and query (`/api/v1/terminal/<ticket>?cols=&rows=`) and dials
/// the origin it already talks to, with `http→ws` and `https→wss`. If the
/// panel's URL is unusable, the path is rebuilt from the ticket.
pub fn rebase_ws_url(base: &Url, ws_url: &str, ticket: &str, cols: u16, rows: u16) -> Result<Url> {
    let terminal_prefix = format!("{API_PREFIX}/terminal/");
    let from_panel = Url::parse(ws_url).ok().filter(|u| {
        u.path()
            .strip_prefix(&terminal_prefix)
            .is_some_and(is_ticket)
    });

    let mut url = base.clone();
    let scheme = match base.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => {
            return Err(DesktopError::invalid_input(format!(
                "Cannot open a terminal over {other}."
            )))
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| DesktopError::invalid_input("Cannot build the terminal address."))?;
    url.set_fragment(None);

    match from_panel {
        Some(p) => {
            url.set_path(p.path());
            url.set_query(p.query());
        }
        None => {
            if !is_ticket(ticket) {
                return Err(DesktopError::invalid_response(
                    "The panel returned an unusable terminal ticket.",
                ));
            }
            url.set_path(&format!("{terminal_prefix}{ticket}"));
            url.set_query(None);
            url.query_pairs_mut()
                .append_pair("cols", &cols.to_string())
                .append_pair("rows", &rows.to_string());
        }
    }
    Ok(url)
}

fn is_ticket(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Decodes a `terminal_write` payload.
pub fn decode_input(b64: &str) -> Result<Zeroizing<Vec<u8>>> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map(Zeroizing::new)
        .map_err(|_| DesktopError::invalid_input("Terminal input must be base64."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebases_onto_the_connection_origin() {
        let base = Url::parse("https://panel.example.com").unwrap();
        let url = rebase_ws_url(
            &base,
            "ws://10.0.0.5:4000/api/v1/terminal/kn_tty_abc123?cols=80&rows=24",
            "kn_tty_abc123",
            80,
            24,
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "wss://panel.example.com/api/v1/terminal/kn_tty_abc123?cols=80&rows=24"
        );

        let base = Url::parse("http://203.0.113.9:8080").unwrap();
        let url = rebase_ws_url(
            &base,
            "wss://panel.internal/api/v1/terminal/kn_tty_x?cols=120&rows=40",
            "kn_tty_x",
            120,
            40,
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "ws://203.0.113.9:8080/api/v1/terminal/kn_tty_x?cols=120&rows=40"
        );
    }

    #[test]
    fn rebuilds_from_ticket_when_ws_url_is_unusable() {
        let base = Url::parse("https://panel.example.com").unwrap();
        for ws in [
            "not a url",
            "wss://x/elsewhere/kn_tty_t",
            "wss://x/api/v1/terminal/../auth",
        ] {
            let url = rebase_ws_url(&base, ws, "kn_tty_t", 100, 30).unwrap();
            assert_eq!(
                url.as_str(),
                "wss://panel.example.com/api/v1/terminal/kn_tty_t?cols=100&rows=30",
                "{ws}"
            );
        }
        assert!(rebase_ws_url(&base, "nope", "../bad", 80, 24).is_err());
    }

    #[test]
    fn events_serialize_as_documented() {
        let v = serde_json::to_value(TerminalEvent::Data { b64: "aGk=".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "data", "b64": "aGk=" }));
        let v = serde_json::to_value(TerminalEvent::Closed {
            code: Some(4401),
            reason: "unknown ticket".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "kind": "closed", "code": 4401, "reason": "unknown ticket" })
        );
        let v = serde_json::to_value(TerminalEvent::Error {
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "error", "message": "x" }));
    }

    #[test]
    fn sizes_and_input() {
        assert!(validate_size(80, 24).is_ok());
        assert!(validate_size(0, 24).is_err());
        assert!(validate_size(80, 1001).is_err());
        assert_eq!(decode_input("aGk=").unwrap().as_slice(), b"hi");
        assert!(decode_input("***").is_err());
    }
}
