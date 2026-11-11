//! App backups (`app.db_dump`, `app.db_restore`).
//!
//! The one thing an app backup needs from the host that no other verb
//! gives it: a consistent dump of an install's companion database. These
//! two verbs are deliberately narrow. The caller names an install, a
//! companion role, an engine from a closed enum and one of two fixed dump
//! slots — nothing else. Everything that could be dangerous is decided
//! here, in the agent:
//!
//!  * the container is `kaname-<install>-<role>` and must carry Kaname's
//!    labels for exactly that install and role, so a dump can never be
//!    pointed at someone else's database container;
//!  * the argv is fixed per engine (pg_dump / pg_restore, mysqldump /
//!    mysql, mariadb-dump / mariadb) and runs inside that container through
//!    the runtime's exec API — no shell, no caller-supplied argument;
//!  * the database name, user and root password come from the container's
//!    own environment (which Kaname set when it created it), so no
//!    credential crosses the socket;
//!  * the dump file lives at a path derived from the install id under the
//!    managed apps root, and is moved there through the companion's own
//!    data mount, which must itself lie under that root.
//!
//! Platform independent: the trait, payloads and the pure guards and argv
//! builders shared by the Linux provider and the simulator.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::managed::{self, LABEL_ROLE};
use super::{Ctx, PResult, ProviderError};
use std::collections::BTreeMap;

/* ------------------------------- payloads ---------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct AppDbParams {
    pub install_id: String,
    pub role: String,
    pub engine: String,
    /// "backup" (default) or "pre_restore".
    pub slot: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppDbDumpResult {
    pub path: String,
    pub size_bytes: i64,
    pub engine: String,
    pub database: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppDbRestoreResult {
    pub ok: bool,
    pub database: String,
}

#[async_trait]
pub trait AppBackup: Send + Sync {
    async fn db_dump(&self, ctx: &Ctx, p: AppDbParams) -> PResult<AppDbDumpResult>;
    async fn db_restore(&self, ctx: &Ctx, p: AppDbParams) -> PResult<AppDbRestoreResult>;
}

/// A provider that has not wired app backups refuses every verb.
pub struct NoAppBackup;

#[async_trait]
impl AppBackup for NoAppBackup {
    async fn db_dump(&self, _ctx: &Ctx, _p: AppDbParams) -> PResult<AppDbDumpResult> {
        Err(ProviderError::unsupported_because("app backups are not available on this host"))
    }
    async fn db_restore(&self, _ctx: &Ctx, _p: AppDbParams) -> PResult<AppDbRestoreResult> {
        Err(ProviderError::unsupported_because("app backups are not available on this host"))
    }
}

pub static NO_APP_BACKUP: NoAppBackup = NoAppBackup;

/* ------------------------------- guards ------------------------------ */

pub const ENGINES: &[&str] = &["postgres", "mysql", "mariadb"];
pub const SLOTS: &[&str] = &["backup", "pre_restore"];
/// The install's backup directory, under its managed directory.
pub const BACKUP_DIR: &str = "kaname-backup";
/// The transfer file inside the companion's data mount while a dump or
/// restore runs; removed afterwards.
pub const TRANSFER_FILE: &str = ".kaname-transfer.dump";

fn invalid(message: impl Into<String>) -> ProviderError {
    ProviderError::invalid(message)
}

/// Checks the params and normalises the slot. Everything that is not one
/// of the closed values is refused, not coerced.
pub fn validate(p: &mut AppDbParams) -> PResult<()> {
    managed::validate_install_id(&p.install_id)?;
    let role_ok = !p.role.is_empty()
        && p.role.len() <= 16
        && p.role.as_bytes()[0].is_ascii_lowercase()
        && p.role.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !role_ok {
        return Err(invalid("role must be 1-16 lowercase letters or digits, starting with a letter"));
    }
    if p.role == "app" || p.role.starts_with("init") {
        return Err(invalid("role must name a companion database container, not the app"));
    }
    if !ENGINES.contains(&p.engine.as_str()) {
        return Err(invalid(format!("engine must be one of {}", ENGINES.join(", "))));
    }
    if p.slot.is_empty() {
        p.slot = "backup".into();
    }
    if !SLOTS.contains(&p.slot.as_str()) {
        return Err(invalid(format!("slot must be one of {}", SLOTS.join(", "))));
    }
    Ok(())
}

/// Where a slot's dump lives on the host. Derived, never supplied.
pub fn dump_path(root: &str, install_id: &str, role: &str, slot: &str) -> String {
    let name = if slot == "pre_restore" {
        format!("{role}.pre-restore.dump")
    } else {
        format!("{role}.dump")
    };
    format!("{}/{BACKUP_DIR}/{name}", managed::install_dir(root, install_id))
}

/// The host directory a companion keeps its data in, as the installer
/// mounts it: `<root>/<install>/<role>/data`.
pub fn data_source(root: &str, install_id: &str, role: &str) -> String {
    format!("{}/{role}/data", managed::install_dir(root, install_id))
}

/// The container must be Kaname's, for this install, in this role.
pub fn check_labels(labels: &BTreeMap<String, String>, install_id: &str, role: &str) -> PResult<()> {
    if !managed::is_managed_by(labels, install_id) {
        return Err(ProviderError::PermissionDenied(format!(
            "{} is not a Kaname-managed container of install {install_id}",
            managed::container_name(install_id, role)
        )));
    }
    if labels.get(LABEL_ROLE).map(String::as_str) != Some(role) {
        return Err(ProviderError::PermissionDenied(format!(
            "{} does not carry the role label {role}",
            managed::container_name(install_id, role)
        )));
    }
    Ok(())
}

/// Finds where the companion's data directory is mounted inside the
/// container. The mount source must be the install's own data directory,
/// which also proves the file the agent moves afterwards stays under the
/// managed root.
pub fn data_mount_target(
    mounts: &[(String, String)],
    root: &str,
    install_id: &str,
    role: &str,
) -> PResult<String> {
    let want = data_source(root, install_id, role);
    mounts
        .iter()
        .find(|(source, _)| source.trim_end_matches('/') == want)
        .map(|(_, target)| target.trim_end_matches('/').to_string())
        .filter(|target| target.starts_with('/') && !target.split('/').any(|s| s == ".."))
        .ok_or_else(|| {
            ProviderError::PreconditionFailed(format!(
                "{} does not mount {want}; it was not created by the installer",
                managed::container_name(install_id, role)
            ))
        })
}

/// What the agent needs to know about the database inside the container,
/// read from the environment the installer gave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbIdentity {
    pub database: String,
    pub user: String,
    /// `MYSQL_PWD` for the exec, for the MySQL family. Never logged.
    pub password: Option<String>,
}

fn identifier_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && (value.as_bytes()[0].is_ascii_alphabetic() || value.as_bytes()[0] == b'_')
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn identity_from_env(engine: &str, env: &[String]) -> PResult<DbIdentity> {
    let get = |name: &str| -> Option<String> {
        env.iter()
            .find_map(|entry| entry.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')))
            .map(str::to_string)
            .filter(|v| !v.is_empty())
    };
    let identity = match engine {
        "postgres" => {
            if get("POSTGRES_PASSWORD").is_none() && get("POSTGRES_USER").is_none() {
                return Err(ProviderError::PreconditionFailed(
                    "the container's environment is not a PostgreSQL companion's".into(),
                ));
            }
            let user = get("POSTGRES_USER").unwrap_or_else(|| "postgres".into());
            DbIdentity {
                database: get("POSTGRES_DB").unwrap_or_else(|| user.clone()),
                user,
                password: None,
            }
        }
        "mysql" | "mariadb" => {
            let database = get("MARIADB_DATABASE").or_else(|| get("MYSQL_DATABASE"));
            let password = get("MARIADB_ROOT_PASSWORD").or_else(|| get("MYSQL_ROOT_PASSWORD"));
            match (database, password) {
                (Some(database), Some(password)) => DbIdentity {
                    database,
                    user: "root".into(),
                    password: Some(password),
                },
                _ => {
                    return Err(ProviderError::PreconditionFailed(
                        "the container's environment names no database or root password".into(),
                    ));
                }
            }
        }
        other => return Err(invalid(format!("engine {other:?} is not supported"))),
    };
    if !identifier_ok(&identity.database) || !identifier_ok(&identity.user) {
        return Err(ProviderError::PreconditionFailed(
            "the container's database or user name is not a plain identifier".into(),
        ));
    }
    Ok(identity)
}

/// The dump command, fixed per engine. `file` is the transfer file inside
/// the container's data mount.
pub fn dump_argv(engine: &str, id: &DbIdentity, file: &str) -> Vec<String> {
    let v = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match engine {
        "postgres" => v(&[
            "pg_dump",
            "--no-password",
            "--format=custom",
            &format!("--username={}", id.user),
            &format!("--dbname={}", id.database),
            &format!("--file={file}"),
        ]),
        "mariadb" => v(&[
            "mariadb-dump",
            "--user=root",
            "--single-transaction",
            "--routines",
            "--triggers",
            &format!("--result-file={file}"),
            &id.database,
        ]),
        _ => v(&[
            "mysqldump",
            "--user=root",
            "--single-transaction",
            "--routines",
            "--triggers",
            &format!("--result-file={file}"),
            &id.database,
        ]),
    }
}

/// The restore command, fixed per engine. PostgreSQL restores in one
/// transaction, so a failure leaves the database as it was.
pub fn restore_argv(engine: &str, id: &DbIdentity, file: &str) -> Vec<String> {
    let v = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match engine {
        "postgres" => v(&[
            "pg_restore",
            "--no-password",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--single-transaction",
            &format!("--username={}", id.user),
            &format!("--dbname={}", id.database),
            file,
        ]),
        "mariadb" => v(&["mariadb", "--user=root", &id.database, &format!("--execute=source {file}")]),
        _ => v(&["mysql", "--user=root", &id.database, &format!("--execute=source {file}")]),
    }
}

/// The exec's environment: only the password the MySQL tools read.
pub fn exec_env(id: &DbIdentity) -> Vec<String> {
    id.password
        .as_ref()
        .map(|p| vec![format!("MYSQL_PWD={p}")])
        .unwrap_or_default()
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/var/lib/kaname-apps";
    const ID: &str = "abcdef12-3456-4789-8abc-def012345678";

    fn params() -> AppDbParams {
        AppDbParams {
            install_id: ID.into(),
            role: "db".into(),
            engine: "postgres".into(),
            slot: String::new(),
        }
    }

    #[test]
    fn well_formed_params_pass_and_default_the_slot() {
        let mut p = params();
        validate(&mut p).expect("valid");
        assert_eq!(p.slot, "backup");
    }

    #[test]
    fn anything_outside_the_closed_values_is_refused() {
        let cases: Vec<Box<dyn Fn(&mut AppDbParams)>> = vec![
            Box::new(|p| p.install_id = "../etc".into()),
            Box::new(|p| p.install_id = String::new()),
            Box::new(|p| p.install_id = "ABC".into()),
            Box::new(|p| p.role = "app".into()),
            Box::new(|p| p.role = "init1".into()),
            Box::new(|p| p.role = "db;rm".into()),
            Box::new(|p| p.role = "../db".into()),
            Box::new(|p| p.role = "Db".into()),
            Box::new(|p| p.role = String::new()),
            Box::new(|p| p.engine = "sqlite".into()),
            Box::new(|p| p.engine = "postgres --file=/etc/passwd".into()),
            Box::new(|p| p.engine = "clickhouse".into()),
            Box::new(|p| p.slot = "/etc/shadow".into()),
            Box::new(|p| p.slot = "latest".into()),
        ];
        for patch in cases {
            let mut p = params();
            patch(&mut p);
            assert!(validate(&mut p).is_err(), "{p:?} should be refused");
        }
    }

    #[test]
    fn unknown_fields_such_as_a_path_or_a_command_are_a_decode_error() {
        for extra in [
            serde_json::json!({"path": "/etc/passwd"}),
            serde_json::json!({"destination": "/root"}),
            serde_json::json!({"command": ["sh", "-c", "id"]}),
            serde_json::json!({"database": "postgres"}),
        ] {
            let mut doc = serde_json::to_value(params()).unwrap();
            for (k, v) in extra.as_object().unwrap() {
                doc[k] = v.clone();
            }
            assert!(serde_json::from_value::<AppDbParams>(doc).is_err(), "{extra}");
        }
    }

    #[test]
    fn dump_paths_are_derived_under_the_install_directory() {
        assert_eq!(
            dump_path(ROOT, ID, "db", "backup"),
            format!("{ROOT}/{ID}/kaname-backup/db.dump")
        );
        assert_eq!(
            dump_path(ROOT, ID, "db", "pre_restore"),
            format!("{ROOT}/{ID}/kaname-backup/db.pre-restore.dump")
        );
    }

    #[test]
    fn only_this_installs_labelled_companion_is_accepted() {
        let good = managed::container_labels(ID, "db");
        check_labels(&good, ID, "db").expect("ours");
        assert!(matches!(
            check_labels(&good, "other-install", "db"),
            Err(ProviderError::PermissionDenied(_))
        ));
        assert!(matches!(
            check_labels(&managed::container_labels(ID, "app"), ID, "db"),
            Err(ProviderError::PermissionDenied(_))
        ));
        let mut forged = BTreeMap::new();
        forged.insert(managed::LABEL_INSTALL.to_string(), ID.to_string());
        forged.insert(LABEL_ROLE.to_string(), "db".to_string());
        assert!(check_labels(&forged, ID, "db").is_err(), "no managed=true label");
        assert!(check_labels(&BTreeMap::new(), ID, "db").is_err());
    }

    #[test]
    fn the_data_mount_must_be_the_installs_own() {
        let own = (data_source(ROOT, ID, "db"), "/var/lib/postgresql/data".to_string());
        assert_eq!(
            data_mount_target(&[own.clone()], ROOT, ID, "db").unwrap(),
            "/var/lib/postgresql/data"
        );
        for mounts in [
            vec![("/etc".to_string(), "/var/lib/postgresql/data".to_string())],
            vec![(format!("{ROOT}/other/db/data"), "/data".to_string())],
            vec![(data_source(ROOT, ID, "events"), "/data".to_string())],
            vec![(own.0.clone(), "relative".to_string())],
            vec![(own.0.clone(), "/x/../y".to_string())],
            vec![],
        ] {
            assert!(data_mount_target(&mounts, ROOT, ID, "db").is_err(), "{mounts:?}");
        }
    }

    #[test]
    fn identity_comes_from_the_containers_environment() {
        let pg = identity_from_env(
            "postgres",
            &["POSTGRES_DB=n8n".into(), "POSTGRES_USER=n8n".into(), "POSTGRES_PASSWORD=x".into()],
        )
        .unwrap();
        assert_eq!((pg.database.as_str(), pg.user.as_str(), pg.password), ("n8n", "n8n", None));

        let my = identity_from_env(
            "mysql",
            &["MYSQL_DATABASE=ghost".into(), "MYSQL_ROOT_PASSWORD=s3cret".into()],
        )
        .unwrap();
        assert_eq!(my.user, "root");
        assert_eq!(exec_env(&my), vec!["MYSQL_PWD=s3cret".to_string()]);

        assert!(identity_from_env("mysql", &["MYSQL_DATABASE=ghost".into()]).is_err());
        assert!(identity_from_env("postgres", &["MYSQL_DATABASE=ghost".into()]).is_err());
        assert!(
            identity_from_env("postgres", &["POSTGRES_USER=a b".into(), "POSTGRES_PASSWORD=x".into()]).is_err(),
            "a name with a space is refused"
        );
        assert!(
            identity_from_env("postgres", &["POSTGRES_USER=--help".into(), "POSTGRES_PASSWORD=x".into()]).is_err(),
            "a name that would read as a flag is refused"
        );
    }

    #[test]
    fn the_argv_is_fixed_and_carries_no_password() {
        let id = DbIdentity {
            database: "ghost".into(),
            user: "root".into(),
            password: Some("s3cret".into()),
        };
        for engine in ENGINES {
            let dump = dump_argv(engine, &id, "/var/lib/mysql/.kaname-transfer.dump");
            let restore = restore_argv(engine, &id, "/var/lib/mysql/.kaname-transfer.dump");
            for argv in [&dump, &restore] {
                assert!(!argv.iter().any(|a| a.contains("s3cret")), "{engine}: {argv:?}");
                assert!(!argv.iter().any(|a| a == "sh" || a == "-c" || a == "bash"));
            }
        }
        assert_eq!(dump_argv("postgres", &id, "/f")[0], "pg_dump");
        assert_eq!(restore_argv("postgres", &id, "/f")[0], "pg_restore");
        assert!(restore_argv("postgres", &id, "/f").contains(&"--single-transaction".to_string()));
        assert_eq!(dump_argv("mysql", &id, "/f")[0], "mysqldump");
        assert_eq!(dump_argv("mariadb", &id, "/f")[0], "mariadb-dump");
        assert_eq!(restore_argv("mysql", &id, "/f").last().unwrap(), "--execute=source /f");
    }
}
