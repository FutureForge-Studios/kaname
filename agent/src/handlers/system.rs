//! system.* — host identity, metrics, reboot, packages, self-update.

use std::sync::Arc;

use crate::providers::{
    OK, PackagesListParams, PackagesListResult, PackagesUpgradeParams, SelfUpdateParams, SystemRebootParams,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, decode, invalid, method, reply, require_stream};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "system.info",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move { reply(h.provider.system().info(&ctx).await?) },
    ));

    r.register(method(
        "system.metrics",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move { reply(h.provider.system().metrics(&ctx).await?) },
    ));

    r.register(method(
        "system.reboot",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: SystemRebootParams = decode(&req)?;
            if !(0..=3600).contains(&p.delay_seconds) {
                return Err(invalid("delay_seconds must be between 0 and 3600"));
            }
            h.provider.system().reboot(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "system.packages.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: PackagesListParams = decode(&req)?;
            let packages = h.provider.system().list_packages(&ctx, p).await?;
            reply(PackagesListResult { packages })
        },
    ));

    r.register(method(
        "system.packages.upgrade",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: PackagesUpgradeParams = decode(&req)?;
            let stream = require_stream(&req)?;
            reply(h.provider.system().upgrade_packages(&ctx, p, stream).await?)
        },
    ));

    r.register(method(
        "system.self_update",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: SelfUpdateParams = decode(&req)?;
            if p.version.is_empty() || p.url.is_empty() {
                return Err(invalid("version and url are required"));
            }
            // Checked here as well as in the downloader: a call that cannot
            // possibly verify what it fetches is refused before anything is
            // fetched at all.
            if p.sha256.len() != 64 {
                return Err(invalid("sha256 must be 64 hexadecimal characters"));
            }
            let stream = require_stream(&req)?;
            reply(h.provider.system().self_update(&ctx, p, stream).await?)
        },
    ));
}
