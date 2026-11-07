//! ftp.account.* — transfer accounts. Each verb needs the daemon its
//! protocol rides on (sshd for SFTP, vsftpd for FTPS), so the registry
//! gate turns a host with neither into a fast `unsupported`.

use std::sync::Arc;

use crate::providers::ftp::{
    self, FtpAccountParams, FtpPasswdParams, FtpUserParams, check_home, check_password, check_protocol,
    check_public_key,
};
use crate::providers::{OK, cap};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, check_identifier, decode, method, reply};

/// Either daemon admits the call; the provider then insists on the one the
/// account's protocol needs.
pub(crate) const NEEDS_TRANSFER: &[&str] = &[cap::SFTP, cap::VSFTPD];

/// Everything an account verb checks before a provider sees it. The home
/// crosses the same path guard as every fs verb, so an account can never
/// be rooted in the agent's own state directory.
fn validate_account(
    h: &Handlers,
    p: &mut FtpAccountParams,
    needs_password: bool,
) -> Result<(), crate::wire::WireError> {
    check_identifier("username", &p.username)?;
    check_protocol(&p.protocol)?;
    p.home_dir = h.paths.check(&p.home_dir)?;
    check_home(&p.home_dir)?;
    if p.quota_bytes < 0 {
        return Err(super::invalid("quota_bytes may not be negative"));
    }
    if let Some(key) = p.ssh_public_key.as_deref().filter(|k| !k.trim().is_empty()) {
        check_public_key(key)?;
    } else {
        p.ssh_public_key = None;
    }
    if needs_password {
        check_password(&p.password)?;
    }
    Ok(())
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "ftp.account.create",
        StreamMode::None,
        NEEDS_TRANSFER,
        h,
        |h, ctx, req| async move {
            let mut p: FtpAccountParams = decode(&req)?;
            validate_account(&h, &mut p, true)?;
            reply(h.provider.ftp().create(&ctx, p).await?)
        },
    ));

    r.register(method(
        "ftp.account.update",
        StreamMode::None,
        NEEDS_TRANSFER,
        h,
        |h, ctx, req| async move {
            let mut p: FtpAccountParams = decode(&req)?;
            // An update never carries a credential; one smuggled in is
            // dropped rather than applied through the wrong verb.
            p.password.clear();
            validate_account(&h, &mut p, false)?;
            reply(h.provider.ftp().update(&ctx, p).await?)
        },
    ));

    r.register(method(
        "ftp.account.passwd",
        StreamMode::None,
        NEEDS_TRANSFER,
        h,
        |h, ctx, req| async move {
            let p: FtpPasswdParams = decode(&req)?;
            check_identifier("username", &p.username)?;
            ftp::check_password(&p.password)?;
            h.provider.ftp().passwd(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "ftp.account.delete",
        StreamMode::None,
        NEEDS_TRANSFER,
        h,
        |h, ctx, req| async move {
            let p: FtpUserParams = decode(&req)?;
            check_identifier("username", &p.username)?;
            h.provider.ftp().delete(&ctx, p).await?;
            reply(OK)
        },
    ));
}
