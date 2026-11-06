//! Sites on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct SiteOps(pub Arc<Shared>);

#[async_trait]
impl Sites for SiteOps {
    async fn list(&self, _ctx: &Ctx) -> PResult<Vec<SiteInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn create(&self, _ctx: &Ctx, _p: SiteCreateParams) -> PResult<SiteConfigResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn update(&self, _ctx: &Ctx, _p: SiteUpdateParams) -> PResult<SiteConfigResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove(&self, _ctx: &Ctx, _p: SiteRemoveParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn test_config(&self, _ctx: &Ctx) -> PResult<SiteTestConfigResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn reload(&self, _ctx: &Ctx) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
