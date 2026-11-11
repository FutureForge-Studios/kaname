//! container.* — the container runtime.

use std::sync::Arc;

use crate::providers::managed::{self, MANAGED_APPS_ROOT};
use crate::providers::{
    ContainerExecParams, ContainerIdParams, ContainerListParams, ContainerListResult, ContainerLogsParams,
    ContainerPruneParams, ContainerRemoveParams, ContainerStopParams, ImageListResult, ImagePullParams,
    LogRecordsResult, ManagedAppRemoveParams, ManagedContainerSpec, ManagedInstallParams, ManagedTaskParams, OK,
};
use crate::registry::{Registry, Request, StreamMode};
use crate::wire::WireError;

use super::{
    Handlers, NEEDS_DOCKER, check_container_id, check_dimensions, decode, method, or_default, reply,
    require_stream,
};

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
            // The same bounds as pty.open: a container shell is the same
            // audited interactive path, and a runtime handed a zero or
            // absurd geometry fails deep inside the exec rather than here.
            check_dimensions(p.cols, p.rows)?;
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

    /* ----------------------- managed app containers --------------------- */

    r.register(method(
        "container.image.pull",
        StreamMode::Response,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ImagePullParams = decode(&req)?;
            managed::validate_image(&p.image)?;
            let stream = require_stream(&req)?;
            reply(h.provider.containers().pull_image(&ctx, p, stream).await?)
        },
    ));

    r.register(method(
        "container.network.create",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ManagedInstallParams = decode(&req)?;
            managed::validate_install_id(&p.install_id)?;
            reply(
                h.provider
                    .containers()
                    .create_network(&ctx, &p.install_id)
                    .await?,
            )
        },
    ));

    r.register(method(
        "container.create",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut spec: ManagedContainerSpec = decode(&req)?;
            managed::validate_spec(&mut spec, MANAGED_APPS_ROOT)?;
            // The agent-wide guard as well: a source can never be the
            // agent's own state directory, whatever the managed root is.
            for mount in &mut spec.mounts {
                mount.source = h.paths.check(&mount.source)?;
            }
            reply(h.provider.containers().create_managed(&ctx, spec).await?)
        },
    ));

    r.register(method(
        "container.task.run",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut p: ManagedTaskParams = decode(&req)?;
            p.timeout_seconds = or_default(p.timeout_seconds, 600);
            managed::validate_task(&mut p.spec, p.timeout_seconds, MANAGED_APPS_ROOT)?;
            for mount in &mut p.spec.mounts {
                mount.source = h.paths.check(&mount.source)?;
            }
            reply(h.provider.containers().run_task(&ctx, p).await?)
        },
    ));

    r.register(method(
        "container.app.status",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ManagedInstallParams = decode(&req)?;
            managed::validate_install_id(&p.install_id)?;
            reply(h.provider.containers().app_status(&ctx, &p.install_id).await?)
        },
    ));

    r.register(method(
        "container.app.remove",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let p: ManagedAppRemoveParams = decode(&req)?;
            managed::validate_install_id(&p.install_id)?;
            reply(h.provider.containers().remove_app(&ctx, p).await?)
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
