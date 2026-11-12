//! backup.* — restic repositories.

use std::sync::Arc;

use serde_json::Value;

use crate::providers::backup_secret::{check_secret_put, check_secret_ref};
use crate::providers::{
    BackupListParams, BackupListResult, BackupPruneParams, BackupRestoreParams, BackupRunParams,
    BackupSecretDeleteParams, BackupSecretPutParams, BackupVerifyParams,
};
use crate::registry::{Registry, Request, StreamMode};
use crate::wire::WireError;

use super::{Handlers, NO_CAPS, check_repository, decode, invalid, method, reply, require_stream};

/// `decode` for `backup.secret_put`. serde's messages quote the offending
/// value ("invalid type: string \"...\"") and that value may be the
/// password, so only the messages that name a field and nothing else
/// survive; anything else becomes a fixed sentence.
fn decode_secret_put(req: &Request) -> Result<BackupSecretPutParams, WireError> {
    match &req.params {
        None | Some(Value::Null) => Ok(BackupSecretPutParams::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| {
            let message = e.to_string();
            if message.starts_with("unknown field") || message.starts_with("missing field") {
                invalid(format!("{}: {message}", req.method))
            } else {
                invalid(format!(
                    "{}: params must be an object of string ref, password and env",
                    req.method
                ))
            }
        }),
    }
}

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

    // Validated here as well as in the provider, so a bad request is
    // refused the same way whichever provider serves it.
    r.register(method(
        "backup.secret_put",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p = decode_secret_put(&req)?;
            check_secret_put(&p)?;
            reply(h.provider.backups().secret_put(&ctx, p).await?)
        },
    ));

    r.register(method(
        "backup.secret_delete",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: BackupSecretDeleteParams = decode(&req)?;
            check_secret_ref(&p.reference)?;
            reply(h.provider.backups().secret_delete(&ctx, p).await?)
        },
    ));
}
