//! ssh.* — authorized keys, sshd_config and live sessions.

use std::sync::Arc;

use crate::providers::{
    SshConfigApplyParams, SshKeysApplyParams, SshKeysApplyResult, SshKeysListParams, SshKeysListResult,
    SshSessionsResult,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_enum, check_identifier, decode, invalid, method, present, reply};

fn has_newline(s: &str) -> bool {
    s.contains('\n') || s.contains('\r')
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "ssh.keys.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: SshKeysListParams = decode(&req)?;
            if let Some(user) = present(&p.user) {
                check_identifier("user", user)?;
            }
            let keys = h.provider.ssh().list_keys(&ctx, p).await?;
            reply(SshKeysListResult { keys })
        },
    ));

    r.register(method(
        "ssh.keys.apply",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: SshKeysApplyParams = decode(&req)?;
            check_identifier("user", &p.user)?;
            for key in &p.keys {
                // A newline would smuggle a second key line into authorized_keys.
                if key.public_key.is_empty() || has_newline(&key.public_key) {
                    return Err(invalid("public_key must be a single non-empty line"));
                }
                if has_newline(&key.comment) {
                    return Err(invalid("comment may not contain a newline"));
                }
            }
            let applied = h.provider.ssh().apply_keys(&ctx, p).await?;
            reply(SshKeysApplyResult { applied })
        },
    ));

    r.register(method(
        "ssh.config.read",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move { reply(h.provider.ssh().read_config(&ctx).await?) },
    ));

    r.register(method(
        "ssh.config.apply",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: SshConfigApplyParams = decode(&req)?;
            if p.port.is_some_and(|port| !(1..=65535).contains(&port)) {
                return Err(invalid("port must be between 1 and 65535"));
            }
            if let Some(permit) = &p.permit_root_login {
                check_enum(
                    "permit_root_login",
                    permit,
                    &["yes", "no", "prohibit-password", "forced-commands-only"],
                )?;
            }
            for user in &p.allow_users {
                check_identifier("allow_users", user)?;
            }
            for group in &p.allow_groups {
                check_identifier("allow_groups", group)?;
            }
            if !(0..=300).contains(&p.rollback_seconds) {
                return Err(invalid("rollback_seconds must be between 0 and 300"));
            }
            reply(h.provider.ssh().apply_config(&ctx, p).await?)
        },
    ));

    r.register(method(
        "ssh.sessions.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move {
            let sessions = h.provider.ssh().sessions(&ctx).await?;
            reply(SshSessionsResult { sessions })
        },
    ));
}
