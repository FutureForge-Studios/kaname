//! site.* — web server virtual hosts.

use std::sync::Arc;

use crate::providers::{OK, SiteCreateParams, SiteListResult, SiteRemoveParams, SiteUpdateParams};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NEEDS_NGINX, check_enum, check_identifier, decode, invalid, method, present, reply};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "site.list",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move {
            let sites = h.provider.sites().list(&ctx).await?;
            reply(SiteListResult { sites })
        },
    ));

    r.register(method(
        "site.create",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let mut p: SiteCreateParams = decode(&req)?;
            if p.name.is_empty() || p.server_names.is_empty() {
                return Err(invalid("name and at least one server name are required"));
            }
            p.webroot = h.paths.check(&p.webroot)?;
            check_enum(
                "runtime",
                &p.runtime,
                &["static", "php", "node", "python", "proxy", "container"],
            )?;
            if let Some(owner) = present(&p.owner) {
                check_identifier("owner", owner)?;
            }
            reply(h.provider.sites().create(&ctx, p).await?)
        },
    ));

    r.register(method(
        "site.update",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let mut p: SiteUpdateParams = decode(&req)?;
            if p.name.is_empty() {
                return Err(invalid("name is required"));
            }
            if let Some(webroot) = present(&p.webroot) {
                p.webroot = Some(h.paths.check(webroot)?);
            }
            reply(h.provider.sites().update(&ctx, p).await?)
        },
    ));

    r.register(method(
        "site.remove",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, req| async move {
            let p: SiteRemoveParams = decode(&req)?;
            if p.name.is_empty() {
                return Err(invalid("name is required"));
            }
            h.provider.sites().remove(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "site.test_config",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move { reply(h.provider.sites().test_config(&ctx).await?) },
    ));

    r.register(method(
        "site.reload",
        StreamMode::None,
        NEEDS_NGINX,
        h,
        |h, ctx, _req| async move {
            h.provider.sites().reload(&ctx).await?;
            reply(OK)
        },
    ));
}
