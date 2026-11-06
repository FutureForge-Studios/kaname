//! Enrollment.
//!
//! The keypair is generated here, on the managed host, and the private half
//! never leaves it — only a CSR is transmitted. The control plane signs it
//! with CN = the server's id, which is how every later connection is bound
//! to one row in the panel (PLAN.md 2.3).

use std::time::Duration;

use anyhow::{Context, bail};
use p256::ecdsa::SigningKey;
use p256::pkcs8::EncodePrivateKey;
use serde::{Deserialize, Serialize};

use crate::providers::HostInfo;
use crate::state::{CA_FILE, CERT_FILE, KEY_FILE, Store};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The body of POST /agent/v1/enroll.
#[derive(Serialize)]
struct EnrollRequest<'a> {
    token: &'a str,
    csr_pem: String,
    host: &'a HostInfo,
    agent_version: &'a str,
}

/// What the control plane returns once the CSR is signed.
#[derive(Deserialize)]
struct EnrollResponse {
    server_id: String,
    certificate_pem: String,
    ca_pem: String,
    connect_url: String,
    #[serde(default)]
    expires_at: Option<String>,
}

pub struct EnrollOptions {
    pub token: String,
    pub control_plane_url: String,
    pub agent_version: String,
    pub host: HostInfo,
}

/// Enrolls this host and persists the resulting identity.
pub async fn run(store: &mut Store, opts: EnrollOptions) -> anyhow::Result<()> {
    if opts.token.is_empty() {
        bail!("an enrollment token is required");
    }
    if opts.control_plane_url.is_empty() {
        bail!("the control plane url is required");
    }

    let mut host = opts.host;
    if host.machine_id.is_empty() {
        host.machine_id = stable_machine_id(store);
    }

    let key = SigningKey::random(&mut rand::thread_rng());
    let csr_pem = certificate_request(&key, &host.hostname)?;
    let key_pem = key
        .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
        .context("encode host key")?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("build http client")?;
    let endpoint = crate::conn::join_url(&opts.control_plane_url, "/agent/v1/enroll")?;
    let response = client
        .post(&endpoint)
        .json(&EnrollRequest {
            token: &opts.token,
            csr_pem,
            host: &host,
            agent_version: &opts.agent_version,
        })
        .send()
        .await
        .with_context(|| format!("enroll against {endpoint}"))?;
    let status = response.status();
    let raw = response.bytes().await.context("read enrollment response")?;
    if !status.is_success() {
        bail!(
            "enrollment rejected (http {}): {}",
            status.as_u16(),
            String::from_utf8_lossy(&raw)
        );
    }
    let out: EnrollResponse = serde_json::from_slice(&raw).context("decode enrollment response")?;
    if out.server_id.is_empty() || out.certificate_pem.is_empty() || out.ca_pem.is_empty() || out.connect_url.is_empty() {
        bail!("enrollment response is missing an identity field");
    }

    store.write_file(KEY_FILE, key_pem.as_bytes())?;
    store.write_file(CERT_FILE, out.certificate_pem.as_bytes())?;
    store.write_file(CA_FILE, out.ca_pem.as_bytes())?;

    store.state.server_id = out.server_id.clone();
    store.state.control_plane_url = opts.control_plane_url.trim_end_matches('/').to_string();
    store.state.connect_url = out.connect_url.clone();
    store.state.machine_id = host.machine_id.clone();
    store.state.agent_version = opts.agent_version.clone();
    store.state.enrolled_at = Some(crate::wire::now_rfc3339());
    store.state.cert_expires_at = out.expires_at.clone();
    store.save()?;

    tracing::info!(
        server_id = out.server_id,
        hostname = host.hostname,
        connect_url = out.connect_url,
        cert_expires_at = ?out.expires_at,
        "enrolled"
    );
    Ok(())
}

/// A PEM CSR. The subject is advisory: the control plane overwrites it with
/// CN = server id, because an agent does not get to name itself.
pub fn certificate_request(key: &SigningKey, hostname: &str) -> anyhow::Result<String> {
    use x509_cert::builder::{Builder, RequestBuilder};
    use x509_cert::der::EncodePem;
    use x509_cert::name::Name;

    let subject_name = if hostname.is_empty() { "kanamed".to_string() } else { hostname.to_string() };
    let subject: Name = format!("CN={},O=Kaname Agents", escape_rdn(&subject_name))
        .parse()
        .context("build csr subject")?;
    let mut builder = RequestBuilder::new(subject, key).context("start csr")?;
    if !hostname.is_empty() {
        if let Ok(name) = x509_cert::der::asn1::Ia5String::new(hostname) {
            let san = x509_cert::ext::pkix::SubjectAltName(vec![x509_cert::ext::pkix::name::GeneralName::DnsName(name)]);
            let _ = builder.add_extension(&san);
        }
    }
    let csr = builder
        .build::<p256::ecdsa::DerSignature>()
        .context("sign csr")?;
    csr.to_pem(x509_cert::der::pem::LineEnding::LF).context("encode csr")
}

fn escape_rdn(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(',', "\\,")
        .replace('+', "\\+")
        .replace('=', "\\=")
}

/// Reuses the id from a previous enrollment, or mints one for a host that
/// has no /etc/machine-id, so the panel does not see a new machine on every
/// restart.
fn stable_machine_id(store: &Store) -> String {
    if !store.state.machine_id.is_empty() {
        return store.state.machine_id.clone();
    }
    let probed = hostprobe::read_machine_id();
    if !probed.is_empty() {
        return probed;
    }
    let mut buf = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    hex::encode(buf)
}

/// Reads the facts that identify this machine. Enrollment runs before a
/// provider is chosen, so this deliberately uses nothing but the files
/// every Linux host has.
pub mod hostprobe {
    use crate::providers::HostInfo;

    pub fn probe_host() -> anyhow::Result<HostInfo> {
        let hostname = nix::unistd::gethostname()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "localhost".into());
        let mut info = HostInfo {
            hostname,
            machine_id: read_machine_id(),
            os: std::env::consts::OS.to_string(),
            os_version: String::new(),
            arch: go_arch(std::env::consts::ARCH).to_string(),
            kernel: read_trimmed("/proc/sys/kernel/osrelease"),
            boot_time: boot_time(),
            simulated: false,
        };
        let release = parse_os_release(&std::fs::read_to_string("/etc/os-release").unwrap_or_default());
        if let Some(id) = release.get("ID").filter(|v| !v.is_empty()) {
            info.os = id.clone();
        }
        if let Some(v) = release.get("VERSION_ID").filter(|v| !v.is_empty()) {
            info.os_version = v.clone();
        }
        Ok(info)
    }

    /// The contract spells architectures the way Go does, because the
    /// release assets are named `kanamed-linux-amd64` and friends.
    pub fn go_arch(arch: &str) -> &str {
        match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            "arm" => "arm",
            "riscv64" => "riscv64",
            other => other,
        }
    }

    pub fn read_machine_id() -> String {
        for candidate in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            let id = read_trimmed(candidate);
            if !id.is_empty() {
                return id;
            }
        }
        String::new()
    }

    pub fn parse_os_release(raw: &str) -> std::collections::HashMap<String, String> {
        let mut out = std::collections::HashMap::new();
        for line in raw.lines() {
            if let Some((k, v)) = line.trim().split_once('=') {
                out.insert(k.to_string(), v.trim_matches('"').to_string());
            }
        }
        out
    }

    pub fn boot_time() -> String {
        let uptime = read_trimmed("/proc/uptime");
        let secs: f64 = uptime.split(' ').next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let boot = chrono::Utc::now() - chrono::Duration::milliseconds((secs * 1000.0) as i64);
        boot.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    pub fn read_trimmed(path: &str) -> String {
        std::fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csr_is_pem_and_signed_by_the_key() {
        let key = SigningKey::random(&mut rand::thread_rng());
        let pem = certificate_request(&key, "host.example").unwrap();
        assert!(pem.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
        let (_, der) = pem_rfc7468::decode_vec(pem.as_bytes()).unwrap();
        use x509_parser::prelude::FromDer;
        let (_, csr) = x509_parser::certification_request::X509CertificationRequest::from_der(&der).unwrap();
        assert!(csr.certification_request_info.subject.to_string().contains("host.example"));
        csr.verify_signature().unwrap();
    }

    #[test]
    fn os_release_parses_quoted_values() {
        let kv = hostprobe::parse_os_release("ID=\"ubuntu\"\nVERSION_ID=\"24.04\"\n");
        assert_eq!(kv["ID"], "ubuntu");
        assert_eq!(hostprobe::go_arch("x86_64"), "amd64");
    }
}
