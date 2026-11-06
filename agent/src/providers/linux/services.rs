//! Services on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct ServiceOps(pub Arc<Shared>);

#[async_trait]
impl Services for ServiceOps {
    async fn list(&self, _ctx: &Ctx, _p: ServiceListParams) -> PResult<Vec<ServiceInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn status(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn start(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn stop(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn restart(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn reload(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn enable(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn disable(&self, _ctx: &Ctx, _unit: &str) -> PResult<ServiceInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn logs(&self, _ctx: &Ctx, _p: ServiceLogsParams, _s: StreamRef) -> PResult<Vec<LogRecord>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
