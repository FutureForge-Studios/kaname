//! mail.* — Yunori Mail Server on the host (KD-023).
//!
//! Every verb is one `yunori-mail` invocation behind the provider seam.
//! `mail.deploy` is the one verb that runs before yunori exists, so it is
//! gated on systemd rather than on the `yunori` capability.

use std::sync::Arc;

use crate::providers::{
    LogRecordsResult, MailAddressParams, MailAliasAddParams, MailAliasListResult, MailAliasRemoveParams,
    MailCheckListResult, MailDeployParams, MailDomainListResult, MailDomainParams, MailListParams, MailLogsParams,
    MailPreflightParams, MailboxAddParams, MailboxListResult, OK,
};
use crate::registry::{Registry, StreamMode};
use crate::wire::WireError;

use super::{
    Handlers, NEEDS_MAIL, NEEDS_SYSTEMD, check_address, check_email, check_enum, check_identifier, decode, invalid,
    method, or_default, reply, require_stream,
};

/// A mail domain name: non-empty and within the DNS length limit. The
/// provider hands it to yunori as one argv element, so there is nothing
/// a shell could see in it.
fn check_domain(field: &str, name: &str) -> Result<(), WireError> {
    if name.is_empty() || name.len() > 253 {
        return Err(invalid(format!("{field} must be between 1 and 253 characters")));
    }
    if name.chars().any(|c| c.is_whitespace() || c == '\0' || c == '/') {
        return Err(invalid(format!("{field} contains an illegal character")));
    }
    Ok(())
}

fn check_deploy(p: &MailDeployParams) -> Result<(), WireError> {
    if p.version.is_empty() || p.url.is_empty() {
        return Err(invalid("version and url are required"));
    }
    if p.version.len() > 64 {
        return Err(invalid("version must be at most 64 characters"));
    }
    // Checked here as well as in the installer: a call that cannot
    // possibly verify what it fetches is refused before anything is
    // fetched at all.
    if p.sha256.len() != 64 || !p.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(invalid("sha256 must be 64 lowercase hexadecimal characters"));
    }
    check_domain("domain", &p.domain)?;
    check_domain("hostname", &p.hostname)?;
    check_email("admin_email", &p.admin_email)?;
    check_identifier("first_mailbox", &p.first_mailbox)?;
    check_enum("sending", &p.sending, &["direct", "relay"])?;
    match (&p.sending[..], &p.relay) {
        ("relay", None) => return Err(invalid("relay is required when sending is relay")),
        ("relay", Some(relay)) => {
            if relay.provider.is_empty() {
                return Err(invalid("relay.provider is required"));
            }
            if relay.port == 0 {
                return Err(invalid("relay.port must be between 1 and 65535"));
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("mail.status", StreamMode::None, NEEDS_MAIL, h, |h, ctx, _req| async move {
        reply(h.provider.mail().status(&ctx).await?)
    }));

    r.register(method("mail.preflight", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailPreflightParams = decode(&req)?;
        if let Some(hostname) = p.hostname.as_deref().filter(|s| !s.is_empty()) {
            check_domain("hostname", hostname)?;
        }
        let checks = h.provider.mail().preflight(&ctx, p).await?;
        reply(MailCheckListResult { checks })
    }));

    r.register(method("mail.doctor", StreamMode::None, NEEDS_MAIL, h, |h, ctx, _req| async move {
        let checks = h.provider.mail().doctor(&ctx).await?;
        reply(MailCheckListResult { checks })
    }));

    r.register(method("mail.deploy", StreamMode::Response, NEEDS_SYSTEMD, h, |h, ctx, req| async move {
        let p: MailDeployParams = decode(&req)?;
        check_deploy(&p)?;
        let stream = require_stream(&req)?;
        reply(h.provider.mail().deploy(&ctx, p, stream).await?)
    }));

    r.register(method("mail.update", StreamMode::Response, NEEDS_MAIL, h, |h, ctx, req| async move {
        let stream = require_stream(&req)?;
        h.provider.mail().update(&ctx, stream).await?;
        reply(OK)
    }));

    r.register(method("mail.domain.list", StreamMode::None, NEEDS_MAIL, h, |h, ctx, _req| async move {
        let domains = h.provider.mail().list_domains(&ctx).await?;
        reply(MailDomainListResult { domains })
    }));

    r.register(method("mail.domain.add", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailDomainParams = decode(&req)?;
        check_domain("name", &p.name)?;
        h.provider.mail().add_domain(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("mail.domain.remove", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailDomainParams = decode(&req)?;
        check_domain("name", &p.name)?;
        h.provider.mail().remove_domain(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("mail.domain.dns", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailDomainParams = decode(&req)?;
        check_domain("name", &p.name)?;
        reply(h.provider.mail().domain_dns(&ctx, p).await?)
    }));

    r.register(method("mail.mailbox.list", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailListParams = decode(&req)?;
        if let Some(domain) = p.domain.as_deref().filter(|s| !s.is_empty()) {
            check_domain("domain", domain)?;
        }
        let mailboxes = h.provider.mail().list_mailboxes(&ctx, p).await?;
        reply(MailboxListResult { mailboxes })
    }));

    r.register(method("mail.mailbox.add", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailboxAddParams = decode(&req)?;
        check_address(&p.address)?;
        if p.quota_mb == Some(0) {
            return Err(invalid("quota_mb must be positive"));
        }
        reply(h.provider.mail().add_mailbox(&ctx, p).await?)
    }));

    r.register(method("mail.mailbox.passwd", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailAddressParams = decode(&req)?;
        check_address(&p.address)?;
        reply(h.provider.mail().mailbox_password(&ctx, p).await?)
    }));

    r.register(method("mail.mailbox.remove", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailAddressParams = decode(&req)?;
        check_address(&p.address)?;
        h.provider.mail().remove_mailbox(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("mail.alias.list", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailListParams = decode(&req)?;
        if let Some(domain) = p.domain.as_deref().filter(|s| !s.is_empty()) {
            check_domain("domain", domain)?;
        }
        let aliases = h.provider.mail().list_aliases(&ctx, p).await?;
        reply(MailAliasListResult { aliases })
    }));

    r.register(method("mail.alias.add", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailAliasAddParams = decode(&req)?;
        check_email("alias", &p.alias)?;
        check_email("mailbox", &p.mailbox)?;
        h.provider.mail().add_alias(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("mail.alias.remove", StreamMode::None, NEEDS_MAIL, h, |h, ctx, req| async move {
        let p: MailAliasRemoveParams = decode(&req)?;
        check_email("alias", &p.alias)?;
        h.provider.mail().remove_alias(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("mail.certificate.status", StreamMode::None, NEEDS_MAIL, h, |h, ctx, _req| async move {
        reply(h.provider.mail().certificate_status(&ctx).await?)
    }));

    r.register(method("mail.certificate.renew", StreamMode::Response, NEEDS_MAIL, h, |h, ctx, req| async move {
        let stream = require_stream(&req)?;
        reply(h.provider.mail().certificate_renew(&ctx, stream).await?)
    }));

    r.register(method("mail.logs", StreamMode::Response, NEEDS_MAIL, h, |h, ctx, req| async move {
        let mut p: MailLogsParams = decode(&req)?;
        p.lines = or_default(p.lines, 200);
        let stream = require_stream(&req)?;
        let records = h.provider.mail().logs(&ctx, p, stream).await?;
        reply(LogRecordsResult { records })
    }));
}
