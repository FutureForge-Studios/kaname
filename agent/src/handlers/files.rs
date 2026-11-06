//! fs.* — the filesystem. Every path crosses the guard before a provider
//! sees it.

use std::sync::Arc;

use crate::providers::{
    FsArchiveParams, FsChmodParams, FsChownParams, FsCopyParams, FsDownloadParams, FsExtractParams, FsExtractResult,
    FsListParams, FsMkdirParams, FsMoveParams, FsReadParams, FsRemoveParams, FsRemoveResult, FsStatParams,
    FsUploadParams, FsUsageParams, FsWriteParams, OK,
};
use crate::registry::{Registry, StreamMode};

use super::{
    Handlers, NO_CAPS, check_enum, check_identifier, check_mode, decode, invalid, method, or_default, present, reply,
    require_stream,
};

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("fs.list", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsListParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        p.limit = or_default(p.limit, 1000);
        reply(h.provider.files().list(&ctx, p).await?)
    }));

    r.register(method("fs.stat", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsStatParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        reply(h.provider.files().stat(&ctx, &p.path).await?)
    }));

    r.register(method("fs.read", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsReadParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        if p.max_bytes <= 0 {
            p.max_bytes = 1024 * 1024;
        }
        reply(h.provider.files().read(&ctx, p).await?)
    }));

    r.register(method("fs.write", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsWriteParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        p.encoding = or_default(p.encoding, "utf8");
        check_enum("encoding", &p.encoding, &["utf8", "base64"])?;
        check_mode(p.mode.as_deref().unwrap_or(""))?;
        reply(h.provider.files().write(&ctx, p).await?)
    }));

    r.register(method("fs.mkdir", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsMkdirParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        check_mode(p.mode.as_deref().unwrap_or(""))?;
        reply(h.provider.files().mkdir(&ctx, p).await?)
    }));

    r.register(method("fs.move", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsMoveParams = decode(&req)?;
        p.from = h.paths.check(&p.from)?;
        p.to = h.paths.check(&p.to)?;
        reply(h.provider.files().r#move(&ctx, p).await?)
    }));

    r.register(method("fs.copy", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsCopyParams = decode(&req)?;
        p.from = h.paths.check(&p.from)?;
        p.to = h.paths.check(&p.to)?;
        reply(h.provider.files().copy(&ctx, p).await?)
    }));

    r.register(method("fs.remove", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsRemoveParams = decode(&req)?;
        p.paths = h.paths.check_all(&p.paths)?;
        let removed = h.provider.files().remove(&ctx, p).await?;
        reply(FsRemoveResult { removed })
    }));

    r.register(method("fs.chmod", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsChmodParams = decode(&req)?;
        p.paths = h.paths.check_all(&p.paths)?;
        if p.mode.is_empty() {
            return Err(invalid("mode is required"));
        }
        check_mode(&p.mode)?;
        h.provider.files().chmod(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("fs.chown", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsChownParams = decode(&req)?;
        p.paths = h.paths.check_all(&p.paths)?;
        let owner = present(&p.owner);
        let group = present(&p.group);
        if owner.is_none() && group.is_none() {
            return Err(invalid("one of owner or group is required"));
        }
        if let Some(owner) = owner {
            check_identifier("owner", owner)?;
        }
        if let Some(group) = group {
            check_identifier("group", group)?;
        }
        h.provider.files().chown(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("fs.archive", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsArchiveParams = decode(&req)?;
        p.paths = h.paths.check_all(&p.paths)?;
        p.destination = h.paths.check(&p.destination)?;
        p.format = or_default(p.format, "tar.gz");
        check_enum("format", &p.format, &["tar.gz", "tar.zst", "zip"])?;
        let stream = require_stream(&req)?;
        reply(h.provider.files().archive(&ctx, p, stream).await?)
    }));

    r.register(method("fs.extract", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsExtractParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        p.destination = h.paths.check(&p.destination)?;
        let stream = require_stream(&req)?;
        let extracted = h.provider.files().extract(&ctx, p, stream).await?;
        reply(FsExtractResult { extracted })
    }));

    r.register(method("fs.download", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsDownloadParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        let stream = require_stream(&req)?;
        reply(h.provider.files().download(&ctx, p, stream).await?)
    }));

    r.register(method("fs.upload", StreamMode::Bidirectional, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsUploadParams = decode(&req)?;
        p.path = h.paths.check(&p.path)?;
        if p.size < 0 {
            return Err(invalid("size may not be negative"));
        }
        check_mode(p.mode.as_deref().unwrap_or(""))?;
        let stream = require_stream(&req)?;
        reply(h.provider.files().upload(&ctx, p, stream).await?)
    }));

    r.register(method("fs.usage", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: FsUsageParams = decode(&req)?;
        p.path = or_default(p.path, "/");
        p.path = h.paths.check(&p.path)?;
        p.depth = or_default(p.depth, 1).min(4);
        reply(h.provider.files().usage(&ctx, p).await?)
    }));
}
