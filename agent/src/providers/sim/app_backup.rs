//! App backups on the simulated host.
//!
//! The same guards as the Linux provider — the install's labelled
//! companion, running, a closed engine and slot — and a dump that is a
//! small file in the simulated filesystem at the derived path, so a
//! snapshot of the install directory has something real to carry and a
//! restore has something to read back.

use std::sync::Arc;

use async_trait::async_trait;

use super::containers::find_container;
use super::state::Sim;
use crate::providers::app_backup::{self as ab, AppBackup, AppDbDumpResult, AppDbParams, AppDbRestoreResult};
use crate::providers::managed::{self, MANAGED_APPS_ROOT};
use crate::providers::{Ctx, PResult, ProviderError};

pub struct SimAppBackup(pub Arc<Sim>);

impl SimAppBackup {
    /// The companion's existence, labels and state, as the agent would check them.
    fn companion(&self, p: &AppDbParams) -> PResult<String> {
        let name = managed::container_name(&p.install_id, &p.role);
        let w = self.0.world.lock();
        let idx =
            find_container(&w, &name).ok_or_else(|| ProviderError::not_found(format!("container {name}")))?;
        let c = &w.containers[idx];
        ab::check_labels(&c.info.labels, &p.install_id, &p.role)?;
        if c.info.state != "running" {
            return Err(ProviderError::PreconditionFailed(format!(
                "{name} is not running; start it before dumping or restoring its database"
            )));
        }
        Ok(name)
    }
}

/// What the simulated companion's database is called: the installer names
/// it after the app, which the simulator does not know, so it uses the role.
fn database_name(p: &AppDbParams) -> String {
    format!(
        "{}_{}",
        p.role,
        p.install_id[..p.install_id.len().min(8)].replace('-', "")
    )
}

#[async_trait]
impl AppBackup for SimAppBackup {
    async fn db_dump(&self, _ctx: &Ctx, mut p: AppDbParams) -> PResult<AppDbDumpResult> {
        ab::validate(&mut p)?;
        let name = self.companion(&p)?;
        let path = ab::dump_path(MANAGED_APPS_ROOT, &p.install_id, &p.role, &p.slot);
        let database = database_name(&p);
        let content = format!(
            "-- simulated {} dump of {database} from {name}\n-- taken {}\n",
            p.engine,
            chrono::Utc::now().to_rfc3339()
        );
        {
            let mut fs = self.0.fs.write();
            // The app's own data directory, as the installer's bind mount
            // would have left it, so the install directory is a real tree.
            let install = managed::install_dir(MANAGED_APPS_ROOT, &p.install_id);
            if fs.lookup(&format!("{install}/data"), false).is_err() {
                fs.mkdir_all(&format!("{install}/data"));
                fs.file(&format!("{install}/data/README"), "simulated app data\n");
            }
            fs.file_as(&path, &content, "0600", "root", 0);
        }
        Ok(AppDbDumpResult {
            size_bytes: content.len() as i64,
            path,
            engine: p.engine,
            database,
        })
    }

    async fn db_restore(&self, _ctx: &Ctx, mut p: AppDbParams) -> PResult<AppDbRestoreResult> {
        ab::validate(&mut p)?;
        let path = ab::dump_path(MANAGED_APPS_ROOT, &p.install_id, &p.role, &p.slot);
        if self.0.fs.read().lookup(&path, false).is_err() {
            return Err(ProviderError::not_found(path));
        }
        self.companion(&p)?;
        Ok(AppDbRestoreResult {
            ok: true,
            database: database_name(&p),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::Containers as _;
    use crate::providers::{ManagedContainerSpec, ManagedMount, Options};

    const ID: &str = "abcdef12-3456-4789-8abc-def012345678";

    fn sim(name: &str) -> Arc<Sim> {
        Sim::new(Options {
            agent_version: "0.1.0".into(),
            state_dir: std::env::temp_dir().join(format!("kaname-sim-appbackup-{name}")),
        })
    }

    fn params(slot: &str) -> AppDbParams {
        AppDbParams {
            install_id: ID.into(),
            role: "db".into(),
            engine: "postgres".into(),
            slot: slot.into(),
        }
    }

    async fn install_companion(sim: &Arc<Sim>) {
        let containers = super::super::containers::SimContainers(sim.clone());
        let ctx = Ctx::background();
        containers.create_network(&ctx, ID).await.expect("network");
        let image = sim
            .world
            .lock()
            .images
            .first()
            .and_then(|i| i.tags.first().cloned())
            .expect("a seeded image");
        containers
            .create_managed(
                &ctx,
                ManagedContainerSpec {
                    install_id: ID.into(),
                    role: "db".into(),
                    image,
                    mounts: vec![ManagedMount {
                        source: format!("{MANAGED_APPS_ROOT}/{ID}/db/data"),
                        target: "/var/lib/postgresql/data".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            )
            .await
            .expect("companion");
    }

    #[tokio::test]
    async fn a_dump_lands_at_the_derived_path_and_restores_from_it() {
        let sim = sim("roundtrip");
        install_companion(&sim).await;
        let ops = SimAppBackup(sim.clone());
        let ctx = Ctx::background();

        let dumped = ops.db_dump(&ctx, params("")).await.expect("dump");
        assert_eq!(
            dumped.path,
            format!("{MANAGED_APPS_ROOT}/{ID}/kaname-backup/db.dump")
        );
        assert!(
            sim.fs
                .read()
                .lookup(&format!("{MANAGED_APPS_ROOT}/{ID}/data"), false)
                .is_ok()
        );
        ops.db_restore(&ctx, params("backup")).await.expect("restore");

        let missing = ops
            .db_restore(&ctx, params("pre_restore"))
            .await
            .expect_err("no safety dump yet");
        assert!(matches!(missing, ProviderError::NotFound(_)));
    }

    #[tokio::test]
    async fn an_unlabelled_or_absent_container_is_refused() {
        let sim = sim("refuse");
        let ops = SimAppBackup(sim.clone());
        let ctx = Ctx::background();
        let err = ops.db_dump(&ctx, params("")).await.expect_err("no container");
        assert!(matches!(err, ProviderError::NotFound(_)), "{err:?}");

        let mut bad = params("");
        bad.engine = "sqlite".into();
        assert!(ops.db_dump(&ctx, bad).await.is_err());
    }
}
