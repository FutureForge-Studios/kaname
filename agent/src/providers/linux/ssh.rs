//! Ssh on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct SshOps(pub Arc<Shared>);

#[async_trait]
impl Ssh for SshOps {
    async fn list_keys(&self, _ctx: &Ctx, _p: SshKeysListParams) -> PResult<Vec<SshKeyInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn apply_keys(&self, _ctx: &Ctx, _p: SshKeysApplyParams) -> PResult<i64> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn read_config(&self, _ctx: &Ctx) -> PResult<SshConfigInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn apply_config(&self, _ctx: &Ctx, _p: SshConfigApplyParams) -> PResult<SshConfigApplyResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn sessions(&self, _ctx: &Ctx) -> PResult<Vec<SshSessionInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
