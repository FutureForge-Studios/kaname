//! The simulation provider (KD-010).
//!
//! A deterministic, stateful fake Debian host. The same state directory
//! always produces the same fleet, so tests are reproducible; starting a
//! unit really changes its state, writing a file really persists, stopping
//! a container really updates its status. This is not a toy — it is how
//! the whole product is developed, demoed and e2e-tested on a machine with
//! no Linux host, so it exercises the real protocol, the real hub and the
//! real job worker with only the syscalls faked.
//!
//! `simulated` is always in the capability list: a fake fleet that can be
//! mistaken for a real one is worse than no fake fleet.

pub mod backups;
pub mod certs;
pub mod containers;
pub mod databases;
pub mod dns;
pub mod files;
pub mod firewall;
pub mod logs;
pub mod mail;
pub mod processes;
pub mod pty;
pub mod services;
pub mod sites;
pub mod ssh;
pub mod state;
pub mod system;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use self::state::{Sim, stamp};
use super::{
    Backups, Certs, Containers, Ctx, Databases, Dns, Event, Files, Firewall, HostInfo, Logs, Mail, Options,
    PResult, Processes, Provider, ProviderRef, Pty, Services, Sites, Ssh, System, cap,
};

/// One fake host, served through every sub-trait at once.
pub struct SimProvider {
    sim: Arc<Sim>,
    system: system::SimSystem,
    services: services::SimServices,
    processes: processes::SimProcesses,
    containers: containers::SimContainers,
    files: files::SimFiles,
    logs: logs::SimLogs,
    certs: certs::SimCerts,
    sites: sites::SimSites,
    dns: dns::SimDns,
    mail: mail::SimMail,
    databases: databases::SimDatabases,
    firewall: firewall::SimFirewall,
    ssh: ssh::SimSsh,
    backups: backups::SimBackups,
    pty: pty::SimPty,
}

impl SimProvider {
    pub fn new(opts: Options) -> SimProvider {
        let sim = Sim::new(opts);
        SimProvider {
            system: system::SimSystem(sim.clone()),
            services: services::SimServices(sim.clone()),
            processes: processes::SimProcesses(sim.clone()),
            containers: containers::SimContainers(sim.clone()),
            files: files::SimFiles(sim.clone()),
            logs: logs::SimLogs(sim.clone()),
            certs: certs::SimCerts(sim.clone()),
            sites: sites::SimSites(sim.clone()),
            dns: dns::SimDns(sim.clone()),
            mail: mail::SimMail(sim.clone()),
            databases: databases::SimDatabases(sim.clone()),
            firewall: firewall::SimFirewall(sim.clone()),
            ssh: ssh::SimSsh(sim.clone()),
            backups: backups::SimBackups(sim.clone()),
            pty: pty::SimPty(sim.clone()),
            sim,
        }
    }

    /// The world behind the provider, for tests that want to look inside.
    #[cfg(test)]
    pub fn sim(&self) -> &Arc<Sim> {
        &self.sim
    }
}

/// Builds the fake host. It needs a Tokio runtime for its background
/// loops, which is why it is async even though nothing in it waits.
pub async fn open(opts: Options) -> anyhow::Result<ProviderRef> {
    Ok(Arc::new(SimProvider::new(opts)))
}

#[async_trait]
impl Provider for SimProvider {
    fn capabilities(&self) -> Vec<String> {
        [
            cap::SYSTEMD,
            cap::DOCKER,
            cap::NGINX,
            cap::PHP,
            cap::NODEJS,
            cap::PYTHON,
            cap::POSTGRES,
            cap::MARIADB,
            cap::YUNORI,
            cap::NFTABLES,
            cap::FAIL2BAN,
            cap::CERTBOT,
            cap::RESTIC,
            cap::SIMULATED,
        ]
        .iter()
        .map(|c| c.to_string())
        .collect()
    }

    async fn host(&self, _ctx: &Ctx) -> PResult<HostInfo> {
        let s = &self.sim;
        Ok(HostInfo {
            hostname: s.id.hostname.clone(),
            machine_id: s.id.machine_id.clone(),
            os: s.id.os.clone(),
            os_version: s.id.os_version.clone(),
            arch: s.id.arch.clone(),
            kernel: s.id.kernel.clone(),
            boot_time: stamp(s.boot_time()),
            simulated: true,
        })
    }

    fn events(&self) -> Option<Arc<tokio::sync::Mutex<mpsc::Receiver<Event>>>> {
        Some(self.sim.events_rx.clone())
    }

    fn system(&self) -> &dyn System {
        &self.system
    }
    fn services(&self) -> &dyn Services {
        &self.services
    }
    fn processes(&self) -> &dyn Processes {
        &self.processes
    }
    fn containers(&self) -> &dyn Containers {
        &self.containers
    }
    fn files(&self) -> &dyn Files {
        &self.files
    }
    fn logs(&self) -> &dyn Logs {
        &self.logs
    }
    fn certs(&self) -> &dyn Certs {
        &self.certs
    }
    fn sites(&self) -> &dyn Sites {
        &self.sites
    }
    fn dns(&self) -> &dyn Dns {
        &self.dns
    }
    fn mail(&self) -> &dyn Mail {
        &self.mail
    }
    fn databases(&self) -> &dyn Databases {
        &self.databases
    }
    fn firewall(&self) -> &dyn Firewall {
        &self.firewall
    }
    fn ssh(&self) -> &dyn Ssh {
        &self.ssh
    }
    fn backups(&self) -> &dyn Backups {
        &self.backups
    }
    fn pty(&self) -> &dyn Pty {
        &self.pty
    }

    async fn close(&self) {
        self.sim.close().await;
    }
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::*;
    use crate::providers::{
        Encoding, FsReadParams, FsWriteParams, MailAddressParams, MailAliasAddParams, MailAliasRemoveParams,
        MailCheckStatus, MailDeployOutcome, MailDeployParams, MailDomainParams, MailListParams,
        MailboxAddParams, ProviderError, SelfUpdateParams, Stream, StreamRef, topic,
    };

    /// Collects what a method streams and has nothing to say back.
    #[derive(Default)]
    struct Collector {
        chunks: Mutex<Vec<(Vec<u8>, Encoding)>>,
    }

    impl Collector {
        fn text(&self) -> String {
            self.chunks
                .lock()
                .iter()
                .filter(|(_, enc)| *enc == Encoding::Utf8)
                .map(|(data, _)| String::from_utf8_lossy(data).into_owned())
                .collect()
        }
    }

    #[async_trait]
    impl Stream for Collector {
        async fn send(&self, data: &[u8], enc: Encoding) -> PResult<()> {
            self.chunks.lock().push((data.to_vec(), enc));
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    fn collector() -> (Arc<Collector>, StreamRef) {
        let c = Arc::new(Collector::default());
        (c.clone(), c)
    }

    async fn open_sim(name: &str) -> ProviderRef {
        let dir = std::env::temp_dir().join(format!("kaname-sim-test-{name}"));
        open(Options {
            agent_version: "0.1.0".into(),
            state_dir: dir,
        })
        .await
        .expect("opening the simulator")
    }

    /// A simulated host exists so the panel can be developed without a
    /// fleet. The one thing it must never do is claim to have carried out a
    /// destructive operation it did not carry out.
    #[tokio::test]
    async fn self_update_is_refused() {
        let provider = open_sim("selfupdate").await;
        let (_, stream) = collector();
        let result = provider
            .system()
            .self_update(
                &Ctx::background(),
                SelfUpdateParams {
                    version: "0.2.0".into(),
                    url: "https://example.com/kanamed".into(),
                    sha256: "0".into(),
                },
                stream,
            )
            .await;
        match result {
            Err(ProviderError::Unsupported(_)) => {}
            Err(other) => panic!("expected Unsupported, got {other:?}"),
            Ok(r) => panic!(
                "a simulated host reported a self-update: restarting={}",
                r.restarting
            ),
        }
        provider.close().await;
    }

    #[tokio::test]
    async fn capabilities_name_yunori_and_simulated() {
        let provider = open_sim("caps").await;
        let caps = provider.capabilities();
        assert!(caps.iter().any(|c| c == "yunori"), "{caps:?}");
        assert!(caps.iter().any(|c| c == "simulated"), "{caps:?}");
        for retired in ["mail", "postfix", "dovecot"] {
            assert!(
                !caps.iter().any(|c| c == retired),
                "{retired} should not be advertised"
            );
        }
        let host = provider.host(&Ctx::background()).await.unwrap();
        assert!(host.simulated);
        assert!(host.hostname.ends_with(".kaname.internal"));
        provider.close().await;
    }

    #[tokio::test]
    async fn identity_is_stable_for_a_state_dir() {
        let a = open_sim("stable").await;
        let b = open_sim("stable").await;
        let ctx = Ctx::background();
        assert_eq!(
            a.host(&ctx).await.unwrap().machine_id,
            b.host(&ctx).await.unwrap().machine_id
        );
        let c = open_sim("other").await;
        assert_ne!(
            a.host(&ctx).await.unwrap().machine_id,
            c.host(&ctx).await.unwrap().machine_id
        );
        a.close().await;
        b.close().await;
        c.close().await;
    }

    #[tokio::test]
    async fn mail_world_enforces_conflicts_and_not_found() {
        let provider = open_sim("mail").await;
        let ctx = Ctx::background();
        let mail = provider.mail();

        let status = mail.status(&ctx).await.unwrap();
        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("0.1.0"));
        assert!(!status.install_complete);
        assert_eq!(status.steps.len(), 12);
        let ptr = status
            .steps
            .iter()
            .find(|s| s.title == "Set reverse DNS")
            .unwrap();
        assert_eq!(ptr.detail.as_deref(), Some(mail::PTR_DETAIL));
        assert_eq!(status.hostnames, vec!["mail.futureforge.dev".to_string()]);
        assert!(status.services.iter().all(|s| s.active));

        let domains = mail.list_domains(&ctx).await.unwrap();
        let primary = domains.iter().find(|d| d.name == "futureforge.dev").unwrap();
        assert_eq!(primary.mailbox_count, 3);
        assert_eq!(primary.dns_status, MailCheckStatus::Warn);

        // An alias may not shadow a mailbox.
        let err = mail
            .add_alias(
                &ctx,
                MailAliasAddParams {
                    alias: "ops@futureforge.dev".into(),
                    mailbox: "hello@futureforge.dev".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{err:?}");

        // A mailbox may not take an alias's address.
        let err = mail
            .add_mailbox(
                &ctx,
                MailboxAddParams {
                    address: "info@futureforge.dev".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{err:?}");

        // A domain with mailboxes stays.
        let err = mail
            .remove_domain(
                &ctx,
                MailDomainParams {
                    name: "kaname.sh".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{err:?}");

        // Unknown things are not found.
        for err in [
            mail.remove_domain(
                &ctx,
                MailDomainParams {
                    name: "nowhere.example".into(),
                },
            )
            .await
            .unwrap_err(),
            mail.remove_mailbox(
                &ctx,
                MailAddressParams {
                    address: "ghost@futureforge.dev".into(),
                },
            )
            .await
            .unwrap_err(),
            mail.remove_alias(
                &ctx,
                MailAliasRemoveParams {
                    alias: "ghost@futureforge.dev".into(),
                },
            )
            .await
            .unwrap_err(),
            mail.mailbox_password(
                &ctx,
                MailAddressParams {
                    address: "ghost@futureforge.dev".into(),
                },
            )
            .await
            .unwrap_err(),
            mail.domain_dns(
                &ctx,
                MailDomainParams {
                    name: "nowhere.example".into(),
                },
            )
            .await
            .unwrap_err(),
            mail.add_mailbox(
                &ctx,
                MailboxAddParams {
                    address: "x@nowhere.example".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err(),
        ] {
            assert!(matches!(err, ProviderError::NotFound(_)), "{err:?}");
        }

        // Adding then removing really mutates the world.
        let password = mail
            .add_mailbox(
                &ctx,
                MailboxAddParams {
                    address: "Bob@kaname.sh".into(),
                    display_name: Some("Bob".into()),
                    quota_mb: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(password.password.chars().count(), 20);
        let boxes = mail
            .list_mailboxes(
                &ctx,
                MailListParams {
                    domain: Some("kaname.sh".into()),
                },
            )
            .await
            .unwrap();
        assert!(boxes.iter().any(|b| b.address == "bob@kaname.sh"));
        let err = mail
            .add_mailbox(
                &ctx,
                MailboxAddParams {
                    address: "bob@kaname.sh".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)));

        mail.add_alias(
            &ctx,
            MailAliasAddParams {
                alias: "robert@kaname.sh".into(),
                mailbox: "bob@kaname.sh".into(),
            },
        )
        .await
        .unwrap();
        let boxes = mail
            .list_mailboxes(
                &ctx,
                MailListParams {
                    domain: Some("kaname.sh".into()),
                },
            )
            .await
            .unwrap();
        let bob = boxes.iter().find(|b| b.address == "bob@kaname.sh").unwrap();
        assert_eq!(bob.aliases, vec!["robert@kaname.sh".to_string()]);

        for address in ["bob@kaname.sh", "team@kaname.sh"] {
            mail.remove_mailbox(
                &ctx,
                MailAddressParams {
                    address: address.into(),
                },
            )
            .await
            .unwrap();
        }
        // The alias went with its mailbox.
        let aliases = mail
            .list_aliases(
                &ctx,
                MailListParams {
                    domain: Some("kaname.sh".into()),
                },
            )
            .await
            .unwrap();
        assert!(!aliases.iter().any(|a| a.address == "robert@kaname.sh"));
        mail.remove_domain(
            &ctx,
            MailDomainParams {
                name: "kaname.sh".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            !mail
                .list_domains(&ctx)
                .await
                .unwrap()
                .iter()
                .any(|d| d.name == "kaname.sh")
        );

        // DNS expectations: DKIM fails on the warn domain, with a long value.
        let dns = mail
            .domain_dns(
                &ctx,
                MailDomainParams {
                    name: "futureforge.dev".into(),
                },
            )
            .await
            .unwrap();
        let dkim = dns
            .records
            .iter()
            .find(|r| {
                r.name
                    .starts_with(&format!("{}._domainkey.", mail::DKIM_SELECTOR))
            })
            .unwrap();
        assert_eq!(dkim.status, MailCheckStatus::Fail);
        assert!(dkim.expected.as_deref().unwrap().len() > 300);
        assert!(dkim.actual.is_empty());
        assert!(
            dns.records
                .iter()
                .any(|r| r.rtype == "MX" && r.status == MailCheckStatus::Pass)
        );
        assert!(dns.zone_file.contains("$ORIGIN futureforge.dev."));

        // Doctor has the two deliberate findings.
        let checks = mail.doctor(&ctx).await.unwrap();
        let zen = checks.iter().find(|c| c.label == "Spamhaus ZEN").unwrap();
        assert_eq!(zen.status, MailCheckStatus::Fail);
        assert!(zen.remedy.is_some());
        let ptr = checks.iter().find(|c| c.label == "Reverse DNS (PTR)").unwrap();
        assert_eq!(ptr.status, MailCheckStatus::Warn);

        provider.close().await;
    }

    #[tokio::test]
    async fn mail_deploy_pauses_at_reverse_dns() {
        let provider = open_sim("deploy").await;
        let ctx = Ctx::background();
        let (collector, stream) = collector();
        let result = provider
            .mail()
            .deploy(
                &ctx,
                MailDeployParams {
                    version: "0.1.0".into(),
                    url: "https://example.com/yunori-mail.tar.zst".into(),
                    sha256: "deadbeef".into(),
                    domain: "Example.org".into(),
                    hostname: "mail.example.org".into(),
                    admin_email: "admin@example.net".into(),
                    ..Default::default()
                },
                stream,
            )
            .await
            .unwrap();
        assert_eq!(result.outcome, MailDeployOutcome::Paused);
        assert_eq!(result.paused_at.as_deref(), Some("Set reverse DNS"));
        assert!(
            result
                .setup_url
                .as_deref()
                .unwrap()
                .starts_with("https://mail.example.org/console/setup#token=sim-")
        );
        assert_eq!(result.first_mailbox.as_deref(), Some("hello@example.org"));
        assert_eq!(
            result.first_mailbox_password.as_deref().map(|p| p.len()),
            Some(20)
        );
        assert!(collector.text().lines().count() >= 10);

        let domains = provider.mail().list_domains(&ctx).await.unwrap();
        let added = domains.iter().find(|d| d.name == "example.org").unwrap();
        assert_eq!(added.mailbox_count, 1);
        assert_eq!(added.dns_status, MailCheckStatus::Fail);
        provider.close().await;
    }

    #[tokio::test]
    async fn stopping_a_unit_removes_its_processes_and_emits() {
        let provider = open_sim("units").await;
        let ctx = Ctx::background();

        let before = provider.processes().list(&ctx, Default::default()).await.unwrap();
        assert!(before.processes.iter().any(|p| p.command == "nginx"));

        let info = provider.services().stop(&ctx, "nginx.service").await.unwrap();
        assert_eq!(info.active_state, "inactive");
        assert!(info.main_pid.is_none());

        let after = provider.processes().list(&ctx, Default::default()).await.unwrap();
        assert!(!after.processes.iter().any(|p| p.command == "nginx"));
        assert!(after.total < before.total);

        let events = provider.events().unwrap();
        let event = events.lock().await.try_recv().expect("a service.changed event");
        assert_eq!(event.topic, topic::SERVICE_CHANGED);
        assert_eq!(event.data["unit"], "nginx.service");

        let err = provider
            .services()
            .status(&ctx, "nope.service")
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::NotFound(_)));
        provider.close().await;
    }

    #[tokio::test]
    async fn files_persist_and_account_for_space() {
        let provider = open_sim("files").await;
        let ctx = Ctx::background();
        let files = provider.files();

        let before = provider.system().metrics(&ctx).await.unwrap();
        let root_before = before.disks.iter().find(|d| d.mount == "/").unwrap().used;

        let body = "x".repeat(4 * 1024 * 1024);
        files
            .write(
                &ctx,
                FsWriteParams {
                    path: "/srv/scratch/big.txt".into(),
                    content: body.clone(),
                    encoding: "utf8".into(),
                    mode: None,
                    create_parents: true,
                },
            )
            .await
            .unwrap();
        let read = files
            .read(
                &ctx,
                FsReadParams {
                    path: "/srv/scratch/big.txt".into(),
                    max_bytes: 16,
                },
            )
            .await
            .unwrap();
        assert!(read.truncated);
        assert_eq!(read.size, body.len() as i64);
        assert_eq!(read.content.len(), 16);

        let after = provider.system().metrics(&ctx).await.unwrap();
        let root_after = after.disks.iter().find(|d| d.mount == "/").unwrap().used;
        assert!(
            root_after > root_before + 3 * 1024 * 1024,
            "{root_before} -> {root_after}"
        );

        let err = files
            .read(
                &ctx,
                FsReadParams {
                    path: "/etc/../etc/passwd".into(),
                    max_bytes: 0,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));

        // The symlinked /bin resolves into /usr/bin.
        let entry = files.stat(&ctx, "/bin/ls").await.unwrap();
        assert_eq!(entry.kind, "file");
        provider.close().await;
    }
}
