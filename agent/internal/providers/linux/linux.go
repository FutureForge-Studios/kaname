//go:build linux

// Package linux is the real provider: the only code in Kaname that ever
// touches systemd, the container socket, procfs, the firewall or the
// filesystem of a managed host.
//
// Two rules hold everywhere in this package. Every exec goes through an
// argv slice, never a string handed to a shell, so command injection is
// structurally impossible rather than a code-review responsibility. And
// anything the host cannot serve returns providers.ErrUnsupported, so the
// panel greys the feature out instead of showing a failure.
package linux

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

const (
	// How often the background watcher re-samples the host for the state
	// changes the control plane should not have to poll for.
	watchInterval = 30 * time.Second
	// A filesystem past this mark raises disk.pressure once, and again
	// only after it has dropped back below it.
	diskPressurePercent = 90
	// Cap on the stderr excerpt attached to a failed exec; the contract
	// caps the wire field at 16 KiB.
	execOutputLimit = 16 << 10
)

func init() {
	providers.Register("linux", func(ctx context.Context, opts providers.Options) (providers.Provider, error) {
		return open(ctx, opts)
	})
}

/* ------------------------------ provider ----------------------------- */

type provider struct {
	opts providers.Options
	log  *slog.Logger

	caps    map[string]struct{}
	capList []string

	docker   *dockerClient
	rollback *rollbackGuard
	names    *nameCache

	events chan providers.Event

	// Counters only become rates against a previous reading, so the last
	// sample outlives the call that took it.
	metricsMu   sync.Mutex
	lastMetrics *metricsSnapshot

	ptyMu    sync.Mutex
	ptys     map[string]*ptySession
	watchers sync.WaitGroup
	cancel   context.CancelFunc
}

func open(ctx context.Context, opts providers.Options) (providers.Provider, error) {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	p := &provider{
		opts:     opts,
		log:      log,
		caps:     map[string]struct{}{},
		rollback: newRollbackGuard(log),
		names:    newNameCache(),
		events:   make(chan providers.Event, 64),
		ptys:     map[string]*ptySession{},
	}

	p.docker = discoverContainerRuntime(ctx)
	p.detect()

	// The watcher outlives the caller's startup context: it must keep
	// running for as long as the provider is open, not for as long as the
	// call that built it.
	watchCtx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.watchers.Add(1)
	go func() {
		defer p.watchers.Done()
		p.watch(watchCtx)
	}()

	log.Info("linux provider ready", "capabilities", p.capList)
	return p, nil
}

func (p *provider) Capabilities() []string { return p.capList }

func (p *provider) Events() <-chan providers.Event { return p.events }

// Host is the identity block of the hello frame: the subset of the
// system info that names this machine to the control plane.
func (p *provider) Host(ctx context.Context) (providers.HostInfo, error) {
	info, err := systemOps{p}.Info(ctx)
	if err != nil {
		return providers.HostInfo{}, err
	}
	return providers.HostInfo{
		Hostname:  info.Hostname,
		MachineID: info.MachineID,
		OS:        info.OS,
		OSVersion: info.OSVersion,
		Arch:      info.Arch,
		Kernel:    info.Kernel,
		BootTime:  info.BootTime,
	}, nil
}

func (p *provider) System() providers.System         { return systemOps{p} }
func (p *provider) Services() providers.Services     { return serviceOps{p} }
func (p *provider) Processes() providers.Processes   { return processOps{p} }
func (p *provider) Containers() providers.Containers { return containerOps{p} }
func (p *provider) Files() providers.Files           { return fileOps{p} }
func (p *provider) Logs() providers.Logs             { return logOps{p} }
func (p *provider) Certs() providers.Certs           { return certOps{p} }
func (p *provider) Sites() providers.Sites           { return siteOps{p} }
func (p *provider) DNS() providers.DNS               { return dnsOps{p} }
func (p *provider) Mail() providers.Mail             { return mailOps{p} }
func (p *provider) Databases() providers.Databases   { return databaseOps{p} }
func (p *provider) Firewall() providers.Firewall     { return firewallOps{p} }
func (p *provider) SSH() providers.SSH               { return sshOps{p} }
func (p *provider) Backups() providers.Backups       { return backupOps{p} }
func (p *provider) PTY() providers.PTY               { return ptyOps{p} }

func (p *provider) Close() error {
	if p.cancel != nil {
		p.cancel()
	}
	p.closeAllPTYs()
	p.rollback.stop()
	p.watchers.Wait()
	return nil
}

func (p *provider) has(capability string) bool {
	_, ok := p.caps[capability]
	return ok
}

// require is the single gate every sub-interface uses, so a host without
// a daemon answers `unsupported` instead of failing somewhere deeper.
func (p *provider) require(capability string) error {
	if p.has(capability) {
		return nil
	}
	return fmt.Errorf("%s is not installed: %w", capability, providers.ErrUnsupported)
}

/* --------------------------- capabilities ---------------------------- */

// detect probes for the daemons and binaries that decide what this host
// can actually serve. It runs once at startup and is what the hello
// frame advertises. The probing lives here; the decision it feeds lives
// in detectCapabilities, which is pure.
func (p *provider) detect() {
	runtime := ""
	if p.docker != nil {
		runtime = p.docker.runtime
	}

	p.capList = detectCapabilities(hostProbe{
		hasBinary:        hasBinary,
		fileExists:       fileExists,
		dirExists:        dirExists,
		containerRuntime: runtime,
	})

	p.caps = make(map[string]struct{}, len(p.capList))
	for _, capability := range p.capList {
		p.caps[capability] = struct{}{}
	}
}

/* ------------------------------ watching ----------------------------- */

// watch pushes the state changes the control plane would otherwise poll
// for. A change nobody is listening for is dropped rather than queued,
// because the provider must never block on a send.
func (p *provider) watch(ctx context.Context) {
	if p.docker != nil {
		p.watchers.Add(1)
		go func() {
			defer p.watchers.Done()
			p.docker.watchEvents(ctx, p.emit)
		}()
	}

	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()

	pressured := map[string]bool{}
	failed := map[string]struct{}{}

	for {
		p.sampleDiskPressure(ctx, pressured)
		if p.has(providers.CapSystemd) {
			p.sampleFailedUnits(ctx, failed)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (p *provider) emit(topic string, data any) {
	select {
	case p.events <- providers.Event{Topic: topic, Data: data}:
	default:
		p.log.Debug("dropped event, nobody is draining", "topic", topic)
	}
}

func (p *provider) sampleDiskPressure(ctx context.Context, pressured map[string]bool) {
	disks, err := collectDisks(ctx)
	if err != nil {
		return
	}
	for _, d := range disks {
		over := d.UsedPercent >= diskPressurePercent
		if over && !pressured[d.Mount] {
			p.emit(topicDiskPressure, d)
		}
		pressured[d.Mount] = over
	}
}

func (p *provider) sampleFailedUnits(ctx context.Context, failed map[string]struct{}) {
	units, err := p.Services().List(ctx, providers.ServiceListParams{State: "failed"})
	if err != nil {
		return
	}

	current := map[string]struct{}{}
	for _, unit := range units {
		current[unit.Unit] = struct{}{}
		if _, known := failed[unit.Unit]; !known {
			p.emit(topicServiceChanged, unit)
		}
	}
	for name := range failed {
		if _, still := current[name]; !still {
			if unit, err := p.Services().Status(ctx, name); err == nil {
				p.emit(topicServiceChanged, unit)
			}
		}
	}

	for name := range failed {
		delete(failed, name)
	}
	for name := range current {
		failed[name] = struct{}{}
	}
}

// Event topics, mirroring the contract's AGENT_EVENT_TOPICS. They are
// duplicated here rather than imported from rpc so the provider layer
// stays free of a dependency on the transport.
const (
	topicServiceChanged   = "service.changed"
	topicContainerChanged = "container.changed"
	topicDiskPressure     = "disk.pressure"
)

/* ------------------------------ execution ---------------------------- */

// execOptions is one child process. There is no Command string field on
// purpose: a shell never sees any of this.
type execOptions struct {
	Name  string
	Args  []string
	Stdin []byte
	// User runs the child under a POSIX account via setuid credentials,
	// which is how `psql` reaches a peer-authenticated cluster without a
	// shell in between.
	User string
	Dir  string
	Env  []string
}

// run executes a real binary with an argv slice and returns its stdout.
func run(ctx context.Context, name string, args ...string) (string, error) {
	return runWith(ctx, execOptions{Name: name, Args: args})
}

func runWith(ctx context.Context, o execOptions) (string, error) {
	cmd, err := command(ctx, o)
	if err != nil {
		return "", err
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return stdout.String(), execError(o.Name, pickOutput(stderr.String(), stdout.String()), err)
	}
	return stdout.String(), nil
}

// runCombined keeps a command's stdout and stderr in one string, for
// tools like `nginx -t` and `sshd -t` that report their verdict on
// stderr whether they pass or fail.
func runCombined(ctx context.Context, o execOptions) (string, error) {
	cmd, err := command(ctx, o)
	if err != nil {
		return "", err
	}

	var combined bytes.Buffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined

	if err := cmd.Run(); err != nil {
		return combined.String(), execError(o.Name, tailBytes(combined.String(), execOutputLimit), err)
	}
	return combined.String(), nil
}

// runStream relays a long job's output to the control plane as it
// happens — an operator watching a package upgrade sees the same lines
// the machine is printing — while still capturing it for parsing.
func runStream(ctx context.Context, s providers.Stream, o execOptions) (string, error) {
	cmd, err := command(ctx, o)
	if err != nil {
		return "", err
	}

	sink := &captureWriter{limit: execOutputLimit}
	writer := &streamWriter{ctx: ctx, stream: s, sink: sink}
	cmd.Stdout = writer
	cmd.Stderr = writer

	if err := cmd.Run(); err != nil {
		return sink.String(), execError(o.Name, sink.String(), err)
	}
	return sink.String(), nil
}

func command(ctx context.Context, o execOptions) (*exec.Cmd, error) {
	path, err := exec.LookPath(o.Name)
	if err != nil {
		return nil, fmt.Errorf("%s is not installed: %w", o.Name, providers.ErrUnsupported)
	}

	cmd := exec.CommandContext(ctx, path, o.Args...)
	cmd.Dir = o.Dir
	if o.Env != nil {
		cmd.Env = o.Env
	}
	if o.Stdin != nil {
		cmd.Stdin = bytes.NewReader(o.Stdin)
	}
	if o.User != "" {
		attr, err := credential(o.User)
		if err != nil {
			return nil, err
		}
		cmd.SysProcAttr = attr
	}
	return cmd, nil
}

// credential resolves a POSIX account to the uid/gid set a child should
// run with. Dropping privilege this way keeps `su -c "..."` — and the
// shell string it would need — out of the agent entirely.
func credential(name string) (*syscall.SysProcAttr, error) {
	account, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("look up user %s: %w", name, providers.ErrNotFound)
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return nil, fmt.Errorf("user %s has a non-numeric uid: %w", name, providers.ErrInvalidParams)
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return nil, fmt.Errorf("user %s has a non-numeric gid: %w", name, providers.ErrInvalidParams)
	}

	var supplementary []uint32
	if ids, err := account.GroupIds(); err == nil {
		for _, id := range ids {
			if parsed, err := strconv.Atoi(id); err == nil {
				supplementary = append(supplementary, uint32(parsed))
			}
		}
	}

	return &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: supplementary},
	}, nil
}

// cLocale pins child output to the C locale so column headings, dates
// and yes/no words stay parseable on a host configured in any language.
func cLocale() []string {
	return append(os.Environ(), "LC_ALL=C", "LANG=C")
}

func execError(op, output string, err error) error {
	return &providers.ExecError{Op: op, Output: strings.TrimSpace(output), Err: err}
}

func pickOutput(stderr, stdout string) string {
	if strings.TrimSpace(stderr) != "" {
		return tailBytes(stderr, execOutputLimit)
	}
	return tailBytes(stdout, execOutputLimit)
}

func tailBytes(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[len(s)-limit:]
}

// streamWriter forwards a child's output to the stream unchanged; the
// stream layer is what splits it into windowed chunks.
type streamWriter struct {
	ctx    context.Context
	stream providers.Stream
	sink   *captureWriter
}

func (w *streamWriter) Write(p []byte) (int, error) {
	if w.sink != nil {
		_, _ = w.sink.Write(p)
	}
	if w.stream == nil {
		return len(p), nil
	}
	if err := w.stream.Send(w.ctx, p, providers.EncodingUTF8); err != nil {
		return 0, err
	}
	return len(p), nil
}

// captureWriter keeps the tail of a child's output so a failure can be
// explained without buffering a whole `apt upgrade` in memory.
type captureWriter struct {
	buf   bytes.Buffer
	limit int
}

func (c *captureWriter) Write(p []byte) (int, error) {
	c.buf.Write(p)
	if c.limit > 0 && c.buf.Len() > 2*c.limit {
		kept := c.buf.Bytes()[c.buf.Len()-c.limit:]
		trimmed := append([]byte(nil), kept...)
		c.buf.Reset()
		c.buf.Write(trimmed)
	}
	return len(p), nil
}

func (c *captureWriter) String() string { return c.buf.String() }

/* ------------------------------ name cache --------------------------- */

// nameCache resolves uid/gid to names. A directory listing asks for the
// same handful of owners thousands of times, and /etc/passwd lookups are
// not free.
type nameCache struct {
	mu     sync.Mutex
	users  map[int]string
	groups map[int]string
}

func newNameCache() *nameCache {
	return &nameCache{users: map[int]string{}, groups: map[int]string{}}
}

func (c *nameCache) user(uid int) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name, ok := c.users[uid]; ok {
		return name
	}
	name := strconv.Itoa(uid)
	if account, err := user.LookupId(name); err == nil {
		name = account.Username
	}
	c.users[uid] = name
	return name
}

func (c *nameCache) group(gid int) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name, ok := c.groups[gid]; ok {
		return name
	}
	name := strconv.Itoa(gid)
	if group, err := user.LookupGroupId(name); err == nil {
		name = group.Name
	}
	c.groups[gid] = name
	return name
}

/* -------------------------------- files ------------------------------ */

// writeAtomic replaces a file in one step: a temp file in the same
// directory, fsynced, then renamed over the target. A crash mid-write
// therefore leaves the old file, never half the new one.
func writeAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("create temp beside %s: %w", path, err)
	}
	name := temp.Name()
	defer os.Remove(name)

	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return fmt.Errorf("chmod %s: %w", name, err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync %s: %w", name, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("install %s: %w", path, err)
	}
	return syncDir(dir)
}

// syncDir persists the rename itself, not just the bytes it points at.
func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open %s: %w", dir, err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil && !errors.Is(err, syscall.EINVAL) {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	return nil
}

/* ------------------------------- helpers ----------------------------- */

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func readTrimmed(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// firstExisting picks the first candidate that is present, which is how
// this package copes with distributions disagreeing about paths.
func firstExisting(candidates ...string) string {
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// isExitCode reports a specific exit status, which several package
// managers use to mean "nothing to do" rather than "failed".
func isExitCode(err error, code int) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == code
}
