//! Shared helpers for the real provider: the parts that decide whether a
//! path is safe, what a line means or how a time is spelled, kept free of
//! syscalls so they are proved by plain unit tests.

use chrono::{DateTime, Utc};

use crate::providers::ProviderError;

pub fn rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn now_rfc3339() -> String {
    rfc3339(Utc::now())
}

/// Seconds since the epoch as RFC 3339, the spelling every payload uses.
pub fn epoch_rfc3339(secs: i64) -> String {
    DateTime::<Utc>::from_timestamp(secs, 0)
        .map(rfc3339)
        .unwrap_or_default()
}

pub fn not_found(what: impl std::fmt::Display) -> ProviderError {
    ProviderError::NotFound(what.to_string())
}

pub fn invalid(what: impl std::fmt::Display) -> ProviderError {
    ProviderError::InvalidParams(what.to_string())
}

pub fn unsupported(what: impl std::fmt::Display) -> ProviderError {
    ProviderError::unsupported_because(what.to_string())
}

pub fn precondition(what: impl std::fmt::Display) -> ProviderError {
    ProviderError::PreconditionFailed(what.to_string())
}

pub fn conflict(what: impl std::fmt::Display) -> ProviderError {
    ProviderError::Conflict(what.to_string())
}

/// Lines of a command's output without the trailing newline, or nothing
/// for empty output.
pub fn split_lines(s: &str) -> Vec<&str> {
    let trimmed = s.trim_end_matches('\n');
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed.split('\n').collect()
}

/// `KEY=value` pairs, as `systemctl show` and `/etc/os-release` print them,
/// with surrounding quotes removed.
pub fn parse_kv(s: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for line in s.lines() {
        if let Some((k, v)) = line.trim().split_once('=') {
            out.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    out
}

/// `ErrorKind::NotFound`, kept in one place so callers read the same way.
pub fn is_not_exist(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_drops_only_the_trailing_newline() {
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\n\nb"), vec!["a", "", "b"]);
    }

    #[test]
    fn parse_kv_strips_quotes() {
        let kv = parse_kv("ID=\"debian\"\nVERSION_ID=12\n");
        assert_eq!(kv["ID"], "debian");
        assert_eq!(kv["VERSION_ID"], "12");
    }
}
