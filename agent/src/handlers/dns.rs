//! dns.* — resolution from the host's own vantage point.

use std::sync::Arc;

use crate::providers::{DnsPublishParams, DnsResolveParams, DnsResolveResult, OK, cap};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, decode, invalid, method, reply};

const NEEDS_SIMULATED: &[&str] = &[cap::SIMULATED];

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "dns.resolve",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: DnsResolveParams = decode(&req)?;
            if p.name.is_empty() || p.r#type.is_empty() {
                return Err(invalid("name and type are required"));
            }
            let records = h.provider.dns().resolve(&ctx, p).await?;
            reply(DnsResolveResult { records })
        },
    ));

    r.register(method(
        "dns.publish",
        StreamMode::None,
        NEEDS_SIMULATED,
        h,
        |h, ctx, req| async move {
            let p: DnsPublishParams = decode(&req)?;
            if p.zone.is_empty() {
                return Err(invalid("zone is required"));
            }
            h.provider.dns().publish(&ctx, p).await?;
            reply(OK)
        },
    ));
}
