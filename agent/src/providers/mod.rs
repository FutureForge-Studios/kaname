//! The provider seam (KD-010).
//!
//! Everything above this line is protocol; everything below it is a
//! syscall. Two implementations satisfy these traits: `linux`, which talks
//! to systemd, the container socket, procfs, the filesystem and the
//! `yunori-mail` CLI, and `sim`, a deterministic fake host that makes the
//! whole product developable and e2e-testable without a Linux box.
//!
//! A provider never receives a command string. Every method takes a typed,
//! already-validated parameter struct, which is what makes command
//! injection structurally impossible rather than a code-review
//! responsibility.

pub mod payloads;

#[cfg(target_os = "linux")]
pub mod linux;
pub mod sim;

use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub use payloads::*;

/* ------------------------------ capabilities ------------------------- */

/// Host capabilities, mirroring `serverCapability` in the contract. A host
/// advertises these in the hello frame and the hub gates methods on them.
pub mod cap {
    pub const SYSTEMD: &str = "systemd";
    pub const DOCKER: &str = "docker";
    pub const PODMAN: &str = "podman";
    pub const NGINX: &str = "nginx";
    pub const APACHE: &str = "apache";
    pub const CADDY: &str = "caddy";
    pub const PHP: &str = "php";
    pub const NODEJS: &str = "nodejs";
    pub const PYTHON: &str = "python";
    pub const MYSQL: &str = "mysql";
    pub const MARIADB: &str = "mariadb";
    pub const POSTGRES: &str = "postgres";
    /// Yunori Mail Server (`yunori-mail` + Stalwart) is installed.
    pub const YUNORI: &str = "yunori";
    pub const NFTABLES: &str = "nftables";
    pub const IPTABLES: &str = "iptables";
    pub const UFW: &str = "ufw";
    pub const FAIL2BAN: &str = "fail2ban";
    pub const CERTBOT: &str = "certbot";
    pub const RESTIC: &str = "restic";
    pub const SIMULATED: &str = "simulated";
}

/* --------------------------------- errors ---------------------------- */

/// Every way a provider call can fail. The RPC layer maps each variant onto
/// a contract error code, so a new variant here needs a code there too.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The host cannot serve this at all; the panel greys the module out.
    #[error("not supported on this host{}", fmt_reason(.0))]
    Unsupported(Option<String>),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PreconditionFailed(String),
    #[error("{0}")]
    InvalidParams(String),
    /// A real binary ran and failed. `output` is the excerpt the operator
    /// needs to understand why — it reaches the panel as the error's
    /// `output` field, which is the difference between "exec failed" and the
    /// line nginx actually printed.
    #[error("{op}: {message}")]
    Exec {
        op: String,
        message: String,
        output: String,
    },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the request was cancelled")]
    Cancelled,
    #[error("the request exceeded its deadline")]
    Timeout,
    #[error("{0}")]
    Internal(String),
}

fn fmt_reason(reason: &Option<String>) -> String {
    match reason {
        Some(r) => format!(": {r}"),
        None => String::new(),
    }
}

impl ProviderError {
    #[cfg(test)]
    pub fn unsupported() -> Self {
        ProviderError::Unsupported(None)
    }
    pub fn unsupported_because(reason: impl Into<String>) -> Self {
        ProviderError::Unsupported(Some(reason.into()))
    }
    pub fn not_found(what: impl Into<String>) -> Self {
        ProviderError::NotFound(what.into())
    }
    pub fn conflict(what: impl Into<String>) -> Self {
        ProviderError::Conflict(what.into())
    }
    pub fn invalid(what: impl Into<String>) -> Self {
        ProviderError::InvalidParams(what.into())
    }
    pub fn internal(what: impl fmt::Display) -> Self {
        ProviderError::Internal(what.to_string())
    }
    pub fn exec(op: impl Into<String>, message: impl Into<String>, output: impl Into<String>) -> Self {
        ProviderError::Exec {
            op: op.into(),
            message: message.into(),
            output: truncate_output(output.into()),
        }
    }
}

impl From<anyhow::Error> for ProviderError {
    fn from(err: anyhow::Error) -> Self {
        ProviderError::Internal(format!("{err:#}"))
    }
}

impl From<serde_json::Error> for ProviderError {
    fn from(err: serde_json::Error) -> Self {
        ProviderError::Internal(err.to_string())
    }
}

/// The contract caps the stderr/journal excerpt an error may carry.
pub const MAX_ERROR_OUTPUT: usize = 16 * 1024;

/// Keeps the tail of an excerpt, cut at a character boundary.
pub fn truncate_output(mut output: String) -> String {
    if output.len() > MAX_ERROR_OUTPUT {
        let mut cut = output.len() - MAX_ERROR_OUTPUT;
        while !output.is_char_boundary(cut) {
            cut += 1;
        }
        output = output.split_off(cut);
    }
    output
}

pub type PResult<T> = Result<T, ProviderError>;

/* ------------------------------- context ----------------------------- */

/// What a call may still do. Carries the cancellation token the connection
/// trips on a `can` frame, a dropped socket or an expired deadline, so a
/// followed log or an open shell stops when the control plane stops
/// listening rather than when it next tries to write.
#[derive(Clone, Debug)]
pub struct Ctx {
    token: CancellationToken,
    deadline: Option<Instant>,
}

impl Ctx {
    pub fn new(token: CancellationToken, deadline: Option<Instant>) -> Self {
        Self { token, deadline }
    }

    /// A context nothing cancels: for startup probes and tests.
    pub fn background() -> Self {
        Self {
            token: CancellationToken::new(),
            deadline: None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled() || self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    /// Resolves when the call is cancelled or its deadline passes.
    pub async fn done(&self) {
        match self.deadline {
            Some(deadline) => {
                tokio::select! {
                    _ = self.token.cancelled() => {}
                    _ = tokio::time::sleep_until(deadline.into()) => {}
                }
            }
            None => self.token.cancelled().await,
        }
    }

    /// The error a cancelled context stands for: a deadline is a timeout, a
    /// `can` frame is a cancel, and neither is an internal failure.
    pub fn error(&self) -> ProviderError {
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            ProviderError::Timeout
        } else {
            ProviderError::Cancelled
        }
    }

    pub fn check(&self) -> PResult<()> {
        if self.is_cancelled() {
            Err(self.error())
        } else {
            Ok(())
        }
    }

    /// A child context that is cancelled with its parent and can also be
    /// cancelled on its own.
    pub fn child(&self) -> Ctx {
        Ctx {
            token: self.token.child_token(),
            deadline: self.deadline,
        }
    }

    pub fn cancel(&self) {
        self.token.cancel();
    }

    /// Runs `fut` unless the context ends first.
    pub async fn run<T>(&self, fut: impl std::future::Future<Output = T>) -> PResult<T> {
        tokio::select! {
            out = fut => Ok(out),
            _ = self.done() => Err(self.error()),
        }
    }
}

/* ------------------------------- streams ----------------------------- */

/// How a chunk's bytes travel on the wire: text streams stay readable as
/// utf8, binary payloads are base64.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    Base64,
}

/// Carries the chunk traffic of a streaming method. Response streams only
/// ever `send`; bidirectional methods (upload, exec, pty) also `recv`.
/// `recv` returns `Ok(None)` once the peer has closed its side.
#[async_trait]
pub trait Stream: Send + Sync {
    async fn send(&self, data: &[u8], enc: Encoding) -> PResult<()>;
    async fn recv(&self) -> PResult<Option<Vec<u8>>>;
}

pub type StreamRef = Arc<dyn Stream>;

/// Convenience for the many methods that narrate progress as text lines.
pub async fn say(stream: &dyn Stream, line: impl AsRef<str>) {
    let mut text = line.as_ref().to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let _ = stream.send(text.as_bytes(), Encoding::Utf8).await;
}

/* -------------------------------- events ----------------------------- */

/// An unsolicited push: a state change the control plane should not have
/// to poll for. `topic` is one of the contract's agent event topics;
/// anything else is dropped by the hub.
#[derive(Clone, Debug)]
pub struct Event {
    pub topic: &'static str,
    pub data: serde_json::Value,
}

pub mod topic {
    pub const METRICS: &str = "metrics";
    pub const SERVICE_CHANGED: &str = "service.changed";
    pub const CONTAINER_CHANGED: &str = "container.changed";
    pub const THREAT_DETECTED: &str = "threat.detected";
    pub const SSH_SESSION: &str = "ssh.session";
    pub const CERT_EXPIRING: &str = "cert.expiring";
    pub const DISK_PRESSURE: &str = "disk.pressure";
    /// Mirrors the contract's topic list; no provider raises it yet.
    #[allow(dead_code)]
    pub const LOG_ANOMALY: &str = "log.anomaly";
}

/* ----------------------------- sub-traits ---------------------------- */

#[async_trait]
pub trait System: Send + Sync {
    async fn info(&self, ctx: &Ctx) -> PResult<SystemInfo>;
    async fn metrics(&self, ctx: &Ctx) -> PResult<MetricsSample>;
    async fn reboot(&self, ctx: &Ctx, p: SystemRebootParams) -> PResult<()>;
    async fn list_packages(&self, ctx: &Ctx, p: PackagesListParams) -> PResult<Vec<PackageInfo>>;
    async fn upgrade_packages(
        &self,
        ctx: &Ctx,
        p: PackagesUpgradeParams,
        s: StreamRef,
    ) -> PResult<PackagesUpgradeResult>;
    /// Replaces the agent binary and restarts. A provider with no real
    /// binary behind it — the simulator — returns `Unsupported` rather than
    /// pretending, because a fleet that lies about this operation is worse
    /// than one that cannot do it.
    async fn self_update(&self, ctx: &Ctx, p: SelfUpdateParams, s: StreamRef) -> PResult<SelfUpdateResult>;
}

#[async_trait]
pub trait Services: Send + Sync {
    async fn list(&self, ctx: &Ctx, p: ServiceListParams) -> PResult<Vec<ServiceInfo>>;
    async fn status(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn start(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn stop(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn restart(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn reload(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn enable(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn disable(&self, ctx: &Ctx, unit: &str) -> PResult<ServiceInfo>;
    async fn logs(&self, ctx: &Ctx, p: ServiceLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>>;
}

#[async_trait]
pub trait Processes: Send + Sync {
    async fn list(&self, ctx: &Ctx, p: ProcessListParams) -> PResult<ProcessListResult>;
    async fn tree(&self, ctx: &Ctx, p: ProcessTreeParams) -> PResult<Vec<ProcessNode>>;
    async fn signal(&self, ctx: &Ctx, p: SignalParams) -> PResult<()>;
}

#[async_trait]
pub trait Containers: Send + Sync {
    async fn list(&self, ctx: &Ctx, p: ContainerListParams) -> PResult<Vec<ContainerInfo>>;
    async fn inspect(&self, ctx: &Ctx, id: &str) -> PResult<ContainerInspectResult>;
    async fn start(&self, ctx: &Ctx, id: &str) -> PResult<ContainerInfo>;
    async fn stop(&self, ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo>;
    async fn restart(&self, ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo>;
    async fn remove(&self, ctx: &Ctx, p: ContainerRemoveParams) -> PResult<()>;
    async fn logs(&self, ctx: &Ctx, p: ContainerLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>>;
    async fn exec(&self, ctx: &Ctx, p: ContainerExecParams, s: StreamRef) -> PResult<()>;
    async fn images(&self, ctx: &Ctx) -> PResult<Vec<ImageInfo>>;
    async fn prune(&self, ctx: &Ctx, p: ContainerPruneParams) -> PResult<ContainerPruneResult>;
}

#[async_trait]
pub trait Files: Send + Sync {
    async fn list(&self, ctx: &Ctx, p: FsListParams) -> PResult<DirectoryListing>;
    async fn stat(&self, ctx: &Ctx, path: &str) -> PResult<FileEntry>;
    async fn read(&self, ctx: &Ctx, p: FsReadParams) -> PResult<FsReadResult>;
    async fn write(&self, ctx: &Ctx, p: FsWriteParams) -> PResult<FileEntry>;
    async fn mkdir(&self, ctx: &Ctx, p: FsMkdirParams) -> PResult<FileEntry>;
    async fn r#move(&self, ctx: &Ctx, p: FsMoveParams) -> PResult<FileEntry>;
    async fn copy(&self, ctx: &Ctx, p: FsCopyParams) -> PResult<FileEntry>;
    async fn remove(&self, ctx: &Ctx, p: FsRemoveParams) -> PResult<i64>;
    async fn chmod(&self, ctx: &Ctx, p: FsChmodParams) -> PResult<()>;
    async fn chown(&self, ctx: &Ctx, p: FsChownParams) -> PResult<()>;
    async fn archive(&self, ctx: &Ctx, p: FsArchiveParams, s: StreamRef) -> PResult<FileEntry>;
    async fn extract(&self, ctx: &Ctx, p: FsExtractParams, s: StreamRef) -> PResult<i64>;
    async fn download(&self, ctx: &Ctx, p: FsDownloadParams, s: StreamRef) -> PResult<FsDownloadResult>;
    async fn upload(&self, ctx: &Ctx, p: FsUploadParams, s: StreamRef) -> PResult<FileEntry>;
    async fn usage(&self, ctx: &Ctx, p: FsUsageParams) -> PResult<FsUsageResult>;
}

#[async_trait]
pub trait Logs: Send + Sync {
    async fn sources(&self, ctx: &Ctx) -> PResult<Vec<LogSource>>;
    async fn tail(&self, ctx: &Ctx, p: LogTailParams, s: StreamRef) -> PResult<Vec<LogRecord>>;
}

#[async_trait]
pub trait Certs: Send + Sync {
    async fn list(&self, ctx: &Ctx) -> PResult<Vec<CertificateInfo>>;
    async fn issue(&self, ctx: &Ctx, p: CertIssueParams, s: StreamRef) -> PResult<CertIssueResult>;
    async fn renew(&self, ctx: &Ctx, p: CertRenewParams, s: StreamRef) -> PResult<CertRenewResult>;
    async fn revoke(&self, ctx: &Ctx, p: CertRevokeParams) -> PResult<()>;
    async fn install(&self, ctx: &Ctx, p: CertInstallParams) -> PResult<CertInstallResult>;
}

#[async_trait]
pub trait Sites: Send + Sync {
    async fn list(&self, ctx: &Ctx) -> PResult<Vec<SiteInfo>>;
    async fn create(&self, ctx: &Ctx, p: SiteCreateParams) -> PResult<SiteConfigResult>;
    async fn update(&self, ctx: &Ctx, p: SiteUpdateParams) -> PResult<SiteConfigResult>;
    async fn remove(&self, ctx: &Ctx, p: SiteRemoveParams) -> PResult<()>;
    async fn test_config(&self, ctx: &Ctx) -> PResult<SiteTestConfigResult>;
    async fn reload(&self, ctx: &Ctx) -> PResult<()>;
}

/// DNS resolves from the managed host's own vantage point: what the panel's
/// resolver sees is not what the mail server sees.
#[async_trait]
pub trait Dns: Send + Sync {
    async fn resolve(&self, ctx: &Ctx, p: DnsResolveParams) -> PResult<Vec<ResolvedRecord>>;
}

/// Mail is Yunori Mail Server on the host (KD-023). Every method is one
/// `yunori-mail` invocation: the agent never reads its database or vault
/// and never talks to Stalwart directly.
#[async_trait]
pub trait Mail: Send + Sync {
    async fn status(&self, ctx: &Ctx) -> PResult<MailServerStatusInfo>;
    async fn preflight(&self, ctx: &Ctx, p: MailPreflightParams) -> PResult<Vec<MailCheck>>;
    async fn doctor(&self, ctx: &Ctx) -> PResult<Vec<MailCheck>>;
    async fn deploy(&self, ctx: &Ctx, p: MailDeployParams, s: StreamRef) -> PResult<MailDeployResult>;
    async fn update(&self, ctx: &Ctx, s: StreamRef) -> PResult<()>;
    async fn list_domains(&self, ctx: &Ctx) -> PResult<Vec<MailDomainEntry>>;
    async fn add_domain(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<()>;
    async fn remove_domain(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<()>;
    async fn domain_dns(&self, ctx: &Ctx, p: MailDomainParams) -> PResult<MailDomainDnsResult>;
    async fn list_mailboxes(&self, ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailboxEntry>>;
    async fn add_mailbox(&self, ctx: &Ctx, p: MailboxAddParams) -> PResult<MailPasswordResult>;
    async fn mailbox_password(&self, ctx: &Ctx, p: MailAddressParams) -> PResult<MailPasswordResult>;
    async fn remove_mailbox(&self, ctx: &Ctx, p: MailAddressParams) -> PResult<()>;
    async fn list_aliases(&self, ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailAliasEntry>>;
    async fn add_alias(&self, ctx: &Ctx, p: MailAliasAddParams) -> PResult<()>;
    async fn remove_alias(&self, ctx: &Ctx, p: MailAliasRemoveParams) -> PResult<()>;
    async fn certificate_status(&self, ctx: &Ctx) -> PResult<MailCertificateStatus>;
    async fn certificate_renew(&self, ctx: &Ctx, s: StreamRef) -> PResult<MailCertificateRenewResult>;
    async fn logs(&self, ctx: &Ctx, p: MailLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>>;
}

#[async_trait]
pub trait Databases: Send + Sync {
    async fn instances(&self, ctx: &Ctx) -> PResult<Vec<DbInstanceInfo>>;
    async fn list_databases(&self, ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbDatabaseInfo>>;
    async fn create_database(&self, ctx: &Ctx, p: DbDatabaseCreateParams) -> PResult<DbDatabaseInfo>;
    async fn delete_database(&self, ctx: &Ctx, p: DbDatabaseDeleteParams) -> PResult<()>;
    async fn list_users(&self, ctx: &Ctx, p: DbEngineParams) -> PResult<Vec<DbUserInfo>>;
    async fn create_user(&self, ctx: &Ctx, p: DbUserCreateParams) -> PResult<DbUserInfo>;
    async fn update_user(&self, ctx: &Ctx, p: DbUserUpdateParams) -> PResult<DbUserInfo>;
    async fn delete_user(&self, ctx: &Ctx, p: DbUserDeleteParams) -> PResult<()>;
    async fn apply_grant(&self, ctx: &Ctx, p: DbGrantApplyParams) -> PResult<()>;
    async fn size(&self, ctx: &Ctx, p: DbSizeParams) -> PResult<DbSizeResult>;
    async fn dump(&self, ctx: &Ctx, p: DbDumpParams, s: StreamRef) -> PResult<DbDumpResult>;
    async fn restore(&self, ctx: &Ctx, p: DbRestoreParams, s: StreamRef) -> PResult<()>;
}

#[async_trait]
pub trait Firewall: Send + Sync {
    async fn status(&self, ctx: &Ctx) -> PResult<FirewallStatus>;
    async fn list(&self, ctx: &Ctx) -> PResult<Vec<FirewallRuleInfo>>;
    async fn apply(&self, ctx: &Ctx, p: FwApplyParams) -> PResult<FwApplyResult>;
    async fn confirm(&self, ctx: &Ctx, p: FwConfirmParams) -> PResult<()>;
    async fn ban(&self, ctx: &Ctx, p: FwBanParams) -> PResult<()>;
    async fn unban(&self, ctx: &Ctx, p: FwUnbanParams) -> PResult<()>;
    async fn bans(&self, ctx: &Ctx) -> PResult<Vec<BanEntry>>;
    async fn threats(&self, ctx: &Ctx, p: FwThreatsParams) -> PResult<Vec<ThreatObservation>>;
}

#[async_trait]
pub trait Ssh: Send + Sync {
    async fn list_keys(&self, ctx: &Ctx, p: SshKeysListParams) -> PResult<Vec<SshKeyInfo>>;
    async fn apply_keys(&self, ctx: &Ctx, p: SshKeysApplyParams) -> PResult<i64>;
    async fn read_config(&self, ctx: &Ctx) -> PResult<SshConfigInfo>;
    async fn apply_config(&self, ctx: &Ctx, p: SshConfigApplyParams) -> PResult<SshConfigApplyResult>;
    async fn sessions(&self, ctx: &Ctx) -> PResult<Vec<SshSessionInfo>>;
}

#[async_trait]
pub trait Backups: Send + Sync {
    async fn run(&self, ctx: &Ctx, p: BackupRunParams, s: StreamRef) -> PResult<BackupSnapshotInfo>;
    async fn list(&self, ctx: &Ctx, p: BackupListParams) -> PResult<Vec<BackupSnapshotInfo>>;
    async fn restore(&self, ctx: &Ctx, p: BackupRestoreParams, s: StreamRef) -> PResult<BackupRestoreResult>;
    async fn verify(&self, ctx: &Ctx, p: BackupVerifyParams, s: StreamRef) -> PResult<BackupVerifyResult>;
    async fn prune(&self, ctx: &Ctx, p: BackupPruneParams, s: StreamRef) -> PResult<BackupPruneResult>;
}

/// The one place where free-form execution is allowed at all, so the one
/// place that is separately permissioned, ticketed and recorded by the
/// control plane (KD-013). Sessions are keyed by the id of the stream that
/// opened them.
#[async_trait]
pub trait Pty: Send + Sync {
    /// Runs the shell until the stream closes, the session is closed or the
    /// context ends. It reports the child pid as soon as it starts.
    async fn open(
        &self,
        ctx: &Ctx,
        session_id: &str,
        p: PtyOpenParams,
        s: StreamRef,
    ) -> PResult<PtyOpenResult>;
    async fn resize(&self, ctx: &Ctx, session_id: &str, p: PtyResizeParams) -> PResult<()>;
    async fn close(&self, ctx: &Ctx, session_id: &str) -> PResult<()>;
}

/* ------------------------------ aggregate ----------------------------- */

/// The whole host, as the agent is allowed to see it. Every sub-trait is
/// always present; a host that lacks a capability returns `Unsupported`
/// from that sub-trait's methods rather than handing back nothing for the
/// caller to trip over.
#[async_trait]
pub trait Provider: Send + Sync {
    fn capabilities(&self) -> Vec<String>;
    async fn host(&self, ctx: &Ctx) -> PResult<HostInfo>;

    /// Drained while a connection is up and ignored the rest of the time.
    /// Implementations must never block on a send: a state change nobody is
    /// listening for is dropped, not queued forever.
    fn events(&self) -> Option<Arc<tokio::sync::Mutex<mpsc::Receiver<Event>>>>;

    fn system(&self) -> &dyn System;
    fn services(&self) -> &dyn Services;
    fn processes(&self) -> &dyn Processes;
    fn containers(&self) -> &dyn Containers;
    fn files(&self) -> &dyn Files;
    fn logs(&self) -> &dyn Logs;
    fn certs(&self) -> &dyn Certs;
    fn sites(&self) -> &dyn Sites;
    fn dns(&self) -> &dyn Dns;
    fn mail(&self) -> &dyn Mail;
    fn databases(&self) -> &dyn Databases;
    fn firewall(&self) -> &dyn Firewall;
    fn ssh(&self) -> &dyn Ssh;
    fn backups(&self) -> &dyn Backups;
    fn pty(&self) -> &dyn Pty;

    async fn close(&self);
}

pub type ProviderRef = Arc<dyn Provider>;

/* ------------------------------ selection ----------------------------- */

/// Everything a provider needs that comes from the process rather than
/// from the host.
#[derive(Clone, Debug)]
pub struct Options {
    pub agent_version: String,
    pub state_dir: std::path::PathBuf,
}

/// Builds the named provider. The binary's provider set is decided by
/// which modules are compiled in, not by configuration.
pub async fn open(name: &str, opts: Options) -> anyhow::Result<ProviderRef> {
    match name {
        "sim" => Ok(sim::open(opts).await?),
        #[cfg(target_os = "linux")]
        "linux" => Ok(linux::open(opts).await?),
        other => anyhow::bail!(
            "provider {other:?} is not available in this build (have: {:?})",
            registered()
        ),
    }
}

/// The provider names compiled into this binary.
pub fn registered() -> Vec<&'static str> {
    let mut names = vec!["sim"];
    if cfg!(target_os = "linux") {
        names.insert(0, "linux");
    }
    names
}

/* ------------------------- capability changes ------------------------ */

/// Raised when what this host can serve has changed under the running
/// agent: a deploy just installed Yunori Mail Server. Capabilities travel
/// in the hello frame and gate methods on both ends, so the only honest
/// way to publish new ones is a fresh hello; `run_agent` reconnects when
/// this fires. `notify_one` keeps a permit, so a change raised between
/// sessions is not lost.
static CAPABILITIES_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn announce_capabilities_changed() {
    CAPABILITIES_CHANGED.notify_one();
}

pub async fn capabilities_changed() {
    CAPABILITIES_CHANGED.notified().await;
}

/// An event sender that drops rather than waits, so a watcher can never
/// stall the provider because nobody is connected.
pub fn emit(tx: &mpsc::Sender<Event>, topic: &'static str, data: impl serde::Serialize) {
    if let Ok(data) = serde_json::to_value(data) {
        let _ = tx.try_send(Event { topic, data });
    }
}
