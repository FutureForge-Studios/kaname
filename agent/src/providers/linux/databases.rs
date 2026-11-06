//! Databases on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct DatabaseOps(pub Arc<Shared>);

#[async_trait]
impl Databases for DatabaseOps {
    async fn instances(&self, _ctx: &Ctx) -> PResult<Vec<DbInstanceInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_databases(&self, _ctx: &Ctx, _p: DbEngineParams) -> PResult<Vec<DbDatabaseInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn create_database(&self, _ctx: &Ctx, _p: DbDatabaseCreateParams) -> PResult<DbDatabaseInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn delete_database(&self, _ctx: &Ctx, _p: DbDatabaseDeleteParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn list_users(&self, _ctx: &Ctx, _p: DbEngineParams) -> PResult<Vec<DbUserInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn create_user(&self, _ctx: &Ctx, _p: DbUserCreateParams) -> PResult<DbUserInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn update_user(&self, _ctx: &Ctx, _p: DbUserUpdateParams) -> PResult<DbUserInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn delete_user(&self, _ctx: &Ctx, _p: DbUserDeleteParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn apply_grant(&self, _ctx: &Ctx, _p: DbGrantApplyParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn size(&self, _ctx: &Ctx, _p: DbSizeParams) -> PResult<DbSizeResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn dump(&self, _ctx: &Ctx, _p: DbDumpParams, _s: StreamRef) -> PResult<DbDumpResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn restore(&self, _ctx: &Ctx, _p: DbRestoreParams, _s: StreamRef) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
