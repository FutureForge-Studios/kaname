//! fw.* — the packet filter and fail2ban.

use std::sync::Arc;

use crate::providers::{
    FwApplyParams, FwBanParams, FwBansResult, FwConfirmParams, FwListResult, FwThreatsParams,
    FwThreatsResult, FwUnbanParams, OK,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_enum, check_target, decode, invalid, method, or_default, reply};
use crate::wire::{ErrorCode, WireError};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method(
        "fw.status",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move { reply(h.provider.firewall().status(&ctx).await?) },
    ));

    r.register(method(
        "fw.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move {
            let rules = h.provider.firewall().list(&ctx).await?;
            reply(FwListResult { rules })
        },
    ));

    r.register(method(
        "fw.apply",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: FwApplyParams = decode(&req)?;
            p.default_inbound = or_default(p.default_inbound, "deny");
            p.default_outbound = or_default(p.default_outbound, "allow");
            check_enum("default_inbound", &p.default_inbound, &["allow", "deny"])?;
            check_enum("default_outbound", &p.default_outbound, &["allow", "deny"])?;
            for rule in &p.rules {
                check_enum("action", &rule.action, &["allow", "deny", "reject"])?;
                check_enum("direction", &rule.direction, &["inbound", "outbound"])?;
                check_enum("protocol", &rule.protocol, &["tcp", "udp", "icmp", "any"])?;
            }
            if !(0..=300).contains(&p.rollback_seconds) {
                return Err(invalid("rollback_seconds must be between 0 and 300"));
            }
            reply(h.provider.firewall().apply(&ctx, p).await?)
        },
    ));

    r.register(method(
        "fw.confirm",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: FwConfirmParams = decode(&req)?;
            if p.rollback_token.is_empty() {
                return Err(invalid("rollback_token is required"));
            }
            h.provider.firewall().confirm(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "fw.ban",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: FwBanParams = decode(&req)?;
            check_target(&p.target)?;
            check_bannable(&p.target)?;
            if p.duration_seconds < 0 {
                return Err(invalid("duration_seconds may not be negative"));
            }
            h.provider.firewall().ban(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "fw.unban",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let p: FwUnbanParams = decode(&req)?;
            check_target(&p.target)?;
            h.provider.firewall().unban(&ctx, p).await?;
            reply(OK)
        },
    ));

    r.register(method(
        "fw.bans.list",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, _req| async move {
            let bans = h.provider.firewall().bans(&ctx).await?;
            reply(FwBansResult { bans })
        },
    ));

    r.register(method(
        "fw.threats",
        StreamMode::None,
        NO_CAPS,
        h,
        |h, ctx, req| async move {
            let mut p: FwThreatsParams = decode(&req)?;
            p.limit = or_default(p.limit, 500);
            let observations = h.provider.firewall().threats(&ctx, p).await?;
            reply(FwThreatsResult { observations })
        },
    ));
}

/// Refuses a ban this host must never apply, whichever provider runs it.
///
/// A ban covering loopback cuts the host off from itself — the local
/// resolver, the database on 127.0.0.1, the reverse proxy in front of the
/// panel — and a /0 drops every packet from everywhere, the agent's own
/// replies included. Neither is ever what "ban this address" meant, and
/// the second is a lockout the rollback window does not cover (a ban has
/// no window). The control plane sends what the operator typed, so the
/// host is the place that says no.
pub(crate) fn check_bannable(target: &str) -> Result<(), WireError> {
    let (address, prefix) = match target.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (target, None),
    };
    let Ok(address) = address.parse::<std::net::IpAddr>() else {
        // Malformed targets are check_target's to refuse, and the provider's.
        return Ok(());
    };
    let bits: u8 = if address.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
        Some(p) => p.parse::<u8>().ok().filter(|p| *p <= bits),
        None => Some(bits),
    };
    let Some(prefix) = prefix else {
        return Ok(());
    };
    if prefix == 0 {
        return Err(precondition(format!(
            "{target} covers every address; banning it would cut this host off from everything, the panel included"
        )));
    }
    let covers_loopback = match address {
        std::net::IpAddr::V4(v4) => {
            // 127.0.0.0/8 overlaps the range when their common prefix matches.
            let shared = prefix.min(8);
            let mask = if shared == 0 { 0 } else { u32::MAX << (32 - shared) };
            (u32::from(v4) & mask) == (u32::from(std::net::Ipv4Addr::new(127, 0, 0, 0)) & mask)
        }
        std::net::IpAddr::V6(v6) => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            (u128::from(v6) & mask) == (u128::from(std::net::Ipv6Addr::LOCALHOST) & mask)
        }
    };
    if covers_loopback {
        return Err(precondition(format!(
            "{target} covers this host's loopback address; banning it would cut the host off from its own services"
        )));
    }
    Ok(())
}

fn precondition(message: String) -> WireError {
    WireError::new(ErrorCode::PreconditionFailed, message)
}

#[cfg(test)]
mod tests {
    use super::check_bannable;

    #[test]
    fn ordinary_addresses_and_ranges_may_be_banned() {
        for target in [
            "203.0.113.7",
            "203.0.113.7/32",
            "198.51.100.0/24",
            "10.0.0.0/8",
            "128.0.0.0/1",
            "2001:db8::1",
            "2001:db8::/32",
        ] {
            assert!(check_bannable(target).is_ok(), "{target} was refused");
        }
    }

    #[test]
    fn loopback_and_everything_are_refused_as_a_precondition() {
        for target in [
            "127.0.0.1",
            "127.0.0.1/32",
            "127.10.0.0/16",
            "126.0.0.0/7",
            "0.0.0.0/0",
            "0.0.0.0/1",
            "::1",
            "::1/128",
            "::/0",
            "::/64",
        ] {
            let err = check_bannable(target).expect_err(target);
            assert!(
                matches!(err.code, crate::wire::ErrorCode::PreconditionFailed),
                "{target}"
            );
            assert!(err.message.contains(target), "{target}: {}", err.message);
        }
    }
}
