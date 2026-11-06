//! db.* — MySQL/MariaDB and PostgreSQL.

use std::sync::Arc;

use crate::providers::{
    DbDatabaseCreateParams, DbDatabaseDeleteParams, DbDatabaseListResult, DbDumpParams, DbEngineParams,
    DbGrantApplyParams, DbInstanceListResult, DbRestoreParams, DbSizeParams, DbUserCreateParams, DbUserDeleteParams,
    DbUserListResult, DbUserUpdateParams, OK,
};
use crate::registry::{Registry, Request, StreamMode};
use crate::wire::WireError;

use super::{
    Handlers, NO_CAPS, check_engine, check_enum, check_identifier, decode, invalid, method, or_default, present, reply,
    require_stream,
};

fn decode_engine(req: &Request) -> Result<DbEngineParams, WireError> {
    let p: DbEngineParams = decode(req)?;
    check_engine(&p.engine)?;
    Ok(p)
}

const PRIVILEGES: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "INDEX",
    "REFERENCES",
    "TRIGGER",
    "EXECUTE",
    "TEMPORARY",
    "ALL",
];

pub(super) fn register(r: &mut Registry, h: &Arc<Handlers>) {
    r.register(method("db.instance.list", StreamMode::None, NO_CAPS, h, |h, ctx, _req| async move {
        let instances = h.provider.databases().instances(&ctx).await?;
        reply(DbInstanceListResult { instances })
    }));

    r.register(method("db.database.list", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p = decode_engine(&req)?;
        let databases = h.provider.databases().list_databases(&ctx, p).await?;
        reply(DbDatabaseListResult { databases })
    }));

    r.register(method("db.database.create", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: DbDatabaseCreateParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("name", &p.name)?;
        if let Some(owner) = present(&p.owner) {
            check_identifier("owner", owner)?;
        }
        reply(h.provider.databases().create_database(&ctx, p).await?)
    }));

    r.register(method("db.database.delete", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: DbDatabaseDeleteParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("name", &p.name)?;
        h.provider.databases().delete_database(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("db.user.list", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p = decode_engine(&req)?;
        let users = h.provider.databases().list_users(&ctx, p).await?;
        reply(DbUserListResult { users })
    }));

    r.register(method("db.user.create", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbUserCreateParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("username", &p.username)?;
        if p.password.len() < 12 {
            return Err(invalid("password must be at least 12 characters"));
        }
        p.host_pattern = or_default(p.host_pattern, "localhost");
        reply(h.provider.databases().create_user(&ctx, p).await?)
    }));

    r.register(method("db.user.update", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbUserUpdateParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("username", &p.username)?;
        if present(&p.password).is_some_and(|pw| pw.len() < 12) {
            return Err(invalid("password must be at least 12 characters"));
        }
        p.host_pattern = or_default(p.host_pattern, "localhost");
        reply(h.provider.databases().update_user(&ctx, p).await?)
    }));

    r.register(method("db.user.delete", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbUserDeleteParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("username", &p.username)?;
        p.host_pattern = or_default(p.host_pattern, "localhost");
        h.provider.databases().delete_user(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("db.grant.apply", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbGrantApplyParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("database", &p.database)?;
        check_identifier("username", &p.username)?;
        p.host_pattern = or_default(p.host_pattern, "localhost");
        for privilege in &p.privileges {
            check_enum("privileges", &privilege.to_ascii_uppercase(), PRIVILEGES)?;
        }
        h.provider.databases().apply_grant(&ctx, p).await?;
        reply(OK)
    }));

    r.register(method("db.size", StreamMode::None, NO_CAPS, h, |h, ctx, req| async move {
        let p: DbSizeParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("name", &p.name)?;
        reply(h.provider.databases().size(&ctx, p).await?)
    }));

    r.register(method("db.dump", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbDumpParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("name", &p.name)?;
        p.destination = h.paths.check(&p.destination)?;
        let stream = require_stream(&req)?;
        reply(h.provider.databases().dump(&ctx, p, stream).await?)
    }));

    r.register(method("db.restore", StreamMode::Response, NO_CAPS, h, |h, ctx, req| async move {
        let mut p: DbRestoreParams = decode(&req)?;
        check_engine(&p.engine)?;
        check_identifier("name", &p.name)?;
        p.source = h.paths.check(&p.source)?;
        let stream = require_stream(&req)?;
        h.provider.databases().restore(&ctx, p, stream).await?;
        reply(OK)
    }));
}
