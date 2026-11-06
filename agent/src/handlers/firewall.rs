//! fw.* — the packet filter and fail2ban.

use std::sync::Arc;

use crate::providers::{
    FwApplyParams, FwBanParams, FwBansResult, FwConfirmParams, FwListResult, FwThreatsParams, FwThreatsResult,
    FwUnbanParams, OK,
};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_enum, check_target, decode, invalid, method, or_default, reply};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("fw.status", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        reply(h.provider.firewall().status(&ctx).await?)
    }));

    r.register(method("fw.list", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let rules = h.provider.firewall().list(&ctx).await?;
        reply(FwListResult { rules })
    }));

    r.register(method("fw.apply", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
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
    }));

    r.register(method("fw.confirm", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: FwConfirmParams = decode(&req)?;
        if p.rollback_token.is_empty() {
            return Err(invalid("rollback_token is required"));
        }
        h.provider.firewall().confirm(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("fw.ban", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: FwBanParams = decode(&req)?;
        check_target(&p.target)?;
        if p.duration_seconds < 0 {
            return Err(invalid("duration_seconds may not be negative"));
        }
        h.provider.firewall().ban(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("fw.unban", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: FwUnbanParams = decode(&req)?;
        check_target(&p.target)?;
        h.provider.firewall().unban(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("fw.bans.list", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let bans = h.provider.firewall().bans(&ctx).await?;
        reply(FwBansResult { bans })
    }));

    r.register(method("fw.threats", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FwThreatsParams = decode(&req)?;
        p.limit = or_default(p.limit, 500);
        let observations = h.provider.firewall().threats(&ctx, p).await?;
        reply(FwThreatsResult { observations })
    }));
}
