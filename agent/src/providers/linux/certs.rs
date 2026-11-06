//! Certs on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct CertOps(pub Arc<Shared>);

#[async_trait]
impl Certs for CertOps {
    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<CertificateInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn issue(&self, _ctx: &Ctx, _p: CertIssueParams, _s: StreamRef) -> PResult<CertIssueResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn renew(&self, _ctx: &Ctx, _p: CertRenewParams, _s: StreamRef) -> PResult<CertRenewResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn revoke(&self, _ctx: &Ctx, _p: CertRevokeParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn install(&self, _ctx: &Ctx, _p: CertInstallParams) -> PResult<CertInstallResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
