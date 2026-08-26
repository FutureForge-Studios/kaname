package sim

import (
	"context"
	"hash/fnv"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The simulation provider (KD-010).
 *
 * A deterministic, stateful fake Debian host. The same hostname always
 * produces the same fleet, so tests are reproducible; starting a unit
 * really changes its state, writing a file really persists, stopping a
 * container really updates its status. This is not a toy — it is how
 * the whole product is developed, demoed and e2e-tested on a machine
 * with no Linux host, so it exercises the real protocol, the real hub
 * and the real job worker with only the syscalls faked.
 *
 * `simulated` is always in the capability list: a fake fleet that can
 * be mistaken for a real one is worse than no fake fleet.
 * ------------------------------------------------------------------ */

func init() {
	providers.Register("sim", New)
}

const (
	// simSeed is fixed so a given hostname always yields the same host.
	// "kaname" in ASCII, which makes an accidental change obvious.
	simSeed = 0x6b616e616d65

	eventBuffer          = 128
	threatInterval       = 45 * time.Second
	housekeepingInterval = 30 * time.Second

	// Mounts above this fraction push a disk.pressure event.
	diskPressureRatio = 0.85
	// Certificates inside this window push a cert.expiring event.
	certExpiryWindow = 21 * 24 * time.Hour
)

// Event topics this provider pushes, mirroring the contract's topic
// list. They are spelled out here rather than imported from the RPC
// layer so a provider never depends on the transport above it.
const (
	topicServiceChanged   = "service.changed"
	topicContainerChanged = "container.changed"
	topicThreatDetected   = "threat.detected"
	topicSSHSession       = "ssh.session"
	topicCertExpiring     = "cert.expiring"
	topicDiskPressure     = "disk.pressure"
)

// Sim is one fake host. Every sub-interface is served by a small struct
// embedding it, so all state lives in one place and one mutex.
type Sim struct {
	opts providers.Options
	log  *slog.Logger
	seed uint64
	id   identity
	fs   *memfs

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	events chan providers.Event

	mu        sync.Mutex
	startedAt time.Time
	bootTime  time.Time

	units  []*unit
	procs  []*process
	pidSeq int

	containers []*container
	images     []providers.ImageInfo

	sites []*site
	certs []*certificate

	mailboxes  []*providers.MailboxInfo
	aliases    map[string][]providers.MailAlias
	forwarders map[string][]providers.MailForwarder
	mailQueue  []providers.MailQueueEntry

	databases map[string][]*providers.DbDatabaseInfo
	dbUsers   map[string][]*providers.DbUserInfo
	dbGrants  map[string][]string

	fwEnabled  bool
	fwInbound  string
	fwOutbound string
	fwRules    []providers.FirewallRuleInfo
	rollbacks  map[string]*rollbackWindow
	bans       map[string]providers.BanEntry
	threats    map[string]*providers.ThreatObservation

	sshKeys     map[string][]providers.SSHKeyInfo
	sshConfig   providers.SSHConfigInfo
	sshSessions []providers.SSHSessionInfo

	snapshots map[string][]providers.BackupSnapshotInfo
	packages  []providers.PackageInfo

	ptys map[string]*ptySession

	// Certificates already announced this run, so one expiry is reported
	// once rather than every housekeeping tick.
	announced map[string]bool

	// written is outside the mutex on purpose: the filesystem accounts for
	// bytes while holding its own lock, and taking the host lock underneath
	// it would invert the order every other path uses.
	written atomic.Int64
}

// New builds the fake host. Its identity comes from the state directory
// rather than the machine hostname, because a development fleet runs
// several agents side by side on one box and four identical hosts is a
// worse demo than no demo. The directory is stable across restarts, so
// a given agent is still the same fake host every run.
func New(ctx context.Context, opts providers.Options) (providers.Provider, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	seed := seedFor(identitySource(opts.StateDir))

	now := time.Now().UTC()
	simCtx, cancel := context.WithCancel(ctx)

	s := &Sim{
		opts:      opts,
		log:       logger.With("provider", "sim"),
		seed:      seed,
		id:        buildIdentity(seed),
		ctx:       simCtx,
		cancel:    cancel,
		events:    make(chan providers.Event, eventBuffer),
		startedAt: now,
		announced: map[string]bool{},
	}
	s.bootTime = now.Add(-time.Duration(11+int64(mix(seed^0x0b)%37)) * 24 * time.Hour).
		Add(-time.Duration(mix(seed^0x0c)%86400) * time.Second)

	s.fs = buildFilesystem(s)
	s.buildUnits()
	s.buildContainers()
	s.buildProcesses()
	s.buildWeb()
	s.buildMail()
	s.buildDatabases()
	s.buildSecurity()
	s.buildBackups()
	s.buildPackages()
	s.ptys = map[string]*ptySession{}

	s.wg.Add(3)
	go s.threatLoop()
	go s.housekeepingLoop()
	go s.mailQueueLoop()

	s.log.Info("simulated host ready",
		"hostname", s.id.hostname,
		"units", len(s.units),
		"processes", len(s.procs),
		"containers", len(s.containers),
	)
	return s, nil
}

/* ------------------------------ identity ----------------------------- */

func (s *Sim) Capabilities() []string {
	return []string{
		providers.CapSystemd,
		providers.CapDocker,
		providers.CapNginx,
		providers.CapPHP,
		providers.CapNodeJS,
		providers.CapPython,
		providers.CapPostgres,
		providers.CapMariaDB,
		providers.CapMail,
		providers.CapPostfix,
		providers.CapDovecot,
		providers.CapNftables,
		providers.CapFail2ban,
		providers.CapCertbot,
		providers.CapRestic,
		providers.CapSimulate,
	}
}

func (s *Sim) Host(context.Context) (providers.HostInfo, error) {
	s.mu.Lock()
	boot := s.bootTime
	s.mu.Unlock()

	return providers.HostInfo{
		Hostname:  s.id.hostname,
		MachineID: s.id.machineID,
		OS:        s.id.os,
		OSVersion: s.id.osVersion,
		Arch:      s.id.arch,
		Kernel:    s.id.kernel,
		BootTime:  stamp(boot),
		Simulated: true,
	}, nil
}

func (s *Sim) Events() <-chan providers.Event { return s.events }

func (s *Sim) Close() error {
	s.cancel()
	s.wg.Wait()

	s.mu.Lock()
	sessions := make([]*ptySession, 0, len(s.ptys))
	for _, session := range s.ptys {
		sessions = append(sessions, session)
	}
	s.ptys = map[string]*ptySession{}
	s.mu.Unlock()

	for _, session := range sessions {
		session.stop()
	}
	return nil
}

/* -------------------------- sub-interfaces --------------------------- */

func (s *Sim) System() providers.System         { return simSystem{s} }
func (s *Sim) Services() providers.Services     { return simServices{s} }
func (s *Sim) Processes() providers.Processes   { return simProcesses{s} }
func (s *Sim) Containers() providers.Containers { return simContainers{s} }
func (s *Sim) Files() providers.Files           { return simFiles{s} }
func (s *Sim) Logs() providers.Logs             { return simLogs{s} }
func (s *Sim) Certs() providers.Certs           { return simCerts{s} }
func (s *Sim) Sites() providers.Sites           { return simSites{s} }
func (s *Sim) DNS() providers.DNS               { return simDNS{s} }
func (s *Sim) Mail() providers.Mail             { return simMail{s} }
func (s *Sim) Databases() providers.Databases   { return simDatabases{s} }
func (s *Sim) Firewall() providers.Firewall     { return simFirewall{s} }
func (s *Sim) SSH() providers.SSH               { return simSSH{s} }
func (s *Sim) Backups() providers.Backups       { return simBackups{s} }
func (s *Sim) PTY() providers.PTY               { return simPTY{s} }

/* ------------------------------- events ------------------------------ */

// emit never blocks: a state change nobody is listening for is dropped,
// which is what the Provider contract asks for.
func (s *Sim) emit(topic string, data any) {
	select {
	case s.events <- providers.Event{Topic: topic, Data: data}:
	default:
	}
}

/* ---------------------------- background ----------------------------- */

// threatLoop is the fake intrusion feed: a stable cast of source
// addresses keeps hammering sshd, so the Security module has something
// honest to render and the ban list has something to act on.
func (s *Sim) threatLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(threatInterval)
	defer ticker.Stop()

	var round int64
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}

		round++
		attacker := threatSources[int(mix(s.seed^uint64(round))%uint64(len(threatSources)))]
		burst := 3 + int(mix(s.seed^uint64(round)^0x51)%22)
		observation := s.recordThreat(attacker, burst)
		s.emit(topicThreatDetected, observation)
	}
}

// housekeepingLoop watches the two conditions an operator wants pushed
// rather than polled: a filling disk and a certificate running out.
func (s *Sim) housekeepingLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(housekeepingInterval)
	defer ticker.Stop()

	var round int64
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		round++

		now := time.Now().UTC()
		for _, disk := range s.disks(now) {
			if disk.UsedPercent >= diskPressureRatio*100 {
				s.emit(topicDiskPressure, map[string]any{
					"mount":        disk.Mount,
					"device":       disk.Device,
					"used_percent": round2(disk.UsedPercent),
					"available":    disk.Available,
					"total":        disk.Total,
				})
			}
		}

		s.mu.Lock()
		for _, cert := range s.certs {
			remaining := cert.notAfter.Sub(now)
			if remaining > certExpiryWindow || s.announced[cert.subject] {
				continue
			}
			s.announced[cert.subject] = true
			s.mu.Unlock()
			s.emit(topicCertExpiring, map[string]any{
				"subject":        cert.subject,
				"not_after":      stamp(cert.notAfter),
				"days_remaining": int(remaining.Hours() / 24),
			})
			s.mu.Lock()
		}
		s.mu.Unlock()

		// A login every few minutes keeps the SSH sessions list alive
		// instead of frozen at whatever the fleet was seeded with.
		if round%10 == 0 {
			s.rotateSSHSession(round)
		}
	}
}

/* --------------------------- determinism ----------------------------- */

// identitySource picks the most specific stable name available: the
// state directory when the caller gave one, the machine hostname
// otherwise.
func identitySource(stateDir string) string {
	if stateDir != "" {
		if base := filepath.Base(filepath.Clean(stateDir)); base != "." && base != string(filepath.Separator) {
			return base
		}
	}
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		return hostname
	}
	return "kaname-sim"
}

func seedFor(hostname string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(hostname))
	return h.Sum64() ^ simSeed
}

// rng returns a generator whose stream depends only on the host seed and
// the caller's tag, so adding a new generated collection never shifts an
// existing one.
func (s *Sim) rng(tag uint64) *rand.Rand {
	return rand.New(rand.NewPCG(s.seed^tag, mix(s.seed+tag)))
}

// mix is splitmix64: a cheap, well-distributed integer hash. Everything
// deterministic in this package ultimately comes from it.
func mix(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

// lattice is one deterministic sample in [-1, 1).
func lattice(seed uint64, n int64) float64 {
	return float64(mix(seed^uint64(n))>>11)/float64(uint64(1)<<52) - 1
}

// wave smoothly interpolates the lattice, which is what turns a hash
// into telemetry: charts read as movement rather than as noise.
func wave(seed uint64, x float64) float64 {
	i := math.Floor(x)
	f := x - i
	t := f * f * (3 - 2*f)
	a := lattice(seed, int64(i))
	b := lattice(seed, int64(i)+1)
	return a + (b-a)*t
}

// drift sums octaves of wave, giving a slow trend with fine texture on
// top — the shape real CPU and network graphs have.
func drift(seed uint64, x float64, octaves int) float64 {
	sum, amp, norm := 0.0, 1.0, 0.0
	for i := 0; i < octaves; i++ {
		sum += amp * wave(seed+uint64(i)*0x9e3779b9, x)
		norm += amp
		amp /= 2
		x *= 2.13
	}
	return sum / norm
}

// dayCycle is the workload's daily component: peaks at 14:00 UTC,
// troughs at 02:00.
func dayCycle(t time.Time) float64 {
	u := t.UTC()
	secs := float64(u.Hour()*3600 + u.Minute()*60 + u.Second())
	return math.Sin(2*math.Pi*(secs/86400-14.0/24) + math.Pi/2)
}

/* ------------------------------ helpers ------------------------------ */

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func stampPtr(t time.Time) *string {
	value := stamp(t)
	return &value
}

func clampf(v, lo, hi float64) float64 {
	return math.Min(math.Max(v, lo), hi)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func ptr[T any](v T) *T { return &v }

func pick[T any](seed uint64, n int64, options []T) T {
	return options[int(mix(seed^uint64(n))%uint64(len(options)))]
}

func hashString(value string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(value))
	return h.Sum64()
}
