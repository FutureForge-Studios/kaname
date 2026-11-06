//! Processes on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct ProcessOps(pub Arc<Shared>);

#[async_trait]
impl Processes for ProcessOps {
    async fn list(&self, _ctx: &Ctx, _p: ProcessListParams) -> PResult<ProcessListResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn tree(&self, _ctx: &Ctx, _p: ProcessTreeParams) -> PResult<Vec<ProcessNode>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn signal(&self, _ctx: &Ctx, _p: SignalParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
