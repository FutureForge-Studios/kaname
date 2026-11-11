//! Method wiring.
//!
//! One entry per verb in the contract's registry, each decoding a typed
//! parameter struct and calling exactly one provider method. Nothing here
//! builds a command line, and every path argument is re-validated against
//! the host before it is used: the control plane already checked it, but a
//! compromised control plane must not be able to walk the agent out of
//! bounds or at the agent's own private key.
//!
//! The namespaces live one per file; this module holds the shared plumbing
//! (decoding, result encoding, validation) and `register_handlers`.

pub mod pathguard;

mod app_backup;
mod backups;
mod certs;
mod containers;
mod databases;
mod dns;
mod files;
mod firewall;
mod ftp;
mod logs;
mod mail;
mod processes;
mod pty;
mod services;
mod sites;
mod ssh;
mod system;

use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::providers::{Ctx, ProviderRef, StreamRef, cap};
use crate::registry::{Method, Registry, Request, StreamMode};
use crate::wire::{ErrorCode, WireError};

use pathguard::PathGuard;

/// Capability requirements, mirroring the contract's `requires` lists.
pub(crate) const NO_CAPS: &[&str] = &[];
pub(crate) const NEEDS_SYSTEMD: &[&str] = &[cap::SYSTEMD];
pub(crate) const NEEDS_DOCKER: &[&str] = &[cap::DOCKER];
pub(crate) const NEEDS_NGINX: &[&str] = &[cap::NGINX];
pub(crate) const NEEDS_MAIL: &[&str] = &[cap::YUNORI];

/// What every handler closure receives alongside the call.
pub(crate) struct Handlers {
    pub provider: ProviderRef,
    pub paths: PathGuard,
    /// The contract's pty.resize and pty.close carry no session id, so
    /// they address the session opened most recently on this connection.
    pty_session: Mutex<Option<String>>,
}

impl Handlers {
    pub(crate) fn set_pty_session(&self, id: &str) {
        *self.pty_session.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_string());
    }

    pub(crate) fn clear_pty_session(&self, id: &str) {
        let mut current = self.pty_session.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_deref() == Some(id) {
            *current = None;
        }
    }

    pub(crate) fn current_pty_session(&self) -> Result<String, WireError> {
        self.pty_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| WireError::new(ErrorCode::NotFound, "no terminal session is open"))
    }
}

/// Wires the whole method registry to a provider. `guarded_dirs` are
/// directories no file verb may reach: the agent's own state directory,
/// which holds the enrolled private key.
pub fn register_handlers(registry: &mut Registry, provider: ProviderRef, guarded_dirs: &[&Path]) {
    let h = Arc::new(Handlers {
        provider,
        paths: PathGuard::new(guarded_dirs),
        pty_session: Mutex::new(None),
    });

    system::register(registry, &h);
    services::register(registry, &h);
    processes::register(registry, &h);
    containers::register(registry, &h);
    files::register(registry, &h);
    sites::register(registry, &h);
    certs::register(registry, &h);
    dns::register(registry, &h);
    mail::register(registry, &h);
    databases::register(registry, &h);
    firewall::register(registry, &h);
    ssh::register(registry, &h);
    ftp::register(registry, &h);
    backups::register(registry, &h);
    app_backup::register(registry, &h);
    logs::register(registry, &h);
    pty::register(registry, &h);
}

/* ------------------------------ plumbing ----------------------------- */

pub(crate) type HResult = Result<Value, WireError>;

/// Builds a registry entry from an async closure that receives the shared
/// handler state, the call context and the request.
pub(crate) fn method<F, Fut>(
    name: &'static str,
    mode: StreamMode,
    requires: &'static [&'static str],
    h: &Arc<Handlers>,
    f: F,
) -> Method
where
    F: Fn(Arc<Handlers>, Ctx, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = HResult> + Send + 'static,
{
    let h = h.clone();
    Method {
        name,
        mode,
        requires,
        handler: Arc::new(move |ctx, req| Box::pin(f(h.clone(), ctx, req))),
    }
}

/// Serializes a handler's result for the response frame.
pub(crate) fn reply<T: Serialize>(value: T) -> HResult {
    serde_json::to_value(value)
        .map_err(|e| WireError::new(ErrorCode::Internal, format!("encode result: {e}")))
}

/// Decodes the request's params. Absent or `null` params decode to the
/// type's default; a malformed document is an `invalid_params` naming the
/// method.
pub(crate) fn decode<T: DeserializeOwned + Default>(req: &Request) -> Result<T, WireError> {
    match &req.params {
        None | Some(Value::Null) => Ok(T::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| invalid(format!("{}: {}", req.method, e))),
    }
}

pub(crate) fn require_stream(req: &Request) -> Result<StreamRef, WireError> {
    req.stream.clone().ok_or_else(|| {
        WireError::new(
            ErrorCode::Internal,
            format!("{} is a streaming method but no stream was opened", req.method),
        )
    })
}

pub(crate) fn invalid(message: impl Into<String>) -> WireError {
    WireError::invalid(message)
}

/// A Go-style "present" test for optional strings: an empty string is as
/// good as absent.
pub(crate) fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

/* ----------------------------- validation ---------------------------- */

/// A value the contract treats as unset, so that the handler's default
/// applies: a non-positive count or an empty string.
pub(crate) trait Unset {
    fn is_unset(&self) -> bool;
}

impl Unset for i64 {
    fn is_unset(&self) -> bool {
        *self <= 0
    }
}

impl Unset for String {
    fn is_unset(&self) -> bool {
        self.is_empty()
    }
}

pub(crate) fn or_default<T: Unset, F: Into<T>>(value: T, fallback: F) -> T {
    if value.is_unset() { fallback.into() } else { value }
}

pub(crate) fn check_enum(field: &str, value: &str, allowed: &[&str]) -> Result<(), WireError> {
    if allowed.contains(&value) {
        return Ok(());
    }
    Err(invalid(format!("{field} must be one of {}", allowed.join(", "))))
}

pub(crate) fn check_engine(engine: &str) -> Result<(), WireError> {
    check_enum("engine", engine, &["mysql", "mariadb", "postgres"])
}

/// Mirrors the contract's `identifier`: a POSIX user, group or database
/// name, never anything a shell would look at twice.
pub(crate) fn check_identifier(field: &str, value: &str) -> Result<(), WireError> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return Err(invalid(format!("{field} must be between 1 and 63 characters")));
    }
    let first = bytes[0];
    if !(first == b'_' || first.is_ascii_alphabetic()) {
        return Err(invalid(format!("{field} must start with a letter or underscore")));
    }
    if !bytes
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
    {
        return Err(invalid(format!("{field} contains an illegal character")));
    }
    Ok(())
}

/// An octal mode string like `0644`; empty means "not given".
pub(crate) fn check_mode(mode: &str) -> Result<(), WireError> {
    if mode.is_empty() {
        return Ok(());
    }
    if !(3..=4).contains(&mode.len()) || !mode.bytes().all(|c| (b'0'..=b'7').contains(&c)) {
        return Err(invalid("mode must be an octal string like 0644"));
    }
    Ok(())
}

pub(crate) fn check_unit(unit: &str) -> Result<(), WireError> {
    if unit.is_empty() || unit.len() > 256 {
        return Err(invalid("unit must be between 1 and 256 characters"));
    }
    if unit
        .chars()
        .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '/' | '\0'))
    {
        return Err(invalid("unit contains an illegal character"));
    }
    Ok(())
}

pub(crate) fn check_container_id(id: &str) -> Result<(), WireError> {
    if id.is_empty() || id.len() > 128 {
        return Err(invalid("id must be between 1 and 128 characters"));
    }
    if !id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'/'))
    {
        return Err(invalid("id contains an illegal character"));
    }
    Ok(())
}

/// A mail address: something before and after one `@`, no whitespace.
pub(crate) fn check_address(address: &str) -> Result<(), WireError> {
    check_email("address", address)
}

pub(crate) fn check_email(field: &str, address: &str) -> Result<(), WireError> {
    let at = address.find('@');
    match at {
        Some(at) if at > 0 && at < address.len() - 1 && address.len() <= 320 => {}
        _ => return Err(invalid(format!("{field} must be a valid email address"))),
    }
    if address
        .chars()
        .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\0'))
    {
        return Err(invalid(format!("{field} contains an illegal character")));
    }
    Ok(())
}

/// An IP address or CIDR range, as fail2ban and the firewall accept it.
pub(crate) fn check_target(target: &str) -> Result<(), WireError> {
    let ok = !target.is_empty()
        && target.len() <= 64
        && target
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, b'.' | b':' | b'/'));
    if !ok {
        return Err(invalid("target must be an address or CIDR range"));
    }
    Ok(())
}

pub(crate) fn check_repository(repository: &str, password_ref: &str) -> Result<(), WireError> {
    if repository.is_empty() {
        return Err(invalid("repository is required"));
    }
    if password_ref.is_empty() {
        return Err(invalid("password_ref is required"));
    }
    Ok(())
}

pub(crate) fn check_dimensions(cols: i64, rows: i64) -> Result<(), WireError> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(invalid("cols and rows must be between 1 and 1000"));
    }
    Ok(())
}

/* -------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde::Deserialize;
    use serde_json::json;
    use tokio::sync::{Mutex as AsyncMutex, mpsc};

    use super::*;
    use crate::providers::{self as p, Ctx, Event, PResult, ProviderError, StreamRef};
    use crate::registry::{CapabilityGate, Registry, Request, StreamMode};
    use crate::wire;

    /* ------------------------ contract manifest ----------------------- */

    /// methods.json is emitted from packages/contract by
    /// `pnpm --filter @kaname/contract emit:agent-manifest`. Embedding it
    /// and asserting against the live registry turns "a method was renamed
    /// on one side" from a silent runtime failure into a failing build.
    const MANIFEST_JSON: &str = include_str!("../../methods.json");

    #[derive(Deserialize)]
    struct ManifestMethod {
        name: String,
        stream: String,
        #[serde(default)]
        requires: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Limits {
        stream_window: u64,
        max_chunk_bytes: usize,
        ping_interval_ms: u64,
        ping_timeout_multiplier: u32,
    }

    #[derive(Deserialize)]
    struct Manifest {
        protocol: u32,
        subprotocol: String,
        limits: Limits,
        methods: Vec<ManifestMethod>,
    }

    fn load_manifest() -> Manifest {
        let m: Manifest = serde_json::from_str(MANIFEST_JSON).expect("methods.json is not valid JSON");
        assert!(
            !m.methods.is_empty(),
            "methods.json declares no methods; run the emit:agent-manifest script"
        );
        m
    }

    fn mode_name(mode: StreamMode) -> &'static str {
        match mode {
            StreamMode::None => "none",
            StreamMode::Response => "response",
            StreamMode::Bidirectional => "bidirectional",
        }
    }

    /* -------------------------- null provider ------------------------- */

    /// A provider that satisfies every trait by refusing every call. The
    /// conformance tests only need the registry's shape, and the handler
    /// tests only need to see validation fail before the provider is
    /// reached.
    struct NullProvider;

    fn unsupported<T>() -> PResult<T> {
        Err(ProviderError::unsupported())
    }

    #[async_trait]
    impl p::System for NullProvider {
        async fn info(&self, _: &Ctx) -> PResult<p::SystemInfo> {
            unsupported()
        }
        async fn metrics(&self, _: &Ctx) -> PResult<p::MetricsSample> {
            unsupported()
        }
        async fn reboot(&self, _: &Ctx, _: p::SystemRebootParams) -> PResult<()> {
            unsupported()
        }
        async fn list_packages(&self, _: &Ctx, _: p::PackagesListParams) -> PResult<Vec<p::PackageInfo>> {
            unsupported()
        }
        async fn upgrade_packages(
            &self,
            _: &Ctx,
            _: p::PackagesUpgradeParams,
            _: StreamRef,
        ) -> PResult<p::PackagesUpgradeResult> {
            unsupported()
        }
        async fn self_update(
            &self,
            _: &Ctx,
            _: p::SelfUpdateParams,
            _: StreamRef,
        ) -> PResult<p::SelfUpdateResult> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Services for NullProvider {
        async fn list(&self, _: &Ctx, _: p::ServiceListParams) -> PResult<Vec<p::ServiceInfo>> {
            unsupported()
        }
        async fn status(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn start(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn stop(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn restart(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn reload(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn enable(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn disable(&self, _: &Ctx, _: &str) -> PResult<p::ServiceInfo> {
            unsupported()
        }
        async fn logs(&self, _: &Ctx, _: p::ServiceLogsParams, _: StreamRef) -> PResult<Vec<p::LogRecord>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Processes for NullProvider {
        async fn list(&self, _: &Ctx, _: p::ProcessListParams) -> PResult<p::ProcessListResult> {
            unsupported()
        }
        async fn tree(&self, _: &Ctx, _: p::ProcessTreeParams) -> PResult<Vec<p::ProcessNode>> {
            unsupported()
        }
        async fn signal(&self, _: &Ctx, _: p::SignalParams) -> PResult<()> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Containers for NullProvider {
        async fn list(&self, _: &Ctx, _: p::ContainerListParams) -> PResult<Vec<p::ContainerInfo>> {
            unsupported()
        }
        async fn inspect(&self, _: &Ctx, _: &str) -> PResult<p::ContainerInspectResult> {
            unsupported()
        }
        async fn start(&self, _: &Ctx, _: &str) -> PResult<p::ContainerInfo> {
            unsupported()
        }
        async fn stop(&self, _: &Ctx, _: p::ContainerStopParams) -> PResult<p::ContainerInfo> {
            unsupported()
        }
        async fn restart(&self, _: &Ctx, _: p::ContainerStopParams) -> PResult<p::ContainerInfo> {
            unsupported()
        }
        async fn remove(&self, _: &Ctx, _: p::ContainerRemoveParams) -> PResult<()> {
            unsupported()
        }
        async fn logs(&self, _: &Ctx, _: p::ContainerLogsParams, _: StreamRef) -> PResult<Vec<p::LogRecord>> {
            unsupported()
        }
        async fn exec(&self, _: &Ctx, _: p::ContainerExecParams, _: StreamRef) -> PResult<()> {
            unsupported()
        }
        async fn images(&self, _: &Ctx) -> PResult<Vec<p::ImageInfo>> {
            unsupported()
        }
        async fn prune(&self, _: &Ctx, _: p::ContainerPruneParams) -> PResult<p::ContainerPruneResult> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Files for NullProvider {
        async fn list(&self, _: &Ctx, _: p::FsListParams) -> PResult<p::DirectoryListing> {
            unsupported()
        }
        async fn stat(&self, _: &Ctx, _: &str) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn read(&self, _: &Ctx, _: p::FsReadParams) -> PResult<p::FsReadResult> {
            unsupported()
        }
        async fn write(&self, _: &Ctx, _: p::FsWriteParams) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn mkdir(&self, _: &Ctx, _: p::FsMkdirParams) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn r#move(&self, _: &Ctx, _: p::FsMoveParams) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn copy(&self, _: &Ctx, _: p::FsCopyParams) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn remove(&self, _: &Ctx, _: p::FsRemoveParams) -> PResult<i64> {
            unsupported()
        }
        async fn chmod(&self, _: &Ctx, _: p::FsChmodParams) -> PResult<()> {
            unsupported()
        }
        async fn chown(&self, _: &Ctx, _: p::FsChownParams) -> PResult<()> {
            unsupported()
        }
        async fn archive(&self, _: &Ctx, _: p::FsArchiveParams, _: StreamRef) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn extract(&self, _: &Ctx, _: p::FsExtractParams, _: StreamRef) -> PResult<i64> {
            unsupported()
        }
        async fn download(
            &self,
            _: &Ctx,
            _: p::FsDownloadParams,
            _: StreamRef,
        ) -> PResult<p::FsDownloadResult> {
            unsupported()
        }
        async fn upload(&self, _: &Ctx, _: p::FsUploadParams, _: StreamRef) -> PResult<p::FileEntry> {
            unsupported()
        }
        async fn usage(&self, _: &Ctx, _: p::FsUsageParams) -> PResult<p::FsUsageResult> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Logs for NullProvider {
        async fn sources(&self, _: &Ctx) -> PResult<Vec<p::LogSource>> {
            unsupported()
        }
        async fn tail(&self, _: &Ctx, _: p::LogTailParams, _: StreamRef) -> PResult<Vec<p::LogRecord>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Certs for NullProvider {
        async fn list(&self, _: &Ctx) -> PResult<Vec<p::CertificateInfo>> {
            unsupported()
        }
        async fn issue(&self, _: &Ctx, _: p::CertIssueParams, _: StreamRef) -> PResult<p::CertIssueResult> {
            unsupported()
        }
        async fn renew(&self, _: &Ctx, _: p::CertRenewParams, _: StreamRef) -> PResult<p::CertRenewResult> {
            unsupported()
        }
        async fn revoke(&self, _: &Ctx, _: p::CertRevokeParams) -> PResult<()> {
            unsupported()
        }
        async fn install(&self, _: &Ctx, _: p::CertInstallParams) -> PResult<p::CertInstallResult> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Sites for NullProvider {
        async fn list(&self, _: &Ctx) -> PResult<Vec<p::SiteInfo>> {
            unsupported()
        }
        async fn create(&self, _: &Ctx, _: p::SiteCreateParams) -> PResult<p::SiteConfigResult> {
            unsupported()
        }
        async fn update(&self, _: &Ctx, _: p::SiteUpdateParams) -> PResult<p::SiteConfigResult> {
            unsupported()
        }
        async fn remove(&self, _: &Ctx, _: p::SiteRemoveParams) -> PResult<()> {
            unsupported()
        }
        async fn test_config(&self, _: &Ctx) -> PResult<p::SiteTestConfigResult> {
            unsupported()
        }
        async fn reload(&self, _: &Ctx) -> PResult<()> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Dns for NullProvider {
        async fn resolve(&self, _: &Ctx, _: p::DnsResolveParams) -> PResult<Vec<p::ResolvedRecord>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Mail for NullProvider {
        async fn status(&self, _: &Ctx) -> PResult<p::MailServerStatusInfo> {
            unsupported()
        }
        async fn preflight(&self, _: &Ctx, _: p::MailPreflightParams) -> PResult<Vec<p::MailCheck>> {
            unsupported()
        }
        async fn doctor(&self, _: &Ctx) -> PResult<Vec<p::MailCheck>> {
            unsupported()
        }
        async fn deploy(
            &self,
            _: &Ctx,
            _: p::MailDeployParams,
            _: StreamRef,
        ) -> PResult<p::MailDeployResult> {
            unsupported()
        }
        async fn update(&self, _: &Ctx, _: StreamRef) -> PResult<()> {
            unsupported()
        }
        async fn list_domains(&self, _: &Ctx) -> PResult<Vec<p::MailDomainEntry>> {
            unsupported()
        }
        async fn add_domain(&self, _: &Ctx, _: p::MailDomainParams) -> PResult<()> {
            unsupported()
        }
        async fn remove_domain(&self, _: &Ctx, _: p::MailDomainParams) -> PResult<()> {
            unsupported()
        }
        async fn domain_dns(&self, _: &Ctx, _: p::MailDomainParams) -> PResult<p::MailDomainDnsResult> {
            unsupported()
        }
        async fn list_mailboxes(&self, _: &Ctx, _: p::MailListParams) -> PResult<Vec<p::MailboxEntry>> {
            unsupported()
        }
        async fn add_mailbox(&self, _: &Ctx, _: p::MailboxAddParams) -> PResult<p::MailPasswordResult> {
            unsupported()
        }
        async fn mailbox_password(&self, _: &Ctx, _: p::MailAddressParams) -> PResult<p::MailPasswordResult> {
            unsupported()
        }
        async fn remove_mailbox(&self, _: &Ctx, _: p::MailAddressParams) -> PResult<()> {
            unsupported()
        }
        async fn list_aliases(&self, _: &Ctx, _: p::MailListParams) -> PResult<Vec<p::MailAliasEntry>> {
            unsupported()
        }
        async fn add_alias(&self, _: &Ctx, _: p::MailAliasAddParams) -> PResult<()> {
            unsupported()
        }
        async fn remove_alias(&self, _: &Ctx, _: p::MailAliasRemoveParams) -> PResult<()> {
            unsupported()
        }
        async fn certificate_status(&self, _: &Ctx) -> PResult<p::MailCertificateStatus> {
            unsupported()
        }
        async fn certificate_renew(&self, _: &Ctx, _: StreamRef) -> PResult<p::MailCertificateRenewResult> {
            unsupported()
        }
        async fn logs(&self, _: &Ctx, _: p::MailLogsParams, _: StreamRef) -> PResult<Vec<p::LogRecord>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Databases for NullProvider {
        async fn instances(&self, _: &Ctx) -> PResult<Vec<p::DbInstanceInfo>> {
            unsupported()
        }
        async fn list_databases(&self, _: &Ctx, _: p::DbEngineParams) -> PResult<Vec<p::DbDatabaseInfo>> {
            unsupported()
        }
        async fn create_database(&self, _: &Ctx, _: p::DbDatabaseCreateParams) -> PResult<p::DbDatabaseInfo> {
            unsupported()
        }
        async fn delete_database(&self, _: &Ctx, _: p::DbDatabaseDeleteParams) -> PResult<()> {
            unsupported()
        }
        async fn list_users(&self, _: &Ctx, _: p::DbEngineParams) -> PResult<Vec<p::DbUserInfo>> {
            unsupported()
        }
        async fn create_user(&self, _: &Ctx, _: p::DbUserCreateParams) -> PResult<p::DbUserInfo> {
            unsupported()
        }
        async fn update_user(&self, _: &Ctx, _: p::DbUserUpdateParams) -> PResult<p::DbUserInfo> {
            unsupported()
        }
        async fn delete_user(&self, _: &Ctx, _: p::DbUserDeleteParams) -> PResult<()> {
            unsupported()
        }
        async fn apply_grant(&self, _: &Ctx, _: p::DbGrantApplyParams) -> PResult<()> {
            unsupported()
        }
        async fn size(&self, _: &Ctx, _: p::DbSizeParams) -> PResult<p::DbSizeResult> {
            unsupported()
        }
        async fn dump(&self, _: &Ctx, _: p::DbDumpParams, _: StreamRef) -> PResult<p::DbDumpResult> {
            unsupported()
        }
        async fn restore(&self, _: &Ctx, _: p::DbRestoreParams, _: StreamRef) -> PResult<()> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Firewall for NullProvider {
        async fn status(&self, _: &Ctx) -> PResult<p::FirewallStatus> {
            unsupported()
        }
        async fn list(&self, _: &Ctx) -> PResult<Vec<p::FirewallRuleInfo>> {
            unsupported()
        }
        async fn apply(&self, _: &Ctx, _: p::FwApplyParams) -> PResult<p::FwApplyResult> {
            unsupported()
        }
        async fn confirm(&self, _: &Ctx, _: p::FwConfirmParams) -> PResult<()> {
            unsupported()
        }
        async fn ban(&self, _: &Ctx, _: p::FwBanParams) -> PResult<()> {
            unsupported()
        }
        async fn unban(&self, _: &Ctx, _: p::FwUnbanParams) -> PResult<()> {
            unsupported()
        }
        async fn bans(&self, _: &Ctx) -> PResult<Vec<p::BanEntry>> {
            unsupported()
        }
        async fn threats(&self, _: &Ctx, _: p::FwThreatsParams) -> PResult<Vec<p::ThreatObservation>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Ssh for NullProvider {
        async fn list_keys(&self, _: &Ctx, _: p::SshKeysListParams) -> PResult<Vec<p::SshKeyInfo>> {
            unsupported()
        }
        async fn apply_keys(&self, _: &Ctx, _: p::SshKeysApplyParams) -> PResult<i64> {
            unsupported()
        }
        async fn read_config(&self, _: &Ctx) -> PResult<p::SshConfigInfo> {
            unsupported()
        }
        async fn apply_config(
            &self,
            _: &Ctx,
            _: p::SshConfigApplyParams,
        ) -> PResult<p::SshConfigApplyResult> {
            unsupported()
        }
        async fn sessions(&self, _: &Ctx) -> PResult<Vec<p::SshSessionInfo>> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Backups for NullProvider {
        async fn run(&self, _: &Ctx, _: p::BackupRunParams, _: StreamRef) -> PResult<p::BackupSnapshotInfo> {
            unsupported()
        }
        async fn list(&self, _: &Ctx, _: p::BackupListParams) -> PResult<Vec<p::BackupSnapshotInfo>> {
            unsupported()
        }
        async fn restore(
            &self,
            _: &Ctx,
            _: p::BackupRestoreParams,
            _: StreamRef,
        ) -> PResult<p::BackupRestoreResult> {
            unsupported()
        }
        async fn verify(
            &self,
            _: &Ctx,
            _: p::BackupVerifyParams,
            _: StreamRef,
        ) -> PResult<p::BackupVerifyResult> {
            unsupported()
        }
        async fn prune(
            &self,
            _: &Ctx,
            _: p::BackupPruneParams,
            _: StreamRef,
        ) -> PResult<p::BackupPruneResult> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Pty for NullProvider {
        async fn open(
            &self,
            _: &Ctx,
            _: &str,
            _: p::PtyOpenParams,
            _: StreamRef,
        ) -> PResult<p::PtyOpenResult> {
            unsupported()
        }
        async fn resize(&self, _: &Ctx, _: &str, _: p::PtyResizeParams) -> PResult<()> {
            unsupported()
        }
        async fn close(&self, _: &Ctx, _: &str) -> PResult<()> {
            unsupported()
        }
    }

    #[async_trait]
    impl p::Provider for NullProvider {
        fn capabilities(&self) -> Vec<String> {
            Vec::new()
        }
        async fn host(&self, _: &Ctx) -> PResult<p::HostInfo> {
            unsupported()
        }
        fn events(&self) -> Option<Arc<AsyncMutex<mpsc::Receiver<Event>>>> {
            None
        }
        fn system(&self) -> &dyn p::System {
            self
        }
        fn services(&self) -> &dyn p::Services {
            self
        }
        fn processes(&self) -> &dyn p::Processes {
            self
        }
        fn containers(&self) -> &dyn p::Containers {
            self
        }
        fn files(&self) -> &dyn p::Files {
            self
        }
        fn logs(&self) -> &dyn p::Logs {
            self
        }
        fn certs(&self) -> &dyn p::Certs {
            self
        }
        fn sites(&self) -> &dyn p::Sites {
            self
        }
        fn dns(&self) -> &dyn p::Dns {
            self
        }
        fn mail(&self) -> &dyn p::Mail {
            self
        }
        fn databases(&self) -> &dyn p::Databases {
            self
        }
        fn firewall(&self) -> &dyn p::Firewall {
            self
        }
        fn ssh(&self) -> &dyn p::Ssh {
            self
        }
        fn backups(&self) -> &dyn p::Backups {
            self
        }
        fn pty(&self) -> &dyn p::Pty {
            self
        }
        async fn close(&self) {}
    }

    /// The registry the agent actually serves, with every capability
    /// present so nothing is gated out of the comparison.
    fn registry_under_test() -> Registry {
        let m = load_manifest();
        let caps: BTreeSet<String> = m
            .methods
            .iter()
            .flat_map(|x| x.requires.iter().cloned())
            .collect();
        let mut r = Registry::new(CapabilityGate::new(caps));
        register_handlers(&mut r, Arc::new(NullProvider), &[Path::new("/var/lib/kaname")]);
        r
    }

    fn request(method: &str, params: Option<Value>) -> Request {
        Request {
            id: "r1".into(),
            method: method.into(),
            params,
            stream: None,
        }
    }

    async fn call(r: &Registry, method: &str, params: Option<Value>) -> HResult {
        let m = r
            .get(method)
            .unwrap_or_else(|| panic!("{method} is not registered"));
        (m.handler)(Ctx::background(), request(method, params)).await
    }

    /* ------------------------------ tests ----------------------------- */

    #[test]
    fn protocol_constants_match_contract() {
        let m = load_manifest();
        assert_eq!(m.protocol, wire::PROTOCOL_VERSION, "protocol version");
        assert_eq!(m.subprotocol, wire::SUBPROTOCOL, "subprotocol");
        assert_eq!(m.limits.stream_window, wire::STREAM_WINDOW, "stream window");
        assert_eq!(m.limits.max_chunk_bytes, wire::MAX_CHUNK_BYTES, "max chunk bytes");
        assert_eq!(
            m.limits.ping_interval_ms,
            wire::PING_INTERVAL.as_millis() as u64,
            "ping interval"
        );
        assert_eq!(
            m.limits.ping_timeout_multiplier,
            wire::PING_TIMEOUT_MULTIPLIER,
            "ping multiplier"
        );
    }

    #[test]
    fn every_contract_method_is_registered() {
        let m = load_manifest();
        let r = registry_under_test();
        let registered: BTreeSet<&str> = r.names().into_iter().collect();
        let missing: Vec<&str> = m
            .methods
            .iter()
            .map(|x| x.name.as_str())
            .filter(|n| !registered.contains(n))
            .collect();
        assert!(
            missing.is_empty(),
            "the contract declares {} methods the agent does not serve: {missing:?}",
            missing.len()
        );
    }

    #[test]
    fn agent_registers_nothing_outside_the_contract() {
        let m = load_manifest();
        let declared: BTreeSet<&str> = m.methods.iter().map(|x| x.name.as_str()).collect();
        let r = registry_under_test();
        // An unlisted verb is an unreviewed hole in the attack surface,
        // which is the whole reason the registry is enumerated at all.
        let extra: Vec<&str> = r.names().into_iter().filter(|n| !declared.contains(n)).collect();
        assert!(
            extra.is_empty(),
            "the agent serves {} methods the contract does not declare: {extra:?}",
            extra.len()
        );
        assert_eq!(r.names().len(), m.methods.len());
    }

    #[test]
    fn stream_modes_and_requirements_match_contract() {
        let m = load_manifest();
        let r = registry_under_test();
        for method in &m.methods {
            let Ok(resolved) = r.resolve(&method.name) else {
                continue; // covered by every_contract_method_is_registered
            };
            assert_eq!(
                mode_name(resolved.mode),
                method.stream,
                "{}: stream mode differs from the contract",
                method.name
            );
            let mut want = method.requires.clone();
            want.sort();
            let mut got: Vec<String> = resolved.requires.iter().map(|s| s.to_string()).collect();
            got.sort();
            assert_eq!(
                got, want,
                "{}: capability requirements differ from the contract",
                method.name
            );
        }
    }

    #[test]
    fn no_method_accepts_a_free_form_command() {
        let m = load_manifest();
        // The security thesis in one assertion: there is no verb whose
        // name suggests arbitrary execution outside the deliberately
        // scoped PTY paths, which are separately permissioned, ticketed
        // and recorded.
        let allowed = ["pty.open", "pty.resize", "pty.close", "container.exec"];
        for method in &m.methods {
            assert!(
                !matches!(
                    method.name.as_str(),
                    "exec" | "shell" | "run" | "command" | "eval" | "system.exec" | "system.shell"
                ),
                "{} is a free-form execution verb and must not exist",
                method.name
            );
            if allowed.contains(&method.name.as_str()) {
                continue;
            }
            assert!(
                !(method.stream == "bidirectional" && method.name != "fs.upload"),
                "{} streams bidirectionally but is not one of the audited interactive verbs",
                method.name
            );
        }
    }

    #[test]
    fn unknown_method_is_rejected_before_any_handler_runs() {
        let r = registry_under_test();
        let err = r.resolve("definitely.not.a.method").unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownMethod);
    }

    #[test]
    fn capability_gate_rejects_what_the_host_cannot_serve() {
        // A host with nothing installed should still refuse cleanly rather
        // than failing deep inside a provider.
        let mut bare = Registry::new(CapabilityGate::default());
        register_handlers(&mut bare, Arc::new(NullProvider), &[]);
        let err = bare.resolve("service.list").unwrap_err();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(
            bare.resolve("system.info").is_ok(),
            "system.info requires no capability"
        );
        assert_eq!(
            bare.resolve("mail.deploy").unwrap_err().code,
            ErrorCode::Unsupported
        );
        assert_eq!(
            bare.resolve("mail.status").unwrap_err().code,
            ErrorCode::Unsupported
        );
    }

    #[test]
    fn decode_treats_absent_and_null_params_as_defaults() {
        let d: p::MailDeployParams = decode(&request("mail.deploy", None)).unwrap();
        assert_eq!(d.first_mailbox, "hello");
        let d: p::MailDeployParams = decode(&request("mail.deploy", Some(Value::Null))).unwrap();
        assert_eq!(d.sending, "direct");
        let err =
            decode::<p::SignalParams>(&request("process.signal", Some(json!({"pid": "x"})))).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
        assert!(err.message.starts_with("process.signal: "), "{}", err.message);
    }

    #[tokio::test]
    async fn validation_fails_before_the_provider_is_reached() {
        let r = registry_under_test();
        let cases: Vec<(&str, Value, ErrorCode)> = vec![
            (
                "system.reboot",
                json!({"delay_seconds": 4000}),
                ErrorCode::InvalidParams,
            ),
            (
                "system.self_update",
                json!({"version": "1", "url": "u", "sha256": "ab"}),
                ErrorCode::InvalidParams,
            ),
            ("service.status", json!({"unit": "a b"}), ErrorCode::InvalidParams),
            ("process.list", json!({"sort": "disk"}), ErrorCode::InvalidParams),
            (
                "process.signal",
                json!({"pid": 1, "signal": "SIGFOO"}),
                ErrorCode::InvalidParams,
            ),
            (
                "container.inspect",
                json!({"id": "a;b"}),
                ErrorCode::InvalidParams,
            ),
            // Container exec is bounded like pty.open: it is the same
            // interactive path, so a runtime never sees a 5000-column TTY.
            (
                "container.exec",
                json!({"id": "abc123", "cols": 5000, "rows": 24}),
                ErrorCode::InvalidParams,
            ),
            (
                "container.exec",
                json!({"id": "a;b", "cols": 80, "rows": 24}),
                ErrorCode::InvalidParams,
            ),
            ("fs.list", json!({"path": "var/www"}), ErrorCode::InvalidParams),
            (
                "fs.read",
                json!({"path": "/var/www/../../etc/shadow"}),
                ErrorCode::InvalidParams,
            ),
            (
                "fs.stat",
                json!({"path": "/var/lib/kaname/agent.key"}),
                ErrorCode::PermissionDenied,
            ),
            (
                "fs.chmod",
                json!({"paths": ["/tmp/x"], "mode": "9"}),
                ErrorCode::InvalidParams,
            ),
            ("fs.chown", json!({"paths": ["/tmp/x"]}), ErrorCode::InvalidParams),
            (
                "site.create",
                json!({"name": "a", "server_names": ["a.b"], "webroot": "/srv", "runtime": "cgi"}),
                ErrorCode::InvalidParams,
            ),
            (
                "cert.issue",
                json!({"domains": ["a.b"], "challenge": "tls-alpn"}),
                ErrorCode::InvalidParams,
            ),
            ("dns.resolve", json!({"name": "a.b"}), ErrorCode::InvalidParams),
            (
                "mail.deploy",
                json!({"version": "1", "url": "https://x", "sha256": "zz", "domain": "d", "hostname": "h", "admin_email": "a@b"}),
                ErrorCode::InvalidParams,
            ),
            (
                "mail.deploy",
                json!({"version": "1", "url": "https://x", "sha256": "0".repeat(64), "domain": "d", "hostname": "h", "admin_email": "a@b", "sending": "relay"}),
                ErrorCode::InvalidParams,
            ),
            (
                "mail.deploy",
                json!({"version": "1", "url": "https://x", "sha256": "0".repeat(64), "domain": "d", "hostname": "h", "admin_email": "ab"}),
                ErrorCode::InvalidParams,
            ),
            ("mail.domain.add", json!({"name": ""}), ErrorCode::InvalidParams),
            (
                "mail.mailbox.add",
                json!({"address": "nobody"}),
                ErrorCode::InvalidParams,
            ),
            (
                "mail.alias.add",
                json!({"alias": "a@b", "mailbox": "c"}),
                ErrorCode::InvalidParams,
            ),
            (
                "db.database.create",
                json!({"engine": "sqlite", "name": "x"}),
                ErrorCode::InvalidParams,
            ),
            (
                "db.user.create",
                json!({"engine": "mysql", "username": "u", "password": "short"}),
                ErrorCode::InvalidParams,
            ),
            (
                "db.grant.apply",
                json!({"engine": "mysql", "database": "d", "username": "u", "privileges": ["GRANT"]}),
                ErrorCode::InvalidParams,
            ),
            (
                "fw.apply",
                json!({"rollback_seconds": 500}),
                ErrorCode::InvalidParams,
            ),
            ("fw.ban", json!({"target": "evil;rm"}), ErrorCode::InvalidParams),
            (
                "ssh.keys.apply",
                json!({"user": "root", "keys": [{"public_key": "a\nb"}]}),
                ErrorCode::InvalidParams,
            ),
            (
                "ssh.config.apply",
                json!({"port": 70000}),
                ErrorCode::InvalidParams,
            ),
            (
                "backup.list",
                json!({"repository": "r"}),
                ErrorCode::InvalidParams,
            ),
            (
                "backup.prune",
                json!({"repository": "r", "password_ref": "p", "keep_last": -1}),
                ErrorCode::InvalidParams,
            ),
            ("log.tail", json!({}), ErrorCode::InvalidParams),
            (
                "pty.open",
                json!({"cols": 0, "rows": 24}),
                ErrorCode::InvalidParams,
            ),
            ("pty.resize", json!({"cols": 80, "rows": 24}), ErrorCode::NotFound),
            ("pty.close", Value::Null, ErrorCode::NotFound),
            // A valid call to a streaming method with no stream is the
            // connection's mistake, not the caller's.
            (
                "service.logs",
                json!({"unit": "nginx.service"}),
                ErrorCode::Internal,
            ),
            ("mail.update", Value::Null, ErrorCode::Internal),
            // A valid call reaches the null provider, which refuses it.
            ("system.info", Value::Null, ErrorCode::Unsupported),
            ("mail.status", Value::Null, ErrorCode::Unsupported),
            ("fs.usage", json!({}), ErrorCode::Unsupported),
        ];
        for (method, params, want) in cases {
            let err = match call(&r, method, Some(params.clone())).await {
                Ok(v) => panic!("{method} {params} was accepted: {v}"),
                Err(e) => e,
            };
            assert_eq!(err.code, want, "{method} {params}: {}", err.message);
        }
    }

    #[test]
    fn validators_match_the_contract_vocabulary() {
        assert!(check_identifier("user", "www-data").is_ok());
        assert!(check_identifier("user", "_svc").is_ok());
        assert!(check_identifier("user", "1abc").is_err());
        assert!(check_identifier("user", "a.b").is_err());
        assert!(check_identifier("user", &"a".repeat(64)).is_err());
        assert!(check_mode("").is_ok());
        assert!(check_mode("644").is_ok());
        assert!(check_mode("0644").is_ok());
        assert!(check_mode("00644").is_err());
        assert!(check_mode("0648").is_err());
        assert!(check_unit("nginx.service").is_ok());
        assert!(check_unit("../x").is_err());
        assert!(check_container_id("abc123/def.x").is_ok());
        assert!(check_container_id("a b").is_err());
        assert!(check_address("a@b.c").is_ok());
        assert!(check_address("@b").is_err());
        assert!(check_address("a@").is_err());
        assert!(check_address("a b@c").is_err());
        assert!(check_target("10.0.0.0/8").is_ok());
        assert!(check_target("2001:db8::1").is_ok());
        assert!(check_target("evil.example").is_err());
        assert!(check_dimensions(80, 24).is_ok());
        assert!(check_dimensions(1001, 24).is_err());
        assert_eq!(or_default(0i64, 200i64), 200);
        assert_eq!(or_default(-5i64, 200i64), 200);
        assert_eq!(or_default(7i64, 200i64), 7);
        assert_eq!(or_default(String::new(), "cpu"), "cpu");
        assert_eq!(or_default("pid".to_string(), "cpu"), "pid");
        let err = check_enum("sort", "disk", &["cpu", "memory"]).unwrap_err();
        assert_eq!(err.message, "sort must be one of cpu, memory");
    }

    #[test]
    fn manifest_requires_are_only_known_capabilities() {
        let m = load_manifest();
        let known: BTreeMap<&str, ()> = [
            cap::SYSTEMD,
            cap::DOCKER,
            cap::PODMAN,
            cap::NGINX,
            cap::APACHE,
            cap::CADDY,
            cap::PHP,
            cap::NODEJS,
            cap::PYTHON,
            cap::MYSQL,
            cap::MARIADB,
            cap::POSTGRES,
            cap::YUNORI,
            cap::NFTABLES,
            cap::IPTABLES,
            cap::UFW,
            cap::FAIL2BAN,
            cap::CERTBOT,
            cap::RESTIC,
            cap::SFTP,
            cap::VSFTPD,
            cap::SIMULATED,
        ]
        .into_iter()
        .map(|c| (c, ()))
        .collect();
        for method in &m.methods {
            for c in &method.requires {
                assert!(
                    known.contains_key(c.as_str()),
                    "{}: unknown capability {c}",
                    method.name
                );
            }
        }
    }
}
