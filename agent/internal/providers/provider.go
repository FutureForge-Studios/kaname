package providers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
)

/* ------------------------------------------------------------------ *
 * The provider seam (KD-010).
 *
 * Everything above this line is protocol; everything below it is a
 * syscall. Two implementations satisfy these interfaces: `linux`, which
 * talks to systemd, the container socket, procfs and the filesystem,
 * and `sim`, a deterministic fake host that makes the whole product
 * developable and e2e-testable without a Linux box.
 *
 * A provider never receives a command string. Every method takes a
 * typed, already-validated parameter struct, which is what makes
 * command injection structurally impossible rather than a code-review
 * responsibility.
 * ------------------------------------------------------------------ */

// ErrUnsupported is returned by any sub-interface method the host cannot
// serve. The RPC layer turns it into the `unsupported` error code so the
// UI can grey the module out instead of failing at call time.
var ErrUnsupported = errors.New("not supported on this host")

// Sentinel errors the RPC layer maps onto contract error codes.
var (
	ErrNotFound           = errors.New("not found")
	ErrPermissionDenied   = errors.New("permission denied")
	ErrConflict           = errors.New("conflict")
	ErrPreconditionFailed = errors.New("precondition failed")
	ErrInvalidParams      = errors.New("invalid parameters")
)

// ExecError reports that a real binary ran and failed. Output is the
// excerpt the operator needs to understand why — it reaches the panel as
// the error's `output` field, which is the difference between "exec
// failed" and the line nginx actually printed.
type ExecError struct {
	Op     string
	Output string
	Err    error
}

func (e *ExecError) Error() string {
	if e.Err == nil {
		return e.Op + " failed"
	}
	return fmt.Sprintf("%s: %v", e.Op, e.Err)
}

func (e *ExecError) Unwrap() error { return e.Err }

// Host capabilities, mirroring `serverCapability` in the contract. A
// host advertises these in the hello frame and the hub gates methods on
// them.
const (
	CapSystemd  = "systemd"
	CapDocker   = "docker"
	CapPodman   = "podman"
	CapNginx    = "nginx"
	CapApache   = "apache"
	CapCaddy    = "caddy"
	CapPHP      = "php"
	CapNodeJS   = "nodejs"
	CapPython   = "python"
	CapMySQL    = "mysql"
	CapMariaDB  = "mariadb"
	CapPostgres = "postgres"
	CapMail     = "mail"
	CapDovecot  = "dovecot"
	CapPostfix  = "postfix"
	CapNftables = "nftables"
	CapIptables = "iptables"
	CapUfw      = "ufw"
	CapFail2ban = "fail2ban"
	CapCertbot  = "certbot"
	CapRestic   = "restic"
	CapSimulate = "simulated"
)

/* ------------------------------ streams ------------------------------ */

// Encoding marks how a chunk's bytes travel on the wire: text streams
// stay readable as utf8, binary payloads are base64.
type Encoding string

const (
	EncodingUTF8   Encoding = "utf8"
	EncodingBase64 Encoding = "base64"
)

// Stream carries the chunk traffic of a streaming method. Response
// streams only ever Send; bidirectional methods (upload, exec, pty) also
// Recv. Recv returns io.EOF once the peer has closed its side.
type Stream interface {
	Send(ctx context.Context, data []byte, enc Encoding) error
	Recv(ctx context.Context) ([]byte, error)
}

/* ------------------------------- events ------------------------------ */

// Event is an unsolicited push: a state change the control plane should
// not have to poll for. Topic is one of the contract's agent event
// topics; anything else is dropped by the hub.
type Event struct {
	Topic string
	Data  any
}

/* --------------------------- sub-interfaces --------------------------- */

type System interface {
	Info(ctx context.Context) (SystemInfo, error)
	Metrics(ctx context.Context) (MetricsSample, error)
	Reboot(ctx context.Context, p SystemRebootParams) error
	ListPackages(ctx context.Context, p PackagesListParams) ([]PackageInfo, error)
	UpgradePackages(ctx context.Context, p PackagesUpgradeParams, s Stream) (PackagesUpgradeResult, error)
	// SelfUpdate replaces the agent binary and restarts. A provider with
	// no real binary behind it — the simulator — returns ErrUnsupported
	// rather than pretending, because a fleet that lies about this
	// operation is worse than one that cannot do it.
	SelfUpdate(ctx context.Context, p SelfUpdateParams, s Stream) (SelfUpdateResult, error)
}

type Services interface {
	List(ctx context.Context, p ServiceListParams) ([]ServiceInfo, error)
	Status(ctx context.Context, unit string) (ServiceInfo, error)
	Start(ctx context.Context, unit string) (ServiceInfo, error)
	Stop(ctx context.Context, unit string) (ServiceInfo, error)
	Restart(ctx context.Context, unit string) (ServiceInfo, error)
	Reload(ctx context.Context, unit string) (ServiceInfo, error)
	Enable(ctx context.Context, unit string) (ServiceInfo, error)
	Disable(ctx context.Context, unit string) (ServiceInfo, error)
	Logs(ctx context.Context, p ServiceLogsParams, s Stream) ([]LogRecord, error)
}

type Processes interface {
	List(ctx context.Context, p ProcessListParams) (ProcessListResult, error)
	Tree(ctx context.Context, p ProcessTreeParams) ([]ProcessNode, error)
	Signal(ctx context.Context, p SignalParams) error
}

type Containers interface {
	List(ctx context.Context, p ContainerListParams) ([]ContainerInfo, error)
	Inspect(ctx context.Context, id string) (ContainerInspectResult, error)
	Start(ctx context.Context, id string) (ContainerInfo, error)
	Stop(ctx context.Context, p ContainerStopParams) (ContainerInfo, error)
	Restart(ctx context.Context, p ContainerStopParams) (ContainerInfo, error)
	Remove(ctx context.Context, p ContainerRemoveParams) error
	Logs(ctx context.Context, p ContainerLogsParams, s Stream) ([]LogRecord, error)
	Exec(ctx context.Context, p ContainerExecParams, s Stream) error
	Images(ctx context.Context) ([]ImageInfo, error)
	Prune(ctx context.Context, p ContainerPruneParams) (ContainerPruneResult, error)
}

type Files interface {
	List(ctx context.Context, p FsListParams) (DirectoryListing, error)
	Stat(ctx context.Context, path string) (FileEntry, error)
	Read(ctx context.Context, p FsReadParams) (FsReadResult, error)
	Write(ctx context.Context, p FsWriteParams) (FileEntry, error)
	Mkdir(ctx context.Context, p FsMkdirParams) (FileEntry, error)
	Move(ctx context.Context, p FsMoveParams) (FileEntry, error)
	Copy(ctx context.Context, p FsCopyParams) (FileEntry, error)
	Remove(ctx context.Context, p FsRemoveParams) (int, error)
	Chmod(ctx context.Context, p FsChmodParams) error
	Chown(ctx context.Context, p FsChownParams) error
	Archive(ctx context.Context, p FsArchiveParams, s Stream) (FileEntry, error)
	Extract(ctx context.Context, p FsExtractParams, s Stream) (int, error)
	Download(ctx context.Context, p FsDownloadParams, s Stream) (FsDownloadResult, error)
	Upload(ctx context.Context, p FsUploadParams, s Stream) (FileEntry, error)
	Usage(ctx context.Context, p FsUsageParams) (FsUsageResult, error)
}

type Logs interface {
	Sources(ctx context.Context) ([]LogSource, error)
	Tail(ctx context.Context, p LogTailParams, s Stream) ([]LogRecord, error)
}

type Certs interface {
	List(ctx context.Context) ([]CertificateInfo, error)
	Issue(ctx context.Context, p CertIssueParams, s Stream) (CertIssueResult, error)
	Renew(ctx context.Context, p CertRenewParams, s Stream) (CertRenewResult, error)
	Revoke(ctx context.Context, p CertRevokeParams) error
	Install(ctx context.Context, p CertInstallParams) (CertInstallResult, error)
}

type Sites interface {
	List(ctx context.Context) ([]SiteInfo, error)
	Create(ctx context.Context, p SiteCreateParams) (SiteConfigResult, error)
	Update(ctx context.Context, p SiteUpdateParams) (SiteConfigResult, error)
	Remove(ctx context.Context, p SiteRemoveParams) error
	TestConfig(ctx context.Context) (SiteTestConfigResult, error)
	Reload(ctx context.Context) error
}

// DNS resolves from the managed host's own vantage point, which is what
// makes a mail-authentication check meaningful: what the panel's
// resolver sees is not what the mail server sees.
type DNS interface {
	Resolve(ctx context.Context, p DNSResolveParams) ([]ResolvedRecord, error)
}

type Mail interface {
	ListMailboxes(ctx context.Context, p MailboxListParams) ([]MailboxInfo, error)
	CreateMailbox(ctx context.Context, p MailboxCreateParams) error
	UpdateMailbox(ctx context.Context, p MailboxUpdateParams) error
	DeleteMailbox(ctx context.Context, p MailboxDeleteParams) error
	SetMailboxPassword(ctx context.Context, p MailboxPasswordParams) error
	ApplyAliases(ctx context.Context, p MailAliasApplyParams) error
	ApplyForwarders(ctx context.Context, p MailForwarderApplyParams) error
	ReadDKIM(ctx context.Context, p MailDkimReadParams) (DkimKeyInfo, error)
	Queue(ctx context.Context, p MailQueueListParams) ([]MailQueueEntry, error)
	Logs(ctx context.Context, p MailLogsParams, s Stream) ([]LogRecord, error)
}

type Databases interface {
	Instances(ctx context.Context) ([]DbInstanceInfo, error)
	ListDatabases(ctx context.Context, p DbEngineParams) ([]DbDatabaseInfo, error)
	CreateDatabase(ctx context.Context, p DbDatabaseCreateParams) (DbDatabaseInfo, error)
	DeleteDatabase(ctx context.Context, p DbDatabaseDeleteParams) error
	ListUsers(ctx context.Context, p DbEngineParams) ([]DbUserInfo, error)
	CreateUser(ctx context.Context, p DbUserCreateParams) (DbUserInfo, error)
	UpdateUser(ctx context.Context, p DbUserUpdateParams) (DbUserInfo, error)
	DeleteUser(ctx context.Context, p DbUserDeleteParams) error
	ApplyGrant(ctx context.Context, p DbGrantApplyParams) error
	Size(ctx context.Context, p DbSizeParams) (DbSizeResult, error)
	Dump(ctx context.Context, p DbDumpParams, s Stream) (DbDumpResult, error)
	Restore(ctx context.Context, p DbRestoreParams, s Stream) error
}

type Firewall interface {
	Status(ctx context.Context) (FirewallStatus, error)
	List(ctx context.Context) ([]FirewallRuleInfo, error)
	Apply(ctx context.Context, p FwApplyParams) (FwApplyResult, error)
	Confirm(ctx context.Context, p FwConfirmParams) error
	Ban(ctx context.Context, p FwBanParams) error
	Unban(ctx context.Context, p FwUnbanParams) error
	Bans(ctx context.Context) ([]BanEntry, error)
	Threats(ctx context.Context, p FwThreatsParams) ([]ThreatObservation, error)
}

type SSH interface {
	ListKeys(ctx context.Context, p SSHKeysListParams) ([]SSHKeyInfo, error)
	ApplyKeys(ctx context.Context, p SSHKeysApplyParams) (int, error)
	ReadConfig(ctx context.Context) (SSHConfigInfo, error)
	ApplyConfig(ctx context.Context, p SSHConfigApplyParams) (SSHConfigApplyResult, error)
	Sessions(ctx context.Context) ([]SSHSessionInfo, error)
}

type Backups interface {
	Run(ctx context.Context, p BackupRunParams, s Stream) (BackupSnapshotInfo, error)
	List(ctx context.Context, p BackupListParams) ([]BackupSnapshotInfo, error)
	Restore(ctx context.Context, p BackupRestoreParams, s Stream) (BackupRestoreResult, error)
	Verify(ctx context.Context, p BackupVerifyParams, s Stream) (BackupVerifyResult, error)
	Prune(ctx context.Context, p BackupPruneParams, s Stream) (BackupPruneResult, error)
}

// PTY is the one place where free-form execution is allowed at all, so
// it is the one place that is separately permissioned, ticketed and
// recorded by the control plane (KD-013). Sessions are keyed by the id
// of the stream that opened them.
type PTY interface {
	// Open runs the shell until the stream closes, the session is closed
	// or ctx is cancelled. It reports the child pid as soon as it starts.
	Open(ctx context.Context, sessionID string, p PtyOpenParams, s Stream) (PtyOpenResult, error)
	Resize(ctx context.Context, sessionID string, p PtyResizeParams) error
	Close(ctx context.Context, sessionID string) error
}

/* ------------------------------ aggregate ----------------------------- */

// Provider is the whole host, as the agent is allowed to see it. Every
// sub-interface is always non-nil; a host that lacks a capability
// returns ErrUnsupported from that sub-interface's methods rather than
// handing back a nil interface for the caller to trip over.
type Provider interface {
	Capabilities() []string
	Host(ctx context.Context) (HostInfo, error)

	// Events is drained while a connection is up and ignored the rest of
	// the time, so implementations must never block on a send: a state
	// change nobody is listening for is dropped, not queued forever.
	Events() <-chan Event

	System() System
	Services() Services
	Processes() Processes
	Containers() Containers
	Files() Files
	Logs() Logs
	Certs() Certs
	Sites() Sites
	DNS() DNS
	Mail() Mail
	Databases() Databases
	Firewall() Firewall
	SSH() SSH
	Backups() Backups
	PTY() PTY

	Close() error
}

/* ------------------------------ selection ----------------------------- */

// Options is everything a provider needs that comes from the process
// rather than from the host.
type Options struct {
	AgentVersion string
	StateDir     string
	Logger       *slog.Logger
}

// Factory builds a provider. Implementations register one in their
// init, so the binary's provider set is decided by which packages are
// linked in rather than by a switch statement here.
type Factory func(ctx context.Context, opts Options) (Provider, error)

var (
	factoriesMu sync.RWMutex
	factories   = map[string]Factory{}
)

// Register makes a provider selectable by name. It panics on a duplicate
// name because that can only ever be a programming error at init time.
func Register(name string, f Factory) {
	factoriesMu.Lock()
	defer factoriesMu.Unlock()
	if _, exists := factories[name]; exists {
		panic(fmt.Sprintf("providers: %q registered twice", name))
	}
	factories[name] = f
}

// New builds the named provider.
func New(ctx context.Context, name string, opts Options) (Provider, error) {
	factoriesMu.RLock()
	f, ok := factories[name]
	factoriesMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("provider %q is not available in this build (have: %v)", name, Registered())
	}
	p, err := f(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("open %s provider: %w", name, err)
	}
	return p, nil
}

// Registered lists the provider names linked into this binary.
func Registered() []string {
	factoriesMu.RLock()
	defer factoriesMu.RUnlock()
	names := make([]string, 0, len(factories))
	for name := range factories {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
