//! pty.* — the one place free-form execution is allowed at all (KD-013).
//!
//! `pty.resize` and `pty.close` carry no session id in the contract, so
//! they address the session opened most recently on this connection.

use std::sync::Arc;

use crate::providers::{OK, PtyOpenParams, PtyResizeParams};
use crate::registry::{Registry, StreamMode};

use super::{Handlers, NO_CAPS, check_dimensions, check_identifier, decode, method, or_default, present, reply, require_stream};

/// Clears the connection's current session when the open call ends,
/// however it ends: by return, by error or by the future being dropped on
/// cancellation.
struct SessionLease {
    h: Arc<Handlers>,
    id: String,
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.h.clear_pty_session(&self.id);
    }
}

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("pty.open", StreamMode::Bidirectional, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: PtyOpenParams = decode(&req)?;
        check_dimensions(p.cols, p.rows)?;
        if let Some(cwd) = present(&p.cwd) {
            p.cwd = Some(h.paths.check(cwd)?);
        }
        if let Some(user) = present(&p.user) {
            check_identifier("user", user)?;
        }
        p.term = or_default(p.term, "xterm-256color");
        let stream = require_stream(&req)?;

        h.set_pty_session(&req.id);
        let _lease = SessionLease {
            h: h.clone(),
            id: req.id.clone(),
        };

        reply(h.provider.pty().open(&ctx, &req.id, p, stream).await?)
    }));

    r.register(method("pty.resize", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: PtyResizeParams = decode(&req)?;
        check_dimensions(p.cols, p.rows)?;
        let session = h.current_pty_session()?;
        h.provider.pty().resize(&ctx, &session, p).await?;
        reply(OK)
    }));

    r.register(method("pty.close", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let session = h.current_pty_session()?;
        h.provider.pty().close(&ctx, &session).await?;
        reply(OK)
    }));
}
