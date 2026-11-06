//! Agent state.
//!
//! One directory, four files, all 0600 inside a 0700 directory:
//!
//!   key.pem     the EC P-256 private key, generated on this host and never
//!               transmitted anywhere
//!   cert.pem    the client certificate the control plane signed, CN = the
//!               server's id
//!   ca.pem      the control plane's agent CA
//!   state.json  everything else the agent must remember across restarts
//!
//! Writes go through a temp file and a rename so a crash mid-write cannot
//! leave the agent with a half-written identity.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use p256::ecdsa::SigningKey;
use p256::pkcs8::DecodePrivateKey;
use serde::{Deserialize, Serialize};

pub const KEY_FILE: &str = "key.pem";
pub const CERT_FILE: &str = "cert.pem";
pub const CA_FILE: &str = "ca.pem";
pub const STATE_FILE: &str = "state.json";

/// The contents of state.json.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub server_id: String,
    /// The https origin used for token requests.
    #[serde(default)]
    pub control_plane_url: String,
    /// The wss endpoint the control plane assigned at enrollment.
    #[serde(default)]
    pub connect_url: String,
    /// Persisted so a host without /etc/machine-id still presents a stable
    /// identity across restarts.
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub agent_version: String,
    #[serde(default)]
    pub enrolled_at: Option<String>,
    #[serde(default)]
    pub cert_expires_at: Option<String>,
}

/// An opened state directory.
pub struct Store {
    dir: PathBuf,
    pub state: State,
}

/// Where a packaged agent keeps its identity.
pub fn default_state_dir() -> PathBuf {
    if cfg!(target_os = "linux") {
        PathBuf::from("/var/lib/kaname")
    } else {
        dirs_fallback()
    }
}

fn dirs_fallback() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|base| base.join("kaname"))
        .unwrap_or_else(|| PathBuf::from(".kaname"))
}

impl Store {
    /// Creates the state directory if needed and loads state.json.
    pub fn open(dir: Option<&Path>) -> anyhow::Result<Store> {
        let dir = match dir {
            Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
            _ => default_state_dir(),
        };
        let absolute = if dir.is_absolute() {
            dir
        } else {
            std::env::current_dir().context("resolve state dir")?.join(dir)
        };
        std::fs::create_dir_all(&absolute).with_context(|| format!("create state dir {}", absolute.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&absolute, std::fs::Permissions::from_mode(0o700));
        }

        let mut store = Store {
            dir: absolute,
            state: State::default(),
        };
        match std::fs::read(store.path(STATE_FILE)) {
            Ok(raw) => {
                store.state = serde_json::from_slice(&raw).with_context(|| format!("parse {STATE_FILE}"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("read {STATE_FILE}")),
        }
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Resolves one of the state directory's files.
    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Whether this host has a usable identity.
    pub fn enrolled(&self) -> bool {
        !self.state.server_id.is_empty()
            && [KEY_FILE, CERT_FILE, CA_FILE].iter().all(|f| self.path(f).is_file())
    }

    /// Writes state.json atomically.
    pub fn save(&self) -> anyhow::Result<()> {
        let mut raw = serde_json::to_vec_pretty(&self.state).context("encode state.json")?;
        raw.push(b'\n');
        self.write_file(STATE_FILE, &raw)
    }

    /// Writes one state file atomically with 0600 permissions.
    pub fn write_file(&self, name: &str, data: &[u8]) -> anyhow::Result<()> {
        use std::io::Write;
        let target = self.path(name);
        let temp = self.dir.join(format!(".{name}.{}", uuid::Uuid::new_v4().simple()));
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut f = options.open(&temp)?;
            f.write_all(data)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&temp, &target)?;
            if let Ok(d) = std::fs::File::open(&self.dir) {
                let _ = d.sync_all();
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.with_context(|| format!("install {name}"))
    }

    pub fn read_file(&self, name: &str) -> anyhow::Result<Vec<u8>> {
        std::fs::read(self.path(name)).with_context(|| format!("read {name}"))
    }

    /// Loads the host's enrolled key. It is read here and nowhere else, and
    /// it is never sent anywhere: only signatures made with it are.
    pub fn private_key(&self) -> anyhow::Result<SigningKey> {
        let raw = self.read_file(KEY_FILE)?;
        let pem = String::from_utf8(raw).context("key.pem is not text")?;
        if pem.contains("BEGIN EC PRIVATE KEY") {
            use p256::pkcs8::der::Decode;
            // SEC1: the spelling an older enrollment or a hand-made key may use.
            let (label, der) = pem_rfc7468::decode_vec(pem.as_bytes()).context("decode key.pem")?;
            if label != "EC PRIVATE KEY" {
                bail!("{KEY_FILE} holds an unexpected {label:?} block");
            }
            let sec1 = sec1::EcPrivateKey::from_der(&der).context("parse EC private key")?;
            return SigningKey::from_slice(sec1.private_key).context("parse EC private key");
        }
        if pem.contains("BEGIN PRIVATE KEY") {
            return SigningKey::from_pkcs8_pem(&pem).context("parse key.pem");
        }
        bail!("{KEY_FILE} does not contain a PEM private key")
    }

    /// Builds the client side of the TLS connection: this host's certificate,
    /// the system roots, and the control plane's agent CA. A self-hosted panel
    /// commonly serves TLS from the same internal CA that signed this agent,
    /// and that CA arrived over an already verified enrollment connection.
    pub fn tls_config(&self) -> anyhow::Result<Arc<rustls::ClientConfig>> {
        let cert_pem = self.read_file(CERT_FILE)?;
        let key_pem = self.read_file(KEY_FILE)?;

        let certs: Vec<rustls_pki_types::CertificateDer<'static>> =
            rustls_pemfile::certs(&mut &cert_pem[..]).collect::<Result<_, _>>().context("parse cert.pem")?;
        if certs.is_empty() {
            bail!("{CERT_FILE} holds no certificate");
        }
        let key = rustls_pemfile::private_key(&mut &key_pem[..])
            .context("parse key.pem")?
            .ok_or_else(|| anyhow::anyhow!("{KEY_FILE} holds no private key"))?;

        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Ok(ca) = self.read_file(CA_FILE) {
            for cert in rustls_pemfile::certs(&mut &ca[..]).flatten() {
                let _ = roots.add(cert);
            }
        }

        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(certs, key)
            .context("build client tls config")?;
        Ok(Arc::new(config))
    }

    /// Not-after of the installed certificate, as RFC 3339.
    pub fn certificate_expiry(&self) -> anyhow::Result<String> {
        let raw = self.read_file(CERT_FILE)?;
        let (label, der) = pem_rfc7468::decode_vec(&raw).context("decode cert.pem")?;
        if label != "CERTIFICATE" {
            bail!("{CERT_FILE} holds an unexpected {label:?} block");
        }
        let (_, cert) = x509_parser::parse_x509_certificate(&der).context("parse cert.pem")?;
        Ok(cert.validity().not_after.to_rfc2822().unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_directory_is_not_enrolled_and_state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(Some(dir.path())).unwrap();
        assert!(!store.enrolled());
        store.state.server_id = "abc".into();
        store.state.connect_url = "wss://panel/agent/v1/connect".into();
        store.save().unwrap();
        let again = Store::open(Some(dir.path())).unwrap();
        assert_eq!(again.state.server_id, "abc");
        assert!(!again.enrolled(), "an id without key material is not an identity");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(again.path(STATE_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
