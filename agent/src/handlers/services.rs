//! service.* — systemd units.

use std::sync::Arc;

use crate::providers::{
    LogRecordsResult, ServiceListParams, ServiceListResult, ServiceLogsParams, UnitParams,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NEEDS_SYSTEMD, check_unit, decode, method, or_default, reply, require_stream};

/// Registers one unit verb: decode `{unit}`, validate it, call the named
/// provider method with it.
macro_rules! unit_action {
    ($r:expr, $h:expr, $name:literal, $call:ident) => {
        $r.register(method(
            $name,
            StreamMode::None,
            NEEDS_SYSTEMD,
            $h,
            |h, ctx, req| async move {
                let p: UnitParams = decode(&req)?;
                check_unit(&p.unit)?;
                reply(h.provider.services().$call(&ctx, &p.unit).await?)
            },
        ));
    };
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "service.list",
        StreamMode::None,
        NEEDS_SYSTEMD,
        h,
        |h, ctx, req| async move {
            let p: ServiceListParams = decode(&req)?;
            let services = h.provider.services().list(&ctx, p).await?;
            reply(ServiceListResult { services })
        },
    ));

    unit_action!(r, h, "service.status", status);
    unit_action!(r, h, "service.start", start);
    unit_action!(r, h, "service.stop", stop);
    unit_action!(r, h, "service.restart", restart);
    unit_action!(r, h, "service.reload", reload);
    unit_action!(r, h, "service.enable", enable);
    unit_action!(r, h, "service.disable", disable);

    r.register(method(
        "service.logs",
        StreamMode::Response,
        NEEDS_SYSTEMD,
        h,
        |h, ctx, req| async move {
            let mut p: ServiceLogsParams = decode(&req)?;
            check_unit(&p.unit)?;
            p.lines = or_default(p.lines, 200);
            let stream = require_stream(&req)?;
            let records = h.provider.services().logs(&ctx, p, stream).await?;
            reply(LogRecordsResult { records })
        },
    ));
}
