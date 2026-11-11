//! Session tokens and API keys, kept in the OS keyring.
//!
//! Entries live under service `io.ffstudios.kaname.desktop`, account
//! `<connection_id>:session` or `<connection_id>:api_key`. If no keyring
//! is available every write fails with code `keyring`: a credential is
//! never written to disk in plaintext as a fallback.
//!
//! A session from a sign-in without "remember me" is held only in memory
//! for the life of the process, which is what the browser does with a
//! cookie that has no expiry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use crate::error::{DesktopError, Result};

pub const SERVICE: &str = "io.ffstudios.kaname.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Session,
    ApiKey,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            SecretKind::Session => "session",
            SecretKind::ApiKey => "api_key",
        }
    }
}

pub fn account(connection_id: &str, kind: SecretKind) -> String {
    format!("{connection_id}:{}", kind.suffix())
}

/// A place secrets are persisted. Blocking; callers run it off the async
/// runtime.
pub trait SecretBackend: Send + Sync + 'static {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>>;
    fn set(&self, account: &str, secret: &str) -> Result<()>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, account: &str) -> Result<()>;
}

/// The real thing: Keychain, Credential Manager or Secret Service.
pub struct KeyringBackend;

impl KeyringBackend {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, account).map_err(keyring_error)
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        match Self::entry(account)?.get_password() {
            Ok(s) => Ok(Some(Zeroizing::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_error(e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(keyring_error)
    }

    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_error(e)),
        }
    }
}

fn keyring_error(e: keyring::Error) -> DesktopError {
    // The keyring's messages describe the store, never the secret.
    DesktopError::keyring(format!("The system keychain is not available: {e}"))
}

/// For tests and for platforms where a test wants no OS keychain.
#[derive(Default)]
pub struct MemoryBackend {
    map: Mutex<HashMap<String, Zeroizing<String>>>,
    /// When set, every call fails like an unavailable keyring.
    pub unavailable: bool,
}

impl MemoryBackend {
    pub fn unavailable() -> Self {
        Self {
            map: Mutex::default(),
            unavailable: true,
        }
    }

    fn check(&self) -> Result<()> {
        if self.unavailable {
            Err(DesktopError::keyring(
                "The system keychain is not available.",
            ))
        } else {
            Ok(())
        }
    }
}

impl SecretBackend for MemoryBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        self.check()?;
        Ok(self.map.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.check()?;
        self.map
            .lock()
            .unwrap()
            .insert(account.to_string(), Zeroizing::new(secret.to_string()));
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.check()?;
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
}

/// The keyring plus an in-memory cache, so a request does not cost a
/// keychain round trip, and a home for non-persistent sessions.
pub struct Secrets {
    backend: Arc<dyn SecretBackend>,
    cache: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl Secrets {
    pub fn new(backend: Arc<dyn SecretBackend>) -> Self {
        Self {
            backend,
            cache: Mutex::default(),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, Zeroizing<String>>> {
        self.cache.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub async fn get(&self, id: &str, kind: SecretKind) -> Result<Option<Zeroizing<String>>> {
        let acct = account(id, kind);
        if let Some(hit) = self.cache().get(&acct).cloned() {
            return Ok(Some(hit));
        }
        // Misses are not cached, so an entry restored in the keychain by
        // other means is picked up.
        let backend = self.backend.clone();
        let key = acct.clone();
        let found = blocking(move || backend.get(&key)).await?;
        if let Some(s) = &found {
            self.cache().insert(acct, s.clone());
        }
        Ok(found)
    }

    /// Whether a credential is held, without failing: an unavailable
    /// keyring simply means "no".
    pub async fn has(&self, id: &str, kind: SecretKind) -> bool {
        matches!(self.get(id, kind).await, Ok(Some(_)))
    }

    /// Stores a secret. With `persist == false` it lives in memory only and
    /// any persisted copy is removed.
    pub async fn set(&self, id: &str, kind: SecretKind, secret: &str, persist: bool) -> Result<()> {
        let acct = account(id, kind);
        let backend = self.backend.clone();
        let key = acct.clone();
        if persist {
            let value = Zeroizing::new(secret.to_string());
            blocking(move || backend.set(&key, &value)).await?;
        } else {
            // Best effort: an older remembered session must not outlive
            // this one, but a missing keyring must not block a sign-in
            // that never asked to be remembered.
            let _ = blocking(move || backend.delete(&key)).await;
        }
        self.cache()
            .insert(acct, Zeroizing::new(secret.to_string()));
        Ok(())
    }

    pub async fn delete(&self, id: &str, kind: SecretKind) -> Result<()> {
        let acct = account(id, kind);
        self.cache().remove(&acct);
        let backend = self.backend.clone();
        blocking(move || backend.delete(&acct)).await
    }

    /// Forgets everything about a connection. Reports the first failure
    /// after attempting both.
    pub async fn delete_all(&self, id: &str) -> Result<()> {
        let a = self.delete(id, SecretKind::Session).await;
        let b = self.delete(id, SecretKind::ApiKey).await;
        a.and(b)
    }
}

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| DesktopError::keyring(format!("The keychain call did not finish: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn set_get_delete_with_cache() {
        let backend = Arc::new(MemoryBackend::default());
        let secrets = Secrets::new(backend.clone());
        assert!(secrets
            .get("c1", SecretKind::Session)
            .await
            .unwrap()
            .is_none());

        secrets
            .set("c1", SecretKind::Session, "kaname_session=abc", true)
            .await
            .unwrap();
        assert_eq!(
            backend
                .get("c1:session")
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("kaname_session=abc")
        );
        assert_eq!(
            secrets
                .get("c1", SecretKind::Session)
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("kaname_session=abc")
        );

        secrets.delete_all("c1").await.unwrap();
        assert!(!secrets.has("c1", SecretKind::Session).await);
        assert!(backend.get("c1:session").unwrap().is_none());
    }

    #[tokio::test]
    async fn non_persistent_sessions_stay_in_memory() {
        let backend = Arc::new(MemoryBackend::default());
        let secrets = Secrets::new(backend.clone());
        secrets
            .set("c1", SecretKind::Session, "tok", false)
            .await
            .unwrap();
        assert!(secrets.has("c1", SecretKind::Session).await);
        assert!(backend.get("c1:session").unwrap().is_none());
    }

    #[tokio::test]
    async fn unavailable_keyring_fails_with_keyring_code() {
        let secrets = Secrets::new(Arc::new(MemoryBackend::unavailable()));
        let err = secrets
            .set("c1", SecretKind::ApiKey, "kn_key", true)
            .await
            .unwrap_err();
        assert_eq!(err.code, "keyring");
        assert!(!secrets.has("c1", SecretKind::ApiKey).await);
    }
}
