//! System on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct SystemOps(pub Arc<Shared>);

/// The previous sample, kept so counters become rates.
#[derive(Clone, Debug, Default)]
pub struct MetricsSnapshot {
    pub at: Option<std::time::Instant>,
}

pub async fn collect_disks(_ctx: &Ctx) -> PResult<Vec<DiskUsage>> {
    Ok(Vec::new())
}

#[async_trait]
impl System for SystemOps {
    async fn info(&self, _ctx: &Ctx) -> PResult<SystemInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn metrics(&self, _ctx: &Ctx) -> PResult<MetricsSample> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn reboot(&self, _ctx: &Ctx, _p: SystemRebootParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_packages(&self, _ctx: &Ctx, _p: PackagesListParams) -> PResult<Vec<PackageInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn upgrade_packages(&self, _ctx: &Ctx, _p: PackagesUpgradeParams, _s: StreamRef) -> PResult<PackagesUpgradeResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn self_update(&self, _ctx: &Ctx, _p: SelfUpdateParams, _s: StreamRef) -> PResult<SelfUpdateResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
