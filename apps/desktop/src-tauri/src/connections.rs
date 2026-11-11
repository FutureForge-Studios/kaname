//! The saved panels ("connections"), kept as `connections.json` in the
//! app config dir. Nothing secret is written here: session tokens and API
//! keys live in the OS keyring (see `secrets.rs`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{DesktopError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Session,
    ApiKey,
}

/// What is stored on disk for one panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: bool,
    pub created_at: String,
    #[serde(default)]
    pub last_connected_at: Option<String>,
}

/// What the frontend sees: the stored record plus whether a credential
/// is held for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Connection {
    #[serde(flatten)]
    pub stored: StoredConnection,
    pub has_credential: bool,
}

/// No `Debug`: it can carry an API key.
#[derive(Clone, Deserialize)]
pub struct ConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: Option<bool>,
    /// Only for `api_key`; goes straight to the keyring.
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    connections: Vec<StoredConnection>,
}

const FILE_VERSION: u32 = 1;

pub struct ConnectionStore {
    path: PathBuf,
    inner: Mutex<Vec<StoredConnection>>,
}

impl ConnectionStore {
    /// Opens (or starts) the store at `dir/connections.json`. A file that
    /// cannot be parsed is set aside as `connections.json.corrupt-<ts>`
    /// rather than silently overwritten.
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("connections.json");
        let connections = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<FileFormat>(&bytes) {
                Ok(file) => file.connections,
                Err(_) => {
                    let aside = dir.join(format!(
                        "connections.json.corrupt-{}",
                        chrono::Utc::now().timestamp()
                    ));
                    fs::rename(&path, &aside).map_err(|e| {
                        DesktopError::storage(format!(
                            "connections.json is unreadable and could not be moved aside: {e}"
                        ))
                    })?;
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                return Err(DesktopError::storage(format!(
                    "Could not read {}: {e}",
                    path.display()
                )))
            }
        };
        Ok(Self {
            path,
            inner: Mutex::new(connections),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> Vec<StoredConnection> {
        self.lock().clone()
    }

    pub fn get(&self, id: &str) -> Result<StoredConnection> {
        self.lock()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| DesktopError::not_found("No such connection."))
    }

    /// Inserts or replaces by id, then persists.
    pub fn upsert(&self, conn: StoredConnection) -> Result<()> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        match next.iter_mut().find(|c| c.id == conn.id) {
            Some(slot) => *slot = conn,
            None => next.push(conn),
        }
        self.write(&next)?;
        *guard = next;
        Ok(())
    }

    /// Applies `f` to one connection and persists.
    pub fn update<F>(&self, id: &str, f: F) -> Result<StoredConnection>
    where
        F: FnOnce(&mut StoredConnection),
    {
        let mut guard = self.lock();
        let mut next = guard.clone();
        let slot = next
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| DesktopError::not_found("No such connection."))?;
        f(slot);
        let updated = slot.clone();
        self.write(&next)?;
        *guard = next;
        Ok(updated)
    }

    /// Removes by id; returns whether it existed.
    pub fn remove(&self, id: &str) -> Result<bool> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        let before = next.len();
        next.retain(|c| c.id != id);
        if next.len() == before {
            return Ok(false);
        }
        self.write(&next)?;
        *guard = next;
        Ok(true)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<StoredConnection>> {
        // A panic while holding the lock leaves valid data behind (we only
        // swap in fully built vectors), so a poisoned lock is still usable.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Atomic replace: write a sibling temp file, fsync, rename over.
    fn write(&self, connections: &[StoredConnection]) -> Result<()> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| DesktopError::storage("The connections file has no directory."))?;
        fs::create_dir_all(dir).map_err(|e| {
            DesktopError::storage(format!("Could not create {}: {e}", dir.display()))
        })?;

        let file = FileFormat {
            version: FILE_VERSION,
            connections: connections.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|e| DesktopError::storage(format!("Could not encode connections: {e}")))?;

        let tmp = dir.join(format!(
            ".connections.json.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let result = (|| -> std::io::Result<()> {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, &self.path)?;
            #[cfg(unix)]
            if let Ok(d) = fs::File::open(dir) {
                let _ = d.sync_all();
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(DesktopError::storage(format!(
                "Could not save {}: {e}",
                self.path.display()
            )));
        }
        Ok(())
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Normalises what an operator typed into a panel origin:
/// `panel.example.com` → `https://panel.example.com`,
/// `https://panel.example.com/api/v1/` → `https://panel.example.com`.
/// Anything with a path other than the API root, credentials, a query or a
/// fragment is refused, since the panel is always served from its origin.
pub fn normalize_base_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::invalid_input("Enter the panel's address."));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let bad = || {
        DesktopError::invalid_input(
            "Enter the panel's address, for example https://panel.example.com.",
        )
    };
    let url = Url::parse(&candidate).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(DesktopError::invalid_input(
            "The panel address must start with https:// or http://.",
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(bad());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(DesktopError::invalid_input(
            "Do not put a user name or password in the panel address.",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad());
    }
    let path = url.path().trim_end_matches('/');
    if !(path.is_empty() || path == "/api/v1" || path == "/api") {
        return Err(DesktopError::invalid_input(
            "Use the panel's address without a path, for example https://panel.example.com.",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

pub fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(DesktopError::invalid_input("Give the connection a name."));
    }
    if name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(DesktopError::invalid_input(
            "Use a name of at most 100 characters.",
        ));
    }
    Ok(name.to_string())
}

pub fn clean_optional(value: Option<String>, max: usize, what: &str) -> Result<Option<String>> {
    match value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        None => Ok(None),
        Some(v) if v.chars().count() > max || v.chars().any(char::is_control) => Err(
            DesktopError::invalid_input(format!("That {what} is not valid.")),
        ),
        Some(v) => Ok(Some(v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> StoredConnection {
        StoredConnection {
            id: id.into(),
            name: "Production".into(),
            base_url: "https://panel.example.com".into(),
            auth_kind: AuthKind::Session,
            email: Some("ops@example.com".into()),
            color: Some("#5B76F7".into()),
            accept_invalid_certs: false,
            created_at: now_iso(),
            last_connected_at: None,
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::open(dir.path()).unwrap();
        assert!(store.list().is_empty());

        store.upsert(sample("a")).unwrap();
        store.upsert(sample("b")).unwrap();
        store.update("a", |c| c.name = "Staging".into()).unwrap();

        let reopened = ConnectionStore::open(dir.path()).unwrap();
        let list = reopened.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].name, "Staging");
        assert_eq!(list[1], sample_with_created(&list[1]));

        assert!(reopened.remove("a").unwrap());
        assert!(!reopened.remove("a").unwrap());
        let again = ConnectionStore::open(dir.path()).unwrap();
        assert_eq!(again.list().len(), 1);
        assert!(again.get("a").is_err());

        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    fn sample_with_created(c: &StoredConnection) -> StoredConnection {
        StoredConnection {
            created_at: c.created_at.clone(),
            ..sample("b")
        }
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("connections.json"), b"{not json").unwrap();
        let store = ConnectionStore::open(dir.path()).unwrap();
        assert!(store.list().is_empty());
        let aside = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("connections.json.corrupt-")
            });
        assert!(aside);
    }

    #[test]
    fn serializes_connection_flat_with_snake_case() {
        let c = Connection {
            stored: StoredConnection {
                auth_kind: AuthKind::ApiKey,
                ..sample("x")
            },
            has_credential: true,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["auth_kind"], "api_key");
        assert_eq!(v["has_credential"], true);
        assert_eq!(v["base_url"], "https://panel.example.com");
        assert!(v["last_connected_at"].is_null());
    }

    #[test]
    fn normalizes_base_urls() {
        let ok = |s: &str| normalize_base_url(s).unwrap();
        assert_eq!(ok("panel.example.com"), "https://panel.example.com");
        assert_eq!(
            ok("https://Panel.Example.com/"),
            "https://panel.example.com"
        );
        assert_eq!(
            ok("https://panel.example.com/api/v1/"),
            "https://panel.example.com"
        );
        assert_eq!(ok("http://10.0.0.5:8080"), "http://10.0.0.5:8080");
        assert_eq!(
            ok("https://panel.example.com:443"),
            "https://panel.example.com"
        );
        assert_eq!(ok("http://[::1]:3000"), "http://[::1]:3000");

        for bad in [
            "",
            "ftp://panel.example.com",
            "https://user:pw@panel.example.com",
            "https://panel.example.com/admin",
            "https://panel.example.com/?x=1",
            "https://panel.example.com/#frag",
            "javascript:alert(1)",
        ] {
            let err = normalize_base_url(bad).unwrap_err();
            assert_eq!(err.code, "invalid_input", "{bad}");
        }
    }

    #[test]
    fn validates_names_and_optionals() {
        assert_eq!(validate_name("  Prod  ").unwrap(), "Prod");
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"x".repeat(101)).is_err());
        assert_eq!(clean_optional(Some("  ".into()), 10, "x").unwrap(), None);
        assert!(clean_optional(Some("a\nb".into()), 10, "x").is_err());
    }
}
