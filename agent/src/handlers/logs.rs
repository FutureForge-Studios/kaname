//! log.* — journal and file log sources.

use std::sync::Arc;

use crate::providers::{LogRecordsResult, LogSourcesResult, LogTailParams};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, decode, invalid, method, or_default, reply, require_stream};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("log.sources", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let sources = h.provider.logs().sources(&ctx).await?;
        reply(LogSourcesResult { sources })
    }));

    r.register(method("log.tail", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: LogTailParams = decode(&req)?;
        if p.source.is_empty() {
            return Err(invalid("source is required"));
        }
        p.lines = or_default(p.lines, 200);
        let stream = require_stream(&req)?;
        let records = h.provider.logs().tail(&ctx, p, stream).await?;
        reply(LogRecordsResult { records })
    }));
}
