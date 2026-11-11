//! Kaname Desktop: the Rust half. See `apps/desktop/INTERFACE.md` for the
//! command contract with the frontend.

pub mod backend;
pub mod connections;
pub mod error;
pub mod http;
pub mod secrets;
pub mod terminal;
pub mod tls;

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use zeroize::Zeroizing;

use crate::backend::{
    ApiResponse, ConnectionTest, Core, LoginResult, TerminalOpened, TerminalRequest,
};
use crate::connections::{Connection, ConnectionInput};
use crate::error::Result;
use crate::secrets::KeyringBackend;
use crate::terminal::TerminalEvent;

/* ---------------------------- connections ---------------------------- */

#[tauri::command]
async fn connections_list(core: State<'_, Core>) -> Result<Vec<Connection>> {
    Ok(core.connections_list().await)
}

#[tauri::command]
async fn connection_save(core: State<'_, Core>, input: ConnectionInput) -> Result<Connection> {
    core.connection_save(input).await
}

#[tauri::command]
async fn connection_delete(core: State<'_, Core>, id: String) -> Result<()> {
    core.connection_delete(&id).await
}

#[tauri::command]
async fn connection_test(
    core: State<'_, Core>,
    base_url: String,
    accept_invalid_certs: Option<bool>,
) -> Result<ConnectionTest> {
    core.connection_test(&base_url, accept_invalid_certs.unwrap_or(false))
        .await
}

/* -------------------------------- auth ------------------------------- */

#[tauri::command]
async fn auth_login(
    core: State<'_, Core>,
    id: String,
    email: String,
    password: String,
    remember: Option<bool>,
) -> Result<LoginResult> {
    let password = Zeroizing::new(password);
    core.auth_login(&id, &email, password, remember.unwrap_or(false))
        .await
}

#[tauri::command]
async fn auth_totp(
    core: State<'_, Core>,
    id: String,
    challenge: String,
    code: String,
) -> Result<LoginResult> {
    core.auth_totp(&id, &challenge, &code).await
}

#[tauri::command]
async fn auth_session(core: State<'_, Core>, id: String) -> Result<Value> {
    core.auth_session(&id).await
}

#[tauri::command]
async fn auth_logout(core: State<'_, Core>, id: String) -> Result<()> {
    core.auth_logout(&id).await
}

/* -------------------------------- api -------------------------------- */

#[tauri::command]
async fn api_request(
    core: State<'_, Core>,
    id: String,
    method: String,
    path: String,
    query: Option<Map<String, Value>>,
    body: Option<Value>,
) -> Result<ApiResponse> {
    core.api_request(&id, &method, &path, query, body).await
}

/* ------------------------------ terminal ----------------------------- */

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn terminal_open(
    core: State<'_, Core>,
    id: String,
    server_id: String,
    cols: u16,
    rows: u16,
    user: Option<String>,
    container_id: Option<String>,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalOpened> {
    core.terminal_open(
        &id,
        TerminalRequest {
            server_id,
            cols,
            rows,
            user,
            container_id,
        },
        Arc::new(on_event),
    )
    .await
}

#[tauri::command]
async fn terminal_write(core: State<'_, Core>, terminal_id: String, b64: String) -> Result<()> {
    core.terminal_write(&terminal_id, &b64).await
}

#[tauri::command]
async fn terminal_resize(
    core: State<'_, Core>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    core.terminal_resize(&terminal_id, cols, rows).await
}

#[tauri::command]
async fn terminal_close(core: State<'_, Core>, terminal_id: String) -> Result<()> {
    core.terminal_close(&terminal_id).await;
    Ok(())
}

/* -------------------------------- app -------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let core = Core::new(&dir, Arc::new(KeyringBackend))?;
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connections_list,
            connection_save,
            connection_delete,
            connection_test,
            auth_login,
            auth_totp,
            auth_session,
            auth_logout,
            api_request,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kaname Desktop");
}
