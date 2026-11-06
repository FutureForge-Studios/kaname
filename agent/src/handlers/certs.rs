//! cert.* — TLS certificates.

use std::sync::Arc;

use crate::providers::{CertInstallParams, CertIssueParams, CertListResult, CertRenewParams, CertRevokeParams, OK};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_enum, decode, invalid, method, or_default, present, reply, require_stream};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("cert.list", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let certificates = h.provider.certs().list(&ctx).await?;
        reply(CertListResult { certificates })
    }));

    r.register(method("cert.issue", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: CertIssueParams = decode(&req)?;
        if p.domains.is_empty() {
            return Err(invalid("at least one domain is required"));
        }
        check_enum("challenge", &p.challenge, &["http-01", "dns-01"])?;
        p.key_type = or_default(p.key_type, "ecdsa");
        check_enum("key_type", &p.key_type, &["ecdsa", "rsa"])?;
        if let Some(webroot) = present(&p.webroot) {
            p.webroot = Some(h.paths.check(webroot)?);
        }
        let stream = require_stream(&req)?;
        reply(h.provider.certs().issue(&ctx, p, stream).await?)
    }));

    r.register(method("cert.renew", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let p: CertRenewParams = decode(&req)?;
        if p.subject.is_empty() {
            return Err(invalid("subject is required"));
        }
        let stream = require_stream(&req)?;
        reply(h.provider.certs().renew(&ctx, p, stream).await?)
    }));

    r.register(method("cert.revoke", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: CertRevokeParams = decode(&req)?;
        if p.subject.is_empty() {
            return Err(invalid("subject is required"));
        }
        p.reason = or_default(p.reason, "unspecified");
        h.provider.certs().revoke(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("cert.install", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: CertInstallParams = decode(&req)?;
        if p.subject.is_empty() || p.certificate_pem.is_empty() || p.key_pem.is_empty() {
            return Err(invalid("subject, certificate_pem and key_pem are required"));
        }
        reply(h.provider.certs().install(&ctx, p).await?)
    }));
}
