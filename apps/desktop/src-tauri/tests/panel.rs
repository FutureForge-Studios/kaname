//! The backend against a mock panel: sign-in (with and without TOTP), the
//! API proxy, credential handling, the connection test and a terminal
//! socket.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use kaname_desktop_lib::backend::{Core, LoginResult, TerminalRequest};
use kaname_desktop_lib::connections::{AuthKind, ConnectionInput};
use kaname_desktop_lib::secrets::{MemoryBackend, SecretBackend};
use kaname_desktop_lib::terminal::{EventSink, TerminalEvent};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Fixture {
    core: Core,
    backend: Arc<MemoryBackend>,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(MemoryBackend::default());
    let core = Core::new(dir.path(), backend.clone()).unwrap();
    Fixture {
        core,
        backend,
        _dir: dir,
    }
}

fn input(base_url: &str, kind: AuthKind, api_key: Option<&str>) -> ConnectionInput {
    serde_json::from_value(json!({
        "name": "Test panel",
        "base_url": base_url,
        "auth_kind": kind,
        "api_key": api_key,
    }))
    .unwrap()
}

fn session_body() -> Value {
    json!({ "data": { "user": { "email": "ops@example.com" }, "api_key": null, "permissions": [], "totp_required": false } })
}

#[tokio::test]
async fn login_stores_cookie_and_proxies_requests() {
    let panel = MockServer::start().await;
    let f = fixture();
    let conn = f
        .core
        .connection_save(input(&panel.uri(), AuthKind::Session, None))
        .await
        .unwrap();
    assert!(!conn.has_credential);

    Mock::given(method("POST"))
        .and(path("/api/v1/auth/login"))
        .and(body_json(
            json!({ "email": "ops@example.com", "password": "hunter2!", "remember": true }),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header(
                    "set-cookie",
                    "kaname_session=tok_abc; Path=/; HttpOnly; SameSite=Lax",
                )
                .set_body_json(json!({ "data": { "status": "ok", "user": {} } })),
        )
        .expect(1)
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/session"))
        .and(header("cookie", "kaname_session=tok_abc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(session_body()))
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/servers"))
        .and(query_param("page", "2"))
        .and(query_param("q", "web"))
        .and(header("cookie", "kaname_session=tok_abc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": [{ "id": "s1" }], "meta": { "page": 2, "per_page": 50, "total": 51, "has_more": false } }),
        ))
        .mount(&panel)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/services/svc1/restart"))
        .respond_with(
            ResponseTemplate::new(202).set_body_json(json!({ "data": { "job": { "id": "j1" } } })),
        )
        .mount(&panel)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/thing/1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&panel)
        .await;

    let result = f
        .core
        .auth_login(
            &conn.stored.id,
            " ops@example.com ",
            "hunter2!".to_string().into(),
            true,
        )
        .await
        .unwrap();
    match result {
        LoginResult::Ok { session } => assert_eq!(session["user"]["email"], "ops@example.com"),
        other => panic!("unexpected {other:?}"),
    }
    let stored = f
        .backend
        .get(&format!("{}:session", conn.stored.id))
        .unwrap()
        .unwrap();
    assert_eq!(stored.as_str(), "kaname_session=tok_abc");

    let list = f.core.connections_list().await;
    assert!(list[0].has_credential);
    assert_eq!(list[0].stored.email.as_deref(), Some("ops@example.com"));
    assert!(list[0].stored.last_connected_at.is_some());

    let q = json!({ "page": 2, "q": "web" });
    let resp = f
        .core
        .api_request(
            &conn.stored.id,
            "GET",
            "/servers",
            q.as_object().cloned(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.data[0]["id"], "s1");
    assert_eq!(resp.meta["total"], 51);

    let resp = f
        .core
        .api_request(
            &conn.stored.id,
            "post",
            "/services/svc1/restart",
            None,
            Some(json!({})),
        )
        .await
        .unwrap();
    assert_eq!(resp.status, 202);
    assert_eq!(resp.data["job"]["id"], "j1");

    let resp = f
        .core
        .api_request(&conn.stored.id, "DELETE", "/thing/1", None, None)
        .await
        .unwrap();
    assert_eq!(resp.status, 204);
    assert!(resp.data.is_null() && resp.meta.is_null());

    for bad in [
        "https://evil.example/x",
        "/servers/../auth/session",
        "servers",
        "/servers?x=1",
    ] {
        let err = f
            .core
            .api_request(&conn.stored.id, "GET", bad, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid_input", "{bad}");
    }
}

#[tokio::test]
async fn unauthenticated_clears_the_session_and_errors_map() {
    let panel = MockServer::start().await;
    let f = fixture();
    let conn = f
        .core
        .connection_save(input(&panel.uri(), AuthKind::Session, None))
        .await
        .unwrap();
    let id = conn.stored.id.clone();

    // Not signed in yet.
    let err = f
        .core
        .api_request(&id, "GET", "/servers", None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "not_signed_in");
    let err = f.core.auth_session(&id).await.unwrap_err();
    assert_eq!(err.code, "not_signed_in");

    f.backend
        .set(&format!("{id}:session"), "__Host-kaname_session=old")
        .unwrap();

    Mock::given(method("GET"))
        .and(path("/api/v1/servers/s9"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "error": { "code": "forbidden", "message": "You do not have servers:read.",
                       "remediation": { "summary": "Ask an owner.", "actions": [{ "label": "View roles", "href": "/administration/roles" }] } }
        })))
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/servers"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": { "code": "unauthenticated", "message": "Sign in to continue." }
        })))
        .mount(&panel)
        .await;

    let err = f
        .core
        .api_request(&id, "GET", "/servers/s9", None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "forbidden");
    assert_eq!(err.status, Some(403));
    assert_eq!(err.remediation.unwrap().actions[0].label, "View roles");

    let err = f
        .core
        .api_request(&id, "GET", "/servers", None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "unauthenticated");
    assert!(f.backend.get(&format!("{id}:session")).unwrap().is_none());
    assert!(!f.core.connections_list().await[0].has_credential);
}

#[tokio::test]
async fn totp_second_leg_and_rotated_cookie() {
    let panel = MockServer::start().await;
    let f = fixture();
    let conn = f
        .core
        .connection_save(input(&panel.uri(), AuthKind::Session, None))
        .await
        .unwrap();
    let id = conn.stored.id.clone();

    Mock::given(method("POST"))
        .and(path("/api/v1/auth/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": { "status": "totp_required", "challenge": "chal.sig" } }),
        ))
        .mount(&panel)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/auth/totp"))
        .and(body_json(
            json!({ "challenge": "chal.sig", "code": "123456" }),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header(
                    "set-cookie",
                    "__Host-kaname_session=t2; Path=/; Secure; HttpOnly",
                )
                .set_body_json(json!({ "data": { "status": "ok", "user": {} } })),
        )
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/session"))
        .respond_with(ResponseTemplate::new(200).set_body_json(session_body()))
        .mount(&panel)
        .await;
    // A password change revokes every session and hands back a new cookie.
    Mock::given(method("POST"))
        .and(path("/api/v1/auth/password"))
        .and(header("cookie", "__Host-kaname_session=t2"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header(
                    "set-cookie",
                    "__Host-kaname_session=t3; Path=/; Secure; HttpOnly",
                )
                .set_body_json(json!({ "data": { "status": "ok" } })),
        )
        .mount(&panel)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/auth/logout"))
        .and(header("cookie", "__Host-kaname_session=t3"))
        .respond_with(
            ResponseTemplate::new(204)
                .insert_header("set-cookie", "__Host-kaname_session=; Max-Age=0; Path=/"),
        )
        .expect(1)
        .mount(&panel)
        .await;

    let first = f
        .core
        .auth_login(&id, "ops@example.com", "pw".to_string().into(), false)
        .await
        .unwrap();
    assert_eq!(
        first,
        LoginResult::TotpRequired {
            challenge: "chal.sig".into()
        }
    );
    let v = serde_json::to_value(&first).unwrap();
    assert_eq!(
        v,
        json!({ "status": "totp_required", "challenge": "chal.sig" })
    );

    let second = f.core.auth_totp(&id, "chal.sig", " 123456 ").await.unwrap();
    assert!(matches!(second, LoginResult::Ok { .. }));
    let v = serde_json::to_value(&second).unwrap();
    assert_eq!(v["status"], "ok");
    // remember = false: held in memory, not in the keyring.
    assert!(f.backend.get(&format!("{id}:session")).unwrap().is_none());
    assert!(f.core.connections_list().await[0].has_credential);
    assert_eq!(
        f.core.connections_list().await[0].stored.email.as_deref(),
        Some("ops@example.com")
    );

    f.core
        .api_request(
            &id,
            "POST",
            "/auth/password",
            None,
            Some(json!({ "current_password": "a", "new_password": "b" })),
        )
        .await
        .unwrap();
    assert_eq!(
        f.backend
            .get(&format!("{id}:session"))
            .unwrap()
            .unwrap()
            .as_str(),
        "__Host-kaname_session=t3"
    );

    f.core.auth_logout(&id).await.unwrap();
    assert!(!f.core.connections_list().await[0].has_credential);
}

#[tokio::test]
async fn api_keys_use_bearer_and_are_never_returned() {
    let panel = MockServer::start().await;
    let f = fixture();

    let err = f
        .core
        .connection_save(input(&panel.uri(), AuthKind::ApiKey, None))
        .await
        .unwrap_err();
    assert_eq!(err.code, "invalid_input");

    let conn = f
        .core
        .connection_save(input(
            &panel.uri(),
            AuthKind::ApiKey,
            Some("kn_live_secret"),
        ))
        .await
        .unwrap();
    assert!(conn.has_credential);
    let serialized = serde_json::to_string(&conn).unwrap();
    assert!(!serialized.contains("kn_live_secret"));
    let id = conn.stored.id.clone();

    Mock::given(method("GET"))
        .and(path("/api/v1/auth/session"))
        .and(header("authorization", "Bearer kn_live_secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": { "user": null, "api_key": { "id": "k1", "name": "ci" }, "permissions": [], "totp_required": false } }),
        ))
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/servers"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&panel)
        .await;

    let session = f.core.auth_session(&id).await.unwrap();
    assert_eq!(session["api_key"]["name"], "ci");

    // A 401 on an API key does not throw the key away.
    let err = f
        .core
        .api_request(&id, "GET", "/servers", None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "unauthenticated");
    assert!(f.backend.get(&format!("{id}:api_key")).unwrap().is_some());

    // Terminals refuse API keys before touching the panel.
    struct Nop;
    impl EventSink for Nop {
        fn emit(&self, _: TerminalEvent) -> bool {
            true
        }
    }
    let err = f
        .core
        .terminal_open(
            &id,
            TerminalRequest {
                server_id: "s1".into(),
                cols: 80,
                rows: 24,
                user: None,
                container_id: None,
            },
            Arc::new(Nop),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "terminal_needs_user");

    // Updating without a key keeps it; moving to another panel drops it.
    let mut update = input(&panel.uri(), AuthKind::ApiKey, None);
    update.id = Some(id.clone());
    update.name = "Renamed".into();
    let c = f.core.connection_save(update).await.unwrap();
    assert!(c.has_credential);
    let mut moved = input("https://other.example.com", AuthKind::ApiKey, None);
    moved.id = Some(id.clone());
    let c = f.core.connection_save(moved).await.unwrap();
    assert!(!c.has_credential);

    f.core.connection_delete(&id).await.unwrap();
    assert!(f.core.connections_list().await.is_empty());
    assert_eq!(
        f.core.connection_delete(&id).await.unwrap_err().code,
        "not_found"
    );
}

#[tokio::test]
async fn keyring_failure_is_reported_not_bypassed() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), Arc::new(MemoryBackend::unavailable())).unwrap();
    let err = core
        .connection_save(input(
            "https://panel.example.com",
            AuthKind::ApiKey,
            Some("kn_x"),
        ))
        .await
        .unwrap_err();
    assert_eq!(err.code, "keyring");
    assert!(core.connections_list().await.is_empty());
    let on_disk = std::fs::read_to_string(dir.path().join("connections.json")).unwrap_or_default();
    assert!(!on_disk.contains("kn_x"));
}

#[tokio::test]
async fn connection_test_reports_setup_and_version() {
    let panel = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/setup/state"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": { "needs_onboarding": true, "step": "owner", "has_owner": false } }),
        ))
        .mount(&panel)
        .await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "status": "ok", "version": "0.2.0" })),
        )
        .mount(&panel)
        .await;

    let f = fixture();
    let t = f
        .core
        .connection_test(&format!("{}/api/v1/", panel.uri()), false)
        .await
        .unwrap();
    assert!(t.reachable);
    assert!(t.setup_required);
    assert_eq!(t.version.as_deref(), Some("0.2.0"));

    // Something that is not a panel.
    let other = MockServer::start().await;
    let err = f
        .core
        .connection_test(&other.uri(), false)
        .await
        .unwrap_err();
    assert_eq!(err.code, "not_found");

    // Nothing listening.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = closed.local_addr().unwrap();
    drop(closed);
    let t = f
        .core
        .connection_test(&format!("http://{addr}"), false)
        .await
        .unwrap();
    assert!(!t.reachable);
}

/* ------------------------------ terminal ----------------------------- */

#[derive(Default)]
struct Collector {
    events: Mutex<Vec<TerminalEvent>>,
    notify: tokio::sync::Notify,
}

impl EventSink for Collector {
    fn emit(&self, event: TerminalEvent) -> bool {
        self.events.lock().unwrap().push(event);
        self.notify.notify_waiters();
        true
    }
}

impl Collector {
    async fn wait_for(&self, pred: impl Fn(&TerminalEvent) -> bool) -> TerminalEvent {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.notify.notified();
                if let Some(e) = self
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|e| pred(e))
                    .cloned()
                {
                    return e;
                }
                notified.await;
            }
        })
        .await
        .expect("terminal event")
    }
}

#[derive(Debug, Default, Clone)]
struct Seen {
    ws_path: String,
    cookie: Option<String>,
    frames: Vec<Message>,
}

/// A panel on one port that answers `POST /api/v1/terminal/sessions` with
/// a `ws_url` on an unreachable host, and serves the socket itself.
#[allow(clippy::result_large_err)] // tungstenite's handshake callback signature
async fn terminal_panel(refuse: bool) -> (String, Arc<Mutex<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let seen2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let seen = seen2.clone();
            tokio::spawn(async move {
                // Peek the head to tell an upgrade from a plain request.
                let mut buf = vec![0u8; 8192];
                let head = loop {
                    let n = stream.peek(&mut buf).await.unwrap();
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    if s.contains("\r\n\r\n") || n == 0 {
                        break s;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                };
                if head.to_ascii_lowercase().contains("upgrade: websocket") {
                    let seen_cb = seen.clone();
                    let mut ws = tokio_tungstenite::accept_hdr_async(
                        stream,
                        move |req: &Request, resp: Response| {
                            let mut s = seen_cb.lock().unwrap();
                            s.ws_path = req.uri().to_string();
                            s.cookie = req
                                .headers()
                                .get("cookie")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned);
                            Ok(resp)
                        },
                    )
                    .await
                    .unwrap();
                    if refuse {
                        let _ = ws
                            .send(Message::Close(Some(CloseFrame {
                                code: CloseCode::from(4401),
                                reason: "unknown ticket".into(),
                            })))
                            .await;
                        while ws.next().await.is_some() {}
                        return;
                    }
                    ws.send(Message::binary(b"hello\r\n".to_vec()))
                        .await
                        .unwrap();
                    while let Some(Ok(m)) = ws.next().await {
                        let close = matches!(m, Message::Close(_));
                        seen.lock().unwrap().frames.push(m);
                        if close {
                            break;
                        }
                    }
                    return;
                }
                // Plain HTTP: read head + body, answer the ticket.
                let head_len = head.find("\r\n\r\n").unwrap() + 4;
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut req = vec![0u8; head_len + len];
                stream.read_exact(&mut req).await.unwrap();
                let body = json!({ "data": {
                    "ticket": "kn_tty_testticket",
                    "ws_url": "ws://10.255.255.1:4000/api/v1/terminal/kn_tty_testticket?cols=80&rows=24",
                    "expires_at": "2026-01-01T00:00:00.000Z",
                    "server_id": "s1", "server_name": "web-1", "recorded": true, "container_name": null
                }})
                .to_string();
                let resp = format!(
                    "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(resp.as_bytes()).await.unwrap();
            });
        }
    });
    (format!("http://{addr}"), seen)
}

async fn signed_in(f: &Fixture, base: &str) -> String {
    let conn = f
        .core
        .connection_save(input(base, AuthKind::Session, None))
        .await
        .unwrap();
    f.backend
        .set(&format!("{}:session", conn.stored.id), "kaname_session=tok")
        .unwrap();
    conn.stored.id
}

#[tokio::test]
async fn terminal_round_trip() {
    let (base, seen) = terminal_panel(false).await;
    let f = fixture();
    let id = signed_in(&f, &base).await;
    let sink = Arc::new(Collector::default());

    let opened = f
        .core
        .terminal_open(
            &id,
            TerminalRequest {
                server_id: "s1".into(),
                cols: 80,
                rows: 24,
                user: Some("deploy".into()),
                container_id: None,
            },
            sink.clone(),
        )
        .await
        .unwrap();
    assert_eq!(opened.server_name, "web-1");
    assert!(opened.recorded);
    assert_eq!(opened.container_name, None);

    let data = sink
        .wait_for(|e| matches!(e, TerminalEvent::Data { .. }))
        .await;
    assert_eq!(
        data,
        TerminalEvent::Data {
            b64: "aGVsbG8NCg==".into()
        }
    );

    f.core
        .terminal_write(&opened.terminal_id, "bHMK")
        .await
        .unwrap();
    f.core
        .terminal_resize(&opened.terminal_id, 120, 40)
        .await
        .unwrap();
    assert_eq!(
        f.core
            .terminal_resize(&opened.terminal_id, 0, 40)
            .await
            .unwrap_err()
            .code,
        "invalid_input"
    );
    f.core.terminal_close(&opened.terminal_id).await;

    let closed = sink
        .wait_for(|e| matches!(e, TerminalEvent::Closed { .. }))
        .await;
    assert_eq!(
        closed,
        TerminalEvent::Closed {
            code: Some(1000),
            reason: "pane closed".into()
        }
    );

    // Give the server task a moment to record the close frame.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let s = seen.lock().unwrap().clone();
    assert_eq!(
        s.ws_path,
        "/api/v1/terminal/kn_tty_testticket?cols=80&rows=24"
    );
    assert_eq!(s.cookie.as_deref(), Some("kaname_session=tok"));
    assert_eq!(s.frames[0], Message::binary(b"ls\n".to_vec()));
    assert_eq!(
        s.frames[1],
        Message::text(r#"{"cols":120,"rows":40,"t":"resize"}"#)
    );
    assert!(
        matches!(&s.frames[2], Message::Close(Some(f)) if f.code == CloseCode::Normal && f.reason == "pane closed")
    );

    // Closing again is harmless; writing to it is not found.
    f.core.terminal_close(&opened.terminal_id).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        f.core
            .terminal_write(&opened.terminal_id, "eA==")
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
}

#[tokio::test]
async fn refused_ticket_surfaces_close_code() {
    let (base, _) = terminal_panel(true).await;
    let f = fixture();
    let id = signed_in(&f, &base).await;
    let sink = Arc::new(Collector::default());
    f.core
        .terminal_open(
            &id,
            TerminalRequest {
                server_id: "s1".into(),
                cols: 80,
                rows: 24,
                user: None,
                container_id: None,
            },
            sink.clone(),
        )
        .await
        .unwrap();
    let closed = sink
        .wait_for(|e| matches!(e, TerminalEvent::Closed { .. }))
        .await;
    assert_eq!(
        closed,
        TerminalEvent::Closed {
            code: Some(4401),
            reason: "unknown ticket".into()
        }
    );
}

#[tokio::test]
async fn deleting_a_connection_closes_its_terminals() {
    let (base, _) = terminal_panel(false).await;
    let f = fixture();
    let id = signed_in(&f, &base).await;
    let sink = Arc::new(Collector::default());
    f.core
        .terminal_open(
            &id,
            TerminalRequest {
                server_id: "s1".into(),
                cols: 80,
                rows: 24,
                user: None,
                container_id: None,
            },
            sink.clone(),
        )
        .await
        .unwrap();
    assert_eq!(f.core.terminals().count(), 1);
    f.core.connection_delete(&id).await.unwrap();
    let closed = sink
        .wait_for(|e| matches!(e, TerminalEvent::Closed { .. }))
        .await;
    assert!(matches!(
        closed,
        TerminalEvent::Closed {
            code: Some(1000),
            ..
        }
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.core.terminals().count(), 0);
}
