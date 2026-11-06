//! Wire payloads.
//!
//! Every struct here mirrors a schema in @kaname/contract's agent package.
//! The serde names are the contract: they are what the control plane parses
//! with Zod, so a rename on either side is a runtime mismatch, not a compile
//! error. Keep them literal.
//!
//! Conventions, mirroring the Go original this was ported from:
//! - Go `omitempty` becomes `Option<T>` (or `Vec<T>`) with
//!   `skip_serializing_if`, so an absent field stays absent on the wire.
//! - A Go pointer without `omitempty` becomes `Option<T>` serialized as
//!   `null`, which is what the contract's `.nullable()` expects.
//! - `*Params` structs carry `#[serde(default)]`: a missing field decodes to
//!   its default and the handler applies the contract's real default, as the
//!   Go handlers did.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/* ------------------------------- host -------------------------------- */

/// The `host` block of the hello frame and of an enrollment request. It is
/// the subset of SystemInfo that identifies a machine.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HostInfo {
    pub hostname: String,
    pub machine_id: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub kernel: String,
    pub boot_time: String,
    pub simulated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SystemInfo {
    pub hostname: String,
    pub machine_id: String,
    pub os: String,
    pub os_version: String,
    pub os_family: String,
    pub arch: String,
    pub kernel: String,
    pub boot_time: String,
    pub uptime_seconds: i64,
    pub cpu_model: String,
    pub cpu_cores: i64,
    pub memory_total: i64,
    pub swap_total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub virtualization: Option<String>,
    pub timezone: String,
    pub agent_version: String,
    pub simulated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DiskUsage {
    pub mount: String,
    pub device: String,
    pub fstype: String,
    pub total: i64,
    pub used: i64,
    pub available: i64,
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inodes_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inodes_used: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MetricsSample {
    pub ts: String,
    pub cpu_percent: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cpu_per_core: Vec<f64>,
    pub memory_used: i64,
    pub memory_total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_cached: Option<i64>,
    pub swap_used: i64,
    pub swap_total: i64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub processes: i64,
    pub disks: Vec<DiskUsage>,
    pub net_rx_bytes: i64,
    pub net_tx_bytes: i64,
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_read_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_write_rate: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackageInfo {
    pub name: String,
    pub installed_version: String,
    pub available_version: Option<String>,
    pub security: bool,
}

/* ------------------------------ services ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub unit: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub enabled: bool,
    pub main_pid: Option<i64>,
    pub memory_current: Option<i64>,
    pub cpu_usage_ns: Option<f64>,
    pub active_since: Option<String>,
    pub restart_count: i64,
}

/* ----------------------------- processes ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: i64,
    pub ppid: i64,
    pub user: String,
    pub command: String,
    pub cmdline: String,
    pub state: String,
    pub cpu_percent: f64,
    pub memory_rss: i64,
    pub memory_percent: f64,
    pub threads: i64,
    pub started_at: String,
    pub nice: i64,
}

/// Flattens to ProcessInfo plus `depth`, matching the extended schema
/// `process.tree` returns.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProcessNode {
    #[serde(flatten)]
    pub process: ProcessInfo,
    pub depth: i64,
}

/* ----------------------------- containers ---------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerPort {
    pub container_port: i64,
    pub host_port: Option<i64>,
    pub host_ip: Option<String>,
    pub protocol: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerMount {
    pub source: String,
    pub destination: String,
    pub rw: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub image_id: String,
    pub state: String,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ports: Vec<ContainerPort>,
    pub labels: BTreeMap<String, String>,
    pub networks: Vec<String>,
    pub mounts: Vec<ContainerMount>,
    pub restart_count: i64,
    pub cpu_percent: Option<f64>,
    pub memory_usage: Option<i64>,
    pub memory_limit: Option<i64>,
    pub runtime: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ImageInfo {
    pub id: String,
    pub tags: Vec<String>,
    pub size: i64,
    pub created_at: String,
    pub in_use: bool,
}

/* ------------------------------- files ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: i64,
    pub mode: String,
    pub owner: String,
    pub group: String,
    pub uid: i64,
    pub gid: i64,
    pub modified_at: String,
    pub link_target: Option<String>,
    pub child_count: Option<i64>,
    pub mime: Option<String>,
    pub is_editable: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    pub total: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StorageUsageEntry {
    pub path: String,
    pub bytes: i64,
    pub inodes: Option<i64>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/* -------------------------------- logs ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogSource {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub size: Option<i64>,
    pub supports_follow: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogRecord {
    pub ts: String,
    pub level: String,
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/* --------------------------- mail / dns / db ------------------------- */

/*
 * Mail is Yunori Mail Server (KD-023). These shapes are what the agent
 * reads back from the `yunori-mail` CLI on the host; their vocabulary is
 * the one the Yunori console speaks, so an operator can read the same
 * verdict in either place.
 */

/// The verdict of one mail check, in the contract's vocabulary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailCheckStatus {
    Pass,
    Warn,
    Fail,
    Info,
    #[default]
    Unknown,
}

impl MailCheckStatus {
    /// Severity rank: pass < info < unknown < warn < fail. An unknown
    /// verdict outranks a pass because "we could not tell" is not good news,
    /// but it never masks a real warning.
    fn rank(self) -> u8 {
        match self {
            MailCheckStatus::Pass => 0,
            MailCheckStatus::Info => 1,
            MailCheckStatus::Unknown => 2,
            MailCheckStatus::Warn => 3,
            MailCheckStatus::Fail => 4,
        }
    }

    /// The more severe of two verdicts, for rolling a list of checks up
    /// into one headline.
    pub fn worst(a: MailCheckStatus, b: MailCheckStatus) -> MailCheckStatus {
        if b.rank() > a.rank() { b } else { a }
    }

    /// Parses the tag yunori's CLI prints in front of a check line:
    /// `ok`, `warn`, `problem`, `info` or `?`. The contract's own spellings
    /// are accepted too, so JSON output parses with the same function.
    /// Anything else is `Unknown`.
    pub fn from_tag(tag: &str) -> MailCheckStatus {
        let tag = tag.trim().trim_matches(|c| c == '[' || c == ']' || c == ':');
        match tag.to_ascii_lowercase().as_str() {
            "ok" | "pass" | "passed" => MailCheckStatus::Pass,
            "warn" | "warning" => MailCheckStatus::Warn,
            "problem" | "fail" | "failed" | "error" => MailCheckStatus::Fail,
            "info" | "note" => MailCheckStatus::Info,
            _ => MailCheckStatus::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MailCheckStatus::Pass => "pass",
            MailCheckStatus::Warn => "warn",
            MailCheckStatus::Fail => "fail",
            MailCheckStatus::Info => "info",
            MailCheckStatus::Unknown => "unknown",
        }
    }
}

/// One diagnostic result. Every status is paired with text, never colour
/// alone.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailCheck {
    pub id: String,
    pub label: String,
    pub status: MailCheckStatus,
    /// What was observed, in plain language.
    pub detail: String,
    /// What to do about it; null when there is nothing to do.
    pub remedy: Option<String>,
    pub help_url: Option<String>,
}

/// One DNS record yunori-mail expects to be published, and whether it is.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailDnsRecord {
    /// Stable id, e.g. "MX:example.com".
    pub id: String,
    #[serde(rename = "type")]
    pub rtype: String,
    /// Fully-qualified name without the trailing dot.
    pub name: String,
    /// Exact value to publish; null when the host reports the record as
    /// passing without restating it.
    pub expected: Option<String>,
    /// What public resolvers currently return.
    pub actual: Vec<String>,
    pub status: MailCheckStatus,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailInstallStepStatus {
    #[default]
    Pending,
    Running,
    Done,
    Failed,
    Waiting,
    Skipped,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailInstallStep {
    pub title: String,
    pub status: MailInstallStepStatus,
    /// For "waiting", exactly what the operator must do.
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailServiceState {
    /// "stalwart" | "yunori-mail" | "unbound"
    pub name: String,
    pub active: bool,
}

/// `mail.status`: what the host says about its Yunori Mail Server.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailServerStatusInfo {
    /// The yunori-mail binary is present.
    pub installed: bool,
    pub version: Option<String>,
    /// Every required install step is done or skipped.
    pub install_complete: bool,
    pub steps: Vec<MailInstallStep>,
    pub services: Vec<MailServiceState>,
    /// Names the TLS certificate covers; the first is the mail hostname.
    pub hostnames: Vec<String>,
    pub console_url: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailCertificateStatus {
    /// "missing" | "self_signed" | "test" | "valid" | "expired" | "unknown"
    pub state: String,
    pub covers: Vec<String>,
    pub issuer: Option<String>,
    pub expires_at: Option<String>,
    pub days_left: Option<i64>,
    pub authority: Option<String>,
    pub renews_at: Option<String>,
    pub last_attempt: Option<String>,
    pub next_attempt: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailDomainEntry {
    pub name: String,
    pub dns_status: MailCheckStatus,
    pub mailbox_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailboxEntry {
    pub address: String,
    pub display_name: Option<String>,
    /// Full alias addresses delivering to this mailbox.
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailAliasEntry {
    pub address: String,
    /// The mailbox the alias delivers to.
    pub mailbox: String,
}

/// "ready" when every step finished, "paused" at an operator gate (DNS,
/// PTR), "failed" otherwise.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailDeployOutcome {
    Ready,
    Paused,
    #[default]
    Failed,
}

/// What `mail.deploy` can honestly report once `yunori-mail install` has
/// returned.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailDeployResult {
    pub outcome: MailDeployOutcome,
    pub version: String,
    /// The step the installer paused at, when it did.
    pub paused_at: Option<String>,
    /// One-time console setup link, carrying its token in the URL fragment.
    /// Shown once, never logged.
    pub setup_url: Option<String>,
    pub console_url: Option<String>,
    pub first_mailbox: Option<String>,
    /// The first mailbox's generated password, shown once.
    pub first_mailbox_password: Option<String>,
    pub steps: Vec<MailInstallStep>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ResolvedRecord {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub values: Vec<String>,
    pub ttl: Option<i64>,
    /// Which resolver answered, so a mismatch can be explained.
    pub resolver: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbInstanceInfo {
    pub engine: String,
    pub version: String,
    pub host: String,
    pub port: i64,
    pub reachable: bool,
    pub uptime_seconds: Option<i64>,
    pub connections: Option<i64>,
    pub max_connections: Option<i64>,
    pub data_size: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbDatabaseInfo {
    pub name: String,
    pub owner: Option<String>,
    pub encoding: String,
    pub collation: Option<String>,
    pub size_bytes: i64,
    pub table_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbUserInfo {
    pub username: String,
    pub host_pattern: String,
    pub auth_plugin: Option<String>,
    pub is_superuser: bool,
    pub can_login: bool,
}

/* ------------------------------ security ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FirewallRuleInfo {
    pub id: String,
    pub priority: i64,
    pub action: String,
    pub direction: String,
    pub protocol: String,
    pub port_spec: Option<String>,
    pub source: Option<String>,
    pub destination: Option<String>,
    pub comment: Option<String>,
    pub enabled: bool,
    pub backend: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BanEntry {
    pub ip: String,
    pub jail: String,
    pub banned_at: String,
    pub expires_at: Option<String>,
    pub attempts: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ThreatObservation {
    pub kind: String,
    pub source_ip: String,
    pub target: String,
    pub attempts: i64,
    pub first_seen: String,
    pub last_seen: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshKeyInfo {
    pub fingerprint: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub comment: String,
    pub public_key: String,
    pub user: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshConfigInfo {
    pub port: i64,
    pub permit_root_login: String,
    pub password_authentication: bool,
    pub pubkey_authentication: bool,
    pub max_auth_tries: i64,
    pub allow_users: Vec<String>,
    pub allow_groups: Vec<String>,
    pub x11_forwarding: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub user: String,
    pub from_ip: String,
    pub tty: String,
    pub pid: i64,
    pub started_at: String,
    pub idle_seconds: i64,
}

/* ------------------------------ backups ------------------------------ */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupSnapshotInfo {
    pub id: String,
    pub taken_at: String,
    pub bytes: i64,
    pub file_count: i64,
    pub paths: Vec<String>,
    pub tags: Vec<String>,
    pub verified: bool,
}

/* ------------------------------- sites ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SiteInfo {
    pub name: String,
    pub webroot: String,
    pub server_names: Vec<String>,
    pub runtime: String,
    pub runtime_version: Option<String>,
    pub enabled: bool,
    pub config_path: String,
}

/* ---------------------------- certificates --------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CertificateInfo {
    pub subject: String,
    pub sans: Vec<String>,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub path: String,
    pub key_type: String,
}

/* ================================================================== *
 * Method parameters and results.
 * ================================================================== */

/// The `{ ok: true }` result shared by mutations with nothing to report
/// back. `Default` yields the only legal value, so `OkResult::default()`
/// and [`OK`] are interchangeable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkResult {
    pub ok: bool,
}

impl Default for OkResult {
    fn default() -> Self {
        OK
    }
}

/// The only legal value of the OK result.
pub const OK: OkResult = OkResult { ok: true };

/* ------------------------------- system ------------------------------ */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SystemRebootParams {
    pub delay_seconds: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PackagesListParams {
    pub upgradable_only: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackagesListResult {
    pub packages: Vec<PackageInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PackagesUpgradeParams {
    pub names: Vec<String>,
    pub security_only: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackagesUpgradeResult {
    pub upgraded: Vec<String>,
    pub reboot_required: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SelfUpdateParams {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// Answered by the process that is about to be replaced, which is why
/// `restarting` is the strongest claim it makes. Whether the new build
/// actually came back is something only the control plane can observe, and
/// it does: reconnecting at the new version is what counts as success.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SelfUpdateResult {
    pub previous_version: String,
    pub version: String,
    pub restarting: bool,
    pub previous_binary_path: String,
}

/* ------------------------------ services ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServiceListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServiceListResult {
    pub services: Vec<ServiceInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UnitParams {
    pub unit: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServiceLogsParams {
    pub unit: String,
    pub lines: i64,
    pub follow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// The settled result of every log-streaming method: the chunks carry the
/// live lines, this carries what was already there.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogRecordsResult {
    pub records: Vec<LogRecord>,
}

/* ----------------------------- processes ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProcessListParams {
    pub sort: String,
    pub limit: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProcessListResult {
    pub processes: Vec<ProcessInfo>,
    pub total: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProcessTreeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProcessTreeResult {
    pub processes: Vec<ProcessNode>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SignalParams {
    pub pid: i64,
    pub signal: String,
}

/* ----------------------------- containers ---------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerListParams {
    pub all: bool,
    pub with_stats: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerListResult {
    pub containers: Vec<ContainerInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerIdParams {
    pub id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerInspectResult {
    pub container: ContainerInfo,
    /// The runtime's own inspect document, passed through untouched.
    pub raw: serde_json::Value,
}

/// Shared by container.stop and container.restart, which take the same
/// shape.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerStopParams {
    pub id: String,
    pub timeout_seconds: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerRemoveParams {
    pub id: String,
    pub force: bool,
    pub remove_volumes: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerLogsParams {
    pub id: String,
    pub lines: i64,
    pub follow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerExecParams {
    pub id: String,
    pub cols: i64,
    pub rows: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ImageListResult {
    pub images: Vec<ImageInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContainerPruneParams {
    pub include_images: bool,
    pub include_volumes: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContainerPruneResult {
    pub reclaimed_bytes: i64,
    pub removed: Vec<String>,
}

/* ------------------------------- files ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsListParams {
    pub path: String,
    pub show_hidden: bool,
    pub limit: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsStatParams {
    pub path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsReadParams {
    pub path: String,
    pub max_bytes: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FsReadResult {
    pub content: String,
    pub encoding: String,
    pub truncated: bool,
    pub size: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsWriteParams {
    pub path: String,
    pub content: String,
    pub encoding: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub create_parents: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsMkdirParams {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub parents: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsMoveParams {
    #[serde(rename = "from")]
    pub from: String,
    #[serde(rename = "to")]
    pub to: String,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsCopyParams {
    #[serde(rename = "from")]
    pub from: String,
    #[serde(rename = "to")]
    pub to: String,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsRemoveParams {
    pub paths: Vec<String>,
    pub recursive: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FsRemoveResult {
    pub removed: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsChmodParams {
    pub paths: Vec<String>,
    pub mode: String,
    pub recursive: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsChownParams {
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub recursive: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsArchiveParams {
    pub paths: Vec<String>,
    pub destination: String,
    pub format: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsExtractParams {
    pub path: String,
    pub destination: String,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FsExtractResult {
    pub extracted: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsDownloadParams {
    pub path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FsDownloadResult {
    pub size: i64,
    pub mime: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsUploadParams {
    pub path: String,
    pub size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FsUsageParams {
    pub path: String,
    pub depth: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FsUsageResult {
    pub entries: Vec<StorageUsageEntry>,
    pub total: i64,
}

/* ------------------------------- sites ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SiteListResult {
    pub sites: Vec<SiteInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteCreateParams {
    pub name: String,
    pub server_names: Vec<String>,
    pub webroot: String,
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub force_https: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteUpdateParams {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub server_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webroot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_https: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SiteConfigResult {
    pub config_path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteRemoveParams {
    pub name: String,
    pub delete_webroot: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SiteTestConfigResult {
    pub valid: bool,
    pub output: String,
}

/* ---------------------------- certificates --------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CertListResult {
    pub certificates: Vec<CertificateInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CertIssueParams {
    pub domains: Vec<String>,
    pub challenge: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webroot: Option<String>,
    pub key_type: String,
    pub staging: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CertIssueResult {
    pub subject: String,
    pub sans: Vec<String>,
    pub not_after: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CertRenewParams {
    pub subject: String,
    pub force: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CertRenewResult {
    pub not_after: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CertRevokeParams {
    pub subject: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CertInstallParams {
    pub subject: String,
    pub certificate_pem: String,
    pub key_pem: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_pem: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CertInstallResult {
    pub path: String,
}

/* -------------------------------- dns -------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DnsResolveParams {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolver: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DnsResolveResult {
    pub records: Vec<ResolvedRecord>,
}

/* -------------------------------- mail ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailPreflightParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
}

/// The outbound relay `mail.deploy` configures when `sending` is "relay".
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MailRelayParams {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Handed to the installer through an environment variable, never argv.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

impl Default for MailRelayParams {
    fn default() -> Self {
        Self {
            provider: String::new(),
            host: None,
            region: None,
            port: 587,
            username: None,
            password: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MailDeployParams {
    /// Release to install; the agent verifies the archive's sha256 before
    /// anything runs.
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub domain: String,
    pub hostname: String,
    /// An address on another provider, for certificates and alerts.
    pub admin_email: String,
    pub first_mailbox: String,
    /// "direct" | "relay"
    pub sending: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay: Option<MailRelayParams>,
    /// Continue past blocking preflight failures.
    pub force: bool,
    pub skip_ptr: bool,
}

impl Default for MailDeployParams {
    fn default() -> Self {
        Self {
            version: String::new(),
            url: String::new(),
            sha256: String::new(),
            domain: String::new(),
            hostname: String::new(),
            admin_email: String::new(),
            first_mailbox: "hello".to_string(),
            sending: "direct".to_string(),
            relay: None,
            force: false,
            skip_ptr: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailDomainParams {
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailboxAddParams {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Omit for unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_mb: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailAddressParams {
    pub address: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailAliasAddParams {
    pub alias: String,
    pub mailbox: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailAliasRemoveParams {
    pub alias: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MailLogsParams {
    pub lines: i64,
    pub follow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// A generated mailbox password, returned once and never stored.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailPasswordResult {
    pub password: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailDomainDnsResult {
    pub records: Vec<MailDnsRecord>,
    pub zone_file: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailCertificateRenewResult {
    pub outcome: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailCheckListResult {
    pub checks: Vec<MailCheck>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailDomainListResult {
    pub domains: Vec<MailDomainEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailboxListResult {
    pub mailboxes: Vec<MailboxEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailAliasListResult {
    pub aliases: Vec<MailAliasEntry>,
}

/* ------------------------------ databases ---------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbInstanceListResult {
    pub instances: Vec<DbInstanceInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbEngineParams {
    pub engine: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbDatabaseListResult {
    pub databases: Vec<DbDatabaseInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbDatabaseCreateParams {
    pub engine: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbDatabaseDeleteParams {
    pub engine: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbUserListResult {
    pub users: Vec<DbUserInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbUserCreateParams {
    pub engine: String,
    pub username: String,
    pub password: String,
    pub host_pattern: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbUserUpdateParams {
    pub engine: String,
    pub username: String,
    pub host_pattern: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_login: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbUserDeleteParams {
    pub engine: String,
    pub username: String,
    pub host_pattern: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbGrantApplyParams {
    pub engine: String,
    pub database: String,
    pub username: String,
    pub host_pattern: String,
    pub privileges: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbSizeParams {
    pub engine: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbSizeResult {
    pub size_bytes: i64,
    pub table_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbDumpParams {
    pub engine: String,
    pub name: String,
    pub destination: String,
    pub compress: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbDumpResult {
    pub path: String,
    pub size_bytes: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DbRestoreParams {
    pub engine: String,
    pub name: String,
    pub source: String,
    pub drop_existing: bool,
}

/* ------------------------------ firewall ----------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FirewallStatus {
    pub backend: String,
    pub enabled: bool,
    pub default_inbound: String,
    pub default_outbound: String,
    pub rule_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FwListResult {
    pub rules: Vec<FirewallRuleInfo>,
}

/// A desired rule, as `fw.apply` receives it: FirewallRuleInfo without the
/// host-assigned id, backend and enabled flag.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FirewallRule {
    pub priority: i64,
    pub action: String,
    pub direction: String,
    pub protocol: String,
    pub port_spec: Option<String>,
    pub source: Option<String>,
    pub destination: Option<String>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FwApplyParams {
    pub default_inbound: String,
    pub default_outbound: String,
    pub rules: Vec<FirewallRule>,
    pub rollback_seconds: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FwApplyResult {
    pub applied: i64,
    pub rollback_token: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FwConfirmParams {
    pub rollback_token: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FwBanParams {
    pub target: String,
    pub duration_seconds: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FwUnbanParams {
    pub target: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FwBansResult {
    pub bans: Vec<BanEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FwThreatsParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub limit: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FwThreatsResult {
    pub observations: Vec<ThreatObservation>,
}

/* -------------------------------- ssh -------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SshKeysListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshKeysListResult {
    pub keys: Vec<SshKeyInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SshAuthorizedKey {
    pub public_key: String,
    pub comment: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SshKeysApplyParams {
    pub user: String,
    pub keys: Vec<SshAuthorizedKey>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshKeysApplyResult {
    pub applied: i64,
}

/// `sshConfigInfo.partial()`: every field is optional, so an unset one
/// means "leave this directive alone".
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SshConfigApplyParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permit_root_login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_authentication: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey_authentication: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_auth_tries: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow_users: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow_groups: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x11_forwarding: Option<bool>,
    pub rollback_seconds: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshConfigApplyResult {
    pub rollback_token: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SshSessionsResult {
    pub sessions: Vec<SshSessionInfo>,
}

/* ------------------------------ backups ------------------------------ */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupDatabase {
    pub engine: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupRunParams {
    pub repository: String,
    pub password_ref: String,
    pub paths: Vec<String>,
    pub exclude: Vec<String>,
    pub tags: Vec<String>,
    pub databases: Vec<BackupDatabase>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupListParams {
    pub repository: String,
    pub password_ref: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupListResult {
    pub snapshots: Vec<BackupSnapshotInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupRestoreParams {
    pub repository: String,
    pub password_ref: String,
    pub snapshot_id: String,
    pub target: String,
    pub include: Vec<String>,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub restored_files: i64,
    pub bytes: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupVerifyParams {
    pub repository: String,
    pub password_ref: String,
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupVerifyResult {
    pub ok: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupPruneParams {
    pub repository: String,
    pub password_ref: String,
    pub keep_last: i64,
    pub keep_daily: i64,
    pub keep_weekly: i64,
    pub keep_monthly: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupPruneResult {
    pub removed: i64,
    pub reclaimed_bytes: i64,
}

/* -------------------------------- logs ------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LogSourcesResult {
    pub sources: Vec<LogSource>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LogTailParams {
    pub source: String,
    pub lines: i64,
    pub follow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/* -------------------------------- pty -------------------------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PtyOpenParams {
    pub cols: i64,
    pub rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub term: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PtyResizeParams {
    pub cols: i64,
    pub rows: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PtyOpenResult {
    pub pid: i64,
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn keys(v: &Value) -> Vec<String> {
        v.as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect()
    }

    #[test]
    fn metrics_sample_omits_absent_optional_fields() {
        let sample = MetricsSample {
            ts: "2026-01-01T00:00:00Z".into(),
            cpu_percent: 1.5,
            disks: vec![],
            ..Default::default()
        };
        let v = serde_json::to_value(&sample).unwrap();
        let k = keys(&v);
        for absent in ["cpu_per_core", "memory_cached", "disk_read_rate", "disk_write_rate"] {
            assert!(!k.iter().any(|x| x == absent), "{absent} should be omitted");
        }
        for present in ["ts", "cpu_percent", "disks", "memory_used", "load15", "net_tx_rate"] {
            assert!(k.iter().any(|x| x == present), "{present} should be present");
        }

        // And present when set.
        let sample = MetricsSample {
            cpu_per_core: vec![1.0, 2.0],
            memory_cached: Some(42),
            ..Default::default()
        };
        let v = serde_json::to_value(&sample).unwrap();
        assert_eq!(v["cpu_per_core"], json!([1.0, 2.0]));
        assert_eq!(v["memory_cached"], json!(42));

        // Round trip of the minimal form decodes.
        let back: MetricsSample = serde_json::from_value(v).unwrap();
        assert_eq!(back.memory_cached, Some(42));
    }

    #[test]
    fn ok_result_default_is_ok_true() {
        assert_eq!(serde_json::to_string(&OkResult::default()).unwrap(), r#"{"ok":true}"#);
        assert_eq!(serde_json::to_string(&OK).unwrap(), r#"{"ok":true}"#);
        assert_eq!(OkResult::default(), OK);
    }

    #[test]
    fn file_entry_field_names_match_go_tags() {
        let v = serde_json::to_value(FileEntry::default()).unwrap();
        let k = keys(&v);
        for name in [
            "name", "path", "kind", "size", "mode", "owner", "group", "uid", "gid", "modified_at",
            "link_target", "child_count", "mime", "is_editable",
        ] {
            assert!(k.iter().any(|x| x == name), "missing key {name}");
        }
        assert_eq!(k.len(), 14);
        // Nullable pointers serialize as null, not absent.
        assert_eq!(v["link_target"], Value::Null);
        assert_eq!(v["child_count"], Value::Null);
    }

    #[test]
    fn type_fields_rename_to_type() {
        let r = ResolvedRecord { r#type: "MX".into(), ..Default::default() };
        assert_eq!(serde_json::to_value(&r).unwrap()["type"], json!("MX"));
        let d = MailDnsRecord { rtype: "TXT".into(), ..Default::default() };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["type"], json!("TXT"));
        assert_eq!(v["expected"], Value::Null);
        let k = SshKeyInfo { r#type: "ssh-ed25519".into(), ..Default::default() };
        assert_eq!(serde_json::to_value(&k).unwrap()["type"], json!("ssh-ed25519"));
        let p: DnsResolveParams = serde_json::from_value(json!({"name": "a", "type": "A"})).unwrap();
        assert_eq!(p.r#type, "A");
        assert_eq!(p.resolver, None);
        let s: LogSource = serde_json::from_value(json!({
            "id": "x", "label": "x", "kind": "journal", "ref": "sshd", "size": null, "supports_follow": true
        }))
        .unwrap();
        assert_eq!(s.r#ref, "sshd");
    }

    #[test]
    fn process_node_flattens() {
        let n = ProcessNode {
            process: ProcessInfo { pid: 7, ..Default::default() },
            depth: 2,
        };
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["pid"], json!(7));
        assert_eq!(v["depth"], json!(2));
        assert!(v.get("process").is_none());
    }

    #[test]
    fn params_decode_with_missing_fields() {
        let p: MailDeployParams = serde_json::from_value(json!({
            "version": "1.2.3", "url": "https://x", "sha256": "ab", "domain": "d", "hostname": "h",
            "admin_email": "a@b"
        }))
        .unwrap();
        assert_eq!(p.first_mailbox, "hello");
        assert_eq!(p.sending, "direct");
        assert!(p.relay.is_none());
        assert!(!p.force);

        let r: MailRelayParams = serde_json::from_value(json!({"provider": "ses"})).unwrap();
        assert_eq!(r.port, 587);

        let p: FsMoveParams = serde_json::from_value(json!({"from": "/a", "to": "/b"})).unwrap();
        assert_eq!(p.from, "/a");
        assert!(!p.overwrite);

        let p: SshConfigApplyParams = serde_json::from_value(json!({"port": 2222})).unwrap();
        assert_eq!(p.port, Some(2222));
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(keys(&v), vec!["port", "rollback_seconds"]);

        let p: ServiceListParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(serde_json::to_string(&p).unwrap(), "{}");
    }

    #[test]
    fn mail_check_status_round_trips_and_ranks() {
        assert_eq!(serde_json::to_string(&MailCheckStatus::Pass).unwrap(), r#""pass""#);
        let s: MailCheckStatus = serde_json::from_str(r#""fail""#).unwrap();
        assert_eq!(s, MailCheckStatus::Fail);
        assert_eq!(MailCheckStatus::default(), MailCheckStatus::Unknown);

        assert_eq!(MailCheckStatus::from_tag("ok"), MailCheckStatus::Pass);
        assert_eq!(MailCheckStatus::from_tag("[warn]"), MailCheckStatus::Warn);
        assert_eq!(MailCheckStatus::from_tag("problem"), MailCheckStatus::Fail);
        assert_eq!(MailCheckStatus::from_tag("info"), MailCheckStatus::Info);
        assert_eq!(MailCheckStatus::from_tag("?"), MailCheckStatus::Unknown);
        assert_eq!(MailCheckStatus::from_tag("gibberish"), MailCheckStatus::Unknown);

        use MailCheckStatus::*;
        assert_eq!(MailCheckStatus::worst(Pass, Info), Info);
        assert_eq!(MailCheckStatus::worst(Info, Unknown), Unknown);
        assert_eq!(MailCheckStatus::worst(Unknown, Warn), Warn);
        assert_eq!(MailCheckStatus::worst(Warn, Fail), Fail);
        assert_eq!(MailCheckStatus::worst(Fail, Pass), Fail);

        // Nullable remedy/help_url are null, never absent.
        let c = MailCheck { id: "dns".into(), ..Default::default() };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["remedy"], Value::Null);
        assert_eq!(v["help_url"], Value::Null);
        assert_eq!(v["status"], json!("unknown"));

        let d = MailDeployResult::default();
        assert_eq!(serde_json::to_value(&d).unwrap()["outcome"], json!("failed"));
        let st = MailInstallStep::default();
        assert_eq!(serde_json::to_value(&st).unwrap()["status"], json!("pending"));
    }

    #[test]
    fn container_inspect_raw_passes_through() {
        let r = ContainerInspectResult {
            container: ContainerInfo::default(),
            raw: json!({"Id": "abc", "Nested": {"x": [1, 2]}}),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["raw"]["Nested"]["x"], json!([1, 2]));
        assert_eq!(v["container"]["labels"], json!({}));
        let rec = LogRecord::default();
        let v = serde_json::to_value(&rec).unwrap();
        assert!(v.get("fields").is_none());
        assert!(v.get("cursor").is_none());
    }
}
