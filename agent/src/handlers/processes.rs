//! process.* — the process table.

use std::sync::Arc;

use crate::providers::{OK, ProcessListParams, ProcessTreeParams, ProcessTreeResult, SignalParams};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_enum, check_identifier, decode, invalid, method, or_default, present, reply};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("process.list", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: ProcessListParams = decode(&req)?;
        p.sort = or_default(p.sort, "cpu");
        check_enum("sort", &p.sort, &["cpu", "memory", "pid", "name"])?;
        p.limit = or_default(p.limit, 200);
        if let Some(user) = present(&p.user) {
            check_identifier("user", user)?;
        }
        reply(h.provider.processes().list(&ctx, p).await?)
    }));

    r.register(method("process.tree", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: ProcessTreeParams = decode(&req)?;
        if p.pid.is_some_and(|pid| pid <= 0) {
            return Err(invalid("pid must be positive"));
        }
        let processes = h.provider.processes().tree(&ctx, p).await?;
        reply(ProcessTreeResult { processes })
    }));

    r.register(method("process.signal", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: SignalParams = decode(&req)?;
        if p.pid <= 0 {
            return Err(invalid("pid must be positive"));
        }
        check_enum(
            "signal",
            &p.signal,
            &["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT", "SIGUSR1", "SIGUSR2", "SIGSTOP", "SIGCONT"],
        )?;
        h.provider.processes().signal(&ctx, p).await?;
        reply(OK)
    }));
}
