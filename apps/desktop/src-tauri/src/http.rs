//! Talking to a panel's `/api/v1`, the way the browser does.
//!
//! No cookie jar: the session cookie is read out of `Set-Cookie` by hand,
//! kept in the keyring and sent back as a `Cookie` header, so exactly one
//! cookie ever leaves this process and only to the panel that set it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, COOKIE, SET_COOKIE};
use reqwest::{redirect, Method};
use serde_json::{Map, Value};
use url::Url;
use zeroize::Zeroizing;

use crate::error::{DesktopError, Result};
use crate::tls;

pub const API_PREFIX: &str = "/api/v1";
pub const USER_AGENT: &str = concat!("KanameDesktop/", env!("CARGO_PKG_VERSION"));
/// The panel's default cookie name and its `__Host-` twin (KD: the name
/// follows how the request arrived; see control-plane http/plugin.ts).
pub const SESSION_COOKIE_NAMES: [&str; 2] = ["__Host-kaname_session", "kaname_session"];

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// How a request authenticates.
pub enum Credential {
    None,
    /// A `name=value` cookie pair as captured from `Set-Cookie`.
    Cookie(Zeroizing<String>),
    /// An API key, sent as `Authorization: Bearer`.
    Bearer(Zeroizing<String>),
}

pub struct RawResponse {
    pub status: u16,
    pub set_cookies: Vec<String>,
    pub body: Vec<u8>,
}

impl RawResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `{ data, meta }` of a 2xx response; both null for an empty body.
    pub fn envelope(&self) -> Result<(Value, Value)> {
        if self.body.iter().all(u8::is_ascii_whitespace) {
            return Ok((Value::Null, Value::Null));
        }
        let v: Value = serde_json::from_slice(&self.body).map_err(|_| {
            DesktopError::invalid_response(
                "The panel answered with something that is not JSON. Check the address points at a Kaname panel.",
            )
        })?;
        match v {
            Value::Object(mut map) => Ok((
                map.remove("data").unwrap_or(Value::Null),
                map.remove("meta").unwrap_or(Value::Null),
            )),
            _ => Err(DesktopError::invalid_response(
                "The panel answered with an unexpected body.",
            )),
        }
    }

    pub fn error(&self) -> DesktopError {
        DesktopError::from_panel(self.status, &self.body)
    }
}

/// One panel origin with its TLS policy.
pub struct PanelClient {
    base: Url,
    http: reqwest::Client,
    tls: Arc<rustls::ClientConfig>,
}

impl PanelClient {
    pub fn new(base_url: &str, accept_invalid_certs: bool) -> Result<Self> {
        let base = Url::parse(base_url)
            .map_err(|_| DesktopError::invalid_input("The panel address is not a valid URL."))?;
        let tls = tls::client_config(accept_invalid_certs);
        let http = reqwest::Client::builder()
            .use_preconfigured_tls((*tls).clone())
            .user_agent(USER_AGENT)
            // A redirect could carry the session or key to another host.
            .redirect(redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| DesktopError::network(format!("Could not start the HTTP client: {e}")))?;
        Ok(Self { base, http, tls })
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn tls_config(&self) -> Arc<rustls::ClientConfig> {
        self.tls.clone()
    }

    pub async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        credential: &Credential,
    ) -> Result<RawResponse> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        match credential {
            Credential::None => {}
            Credential::Cookie(pair) => {
                let mut v = HeaderValue::from_str(pair).map_err(|_| {
                    DesktopError::invalid_input("The stored session is malformed; sign in again.")
                })?;
                v.set_sensitive(true);
                headers.insert(COOKIE, v);
            }
            Credential::Bearer(key) => {
                let bearer = Zeroizing::new(format!("Bearer {}", key.as_str()));
                let mut v = HeaderValue::from_str(&bearer).map_err(|_| {
                    DesktopError::invalid_input("The stored API key is malformed; enter it again.")
                })?;
                v.set_sensitive(true);
                headers.insert(AUTHORIZATION, v);
            }
        }

        let mut req = self.http.request(method, url).headers(headers);
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| transport_error(&e))?;
        let status = resp.status().as_u16();
        let set_cookies = resp
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_owned))
            .collect();
        let body = resp
            .bytes()
            .await
            .map_err(|e| transport_error(&e))?
            .to_vec();
        Ok(RawResponse {
            status,
            set_cookies,
            body,
        })
    }
}

/// Builds a client per (origin, TLS policy) and keeps it, so connections
/// are pooled across requests.
#[derive(Default)]
pub struct Clients {
    map: Mutex<HashMap<(String, bool), Arc<PanelClient>>>,
}

impl Clients {
    pub fn get(&self, base_url: &str, accept_invalid_certs: bool) -> Result<Arc<PanelClient>> {
        let key = (base_url.to_string(), accept_invalid_certs);
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = map.get(&key) {
            return Ok(c.clone());
        }
        let client = Arc::new(PanelClient::new(base_url, accept_invalid_certs)?);
        map.insert(key, client.clone());
        Ok(client)
    }
}

pub fn transport_error(e: &reqwest::Error) -> DesktopError {
    if let Some(t) = tls::find_tls_error(e) {
        return tls::tls_error(t);
    }
    if e.is_timeout() {
        return DesktopError::network("The panel did not answer in time.")
            .with_remediation("Check the panel is running and reachable from this computer.");
    }
    if e.is_connect() {
        return DesktopError::network("Could not connect to the panel.")
            .with_remediation("Check the address, your network, and that the panel is running.");
    }
    if e.is_redirect() {
        return DesktopError::network("The panel tried to redirect the request.");
    }
    DesktopError::network(format!("The request to the panel failed: {e}"))
}

pub fn parse_method(method: &str) -> Result<Method> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(DesktopError::invalid_input(format!(
            "Unsupported method {method:?}."
        ))),
    }
}

/// Checks a path the frontend wants under `/api/v1` and returns it
/// without that prefix. Refuses anything that could leave `/api/v1` or the
/// panel's origin: absolute or scheme-relative URLs, `.`/`..` segments
/// (also percent-encoded), backslashes, query strings and fragments (use
/// `query` instead), whitespace and control characters.
pub fn validate_api_path(path: &str) -> Result<String> {
    let bad = |why: &str| DesktopError::invalid_input(format!("Invalid API path: {why}."));
    if path.is_empty() || !path.starts_with('/') {
        return Err(bad("it must start with /"));
    }
    if path.starts_with("//") || path.contains("://") {
        return Err(bad("absolute URLs are not allowed"));
    }
    if path.len() > 2048 {
        return Err(bad("it is too long"));
    }
    if path
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(bad("it contains characters that are not allowed"));
    }
    if path.contains('?') || path.contains('#') {
        return Err(bad("pass query parameters in `query`, not in the path"));
    }
    // Tolerate callers that include the prefix themselves.
    let rest = match path.strip_prefix(API_PREFIX) {
        Some("") => "/",
        Some(r) if r.starts_with('/') => r,
        _ => path,
    };
    for seg in rest.split('/').skip(1) {
        let decoded = percent_decode_lossy(seg);
        if decoded == "." || decoded == ".." {
            return Err(bad("`.` and `..` segments are not allowed"));
        }
        if decoded.contains('/') || decoded.contains('\\') {
            return Err(bad("encoded slashes are not allowed"));
        }
    }
    Ok(rest.to_string())
}

fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `base` + `/api/v1` + a validated `path`, with `query` appended. Values
/// may be strings, numbers or booleans; null skips the key.
pub fn api_url(base: &Url, path: &str, query: Option<&Map<String, Value>>) -> Result<Url> {
    let rest = validate_api_path(path)?;
    let mut url = base.clone();
    url.set_path(&format!("{API_PREFIX}{rest}"));
    url.set_query(None);
    url.set_fragment(None);
    if let Some(q) = query {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for (k, v) in q {
            let s = match v {
                Value::Null => continue,
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => {
                    return Err(DesktopError::invalid_input(format!(
                        "Query parameter {k:?} must be a string, number or boolean."
                    )))
                }
            };
            pairs.push((k.clone(), s));
        }
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs);
        }
    }
    // Belt and braces: nothing above may move the request off the panel.
    if url.origin() != base.origin() || !url.path().starts_with(API_PREFIX) {
        return Err(DesktopError::invalid_input("Invalid API path."));
    }
    Ok(url)
}

/// A session cookie found in a response's `Set-Cookie` headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionCookie {
    /// `name=value`, ready to send back as a `Cookie` header.
    Set(String),
    /// The panel cleared the cookie (logout, password change elsewhere).
    Cleared,
}

/// Finds the panel's session cookie among `Set-Cookie` values.
///
/// Matches the panel's default names, plus `preferred` (the name a
/// previously stored cookie had, which covers a custom
/// `SESSION_COOKIE_NAME`). With `fallback`, a lone HttpOnly cookie is
/// accepted when no known name matched — only used on the sign-in
/// response, where the panel sets exactly the session cookie.
pub fn find_session_cookie(
    set_cookies: &[String],
    preferred: Option<&str>,
    fallback: bool,
) -> Option<SessionCookie> {
    let parsed: Vec<ParsedCookie> = set_cookies
        .iter()
        .filter_map(|s| parse_set_cookie(s))
        .collect();
    let known = |name: &str| SESSION_COOKIE_NAMES.contains(&name) || Some(name) == preferred;

    // `__Host-` first, like the panel reads them.
    let mut matches: Vec<&ParsedCookie> = parsed.iter().filter(|c| known(&c.name)).collect();
    matches.sort_by_key(|c| !c.name.starts_with("__Host-"));
    // A fresh value beats a clearing of the other name.
    if let Some(c) = matches.iter().find(|c| !c.cleared) {
        return Some(SessionCookie::Set(format!("{}={}", c.name, c.value)));
    }
    if !matches.is_empty() {
        return Some(SessionCookie::Cleared);
    }

    if fallback {
        let live: Vec<&ParsedCookie> = parsed
            .iter()
            .filter(|c| c.http_only && !c.cleared)
            .collect();
        if let [only] = live.as_slice() {
            return Some(SessionCookie::Set(format!("{}={}", only.name, only.value)));
        }
    }
    None
}

/// The cookie name of a stored `name=value` pair.
pub fn cookie_name(pair: &str) -> Option<&str> {
    pair.split_once('=').map(|(n, _)| n)
}

#[derive(Debug)]
struct ParsedCookie {
    name: String,
    value: String,
    cleared: bool,
    http_only: bool,
}

fn parse_set_cookie(header: &str) -> Option<ParsedCookie> {
    let mut parts = header.split(';');
    let (name, value) = parts.next()?.split_once('=')?;
    let name = name.trim();
    let mut value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value = &value[1..value.len() - 1];
    }
    if name.is_empty() || !name.bytes().all(is_token_byte) || !value.bytes().all(is_cookie_octet) {
        return None;
    }
    let mut cleared = value.is_empty();
    let mut http_only = false;
    for attr in parts {
        let (k, v) = match attr.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => (attr.trim(), ""),
        };
        if k.eq_ignore_ascii_case("max-age") {
            if v.parse::<i64>().map(|n| n <= 0).unwrap_or(false) {
                cleared = true;
            }
        } else if k.eq_ignore_ascii_case("expires") {
            if let Ok(t) = chrono::DateTime::parse_from_rfc2822(v) {
                if t < chrono::Utc::now() {
                    cleared = true;
                }
            }
        } else if k.eq_ignore_ascii_case("httponly") {
            http_only = true;
        }
    }
    Some(ParsedCookie {
        name: name.to_string(),
        value: value.to_string(),
        cleared,
        http_only,
    })
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// RFC 6265 cookie-octet: printable ASCII except `" , ; \` and space.
fn is_cookie_octet(b: u8) -> bool {
    matches!(b, 0x21 | 0x23..=0x2B | 0x2D..=0x3A | 0x3C..=0x5B | 0x5D..=0x7E)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_ordinary_paths() {
        assert_eq!(validate_api_path("/servers").unwrap(), "/servers");
        assert_eq!(
            validate_api_path("/services/abc-123/restart").unwrap(),
            "/services/abc-123/restart"
        );
        assert_eq!(validate_api_path("/api/v1/jobs").unwrap(), "/jobs");
        assert_eq!(validate_api_path("/api/v1").unwrap(), "/");
        // Not the prefix, just a similar name.
        assert_eq!(validate_api_path("/api/v10").unwrap(), "/api/v10");
        assert_eq!(validate_api_path("/files/a%20b").unwrap(), "/files/a%20b");
    }

    #[test]
    fn rejects_paths_that_escape() {
        for bad in [
            "",
            "servers",
            "https://evil.example/x",
            "//evil.example/x",
            "/x/https://evil",
            "/servers/../auth",
            "/..",
            "/./servers",
            "/servers/%2e%2e/x",
            "/servers/%2E/x",
            "/servers/.%2e",
            "/servers/a%2fb",
            "/servers?page=1",
            "/servers#x",
            "/servers\\..\\x",
            "/serv ers",
            "/servers\n",
            "/api/v1/../setup",
        ] {
            let err = validate_api_path(bad).unwrap_err();
            assert_eq!(err.code, "invalid_input", "{bad:?}");
        }
        // Literal dots inside a segment are fine.
        assert!(validate_api_path("/files/.env").is_ok());
        assert!(validate_api_path("/files/a..b").is_ok());
    }

    #[test]
    fn builds_urls_with_query() {
        let base = Url::parse("https://panel.example.com").unwrap();
        let q = json!({ "server_id": "s1", "page": 2, "active": true, "skip": null });
        let url = api_url(&base, "/services", q.as_object()).unwrap();
        assert_eq!(url.path(), "/api/v1/services");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("server_id".into(), "s1".into())));
        assert!(pairs.contains(&("page".into(), "2".into())));
        assert!(pairs.contains(&("active".into(), "true".into())));
        assert!(!pairs.iter().any(|(k, _)| k == "skip"));

        let q = json!({ "q": "a&b=c" });
        let url = api_url(&base, "/servers", q.as_object()).unwrap();
        assert_eq!(url.query(), Some("q=a%26b%3Dc"));

        let q = json!({ "ids": [1, 2] });
        assert!(api_url(&base, "/servers", q.as_object()).is_err());
    }

    #[test]
    fn parses_session_cookies() {
        let set = vec!["kaname_session=tok123; Path=/; HttpOnly; SameSite=Lax".to_string()];
        assert_eq!(
            find_session_cookie(&set, None, false),
            Some(SessionCookie::Set("kaname_session=tok123".into()))
        );

        let set = vec![
            "other=1; Path=/".to_string(),
            "__Host-kaname_session=sec; Path=/; Secure; HttpOnly; Expires=Wed, 21 Oct 2099 07:28:00 GMT".to_string(),
        ];
        assert_eq!(
            find_session_cookie(&set, None, false),
            Some(SessionCookie::Set("__Host-kaname_session=sec".into()))
        );

        // Fastify's clearCookie: empty value, epoch expiry.
        let set = vec![
            "kaname_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly"
                .to_string(),
        ];
        assert_eq!(
            find_session_cookie(&set, None, false),
            Some(SessionCookie::Cleared)
        );

        let set = vec!["kaname_session=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT".to_string()];
        assert_eq!(
            find_session_cookie(&set, None, false),
            Some(SessionCookie::Cleared)
        );

        // Nothing relevant.
        assert_eq!(find_session_cookie(&["x=1".into()], None, false), None);
        assert_eq!(find_session_cookie(&[], None, true), None);
    }

    #[test]
    fn custom_cookie_names() {
        let set = vec!["acme_sess=v1; Path=/; HttpOnly".to_string()];
        assert_eq!(find_session_cookie(&set, None, false), None);
        assert_eq!(
            find_session_cookie(&set, None, true),
            Some(SessionCookie::Set("acme_sess=v1".into()))
        );
        assert_eq!(
            find_session_cookie(&set, Some("acme_sess"), false),
            Some(SessionCookie::Set("acme_sess=v1".into()))
        );
        // Two candidates: ambiguous, so no guess.
        let set = vec!["a=1; HttpOnly".to_string(), "b=2; HttpOnly".to_string()];
        assert_eq!(find_session_cookie(&set, None, true), None);
        assert_eq!(cookie_name("acme_sess=v1"), Some("acme_sess"));
    }

    #[test]
    fn refuses_cookie_values_that_could_inject_headers() {
        let set = vec!["kaname_session=a b; Path=/".to_string()];
        assert_eq!(find_session_cookie(&set, None, false), None);
        let set = vec!["kaname_session=\"quoted\"; Path=/".to_string()];
        assert_eq!(
            find_session_cookie(&set, None, false),
            Some(SessionCookie::Set("kaname_session=quoted".into()))
        );
    }

    #[test]
    fn envelope_handles_empty_and_lists() {
        let r = RawResponse {
            status: 204,
            set_cookies: vec![],
            body: vec![],
        };
        assert_eq!(r.envelope().unwrap(), (Value::Null, Value::Null));
        let r = RawResponse {
            status: 200,
            set_cookies: vec![],
            body: br#"{"data":[1],"meta":{"page":1}}"#.to_vec(),
        };
        let (d, m) = r.envelope().unwrap();
        assert_eq!(d, json!([1]));
        assert_eq!(m, json!({"page":1}));
        let r = RawResponse {
            status: 200,
            set_cookies: vec![],
            body: b"<html>".to_vec(),
        };
        assert_eq!(r.envelope().unwrap_err().code, "invalid_response");
    }

    #[test]
    fn methods() {
        assert_eq!(parse_method("post").unwrap(), Method::POST);
        assert!(parse_method("TRACE").is_err());
    }
}
