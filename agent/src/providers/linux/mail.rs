//! Mail on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct MailOps(pub Arc<Shared>);

#[async_trait]
impl Mail for MailOps {
    async fn status(&self, _ctx: &Ctx) -> PResult<MailServerStatusInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn preflight(&self, _ctx: &Ctx, _p: MailPreflightParams) -> PResult<Vec<MailCheck>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn doctor(&self, _ctx: &Ctx) -> PResult<Vec<MailCheck>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn deploy(&self, _ctx: &Ctx, _p: MailDeployParams, _s: StreamRef) -> PResult<MailDeployResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn update(&self, _ctx: &Ctx, _s: StreamRef) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_domains(&self, _ctx: &Ctx) -> PResult<Vec<MailDomainEntry>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn add_domain(&self, _ctx: &Ctx, _p: MailDomainParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove_domain(&self, _ctx: &Ctx, _p: MailDomainParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn domain_dns(&self, _ctx: &Ctx, _p: MailDomainParams) -> PResult<MailDomainDnsResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_mailboxes(&self, _ctx: &Ctx, _p: MailListParams) -> PResult<Vec<MailboxEntry>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn add_mailbox(&self, _ctx: &Ctx, _p: MailboxAddParams) -> PResult<MailPasswordResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn mailbox_password(&self, _ctx: &Ctx, _p: MailAddressParams) -> PResult<MailPasswordResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove_mailbox(&self, _ctx: &Ctx, _p: MailAddressParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_aliases(&self, _ctx: &Ctx, _p: MailListParams) -> PResult<Vec<MailAliasEntry>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn add_alias(&self, _ctx: &Ctx, _p: MailAliasAddParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove_alias(&self, _ctx: &Ctx, _p: MailAliasRemoveParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn certificate_status(&self, _ctx: &Ctx) -> PResult<MailCertificateStatus> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn certificate_renew(&self, _ctx: &Ctx, _s: StreamRef) -> PResult<MailCertificateRenewResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn logs(&self, _ctx: &Ctx, _p: MailLogsParams, _s: StreamRef) -> PResult<Vec<LogRecord>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
