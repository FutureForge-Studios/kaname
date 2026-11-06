//! Certificates.
//!
//! Four of them, one running out soon enough that the housekeeping loop
//! has an expiry to announce. Issuing and renewing write the same files a
//! real certbot would, so the editor can open them.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::state::{Sim, progress, stamp};
use crate::providers::{
    CertInstallParams, CertInstallResult, CertIssueParams, CertIssueResult, CertRenewParams, CertRenewResult,
    CertRevokeParams, CertificateInfo, Certs, Ctx, PResult, ProviderError, StreamRef,
};

#[derive(Clone, Debug)]
pub struct Certificate {
    pub subject: String,
    pub sans: Vec<String>,
    pub issuer: String,
    pub not_before: DateTime<Utc>,
    pub not_after: DateTime<Utc>,
    pub path: String,
    pub key_type: String,
}

/// How many days the mail certificate has left; `mail.certificate.status`
/// reports the same figure so the two views agree.
pub const MAIL_CERT_DAYS: i64 = 60;

pub fn build_certs(sim: &Sim) {
    let domain = &sim.id.domain;
    let mail_host = format!("mail.{}", sim.id.mail_domain);
    let now = Utc::now();

    let seeds: Vec<(String, Vec<String>, i64)> = vec![
        (domain.clone(), vec![domain.clone(), format!("www.{domain}")], 63),
        (format!("api.{domain}"), vec![format!("api.{domain}")], 41),
        (format!("blog.{domain}"), vec![format!("blog.{domain}")], 12),
        (mail_host.clone(), vec![mail_host.clone()], MAIL_CERT_DAYS),
    ];

    let certs: Vec<Certificate> = seeds
        .into_iter()
        .map(|(subject, sans, days)| Certificate {
            path: format!("/etc/letsencrypt/live/{subject}/fullchain.pem"),
            subject,
            sans,
            issuer: "C=US, O=Let's Encrypt, CN=R11".into(),
            not_before: now - chrono::Duration::days(90 - days),
            not_after: now + chrono::Duration::days(days),
            key_type: "ecdsa".into(),
        })
        .collect();

    for cert in &certs {
        write_cert_files(sim, cert);
    }
    sim.world.lock().certs = certs;
}

pub fn write_cert_files(sim: &Sim, cert: &Certificate) {
    let dir = format!("/etc/letsencrypt/live/{}", cert.subject);
    let mut fs = sim.fs.write();
    fs.dir(&dir);
    let body = format!(
        "# simulated leaf for {}\n# sans: {}\n# not_after: {}\n",
        cert.subject,
        cert.sans.join(", "),
        stamp(cert.not_after)
    );
    let leaf = format!("-----BEGIN CERTIFICATE-----\n{body}-----END CERTIFICATE-----\n");
    fs.file(&format!("{dir}/fullchain.pem"), &leaf);
    fs.file(&format!("{dir}/cert.pem"), &leaf);
    fs.file(&format!("{dir}/chain.pem"), "-----BEGIN CERTIFICATE-----\n# ISRG Root X1 chain\n-----END CERTIFICATE-----\n");
    fs.file_as(
        &format!("{dir}/privkey.pem"),
        "-----BEGIN PRIVATE KEY-----\n(simulated; no key material is kept)\n-----END PRIVATE KEY-----\n",
        "0600",
        "root",
        0,
    );
}

pub struct SimCerts(pub Arc<Sim>);

#[async_trait]
impl Certs for SimCerts {
    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<CertificateInfo>> {
        let w = self.0.world.lock();
        let mut out: Vec<CertificateInfo> = w
            .certs
            .iter()
            .map(|c| CertificateInfo {
                subject: c.subject.clone(),
                sans: c.sans.clone(),
                issuer: c.issuer.clone(),
                not_before: stamp(c.not_before),
                not_after: stamp(c.not_after),
                path: c.path.clone(),
                key_type: c.key_type.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.subject.cmp(&b.subject));
        Ok(out)
    }

    async fn issue(&self, ctx: &Ctx, p: CertIssueParams, s: StreamRef) -> PResult<CertIssueResult> {
        let Some(subject) = p.domains.first().cloned() else {
            return Err(ProviderError::invalid("at least one domain is required"));
        };
        let directory = if p.staging {
            "https://acme-staging-v02.api.letsencrypt.org/directory"
        } else {
            "https://acme-v02.api.letsencrypt.org/directory"
        };

        let mut steps = vec![
            "Saving debug log to /var/log/letsencrypt/letsencrypt.log".to_string(),
            format!("Account registered with {directory}"),
            format!("Requesting a certificate for {}", p.domains.join(", ")),
        ];
        for domain in &p.domains {
            if p.challenge == "dns-01" {
                steps.push(format!("Waiting for verification of _acme-challenge.{domain}"));
            } else {
                steps.push(format!(
                    "http-01 challenge for {domain} served from {}",
                    p.webroot.clone().unwrap_or_default()
                ));
            }
        }
        steps.push("Challenges validated".into());
        steps.push("Downloading the certificate chain".into());
        for step in steps {
            progress(ctx, &*s, Duration::from_millis(320), step).await?;
        }

        let now = Utc::now();
        let cert = Certificate {
            subject: subject.clone(),
            sans: p.domains.clone(),
            issuer: if p.staging {
                "C=US, O=(STAGING) Let's Encrypt, CN=(STAGING) False Fennel E6".into()
            } else {
                "C=US, O=Let's Encrypt, CN=R11".into()
            },
            not_before: now,
            not_after: now + chrono::Duration::days(90),
            path: format!("/etc/letsencrypt/live/{subject}/fullchain.pem"),
            key_type: p.key_type.clone(),
        };

        {
            let mut w = self.0.world.lock();
            match w.certs.iter_mut().find(|c| c.subject == subject) {
                Some(existing) => *existing = cert.clone(),
                None => w.certs.push(cert.clone()),
            }
            w.announced.remove(&subject);
        }

        write_cert_files(&self.0, &cert);
        let _ = progress(ctx, &*s, Duration::ZERO, format!("Certificate saved at {}", cert.path)).await;

        Ok(CertIssueResult { subject: cert.subject, sans: cert.sans, not_after: stamp(cert.not_after), path: cert.path })
    }

    async fn renew(&self, ctx: &Ctx, p: CertRenewParams, s: StreamRef) -> PResult<CertRenewResult> {
        let remaining = {
            let w = self.0.world.lock();
            let Some(cert) = w.certs.iter().find(|c| c.subject == p.subject) else {
                return Err(ProviderError::not_found(format!("certificate {}", p.subject)));
            };
            cert.not_after - Utc::now()
        };

        if remaining > chrono::Duration::days(30) && !p.force {
            let _ = progress(
                ctx,
                &*s,
                Duration::ZERO,
                format!("Certificate not yet due for renewal ({} days remaining)", remaining.num_hours() / 24),
            )
            .await;
            return Err(ProviderError::PreconditionFailed(format!("{} is not due for renewal", p.subject)));
        }

        for step in [
            format!("Processing /etc/letsencrypt/renewal/{}.conf", p.subject),
            format!("Renewing an existing certificate for {}", p.subject),
            "Challenges validated".to_string(),
        ] {
            progress(ctx, &*s, Duration::from_millis(300), step).await?;
        }

        let now = Utc::now();
        let cert = {
            let mut w = self.0.world.lock();
            let Some(cert) = w.certs.iter_mut().find(|c| c.subject == p.subject) else {
                return Err(ProviderError::not_found(format!("certificate {}", p.subject)));
            };
            cert.not_before = now;
            cert.not_after = now + chrono::Duration::days(90);
            let cert = cert.clone();
            w.announced.remove(&cert.subject);
            cert
        };

        write_cert_files(&self.0, &cert);
        let _ = progress(ctx, &*s, Duration::ZERO, format!("Renewal successful, new expiry {}", stamp(cert.not_after))).await;
        Ok(CertRenewResult { not_after: stamp(cert.not_after) })
    }

    async fn revoke(&self, _ctx: &Ctx, p: CertRevokeParams) -> PResult<()> {
        {
            let mut w = self.0.world.lock();
            let Some(idx) = w.certs.iter().position(|c| c.subject == p.subject) else {
                return Err(ProviderError::not_found(format!("certificate {}", p.subject)));
            };
            w.certs.remove(idx);
        }
        self.0.fs.write().detach(&format!("/etc/letsencrypt/live/{}", p.subject));
        Ok(())
    }

    async fn install(&self, _ctx: &Ctx, p: CertInstallParams) -> PResult<CertInstallResult> {
        let now = Utc::now();
        let dir = format!("/etc/ssl/kaname/{}", p.subject);
        let cert = Certificate {
            subject: p.subject.clone(),
            sans: vec![p.subject.clone()],
            issuer: "externally issued".into(),
            not_before: now,
            not_after: now + chrono::Duration::days(365),
            path: format!("{dir}/fullchain.pem"),
            key_type: "rsa".into(),
        };

        {
            let mut w = self.0.world.lock();
            match w.certs.iter_mut().find(|c| c.subject == p.subject) {
                Some(existing) => *existing = cert.clone(),
                None => w.certs.push(cert.clone()),
            }
        }

        {
            let mut fs = self.0.fs.write();
            fs.dir(&dir);
            fs.file(&format!("{dir}/fullchain.pem"), &format!("{}{}", p.certificate_pem, p.chain_pem.unwrap_or_default()));
            fs.file_as(&format!("{dir}/privkey.pem"), &p.key_pem, "0600", "root", 0);
        }
        Ok(CertInstallResult { path: cert.path })
    }
}
