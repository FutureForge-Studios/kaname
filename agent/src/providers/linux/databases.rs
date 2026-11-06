//! Databases.
//!
//! The engines are driven through their own CLI clients, and every
//! statement travels on stdin rather than in `-e`: a password in an argv
//! is a password every user on the host can read out of /proc.
//!
//! Identifiers arrive already validated by the RPC layer and are quoted
//! again here — backticks for MySQL, double quotes for PostgreSQL — so a
//! name can never break out of its position in a statement.

use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::Shared;
use super::common::{invalid, not_found, precondition, split_lines, unsupported};
use super::exec::{self, ExecOptions};
use crate::providers::*;

/// Field separator for psql's unaligned output. A unit separator cannot
/// appear in an identifier, so splitting on it is unambiguous.
const PSQL_SEPARATOR: &str = "\x1f";
/// How much dump output goes by before the operator gets a progress line.
const DUMP_PROGRESS_STRIDE: u64 = 8 << 20;

/// Schemas that belong to the engine rather than to the operator.
const SYSTEM_SCHEMAS: &[&str] = &[
    "information_schema",
    "mysql",
    "performance_schema",
    "sys",
    "template0",
    "template1",
];

fn is_system_schema(name: &str) -> bool {
    SYSTEM_SCHEMAS.contains(&name)
}

pub struct DatabaseOps(pub Arc<Shared>);

type Rows = Vec<Vec<String>>;

fn first(row: &[String]) -> &str {
    row.first().map(String::as_str).unwrap_or_default()
}

/// Maps the kernel's answers onto the provider sentinels so the panel can
/// say "not found" or "permission denied" rather than surfacing an errno.
fn wrap_fs_error(target: &str, err: std::io::Error) -> ProviderError {
    match err.kind() {
        std::io::ErrorKind::NotFound => not_found(target),
        std::io::ErrorKind::PermissionDenied => ProviderError::PermissionDenied(target.to_string()),
        std::io::ErrorKind::AlreadyExists => ProviderError::conflict(format!("{target} already exists")),
        _ if err.raw_os_error() == Some(libc::ENOSPC) => precondition(format!("no space left for {target}")),
        _ => ProviderError::internal(format!("{target}: {err}")),
    }
}

/* ------------------------------ instances ---------------------------- */

#[async_trait]
impl Databases for DatabaseOps {
    async fn instances(&self, ctx: &Ctx) -> PResult<Vec<DbInstanceInfo>> {
        let mut instances = Vec::with_capacity(2);

        if self.0.has(cap::MYSQL) || self.0.has(cap::MARIADB) {
            let engine = if self.0.has(cap::MARIADB) && !self.0.has(cap::MYSQL) {
                "mariadb"
            } else {
                "mysql"
            };
            instances.push(self.mysql_instance(ctx, engine).await);
        }
        if self.0.has(cap::POSTGRES) {
            instances.push(self.postgres_instance(ctx).await);
        }
        if instances.is_empty() {
            return Err(unsupported("no database client is installed on this host"));
        }
        Ok(instances)
    }

    /* ------------------------------ databases ---------------------------- */

    async fn list_databases(&self, ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbDatabaseInfo>> {
        if is_postgres(&p.engine) {
            let rows = self
                .psql(
                    ctx,
                    "postgres",
                    &[
                        "SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding),",
                        "       d.datcollate, pg_database_size(d.datname)::bigint",
                        "FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname;",
                    ]
                    .join("\n"),
                )
                .await?;

            let mut databases = Vec::with_capacity(rows.len());
            for row in rows {
                if row.len() < 5 {
                    continue;
                }
                let mut info = DbDatabaseInfo {
                    name: row[0].clone(),
                    owner: Some(row[1].clone()),
                    encoding: row[2].clone(),
                    collation: Some(row[3].clone()),
                    size_bytes: row[4].parse().unwrap_or(0),
                    table_count: 0,
                };
                info.table_count = self.postgres_table_count(ctx, &row[0]).await;
                databases.push(info);
            }
            return Ok(databases);
        }

        let rows = self
            .mysql(
                ctx,
                "",
                &[
                    "SELECT s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME,",
                    "       COALESCE(SUM(t.DATA_LENGTH+t.INDEX_LENGTH),0), COUNT(t.TABLE_NAME)",
                    "FROM information_schema.SCHEMATA s",
                    "LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME",
                    "GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME",
                    "ORDER BY s.SCHEMA_NAME;",
                ]
                .join("\n"),
            )
            .await?;

        let mut databases = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 5 || is_system_schema(&row[0]) {
                continue;
            }
            databases.push(DbDatabaseInfo {
                name: row[0].clone(),
                owner: None,
                encoding: row[1].clone(),
                collation: Some(row[2].clone()),
                size_bytes: row[3].parse().unwrap_or(0),
                table_count: row[4].parse().unwrap_or(0),
            });
        }
        Ok(databases)
    }

    async fn create_database(&self, ctx: &Ctx, p: DbDatabaseCreateParams) -> PResult<DbDatabaseInfo> {
        let encoding = p.encoding.as_deref().filter(|e| !e.is_empty());
        let collation = p.collation.as_deref().filter(|c| !c.is_empty());
        let owner = p.owner.as_deref().filter(|o| !o.is_empty());

        if is_postgres(&p.engine) {
            let mut statement = format!("CREATE DATABASE {}", quote_pg(&p.name));
            if let Some(encoding) = encoding {
                check_charset(encoding)?;
                statement.push_str(&format!(" ENCODING {}", literal(encoding)));
            }
            if let Some(collation) = collation {
                check_charset(collation)?;
                // A non-default collation needs template0; template1 carries the
                // cluster's own locale and would reject it.
                statement.push_str(&format!(" LC_COLLATE {} TEMPLATE template0", literal(collation)));
            }
            if let Some(owner) = owner {
                statement.push_str(&format!(" OWNER {}", quote_pg(owner)));
            }
            self.psql(ctx, "postgres", &format!("{statement};")).await?;
        } else {
            let mut statement = format!("CREATE DATABASE {}", quote_mysql(&p.name));
            if let Some(encoding) = encoding {
                check_charset(encoding)?;
                statement.push_str(&format!(" CHARACTER SET {encoding}"));
            }
            if let Some(collation) = collation {
                check_charset(collation)?;
                statement.push_str(&format!(" COLLATE {collation}"));
            }
            self.mysql(ctx, "", &format!("{statement};")).await?;
        }

        let databases = self
            .list_databases(
                ctx,
                DbEngineParams {
                    engine: p.engine.clone(),
                },
            )
            .await?;
        if let Some(database) = databases.into_iter().find(|d| d.name == p.name) {
            return Ok(database);
        }
        Ok(DbDatabaseInfo {
            name: p.name,
            encoding: encoding.unwrap_or_default().to_string(),
            ..Default::default()
        })
    }

    async fn delete_database(&self, ctx: &Ctx, p: DbDatabaseDeleteParams) -> PResult<()> {
        if is_system_schema(&p.name) {
            return Err(ProviderError::PermissionDenied(format!(
                "{} belongs to the engine and will not be dropped",
                p.name
            )));
        }
        if is_postgres(&p.engine) {
            self.psql(
                ctx,
                "postgres",
                &format!("DROP DATABASE IF EXISTS {};", quote_pg(&p.name)),
            )
            .await?;
            return Ok(());
        }
        self.mysql(
            ctx,
            "",
            &format!("DROP DATABASE IF EXISTS {};", quote_mysql(&p.name)),
        )
        .await?;
        Ok(())
    }

    /* -------------------------------- users ------------------------------ */

    async fn list_users(&self, ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbUserInfo>> {
        if is_postgres(&p.engine) {
            let rows = self
                .psql(
                    ctx,
                    "postgres",
                    "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;",
                )
                .await?;
            return Ok(rows
                .into_iter()
                .filter(|row| row.len() >= 3)
                .map(|row| DbUserInfo {
                    username: row[0].clone(),
                    host_pattern: "localhost".into(),
                    auth_plugin: None,
                    is_superuser: row[1] == "t",
                    can_login: row[2] == "t",
                })
                .collect());
        }

        let rows = match self
            .mysql(
                ctx,
                "",
                "SELECT User, Host, plugin, Super_priv, account_locked FROM mysql.user ORDER BY User, Host;",
            )
            .await
        {
            Ok(rows) => rows,
            // Older MySQL has no account_locked column; ask again without it
            // rather than failing the whole page.
            Err(_) => {
                self.mysql(
                    ctx,
                    "",
                    "SELECT User, Host, plugin, Super_priv FROM mysql.user ORDER BY User, Host;",
                )
                .await?
            }
        };

        let mut users = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 4 {
                continue;
            }
            let mut user = DbUserInfo {
                username: row[0].clone(),
                host_pattern: row[1].clone(),
                auth_plugin: None,
                is_superuser: row[3].eq_ignore_ascii_case("Y"),
                can_login: true,
            };
            if !row[2].is_empty() && row[2] != "NULL" {
                user.auth_plugin = Some(row[2].clone());
            }
            if row.len() > 4 && row[4].eq_ignore_ascii_case("Y") {
                user.can_login = false;
            }
            users.push(user);
        }
        Ok(users)
    }

    async fn create_user(&self, ctx: &Ctx, p: DbUserCreateParams) -> PResult<DbUserInfo> {
        if is_postgres(&p.engine) {
            let statement = format!(
                "CREATE ROLE {} LOGIN PASSWORD {};",
                quote_pg(&p.username),
                literal(&p.password)
            );
            self.psql(ctx, "postgres", &statement).await?;
            return Ok(DbUserInfo {
                username: p.username,
                host_pattern: "localhost".into(),
                can_login: true,
                ..Default::default()
            });
        }

        check_host_pattern(&p.host_pattern)?;
        let statement = format!(
            "CREATE USER {}@{} IDENTIFIED BY {};",
            literal(&p.username),
            literal(&p.host_pattern),
            literal(&p.password)
        );
        self.mysql(ctx, "", &statement).await?;
        Ok(DbUserInfo {
            username: p.username,
            host_pattern: p.host_pattern,
            can_login: true,
            ..Default::default()
        })
    }

    async fn update_user(&self, ctx: &Ctx, p: DbUserUpdateParams) -> PResult<DbUserInfo> {
        let mut statements: Vec<String> = Vec::with_capacity(2);
        let password = p.password.as_deref().filter(|pw| !pw.is_empty());

        if is_postgres(&p.engine) {
            if let Some(password) = password {
                statements.push(format!(
                    "ALTER ROLE {} PASSWORD {};",
                    quote_pg(&p.username),
                    literal(password)
                ));
            }
            if let Some(can_login) = p.can_login {
                let access = if can_login { "LOGIN" } else { "NOLOGIN" };
                statements.push(format!("ALTER ROLE {} {access};", quote_pg(&p.username)));
            }
            if !statements.is_empty() {
                self.psql(ctx, "postgres", &statements.join("\n")).await?;
            }
            return Ok(DbUserInfo {
                username: p.username,
                host_pattern: "localhost".into(),
                can_login: p.can_login.unwrap_or(true),
                ..Default::default()
            });
        }

        check_host_pattern(&p.host_pattern)?;
        let account = format!("{}@{}", literal(&p.username), literal(&p.host_pattern));
        if let Some(password) = password {
            statements.push(format!(
                "ALTER USER {account} IDENTIFIED BY {};",
                literal(password)
            ));
        }
        if let Some(can_login) = p.can_login {
            let state = if can_login {
                "ACCOUNT UNLOCK"
            } else {
                "ACCOUNT LOCK"
            };
            statements.push(format!("ALTER USER {account} {state};"));
        }
        if !statements.is_empty() {
            self.mysql(ctx, "", &statements.join("\n")).await?;
        }
        Ok(DbUserInfo {
            username: p.username,
            host_pattern: p.host_pattern,
            can_login: p.can_login.unwrap_or(true),
            ..Default::default()
        })
    }

    async fn delete_user(&self, ctx: &Ctx, p: DbUserDeleteParams) -> PResult<()> {
        if is_postgres(&p.engine) {
            self.psql(
                ctx,
                "postgres",
                &format!("DROP ROLE IF EXISTS {};", quote_pg(&p.username)),
            )
            .await?;
            return Ok(());
        }
        check_host_pattern(&p.host_pattern)?;
        self.mysql(
            ctx,
            "",
            &format!(
                "DROP USER IF EXISTS {}@{};",
                literal(&p.username),
                literal(&p.host_pattern)
            ),
        )
        .await?;
        Ok(())
    }

    async fn apply_grant(&self, ctx: &Ctx, p: DbGrantApplyParams) -> PResult<()> {
        let privileges = normalize_privileges(&p.privileges)?;

        if is_postgres(&p.engine) {
            let (database, user) = (quote_pg(&p.database), quote_pg(&p.username));
            // Revoking first is what makes this an "apply" rather than an
            // "add": the resulting grant set is exactly what was asked for.
            let statements = [
                format!("REVOKE ALL PRIVILEGES ON DATABASE {database} FROM {user};"),
                format!("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {user};"),
                format!("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {user};"),
            ];
            self.psql(ctx, &p.database, &statements.join("\n")).await?;
            if privileges.is_empty() {
                return Ok(());
            }

            let mut grants = vec![format!(
                "GRANT CONNECT, TEMPORARY ON DATABASE {database} TO {user};"
            )];
            if privileges.iter().any(|p| p == "ALL") {
                grants.extend([
                    format!("GRANT ALL PRIVILEGES ON DATABASE {database} TO {user};"),
                    format!("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO {user};"),
                    format!("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO {user};"),
                    format!("GRANT USAGE, CREATE ON SCHEMA public TO {user};"),
                ]);
            } else {
                let table = postgres_table_privileges(&privileges);
                if !table.is_empty() {
                    grants.extend([
                        format!("GRANT USAGE ON SCHEMA public TO {user};"),
                        format!("GRANT {table} ON ALL TABLES IN SCHEMA public TO {user};"),
                    ]);
                }
            }
            self.psql(ctx, &p.database, &grants.join("\n")).await?;
            return Ok(());
        }

        check_host_pattern(&p.host_pattern)?;
        let account = format!("{}@{}", literal(&p.username), literal(&p.host_pattern));
        let scope = format!("{}.*", quote_mysql(&p.database));

        // A user with no grants makes REVOKE an error, which is not a failure
        // of this call, so its result is deliberately not fatal.
        if self
            .mysql(
                ctx,
                "",
                &format!("REVOKE ALL PRIVILEGES ON {scope} FROM {account};"),
            )
            .await
            .is_err()
        {
            tracing::debug!(user = %p.username, database = %p.database, "nothing to revoke before applying grants");
        }
        if privileges.is_empty() {
            self.mysql(ctx, "", "FLUSH PRIVILEGES;").await?;
            return Ok(());
        }

        let statement = format!(
            "GRANT {} ON {scope} TO {account};\nFLUSH PRIVILEGES;",
            privileges.join(", ")
        );
        self.mysql(ctx, "", &statement).await?;
        Ok(())
    }

    /* -------------------------------- size ------------------------------- */

    async fn size(&self, ctx: &Ctx, p: DbSizeParams) -> PResult<DbSizeResult> {
        if is_postgres(&p.engine) {
            let rows = self
                .psql(
                    ctx,
                    "postgres",
                    &format!("SELECT pg_database_size({})::bigint;", literal(&p.name)),
                )
                .await?;
            let Some(row) = rows.first() else {
                return Err(not_found(format!("database {}", p.name)));
            };
            return Ok(DbSizeResult {
                size_bytes: first(row).parse().unwrap_or(0),
                table_count: self.postgres_table_count(ctx, &p.name).await,
            });
        }

        let rows = self
            .mysql(
                ctx,
                "",
                &format!(
                    "SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0), COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = {};",
                    literal(&p.name)
                ),
            )
            .await?;
        match rows.first() {
            Some(row) if row.len() >= 2 => Ok(DbSizeResult {
                size_bytes: row[0].parse().unwrap_or(0),
                table_count: row[1].parse().unwrap_or(0),
            }),
            _ => Err(not_found(format!("database {}", p.name))),
        }
    }

    /* --------------------------- dump and restore ------------------------ */

    async fn dump(&self, ctx: &Ctx, p: DbDumpParams, stream: StreamRef) -> PResult<DbDumpResult> {
        let options = dump_command(&p)?;

        let mut destination = p.destination.clone();
        if p.compress && !destination.ends_with(".gz") {
            destination.push_str(".gz");
        }

        let mut cmd = piped_command(&options)?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| spawn_error(&options.name, e))?;
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");

        // The bytes are written by a blocking task so a slow disk or the gzip
        // encoder never stalls the runtime; the async side counts them and
        // reports progress, which is how an operator watching a 40 GB dump
        // sees something move.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let (sink_path, compress) = (destination.clone(), p.compress);
        let writer = tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&sink_path)?;
            let mut sink = DumpSink::new(file, compress);
            while let Some(chunk) = rx.blocking_recv() {
                sink.write_all(&chunk)?;
            }
            let file = sink.finish()?;
            file.sync_all()?;
            Ok(file.metadata()?.len())
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let label = p.name.clone();
        let relay = async {
            let mut buffer = vec![0u8; 64 << 10];
            let mut written: u64 = 0;
            let mut reported: u64 = 0;
            loop {
                let n = stdout
                    .read(&mut buffer)
                    .await
                    .map_err(|e| ProviderError::internal(format!("read dump: {e}")))?;
                if n == 0 {
                    break;
                }
                written += n as u64;
                if tx.send(buffer[..n].to_vec()).await.is_err() {
                    break;
                }
                if written - reported >= DUMP_PROGRESS_STRIDE {
                    reported = written;
                    let line = format!("{label}: {written} bytes written\n");
                    stream.send(line.as_bytes(), Encoding::Utf8).await?;
                }
            }
            drop(tx);
            Ok::<(), ProviderError>(())
        };

        let outcome: PResult<()> = tokio::select! {
            r = relay => r,
            _ = ctx.done() => Err(ctx.error()),
        };
        if outcome.is_err() {
            let _ = child.start_kill();
        }
        let status = child
            .wait()
            .await
            .map_err(|e| ProviderError::internal(format!("waiting for {}: {e}", options.name)));
        let written = writer.await.unwrap_or_else(|e| Err(std::io::Error::other(e)));
        let stderr_text = stderr_task.await.unwrap_or_default();

        let failure = match (outcome, status) {
            (Err(e), _) => Some(e),
            (Ok(()), Err(e)) => Some(e),
            (Ok(()), Ok(status)) if !status.success() => Some(exec::exec_error(
                &options.name,
                exec::tail(&stderr_text, exec::EXEC_OUTPUT_LIMIT),
                status.code(),
            )),
            _ => None,
        };
        if let Some(err) = failure {
            let _ = std::fs::remove_file(&destination);
            return Err(err);
        }
        let size = written.map_err(|e| ProviderError::internal(format!("finish {destination}: {e}")))?;
        Ok(DbDumpResult {
            path: destination,
            size_bytes: size as i64,
        })
    }

    async fn restore(&self, ctx: &Ctx, p: DbRestoreParams, stream: StreamRef) -> PResult<()> {
        let source = std::fs::File::open(&p.source).map_err(|e| wrap_fs_error(&p.source, e))?;
        let gzipped = p.source.ends_with(".gz");

        if p.drop_existing {
            self.delete_database(
                ctx,
                DbDatabaseDeleteParams {
                    engine: p.engine.clone(),
                    name: p.name.clone(),
                },
            )
            .await?;
            self.create_database(
                ctx,
                DbDatabaseCreateParams {
                    engine: p.engine.clone(),
                    name: p.name.clone(),
                    ..Default::default()
                },
            )
            .await?;
        }

        let options = restore_command(&p)?;
        let mut cmd = piped_command(&options)?;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| spawn_error(&options.name, e))?;
        let mut stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");

        // The source is read, and inflated when gzipped, on a blocking task
        // and handed to the client's stdin in chunks.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let source_path = p.source.clone();
        let reader = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut input: Box<dyn Read> = if gzipped {
                Box::new(GzDecoder::new(source))
            } else {
                Box::new(source)
            };
            let mut buffer = vec![0u8; 64 << 10];
            loop {
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    return Ok(());
                }
                if tx.blocking_send(buffer[..n].to_vec()).is_err() {
                    return Ok(());
                }
            }
        });
        let feeder = tokio::spawn(async move {
            while let Some(chunk) = rx.recv().await {
                if stdin.write_all(&chunk).await.is_err() {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });

        // Both of the client's streams are relayed to the operator and kept
        // as a tail for the error report.
        let (lines_tx, mut lines_rx) = tokio::sync::mpsc::channel::<String>(256);
        let pump = |reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
                    tx: tokio::sync::mpsc::Sender<String>| async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        };
        let t1 = tokio::spawn(pump(Box::new(stdout), lines_tx.clone()));
        let t2 = tokio::spawn(pump(Box::new(stderr), lines_tx));

        let mut captured = String::new();
        let relay = async {
            while let Some(line) = lines_rx.recv().await {
                captured.push_str(&line);
                captured.push('\n');
                if captured.len() > 2 * exec::EXEC_OUTPUT_LIMIT {
                    captured = exec::tail(&captured, exec::EXEC_OUTPUT_LIMIT).to_string();
                }
                say(stream.as_ref(), &line).await;
            }
        };

        let status = tokio::select! {
            _ = relay => child.wait().await.map_err(|e| ProviderError::internal(format!("waiting for {}: {e}", options.name)))?,
            _ = ctx.done() => {
                let _ = child.start_kill();
                return Err(ctx.error());
            }
        };
        let _ = t1.await;
        let _ = t2.await;
        let _ = feeder.await;
        if let Ok(Err(e)) = reader.await {
            if gzipped {
                return Err(ProviderError::internal(format!(
                    "open {source_path} as gzip: {e}"
                )));
            }
            return Err(wrap_fs_error(&source_path, e));
        }

        if !status.success() {
            return Err(exec::exec_error(
                &options.name,
                exec::tail(&captured, exec::EXEC_OUTPUT_LIMIT),
                status.code(),
            ));
        }
        Ok(())
    }
}

/// Where a dump's bytes land: the file itself, or a gzip stream over it.
enum DumpSink {
    Plain(std::fs::File),
    Gzip(GzEncoder<std::fs::File>),
}

impl DumpSink {
    fn new(file: std::fs::File, compress: bool) -> Self {
        if compress {
            DumpSink::Gzip(GzEncoder::new(file, Compression::default()))
        } else {
            DumpSink::Plain(file)
        }
    }

    fn write_all(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        match self {
            DumpSink::Plain(f) => f.write_all(chunk),
            DumpSink::Gzip(g) => g.write_all(chunk),
        }
    }

    fn finish(self) -> std::io::Result<std::fs::File> {
        match self {
            DumpSink::Plain(f) => Ok(f),
            DumpSink::Gzip(g) => g.finish(),
        }
    }
}

impl DatabaseOps {
    async fn mysql_instance(&self, ctx: &Ctx, engine: &str) -> DbInstanceInfo {
        let mut instance = DbInstanceInfo {
            engine: engine.to_string(),
            host: "localhost".into(),
            port: 3306,
            ..Default::default()
        };

        let Ok(rows) = self
            .mysql(
                ctx,
                "",
                &[
                    "SELECT VERSION();",
                    "SHOW GLOBAL STATUS LIKE 'Uptime';",
                    "SHOW GLOBAL STATUS LIKE 'Threads_connected';",
                    "SHOW GLOBAL VARIABLES LIKE 'max_connections';",
                    "SHOW GLOBAL VARIABLES LIKE 'port';",
                    "SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) FROM information_schema.TABLES;",
                ]
                .join("\n"),
            )
            .await
        else {
            return instance;
        };

        instance.reachable = true;
        for (index, row) in rows.iter().enumerate() {
            if index == 0 && !row.is_empty() {
                instance.version = row[0].clone();
            } else if row.len() == 2 {
                let Ok(value) = row[1].parse::<i64>() else {
                    continue;
                };
                match row[0].as_str() {
                    "Uptime" => instance.uptime_seconds = Some(value),
                    "Threads_connected" => instance.connections = Some(value),
                    "max_connections" => instance.max_connections = Some(value),
                    "port" => instance.port = value,
                    _ => {}
                }
            } else if row.len() == 1 {
                if let Ok(value) = row[0].parse::<i64>() {
                    instance.data_size = Some(value);
                }
            }
        }
        instance
    }

    async fn postgres_instance(&self, ctx: &Ctx) -> DbInstanceInfo {
        let mut instance = DbInstanceInfo {
            engine: "postgres".into(),
            host: "localhost".into(),
            port: 5432,
            ..Default::default()
        };

        // One statement per line, so the answers come back in a known order.
        let rows = match self
            .psql(
                ctx,
                "postgres",
                &[
                    "SELECT current_setting('server_version');",
                    "SELECT current_setting('port');",
                    "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint;",
                    "SELECT count(*) FROM pg_stat_activity;",
                    "SELECT current_setting('max_connections');",
                    "SELECT COALESCE(sum(pg_database_size(datname)),0)::bigint FROM pg_database;",
                ]
                .join("\n"),
            )
            .await
        {
            Ok(rows) if rows.len() >= 6 => rows,
            _ => return instance,
        };

        instance.reachable = true;
        instance.version = first(&rows[0]).to_string();
        if let Ok(port) = first(&rows[1]).parse() {
            instance.port = port;
        }
        if let Ok(uptime) = first(&rows[2]).parse() {
            instance.uptime_seconds = Some(uptime);
        }
        if let Ok(connections) = first(&rows[3]).parse() {
            instance.connections = Some(connections);
        }
        if let Ok(maximum) = first(&rows[4]).parse() {
            instance.max_connections = Some(maximum);
        }
        if let Ok(size) = first(&rows[5]).parse() {
            instance.data_size = Some(size);
        }
        instance
    }

    async fn postgres_table_count(&self, ctx: &Ctx, database: &str) -> i64 {
        let Ok(rows) = self
            .psql(
                ctx,
                database,
                "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');",
            )
            .await
        else {
            return 0;
        };
        rows.first()
            .map(|row| first(row).parse().unwrap_or(0))
            .unwrap_or(0)
    }

    /* ------------------------------- clients ----------------------------- */

    /// Runs a batch of statements with the SQL on stdin and returns the
    /// tab-separated rows. `database` selects a default schema when set.
    async fn mysql(&self, ctx: &Ctx, database: &str, statements: &str) -> PResult<Rows> {
        let Some(binary) = mysql_binary("mysql") else {
            return Err(unsupported("no mysql client is installed"));
        };

        let mut args = vec![
            "--batch".to_string(),
            "--raw".into(),
            "--skip-column-names".into(),
            "--connect-timeout=10".into(),
        ];
        if !database.is_empty() {
            args.push(format!("--database={database}"));
        }
        let out = exec::run_with(
            ctx,
            ExecOptions::new(binary, args)
                .stdin(format!("{statements}\n"))
                .c_locale(),
        )
        .await?;

        Ok(split_lines(&out)
            .into_iter()
            .map(|line| line.split('\t').map(str::to_string).collect())
            .collect())
    }

    /// Runs a batch as the cluster's own system account, which is how a
    /// peer-authenticated PostgreSQL is reached without a password and
    /// without a shell in between.
    async fn psql(&self, ctx: &Ctx, database: &str, statements: &str) -> PResult<Rows> {
        let mut args = vec![
            "-X".to_string(),
            "-q".into(),
            "-A".into(),
            "-t".into(),
            "-F".into(),
            PSQL_SEPARATOR.into(),
            "-v".into(),
            "ON_ERROR_STOP=1".into(),
        ];
        if !database.is_empty() {
            args.push(format!("--dbname={database}"));
        }
        let mut options = ExecOptions::new("psql", args)
            .stdin(format!("{statements}\n"))
            .c_locale();
        if let Some(account) = postgres_account() {
            options = options.user(account);
        }
        let out = exec::run_with(ctx, options).await?;

        Ok(split_lines(&out)
            .into_iter()
            .filter(|line| !line.is_empty())
            .map(|line| line.split(PSQL_SEPARATOR).map(str::to_string).collect())
            .collect())
    }
}

fn dump_command(p: &DbDumpParams) -> PResult<ExecOptions> {
    if is_postgres(&p.engine) {
        let dbname = format!("--dbname={}", p.name);
        let mut options = ExecOptions::new(
            "pg_dump",
            ["--no-owner", "--no-privileges", "--format=plain", dbname.as_str()],
        )
        .c_locale();
        if let Some(account) = postgres_account() {
            options = options.user(account);
        }
        return Ok(options);
    }
    let Some(binary) = mysql_binary("mysqldump") else {
        return Err(unsupported("mysqldump is not installed"));
    };
    Ok(ExecOptions::new(
        binary,
        [
            "--single-transaction",
            "--quick",
            "--routines",
            "--triggers",
            "--databases",
            &p.name,
        ],
    )
    .c_locale())
}

fn restore_command(p: &DbRestoreParams) -> PResult<ExecOptions> {
    if is_postgres(&p.engine) {
        let dbname = format!("--dbname={}", p.name);
        let mut options =
            ExecOptions::new("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", dbname.as_str()]).c_locale();
        if let Some(account) = postgres_account() {
            options = options.user(account);
        }
        return Ok(options);
    }
    let Some(binary) = mysql_binary("mysql") else {
        return Err(unsupported("no mysql client is installed"));
    };
    Ok(ExecOptions::new(binary, [format!("--database={}", p.name)]).c_locale())
}

/// The system user the cluster trusts. If it is absent the agent stays root
/// and lets the engine decide.
fn postgres_account() -> Option<&'static str> {
    nix::unistd::User::from_name("postgres")
        .ok()
        .flatten()
        .map(|_| "postgres")
}

/// Prefers the MariaDB-named tools when the MySQL-named ones are gone,
/// which is the case on recent MariaDB packages.
fn mysql_binary(name: &str) -> Option<&'static str> {
    let (primary, alternative): (&'static str, &'static str) = match name {
        "mysql" => ("mysql", "mariadb"),
        "mysqldump" => ("mysqldump", "mariadb-dump"),
        _ => return None,
    };
    if exec::has_binary(primary) {
        return Some(primary);
    }
    if exec::has_binary(alternative) {
        return Some(alternative);
    }
    None
}

/* ------------------------------ piped exec ---------------------------- */

/// A child whose stdin or stdout the caller drives itself: a dump that is
/// gzipped into a file as it streams, a restore fed from one, or restic's
/// JSON protocol read line by line. It is `exec`'s argv-only command
/// builder, minus the capture: a program name, an argv slice, an
/// environment and optionally a POSIX account. No shell ever sees it.
pub(crate) fn piped_command(o: &ExecOptions) -> PResult<Command> {
    let path = exec::which(&o.name).ok_or_else(|| unsupported(format!("{} is not installed", o.name)))?;
    let mut cmd = Command::new(path);
    cmd.args(&o.args);
    if let Some(dir) = &o.dir {
        cmd.current_dir(dir);
    }
    if o.clear_env {
        cmd.env_clear();
        cmd.env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/sbin:/usr/bin:/sbin:/bin".into()),
        );
    }
    if o.c_locale {
        cmd.env("LC_ALL", "C").env("LANG", "C");
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    if let Some(user) = &o.user {
        let (uid, gid, groups) = exec::credential(user)?;
        cmd.uid(uid).gid(gid);
        // Supplementary groups are set in the child before exec, which is the
        // moment `su -c "..."` — and its shell string — would otherwise be
        // needed for.
        unsafe {
            cmd.pre_exec(move || {
                let gids: Vec<libc::gid_t> = groups.iter().map(|g| *g as libc::gid_t).collect();
                if libc::setgroups(gids.len(), gids.as_ptr()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.kill_on_drop(true);
    Ok(cmd)
}

pub(crate) fn spawn_error(name: &str, e: std::io::Error) -> ProviderError {
    match e.kind() {
        std::io::ErrorKind::NotFound => unsupported(format!("{name} is not installed")),
        std::io::ErrorKind::PermissionDenied => {
            ProviderError::PermissionDenied(format!("cannot run {name}: {e}"))
        }
        _ => ProviderError::internal(format!("starting {name}: {e}")),
    }
}

/* ------------------------------ validation --------------------------- */

fn is_postgres(engine: &str) -> bool {
    engine == "postgres"
}

/// `quote_mysql` and `quote_pg` double the engine's own quote character,
/// which is the only escape either dialect defines for an identifier.
pub fn quote_mysql(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

pub fn quote_pg(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Quotes a value. Backslashes are escaped as well as quotes, because MySQL
/// treats a backslash as an escape character by default while PostgreSQL,
/// under standard_conforming_strings, does not — and doubling a backslash
/// is safe in both.
pub fn literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "''");
    format!("'{escaped}'")
}

fn check_host_pattern(pattern: &str) -> PResult<()> {
    if pattern.is_empty() || pattern.len() > 64 {
        return Err(invalid("host_pattern must be between 1 and 64 characters"));
    }
    if !pattern
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_' | b'%' | b':'))
    {
        return Err(invalid("host_pattern contains an illegal character"));
    }
    Ok(())
}

fn check_charset(value: &str) -> PResult<()> {
    if value.is_empty() || value.len() > 64 {
        return Err(invalid("character set must be between 1 and 64 characters"));
    }
    if !value
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
    {
        return Err(invalid("character set contains an illegal character"));
    }
    Ok(())
}

/// Upper-cases and re-checks the privilege list. The values are
/// concatenated into a GRANT, so an unrecognised one is rejected rather
/// than passed through.
fn normalize_privileges(privileges: &[String]) -> PResult<Vec<String>> {
    const ALLOWED: &[&str] = &[
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
    let mut out = Vec::with_capacity(privileges.len());
    for privilege in privileges {
        let upper = privilege.trim().to_uppercase();
        if !ALLOWED.contains(&upper.as_str()) {
            return Err(invalid(format!("{privilege:?} is not a grantable privilege")));
        }
        out.push(upper);
    }
    Ok(out)
}

/// Keeps only the verbs PostgreSQL accepts on a table; MySQL's schema-level
/// extras have no equivalent there.
fn postgres_table_privileges(privileges: &[String]) -> String {
    const ALLOWED: &[&str] = &["SELECT", "INSERT", "UPDATE", "DELETE", "TRIGGER", "REFERENCES"];
    privileges
        .iter()
        .filter(|p| ALLOWED.contains(&p.as_str()))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_quoted_by_doubling_the_quote_character() {
        assert_eq!(
            quote_mysql("app`; DROP DATABASE x; --"),
            "`app``; DROP DATABASE x; --`"
        );
        assert_eq!(
            quote_pg("app\"; DROP DATABASE x; --"),
            "\"app\"\"; DROP DATABASE x; --\""
        );
    }

    #[test]
    fn literals_escape_quotes_and_backslashes() {
        assert_eq!(literal("it's"), "'it''s'");
        assert_eq!(literal("a\\b"), "'a\\\\b'");
        assert_eq!(literal("'; DROP TABLE t; --"), "'''; DROP TABLE t; --'");
    }

    #[test]
    fn privileges_are_normalised_and_unknown_ones_refused() {
        let ok = normalize_privileges(&["select".into(), " Insert ".into(), "ALL".into()]).unwrap();
        assert_eq!(ok, vec!["SELECT", "INSERT", "ALL"]);
        assert!(matches!(
            normalize_privileges(&["FILE".into()]),
            Err(ProviderError::InvalidParams(_))
        ));
        assert!(matches!(
            normalize_privileges(&["SELECT; DROP".into()]),
            Err(ProviderError::InvalidParams(_))
        ));
    }

    #[test]
    fn postgres_table_privileges_keep_only_table_verbs() {
        let privileges: Vec<String> = ["SELECT", "INDEX", "TRIGGER", "EXECUTE"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(postgres_table_privileges(&privileges), "SELECT, TRIGGER");
    }

    #[test]
    fn host_patterns_and_charsets_are_checked() {
        assert!(check_host_pattern("localhost").is_ok());
        assert!(check_host_pattern("10.0.%").is_ok());
        assert!(check_host_pattern("").is_err());
        assert!(check_host_pattern("a b").is_err());
        assert!(check_host_pattern("x'; --").is_err());
        assert!(check_charset("utf8mb4").is_ok());
        assert!(check_charset("en_US.UTF-8").is_ok());
        assert!(check_charset("utf8 COLLATE x").is_err());
    }

    #[test]
    fn system_schemas_are_recognised() {
        assert!(is_system_schema("mysql"));
        assert!(is_system_schema("template0"));
        assert!(!is_system_schema("app"));
    }

    #[tokio::test]
    async fn piped_command_runs_an_argv_without_a_shell() {
        let mut cmd = piped_command(&ExecOptions::new("sh", ["-c", "echo $0; cat"]).stdin("")).unwrap();
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"from stdin").await.unwrap();
        drop(stdin);
        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).ends_with("from stdin"));
    }
}
