//! backup.* — restic repositories.

use std::sync::Arc;

use crate::providers::{
    BackupListParams, BackupListResult, BackupPruneParams, BackupRestoreParams, BackupRunParams,
    BackupVerifyParams,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_repository, decode, invalid, method, reply, require_stream};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "backup.run",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: BackupRunParams = decode(&req)?;
            check_repository(&p.repository, &p.password_ref)?;
            p.paths = h.paths.check_all(&p.paths)?;
            let stream = require_stream(&req)?;
            reply(h.provider.backups().run(&ctx, p, stream).await?)
        },
    ));

    r.register(method(
        "backup.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: BackupListParams = decode(&req)?;
            check_repository(&p.repository, &p.password_ref)?;
            let snapshots = h.provider.backups().list(&ctx, p).await?;
            reply(BackupListResult { snapshots })
        },
    ));

    r.register(method(
        "backup.restore",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: BackupRestoreParams = decode(&req)?;
            check_repository(&p.repository, &p.password_ref)?;
            if p.snapshot_id.is_empty() {
                return Err(invalid("snapshot_id is required"));
            }
            p.target = h.paths.check(&p.target)?;
            let stream = require_stream(&req)?;
            reply(h.provider.backups().restore(&ctx, p, stream).await?)
        },
    ));

    r.register(method(
        "backup.verify",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: BackupVerifyParams = decode(&req)?;
            check_repository(&p.repository, &p.password_ref)?;
            if p.snapshot_id.is_empty() {
                return Err(invalid("snapshot_id is required"));
            }
            let stream = require_stream(&req)?;
            reply(h.provider.backups().verify(&ctx, p, stream).await?)
        },
    ));

    r.register(method(
        "backup.prune",
        StreamMode::Response,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: BackupPruneParams = decode(&req)?;
            check_repository(&p.repository, &p.password_ref)?;
            if p.keep_last < 0 || p.keep_daily < 0 || p.keep_weekly < 0 || p.keep_monthly < 0 {
                return Err(invalid("retention counts may not be negative"));
            }
            let stream = require_stream(&req)?;
            reply(h.provider.backups().prune(&ctx, p, stream).await?)
        },
    ));
}
