//! Yunori Mail Server, simulated (KD-023).
//!
//! Not a port of the Go sim's Postfix model: the shape here is what the
//! `yunori-mail` CLI reports on a real host — an installed server, its
//! install checklist, domains, mailboxes, aliases, doctor and preflight
//! verdicts, the DNS records it wants published. The world is deliberately
//! *almost* right: the PTR has not been set and the DKIM record for the
//! primary domain is missing, so the panel's mail pages have real findings
//! to render instead of a row of green ticks.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use rand::Rng;

use super::certs::MAIL_CERT_DAYS;
use super::logs::{self, TailRequest};
use super::services::unit_active;
use super::state::{Sim, World, mix, pause, progress, stamp};
use crate::providers::{
    Ctx, LogRecord, Mail, MailAddressParams, MailAliasAddParams, MailAliasEntry, MailAliasRemoveParams,
    MailCertificateRenewResult, MailCertificateStatus, MailCheck, MailCheckStatus, MailDeployOutcome,
    MailDeployParams, MailDeployResult, MailDnsRecord, MailDomainDnsResult, MailDomainEntry, MailDomainParams,
    MailInstallStep, MailInstallStepStatus, MailListParams, MailLogsParams, MailPasswordResult, MailPreflightParams,
    MailServerStatusInfo, MailServiceState, MailboxAddParams, MailboxEntry, PResult, ProviderError, StreamRef,
};

pub const PRIMARY_DOMAIN: &str = "futureforge.dev";
pub const SECOND_DOMAIN: &str = "kaname.sh";
/// The address the sim host sends from; RFC 5737 documentation space.
pub const MAIL_IP: &str = "198.51.100.42";
pub const VERSION: &str = "0.1.0";
pub const DKIM_SELECTOR: &str = "ym1";
pub const PTR_DETAIL: &str = "Set the PTR for 198.51.100.42 to mail.futureforge.dev at your provider.";

/// Inert filler shaped like a 2048-bit RSA SPKI. Nothing here is a key; it
/// exists so the expected DKIM record has the length a real one has.
pub const DKIM_PUBLIC_KEY: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsimulatedKAName0AgentKeyMaterialFor\
DevelopmentOnlyQm5kZXZlbG9wbWVudE9ubHkxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1\
dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODkrLzAxMjM0NTY3ODlhYmNkZWZn\
aGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1Njc4OSsvQUJD\
REVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcAIDAQAB";

/// The installer's checklist, titles verbatim from yunori-mail's
/// `installer::state::STEPS`.
pub const INSTALL_STEPS: &[(&str, &str)] = &[
    ("preflight", "Check this server"),
    ("inputs", "Your domain"),
    ("host_record", "Point the mail hostname here"),
    ("firewall", "Open mail ports"),
    ("install_engine", "Install the mail engine"),
    ("bootstrap_engine", "Configure the mail engine"),
    ("edge_tls", "Start the console and HTTPS edge"),
    ("certificate", "Get a trusted TLS certificate"),
    ("dns", "Publish DNS records"),
    ("ptr", "Set reverse DNS"),
    ("first_mailbox", "Create your first mailbox"),
    ("done", "Finish"),
];

#[derive(Clone, Debug)]
pub struct MailDomain {
    pub name: String,
    pub dns_status: MailCheckStatus,
}

#[derive(Clone, Debug)]
pub struct Mailbox {
    pub address: String,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct MailWorld {
    pub installed: bool,
    pub version: String,
    pub hostname: String,
    pub steps: Vec<MailInstallStep>,
    pub domains: Vec<MailDomain>,
    pub mailboxes: Vec<Mailbox>,
    pub aliases: Vec<MailAliasEntry>,
}

impl MailWorld {
    pub fn domain(&self, name: &str) -> Option<&MailDomain> {
        self.domains.iter().find(|d| d.name.eq_ignore_ascii_case(name))
    }
    pub fn mailbox(&self, address: &str) -> Option<&Mailbox> {
        self.mailboxes.iter().find(|m| m.address.eq_ignore_ascii_case(address))
    }
    pub fn alias(&self, address: &str) -> Option<&MailAliasEntry> {
        self.aliases.iter().find(|a| a.address.eq_ignore_ascii_case(address))
    }
    pub fn mailbox_count(&self, domain: &str) -> i64 {
        self.mailboxes.iter().filter(|m| domain_of(&m.address).eq_ignore_ascii_case(domain)).count() as i64
    }
    pub fn install_complete(&self) -> bool {
        self.steps
            .iter()
            .all(|s| matches!(s.status, MailInstallStepStatus::Done | MailInstallStepStatus::Skipped))
    }
    pub fn console_url(&self) -> String {
        format!("https://{}/console", self.hostname)
    }
}

/// The checklist of a finished install that still waits on the operator's
/// reverse-DNS entry.
pub fn steps_paused_at_ptr(skip_ptr: bool) -> Vec<MailInstallStep> {
    INSTALL_STEPS
        .iter()
        .map(|(id, title)| {
            let (status, detail) = match (*id, skip_ptr) {
                ("ptr", false) => (MailInstallStepStatus::Waiting, Some(PTR_DETAIL.to_string())),
                ("ptr", true) => (MailInstallStepStatus::Skipped, Some("Skipped at the operator's request.".into())),
                _ => (MailInstallStepStatus::Done, None),
            };
            MailInstallStep { title: title.to_string(), status, detail }
        })
        .collect()
}

pub fn build_mail(sim: &Sim) {
    let hostname = format!("mail.{PRIMARY_DOMAIN}");
    let mailbox = |local: &str, domain: &str, name: &str| Mailbox {
        address: format!("{local}@{domain}"),
        display_name: Some(name.to_string()),
    };
    let alias = |local: &str, domain: &str, target: &str| MailAliasEntry {
        address: format!("{local}@{domain}"),
        mailbox: format!("{target}@{domain}"),
    };

    let world = MailWorld {
        installed: true,
        version: VERSION.into(),
        hostname,
        steps: steps_paused_at_ptr(false),
        domains: vec![
            MailDomain { name: PRIMARY_DOMAIN.into(), dns_status: MailCheckStatus::Warn },
            MailDomain { name: SECOND_DOMAIN.into(), dns_status: MailCheckStatus::Pass },
        ],
        mailboxes: vec![
            mailbox("hello", PRIMARY_DOMAIN, "FutureForge Studios"),
            mailbox("ops", PRIMARY_DOMAIN, "Operations"),
            mailbox("alice", PRIMARY_DOMAIN, "Alice Nakamura"),
            mailbox("team", SECOND_DOMAIN, "Kaname Team"),
        ],
        aliases: vec![
            alias("postmaster", PRIMARY_DOMAIN, "ops"),
            alias("abuse", PRIMARY_DOMAIN, "ops"),
            alias("support", PRIMARY_DOMAIN, "hello"),
            alias("info", PRIMARY_DOMAIN, "hello"),
            alias("postmaster", SECOND_DOMAIN, "team"),
        ],
    };
    sim.world.lock().mail = world;
}

/* ------------------------------ helpers ------------------------------ */

pub fn domain_of(address: &str) -> &str {
    address.rsplit('@').next().unwrap_or_default()
}

fn split_address(address: &str) -> PResult<(String, String)> {
    let address = address.trim().to_ascii_lowercase();
    let Some((local, domain)) = address.split_once('@') else {
        return Err(ProviderError::invalid(format!("{address:?} is not an email address")));
    };
    if local.is_empty() || domain.is_empty() || !domain.contains('.') || address.contains(char::is_whitespace) {
        return Err(ProviderError::invalid(format!("{address:?} is not an email address")));
    }
    Ok((local.to_string(), domain.to_string()))
}

fn normalise_domain(name: &str) -> PResult<String> {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    let valid = !name.is_empty()
        && name.contains('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.starts_with('.')
        && !name.contains("..");
    if !valid {
        return Err(ProviderError::invalid(format!("{name:?} is not a domain name")));
    }
    Ok(name)
}

/// A 20-character password from an alphabet without look-alikes, the way
/// yunori-mail generates them. Returned once and never kept.
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..20).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

fn check(id: &str, label: &str, status: MailCheckStatus, detail: impl Into<String>, remedy: Option<&str>) -> MailCheck {
    MailCheck {
        id: id.into(),
        label: label.into(),
        status,
        detail: detail.into(),
        remedy: remedy.map(str::to_string),
        help_url: None,
    }
}

fn require_installed(w: &World) -> PResult<()> {
    if !w.mail.installed {
        return Err(ProviderError::PreconditionFailed(
            "Yunori Mail Server is not installed on this host; run mail.deploy first".into(),
        ));
    }
    Ok(())
}

/* --------------------------------- dns ------------------------------- */

fn record(
    rtype: &str,
    name: &str,
    expected: String,
    status: MailCheckStatus,
    required: bool,
) -> MailDnsRecord {
    let actual = match status {
        MailCheckStatus::Pass | MailCheckStatus::Warn | MailCheckStatus::Info => vec![expected.clone()],
        _ => vec![],
    };
    MailDnsRecord {
        id: format!("{rtype}:{name}"),
        rtype: rtype.into(),
        name: name.into(),
        expected: Some(expected),
        actual,
        status,
        required,
    }
}

/// The records yunori expects for a domain, with each one's verdict
/// derived from the domain's overall DNS status: a passing domain has
/// everything published, a warning one is missing DKIM, a failing one has
/// published nothing yet.
pub fn expected_records(domain: &MailDomain, hostname: &str) -> Vec<MailDnsRecord> {
    let d = &domain.name;
    let overall = domain.dns_status;
    let published = |required: bool| match overall {
        MailCheckStatus::Fail | MailCheckStatus::Unknown => MailCheckStatus::Fail,
        _ if !required && overall == MailCheckStatus::Warn => MailCheckStatus::Warn,
        _ => MailCheckStatus::Pass,
    };
    let dkim_status = match overall {
        MailCheckStatus::Pass => MailCheckStatus::Pass,
        _ => MailCheckStatus::Fail,
    };

    let mut out = Vec::new();
    if hostname == format!("mail.{d}") {
        out.push(record("A", hostname, MAIL_IP.into(), published(true), true));
    }
    out.push(record("MX", d, format!("10 {hostname}."), published(true), true));
    out.push(record("TXT", d, "v=spf1 mx -all".into(), published(true), true));
    out.push(record(
        "TXT",
        &format!("{DKIM_SELECTOR}._domainkey.{d}"),
        format!("v=DKIM1; k=rsa; p={DKIM_PUBLIC_KEY}"),
        dkim_status,
        true,
    ));
    out.push(record(
        "TXT",
        &format!("_dmarc.{d}"),
        format!("v=DMARC1; p=quarantine; rua=mailto:dmarc@{d}; adkim=s; aspf=s"),
        published(true),
        true,
    ));
    out.push(record("TXT", &format!("_mta-sts.{d}"), "v=STSv1; id=2026110601".into(), published(false), false));
    out.push(record("CNAME", &format!("mta-sts.{d}"), format!("{hostname}."), published(false), false));
    out.push(record(
        "TXT",
        &format!("_smtp._tls.{d}"),
        format!("v=TLSRPTv1; rua=mailto:tlsrpt@{d}"),
        published(false),
        false,
    ));
    out.push(record("CNAME", &format!("autoconfig.{d}"), format!("{hostname}."), published(true), true));
    out.push(record("CNAME", &format!("autodiscover.{d}"), format!("{hostname}."), published(false), false));
    out.push(record("SRV", &format!("_imaps._tcp.{d}"), format!("0 1 993 {hostname}."), published(false), false));
    out.push(record("SRV", &format!("_submission._tcp.{d}"), format!("0 1 587 {hostname}."), published(false), false));
    out
}

pub fn zone_file(domain: &str, records: &[MailDnsRecord]) -> String {
    let mut b = format!("; Yunori Mail Server records for {domain}\n; generated by yunori-mail {VERSION}\n$ORIGIN {domain}.\n$TTL 3600\n\n");
    for r in records {
        let name = if r.name == domain { "@".to_string() } else { format!("{}.", r.name) };
        let value = r.expected.clone().unwrap_or_default();
        let value = match r.rtype.as_str() {
            "TXT" => {
                // Long TXT values are split into 255-byte strings, as a zone
                // file requires.
                let chunks: Vec<String> =
                    value.as_bytes().chunks(255).map(|c| format!("\"{}\"", String::from_utf8_lossy(c))).collect();
                if chunks.len() > 1 { format!("( {} )", chunks.join(" ")) } else { chunks.join("") }
            }
            _ => value,
        };
        b.push_str(&format!("{name:<40} IN {:<6} {value}\n", r.rtype));
    }
    b
}

/* --------------------------------- mail ------------------------------ */

pub struct SimMail(pub Arc<Sim>);

impl SimMail {
    fn status_info(&self) -> MailServerStatusInfo {
        let w = self.0.world.lock();
        let m = &w.mail;
        if !m.installed {
            return MailServerStatusInfo { installed: false, ..Default::default() };
        }
        let services = ["stalwart", "yunori-mail", "unbound"]
            .iter()
            .map(|name| MailServiceState {
                name: name.to_string(),
                active: unit_active(&w, &service_unit(name)),
            })
            .collect();
        MailServerStatusInfo {
            installed: true,
            version: Some(m.version.clone()),
            install_complete: m.install_complete(),
            steps: m.steps.clone(),
            services,
            hostnames: vec![m.hostname.clone()],
            console_url: Some(m.console_url()),
        }
    }
}

fn service_unit(name: &str) -> String {
    match name {
        "stalwart" => "stalwart-mail.service".into(),
        other => format!("{other}.service"),
    }
}

#[async_trait]
impl Mail for SimMail {
    async fn status(&self, _ctx: &Ctx) -> PResult<MailServerStatusInfo> {
        Ok(self.status_info())
    }

    async fn preflight(&self, _ctx: &Ctx, p: MailPreflightParams) -> PResult<Vec<MailCheck>> {
        let hostname = p.hostname.filter(|h| !h.is_empty()).unwrap_or_else(|| format!("mail.{PRIMARY_DOMAIN}"));
        let id = &self.0.id;
        Ok(vec![
            check("os", "Operating system", MailCheckStatus::Pass, format!("{} {} ({})", id.os, id.os_version, id.arch), None),
            check("memory", "Memory", MailCheckStatus::Pass, format!("{} GiB available; 2 GiB is the minimum", id.memory_total >> 30), None),
            check("disk", "Disk space", MailCheckStatus::Pass, "41 GiB free on /; 10 GiB is the minimum", None),
            check("hostname", "Mail hostname", MailCheckStatus::Pass, format!("{hostname} resolves to {MAIL_IP}, which is this server"), None),
            check("ports", "Mail ports", MailCheckStatus::Pass, "Ports 25, 465, 587, 993 and 443 are free", None),
            check(
                "outbound_25",
                "Outbound port 25",
                MailCheckStatus::Info,
                "Outbound SMTP on port 25 is reachable from this server. Some providers block it later; switch to relay sending if deliveries stall.",
                None,
            ),
            check("existing_mta", "Existing mail software", MailCheckStatus::Pass, "No Postfix, Exim or Dovecot installation found", None),
            check("systemd", "systemd", MailCheckStatus::Pass, "systemd 252 is managing services", None),
            check("resolver", "DNS resolver", MailCheckStatus::Pass, "A local validating resolver can be installed (unbound)", None),
        ])
    }

    async fn doctor(&self, _ctx: &Ctx) -> PResult<Vec<MailCheck>> {
        let (services, hostname, domain_detail, dns_status) = {
            let w = self.0.world.lock();
            require_installed(&w)?;
            let services: Vec<(String, bool)> =
                ["stalwart", "yunori-mail", "unbound"].iter().map(|n| (n.to_string(), unit_active(&w, &service_unit(n)))).collect();
            let mut worst = MailCheckStatus::Pass;
            let mut parts = Vec::new();
            for d in &w.mail.domains {
                worst = MailCheckStatus::worst(worst, d.dns_status);
                parts.push(match d.dns_status {
                    MailCheckStatus::Pass => format!("{}: all records present", d.name),
                    MailCheckStatus::Warn => format!("{}: DKIM record missing", d.name),
                    _ => format!("{}: no records published yet", d.name),
                });
            }
            (services, w.mail.hostname.clone(), parts.join("; "), worst)
        };

        let mut checks = Vec::new();
        for (name, active) in services {
            let unit = service_unit(&name);
            checks.push(if active {
                check(&format!("service_{name}"), &format!("Service {name}"), MailCheckStatus::Pass, format!("{unit} is active"), None)
            } else {
                check(
                    &format!("service_{name}"),
                    &format!("Service {name}"),
                    MailCheckStatus::Fail,
                    format!("{unit} is not running"),
                    Some(&format!("Start it with `systemctl start {unit}` and check `journalctl -u {unit}`.")),
                )
            });
        }
        checks.push(check("ports", "Mail ports", MailCheckStatus::Pass, "Listening on 25, 465, 587, 993 and 443", None));
        checks.push(check(
            "ptr",
            "Reverse DNS (PTR)",
            MailCheckStatus::Warn,
            format!("{MAIL_IP} resolves to {} instead of {hostname}; receivers that check the PTR may distrust this server", self.0.id.hostname),
            Some(PTR_DETAIL),
        ));
        let mut zen = check(
            "dnsbl_spamhaus",
            "Spamhaus ZEN",
            MailCheckStatus::Fail,
            format!("{MAIL_IP} is listed (127.0.0.4, SBL CSS); most receivers will reject or junk mail from it"),
            Some("Request removal at check.spamhaus.org and send through a relay until the listing clears."),
        );
        zen.help_url = Some("https://check.spamhaus.org/".into());
        checks.push(zen);
        checks.push(check(
            "dns",
            "DNS records",
            dns_status,
            domain_detail,
            if dns_status == MailCheckStatus::Pass { None } else { Some("Publish the records shown under Domains › DNS at your DNS provider.") },
        ));
        checks.push(check(
            "certificate",
            "TLS certificate",
            MailCheckStatus::Pass,
            format!("Let's Encrypt certificate covers {hostname}; {MAIL_CERT_DAYS} days left, renews automatically"),
            None,
        ));
        checks.push(check("audit", "Security audit", MailCheckStatus::Pass, "Last audit 4 hours ago: no findings", None));
        checks.push(check("disk", "Disk space", MailCheckStatus::Pass, "Mail store uses 1.2 GiB; 41 GiB free", None));
        checks.push(check("queue", "Outbound queue", MailCheckStatus::Pass, "3 messages queued, oldest 4 minutes", None));
        Ok(checks)
    }

    async fn deploy(&self, ctx: &Ctx, p: MailDeployParams, s: StreamRef) -> PResult<MailDeployResult> {
        let domain = normalise_domain(&p.domain)?;
        let hostname = if p.hostname.is_empty() { format!("mail.{domain}") } else { normalise_domain(&p.hostname)? };
        let version = if p.version.is_empty() { VERSION.to_string() } else { p.version.clone() };
        let first_local = if p.first_mailbox.is_empty() { "hello".to_string() } else { p.first_mailbox.to_ascii_lowercase() };
        let first_mailbox = format!("{first_local}@{domain}");

        let lines = [
            format!("Verifying yunori-mail {version} archive (sha256 {}…)", p.sha256.chars().take(12).collect::<String>()),
            "Check this server: all preflight checks passed".to_string(),
            format!("Your domain: {domain}, mail hostname {hostname}"),
            format!("Point the mail hostname here: {hostname} → {MAIL_IP}"),
            "Open mail ports: 25, 465, 587, 993, 443 allowed through nftables".to_string(),
            "Install the mail engine: Stalwart installed to /opt/stalwart".to_string(),
            "Configure the mail engine: directory, listeners and storage written".to_string(),
            "Start the console and HTTPS edge: yunori-mail.service active".to_string(),
            format!("Get a trusted TLS certificate: issued for {hostname} by Let's Encrypt"),
            format!("Publish DNS records: records for {domain} are shown in the console"),
        ];
        for line in lines {
            progress(ctx, &*s, Duration::from_millis(180), line).await?;
        }
        if p.skip_ptr {
            progress(ctx, &*s, Duration::from_millis(120), "Set reverse DNS: skipped").await?;
        } else {
            progress(ctx, &*s, Duration::from_millis(120), format!("Set reverse DNS: waiting — {PTR_DETAIL}")).await?;
        }
        progress(ctx, &*s, Duration::from_millis(120), format!("Create your first mailbox: {first_mailbox}")).await?;

        let password = generate_password();
        let token = format!("sim-{:016x}", mix(self.0.seed ^ Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64));
        let steps = steps_paused_at_ptr(p.skip_ptr);

        {
            let mut w = self.0.world.lock();
            let m = &mut w.mail;
            m.installed = true;
            m.version = version.clone();
            m.hostname = hostname.clone();
            m.steps = steps.clone();
            if m.domain(&domain).is_none() {
                m.domains.push(MailDomain { name: domain.clone(), dns_status: MailCheckStatus::Fail });
            }
            if m.mailbox(&first_mailbox).is_none() {
                m.mailboxes.push(Mailbox { address: first_mailbox.clone(), display_name: None });
            }
            for local in ["postmaster", "abuse"] {
                let address = format!("{local}@{domain}");
                if m.alias(&address).is_none() && m.mailbox(&address).is_none() {
                    m.aliases.push(MailAliasEntry { address, mailbox: first_mailbox.clone() });
                }
            }
        }

        let outcome = if p.skip_ptr { MailDeployOutcome::Ready } else { MailDeployOutcome::Paused };
        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            match outcome {
                MailDeployOutcome::Ready => "Finish: Yunori Mail Server is ready".to_string(),
                _ => "Finish: paused at \"Set reverse DNS\"; the console will pick up where this left off".to_string(),
            },
        )
        .await;

        Ok(MailDeployResult {
            outcome,
            version,
            paused_at: if p.skip_ptr { None } else { Some("Set reverse DNS".into()) },
            setup_url: Some(format!("https://{hostname}/console/setup#token={token}")),
            console_url: Some(format!("https://{hostname}/console")),
            first_mailbox: Some(first_mailbox),
            first_mailbox_password: Some(password),
            steps,
        })
    }

    async fn update(&self, ctx: &Ctx, s: StreamRef) -> PResult<()> {
        let version = {
            let w = self.0.world.lock();
            require_installed(&w)?;
            w.mail.version.clone()
        };
        progress(ctx, &*s, Duration::ZERO, "Checking for a newer Yunori Mail Server release…").await?;
        progress(ctx, &*s, Duration::from_millis(400), format!("yunori-mail {version} is installed")).await?;
        progress(ctx, &*s, Duration::from_millis(300), "Stalwart is at the version this release pins").await?;
        progress(ctx, &*s, Duration::from_millis(200), format!("{version} is the latest release; nothing to do")).await?;
        Ok(())
    }

    async fn list_domains(&self, _ctx: &Ctx) -> PResult<Vec<MailDomainEntry>> {
        let w = self.0.world.lock();
        require_installed(&w)?;
        let mut out: Vec<MailDomainEntry> = w
            .mail
            .domains
            .iter()
            .map(|d| MailDomainEntry {
                name: d.name.clone(),
                dns_status: d.dns_status,
                mailbox_count: w.mail.mailbox_count(&d.name),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn add_domain(&self, _ctx: &Ctx, p: MailDomainParams) -> PResult<()> {
        let name = normalise_domain(&p.name)?;
        let mut w = self.0.world.lock();
        require_installed(&w)?;
        if w.mail.domain(&name).is_some() {
            return Err(ProviderError::conflict(format!("domain {name} already exists")));
        }
        // Nothing is published for a brand-new domain, which is exactly what
        // the DNS page should say until the operator acts.
        w.mail.domains.push(MailDomain { name, dns_status: MailCheckStatus::Fail });
        Ok(())
    }

    async fn remove_domain(&self, _ctx: &Ctx, p: MailDomainParams) -> PResult<()> {
        let name = normalise_domain(&p.name)?;
        let mut w = self.0.world.lock();
        require_installed(&w)?;
        let Some(idx) = w.mail.domains.iter().position(|d| d.name == name) else {
            return Err(ProviderError::not_found(format!("domain {name}")));
        };
        let count = w.mail.mailbox_count(&name);
        if count > 0 {
            return Err(ProviderError::conflict(format!(
                "domain {name} still has {count} mailbox{}; remove them first",
                if count == 1 { "" } else { "es" }
            )));
        }
        w.mail.domains.remove(idx);
        w.mail.aliases.retain(|a| !domain_of(&a.address).eq_ignore_ascii_case(&name));
        Ok(())
    }

    async fn domain_dns(&self, _ctx: &Ctx, p: MailDomainParams) -> PResult<MailDomainDnsResult> {
        let name = normalise_domain(&p.name)?;
        let w = self.0.world.lock();
        require_installed(&w)?;
        let Some(domain) = w.mail.domain(&name) else {
            return Err(ProviderError::not_found(format!("domain {name}")));
        };
        let records = expected_records(domain, &w.mail.hostname);
        let zone_file = zone_file(&domain.name, &records);
        Ok(MailDomainDnsResult { records, zone_file })
    }

    async fn list_mailboxes(&self, _ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailboxEntry>> {
        let filter = p.domain.filter(|d| !d.is_empty()).map(|d| d.to_ascii_lowercase());
        let w = self.0.world.lock();
        require_installed(&w)?;
        let mut out: Vec<MailboxEntry> = w
            .mail
            .mailboxes
            .iter()
            .filter(|m| filter.as_deref().is_none_or(|d| domain_of(&m.address).eq_ignore_ascii_case(d)))
            .map(|m| MailboxEntry {
                address: m.address.clone(),
                display_name: m.display_name.clone(),
                aliases: w
                    .mail
                    .aliases
                    .iter()
                    .filter(|a| a.mailbox.eq_ignore_ascii_case(&m.address))
                    .map(|a| a.address.clone())
                    .collect(),
            })
            .collect();
        out.sort_by(|a, b| a.address.cmp(&b.address));
        Ok(out)
    }

    async fn add_mailbox(&self, _ctx: &Ctx, p: MailboxAddParams) -> PResult<MailPasswordResult> {
        let (local, domain) = split_address(&p.address)?;
        let address = format!("{local}@{domain}");
        let mut w = self.0.world.lock();
        require_installed(&w)?;
        if w.mail.domain(&domain).is_none() {
            return Err(ProviderError::not_found(format!("domain {domain} is not served by this host")));
        }
        if w.mail.mailbox(&address).is_some() {
            return Err(ProviderError::conflict(format!("mailbox {address} already exists")));
        }
        if let Some(alias) = w.mail.alias(&address) {
            return Err(ProviderError::conflict(format!(
                "{address} is an alias of {}; remove the alias first",
                alias.mailbox
            )));
        }
        w.mail.mailboxes.push(Mailbox {
            address,
            display_name: p.display_name.filter(|d| !d.trim().is_empty()),
        });
        Ok(MailPasswordResult { password: generate_password() })
    }

    async fn mailbox_password(&self, _ctx: &Ctx, p: MailAddressParams) -> PResult<MailPasswordResult> {
        let (local, domain) = split_address(&p.address)?;
        let address = format!("{local}@{domain}");
        let w = self.0.world.lock();
        require_installed(&w)?;
        if w.mail.mailbox(&address).is_none() {
            return Err(ProviderError::not_found(format!("mailbox {address}")));
        }
        Ok(MailPasswordResult { password: generate_password() })
    }

    async fn remove_mailbox(&self, _ctx: &Ctx, p: MailAddressParams) -> PResult<()> {
        let (local, domain) = split_address(&p.address)?;
        let address = format!("{local}@{domain}");
        let mut w = self.0.world.lock();
        require_installed(&w)?;
        let Some(idx) = w.mail.mailboxes.iter().position(|m| m.address.eq_ignore_ascii_case(&address)) else {
            return Err(ProviderError::not_found(format!("mailbox {address}")));
        };
        w.mail.mailboxes.remove(idx);
        // Aliases that delivered to the mailbox go with it.
        w.mail.aliases.retain(|a| !a.mailbox.eq_ignore_ascii_case(&address));
        Ok(())
    }

    async fn list_aliases(&self, _ctx: &Ctx, p: MailListParams) -> PResult<Vec<MailAliasEntry>> {
        let filter = p.domain.filter(|d| !d.is_empty()).map(|d| d.to_ascii_lowercase());
        let w = self.0.world.lock();
        require_installed(&w)?;
        let mut out: Vec<MailAliasEntry> = w
            .mail
            .aliases
            .iter()
            .filter(|a| filter.as_deref().is_none_or(|d| domain_of(&a.address).eq_ignore_ascii_case(d)))
            .cloned()
            .collect();
        out.sort_by(|a, b| a.address.cmp(&b.address));
        Ok(out)
    }

    async fn add_alias(&self, _ctx: &Ctx, p: MailAliasAddParams) -> PResult<()> {
        let (alias_local, alias_domain) = split_address(&p.alias)?;
        let alias = format!("{alias_local}@{alias_domain}");
        let (box_local, box_domain) = split_address(&p.mailbox)?;
        let mailbox = format!("{box_local}@{box_domain}");

        let mut w = self.0.world.lock();
        require_installed(&w)?;
        if w.mail.domain(&alias_domain).is_none() {
            return Err(ProviderError::not_found(format!("domain {alias_domain} is not served by this host")));
        }
        if w.mail.mailbox(&mailbox).is_none() {
            return Err(ProviderError::not_found(format!("mailbox {mailbox}")));
        }
        if w.mail.mailbox(&alias).is_some() {
            return Err(ProviderError::conflict(format!("{alias} is a mailbox; an alias cannot shadow it")));
        }
        if let Some(existing) = w.mail.alias(&alias) {
            return Err(ProviderError::conflict(format!(
                "alias {alias} already delivers to {}",
                existing.mailbox
            )));
        }
        w.mail.aliases.push(MailAliasEntry { address: alias, mailbox });
        Ok(())
    }

    async fn remove_alias(&self, _ctx: &Ctx, p: MailAliasRemoveParams) -> PResult<()> {
        let (local, domain) = split_address(&p.alias)?;
        let alias = format!("{local}@{domain}");
        let mut w = self.0.world.lock();
        require_installed(&w)?;
        let Some(idx) = w.mail.aliases.iter().position(|a| a.address.eq_ignore_ascii_case(&alias)) else {
            return Err(ProviderError::not_found(format!("alias {alias}")));
        };
        w.mail.aliases.remove(idx);
        Ok(())
    }

    async fn certificate_status(&self, _ctx: &Ctx) -> PResult<MailCertificateStatus> {
        let hostname = {
            let w = self.0.world.lock();
            require_installed(&w)?;
            w.mail.hostname.clone()
        };
        let now = Utc::now();
        let (expires, days_left) = {
            let w = self.0.world.lock();
            match w.certs.iter().find(|c| c.subject == hostname) {
                Some(cert) => (cert.not_after, (cert.not_after - now).num_days()),
                None => (now + chrono::Duration::days(MAIL_CERT_DAYS), MAIL_CERT_DAYS),
            }
        };
        Ok(MailCertificateStatus {
            state: "valid".into(),
            covers: vec![hostname],
            issuer: Some("C=US, O=Let's Encrypt, CN=R11".into()),
            expires_at: Some(stamp(expires)),
            days_left: Some(days_left),
            authority: Some("letsencrypt".into()),
            renews_at: Some(stamp(expires - chrono::Duration::days(30))),
            last_attempt: Some(stamp(now - chrono::Duration::days(90 - MAIL_CERT_DAYS))),
            next_attempt: Some(stamp(expires - chrono::Duration::days(30))),
        })
    }

    async fn certificate_renew(&self, ctx: &Ctx, s: StreamRef) -> PResult<MailCertificateRenewResult> {
        let hostname = {
            let w = self.0.world.lock();
            require_installed(&w)?;
            w.mail.hostname.clone()
        };
        progress(ctx, &*s, Duration::ZERO, format!("Checking the certificate for {hostname}…")).await?;
        progress(ctx, &*s, Duration::from_millis(350), format!("Covers {hostname}; {MAIL_CERT_DAYS} days left")).await?;
        let outcome = "The current certificate is valid and covers every name; nothing to do.".to_string();
        progress(ctx, &*s, Duration::from_millis(250), &outcome).await?;
        Ok(MailCertificateRenewResult { outcome })
    }

    async fn logs(&self, ctx: &Ctx, p: MailLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        {
            let w = self.0.world.lock();
            require_installed(&w)?;
        }
        // A follow should feel live even while the backlog is being read.
        if p.follow {
            pause(ctx, Duration::from_millis(50)).await?;
        }
        logs::tail(
            &self.0,
            ctx,
            &*s,
            TailRequest {
                source: logs::SOURCE_MAIL.into(),
                lines: p.lines,
                follow: p.follow,
                query: p.query,
                ..Default::default()
            },
        )
        .await
    }
}
