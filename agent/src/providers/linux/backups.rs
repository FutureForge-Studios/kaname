//! Backups on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct BackupOps(pub Arc<Shared>);

#[async_trait]
impl Backups for BackupOps {
    async fn run(&self, _ctx: &Ctx, _p: BackupRunParams, _s: StreamRef) -> PResult<BackupSnapshotInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list(&self, _ctx: &Ctx, _p: BackupListParams) -> PResult<Vec<BackupSnapshotInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn restore(&self, _ctx: &Ctx, _p: BackupRestoreParams, _s: StreamRef) -> PResult<BackupRestoreResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn verify(&self, _ctx: &Ctx, _p: BackupVerifyParams, _s: StreamRef) -> PResult<BackupVerifyResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn prune(&self, _ctx: &Ctx, _p: BackupPruneParams, _s: StreamRef) -> PResult<BackupPruneResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
