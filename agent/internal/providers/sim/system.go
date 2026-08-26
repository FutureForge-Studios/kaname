package sim

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Host identity, telemetry and the process table.
 *
 * Metrics are a pure function of wall-clock time rather than a mutable
 * counter, so an extra on-demand sample never perturbs the series and
 * two agents seeded alike produce byte-identical charts.
 * ------------------------------------------------------------------ */

const (
	kiB int64 = 1 << 10
	miB int64 = 1 << 20
	giB int64 = 1 << 30
)

type identity struct {
	hostname       string
	machineID      string
	os             string
	osVersion      string
	osFamily       string
	arch           string
	kernel         string
	cpuModel       string
	cpuCores       int
	memoryTotal    int64
	swapTotal      int64
	virtualization string
	timezone       string
	privateIP      string
	publicIP       string
	domain         string
	mailDomain     string
	disks          []diskSpec
}

// diskSpec is a mount as it was at agent start plus the rate it grows,
// which is what makes "the disk is filling" visible on a chart instead
// of a static number.
type diskSpec struct {
	mount     string
	device    string
	fstype    string
	total     int64
	used      int64
	fillBytes float64 // per second
	inodes    int64
	inodesUse int64
}

var hostnamePool = []string{"web-01", "web-02", "app-01", "edge-01", "core-01", "node-01"}

var cpuPool = []string{
	"AMD EPYC 7763 64-Core Processor",
	"Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz",
	"AMD EPYC 9354P 32-Core Processor",
	"Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz",
}

func buildIdentity(seed uint64) identity {
	cores := []int{4, 8, 8, 16}[int(mix(seed^0x21)%4)]
	memory := int64([]int{8, 16, 16, 32}[int(mix(seed^0x22)%4)]) * giB

	id := identity{
		hostname:       pick(seed, 0x01, hostnamePool) + ".kaname.internal",
		machineID:      fmt.Sprintf("%016x%016x", mix(seed^0xa1), mix(seed^0xa2)),
		os:             "Debian GNU/Linux",
		osVersion:      "12 (bookworm)",
		osFamily:       "debian",
		arch:           "amd64",
		kernel:         "6.1.0-18-amd64",
		cpuModel:       pick(seed, 0x02, cpuPool),
		cpuCores:       cores,
		memoryTotal:    memory,
		swapTotal:      2 * giB,
		virtualization: "kvm",
		timezone:       "Etc/UTC",
		privateIP:      fmt.Sprintf("10.20.30.%d", 11+mix(seed^0x31)%40),
		publicIP:       fmt.Sprintf("192.0.2.%d", 20+mix(seed^0x32)%80),
		domain:         "example.com",
		mailDomain:     "example.com",
	}

	id.disks = []diskSpec{
		{
			mount: "/", device: "/dev/vda1", fstype: "ext4",
			total:     80 * giB,
			used:      33*giB + int64(mix(seed^0x41)%(4*uint64(giB))),
			fillBytes: 6 * float64(kiB),
			inodes:    5242880, inodesUse: 412_336,
		},
		{
			mount: "/boot", device: "/dev/vda2", fstype: "ext4",
			total:  1 * giB,
			used:   233 * miB,
			inodes: 65536, inodesUse: 318,
		},
		{
			mount: "/srv", device: "/dev/vdb1", fstype: "xfs",
			total:     200 * giB,
			used:      124*giB + int64(mix(seed^0x42)%(9*uint64(giB))),
			fillBytes: 18 * float64(kiB),
			inodes:    104857600, inodesUse: 1_884_205,
		},
		{
			// Deliberately hot: an operator should see the warning axis do
			// something on a fresh install rather than a wall of green.
			mount: "/var/lib/docker", device: "/dev/vdc1", fstype: "ext4",
			total:     40 * giB,
			used:      34*giB + 900*miB,
			fillBytes: 2 * float64(kiB),
			inodes:    2621440, inodesUse: 743_119,
		},
	}
	return id
}

/* ------------------------------- system ------------------------------ */

type simSystem struct{ *Sim }

func (s simSystem) Info(context.Context) (providers.SystemInfo, error) {
	s.mu.Lock()
	boot := s.bootTime
	s.mu.Unlock()

	return providers.SystemInfo{
		Hostname:       s.id.hostname,
		MachineID:      s.id.machineID,
		OS:             s.id.os,
		OSVersion:      s.id.osVersion,
		OSFamily:       s.id.osFamily,
		Arch:           s.id.arch,
		Kernel:         s.id.kernel,
		BootTime:       stamp(boot),
		UptimeSeconds:  int64(time.Since(boot).Seconds()),
		CPUModel:       s.id.cpuModel,
		CPUCores:       s.id.cpuCores,
		MemoryTotal:    s.id.memoryTotal,
		SwapTotal:      s.id.swapTotal,
		Virtualization: s.id.virtualization,
		Timezone:       s.id.timezone,
		AgentVersion:   s.opts.AgentVersion,
		Simulated:      true,
	}, nil
}

func (s simSystem) Metrics(context.Context) (providers.MetricsSample, error) {
	now := time.Now().UTC()
	return s.sample(now), nil
}

// sample synthesises one telemetry point: a daily sinusoid for the shape
// of a working day, fractal drift for texture, and a cumulative network
// counter that only ever goes up.
func (s *Sim) sample(now time.Time) providers.MetricsSample {
	t := float64(now.UnixMilli()) / 1000
	cycle := dayCycle(now)

	cpu := clampf(19+13*cycle+14*drift(s.seed^0x100, t/240, 3)+5*drift(s.seed^0x101, t/17, 2), 0.6, 99)

	perCore := make([]float64, 0, s.id.cpuCores)
	for core := 0; core < s.id.cpuCores; core++ {
		jitter := 11 * drift(s.seed^0x110^uint64(core), t/23, 2)
		perCore = append(perCore, round2(clampf(cpu+jitter, 0.2, 100)))
	}

	memRatio := clampf(0.44+0.07*cycle+0.06*drift(s.seed^0x120, t/900, 3), 0.18, 0.95)
	memUsed := int64(float64(s.id.memoryTotal) * memRatio)
	memCached := int64(float64(s.id.memoryTotal) * clampf(0.19+0.04*drift(s.seed^0x121, t/1200, 2), 0.05, 0.4))
	swapUsed := int64(float64(s.id.swapTotal) * clampf(0.04+0.03*drift(s.seed^0x122, t/3600, 2), 0, 0.6))

	cores := float64(s.id.cpuCores)
	load1 := clampf(cores*cpu/100*(1+0.18*drift(s.seed^0x130, t/60, 2)), 0.01, cores*3)
	load5 := clampf(cores*cpu/100*(1+0.12*drift(s.seed^0x131, t/300, 2)), 0.01, cores*3)
	load15 := clampf(cores*cpu/100*(1+0.08*drift(s.seed^0x132, t/900, 2)), 0.01, cores*3)

	rxRate := clampf(1.6*float64(miB)*(1+0.7*cycle)+0.9*float64(miB)*drift(s.seed^0x140, t/45, 3), 24*float64(kiB), 90*float64(miB))
	txRate := clampf(3.9*float64(miB)*(1+0.8*cycle)+1.6*float64(miB)*drift(s.seed^0x141, t/38, 3), 40*float64(kiB), 180*float64(miB))

	elapsed := now.Sub(s.bootTime).Seconds()
	rxTotal := int64(1.7*float64(miB)*elapsed) + int64(mix(s.seed^0x150)%uint64(giB))
	txTotal := int64(4.1*float64(miB)*elapsed) + int64(mix(s.seed^0x151)%uint64(giB))

	s.mu.Lock()
	processes := len(s.procs)
	s.mu.Unlock()

	return providers.MetricsSample{
		Ts:            stamp(now),
		CPUPercent:    round2(cpu),
		CPUPerCore:    perCore,
		MemoryUsed:    memUsed,
		MemoryTotal:   s.id.memoryTotal,
		MemoryCached:  ptr(memCached),
		SwapUsed:      swapUsed,
		SwapTotal:     s.id.swapTotal,
		Load1:         round2(load1),
		Load5:         round2(load5),
		Load15:        round2(load15),
		Processes:     processes,
		Disks:         s.disks(now),
		NetRxBytes:    rxTotal,
		NetTxBytes:    txTotal,
		NetRxRate:     round2(rxRate),
		NetTxRate:     round2(txRate),
		DiskReadRate:  ptr(round2(clampf(2.4*float64(miB)*(1+cycle)+float64(miB)*drift(s.seed^0x160, t/70, 2), 0, 400*float64(miB)))),
		DiskWriteRate: ptr(round2(clampf(6.1*float64(miB)*(1+cycle)+2*float64(miB)*drift(s.seed^0x161, t/55, 2), 0, 600*float64(miB)))),
	}
}

// disks grows every writable mount at its own rate and adds whatever the
// panel has written through the file manager, so deleting a large file
// really does give space back.
func (s *Sim) disks(now time.Time) []providers.DiskUsage {
	written := s.written.Load()
	elapsed := now.Sub(s.startedAt).Seconds()
	out := make([]providers.DiskUsage, 0, len(s.id.disks))

	for i, spec := range s.id.disks {
		used := spec.used + int64(spec.fillBytes*elapsed)
		if spec.mount == "/" {
			used += written
		}
		used += int64(float64(64*miB) * drift(s.seed^0x170^uint64(i), float64(now.Unix())/600, 2))
		if used < 0 {
			used = 0
		}
		if used > spec.total {
			used = spec.total
		}

		inodesUsed := spec.inodesUse
		out = append(out, providers.DiskUsage{
			Mount:       spec.mount,
			Device:      spec.device,
			Fstype:      spec.fstype,
			Total:       spec.total,
			Used:        used,
			Available:   spec.total - used,
			UsedPercent: round2(float64(used) / float64(spec.total) * 100),
			InodesTotal: ptr(spec.inodes),
			InodesUsed:  ptr(inodesUsed),
		})
	}
	return out
}

// Reboot is honoured rather than faked away: the boot time moves, every
// enabled unit comes back up and the process table is rebuilt, so the
// panel sees exactly what a real reboot looks like.
func (s simSystem) Reboot(ctx context.Context, p providers.SystemRebootParams) error {
	delay := time.Duration(p.DelaySeconds) * time.Second

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		select {
		case <-time.After(delay):
		case <-s.ctx.Done():
			return
		}

		s.mu.Lock()
		s.bootTime = time.Now().UTC()
		for _, u := range s.units {
			if u.info.Enabled {
				u.info.ActiveState = "active"
				u.info.SubState = "running"
				u.info.RestartCount = 0
				u.info.ActiveSince = stampPtr(s.bootTime)
			} else {
				u.info.ActiveState = "inactive"
				u.info.SubState = "dead"
				u.info.MainPID = nil
				u.info.ActiveSince = nil
			}
		}
		s.procs = nil
		s.pidSeq = 0
		s.mu.Unlock()

		s.buildProcesses()
		s.log.Info("simulated host rebooted")
		s.emit(topicServiceChanged, map[string]any{"unit": "*", "state": "active"})
	}()

	return nil
}

/* ------------------------------ packages ----------------------------- */

func (s *Sim) buildPackages() {
	type seedPkg struct {
		name      string
		installed string
		available string
		security  bool
	}
	catalogue := []seedPkg{
		{"base-files", "12.4+deb12u5", "", false},
		{"bash", "5.2.15-2+b7", "", false},
		{"ca-certificates", "20230311", "20240203", true},
		{"coreutils", "9.1-1", "", false},
		{"cron", "3.0pl1-162", "", false},
		{"curl", "7.88.1-10+deb12u5", "7.88.1-10+deb12u7", true},
		{"dbus", "1.14.10-1~deb12u1", "", false},
		{"docker-ce", "5:26.1.3-1~debian.12~bookworm", "5:26.1.4-1~debian.12~bookworm", false},
		{"docker-ce-cli", "5:26.1.3-1~debian.12~bookworm", "5:26.1.4-1~debian.12~bookworm", false},
		{"dovecot-core", "1:2.3.19.1+dfsg1-2.1", "", false},
		{"dovecot-imapd", "1:2.3.19.1+dfsg1-2.1", "", false},
		{"fail2ban", "1.0.2-2", "", false},
		{"git", "1:2.39.2-1.1", "1:2.39.5-0+deb12u1", true},
		{"gzip", "1.12-1", "", false},
		{"libc6", "2.36-9+deb12u7", "2.36-9+deb12u8", true},
		{"libssl3", "3.0.11-1~deb12u2", "3.0.13-1~deb12u1", true},
		{"linux-image-6.1.0-18-amd64", "6.1.76-1", "6.1.90-1", true},
		{"mariadb-server", "1:10.11.6-0+deb12u1", "", false},
		{"nftables", "1.0.6-2+deb12u2", "", false},
		{"nginx", "1.22.1-9", "1.22.1-9+deb12u1", false},
		{"openssh-server", "1:9.2p1-2+deb12u2", "1:9.2p1-2+deb12u3", true},
		{"openssl", "3.0.11-1~deb12u2", "3.0.13-1~deb12u1", true},
		{"php8.2-fpm", "8.2.20-1~deb12u1", "", false},
		{"postfix", "3.7.10-0+deb12u1", "", false},
		{"postgresql-16", "16.3-1.pgdg120+1", "16.4-1.pgdg120+1", false},
		{"python3", "3.11.2-1+b1", "", false},
		{"restic", "0.14.0-2", "", false},
		{"rsyslog", "8.2302.0-1", "", false},
		{"systemd", "252.22-1~deb12u1", "252.26-1~deb12u2", false},
		{"tzdata", "2024a-0+deb12u1", "", false},
		{"vim", "2:9.0.1378-2", "", false},
	}

	s.packages = make([]providers.PackageInfo, 0, len(catalogue))
	for _, p := range catalogue {
		info := providers.PackageInfo{Name: p.name, InstalledVersion: p.installed, Security: p.security}
		if p.available != "" {
			info.AvailableVersion = ptr(p.available)
		}
		s.packages = append(s.packages, info)
	}
}

func (s simSystem) ListPackages(_ context.Context, p providers.PackagesListParams) ([]providers.PackageInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.PackageInfo, 0, len(s.packages))
	for _, pkg := range s.packages {
		if p.UpgradableOnly && pkg.AvailableVersion == nil {
			continue
		}
		out = append(out, pkg)
	}
	return out, nil
}

func (s simSystem) UpgradePackages(ctx context.Context, p providers.PackagesUpgradeParams, stream providers.Stream) (providers.PackagesUpgradeResult, error) {
	wanted := map[string]bool{}
	for _, name := range p.Names {
		wanted[name] = true
	}

	s.mu.Lock()
	targets := make([]int, 0, len(s.packages))
	for i, pkg := range s.packages {
		if pkg.AvailableVersion == nil {
			continue
		}
		if len(wanted) > 0 && !wanted[pkg.Name] {
			continue
		}
		if p.SecurityOnly && !pkg.Security {
			continue
		}
		targets = append(targets, i)
	}
	s.mu.Unlock()

	if err := progress(ctx, stream, 0, "Reading package lists... Done"); err != nil {
		return providers.PackagesUpgradeResult{}, err
	}
	if err := progress(ctx, stream, 180*time.Millisecond, "Building dependency tree... Done"); err != nil {
		return providers.PackagesUpgradeResult{}, err
	}
	if len(targets) == 0 {
		_ = progress(ctx, stream, 0, "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.")
		return providers.PackagesUpgradeResult{Upgraded: []string{}}, nil
	}

	upgraded := make([]string, 0, len(targets))
	rebootRequired := false

	for _, index := range targets {
		s.mu.Lock()
		pkg := s.packages[index]
		next := *pkg.AvailableVersion
		s.packages[index].InstalledVersion = next
		s.packages[index].AvailableVersion = nil
		s.packages[index].Security = false
		s.mu.Unlock()

		upgraded = append(upgraded, pkg.Name)
		if strings.HasPrefix(pkg.Name, "linux-image") || pkg.Name == "libc6" || pkg.Name == "systemd" {
			rebootRequired = true
		}

		for _, line := range []string{
			fmt.Sprintf("Get:%d http://deb.debian.org/debian bookworm/main amd64 %s amd64 %s", len(upgraded), pkg.Name, next),
			fmt.Sprintf("Preparing to unpack .../%s_%s_amd64.deb ...", pkg.Name, next),
			fmt.Sprintf("Unpacking %s (%s) over (%s) ...", pkg.Name, next, pkg.InstalledVersion),
			fmt.Sprintf("Setting up %s (%s) ...", pkg.Name, next),
		} {
			if err := progress(ctx, stream, 120*time.Millisecond, line); err != nil {
				return providers.PackagesUpgradeResult{}, err
			}
		}
	}

	_ = progress(ctx, stream, 0, "Processing triggers for man-db (2.11.2-2) ...")
	_ = progress(ctx, stream, 0, fmt.Sprintf("%d upgraded, 0 newly installed, 0 to remove and 0 not upgraded.", len(upgraded)))
	if rebootRequired {
		_ = progress(ctx, stream, 0, "*** System restart required ***")
	}

	return providers.PackagesUpgradeResult{Upgraded: upgraded, RebootRequired: rebootRequired}, nil
}

/* ---------------------------- self-update ---------------------------- */

// SelfUpdate is refused outright. A simulated host has no binary to
// replace, and answering "restarting" would make the development fleet
// lie about a destructive operation — which is exactly the operation
// where a lie costs the most.
func (s simSystem) SelfUpdate(
	_ context.Context,
	_ providers.SelfUpdateParams,
	_ providers.Stream,
) (providers.SelfUpdateResult, error) {
	return providers.SelfUpdateResult{}, fmt.Errorf(
		"this is a simulated host with no agent binary to replace: %w",
		providers.ErrUnsupported,
	)
}

/* ----------------------------- processes ----------------------------- */

// process carries the fixed half of a row; the moving half (cpu, rss) is
// recomputed on read so `top`-style pages animate.
type process struct {
	info    providers.ProcessInfo
	unit    string
	cpuBase float64
	memBase int64
	frozen  bool
}

type procSpec struct {
	command string
	cmdline string
	user    string
	unit    string
	ppid    int
	rss     int64
	threads int
	state   string
	nice    int
	cpu     float64
}

var kernelThreads = []string{
	"rcu_gp", "rcu_par_gp", "slub_flushwq", "netns", "mm_percpu_wq", "rcu_tasks_kthre",
	"rcu_tasks_rude_", "rcu_tasks_trace", "ksoftirqd/0", "rcu_preempt", "migration/0",
	"idle_inject/0", "cpuhp/0", "cpuhp/1", "idle_inject/1", "migration/1", "ksoftirqd/1",
	"kdevtmpfs", "inet_frag_wq", "kauditd", "khungtaskd", "oom_reaper", "writeback",
	"kcompactd0", "ksmd", "khugepaged", "kintegrityd", "kblockd", "blkcg_punt_bio",
	"tpm_dev_wq", "ata_sff", "md", "edac-poller", "devfreq_wq", "watchdogd", "kswapd0",
	"ecryptfs-kthread", "kthrotld", "acpi_thermal_pm", "vfio-irqfd-cleanup", "mld",
	"ipv6_addrconf", "kstrp", "zswap-shrink", "charger_manager", "scsi_eh_0", "scsi_tmf_0",
	"scsi_eh_1", "scsi_tmf_1", "jbd2/vda1-8", "ext4-rsv-conver", "jbd2/vdb1-8",
	"cryptd", "kaluad", "kmpath_rdacd", "kmpathd", "kmpath_handlerd",
}

// targetProcesses keeps the table around the size of a real busy host,
// which is what makes the Processes page worth paginating.
const targetProcesses = 182

func (s *Sim) buildProcesses() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.pidSeq = 0
	s.procs = nil

	s.addProcessLocked(procSpec{
		command: "systemd", cmdline: "/sbin/init", user: "root", ppid: 0,
		rss: 12 * miB, threads: 1, state: "sleeping", cpu: 0.1,
	})
	s.addProcessLocked(procSpec{
		command: "kthreadd", cmdline: "[kthreadd]", user: "root", ppid: 0,
		threads: 1, state: "sleeping",
	})
	for _, name := range kernelThreads {
		s.addProcessLocked(procSpec{
			command: name, cmdline: "[" + name + "]", user: "root", ppid: 2,
			threads: 1, state: "idle", nice: -20,
		})
	}

	systemdPID := 1
	for _, spec := range s.userlandProcessesLocked(systemdPID) {
		s.addProcessLocked(spec)
	}

	for len(s.procs) < targetProcesses {
		n := len(s.procs)
		s.addProcessLocked(procSpec{
			command: fmt.Sprintf("kworker/u%d:%d-events_unbound", n%(2*s.id.cpuCores), n%9),
			cmdline: fmt.Sprintf("[kworker/u%d:%d-events_unbound]", n%(2*s.id.cpuCores), n%9),
			user:    "root", ppid: 2, threads: 1, state: "idle",
		})
	}

	s.syncUnitPIDsLocked()
}

// userlandProcessesLocked returns the unit-less processes plus whatever
// every active unit currently owns, so a stopped unit really has no
// process and a running container really has a shim.
func (s *Sim) userlandProcessesLocked(systemd int) []procSpec {
	specs := []procSpec{
		{command: "bash", cmdline: "-bash", user: "deploy", ppid: systemd, rss: 6 * miB, threads: 1, state: "sleeping"},
		{command: "agetty", cmdline: "/sbin/agetty -o -p -- \\u --noclear - linux", user: "root", ppid: systemd, rss: 2 * miB, threads: 1, state: "sleeping"},
		{command: "polkitd", cmdline: "/usr/libexec/polkitd --no-debug", user: "polkitd", ppid: systemd, rss: 15 * miB, threads: 3, state: "sleeping"},
		{command: "irqbalance", cmdline: "/usr/sbin/irqbalance --foreground", user: "root", ppid: systemd, rss: 5 * miB, threads: 2, state: "sleeping"},
		{command: "unattended-upgr", cmdline: "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal", user: "root", ppid: systemd, rss: 22 * miB, threads: 1, state: "sleeping"},
	}
	for _, u := range s.units {
		if u.info.ActiveState != "active" || u.info.SubState == "exited" {
			continue
		}
		specs = append(specs, s.unitProcessSpecs(u.info.Unit, systemd)...)
	}
	return specs
}

func (s *Sim) addProcessLocked(spec procSpec) *process {
	s.pidSeq++
	pid := s.pidSeq
	if pid > 2 {
		// Real pids are sparse; a dense 1..N table reads as generated.
		pid = 300 + pid*7 + int(mix(s.seed^uint64(pid))%5)
	}

	started := s.bootTime.Add(time.Duration(mix(s.seed^uint64(pid)^0x71)%420) * time.Second)
	state := spec.state
	if state == "" {
		state = "sleeping"
	}
	threads := spec.threads
	if threads == 0 {
		threads = 1
	}

	p := &process{
		info: providers.ProcessInfo{
			PID:       pid,
			PPID:      spec.ppid,
			User:      spec.user,
			Command:   spec.command,
			Cmdline:   spec.cmdline,
			State:     state,
			MemoryRSS: spec.rss,
			Threads:   threads,
			StartedAt: stamp(started),
			Nice:      spec.nice,
		},
		unit:    spec.unit,
		cpuBase: spec.cpu,
		memBase: spec.rss,
	}
	s.procs = append(s.procs, p)
	return p
}

// live recomputes the moving columns. Kernel threads stay flat because a
// wobbling `[kswapd0]` is exactly the tell that a table is fake.
func (s *Sim) live(p *process, now time.Time) providers.ProcessInfo {
	info := p.info
	if p.frozen || p.memBase == 0 {
		return info
	}

	t := float64(now.UnixMilli()) / 1000
	seed := s.seed ^ uint64(p.info.PID)*0x9e3779b1
	cpu := clampf(p.cpuBase*(1+1.4*drift(seed, t/30, 2))+0.35*math.Abs(drift(seed^0x5, t/7, 2)), 0, 96)
	rss := float64(p.memBase) * (1 + 0.09*drift(seed^0x9, t/600, 2))

	info.CPUPercent = round2(cpu)
	info.MemoryRSS = int64(rss)
	info.MemoryPercent = round2(float64(info.MemoryRSS) / float64(s.id.memoryTotal) * 100)
	return info
}

type simProcesses struct{ *Sim }

func (s simProcesses) List(_ context.Context, p providers.ProcessListParams) (providers.ProcessListResult, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	rows := make([]providers.ProcessInfo, 0, len(s.procs))
	for _, proc := range s.procs {
		if p.User != "" && proc.info.User != p.User {
			continue
		}
		rows = append(rows, s.live(proc, now))
	}
	s.mu.Unlock()

	total := len(rows)
	sortProcesses(rows, p.Sort)
	if p.Limit > 0 && len(rows) > p.Limit {
		rows = rows[:p.Limit]
	}
	return providers.ProcessListResult{Processes: rows, Total: total}, nil
}

func sortProcesses(rows []providers.ProcessInfo, by string) {
	sort.SliceStable(rows, func(i, j int) bool {
		switch by {
		case "memory":
			return rows[i].MemoryRSS > rows[j].MemoryRSS
		case "pid":
			return rows[i].PID < rows[j].PID
		case "name":
			if rows[i].Command != rows[j].Command {
				return rows[i].Command < rows[j].Command
			}
			return rows[i].PID < rows[j].PID
		default:
			return rows[i].CPUPercent > rows[j].CPUPercent
		}
	})
}

func (s simProcesses) Tree(_ context.Context, p providers.ProcessTreeParams) ([]providers.ProcessNode, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	children := map[int][]*process{}
	byPID := map[int]*process{}
	for _, proc := range s.procs {
		byPID[proc.info.PID] = proc
		children[proc.info.PPID] = append(children[proc.info.PPID], proc)
	}

	roots := children[0]
	if p.PID != nil {
		root, ok := byPID[*p.PID]
		if !ok {
			return nil, fmt.Errorf("pid %d: %w", *p.PID, providers.ErrNotFound)
		}
		roots = []*process{root}
	}

	out := make([]providers.ProcessNode, 0, len(s.procs))
	var walk func(procs []*process, depth int)
	walk = func(procs []*process, depth int) {
		for _, proc := range procs {
			out = append(out, providers.ProcessNode{ProcessInfo: s.live(proc, now), Depth: depth})
			if depth < 12 {
				walk(children[proc.info.PID], depth+1)
			}
		}
	}
	walk(roots, 0)

	return out, nil
}

// Signal really removes the process, so killing a unit's main pid puts
// that unit into `failed` the way it would on a real host.
func (s simProcesses) Signal(_ context.Context, p providers.SignalParams) error {
	s.mu.Lock()

	index := -1
	for i, proc := range s.procs {
		if proc.info.PID == p.PID {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return fmt.Errorf("pid %d: %w", p.PID, providers.ErrNotFound)
	}
	if p.PID == 1 {
		s.mu.Unlock()
		return fmt.Errorf("pid 1 is the init system: %w", providers.ErrPermissionDenied)
	}

	target := s.procs[index]
	switch p.Signal {
	case "SIGSTOP":
		target.info.State = "stopped"
		target.frozen = true
		s.mu.Unlock()
		return nil
	case "SIGCONT":
		target.info.State = "sleeping"
		target.frozen = false
		s.mu.Unlock()
		return nil
	case "SIGHUP", "SIGUSR1", "SIGUSR2":
		s.mu.Unlock()
		return nil
	}

	s.procs = append(s.procs[:index], s.procs[index+1:]...)
	unit := s.failUnitForPIDLocked(p.PID, target.unit)
	s.mu.Unlock()

	if unit != "" {
		s.emit(topicServiceChanged, map[string]any{"unit": unit, "state": "failed"})
	}
	return nil
}

func (s *Sim) failUnitForPIDLocked(pid int, name string) string {
	for _, u := range s.units {
		if u.info.Unit != name || u.info.MainPID == nil || *u.info.MainPID != pid {
			continue
		}
		u.info.ActiveState = "failed"
		u.info.SubState = "failed"
		u.info.MainPID = nil
		u.info.MemoryCurrent = nil
		u.info.ActiveSince = nil
		return u.info.Unit
	}
	return ""
}

/* ------------------------------ progress ----------------------------- */

// progress writes one line of human-readable output to a response
// stream. Job handlers in the control plane split these on newlines
// straight into the job log, so every line must stand on its own.
func progress(ctx context.Context, stream providers.Stream, pause time.Duration, format string, args ...any) error {
	if pause > 0 {
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	line := format
	if len(args) > 0 {
		line = fmt.Sprintf(format, args...)
	}
	return stream.Send(ctx, []byte(line+"\n"), providers.EncodingUTF8)
}
