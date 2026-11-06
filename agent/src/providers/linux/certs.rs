//! Certificates.
//!
//! Issuance and renewal are certbot's job; this file only ever hands it
//! an argv slice. Listing does not need certbot at all — the certificates
//! on disk are parsed directly, so a host that got its certificate some
//! other way still shows an honest expiry in the panel.
//!
//! DNS-01 is deliberately not driven from here: authoritative record
//! writes belong to the control plane's DNS provider (PLAN.md 2.4), and
//! an agent that could edit a zone would be a much larger blast radius
//! than one that cannot.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

use super::Shared;
use super::common::{epoch_rfc3339, invalid, unsupported};
use super::exec::{ExecOptions, exec_error, file_exists, first_existing, run_stream, run_with, write_atomic};
use super::paths::{validate_path, wrap_fs_error};
use crate::providers::*;

pub const LETS_ENCRYPT_DIR: &str = "/etc/letsencrypt/live";
/// Where externally-issued material installed through cert.install lands,
/// so the panel has one predictable place to point a web server at.
pub const INSTALLED_CERT_DIR: &str = "/etc/ssl/kaname";

pub struct CertOps(pub Arc<Shared>);

#[async_trait]
impl Certs for CertOps {
    async fn list(&self, ctx: &Ctx) -> PResult<Vec<CertificateInfo>> {
        let mut certificates = Vec::with_capacity(8);
        let mut seen: HashSet<String> = HashSet::new();

        for root in [LETS_ENCRYPT_DIR, INSTALLED_CERT_DIR] {
            let Ok(entries) = std::fs::read_dir(root) else {
                continue;
            };
            for entry in entries.flatten() {
                ctx.check()?;
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let dir = entry.path();
                let fullchain = dir.join("fullchain.pem");
                let cert = dir.join("cert.pem");
                let Some(target) = first_existing(&[
                    fullchain.to_str().unwrap_or_default(),
                    cert.to_str().unwrap_or_default(),
                ]) else {
                    continue;
                };
                let info = match read_certificate(target) {
                    Ok(info) => info,
                    Err(err) => {
                        tracing::debug!(path = target, error = %err, "unreadable certificate");
                        continue;
                    }
                };
                let key = format!("{}{}", info.subject, info.not_after);
                if !seen.insert(key) {
                    continue;
                }
                certificates.push(info);
            }
        }

        certificates.sort_by(|a, b| a.not_after.cmp(&b.not_after));
        Ok(certificates)
    }

    async fn issue(&self, ctx: &Ctx, p: CertIssueParams, s: StreamRef) -> PResult<CertIssueResult> {
        self.0.require(cap::CERTBOT)?;
        if p.challenge == "dns-01" {
            return Err(unsupported(
                "dns-01 issuance is driven by the control plane's DNS provider, not by the agent",
            ));
        }
        if p.domains.is_empty() {
            return Err(invalid("at least one domain is required"));
        }
        for domain in &p.domains {
            check_domain(domain)?;
        }

        let name = p.domains[0].clone();
        let mut args: Vec<String> = [
            "certonly",
            "--non-interactive",
            "--agree-tos",
            "--keep-until-expiring",
            "--email",
            &p.email,
            "--cert-name",
            &name,
            "--key-type",
            &p.key_type,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        match p.webroot.as_deref().filter(|w| !w.is_empty()) {
            Some(webroot) => {
                let webroot = validate_path(webroot)?;
                args.extend(["--webroot".to_string(), "-w".to_string(), webroot]);
            }
            None if self.0.has(cap::NGINX) => args.push("--nginx".into()),
            None => args.push("--standalone".into()),
        }
        if p.staging {
            args.push("--staging".into());
        }
        for domain in &p.domains {
            args.push("-d".into());
            args.push(domain.clone());
        }

        let out = run_stream(
            ctx,
            s.as_ref(),
            ExecOptions::new("certbot", args).c_locale(),
            None,
        )
        .await?;
        if !out.success() {
            return Err(exec_error("certbot", &out.stdout, out.code));
        }

        let issued = read_certificate(&format!("{LETS_ENCRYPT_DIR}/{name}/fullchain.pem"))?;
        Ok(CertIssueResult {
            subject: issued.subject,
            sans: issued.sans,
            not_after: issued.not_after,
            path: issued.path,
        })
    }

    async fn renew(&self, ctx: &Ctx, p: CertRenewParams, s: StreamRef) -> PResult<CertRenewResult> {
        self.0.require(cap::CERTBOT)?;
        check_domain(&p.subject)?;

        let mut args = vec![
            "renew".to_string(),
            "--non-interactive".into(),
            "--cert-name".into(),
            p.subject.clone(),
        ];
        if p.force {
            args.push("--force-renewal".into());
        }
        let out = run_stream(
            ctx,
            s.as_ref(),
            ExecOptions::new("certbot", args).c_locale(),
            None,
        )
        .await?;
        if !out.success() {
            return Err(exec_error("certbot", &out.stdout, out.code));
        }

        let renewed = read_certificate(&format!("{LETS_ENCRYPT_DIR}/{}/fullchain.pem", p.subject))?;
        Ok(CertRenewResult {
            not_after: renewed.not_after,
        })
    }

    async fn revoke(&self, ctx: &Ctx, p: CertRevokeParams) -> PResult<()> {
        self.0.require(cap::CERTBOT)?;
        check_domain(&p.subject)?;
        check_revocation_reason(&p.reason)?;

        run_with(
            ctx,
            ExecOptions::new(
                "certbot",
                [
                    "revoke",
                    "--non-interactive",
                    "--cert-name",
                    &p.subject,
                    "--reason",
                    &p.reason,
                    "--delete-after-revoke",
                ],
            )
            .c_locale(),
        )
        .await?;
        Ok(())
    }

    async fn install(&self, ctx: &Ctx, p: CertInstallParams) -> PResult<CertInstallResult> {
        ctx.check()?;
        check_domain(&p.subject)?;
        if let Err(err) = parse_pem_chain(p.certificate_pem.as_bytes()) {
            return Err(invalid(format!(
                "certificate_pem is not a valid certificate: {err}"
            )));
        }
        if !has_pem_block(p.key_pem.as_bytes()) {
            return Err(invalid("key_pem does not contain a PEM block"));
        }

        let dir = format!("{INSTALLED_CERT_DIR}/{}", p.subject);
        std::fs::create_dir_all(&dir).map_err(|e| wrap_fs_error(&dir, e))?;

        let chain = match p.chain_pem.as_deref().filter(|c| !c.is_empty()) {
            Some(chain_pem) => format!("{}\n{chain_pem}", p.certificate_pem.trim_end_matches('\n')),
            None => p.certificate_pem.clone(),
        };

        // The private key is the one file here that must never be world
        // readable, so it is written 0600 while the chain stays 0644.
        let files: [(&str, &str, u32); 3] = [
            ("cert.pem", &p.certificate_pem, 0o644),
            ("fullchain.pem", &chain, 0o644),
            ("privkey.pem", &p.key_pem, 0o600),
        ];
        for (name, data, mode) in files {
            let target = format!("{dir}/{name}");
            write_atomic(Path::new(&target), data.as_bytes(), mode).map_err(|e| wrap_fs_error(&target, e))?;
        }

        Ok(CertInstallResult {
            path: format!("{dir}/fullchain.pem"),
        })
    }
}

/* ------------------------------- parsing ----------------------------- */

pub fn read_certificate(target: &str) -> PResult<CertificateInfo> {
    let raw = std::fs::read(target).map_err(|e| wrap_fs_error(target, e))?;
    let mut info =
        parse_certificate(&raw).map_err(|e| ProviderError::internal(format!("parse {target}: {e}")))?;
    info.path = target.to_string();
    Ok(info)
}

/// The leaf of a PEM chain as a CertificateInfo, with `path` left for the
/// caller to fill.
pub fn parse_certificate(raw: &[u8]) -> Result<CertificateInfo, String> {
    let der = parse_pem_chain(raw)?;
    let (_, certificate) = X509Certificate::from_der(&der).map_err(|e| e.to_string())?;

    let mut sans = Vec::new();
    if let Ok(Some(extension)) = certificate.subject_alternative_name() {
        for name in &extension.value.general_names {
            match name {
                GeneralName::DNSName(dns) => sans.push(dns.to_string()),
                GeneralName::IPAddress(octets) => match octets.len() {
                    4 => sans.push(
                        std::net::Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]).to_string(),
                    ),
                    16 => {
                        let mut bytes = [0u8; 16];
                        bytes.copy_from_slice(octets);
                        sans.push(std::net::Ipv6Addr::from(bytes).to_string());
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    Ok(CertificateInfo {
        subject: common_name(certificate.subject()),
        sans,
        issuer: common_name(certificate.issuer()),
        not_before: epoch_rfc3339(certificate.validity().not_before.timestamp()),
        not_after: epoch_rfc3339(certificate.validity().not_after.timestamp()),
        path: String::new(),
        key_type: key_type(&certificate),
    })
}

fn common_name(name: &X509Name<'_>) -> String {
    name.iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Returns the DER of the leaf, which in a fullchain file is always the
/// first certificate.
pub fn parse_pem_chain(raw: &[u8]) -> Result<Vec<u8>, String> {
    for pem in Pem::iter_from_buffer(raw) {
        let pem = pem.map_err(|e| e.to_string())?;
        if pem.label != "CERTIFICATE" {
            continue;
        }
        return Ok(pem.contents);
    }
    Err("no CERTIFICATE block found".to_string())
}

/// Whether the bytes hold at least one PEM block of any label, which is
/// all that can be said about a private key without parsing it.
pub fn has_pem_block(raw: &[u8]) -> bool {
    matches!(Pem::iter_from_buffer(raw).next(), Some(Ok(_)))
}

fn key_type(certificate: &X509Certificate<'_>) -> String {
    let spki = certificate.public_key();
    match spki.parsed() {
        Ok(PublicKey::RSA(key)) => format!("rsa-{}", key.key_size()),
        Ok(PublicKey::EC(point)) => format!("ecdsa-{}", point.key_size()),
        _ => {
            if spki.algorithm.algorithm == oid_registry::OID_SIG_ED25519 {
                "ed25519".to_string()
            } else {
                "unknown".to_string()
            }
        }
    }
}

/* ------------------------------ validation --------------------------- */

/// Accepts a hostname or a wildcard label and nothing that could be read
/// as a flag or a path segment.
pub fn check_domain(domain: &str) -> PResult<()> {
    let bad = || invalid(format!("{domain:?} is not a usable domain name"));
    if domain.is_empty() || domain.len() > 253 || domain.starts_with('-') {
        return Err(bad());
    }
    if domain.contains(['/', '\\', ' ', '\0']) {
        return Err(bad());
    }

    for label in domain.strip_suffix('.').unwrap_or(domain).split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(bad());
        }
        if label == "*" {
            continue;
        }
        for c in label.bytes() {
            match c {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => {}
                _ => return Err(bad()),
            }
        }
    }
    Ok(())
}

pub fn check_revocation_reason(reason: &str) -> PResult<()> {
    match reason {
        "unspecified" | "keycompromise" | "affiliationchanged" | "superseded" | "cessationofoperation" => {
            Ok(())
        }
        _ => Err(invalid(format!(
            "reason {reason:?} is not an ACME revocation reason"
        ))),
    }
}

/// Reports where a subject's material lives, preferring Let's Encrypt's
/// layout and falling back to what cert.install wrote.
pub fn certificate_paths(subject: &str) -> Option<(String, String)> {
    for root in [LETS_ENCRYPT_DIR, INSTALLED_CERT_DIR] {
        let chain = format!("{root}/{subject}/fullchain.pem");
        let key = format!("{root}/{subject}/privkey.pem");
        if file_exists(&chain) && file_exists(&key) {
            return Some((chain, key));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const EC_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIBtzCCAV6gAwIBAgIUbLOB7Gu+wLOF88DZGZ4B1CERDC0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MCAXDTI2MTEwNjEzMTE1MFoYDzIxMjYx
MDEzMTMxMTUwWjAXMRUwEwYDVQQDDAxleGFtcGxlLnRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAS/+qY73IFbTKbyufyVGRoCp2v3XMnGfoXJAI+GYucIFG5f
UUL+3oE5m7bW3KETlzfSTVDfS6dHvjXYb8Jcze+ho4GFMIGCMB0GA1UdDgQWBBTY
zxO4+ZfG40ob7XJQMeBIWvNeJzAfBgNVHSMEGDAWgBTYzxO4+ZfG40ob7XJQMeBI
WvNeJzAPBgNVHRMBAf8EBTADAQH/MC8GA1UdEQQoMCaCDGV4YW1wbGUudGVzdIIQ
d3d3LmV4YW1wbGUudGVzdIcEywBxBzAKBggqhkjOPQQDAgNHADBEAiAzwhSnTksh
68MNhSPyeYUMkNMWKB7cyXlPUUKvsS99lAIgD+Jqy/t9v49PUrvf15mNx4co1a1U
DZ8+LC+M3B3qW+U=
-----END CERTIFICATE-----
";

    const RSA_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUREegYu7HdxZLwIIDzoEUJprPFpcwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQcnNhLmV4YW1wbGUudGVzdDAgFw0yNjExMDYxMzExNTFa
GA8yMTI2MTAxMzEzMTE1MVowGzEZMBcGA1UEAwwQcnNhLmV4YW1wbGUudGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIqPO7mv8/jZQB+Kfoce9q30
iKpzWIEoiQEdKyGVUag9UII7fnBw1TTRY+cWZPYbfvIMvgrQvki2fXFQOylEB3qS
FHMU2rpr/NPPArcCS5e9eVJvBbBZukqWGaI59yNWqy5bQf6dw3uU9MZpPbLWFroz
ghDt2PQw8CVCJNCbmFqOn95pnRqMoNY+m/R3lxZi5Ve8r+s6vQBsSX/FeW8BW56p
wYjxVOt4ZAq0zurQ5SdWbnf0fcjEmuHUcXBjcpYFscYx/BjREgoPbixZ3siCZYro
THI5fnnGzwygio2zm+rLKa70YzjG50OCnh6IATJBjd0YJuJZv6E97HzcLIMtuGEC
AwEAAaNTMFEwHQYDVR0OBBYEFPV05sCzohbMkdlAdLbPLhJ0aTu4MB8GA1UdIwQY
MBaAFPV05sCzohbMkdlAdLbPLhJ0aTu4MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBADOXhTJMWOzUge8Krmjg8JtQAnV46N3l64cxj7lqE88nF8qT
r9qDlnRwwDvhty6iQewwavruAX7GAhNMcaPP6CH77PfIPpqLMZR6Ih3AAB9GSu2j
2jpxx5+3uqIB5f0JVvU+cVCtVsAxv5UaUCSEr+NUX/hYLIcZAv/Nm1kMpMKne1zN
MNx02yPmD9qXEZob6qZsNEFFd3kOZA+b8ZN4pG6impPkldzg1jZRg27lAf/bbLBL
0rbgHu00f37tDeBzqHxLq30TRSlnfF576TS7UxeLx2kVAy/YSFb59JYH/pY3MwHp
J495I26xRc5NBFXqMOpmEml3IFzmOJrEB9iI8P4=
-----END CERTIFICATE-----
";

    #[test]
    fn leaf_certificates_parse_with_sans_and_key_type() {
        let info = parse_certificate(EC_CERT.as_bytes()).unwrap();
        assert_eq!(info.subject, "example.test");
        assert_eq!(info.issuer, "example.test");
        assert_eq!(info.sans, vec!["example.test", "www.example.test", "203.0.113.7"]);
        assert_eq!(info.not_before, "2026-11-06T13:11:50Z");
        assert_eq!(info.not_after, "2126-10-13T13:11:50Z");
        assert_eq!(info.key_type, "ecdsa-256");

        let rsa = parse_certificate(RSA_CERT.as_bytes()).unwrap();
        assert_eq!(rsa.subject, "rsa.example.test");
        assert_eq!(rsa.key_type, "rsa-2048");
        assert!(rsa.sans.is_empty());
    }

    #[test]
    fn the_first_certificate_block_is_the_leaf() {
        let chain = format!(
            "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n{EC_CERT}{RSA_CERT}"
        );
        let info = parse_certificate(chain.as_bytes()).unwrap();
        assert_eq!(info.subject, "example.test");
        assert!(parse_pem_chain(b"not pem at all").is_err());
        assert!(has_pem_block(
            b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
        ));
        assert!(!has_pem_block(b"nope"));
    }

    #[test]
    fn domains_allow_wildcards_and_refuse_flags_and_paths() {
        assert!(check_domain("example.com").is_ok());
        assert!(check_domain("*.example.com").is_ok());
        assert!(check_domain("_dmarc.example.com.").is_ok());
        assert!(check_domain("-flag.example.com").is_err());
        assert!(check_domain("a/b.example.com").is_err());
        assert!(check_domain("double..dot").is_err());
        assert!(check_domain("").is_err());
        assert!(check_domain(&"a".repeat(64)).is_err());
    }

    #[test]
    fn revocation_reasons_are_the_acme_set() {
        assert!(check_revocation_reason("superseded").is_ok());
        assert!(check_revocation_reason("because").is_err());
    }
}
