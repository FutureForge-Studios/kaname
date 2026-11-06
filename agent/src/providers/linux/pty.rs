//! Pty on a real host. STUB: the port of the Go implementation lands here.

use std::sync::Arc;

use async_trait::async_trait;

use super::Shared;
use crate::providers::*;

pub struct PtyOps(pub Arc<Shared>);

/// Open terminal sessions, keyed by the id of the stream that opened them.
#[derive(Default)]
pub struct PtySessions {}

impl PtySessions {
    pub async fn close_all(&self) {}
}

#[async_trait]
impl Pty for PtyOps {
    async fn open(&self, _ctx: &Ctx, _session_id: &str, _p: PtyOpenParams, _s: StreamRef) -> PResult<PtyOpenResult> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn resize(&self, _ctx: &Ctx, _session_id: &str, _p: PtyResizeParams) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
    async fn close(&self, _ctx: &Ctx, _session_id: &str) -> PResult<()> {
        Err(ProviderError::unsupported_because("not yet ported"))
    }
}
