//! Containers on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;
use tokio_util::sync::CancellationToken;

pub struct ContainerOps(pub Arc<Shared>);

/// The container runtime's HTTP-over-unix-socket client.
pub struct DockerClient {
    runtime: &'static str,
}

impl DockerClient {
    /// "docker" or "podman": the capability name of the runtime whose socket answered.
    pub fn runtime(&self) -> &'static str {
        self.runtime
    }

    pub async fn watch_events(self: Arc<Self>, _shared: Arc<Shared>, _cancel: CancellationToken) {}
}

/// Probes the docker and podman sockets; `None` when neither answers.
pub async fn discover_container_runtime() -> Option<DockerClient> {
    None
}

#[async_trait]
impl Containers for ContainerOps {
    async fn list(&self, _ctx: &Ctx, _p: ContainerListParams) -> PResult<Vec<ContainerInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn inspect(&self, _ctx: &Ctx, _id: &str) -> PResult<ContainerInspectResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn start(&self, _ctx: &Ctx, _id: &str) -> PResult<ContainerInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn stop(&self, _ctx: &Ctx, _p: ContainerStopParams) -> PResult<ContainerInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn restart(&self, _ctx: &Ctx, _p: ContainerStopParams) -> PResult<ContainerInfo> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn remove(&self, _ctx: &Ctx, _p: ContainerRemoveParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn logs(&self, _ctx: &Ctx, _p: ContainerLogsParams, _s: StreamRef) -> PResult<Vec<LogRecord>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn exec(&self, _ctx: &Ctx, _p: ContainerExecParams, _s: StreamRef) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn images(&self, _ctx: &Ctx) -> PResult<Vec<ImageInfo>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn prune(&self, _ctx: &Ctx, _p: ContainerPruneParams) -> PResult<ContainerPruneResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
