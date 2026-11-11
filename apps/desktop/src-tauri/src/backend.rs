//! Everything the commands do, independent of Tauri so it can be tested
//! against a mock panel.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::connections::{
    clean_optional, normalize_base_url, now_iso, validate_name, AuthKind, Connection,
    ConnectionInput, ConnectionStore, StoredConnection,
};
use crate::error::{DesktopError, Result};
use crate::http::{
    api_url, cookie_name, find_session_cookie, parse_method, Clients, Credential, PanelClient,
    RawResponse, SessionCookie,
};
use crate::secrets::{SecretBackend, SecretKind, Secrets};
use crate::terminal::{self, Dial, EventSink, Terminals};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginResult {
    Ok { session: Value },
    TotpRequired { challenge: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub data: Value,
    pub meta: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConnectionTest {
    pub reachable: bool,
    pub version: Option<String>,
    pub setup_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TerminalOpened {
    pub terminal_id: String,
    pub server_id: String,
    pub server_name: String,
    pub container_name: Option<String>,
    pub recorded: bool,
}

pub struct TerminalRequest {
    pub server_id: String,
    pub cols: u16,
    pub rows: u16,
    pub user: Option<String>,
    pub container_id: Option<String>,
}

/// A sign-in waiting for its TOTP leg.
struct PendingLogin {
    email: String,
    remember: bool,
}

pub struct Core {
    store: ConnectionStore,
    secrets: Secrets,
    clients: Clients,
    terminals: Terminals,
    pending: Mutex<HashMap<String, PendingLogin>>,
}

impl Core {
    pub fn new(config_dir: &Path, backend: Arc<dyn SecretBackend>) -> Result<Self> {
        Ok(Self {
            store: ConnectionStore::open(config_dir)?,
            secrets: Secrets::new(backend),
            clients: Clients::default(),
            terminals: Terminals::default(),
            pending: Mutex::default(),
        })
    }

    pub fn terminals(&self) -> &Terminals {
        &self.terminals
    }

    /* --------------------------- connections -------------------------- */

    async fn present(&self, stored: StoredConnection) -> Connection {
        let kind = match stored.auth_kind {
            AuthKind::Session => SecretKind::Session,
            AuthKind::ApiKey => SecretKind::ApiKey,
        };
        let has_credential = self.secrets.has(&stored.id, kind).await;
        Connection {
            stored,
            has_credential,
        }
    }

    pub async fn connections_list(&self) -> Vec<Connection> {
        let mut out = Vec::new();
        for c in self.store.list() {
            out.push(self.present(c).await);
        }
        out
    }

    pub async fn connection_save(&self, input: ConnectionInput) -> Result<Connection> {
        let name = validate_name(&input.name)?;
        let base_url = normalize_base_url(&input.base_url)?;
        let email = clean_optional(input.email, 254, "email address")?;
        let color = clean_optional(input.color, 32, "color")?;
        let api_key = match input.api_key.map(Zeroizing::new) {
            Some(k) if !k.trim().is_empty() => {
                if input.auth_kind != AuthKind::ApiKey {
                    return Err(DesktopError::invalid_input(
                        "An API key only applies to API-key connections.",
                    ));
                }
                let k = Zeroizing::new(k.trim().to_string());
                if k.len() > 512 || !k.bytes().all(|b| b.is_ascii_graphic()) {
                    return Err(DesktopError::invalid_input("That API key is not valid."));
                }
                Some(k)
            }
            _ => None,
        };

        let existing = match input.id.as_deref() {
            Some(id) => Some(self.store.get(id)?),
            None => None,
        };

        let conn = match &existing {
            Some(prev) => StoredConnection {
                id: prev.id.clone(),
                name,
                base_url: base_url.clone(),
                auth_kind: input.auth_kind,
                email,
                color,
                accept_invalid_certs: input
                    .accept_invalid_certs
                    .unwrap_or(prev.accept_invalid_certs),
                created_at: prev.created_at.clone(),
                last_connected_at: prev.last_connected_at.clone(),
            },
            None => {
                if input.auth_kind == AuthKind::ApiKey && api_key.is_none() {
                    return Err(DesktopError::invalid_input(
                        "Enter the API key for this connection.",
                    ));
                }
                StoredConnection {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    base_url: base_url.clone(),
                    auth_kind: input.auth_kind,
                    email,
                    color,
                    accept_invalid_certs: input.accept_invalid_certs.unwrap_or(false),
                    created_at: now_iso(),
                    last_connected_at: None,
                }
            }
        };

        // Store the key first: a connection that says "api_key" but has
        // none would be a dead entry if the keyring refuses it.
        if let Some(k) = &api_key {
            self.secrets
                .set(&conn.id, SecretKind::ApiKey, k, true)
                .await?;
        }

        if let Some(prev) = &existing {
            let moved = prev.base_url != conn.base_url
                || prev.accept_invalid_certs != conn.accept_invalid_certs;
            // A credential for one panel must never be sent to another.
            if prev.base_url != conn.base_url {
                let _ = self.secrets.delete(&conn.id, SecretKind::Session).await;
                if api_key.is_none() {
                    let _ = self.secrets.delete(&conn.id, SecretKind::ApiKey).await;
                }
            }
            if prev.auth_kind != conn.auth_kind {
                let stale = match prev.auth_kind {
                    AuthKind::Session => SecretKind::Session,
                    AuthKind::ApiKey => SecretKind::ApiKey,
                };
                let _ = self.secrets.delete(&conn.id, stale).await;
            }
            if moved || prev.auth_kind != conn.auth_kind {
                self.terminals.close_connection(&conn.id);
            }
        }

        self.store.upsert(conn.clone())?;
        Ok(self.present(conn).await)
    }

    pub async fn connection_delete(&self, id: &str) -> Result<()> {
        self.terminals.close_connection(id);
        self.pending_lock().remove(id);
        // Keyring first: if it refuses, the connection stays listed so the
        // operator can retry rather than leaving an orphaned secret.
        self.secrets.delete_all(id).await?;
        if !self.store.remove(id)? {
            return Err(DesktopError::not_found("No such connection."));
        }
        Ok(())
    }

    pub async fn connection_test(
        &self,
        base_url: &str,
        accept_invalid_certs: bool,
    ) -> Result<ConnectionTest> {
        let base = normalize_base_url(base_url)?;
        // A throwaway client: testing an address must not pollute the
        // pool for a saved connection with a different TLS policy.
        let client = PanelClient::new(&base, accept_invalid_certs)?;

        let url = api_url(client.base(), "/setup/state", None)?;
        let resp = match client.send(Method::GET, url, None, &Credential::None).await {
            Ok(r) => r,
            // A certificate problem is actionable; say so instead of
            // reporting "unreachable".
            Err(e) if e.code == "tls" => return Err(e),
            Err(_) => {
                return Ok(ConnectionTest {
                    reachable: false,
                    version: None,
                    setup_required: false,
                })
            }
        };
        if !resp.is_success() {
            return Err(not_a_panel(resp.status));
        }
        let (data, _) = resp.envelope().map_err(|_| not_a_panel(resp.status))?;
        let setup_required = match data.get("needs_onboarding") {
            Some(Value::Bool(b)) => *b,
            _ => return Err(not_a_panel(resp.status)),
        };

        // `/health` sits beside `/api` on the same origin and is the only
        // public place the version is reported. Best effort.
        let mut version = None;
        if let Ok(mut health) = url::Url::parse(&base) {
            health.set_path("/health");
            if let Ok(r) = client
                .send(Method::GET, health, None, &Credential::None)
                .await
            {
                if r.is_success() {
                    version = serde_json::from_slice::<Value>(&r.body)
                        .ok()
                        .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_owned));
                }
            }
        }

        Ok(ConnectionTest {
            reachable: true,
            version,
            setup_required,
        })
    }

    /* ------------------------------ auth ------------------------------ */

    fn pending_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingLogin>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn client_for(&self, conn: &StoredConnection) -> Result<Arc<PanelClient>> {
        self.clients.get(&conn.base_url, conn.accept_invalid_certs)
    }

    pub async fn auth_login(
        &self,
        id: &str,
        email: &str,
        password: Zeroizing<String>,
        remember: bool,
    ) -> Result<LoginResult> {
        let conn = self.store.get(id)?;
        if conn.auth_kind != AuthKind::Session {
            return Err(DesktopError::invalid_input(
                "This connection signs in with an API key.",
            ));
        }
        let email = email.trim().to_string();
        if email.is_empty() || password.is_empty() {
            return Err(DesktopError::invalid_input(
                "Enter your email and password.",
            ));
        }
        let client = self.client_for(&conn)?;
        let body = json!({ "email": email, "password": password.as_str(), "remember": remember });
        let url = api_url(client.base(), "/auth/login", None)?;
        let resp = client
            .send(Method::POST, url, Some(&body), &Credential::None)
            .await?;
        drop(body);
        self.finish_login(&conn, &client, resp, email, remember)
            .await
    }

    pub async fn auth_totp(&self, id: &str, challenge: &str, code: &str) -> Result<LoginResult> {
        let conn = self.store.get(id)?;
        let client = self.client_for(&conn)?;
        let code = code.trim();
        if challenge.is_empty() || code.is_empty() {
            return Err(DesktopError::invalid_input(
                "Enter the code from your authenticator.",
            ));
        }
        let url = api_url(client.base(), "/auth/totp", None)?;
        let body = json!({ "challenge": challenge, "code": code });
        let resp = client
            .send(Method::POST, url, Some(&body), &Credential::None)
            .await?;
        let (email, remember) = match self.pending_lock().get(id) {
            Some(p) => (p.email.clone(), p.remember),
            // No pending leg (e.g. the app restarted): do not persist.
            None => (conn.email.clone().unwrap_or_default(), false),
        };
        self.finish_login(&conn, &client, resp, email, remember)
            .await
    }

    async fn finish_login(
        &self,
        conn: &StoredConnection,
        client: &PanelClient,
        resp: RawResponse,
        email: String,
        remember: bool,
    ) -> Result<LoginResult> {
        if !resp.is_success() {
            return Err(resp.error());
        }
        let (data, _) = resp.envelope()?;
        match data.get("status").and_then(Value::as_str) {
            Some("totp_required") => {
                let challenge = data
                    .get("challenge")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        DesktopError::invalid_response(
                            "The panel asked for a code but sent no challenge.",
                        )
                    })?
                    .to_string();
                self.pending_lock()
                    .insert(conn.id.clone(), PendingLogin { email, remember });
                Ok(LoginResult::TotpRequired { challenge })
            }
            Some("ok") => {
                self.pending_lock().remove(&conn.id);
                let pair = match find_session_cookie(&resp.set_cookies, None, true) {
                    Some(SessionCookie::Set(pair)) => Zeroizing::new(pair),
                    _ => {
                        return Err(DesktopError::invalid_response(
                            "The panel accepted the sign-in but returned no session cookie. \
                             A proxy in front of the panel may be stripping it.",
                        ))
                    }
                };
                self.secrets
                    .set(&conn.id, SecretKind::Session, &pair, remember)
                    .await?;
                let remembered = (!email.is_empty()).then_some(email);
                self.store.update(&conn.id, |c| {
                    if remembered.is_some() {
                        c.email = remembered;
                    }
                    c.last_connected_at = Some(now_iso());
                })?;
                let session = self.fetch_session(conn, client).await?;
                Ok(LoginResult::Ok { session })
            }
            _ => Err(DesktopError::invalid_response(
                "The panel answered the sign-in in a way this app does not understand.",
            )),
        }
    }

    async fn fetch_session(&self, conn: &StoredConnection, client: &PanelClient) -> Result<Value> {
        let url = api_url(client.base(), "/auth/session", None)?;
        let resp = self
            .authed_send(conn, client, Method::GET, url, None)
            .await?;
        Ok(resp.envelope()?.0)
    }

    pub async fn auth_session(&self, id: &str) -> Result<Value> {
        let conn = self.store.get(id)?;
        let client = self.client_for(&conn)?;
        let session = self.fetch_session(&conn, &client).await?;
        let _ = self
            .store
            .update(id, |c| c.last_connected_at = Some(now_iso()));
        Ok(session)
    }

    pub async fn auth_logout(&self, id: &str) -> Result<()> {
        let conn = self.store.get(id)?;
        self.terminals.close_connection(id);
        self.pending_lock().remove(id);
        match conn.auth_kind {
            AuthKind::Session => {
                if let Some(pair) = self
                    .secrets
                    .get(id, SecretKind::Session)
                    .await
                    .ok()
                    .flatten()
                {
                    if let Ok(client) = self.client_for(&conn) {
                        if let Ok(url) = api_url(client.base(), "/auth/logout", None) {
                            // Best effort: the token is forgotten either way.
                            let _ = client
                                .send(Method::POST, url, None, &Credential::Cookie(pair))
                                .await;
                        }
                    }
                }
                self.secrets.delete(id, SecretKind::Session).await
            }
            // An API key has no server-side session; signing out of an
            // API-key connection forgets the key.
            AuthKind::ApiKey => self.secrets.delete(id, SecretKind::ApiKey).await,
        }
    }

    /* ------------------------------ api ------------------------------- */

    async fn credential(&self, conn: &StoredConnection) -> Result<Credential> {
        let kind = match conn.auth_kind {
            AuthKind::Session => SecretKind::Session,
            AuthKind::ApiKey => SecretKind::ApiKey,
        };
        match self.secrets.get(&conn.id, kind).await? {
            Some(s) => Ok(match conn.auth_kind {
                AuthKind::Session => Credential::Cookie(s),
                AuthKind::ApiKey => Credential::Bearer(s),
            }),
            None => Err(DesktopError::not_signed_in()),
        }
    }

    /// Sends with the connection's credential and keeps the stored session
    /// in step with the panel: a 401 forgets it, a fresh `Set-Cookie`
    /// (e.g. after a password change) replaces it, a clearing one drops it.
    async fn authed_send(
        &self,
        conn: &StoredConnection,
        client: &PanelClient,
        method: Method,
        url: url::Url,
        body: Option<&Value>,
    ) -> Result<RawResponse> {
        let credential = self.credential(conn).await?;
        let preferred = match &credential {
            Credential::Cookie(pair) => cookie_name(pair).map(str::to_owned),
            _ => None,
        };
        let resp = client.send(method, url, body, &credential).await?;
        drop(credential);

        if conn.auth_kind == AuthKind::Session {
            if resp.status == 401 {
                let _ = self.secrets.delete(&conn.id, SecretKind::Session).await;
            } else {
                match find_session_cookie(&resp.set_cookies, preferred.as_deref(), false) {
                    Some(SessionCookie::Set(pair)) => {
                        // Keep it as persistent as the keyring allows; a
                        // refused write still updates the in-memory copy.
                        if self
                            .secrets
                            .set(&conn.id, SecretKind::Session, &pair, true)
                            .await
                            .is_err()
                        {
                            let _ = self
                                .secrets
                                .set(&conn.id, SecretKind::Session, &pair, false)
                                .await;
                        }
                    }
                    Some(SessionCookie::Cleared) => {
                        let _ = self.secrets.delete(&conn.id, SecretKind::Session).await;
                    }
                    None => {}
                }
            }
        }

        if !resp.is_success() {
            return Err(resp.error());
        }
        Ok(resp)
    }

    pub async fn api_request(
        &self,
        id: &str,
        method: &str,
        path: &str,
        query: Option<Map<String, Value>>,
        body: Option<Value>,
    ) -> Result<ApiResponse> {
        let method = parse_method(method)?;
        let conn = self.store.get(id)?;
        let client = self.client_for(&conn)?;
        let url = api_url(client.base(), path, query.as_ref())?;
        let body = match body {
            Some(Value::Null) | None => None,
            Some(_) if method == Method::GET => {
                return Err(DesktopError::invalid_input(
                    "A GET request cannot have a body.",
                ))
            }
            Some(b) => Some(b),
        };
        let resp = self
            .authed_send(&conn, &client, method, url, body.as_ref())
            .await?;
        let (data, meta) = resp.envelope()?;
        Ok(ApiResponse {
            status: resp.status,
            data,
            meta,
        })
    }

    /* ---------------------------- terminal ---------------------------- */

    pub async fn terminal_open(
        &self,
        id: &str,
        req: TerminalRequest,
        sink: Arc<dyn EventSink>,
    ) -> Result<TerminalOpened> {
        terminal::validate_size(req.cols, req.rows)?;
        let conn = self.store.get(id)?;
        if conn.auth_kind != AuthKind::Session {
            return Err(DesktopError::new(
                "terminal_needs_user",
                "Terminals need a signed-in user; API keys cannot open a shell.",
            )
            .with_remediation(
                "Add a connection that signs in with your email and password to open terminals.",
            ));
        }
        let client = self.client_for(&conn)?;

        let mut body = json!({ "server_id": req.server_id, "cols": req.cols, "rows": req.rows });
        if let Some(u) = req.user.filter(|u| !u.is_empty()) {
            body["user"] = Value::String(u);
        }
        if let Some(c) = req.container_id.filter(|c| !c.is_empty()) {
            body["container_id"] = Value::String(c);
        }
        let url = api_url(client.base(), "/terminal/sessions", None)?;
        let resp = self
            .authed_send(&conn, &client, Method::POST, url, Some(&body))
            .await?;
        let (data, _) = resp.envelope()?;

        let field = |k: &str| data.get(k).and_then(Value::as_str).map(str::to_owned);
        let ticket = field("ticket").ok_or_else(|| {
            DesktopError::invalid_response("The panel did not return a terminal ticket.")
        })?;
        let ws_url = field("ws_url").unwrap_or_default();
        let ws = terminal::rebase_ws_url(client.base(), &ws_url, &ticket, req.cols, req.rows)?;

        // The ticket is single use and expires in 30 s: dial right away.
        let cookie = match self.credential(&conn).await {
            Ok(Credential::Cookie(c)) => Some(c),
            _ => None,
        };
        let origin = client.base().origin().ascii_serialization();
        let terminal_id = self
            .terminals
            .dial(
                Dial {
                    connection_id: &conn.id,
                    url: ws,
                    cookie: cookie.as_deref().map(String::as_str),
                    origin: &origin,
                    tls: client.tls_config(),
                },
                sink,
            )
            .await?;

        Ok(TerminalOpened {
            terminal_id,
            server_id: field("server_id").unwrap_or(req.server_id),
            server_name: field("server_name").unwrap_or_default(),
            container_name: field("container_name"),
            recorded: data
                .get("recorded")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        })
    }

    pub async fn terminal_write(&self, terminal_id: &str, b64: &str) -> Result<()> {
        let bytes = terminal::decode_input(b64)?;
        self.terminals.write(terminal_id, bytes.to_vec()).await
    }

    pub async fn terminal_resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.terminals.resize(terminal_id, cols, rows).await
    }

    pub async fn terminal_close(&self, terminal_id: &str) {
        self.terminals.close(terminal_id).await
    }
}

fn not_a_panel(status: u16) -> DesktopError {
    let mut e = DesktopError::not_found(
        "That address answered, but not like a Kaname panel. Check the address.",
    );
    e.status = Some(status);
    e
}
