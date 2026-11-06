//! Firewall on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct FirewallOps(pub Arc<Shared>);

#[async_trait]
impl Firewall for FirewallOps {
    async fn status(&self, _ctx: &Ctx) -> PResult<FirewallStatus> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn apply(&self, _ctx: &Ctx, _p: FwApplyParams) -> PResult<FwApplyResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn confirm(&self, _ctx: &Ctx, _p: FwConfirmParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn ban(&self, _ctx: &Ctx, _p: FwBanParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn unban(&self, _ctx: &Ctx, _p: FwUnbanParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn bans(&self, _ctx: &Ctx) -> PResult<Vec<BanEntry>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn threats(&self, _ctx: &Ctx, _p: FwThreatsParams) -> PResult<Vec<ThreatObservation>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
