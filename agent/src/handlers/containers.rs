//! container.* — the container runtime.

use std::sync::Arc;

use crate::providers::{
    ContainerExecParams, ContainerIdParams, ContainerListParams, ContainerListResult, ContainerLogsParams,
    ContainerPruneParams, ContainerRemoveParams, ContainerStopParams, ImageListResult, LogRecordsResult, OK,
};
use crate::registry::{Registry, Request, StreamMode};
use crate::wire::WireError;

use super::{Handlers, NEEDS_DOCKER, check_container_id, decode, method, or_default, reply, require_stream};

fn decode_container_id(req: &Request) -> Result<ContainerIdParams, WireError> {
    let p: ContainerIdParams = decode(req)?;
    check_container_id(&p.id)?;
    Ok(p)
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "container.list",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ContainerListParams = decode(&req)?;
            let containers = h.provider.containers().list(&ctx, p).await?;
            reply(ContainerListResult { containers })
        },
    ));

    r.register(method(
        "container.inspect",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p = decode_container_id(&req)?;
            reply(h.provider.containers().inspect(&ctx, &p.id).await?)
        },
    ));

    r.register(method(
        "container.start",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p = decode_container_id(&req)?;
            reply(h.provider.containers().start(&ctx, &p.id).await?)
        },
    ));

    r.register(method(
        "container.stop",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ContainerStopParams = decode(&req)?;
            check_container_id(&p.id)?;
            reply(h.provider.containers().stop(&ctx, p).await?)
        },
    ));

    r.register(method(
        "container.restart",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ContainerStopParams = decode(&req)?;
            check_container_id(&p.id)?;
            reply(h.provider.containers().restart(&ctx, p).await?)
        },
    ));

    r.register(method(
        "container.remove",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ContainerRemoveParams = decode(&req)?;
            check_container_id(&p.id)?;
            h.provider.containers().remove(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "container.logs",
        StreamMode::Response,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut p: ContainerLogsParams = decode(&req)?;
            check_container_id(&p.id)?;
            p.lines = or_default(p.lines, 200);
            let stream = require_stream(&req)?;
            let records = h.provider.containers().logs(&ctx, p, stream).await?;
            reply(LogRecordsResult { records })
        },
    ));

    r.register(method(
        "container.exec",
        StreamMode::Bidirectional,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut p: ContainerExecParams = decode(&req)?;
            check_container_id(&p.id)?;
            p.cols = or_default(p.cols, 80);
            p.rows = or_default(p.rows, 24);
            let stream = require_stream(&req)?;
            h.provider.containers().exec(&ctx, p, stream).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "container.images.list",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, _req| async move {
            let images = h.provider.containers().images(&ctx).await?;
            reply(ImageListResult { images })
        },
    ));

    r.register(method(
        "container.prune",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ContainerPruneParams = decode(&req)?;
            reply(h.provider.containers().prune(&ctx, p).await?)
        },
    ));
}
