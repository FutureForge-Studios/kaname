//! app.db_dump / app.db_restore — a consistent dump of an app install's
//! companion database, and its re-import. The guards (labelled container,
//! closed engine and slot, derived paths) live in
//! `providers::app_backup`; both are applied here before the provider is
//! called, and again by the provider itself.

use std::sync::Arc;

use crate::providers::app_backup::{self as ab, AppDbParams};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NEEDS_DOCKER, decode, reply};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(super::method(
        "app.db_dump",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut p: AppDbParams = decode(&req)?;
            ab::validate(&mut p)?;
            reply(h.provider.app_backup().db_dump(&ctx, p).await?)
        },
    ));

    r.register(super::method(
        "app.db_restore",
        StreamMode::None,
        NEEDS_DOCKER,
        h,
        |h, ctx, req| async move {
            let mut p: AppDbParams = decode(&req)?;
            ab::validate(&mut p)?;
            reply(h.provider.app_backup().db_restore(&ctx, p).await?)
        },
    ));
}
