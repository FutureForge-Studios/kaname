//! The one error type every command rejects with.
//!
//! It mirrors the panel's own error envelope (`{ error: { code, message,
//! remediation } }`) so the UI renders a panel error and a local one the
//! same way. Local failures use the codes listed in `INTERFACE.md`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// What an operator can do about an error. Same shape as the panel's
/// `remediation` (packages/contract/src/primitives.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remediation {
    pub summary: String,
    #[serde(default)]
    pub actions: Vec<RemediationAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemediationAction {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// A literal the operator should copy (a DNS record, a command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    pub remediation: Option<Box<Remediation>>,
    /// Per-field messages of a panel `validation_failed` error. Omitted
    /// when there are none, so the documented shape is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Box<BTreeMap<String, String>>>,
}

pub type Result<T, E = DesktopError> = std::result::Result<T, E>;

impl DesktopError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
            remediation: None,
            fields: None,
        }
    }

    pub fn with_remediation(mut self, summary: impl Into<String>) -> Self {
        self.remediation = Some(Box::new(Remediation {
            summary: summary.into(),
            actions: Vec::new(),
        }));
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new("network", message)
    }

    pub fn keyring(message: impl Into<String>) -> Self {
        Self::new("keyring", message).with_remediation(
            "Kaname Desktop keeps sign-in tokens and API keys only in the system keychain \
             (Keychain, Credential Manager or a Secret Service such as GNOME Keyring or \
             KWallet). Make sure one is installed and unlocked, then try again.",
        )
    }

    pub fn not_signed_in() -> Self {
        Self::new("not_signed_in", "You are not signed in to this panel.")
            .with_remediation("Sign in to continue.")
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new("storage", message)
    }

    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new("invalid_response", message)
    }

    /// Maps a non-2xx panel response. The panel answers
    /// `{ error: { code, message, remediation?, fields? } }`; anything else
    /// (a proxy's HTML error page, an empty body) still becomes a usable
    /// error keyed on the HTTP status.
    pub fn from_panel(status: u16, body: &[u8]) -> Self {
        #[derive(Deserialize)]
        struct Envelope {
            error: PanelError,
        }
        #[derive(Deserialize)]
        struct PanelError {
            code: String,
            #[serde(default)]
            message: Option<String>,
            #[serde(default)]
            remediation: Option<serde_json::Value>,
            #[serde(default)]
            fields: Option<BTreeMap<String, String>>,
        }

        if let Ok(Envelope { error }) = serde_json::from_slice::<Envelope>(body) {
            if !error.code.is_empty() {
                return Self {
                    message: error
                        .message
                        .filter(|m| !m.is_empty())
                        .unwrap_or_else(|| fallback_message(status).to_string()),
                    code: error.code,
                    status: Some(status),
                    // A remediation the client cannot read is dropped rather
                    // than failing the whole error.
                    remediation: error
                        .remediation
                        .and_then(|r| serde_json::from_value::<Remediation>(r).ok())
                        .map(Box::new),
                    fields: error.fields.filter(|f| !f.is_empty()).map(Box::new),
                };
            }
        }

        Self {
            code: fallback_code(status).to_string(),
            message: fallback_message(status).to_string(),
            status: Some(status),
            remediation: None,
            fields: None,
        }
    }
}

fn fallback_code(status: u16) -> &'static str {
    match status {
        400 => "bad_request",
        401 => "unauthenticated",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        422 => "validation_failed",
        429 => "rate_limited",
        502..=504 => "unavailable",
        _ if status >= 500 => "internal_error",
        _ => "unexpected_response",
    }
}

fn fallback_message(status: u16) -> &'static str {
    match status {
        400 => "The panel rejected the request.",
        401 => "Sign in to continue.",
        403 => "You do not have permission to do that.",
        404 => "The panel has no such resource.",
        409 => "That conflicts with the current state on the panel.",
        429 => "Too many requests. Wait a moment and try again.",
        502..=504 => "The panel is not answering right now.",
        _ if status >= 500 => "Something went wrong on the control plane.",
        _ => "The panel answered with an unexpected response.",
    }
}

impl fmt::Display for DesktopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DesktopError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_panel_error_with_remediation() {
        let body = br#"{"error":{"code":"forbidden","message":"You do not have servers:read.",
            "remediation":{"summary":"Ask an owner.","actions":[{"label":"View roles","href":"/administration/roles"}]},
            "request_id":"req-1"}}"#;
        let err = DesktopError::from_panel(403, body);
        assert_eq!(err.code, "forbidden");
        assert_eq!(err.message, "You do not have servers:read.");
        assert_eq!(err.status, Some(403));
        let r = err.remediation.unwrap();
        assert_eq!(r.summary, "Ask an owner.");
        assert_eq!(r.actions[0].href.as_deref(), Some("/administration/roles"));
        assert_eq!(r.actions[0].action, None);
    }

    #[test]
    fn maps_validation_fields() {
        let body = br#"{"error":{"code":"validation_failed","message":"Invalid request body.","fields":{"email":"Invalid email"}}}"#;
        let err = DesktopError::from_panel(422, body);
        assert_eq!(err.code, "validation_failed");
        assert_eq!(
            err.fields.unwrap().get("email").map(String::as_str),
            Some("Invalid email")
        );
    }

    #[test]
    fn falls_back_on_status_for_non_json_bodies() {
        let err = DesktopError::from_panel(502, b"<html>Bad Gateway</html>");
        assert_eq!(err.code, "unavailable");
        assert_eq!(err.status, Some(502));
        assert!(err.remediation.is_none());

        let err = DesktopError::from_panel(401, b"");
        assert_eq!(err.code, "unauthenticated");
    }

    #[test]
    fn malformed_remediation_is_dropped_not_fatal() {
        let body = br#"{"error":{"code":"conflict","message":"Busy","remediation":"nope"}}"#;
        let err = DesktopError::from_panel(409, body);
        assert_eq!(err.code, "conflict");
        assert!(err.remediation.is_none());
    }

    #[test]
    fn serializes_to_the_documented_shape() {
        let v = serde_json::to_value(DesktopError::not_signed_in()).unwrap();
        assert_eq!(v["code"], "not_signed_in");
        assert!(v["status"].is_null());
        assert_eq!(v["remediation"]["actions"], serde_json::json!([]));
        assert!(v.get("fields").is_none());
    }
}
