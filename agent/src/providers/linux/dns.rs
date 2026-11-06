//! Dns on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct DnsOps(pub Arc<Shared>);

#[async_trait]
impl Dns for DnsOps {
    async fn resolve(&self, _ctx: &Ctx, _p: DnsResolveParams) -> PResult<Vec<ResolvedRecord>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
