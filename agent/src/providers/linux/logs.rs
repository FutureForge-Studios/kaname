//! Logs on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct LogOps(pub Arc<Shared>);

#[async_trait]
impl Logs for LogOps {
    async fn sources(&self, _ctx: &Ctx) -> PResult<Vec<LogSource>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn tail(&self, _ctx: &Ctx, _p: LogTailParams, _s: StreamRef) -> PResult<Vec<LogRecord>> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
