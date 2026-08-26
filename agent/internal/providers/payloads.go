package providers

import "encoding/json"

/* ------------------------------------------------------------------ *
 * Wire payloads.
 *
 * Every struct here mirrors a schema in @kaname/contract's agent
 * package. The json tags are the contract: they are what the control
 * plane parses with Zod, so a rename on either side is a runtime
 * mismatch, not a compile error. Keep them literal.
 * ------------------------------------------------------------------ */

/* ------------------------------- host -------------------------------- */

// HostInfo is the `host` block of the hello frame and of an enrollment
// request. It is the subset of SystemInfo that identifies a machine.
type HostInfo struct {
	Hostname  string `json:"hostname"`
	MachineID string `json:"machine_id"`
	OS        string `json:"os"`
	OSVersion string `json:"os_version"`
	Arch      string `json:"arch"`
	Kernel    string `json:"kernel"`
	BootTime  string `json:"boot_time"`
	Simulated bool   `json:"simulated"`
}

type SystemInfo struct {
	Hostname       string `json:"hostname"`
	MachineID      string `json:"machine_id"`
	OS             string `json:"os"`
	OSVersion      string `json:"os_version"`
	OSFamily       string `json:"os_family"`
	Arch           string `json:"arch"`
	Kernel         string `json:"kernel"`
	BootTime       string `json:"boot_time"`
	UptimeSeconds  int64  `json:"uptime_seconds"`
	CPUModel       string `json:"cpu_model"`
	CPUCores       int    `json:"cpu_cores"`
	MemoryTotal    int64  `json:"memory_total"`
	SwapTotal      int64  `json:"swap_total"`
	Virtualization string `json:"virtualization,omitempty"`
	Timezone       string `json:"timezone"`
	AgentVersion   string `json:"agent_version"`
	Simulated      bool   `json:"simulated"`
}

type DiskUsage struct {
	Mount       string  `json:"mount"`
	Device      string  `json:"device"`
	Fstype      string  `json:"fstype"`
	Total       int64   `json:"total"`
	Used        int64   `json:"used"`
	Available   int64   `json:"available"`
	UsedPercent float64 `json:"used_percent"`
	InodesTotal *int64  `json:"inodes_total,omitempty"`
	InodesUsed  *int64  `json:"inodes_used,omitempty"`
}

type MetricsSample struct {
	Ts            string      `json:"ts"`
	CPUPercent    float64     `json:"cpu_percent"`
	CPUPerCore    []float64   `json:"cpu_per_core,omitempty"`
	MemoryUsed    int64       `json:"memory_used"`
	MemoryTotal   int64       `json:"memory_total"`
	MemoryCached  *int64      `json:"memory_cached,omitempty"`
	SwapUsed      int64       `json:"swap_used"`
	SwapTotal     int64       `json:"swap_total"`
	Load1         float64     `json:"load1"`
	Load5         float64     `json:"load5"`
	Load15        float64     `json:"load15"`
	Processes     int         `json:"processes"`
	Disks         []DiskUsage `json:"disks"`
	NetRxBytes    int64       `json:"net_rx_bytes"`
	NetTxBytes    int64       `json:"net_tx_bytes"`
	NetRxRate     float64     `json:"net_rx_rate"`
	NetTxRate     float64     `json:"net_tx_rate"`
	DiskReadRate  *float64    `json:"disk_read_rate,omitempty"`
	DiskWriteRate *float64    `json:"disk_write_rate,omitempty"`
}

type PackageInfo struct {
	Name             string  `json:"name"`
	InstalledVersion string  `json:"installed_version"`
	AvailableVersion *string `json:"available_version"`
	Security         bool    `json:"security"`
}

/* ------------------------------ services ----------------------------- */

type ServiceInfo struct {
	Unit          string   `json:"unit"`
	Description   string   `json:"description"`
	LoadState     string   `json:"load_state"`
	ActiveState   string   `json:"active_state"`
	SubState      string   `json:"sub_state"`
	Enabled       bool     `json:"enabled"`
	MainPID       *int     `json:"main_pid"`
	MemoryCurrent *int64   `json:"memory_current"`
	CPUUsageNs    *float64 `json:"cpu_usage_ns"`
	ActiveSince   *string  `json:"active_since"`
	RestartCount  int      `json:"restart_count"`
}

/* ----------------------------- processes ----------------------------- */

type ProcessInfo struct {
	PID           int     `json:"pid"`
	PPID          int     `json:"ppid"`
	User          string  `json:"user"`
	Command       string  `json:"command"`
	Cmdline       string  `json:"cmdline"`
	State         string  `json:"state"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemoryRSS     int64   `json:"memory_rss"`
	MemoryPercent float64 `json:"memory_percent"`
	Threads       int     `json:"threads"`
	StartedAt     string  `json:"started_at"`
	Nice          int     `json:"nice"`
}

// ProcessNode flattens to ProcessInfo plus `depth`, matching the
// extended schema `process.tree` returns.
type ProcessNode struct {
	ProcessInfo
	Depth int `json:"depth"`
}

/* ----------------------------- containers ---------------------------- */

type ContainerPort struct {
	ContainerPort int     `json:"container_port"`
	HostPort      *int    `json:"host_port"`
	HostIP        *string `json:"host_ip"`
	Protocol      string  `json:"protocol"`
}

type ContainerMount struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	RW          bool   `json:"rw"`
}

type ContainerInfo struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	ImageID      string            `json:"image_id"`
	State        string            `json:"state"`
	Status       string            `json:"status"`
	CreatedAt    string            `json:"created_at"`
	StartedAt    *string           `json:"started_at"`
	Ports        []ContainerPort   `json:"ports"`
	Labels       map[string]string `json:"labels"`
	Networks     []string          `json:"networks"`
	Mounts       []ContainerMount  `json:"mounts"`
	RestartCount int               `json:"restart_count"`
	CPUPercent   *float64          `json:"cpu_percent"`
	MemoryUsage  *int64            `json:"memory_usage"`
	MemoryLimit  *int64            `json:"memory_limit"`
	Runtime      string            `json:"runtime"`
}

type ImageInfo struct {
	ID        string   `json:"id"`
	Tags      []string `json:"tags"`
	Size      int64    `json:"size"`
	CreatedAt string   `json:"created_at"`
	InUse     bool     `json:"in_use"`
}

/* ------------------------------- files ------------------------------- */

type FileEntry struct {
	Name       string  `json:"name"`
	Path       string  `json:"path"`
	Kind       string  `json:"kind"`
	Size       int64   `json:"size"`
	Mode       string  `json:"mode"`
	Owner      string  `json:"owner"`
	Group      string  `json:"group"`
	UID        int     `json:"uid"`
	GID        int     `json:"gid"`
	ModifiedAt string  `json:"modified_at"`
	LinkTarget *string `json:"link_target"`
	ChildCount *int    `json:"child_count"`
	Mime       *string `json:"mime"`
	IsEditable bool    `json:"is_editable"`
}

type DirectoryListing struct {
	Path      string      `json:"path"`
	Parent    *string     `json:"parent"`
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
	Total     int         `json:"total"`
}

type StorageUsageEntry struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Inodes *int64 `json:"inodes"`
	Kind   string `json:"kind"`
	Label  string `json:"label,omitempty"`
}

/* -------------------------------- logs ------------------------------- */

type LogSource struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Kind           string `json:"kind"`
	Ref            string `json:"ref"`
	Size           *int64 `json:"size"`
	SupportsFollow bool   `json:"supports_follow"`
}

type LogRecord struct {
	Ts      string            `json:"ts"`
	Level   string            `json:"level"`
	Source  string            `json:"source"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
	Cursor  string            `json:"cursor,omitempty"`
}

/* --------------------------- mail / dns / db ------------------------- */

type DkimKeyInfo struct {
	Selector  string `json:"selector"`
	PublicKey string `json:"public_key"`
	KeyBits   int    `json:"key_bits"`
	TxtValue  string `json:"txt_value"`
}

type MailQueueEntry struct {
	QueueID   string   `json:"queue_id"`
	From      string   `json:"from"`
	To        []string `json:"to"`
	Size      int64    `json:"size"`
	ArrivedAt string   `json:"arrived_at"`
	Reason    *string  `json:"reason"`
}

type MailboxInfo struct {
	Address    string  `json:"address"`
	QuotaBytes int64   `json:"quota_bytes"`
	UsedBytes  int64   `json:"used_bytes"`
	Active     bool    `json:"active"`
	LastLogin  *string `json:"last_login"`
}

type ResolvedRecord struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Values   []string `json:"values"`
	TTL      *int     `json:"ttl"`
	Resolver string   `json:"resolver"`
}

type DbInstanceInfo struct {
	Engine         string `json:"engine"`
	Version        string `json:"version"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Reachable      bool   `json:"reachable"`
	UptimeSeconds  *int64 `json:"uptime_seconds"`
	Connections    *int   `json:"connections"`
	MaxConnections *int   `json:"max_connections"`
	DataSize       *int64 `json:"data_size"`
}

type DbDatabaseInfo struct {
	Name       string  `json:"name"`
	Owner      *string `json:"owner"`
	Encoding   string  `json:"encoding"`
	Collation  *string `json:"collation"`
	SizeBytes  int64   `json:"size_bytes"`
	TableCount int     `json:"table_count"`
}

type DbUserInfo struct {
	Username    string  `json:"username"`
	HostPattern string  `json:"host_pattern"`
	AuthPlugin  *string `json:"auth_plugin"`
	IsSuperuser bool    `json:"is_superuser"`
	CanLogin    bool    `json:"can_login"`
}

/* ------------------------------ security ----------------------------- */

type FirewallRuleInfo struct {
	ID          string  `json:"id"`
	Priority    int     `json:"priority"`
	Action      string  `json:"action"`
	Direction   string  `json:"direction"`
	Protocol    string  `json:"protocol"`
	PortSpec    *string `json:"port_spec"`
	Source      *string `json:"source"`
	Destination *string `json:"destination"`
	Comment     *string `json:"comment"`
	Enabled     bool    `json:"enabled"`
	Backend     string  `json:"backend"`
}

type BanEntry struct {
	IP        string  `json:"ip"`
	Jail      string  `json:"jail"`
	BannedAt  string  `json:"banned_at"`
	ExpiresAt *string `json:"expires_at"`
	Attempts  int     `json:"attempts"`
}

type ThreatObservation struct {
	Kind      string `json:"kind"`
	SourceIP  string `json:"source_ip"`
	Target    string `json:"target"`
	Attempts  int    `json:"attempts"`
	FirstSeen string `json:"first_seen"`
	LastSeen  string `json:"last_seen"`
	Sample    string `json:"sample,omitempty"`
}

type SSHKeyInfo struct {
	Fingerprint string `json:"fingerprint"`
	Type        string `json:"type"`
	Comment     string `json:"comment"`
	PublicKey   string `json:"public_key"`
	User        string `json:"user"`
}

type SSHConfigInfo struct {
	Port                   int      `json:"port"`
	PermitRootLogin        string   `json:"permit_root_login"`
	PasswordAuthentication bool     `json:"password_authentication"`
	PubkeyAuthentication   bool     `json:"pubkey_authentication"`
	MaxAuthTries           int      `json:"max_auth_tries"`
	AllowUsers             []string `json:"allow_users"`
	AllowGroups            []string `json:"allow_groups"`
	X11Forwarding          bool     `json:"x11_forwarding"`
}

type SSHSessionInfo struct {
	User        string `json:"user"`
	FromIP      string `json:"from_ip"`
	TTY         string `json:"tty"`
	PID         int    `json:"pid"`
	StartedAt   string `json:"started_at"`
	IdleSeconds int    `json:"idle_seconds"`
}

/* ------------------------------ backups ------------------------------ */

type BackupSnapshotInfo struct {
	ID        string   `json:"id"`
	TakenAt   string   `json:"taken_at"`
	Bytes     int64    `json:"bytes"`
	FileCount int      `json:"file_count"`
	Paths     []string `json:"paths"`
	Tags      []string `json:"tags"`
	Verified  bool     `json:"verified"`
}

/* ------------------------------- sites ------------------------------- */

type SiteInfo struct {
	Name           string   `json:"name"`
	Webroot        string   `json:"webroot"`
	ServerNames    []string `json:"server_names"`
	Runtime        string   `json:"runtime"`
	RuntimeVersion *string  `json:"runtime_version"`
	Enabled        bool     `json:"enabled"`
	ConfigPath     string   `json:"config_path"`
}

/* ---------------------------- certificates --------------------------- */

type CertificateInfo struct {
	Subject   string   `json:"subject"`
	Sans      []string `json:"sans"`
	Issuer    string   `json:"issuer"`
	NotBefore string   `json:"not_before"`
	NotAfter  string   `json:"not_after"`
	Path      string   `json:"path"`
	KeyType   string   `json:"key_type"`
}

/* ================================================================== *
 * Method parameters and results.
 * ================================================================== */

// OK is the `{ ok: true }` result shared by mutations with nothing to
// report back.
type OK struct {
	OK bool `json:"ok"`
}

// Ok is the only legal value of the OK result.
var Ok = OK{OK: true}

/* ------------------------------- system ------------------------------ */

type SystemRebootParams struct {
	DelaySeconds int `json:"delay_seconds"`
}

type PackagesListParams struct {
	UpgradableOnly bool `json:"upgradable_only"`
}

type PackagesListResult struct {
	Packages []PackageInfo `json:"packages"`
}

type PackagesUpgradeParams struct {
	Names        []string `json:"names"`
	SecurityOnly bool     `json:"security_only"`
}

type PackagesUpgradeResult struct {
	Upgraded       []string `json:"upgraded"`
	RebootRequired bool     `json:"reboot_required"`
}

type SelfUpdateParams struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

// SelfUpdateResult is answered by the process that is about to be
// replaced, which is why Restarting is the strongest claim it makes.
// Whether the new build actually came back is something only the
// control plane can observe, and it does: reconnecting at the new
// version is what counts as success.
type SelfUpdateResult struct {
	PreviousVersion    string `json:"previous_version"`
	Version            string `json:"version"`
	Restarting         bool   `json:"restarting"`
	PreviousBinaryPath string `json:"previous_binary_path"`
}

/* ------------------------------ services ----------------------------- */

type ServiceListParams struct {
	Pattern string `json:"pattern,omitempty"`
	State   string `json:"state,omitempty"`
}

type ServiceListResult struct {
	Services []ServiceInfo `json:"services"`
}

type UnitParams struct {
	Unit string `json:"unit"`
}

type ServiceLogsParams struct {
	Unit   string `json:"unit"`
	Lines  int    `json:"lines"`
	Follow bool   `json:"follow"`
	Since  string `json:"since,omitempty"`
}

// LogRecordsResult is the settled result of every log-streaming method:
// the chunks carry the live lines, this carries what was already there.
type LogRecordsResult struct {
	Records []LogRecord `json:"records"`
}

/* ----------------------------- processes ----------------------------- */

type ProcessListParams struct {
	Sort  string `json:"sort"`
	Limit int    `json:"limit"`
	User  string `json:"user,omitempty"`
}

type ProcessListResult struct {
	Processes []ProcessInfo `json:"processes"`
	Total     int           `json:"total"`
}

type ProcessTreeParams struct {
	PID *int `json:"pid,omitempty"`
}

type ProcessTreeResult struct {
	Processes []ProcessNode `json:"processes"`
}

type SignalParams struct {
	PID    int    `json:"pid"`
	Signal string `json:"signal"`
}

/* ----------------------------- containers ---------------------------- */

type ContainerListParams struct {
	All       bool `json:"all"`
	WithStats bool `json:"with_stats"`
}

type ContainerListResult struct {
	Containers []ContainerInfo `json:"containers"`
}

type ContainerIDParams struct {
	ID string `json:"id"`
}

type ContainerInspectResult struct {
	Container ContainerInfo   `json:"container"`
	Raw       json.RawMessage `json:"raw"`
}

// ContainerStopParams is shared by container.stop and container.restart,
// which take the same shape.
type ContainerStopParams struct {
	ID             string `json:"id"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

type ContainerRemoveParams struct {
	ID            string `json:"id"`
	Force         bool   `json:"force"`
	RemoveVolumes bool   `json:"remove_volumes"`
}

type ContainerLogsParams struct {
	ID     string `json:"id"`
	Lines  int    `json:"lines"`
	Follow bool   `json:"follow"`
	Since  string `json:"since,omitempty"`
}

type ContainerExecParams struct {
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type ImageListResult struct {
	Images []ImageInfo `json:"images"`
}

type ContainerPruneParams struct {
	IncludeImages  bool `json:"include_images"`
	IncludeVolumes bool `json:"include_volumes"`
}

type ContainerPruneResult struct {
	ReclaimedBytes int64    `json:"reclaimed_bytes"`
	Removed        []string `json:"removed"`
}

/* ------------------------------- files ------------------------------- */

type FsListParams struct {
	Path       string `json:"path"`
	ShowHidden bool   `json:"show_hidden"`
	Limit      int    `json:"limit"`
}

type FsStatParams struct {
	Path string `json:"path"`
}

type FsReadParams struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"max_bytes"`
}

type FsReadResult struct {
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Truncated bool   `json:"truncated"`
	Size      int64  `json:"size"`
}

type FsWriteParams struct {
	Path          string `json:"path"`
	Content       string `json:"content"`
	Encoding      string `json:"encoding"`
	Mode          string `json:"mode,omitempty"`
	CreateParents bool   `json:"create_parents"`
}

type FsMkdirParams struct {
	Path    string `json:"path"`
	Mode    string `json:"mode,omitempty"`
	Parents bool   `json:"parents"`
}

type FsMoveParams struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite"`
}

type FsCopyParams struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite"`
}

type FsRemoveParams struct {
	Paths     []string `json:"paths"`
	Recursive bool     `json:"recursive"`
}

type FsRemoveResult struct {
	Removed int `json:"removed"`
}

type FsChmodParams struct {
	Paths     []string `json:"paths"`
	Mode      string   `json:"mode"`
	Recursive bool     `json:"recursive"`
}

type FsChownParams struct {
	Paths     []string `json:"paths"`
	Owner     string   `json:"owner,omitempty"`
	Group     string   `json:"group,omitempty"`
	Recursive bool     `json:"recursive"`
}

type FsArchiveParams struct {
	Paths       []string `json:"paths"`
	Destination string   `json:"destination"`
	Format      string   `json:"format"`
}

type FsExtractParams struct {
	Path        string `json:"path"`
	Destination string `json:"destination"`
	Overwrite   bool   `json:"overwrite"`
}

type FsExtractResult struct {
	Extracted int `json:"extracted"`
}

type FsDownloadParams struct {
	Path string `json:"path"`
}

type FsDownloadResult struct {
	Size int64  `json:"size"`
	Mime string `json:"mime"`
}

type FsUploadParams struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode,omitempty"`
	Overwrite bool   `json:"overwrite"`
}

type FsUsageParams struct {
	Path  string `json:"path"`
	Depth int    `json:"depth"`
}

type FsUsageResult struct {
	Entries []StorageUsageEntry `json:"entries"`
	Total   int64               `json:"total"`
}

/* ------------------------------- sites ------------------------------- */

type SiteListResult struct {
	Sites []SiteInfo `json:"sites"`
}

type SiteCreateParams struct {
	Name           string   `json:"name"`
	ServerNames    []string `json:"server_names"`
	Webroot        string   `json:"webroot"`
	Runtime        string   `json:"runtime"`
	RuntimeVersion string   `json:"runtime_version,omitempty"`
	Upstream       string   `json:"upstream,omitempty"`
	ForceHTTPS     bool     `json:"force_https"`
	Owner          string   `json:"owner,omitempty"`
}

type SiteUpdateParams struct {
	Name           string   `json:"name"`
	ServerNames    []string `json:"server_names,omitempty"`
	Webroot        string   `json:"webroot,omitempty"`
	RuntimeVersion string   `json:"runtime_version,omitempty"`
	Upstream       string   `json:"upstream,omitempty"`
	ForceHTTPS     *bool    `json:"force_https,omitempty"`
	Enabled        *bool    `json:"enabled,omitempty"`
}

type SiteConfigResult struct {
	ConfigPath string `json:"config_path"`
}

type SiteRemoveParams struct {
	Name          string `json:"name"`
	DeleteWebroot bool   `json:"delete_webroot"`
}

type SiteTestConfigResult struct {
	Valid  bool   `json:"valid"`
	Output string `json:"output"`
}

/* ---------------------------- certificates --------------------------- */

type CertListResult struct {
	Certificates []CertificateInfo `json:"certificates"`
}

type CertIssueParams struct {
	Domains   []string `json:"domains"`
	Challenge string   `json:"challenge"`
	Email     string   `json:"email"`
	Webroot   string   `json:"webroot,omitempty"`
	KeyType   string   `json:"key_type"`
	Staging   bool     `json:"staging"`
}

type CertIssueResult struct {
	Subject  string   `json:"subject"`
	Sans     []string `json:"sans"`
	NotAfter string   `json:"not_after"`
	Path     string   `json:"path"`
}

type CertRenewParams struct {
	Subject string `json:"subject"`
	Force   bool   `json:"force"`
}

type CertRenewResult struct {
	NotAfter string `json:"not_after"`
}

type CertRevokeParams struct {
	Subject string `json:"subject"`
	Reason  string `json:"reason"`
}

type CertInstallParams struct {
	Subject        string `json:"subject"`
	CertificatePEM string `json:"certificate_pem"`
	KeyPEM         string `json:"key_pem"`
	ChainPEM       string `json:"chain_pem,omitempty"`
}

type CertInstallResult struct {
	Path string `json:"path"`
}

/* -------------------------------- dns -------------------------------- */

type DNSResolveParams struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Resolver string `json:"resolver,omitempty"`
}

type DNSResolveResult struct {
	Records []ResolvedRecord `json:"records"`
}

/* -------------------------------- mail ------------------------------- */

type MailboxListParams struct {
	Domain string `json:"domain,omitempty"`
}

type MailboxListResult struct {
	Mailboxes []MailboxInfo `json:"mailboxes"`
}

type MailboxCreateParams struct {
	Address     string `json:"address"`
	Password    string `json:"password"`
	QuotaBytes  int64  `json:"quota_bytes"`
	DisplayName string `json:"display_name,omitempty"`
}

type MailboxUpdateParams struct {
	Address     string  `json:"address"`
	QuotaBytes  *int64  `json:"quota_bytes,omitempty"`
	Active      *bool   `json:"active,omitempty"`
	DisplayName *string `json:"display_name,omitempty"`
}

type MailboxDeleteParams struct {
	Address       string `json:"address"`
	DeleteMaildir bool   `json:"delete_maildir"`
}

type MailboxPasswordParams struct {
	Address  string `json:"address"`
	Password string `json:"password"`
}

type MailAlias struct {
	Address      string   `json:"address"`
	Destinations []string `json:"destinations"`
}

type MailAliasApplyParams struct {
	Domain  string      `json:"domain"`
	Aliases []MailAlias `json:"aliases"`
}

type MailForwarder struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
	KeepCopy    bool   `json:"keep_copy"`
}

type MailForwarderApplyParams struct {
	Domain     string          `json:"domain"`
	Forwarders []MailForwarder `json:"forwarders"`
}

type MailDkimReadParams struct {
	Domain string `json:"domain"`
}

type MailQueueListParams struct {
	Limit int `json:"limit"`
}

type MailQueueListResult struct {
	Entries []MailQueueEntry `json:"entries"`
}

type MailLogsParams struct {
	Lines  int    `json:"lines"`
	Follow bool   `json:"follow"`
	Query  string `json:"query,omitempty"`
}

/* ------------------------------ databases ---------------------------- */

type DbInstanceListResult struct {
	Instances []DbInstanceInfo `json:"instances"`
}

type DbEngineParams struct {
	Engine string `json:"engine"`
}

type DbDatabaseListResult struct {
	Databases []DbDatabaseInfo `json:"databases"`
}

type DbDatabaseCreateParams struct {
	Engine    string `json:"engine"`
	Name      string `json:"name"`
	Encoding  string `json:"encoding,omitempty"`
	Collation string `json:"collation,omitempty"`
	Owner     string `json:"owner,omitempty"`
}

type DbDatabaseDeleteParams struct {
	Engine string `json:"engine"`
	Name   string `json:"name"`
}

type DbUserListResult struct {
	Users []DbUserInfo `json:"users"`
}

type DbUserCreateParams struct {
	Engine      string `json:"engine"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	HostPattern string `json:"host_pattern"`
}

type DbUserUpdateParams struct {
	Engine      string `json:"engine"`
	Username    string `json:"username"`
	HostPattern string `json:"host_pattern"`
	Password    string `json:"password,omitempty"`
	CanLogin    *bool  `json:"can_login,omitempty"`
}

type DbUserDeleteParams struct {
	Engine      string `json:"engine"`
	Username    string `json:"username"`
	HostPattern string `json:"host_pattern"`
}

type DbGrantApplyParams struct {
	Engine      string   `json:"engine"`
	Database    string   `json:"database"`
	Username    string   `json:"username"`
	HostPattern string   `json:"host_pattern"`
	Privileges  []string `json:"privileges"`
}

type DbSizeParams struct {
	Engine string `json:"engine"`
	Name   string `json:"name"`
}

type DbSizeResult struct {
	SizeBytes  int64 `json:"size_bytes"`
	TableCount int   `json:"table_count"`
}

type DbDumpParams struct {
	Engine      string `json:"engine"`
	Name        string `json:"name"`
	Destination string `json:"destination"`
	Compress    bool   `json:"compress"`
}

type DbDumpResult struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
}

type DbRestoreParams struct {
	Engine       string `json:"engine"`
	Name         string `json:"name"`
	Source       string `json:"source"`
	DropExisting bool   `json:"drop_existing"`
}

/* ------------------------------ firewall ----------------------------- */

type FirewallStatus struct {
	Backend         string `json:"backend"`
	Enabled         bool   `json:"enabled"`
	DefaultInbound  string `json:"default_inbound"`
	DefaultOutbound string `json:"default_outbound"`
	RuleCount       int    `json:"rule_count"`
}

type FwListResult struct {
	Rules []FirewallRuleInfo `json:"rules"`
}

type FirewallRule struct {
	Priority    int     `json:"priority"`
	Action      string  `json:"action"`
	Direction   string  `json:"direction"`
	Protocol    string  `json:"protocol"`
	PortSpec    *string `json:"port_spec"`
	Source      *string `json:"source"`
	Destination *string `json:"destination"`
	Comment     *string `json:"comment"`
}

type FwApplyParams struct {
	DefaultInbound  string         `json:"default_inbound"`
	DefaultOutbound string         `json:"default_outbound"`
	Rules           []FirewallRule `json:"rules"`
	RollbackSeconds int            `json:"rollback_seconds"`
}

type FwApplyResult struct {
	Applied       int     `json:"applied"`
	RollbackToken *string `json:"rollback_token"`
}

type FwConfirmParams struct {
	RollbackToken string `json:"rollback_token"`
}

type FwBanParams struct {
	Target          string `json:"target"`
	DurationSeconds int    `json:"duration_seconds"`
	Reason          string `json:"reason,omitempty"`
}

type FwUnbanParams struct {
	Target string `json:"target"`
}

type FwBansResult struct {
	Bans []BanEntry `json:"bans"`
}

type FwThreatsParams struct {
	Since string `json:"since,omitempty"`
	Limit int    `json:"limit"`
}

type FwThreatsResult struct {
	Observations []ThreatObservation `json:"observations"`
}

/* -------------------------------- ssh -------------------------------- */

type SSHKeysListParams struct {
	User string `json:"user,omitempty"`
}

type SSHKeysListResult struct {
	Keys []SSHKeyInfo `json:"keys"`
}

type SSHAuthorizedKey struct {
	PublicKey string `json:"public_key"`
	Comment   string `json:"comment"`
}

type SSHKeysApplyParams struct {
	User string             `json:"user"`
	Keys []SSHAuthorizedKey `json:"keys"`
}

type SSHKeysApplyResult struct {
	Applied int `json:"applied"`
}

// SSHConfigApplyParams is sshConfigInfo.partial(): every field is
// optional, so an unset one means "leave this directive alone".
type SSHConfigApplyParams struct {
	Port                   *int     `json:"port,omitempty"`
	PermitRootLogin        *string  `json:"permit_root_login,omitempty"`
	PasswordAuthentication *bool    `json:"password_authentication,omitempty"`
	PubkeyAuthentication   *bool    `json:"pubkey_authentication,omitempty"`
	MaxAuthTries           *int     `json:"max_auth_tries,omitempty"`
	AllowUsers             []string `json:"allow_users,omitempty"`
	AllowGroups            []string `json:"allow_groups,omitempty"`
	X11Forwarding          *bool    `json:"x11_forwarding,omitempty"`
	RollbackSeconds        int      `json:"rollback_seconds"`
}

type SSHConfigApplyResult struct {
	RollbackToken *string `json:"rollback_token"`
}

type SSHSessionsResult struct {
	Sessions []SSHSessionInfo `json:"sessions"`
}

/* ------------------------------ backups ------------------------------ */

type BackupDatabase struct {
	Engine string `json:"engine"`
	Name   string `json:"name"`
}

type BackupRunParams struct {
	Repository  string           `json:"repository"`
	PasswordRef string           `json:"password_ref"`
	Paths       []string         `json:"paths"`
	Exclude     []string         `json:"exclude"`
	Tags        []string         `json:"tags"`
	Databases   []BackupDatabase `json:"databases"`
}

type BackupListParams struct {
	Repository  string `json:"repository"`
	PasswordRef string `json:"password_ref"`
}

type BackupListResult struct {
	Snapshots []BackupSnapshotInfo `json:"snapshots"`
}

type BackupRestoreParams struct {
	Repository  string   `json:"repository"`
	PasswordRef string   `json:"password_ref"`
	SnapshotID  string   `json:"snapshot_id"`
	Target      string   `json:"target"`
	Include     []string `json:"include"`
	Overwrite   bool     `json:"overwrite"`
}

type BackupRestoreResult struct {
	RestoredFiles int   `json:"restored_files"`
	Bytes         int64 `json:"bytes"`
}

type BackupVerifyParams struct {
	Repository  string `json:"repository"`
	PasswordRef string `json:"password_ref"`
	SnapshotID  string `json:"snapshot_id"`
}

type BackupVerifyResult struct {
	OK     bool     `json:"ok"`
	Errors []string `json:"errors"`
}

type BackupPruneParams struct {
	Repository  string `json:"repository"`
	PasswordRef string `json:"password_ref"`
	KeepLast    int    `json:"keep_last"`
	KeepDaily   int    `json:"keep_daily"`
	KeepWeekly  int    `json:"keep_weekly"`
	KeepMonthly int    `json:"keep_monthly"`
}

type BackupPruneResult struct {
	Removed        int   `json:"removed"`
	ReclaimedBytes int64 `json:"reclaimed_bytes"`
}

/* -------------------------------- logs ------------------------------- */

type LogSourcesResult struct {
	Sources []LogSource `json:"sources"`
}

type LogTailParams struct {
	Source string `json:"source"`
	Lines  int    `json:"lines"`
	Follow bool   `json:"follow"`
	Level  string `json:"level,omitempty"`
	Query  string `json:"query,omitempty"`
	Since  string `json:"since,omitempty"`
}

/* -------------------------------- pty -------------------------------- */

type PtyOpenParams struct {
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Cwd  string `json:"cwd,omitempty"`
	User string `json:"user,omitempty"`
	Term string `json:"term"`
}

type PtyResizeParams struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type PtyOpenResult struct {
	PID int `json:"pid"`
}
