import { z } from "zod";

/* ------------------------------------------------------------------ *
 * The two independent status axes (PLAN.md 2.6)
 * ------------------------------------------------------------------ */

/** "Can we reach the box." */
export const agentConnection = z.enum([
  "connected",
  "degraded",
  "disconnected",
  "never_enrolled",
  "revoked",
]);
export type AgentConnection = z.infer<typeof agentConnection>;

/** "Is the box OK." */
export const healthState = z.enum(["healthy", "warning", "critical", "unknown"]);
export type HealthState = z.infer<typeof healthState>;

/* ------------------------------------------------------------------ *
 * Fleet
 * ------------------------------------------------------------------ */

export const serverCapability = z.enum([
  "systemd",
  "docker",
  "podman",
  "nginx",
  "apache",
  "caddy",
  "php",
  "nodejs",
  "python",
  "mysql",
  "mariadb",
  "postgres",
  "mail",
  "dovecot",
  "postfix",
  "nftables",
  "iptables",
  "ufw",
  "fail2ban",
  "certbot",
  "restic",
  "simulated",
]);
export type ServerCapability = z.infer<typeof serverCapability>;

export const osFamily = z.enum(["debian", "ubuntu", "rhel", "fedora", "alpine", "arch", "other"]);
export const cpuArch = z.enum(["amd64", "arm64", "arm", "riscv64", "other"]);

export const serviceActiveState = z.enum([
  "active",
  "reloading",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "unknown",
]);
export type ServiceActiveState = z.infer<typeof serviceActiveState>;

export const containerState = z.enum([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
  "unknown",
]);
export type ContainerState = z.infer<typeof containerState>;

export const processState = z.enum([
  "running",
  "sleeping",
  "disk_sleep",
  "stopped",
  "zombie",
  "idle",
  "unknown",
]);

export const signalName = z.enum([
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGINT",
  "SIGUSR1",
  "SIGUSR2",
  "SIGSTOP",
  "SIGCONT",
]);
export type SignalName = z.infer<typeof signalName>;

/* ------------------------------------------------------------------ *
 * Websites
 * ------------------------------------------------------------------ */

export const siteRuntime = z.enum(["static", "php", "node", "python", "proxy", "container"]);
export type SiteRuntime = z.infer<typeof siteRuntime>;

export const siteStatus = z.enum(["active", "suspended", "provisioning", "error"]);

export const dnsRecordType = z.enum([
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "SRV",
  "CAA",
  "PTR",
  "ALIAS",
]);
export type DnsRecordType = z.infer<typeof dnsRecordType>;

export const dnsProvider = z.enum(["cloudflare", "route53", "digitalocean", "manual"]);
export type DnsProvider = z.infer<typeof dnsProvider>;

export const managedBy = z.enum(["kaname", "external"]);

export const certChallenge = z.enum(["http-01", "dns-01"]);
export const certStatus = z.enum([
  "none",
  "pending",
  "active",
  "expiring",
  "expired",
  "revoked",
  "failed",
]);
export type CertStatus = z.infer<typeof certStatus>;

export const deploymentStatus = z.enum([
  "queued",
  "building",
  "deploying",
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof deploymentStatus>;

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

export const fileKind = z.enum(["file", "directory", "symlink", "socket", "fifo", "device"]);
export type FileKind = z.infer<typeof fileKind>;

export const archiveFormat = z.enum(["tar.gz", "tar.zst", "zip"]);
export const transferProtocol = z.enum(["sftp", "ftps"]);

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

export const mailAuthCheck = z.enum([
  "mx",
  "host_spf",
  "spf",
  "dkim",
  "dmarc",
  "ptr",
  "tls",
  "proxy_exposure",
]);
export type MailAuthCheck = z.infer<typeof mailAuthCheck>;

export const checkStatus = z.enum(["pass", "warn", "fail", "unknown"]);
export type CheckStatus = z.infer<typeof checkStatus>;

export const mailDeliveryStatus = z.enum([
  "sent",
  "deferred",
  "bounced",
  "rejected",
  "received",
  "quarantined",
]);

/* ------------------------------------------------------------------ *
 * Databases
 * ------------------------------------------------------------------ */

export const dbEngine = z.enum(["mysql", "mariadb", "postgres"]);
export type DbEngine = z.infer<typeof dbEngine>;

export const dbPrivilege = z.enum([
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
]);

/* ------------------------------------------------------------------ *
 * Security
 * ------------------------------------------------------------------ */

export const firewallAction = z.enum(["allow", "deny", "reject"]);
export const firewallDirection = z.enum(["inbound", "outbound"]);
export const firewallProtocol = z.enum(["tcp", "udp", "icmp", "any"]);

export const threatKind = z.enum([
  "ssh_bruteforce",
  "web_bruteforce",
  "mail_bruteforce",
  "port_scan",
  "malformed_request",
  "rate_abuse",
  "known_bad_ip",
]);
export type ThreatKind = z.infer<typeof threatKind>;

export const threatDisposition = z.enum(["observed", "banned", "ignored"]);

export const auditActorType = z.enum(["user", "api_key", "agent", "system"]);
export type AuditActorType = z.infer<typeof auditActorType>;

/* ------------------------------------------------------------------ *
 * Backups
 * ------------------------------------------------------------------ */

export const backupDestinationKind = z.enum(["s3", "b2", "sftp", "local"]);
export const backupScopeKind = z.enum(["files", "databases", "mail", "config", "panel"]);
export const backupRunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
export type BackupRunStatus = z.infer<typeof backupRunStatus>;

/* ------------------------------------------------------------------ *
 * Logs & monitoring
 * ------------------------------------------------------------------ */

export const logLevel = z.enum(["trace", "debug", "info", "notice", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof logLevel>;

export const logSourceKind = z.enum([
  "journald",
  "file",
  "container",
  "nginx_access",
  "nginx_error",
  "mail",
  "panel",
]);
export type LogSourceKind = z.infer<typeof logSourceKind>;

export const metricName = z.enum([
  "cpu",
  "memory",
  "swap",
  "disk",
  "disk_io",
  "network_rx",
  "network_tx",
  "load1",
  "load5",
  "load15",
  "processes",
]);
export type MetricName = z.infer<typeof metricName>;

export const timeRange = z.enum(["1h", "6h", "24h", "7d", "30d", "90d"]);
export type TimeRange = z.infer<typeof timeRange>;

export const alertSeverity = z.enum(["info", "warning", "critical"]);
export const alertComparator = z.enum(["gt", "gte", "lt", "lte"]);
export const alertState = z.enum(["ok", "pending", "firing", "resolved", "silenced"]);
