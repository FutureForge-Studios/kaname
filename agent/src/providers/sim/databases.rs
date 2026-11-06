//! Databases.
//!
//! Two engines, because the panel has to prove it can hold both at once: a
//! PostgreSQL 16 cluster carrying the applications, and a MariaDB instance
//! carrying the legacy blog. Creating a database or a user really adds
//! one, and dropping one really removes it — including the grants that
//! pointed at it, which is the part a naive fake forgets.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use super::files::{Node, clean_path, path_base, path_dir};
use super::services::unit_active;
use super::state::{Sim, World, hash_string, mix, progress};
use crate::providers::{
    Ctx, Databases, DbDatabaseCreateParams, DbDatabaseDeleteParams, DbDatabaseInfo, DbDumpParams, DbDumpResult,
    DbEngineParams, DbGrantApplyParams, DbInstanceInfo, DbRestoreParams, DbSizeParams, DbSizeResult,
    DbUserCreateParams, DbUserDeleteParams, DbUserInfo, DbUserUpdateParams, PResult, ProviderError, StreamRef,
};

pub const ENGINE_POSTGRES: &str = "postgres";
pub const ENGINE_MARIADB: &str = "mariadb";
pub const ENGINE_MYSQL: &str = "mysql";

pub fn build_databases(sim: &Sim) {
    let mut w = sim.world.lock();

    let postgres: &[(&str, &str, i64, i64)] = &[
        ("kaname", "kaname", 1_884_301_824, 42),
        ("storefront", "storefront", 6_442_450_944, 118),
        ("analytics", "analytics", 21_474_836_480, 27),
        ("uptime_kuma", "kaname", 184_549_376, 19),
        ("n8n", "kaname", 512_802_816, 34),
        ("postgres", "postgres", 8_495_104, 0),
    ];
    w.databases.insert(
        ENGINE_POSTGRES.into(),
        postgres
            .iter()
            .map(|(name, owner, size, tables)| DbDatabaseInfo {
                name: name.to_string(),
                owner: Some(owner.to_string()),
                encoding: "UTF8".into(),
                collation: Some("en_US.UTF-8".into()),
                size_bytes: *size,
                table_count: *tables,
            })
            .collect(),
    );

    let mariadb: &[(&str, i64, i64)] =
        &[("blog_prod", 3_221_225_472, 64), ("blog_staging", 486_539_264, 64), ("legacy_crm", 12_884_901_888, 211)];
    w.databases.insert(
        ENGINE_MARIADB.into(),
        mariadb
            .iter()
            .map(|(name, size, tables)| DbDatabaseInfo {
                name: name.to_string(),
                owner: Some("root".into()),
                encoding: "utf8mb4".into(),
                collation: Some("utf8mb4_general_ci".into()),
                size_bytes: *size,
                table_count: *tables,
            })
            .collect(),
    );

    let user = |name: &str, host: &str, plugin: &str, superuser: bool, login: bool| DbUserInfo {
        username: name.into(),
        host_pattern: host.into(),
        auth_plugin: Some(plugin.into()),
        is_superuser: superuser,
        can_login: login,
    };
    w.db_users.insert(
        ENGINE_POSTGRES.into(),
        vec![
            user("postgres", "localhost", "scram-sha-256", true, true),
            user("kaname", "localhost", "scram-sha-256", false, true),
            user("storefront", "localhost", "scram-sha-256", false, true),
            user("analytics", "localhost", "scram-sha-256", false, true),
            user("readonly", "localhost", "scram-sha-256", false, true),
            user("replication", "10.20.30.0/24", "scram-sha-256", false, false),
        ],
    );
    w.db_users.insert(
        ENGINE_MARIADB.into(),
        vec![
            user("root", "localhost", "unix_socket", true, true),
            user("blog", "localhost", "mysql_native_password", false, true),
            user("backup", "%", "mysql_native_password", false, true),
        ],
    );

    let grants: &[(&str, &str, &str, &str, &[&str])] = &[
        (ENGINE_POSTGRES, "kaname", "kaname", "localhost", &["ALL"]),
        (ENGINE_POSTGRES, "storefront", "storefront", "localhost", &["ALL"]),
        (ENGINE_POSTGRES, "analytics", "analytics", "localhost", &["ALL"]),
        (ENGINE_POSTGRES, "analytics", "readonly", "localhost", &["SELECT"]),
        (ENGINE_POSTGRES, "storefront", "readonly", "localhost", &["SELECT"]),
        (ENGINE_MARIADB, "blog_prod", "blog", "localhost", &["SELECT", "INSERT", "UPDATE", "DELETE"]),
        (ENGINE_MARIADB, "blog_staging", "blog", "localhost", &["ALL"]),
        (ENGINE_MARIADB, "legacy_crm", "backup", "%", &["SELECT"]),
    ];
    for (engine, database, user, host, privileges) in grants {
        w.db_grants.insert(grant_key(engine, database, user, host), privileges.iter().map(|p| p.to_string()).collect());
    }
}

fn grant_key(engine: &str, database: &str, user: &str, host: &str) -> String {
    format!("{engine}|{database}|{user}|{host}")
}

/// Folds mysql onto mariadb: the host runs one of them, and a panel
/// configured for either should reach it.
fn normalise_engine(engine: &str) -> String {
    if engine == ENGINE_MYSQL { ENGINE_MARIADB.into() } else { engine.into() }
}

pub fn find_database<'a>(w: &'a World, engine: &str, name: &str) -> Option<&'a DbDatabaseInfo> {
    w.databases.get(&normalise_engine(engine))?.iter().find(|db| db.name == name)
}

fn find_database_mut<'a>(w: &'a mut World, engine: &str, name: &str) -> Option<&'a mut DbDatabaseInfo> {
    w.databases.get_mut(&normalise_engine(engine))?.iter_mut().find(|db| db.name == name)
}

fn find_user_index(w: &World, engine: &str, username: &str, host: &str) -> Option<usize> {
    w.db_users
        .get(&normalise_engine(engine))?
        .iter()
        .position(|u| u.username == username && (host.is_empty() || u.host_pattern == host))
}

fn sum_sizes(w: &World, engine: &str) -> i64 {
    w.databases.get(engine).map(|dbs| dbs.iter().map(|d| d.size_bytes).sum()).unwrap_or(0)
}

fn dump_table_name(engine: &str, index: usize) -> &'static str {
    const PG: &[&str] = &[
        "users", "sessions", "orders", "order_items", "products", "inventory",
        "audit_events", "jobs", "job_logs", "settings", "migrations", "carts",
    ];
    const WP: &[&str] = &[
        "wp_posts", "wp_postmeta", "wp_options", "wp_users", "wp_usermeta",
        "wp_terms", "wp_term_taxonomy", "wp_comments", "wp_commentmeta",
        "wp_links", "wp_termmeta", "wp_term_relationships",
    ];
    let tables = if engine == ENGINE_MARIADB { WP } else { PG };
    tables[index % tables.len()]
}

pub struct SimDatabases(pub Arc<Sim>);

#[async_trait]
impl Databases for SimDatabases {
    async fn instances(&self, _ctx: &Ctx) -> PResult<Vec<DbInstanceInfo>> {
        let now = Utc::now();
        let w = self.0.world.lock();
        let uptime = (now - w.boot_time).num_seconds();
        Ok(vec![
            DbInstanceInfo {
                engine: ENGINE_POSTGRES.into(),
                version: "16.3 (Debian 16.3-1.pgdg120+1)".into(),
                host: "127.0.0.1".into(),
                port: 5432,
                reachable: unit_active(&w, "postgresql@16-main.service"),
                uptime_seconds: Some(uptime),
                connections: Some(11 + (mix(self.0.seed ^ 0xd1) % 14) as i64),
                max_connections: Some(100),
                data_size: Some(sum_sizes(&w, ENGINE_POSTGRES)),
            },
            DbInstanceInfo {
                engine: ENGINE_MARIADB.into(),
                version: "10.11.6-MariaDB-0+deb12u1".into(),
                host: "127.0.0.1".into(),
                port: 3306,
                reachable: unit_active(&w, "mariadb.service"),
                uptime_seconds: Some(uptime),
                connections: Some(3 + (mix(self.0.seed ^ 0xd2) % 9) as i64),
                max_connections: Some(151),
                data_size: Some(sum_sizes(&w, ENGINE_MARIADB)),
            },
        ])
    }

    async fn list_databases(&self, _ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbDatabaseInfo>> {
        let w = self.0.world.lock();
        let mut out = w.databases.get(&normalise_engine(&p.engine)).cloned().unwrap_or_default();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn create_database(&self, _ctx: &Ctx, p: DbDatabaseCreateParams) -> PResult<DbDatabaseInfo> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        if find_database(&w, &engine, &p.name).is_some() {
            return Err(ProviderError::conflict(format!("database {} already exists", p.name)));
        }

        let (mut encoding, mut collation) = ("UTF8".to_string(), "en_US.UTF-8".to_string());
        if engine == ENGINE_MARIADB {
            encoding = "utf8mb4".into();
            collation = "utf8mb4_general_ci".into();
        }
        if let Some(e) = p.encoding.filter(|e| !e.is_empty()) {
            encoding = e;
        }
        if let Some(c) = p.collation.filter(|c| !c.is_empty()) {
            collation = c;
        }
        let owner = p.owner.filter(|o| !o.is_empty()).unwrap_or_else(|| {
            if engine == ENGINE_MARIADB { "root".to_string() } else { "postgres".to_string() }
        });

        let db = DbDatabaseInfo {
            name: p.name,
            owner: Some(owner),
            encoding,
            collation: Some(collation),
            size_bytes: 8_495_104,
            table_count: 0,
        };
        w.databases.entry(engine).or_default().push(db.clone());
        Ok(db)
    }

    async fn delete_database(&self, _ctx: &Ctx, p: DbDatabaseDeleteParams) -> PResult<()> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        let dbs = w.databases.entry(engine.clone()).or_default();
        let Some(index) = dbs.iter().position(|db| db.name == p.name) else {
            return Err(ProviderError::not_found(format!("database {}", p.name)));
        };
        dbs.remove(index);

        // Grants that pointed at the dropped database go with it; leaving
        // them behind is how a panel ends up showing privileges on nothing.
        let prefix = format!("{engine}|{}|", p.name);
        w.db_grants.retain(|key, _| !key.starts_with(&prefix));
        Ok(())
    }

    async fn list_users(&self, _ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbUserInfo>> {
        let w = self.0.world.lock();
        let mut out = w.db_users.get(&normalise_engine(&p.engine)).cloned().unwrap_or_default();
        out.sort_by(|a, b| a.username.cmp(&b.username));
        Ok(out)
    }

    async fn create_user(&self, _ctx: &Ctx, p: DbUserCreateParams) -> PResult<DbUserInfo> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        if find_user_index(&w, &engine, &p.username, &p.host_pattern).is_some() {
            return Err(ProviderError::conflict(format!("user {} already exists", p.username)));
        }
        let plugin = if engine == ENGINE_MARIADB { "mysql_native_password" } else { "scram-sha-256" };
        let user = DbUserInfo {
            username: p.username,
            host_pattern: p.host_pattern,
            auth_plugin: Some(plugin.into()),
            is_superuser: false,
            can_login: true,
        };
        w.db_users.entry(engine).or_default().push(user.clone());
        Ok(user)
    }

    async fn update_user(&self, _ctx: &Ctx, p: DbUserUpdateParams) -> PResult<DbUserInfo> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        let Some(index) = find_user_index(&w, &engine, &p.username, &p.host_pattern) else {
            return Err(ProviderError::not_found(format!("user {}", p.username)));
        };
        let user = &mut w.db_users.get_mut(&engine).expect("engine present")[index];
        if let Some(can_login) = p.can_login {
            user.can_login = can_login;
        }
        Ok(user.clone())
    }

    async fn delete_user(&self, _ctx: &Ctx, p: DbUserDeleteParams) -> PResult<()> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        let users = w.db_users.entry(engine).or_default();
        let Some(index) = users.iter().position(|u| u.username == p.username && u.host_pattern == p.host_pattern) else {
            return Err(ProviderError::not_found(format!("user {}@{}", p.username, p.host_pattern)));
        };
        if users[index].is_superuser {
            return Err(ProviderError::PermissionDenied(format!("refusing to drop the superuser {}", p.username)));
        }
        users.remove(index);

        let suffix = format!("|{}|{}", p.username, p.host_pattern);
        w.db_grants.retain(|key, _| !key.ends_with(&suffix));
        Ok(())
    }

    async fn apply_grant(&self, _ctx: &Ctx, p: DbGrantApplyParams) -> PResult<()> {
        let engine = normalise_engine(&p.engine);
        let mut w = self.0.world.lock();
        if find_database(&w, &engine, &p.database).is_none() {
            return Err(ProviderError::not_found(format!("database {}", p.database)));
        }
        if find_user_index(&w, &engine, &p.username, &p.host_pattern).is_none() {
            return Err(ProviderError::not_found(format!("user {}@{}", p.username, p.host_pattern)));
        }

        let key = grant_key(&engine, &p.database, &p.username, &p.host_pattern);
        if p.privileges.is_empty() {
            w.db_grants.remove(&key);
            return Ok(());
        }
        let mut privileges: Vec<String> = p.privileges.iter().map(|p| p.to_uppercase()).collect();
        privileges.sort();
        w.db_grants.insert(key, privileges);
        Ok(())
    }

    async fn size(&self, _ctx: &Ctx, p: DbSizeParams) -> PResult<DbSizeResult> {
        let w = self.0.world.lock();
        let Some(db) = find_database(&w, &p.engine, &p.name) else {
            return Err(ProviderError::not_found(format!("database {}", p.name)));
        };
        Ok(DbSizeResult { size_bytes: db.size_bytes, table_count: db.table_count })
    }

    async fn dump(&self, ctx: &Ctx, p: DbDumpParams, s: StreamRef) -> PResult<DbDumpResult> {
        let destination = clean_path(&p.destination)?;
        let engine = normalise_engine(&p.engine);

        let (logical, tables) = {
            let w = self.0.world.lock();
            let Some(db) = find_database(&w, &engine, &p.name) else {
                return Err(ProviderError::not_found(format!("database {}", p.name)));
            };
            (db.size_bytes, db.table_count)
        };

        let tool = if engine == ENGINE_MARIADB { "mariadb-dump" } else { "pg_dump" };
        progress(ctx, &*s, Duration::ZERO, format!("{tool}: dumping database {:?} to {destination}", p.name)).await?;
        for i in 0..tables.min(12) {
            progress(
                ctx,
                &*s,
                Duration::from_millis(110),
                format!("{tool}: dumping contents of table \"public.{}\"", dump_table_name(&engine, i as usize)),
            )
            .await?;
        }

        let size = if p.compress { logical / 11 } else { logical / 4 };

        {
            let mut fs = self.0.fs.write();
            fs.mkdir_all(&path_dir(&destination));
            let mut n = Node::new_file(&path_base(&destination), Vec::new(), "0640", Utc::now());
            n.virtual_size = size;
            fs.parent_mut(&destination)?.children.insert(path_base(&destination), n);
        }
        self.0.account_bytes(size);

        let _ = progress(ctx, &*s, Duration::ZERO, format!("{tool}: wrote {destination} ({size} bytes, {tables} tables)")).await;
        Ok(DbDumpResult { path: destination, size_bytes: size })
    }

    async fn restore(&self, ctx: &Ctx, p: DbRestoreParams, s: StreamRef) -> PResult<()> {
        let source = clean_path(&p.source)?;
        let engine = normalise_engine(&p.engine);

        let size = {
            let fs = self.0.fs.read();
            let (dump, _) = fs.lookup(&source, true)?;
            dump.size()
        };

        let tool = if engine == ENGINE_MARIADB { "mariadb" } else { "psql" };

        {
            let mut w = self.0.world.lock();
            if find_database(&w, &engine, &p.name).is_none() {
                if !p.drop_existing {
                    return Err(ProviderError::not_found(format!("database {}", p.name)));
                }
                w.databases.entry(engine.clone()).or_default().push(DbDatabaseInfo {
                    name: p.name.clone(),
                    owner: Some("postgres".into()),
                    encoding: "UTF8".into(),
                    collation: Some("en_US.UTF-8".into()),
                    size_bytes: 0,
                    table_count: 0,
                });
            }
        }

        let mut steps = vec![format!("{tool}: restoring {source} into {:?}", p.name)];
        if p.drop_existing {
            steps.push(format!("{tool}: DROP DATABASE IF EXISTS {}", p.name));
            steps.push(format!("{tool}: CREATE DATABASE {}", p.name));
        }
        steps.extend([
            format!("{tool}: creating schema \"public\""),
            format!("{tool}: restoring data"),
            format!("{tool}: creating indexes"),
            format!("{tool}: restoring constraints"),
        ]);
        for step in steps {
            progress(ctx, &*s, Duration::from_millis(220), step).await?;
        }

        {
            let mut w = self.0.world.lock();
            if let Some(db) = find_database_mut(&mut w, &engine, &p.name) {
                db.size_bytes = size * 4;
                db.table_count = 12 + (mix(self.0.seed ^ hash_string(&p.name)) % 60) as i64;
            }
        }

        let _ = progress(ctx, &*s, Duration::ZERO, format!("{tool}: restore complete")).await;
        Ok(())
    }
}
