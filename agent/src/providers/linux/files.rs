//! Files on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct FileOps(pub Arc<Shared>);

#[async_trait]
impl Files for FileOps {
    async fn list(&self, _ctx: &Ctx, _p: FsListParams) -> PResult<DirectoryListing> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn stat(&self, _ctx: &Ctx, _path: &str) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn read(&self, _ctx: &Ctx, _p: FsReadParams) -> PResult<FsReadResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn write(&self, _ctx: &Ctx, _p: FsWriteParams) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn mkdir(&self, _ctx: &Ctx, _p: FsMkdirParams) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn r#move(&self, _ctx: &Ctx, _p: FsMoveParams) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn copy(&self, _ctx: &Ctx, _p: FsCopyParams) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove(&self, _ctx: &Ctx, _p: FsRemoveParams) -> PResult<i64> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn chmod(&self, _ctx: &Ctx, _p: FsChmodParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn chown(&self, _ctx: &Ctx, _p: FsChownParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn archive(&self, _ctx: &Ctx, _p: FsArchiveParams, _s: StreamRef) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn extract(&self, _ctx: &Ctx, _p: FsExtractParams, _s: StreamRef) -> PResult<i64> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn download(&self, _ctx: &Ctx, _p: FsDownloadParams, _s: StreamRef) -> PResult<FsDownloadResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn upload(&self, _ctx: &Ctx, _p: FsUploadParams, _s: StreamRef) -> PResult<FileEntry> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn usage(&self, _ctx: &Ctx, _p: FsUsageParams) -> PResult<FsUsageResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
