//! kaname-agent.v1 — wire frames.
//!
//! One agent-initiated WebSocket carries request/response, streaming chunks
//! in both directions, unsolicited events and heartbeats. These structs
//! mirror `@kaname/contract/agent/protocol.ts` frame for frame and tag for
//! tag; the envelope is versioned so the encoding can change without
//! touching call sites.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::providers::{Encoding, HostInfo, ProviderError, truncate_output};

pub const PROTOCOL_VERSION: u32 = 1;
pub const SUBPROTOCOL: &str = "kaname-agent.v1";

/// The number of unacknowledged chunks a sender may have in flight before
/// it must pause. It is what stops a chatty `journalctl -f` from OOMing the
/// control plane.
pub const STREAM_WINDOW: u64 = 32;
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
pub const PING_INTERVAL: Duration = Duration::from_secs(15);
pub const PING_TIMEOUT_MULTIPLIER: u32 = 3;
/// Deadlines are clamped on both ends, so a timer beyond this would outlive
/// the request it guards.
pub const MAX_DEADLINE: Duration = Duration::from_secs(6 * 60 * 60);
pub const MIN_DEADLINE: Duration = Duration::from_millis(100);

/// Frame tags.
pub mod tag {
    pub const HELLO: &str = "hlo";
    pub const REQUEST: &str = "req";
    pub const RESPONSE: &str = "res";
    pub const CHUNK: &str = "chk";
    pub const ACK: &str = "ack";
    pub const END: &str = "end";
    pub const CANCEL: &str = "can";
    pub const EVENT: &str = "evt";
    pub const PING: &str = "png";
    pub const PONG: &str = "pog";
}

/* -------------------------------- errors ----------------------------- */

/// The machine-readable half of an agent error. The control plane maps
/// these onto HTTP status codes and remediations, so a new code here needs
/// one there too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnknownMethod,
    InvalidParams,
    Unsupported,
    NotFound,
    PermissionDenied,
    Conflict,
    PreconditionFailed,
    Timeout,
    Cancelled,
    IoError,
    ExecFailed,
    Internal,
}

/// The `error` object of a `res` or `end` frame.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

impl WireError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            output: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidParams, message)
    }

    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        let output = truncate_output(output.into());
        if !output.is_empty() {
            self.output = Some(output);
        }
        self
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", serde_json::to_string(&self.code).unwrap_or_default().trim_matches('"'), self.message)
    }
}

impl std::error::Error for WireError {}

/// Maps a provider's failure onto a wire error code. Context outcomes are
/// reported honestly: a deadline is a timeout, a cancel is a cancel,
/// neither is an internal failure.
impl From<ProviderError> for WireError {
    fn from(err: ProviderError) -> Self {
        match err {
            ProviderError::Unsupported(_) => WireError::new(ErrorCode::Unsupported, err.to_string()),
            ProviderError::NotFound(m) => WireError::new(ErrorCode::NotFound, m),
            ProviderError::PermissionDenied(m) => WireError::new(ErrorCode::PermissionDenied, m),
            ProviderError::Conflict(m) => WireError::new(ErrorCode::Conflict, m),
            ProviderError::PreconditionFailed(m) => WireError::new(ErrorCode::PreconditionFailed, m),
            ProviderError::InvalidParams(m) => WireError::new(ErrorCode::InvalidParams, m),
            ProviderError::Exec { op, message, output } => {
                WireError::new(ErrorCode::ExecFailed, format!("{op}: {message}")).with_output(output)
            }
            ProviderError::Io(e) => match e.kind() {
                std::io::ErrorKind::NotFound => WireError::new(ErrorCode::NotFound, e.to_string()),
                std::io::ErrorKind::PermissionDenied => WireError::new(ErrorCode::PermissionDenied, e.to_string()),
                std::io::ErrorKind::AlreadyExists => WireError::new(ErrorCode::Conflict, e.to_string()),
                _ => WireError::new(ErrorCode::IoError, e.to_string()),
            },
            ProviderError::Cancelled => WireError::new(ErrorCode::Cancelled, "the request was cancelled"),
            ProviderError::Timeout => WireError::new(ErrorCode::Timeout, "the request exceeded its deadline"),
            ProviderError::Internal(m) => WireError::new(ErrorCode::Internal, m),
        }
    }
}

/* -------------------------------- frames ----------------------------- */

/// Peeks at a frame's tag before the full decode.
#[derive(Deserialize)]
pub struct Envelope {
    pub t: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HelloFrame {
    pub t: &'static str,
    pub proto: u32,
    pub agent_version: String,
    pub capabilities: Vec<String>,
    pub host: HostInfo,
}

#[derive(Deserialize, Debug)]
pub struct RequestFrame {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub deadline_ms: i64,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Serialize, Debug)]
pub struct ResponseFrame {
    pub t: &'static str,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ChunkFrame {
    pub t: String,
    pub id: String,
    pub seq: u64,
    pub data: String,
    #[serde(default = "default_encoding")]
    pub encoding: Encoding,
}

fn default_encoding() -> Encoding {
    Encoding::Utf8
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AckFrame {
    pub t: String,
    pub id: String,
    pub seq: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EndFrame {
    pub t: String,
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
}

#[derive(Deserialize, Debug)]
pub struct CancelFrame {
    pub id: String,
}

#[derive(Serialize, Debug)]
pub struct EventFrame {
    pub t: &'static str,
    pub topic: &'static str,
    pub ts: String,
    pub data: Value,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PingFrame {
    pub t: String,
    pub ts: i64,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
