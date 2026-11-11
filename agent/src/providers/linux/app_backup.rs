//! App backups on a real host: `app.db_dump` and `app.db_restore`.
//!
//! The guards and argv live in `providers::app_backup`; this module only
//! carries them out against the container runtime's Engine API. It keeps
//! its own few lines of HTTP-over-unix-socket rather than reaching into
//! the containers module, so the managed-container code stays the only
//! thing that can *create* a container: what is here can inspect one
//! container by its derived name and run one fixed argv inside it.

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use tokio::net::UnixStream;

use super::Shared;
use crate::providers::app_backup::{
    self as ab, AppBackup, AppDbDumpResult, AppDbParams, AppDbRestoreResult, BACKUP_DIR, TRANSFER_FILE,
};
use crate::providers::managed::{self, MANAGED_APPS_ROOT};
use crate::providers::{Ctx, PResult, ProviderError};

const API_PREFIX: &str = "/v1.40";
const SOCKETS: &[&str] = &[
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman/podman.sock",
    "/var/run/podman/podman.sock",
];
/// The most of a dump tool's chatter kept for an error message.
const OUTPUT_LIMIT: usize = 16 << 10;

pub struct AppBackupOps(pub Arc<Shared>);

#[derive(Deserialize, Default)]
#[serde(default)]
struct Inspect {
    #[serde(rename = "Config")]
    config: InspectConfig,
    #[serde(rename = "State")]
    state: InspectState,
    #[serde(rename = "Mounts")]
    mounts: Vec<InspectMount>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InspectConfig {
    #[serde(rename = "Labels")]
    labels: Option<std::collections::BTreeMap<String, String>>,
    #[serde(rename = "Env")]
    env: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InspectState {
    #[serde(rename = "Running")]
    running: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InspectMount {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Destination")]
    destination: String,
}

/// The companion as the guards need it.
struct Companion {
    name: String,
    identity: ab::DbIdentity,
    /// Inside the container / on the host: the transfer file in the data mount.
    container_file: String,
    host_file: String,
}

impl AppBackupOps {
    fn socket(&self) -> PResult<&'static str> {
        if self.0.docker.is_none() {
            return Err(ProviderError::unsupported_because(
                "no container runtime socket on this host",
            ));
        }
        SOCKETS
            .iter()
            .copied()
            .find(|s| Path::new(s).exists())
            .ok_or_else(|| ProviderError::unsupported_because("no container runtime socket on this host"))
    }

    async fn request(
        &self,
        ctx: &Ctx,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> PResult<(StatusCode, Bytes)> {
        let socket = self.socket()?;
        let work = async {
            let stream = UnixStream::connect(socket)
                .await
                .map_err(|e| ProviderError::internal(format!("dial {socket}: {e}")))?;
            let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
                .await
                .map_err(|e| ProviderError::internal(format!("handshake {socket}: {e}")))?;
            let driver = tokio::spawn(async move {
                let _ = conn.await;
            });
            let mut builder = Request::builder()
                .method(method.clone())
                .uri(format!("{API_PREFIX}{path}"))
                .header(hyper::header::HOST, "kaname");
            let payload = match body {
                Some(value) => {
                    builder = builder.header(hyper::header::CONTENT_TYPE, "application/json");
                    Bytes::from(serde_json::to_vec(&value)?)
                }
                None => Bytes::new(),
            };
            let request = builder
                .body(Full::new(payload))
                .map_err(|e| ProviderError::internal(format!("build {method} {path}: {e}")))?;
            let response = sender
                .send_request(request)
                .await
                .map_err(|e| ProviderError::internal(format!("{method} {path}: {e}")))?;
            let status = response.status();
            let bytes = response
                .into_body()
                .collect()
                .await
                .map_err(|e| ProviderError::internal(format!("read {method} {path}: {e}")))?
                .to_bytes();
            driver.abort();
            Ok::<_, ProviderError>((status, bytes))
        };
        ctx.run(work).await?
    }

    async fn json<T: for<'de> Deserialize<'de>>(
        &self,
        ctx: &Ctx,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> PResult<T> {
        let (status, raw) = self.request(ctx, method.clone(), path, body).await?;
        if status.as_u16() >= 400 {
            let text = String::from_utf8_lossy(&raw).trim().to_string();
            return Err(match status {
                StatusCode::NOT_FOUND => ProviderError::not_found(text),
                StatusCode::CONFLICT => ProviderError::conflict(text),
                _ => ProviderError::exec("container runtime", format!("http {}", status.as_u16()), text),
            });
        }
        serde_json::from_slice(&raw)
            .map_err(|e| ProviderError::internal(format!("decode {method} {path}: {e}")))
    }

    /// Inspects the companion by its derived name and applies every guard.
    async fn companion(&self, ctx: &Ctx, p: &AppDbParams) -> PResult<Companion> {
        let name = managed::container_name(&p.install_id, &p.role);
        let inspect: Inspect = self
            .json(ctx, Method::GET, &format!("/containers/{name}/json"), None)
            .await
            .map_err(|e| match e {
                ProviderError::NotFound(_) => ProviderError::not_found(format!("container {name}")),
                other => other,
            })?;
        ab::check_labels(&inspect.config.labels.unwrap_or_default(), &p.install_id, &p.role)?;
        if !inspect.state.running {
            return Err(ProviderError::PreconditionFailed(format!(
                "{name} is not running; start it before dumping or restoring its database"
            )));
        }
        let mounts: Vec<(String, String)> = inspect
            .mounts
            .into_iter()
            .map(|m| (m.source, m.destination))
            .collect();
        let target = ab::data_mount_target(&mounts, MANAGED_APPS_ROOT, &p.install_id, &p.role)?;
        let host_dir = ab::data_source(MANAGED_APPS_ROOT, &p.install_id, &p.role);
        let host_file = format!("{host_dir}/{TRANSFER_FILE}");
        // Lexically and through symlinks: the data directory may not lead out.
        managed::check_source(MANAGED_APPS_ROOT, &p.install_id, &host_file)?;
        let identity = ab::identity_from_env(&p.engine, &inspect.config.env.unwrap_or_default())?;
        Ok(Companion {
            name,
            identity,
            container_file: format!("{target}/{TRANSFER_FILE}"),
            host_file,
        })
    }

    /// Runs one fixed argv inside the companion and returns its exit code
    /// and (bounded) output.
    async fn exec(&self, ctx: &Ctx, c: &Companion, argv: Vec<String>) -> PResult<(i64, String)> {
        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "Id")]
            id: String,
        }
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct ExecState {
            #[serde(rename = "ExitCode")]
            exit_code: Option<i64>,
        }
        let created: Created = self
            .json(
                ctx,
                Method::POST,
                &format!("/containers/{}/exec", c.name),
                Some(serde_json::json!({
                    "AttachStdin": false,
                    "AttachStdout": true,
                    "AttachStderr": true,
                    "Tty": false,
                    "Privileged": false,
                    "Cmd": argv,
                    "Env": ab::exec_env(&c.identity),
                })),
            )
            .await?;
        if created.id.is_empty() || !created.id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ProviderError::internal(
                "the runtime returned an unusable exec id",
            ));
        }
        let (status, raw) = self
            .request(
                ctx,
                Method::POST,
                &format!("/exec/{}/start", created.id),
                Some(serde_json::json!({"Detach": false, "Tty": false})),
            )
            .await?;
        if status.as_u16() >= 400 {
            return Err(ProviderError::exec(
                "container runtime",
                format!("http {}", status.as_u16()),
                String::from_utf8_lossy(&raw).to_string(),
            ));
        }
        let mut output = demultiplex(&raw);
        if output.len() > OUTPUT_LIMIT {
            output = output[output.len() - OUTPUT_LIMIT..].to_string();
        }
        let state: ExecState = self
            .json(ctx, Method::GET, &format!("/exec/{}/json", created.id), None)
            .await?;
        Ok((state.exit_code.unwrap_or(-1), output))
    }
}

/// Removes a regular file at `path`; refuses to follow or remove a symlink
/// planted there by whatever runs in the container.
fn clear_regular(path: &str) -> PResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(ProviderError::PermissionDenied(format!(
            "{path} is a symlink; refusing to use it"
        ))),
        Ok(meta) if meta.is_file() => Ok(std::fs::remove_file(path)?),
        Ok(_) => Err(ProviderError::conflict(format!(
            "{path} exists and is not a file"
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn demultiplex(mut raw: &[u8]) -> String {
    let mut out = Vec::new();
    while raw.len() >= 8 {
        let size = u32::from_be_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
        let end = (8 + size).min(raw.len());
        out.extend_from_slice(&raw[8..end]);
        raw = &raw[end..];
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[async_trait]
impl AppBackup for AppBackupOps {
    async fn db_dump(&self, ctx: &Ctx, mut p: AppDbParams) -> PResult<AppDbDumpResult> {
        ab::validate(&mut p)?;
        let c = self.companion(ctx, &p).await?;
        clear_regular(&c.host_file)?;

        let argv = ab::dump_argv(&p.engine, &c.identity, &c.container_file);
        let (code, output) = self.exec(ctx, &c, argv).await?;
        if code != 0 {
            let _ = clear_regular(&c.host_file);
            return Err(ProviderError::exec(
                format!("{} dump", p.engine),
                format!("exited with {code}"),
                output,
            ));
        }

        // The tool wrote into the data mount; the file now moves to the
        // install's backup directory, which only the agent writes to.
        let meta = std::fs::symlink_metadata(&c.host_file)
            .map_err(|_| ProviderError::PreconditionFailed("the dump tool produced no file".into()))?;
        if !meta.is_file() {
            return Err(ProviderError::PermissionDenied(
                "the dump is not a regular file".into(),
            ));
        }
        let dir = format!(
            "{}/{BACKUP_DIR}",
            managed::install_dir(MANAGED_APPS_ROOT, &p.install_id)
        );
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        let dest = ab::dump_path(MANAGED_APPS_ROOT, &p.install_id, &p.role, &p.slot);
        managed::check_source(MANAGED_APPS_ROOT, &p.install_id, &dest)?;
        clear_regular(&dest)?;
        if std::fs::rename(&c.host_file, &dest).is_err() {
            std::fs::copy(&c.host_file, &dest)?;
            clear_regular(&c.host_file)?;
        }
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600))?;
        let size = std::fs::metadata(&dest)?.len() as i64;
        Ok(AppDbDumpResult {
            path: dest,
            size_bytes: size,
            engine: p.engine,
            database: c.identity.database,
        })
    }

    async fn db_restore(&self, ctx: &Ctx, mut p: AppDbParams) -> PResult<AppDbRestoreResult> {
        ab::validate(&mut p)?;
        let source = ab::dump_path(MANAGED_APPS_ROOT, &p.install_id, &p.role, &p.slot);
        managed::check_source(MANAGED_APPS_ROOT, &p.install_id, &source)?;
        match std::fs::symlink_metadata(&source) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => {
                return Err(ProviderError::PermissionDenied(format!(
                    "{source} is not a regular file"
                )));
            }
            Err(_) => return Err(ProviderError::not_found(source)),
        }
        let c = self.companion(ctx, &p).await?;
        clear_regular(&c.host_file)?;
        std::fs::copy(&source, &c.host_file)?;
        // Readable by the database's own account inside the container.
        std::fs::set_permissions(&c.host_file, std::fs::Permissions::from_mode(0o644))?;

        let argv = ab::restore_argv(&p.engine, &c.identity, &c.container_file);
        let outcome = self.exec(ctx, &c, argv).await;
        let _ = clear_regular(&c.host_file);
        let (code, output) = outcome?;
        if code != 0 {
            return Err(ProviderError::exec(
                format!("{} restore", p.engine),
                format!("exited with {code}"),
                output,
            ));
        }
        Ok(AppDbRestoreResult {
            ok: true,
            database: c.identity.database,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_output_is_demultiplexed() {
        let mut raw = vec![2, 0, 0, 0, 0, 0, 0, 5];
        raw.extend_from_slice(b"error");
        assert_eq!(demultiplex(&raw), "error");
    }

    #[test]
    fn a_planted_symlink_is_never_followed_or_removed() {
        let dir = std::env::temp_dir().join(format!("kaname-appbackup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("t.dump");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink("/etc/passwd", &link).unwrap();
        let err = clear_regular(link.to_str().unwrap()).expect_err("symlink");
        assert!(matches!(err, ProviderError::PermissionDenied(_)));
        assert!(std::fs::symlink_metadata(&link).is_ok(), "left in place");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
