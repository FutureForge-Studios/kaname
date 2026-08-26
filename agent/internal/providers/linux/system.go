//go:build linux

package linux

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Host identity, resource sampling and packages.
 *
 * Identity and metrics come from procfs through gopsutil. Packages go
 * through whichever package manager the distribution actually ships,
 * always as an argv slice — an upgrade is the one operation where a
 * smuggled shell metacharacter would be running as root by design.
 * ------------------------------------------------------------------ */

// Pseudo filesystems carry no capacity an operator can act on, so they
// are left out of every disk figure rather than inflating the list.
var pseudoFilesystems = map[string]struct{}{
	"autofs": {}, "binfmt_misc": {}, "bpf": {}, "cgroup": {}, "cgroup2": {},
	"configfs": {}, "debugfs": {}, "devpts": {}, "devtmpfs": {}, "efivarfs": {},
	"fuse.gvfsd-fuse": {}, "fusectl": {}, "hugetlbfs": {}, "mqueue": {},
	"overlay": {}, "proc": {}, "pstore": {}, "ramfs": {}, "rpc_pipefs": {},
	"securityfs": {}, "selinuxfs": {}, "squashfs": {}, "sysfs": {}, "tracefs": {},
}

var osFamilies = map[string]struct{}{
	"debian": {}, "ubuntu": {}, "rhel": {}, "fedora": {}, "alpine": {}, "arch": {},
}

// metricsSnapshot is the previous sample, kept so counters become rates.
// Without it the panel would plot monotonically rising byte totals.
type metricsSnapshot struct {
	at        time.Time
	netRx     uint64
	netTx     uint64
	diskRead  uint64
	diskWrite uint64
}

type systemOps struct{ p *provider }

func (s systemOps) Info(ctx context.Context) (providers.SystemInfo, error) {
	stat, err := host.InfoWithContext(ctx)
	if err != nil {
		return providers.SystemInfo{}, fmt.Errorf("read host info: %w", err)
	}

	info := providers.SystemInfo{
		Hostname:       stat.Hostname,
		MachineID:      machineID(stat),
		OS:             stat.Platform,
		OSVersion:      stat.PlatformVersion,
		OSFamily:       osFamily(stat),
		Arch:           runtime.GOARCH,
		Kernel:         stat.KernelVersion,
		BootTime:       rfc3339(time.Unix(int64(stat.BootTime), 0)),
		UptimeSeconds:  int64(stat.Uptime),
		Virtualization: stat.VirtualizationSystem,
		Timezone:       timezone(),
		AgentVersion:   s.p.opts.AgentVersion,
	}

	if cores, err := cpu.CountsWithContext(ctx, true); err == nil && cores > 0 {
		info.CPUCores = cores
	} else {
		info.CPUCores = runtime.NumCPU()
	}
	if cpus, err := cpu.InfoWithContext(ctx); err == nil && len(cpus) > 0 {
		info.CPUModel = strings.TrimSpace(cpus[0].ModelName)
	}
	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemoryTotal = int64(memory.Total)
	}
	if swap, err := mem.SwapMemoryWithContext(ctx); err == nil {
		info.SwapTotal = int64(swap.Total)
	}
	return info, nil
}

func (s systemOps) Metrics(ctx context.Context) (providers.MetricsSample, error) {
	sample := providers.MetricsSample{Ts: nowRFC3339(), Disks: []providers.DiskUsage{}}

	// Interval 0 measures against gopsutil's previous call, which is the
	// agent's own 15-second cadence rather than a blocking sleep here.
	if percent, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(percent) > 0 {
		sample.CPUPercent = clampPercent(percent[0])
	}
	if percore, err := cpu.PercentWithContext(ctx, 0, true); err == nil && len(percore) > 0 {
		sample.CPUPerCore = make([]float64, 0, len(percore))
		for _, value := range percore {
			sample.CPUPerCore = append(sample.CPUPerCore, clampPercent(value))
		}
	}

	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		sample.MemoryUsed = int64(memory.Used)
		sample.MemoryTotal = int64(memory.Total)
		sample.MemoryCached = int64Ptr(int64(memory.Cached))
	}
	if swap, err := mem.SwapMemoryWithContext(ctx); err == nil {
		sample.SwapUsed = int64(swap.Used)
		sample.SwapTotal = int64(swap.Total)
	}
	if averages, err := load.AvgWithContext(ctx); err == nil {
		sample.Load1, sample.Load5, sample.Load15 = averages.Load1, averages.Load5, averages.Load15
	}
	if stat, err := host.InfoWithContext(ctx); err == nil {
		sample.Processes = int(stat.Procs)
	}
	if disks, err := collectDisks(ctx); err == nil {
		sample.Disks = disks
	}

	current := metricsSnapshot{at: time.Now()}
	if counters, err := gnet.IOCountersWithContext(ctx, false); err == nil && len(counters) > 0 {
		current.netRx, current.netTx = counters[0].BytesRecv, counters[0].BytesSent
	}
	if counters, err := disk.IOCountersWithContext(ctx); err == nil {
		for _, counter := range counters {
			current.diskRead += counter.ReadBytes
			current.diskWrite += counter.WriteBytes
		}
	}
	sample.NetRxBytes = int64(current.netRx)
	sample.NetTxBytes = int64(current.netTx)

	s.p.metricsMu.Lock()
	previous := s.p.lastMetrics
	s.p.lastMetrics = &current
	s.p.metricsMu.Unlock()

	if previous != nil {
		elapsed := current.at.Sub(previous.at).Seconds()
		if elapsed > 0 {
			sample.NetRxRate = rate(previous.netRx, current.netRx, elapsed)
			sample.NetTxRate = rate(previous.netTx, current.netTx, elapsed)
			read := rate(previous.diskRead, current.diskRead, elapsed)
			write := rate(previous.diskWrite, current.diskWrite, elapsed)
			sample.DiskReadRate, sample.DiskWriteRate = &read, &write
		}
	}
	return sample, nil
}

func (s systemOps) Reboot(ctx context.Context, p providers.SystemRebootParams) error {
	if p.DelaySeconds <= 0 {
		if s.p.has(providers.CapSystemd) {
			_, err := run(ctx, "systemctl", "reboot")
			return err
		}
		_, err := run(ctx, "shutdown", "-r", "now")
		return err
	}

	// A transient timer gives second granularity; `shutdown` only speaks
	// whole minutes, so it rounds up rather than rebooting early.
	if s.p.has(providers.CapSystemd) && hasBinary("systemd-run") {
		_, err := run(ctx, "systemd-run",
			"--on-active="+strconv.Itoa(p.DelaySeconds)+"s",
			"--timer-property=AccuracySec=1s",
			"systemctl", "reboot")
		return err
	}

	minutes := (p.DelaySeconds + 59) / 60
	_, err := run(ctx, "shutdown", "-r", "+"+strconv.Itoa(minutes))
	return err
}

/* ------------------------------ packages ----------------------------- */

// packageManager is the distribution's own tool. Detection is by binary
// rather than by /etc/os-release, because that is what actually decides
// whether a command will work.
type packageManager string

const (
	managerAPT    packageManager = "apt"
	managerDNF    packageManager = "dnf"
	managerYUM    packageManager = "yum"
	managerAPK    packageManager = "apk"
	managerPacman packageManager = "pacman"
)

func detectPackageManager() (packageManager, bool) {
	switch {
	case hasBinary("apt-get") && hasBinary("dpkg-query"):
		return managerAPT, true
	case hasBinary("dnf"):
		return managerDNF, true
	case hasBinary("yum"):
		return managerYUM, true
	case hasBinary("apk"):
		return managerAPK, true
	case hasBinary("pacman"):
		return managerPacman, true
	default:
		return "", false
	}
}

func (s systemOps) ListPackages(ctx context.Context, p providers.PackagesListParams) ([]providers.PackageInfo, error) {
	manager, ok := detectPackageManager()
	if !ok {
		return nil, unsupported("no supported package manager on this host")
	}

	upgradable, err := upgradablePackages(ctx, manager)
	if err != nil {
		return nil, err
	}
	if p.UpgradableOnly {
		out := make([]providers.PackageInfo, 0, len(upgradable))
		for _, entry := range upgradable {
			out = append(out, entry)
		}
		sortPackages(out)
		return out, nil
	}

	installed, err := installedPackages(ctx, manager)
	if err != nil {
		return nil, err
	}
	for i := range installed {
		if entry, pending := upgradable[installed[i].Name]; pending {
			installed[i].AvailableVersion = entry.AvailableVersion
			installed[i].Security = entry.Security
		}
	}
	sortPackages(installed)
	return installed, nil
}

func (s systemOps) UpgradePackages(ctx context.Context, p providers.PackagesUpgradeParams, stream providers.Stream) (providers.PackagesUpgradeResult, error) {
	var result providers.PackagesUpgradeResult

	manager, ok := detectPackageManager()
	if !ok {
		return result, unsupported("no supported package manager on this host")
	}

	names := p.Names
	if p.SecurityOnly && len(names) == 0 {
		pending, err := upgradablePackages(ctx, manager)
		if err != nil {
			return result, err
		}
		for name, entry := range pending {
			if entry.Security {
				names = append(names, name)
			}
		}
		if len(names) == 0 {
			return providers.PackagesUpgradeResult{Upgraded: []string{}, RebootRequired: rebootRequired(ctx)}, nil
		}
	}
	for _, name := range names {
		if err := checkPackageName(name); err != nil {
			return result, err
		}
	}

	options := execOptions{Env: append(cLocale(), "DEBIAN_FRONTEND=noninteractive")}
	switch manager {
	case managerAPT:
		options.Name = "apt-get"
		// `upgrade` takes no package list, so a targeted upgrade is an
		// `install --only-upgrade` instead.
		base := []string{"-y", "-o", "Dpkg::Options::=--force-confold"}
		if len(names) > 0 {
			options.Args = append(append(base, "install", "--only-upgrade"), names...)
		} else {
			options.Args = append(base, "upgrade")
		}
	case managerDNF, managerYUM:
		options.Name = string(manager)
		options.Args = append([]string{"-y", "upgrade"}, names...)
		if p.SecurityOnly && len(p.Names) == 0 {
			options.Args = []string{"-y", "--security", "upgrade"}
		}
	case managerAPK:
		options.Name = "apk"
		options.Args = append([]string{"upgrade"}, names...)
	case managerPacman:
		options.Name = "pacman"
		options.Args = append([]string{"--noconfirm", "-Syu"}, names...)
	}

	if _, err := runStream(ctx, stream, options); err != nil {
		return result, err
	}

	result.Upgraded = names
	if result.Upgraded == nil {
		result.Upgraded = []string{}
	}
	result.RebootRequired = rebootRequired(ctx)
	return result, nil
}

func installedPackages(ctx context.Context, manager packageManager) ([]providers.PackageInfo, error) {
	switch manager {
	case managerAPT:
		out, err := run(ctx, "dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n")
		if err != nil {
			return nil, err
		}
		return parseTabbedPackages(out), nil

	case managerDNF, managerYUM:
		out, err := run(ctx, "rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n")
		if err != nil {
			return nil, err
		}
		return parseTabbedPackages(out), nil

	case managerAPK:
		out, err := run(ctx, "apk", "info", "-v")
		if err != nil {
			return nil, err
		}
		packages := make([]providers.PackageInfo, 0, 64)
		for _, line := range splitLines(out) {
			name, version, ok := splitAPKVersion(strings.TrimSpace(line))
			if !ok {
				continue
			}
			packages = append(packages, providers.PackageInfo{Name: name, InstalledVersion: version})
		}
		return packages, nil

	case managerPacman:
		out, err := run(ctx, "pacman", "-Q")
		if err != nil {
			return nil, err
		}
		packages := make([]providers.PackageInfo, 0, 64)
		for _, line := range splitLines(out) {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			packages = append(packages, providers.PackageInfo{Name: fields[0], InstalledVersion: fields[1]})
		}
		return packages, nil
	}
	return nil, unsupported("package listing is not implemented for %s", manager)
}

func upgradablePackages(ctx context.Context, manager packageManager) (map[string]providers.PackageInfo, error) {
	pending := map[string]providers.PackageInfo{}

	switch manager {
	case managerAPT:
		// `apt-get -s upgrade` is a dry run whose `Inst` lines carry the
		// origin, which is the only place the security suite is visible.
		out, err := runWith(ctx, execOptions{
			Name: "apt-get",
			Args: []string{"-s", "-q", "-o", "Debug::NoLocking=true", "upgrade"},
			Env:  append(cLocale(), "DEBIAN_FRONTEND=noninteractive"),
		})
		if err != nil {
			return nil, err
		}
		for _, line := range splitLines(out) {
			if !strings.HasPrefix(line, "Inst ") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 3 {
				continue
			}
			name := fields[1]
			installed := strings.Trim(fields[2], "[]")
			available := ""
			if open := strings.Index(line, "("); open >= 0 {
				inner := strings.Fields(line[open+1:])
				if len(inner) > 0 {
					available = inner[0]
				}
			}
			pending[name] = providers.PackageInfo{
				Name:             name,
				InstalledVersion: installed,
				AvailableVersion: stringPtr(available),
				Security:         strings.Contains(line, "-security") || strings.Contains(line, "Debian-Security"),
			}
		}
		return pending, nil

	case managerDNF, managerYUM:
		// check-update exits 100 when updates exist, which is success here.
		out, err := runWith(ctx, execOptions{Name: string(manager), Args: []string{"-q", "check-update"}, Env: cLocale()})
		if err != nil && !isExitCode(err, 100) {
			return nil, err
		}
		security := map[string]struct{}{}
		if secure, err := runWith(ctx, execOptions{Name: string(manager), Args: []string{"-q", "--security", "check-update"}, Env: cLocale()}); err == nil || isExitCode(err, 100) {
			for _, line := range splitLines(secure) {
				if fields := strings.Fields(line); len(fields) >= 2 {
					security[trimRPMArch(fields[0])] = struct{}{}
				}
			}
		}
		for _, line := range splitLines(out) {
			fields := strings.Fields(line)
			if len(fields) < 3 || strings.HasSuffix(line, ":") {
				continue
			}
			name := trimRPMArch(fields[0])
			_, isSecurity := security[name]
			pending[name] = providers.PackageInfo{
				Name:             name,
				AvailableVersion: stringPtr(fields[1]),
				Security:         isSecurity,
			}
		}
		return pending, nil

	case managerAPK:
		out, err := run(ctx, "apk", "version", "-l", "<")
		if err != nil {
			return nil, err
		}
		for _, line := range splitLines(out) {
			fields := strings.Fields(line)
			if len(fields) < 3 || fields[1] != "<" {
				continue
			}
			name, installed, ok := splitAPKVersion(fields[0])
			if !ok {
				continue
			}
			pending[name] = providers.PackageInfo{
				Name:             name,
				InstalledVersion: installed,
				AvailableVersion: stringPtr(fields[2]),
			}
		}
		return pending, nil

	case managerPacman:
		out, err := runWith(ctx, execOptions{Name: "pacman", Args: []string{"-Qu"}})
		if err != nil && !isExitCode(err, 1) {
			return nil, err
		}
		for _, line := range splitLines(out) {
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			pending[fields[0]] = providers.PackageInfo{
				Name:             fields[0],
				InstalledVersion: fields[1],
				AvailableVersion: stringPtr(fields[3]),
			}
		}
		return pending, nil
	}
	return pending, nil
}

// rebootRequired answers the question a package upgrade leaves open, in
// whichever way the distribution records it.
func rebootRequired(ctx context.Context) bool {
	if fileExists("/var/run/reboot-required") || fileExists("/run/reboot-required") {
		return true
	}
	if hasBinary("needs-restarting") {
		if _, err := run(ctx, "needs-restarting", "-r"); err != nil {
			return isExitCode(err, 1)
		}
		return false
	}
	return false
}

/* ------------------------------- helpers ----------------------------- */

func collectDisks(ctx context.Context) ([]providers.DiskUsage, error) {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil, fmt.Errorf("read partitions: %w", err)
	}

	seen := map[string]struct{}{}
	disks := make([]providers.DiskUsage, 0, len(partitions))
	for _, partition := range partitions {
		if _, pseudo := pseudoFilesystems[partition.Fstype]; pseudo {
			continue
		}
		if _, duplicate := seen[partition.Mountpoint]; duplicate {
			continue
		}
		usage, err := disk.UsageWithContext(ctx, partition.Mountpoint)
		if err != nil || usage.Total == 0 {
			continue
		}
		seen[partition.Mountpoint] = struct{}{}

		entry := providers.DiskUsage{
			Mount:       partition.Mountpoint,
			Device:      partition.Device,
			Fstype:      partition.Fstype,
			Total:       int64(usage.Total),
			Used:        int64(usage.Used),
			Available:   int64(usage.Free),
			UsedPercent: clampPercent(usage.UsedPercent),
		}
		if usage.InodesTotal > 0 {
			entry.InodesTotal = int64Ptr(int64(usage.InodesTotal))
			entry.InodesUsed = int64Ptr(int64(usage.InodesUsed))
		}
		disks = append(disks, entry)
	}
	return disks, nil
}

func machineID(stat *host.InfoStat) string {
	for _, candidate := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if id := readTrimmed(candidate); id != "" {
			return id
		}
	}
	return stat.HostID
}

func osFamily(stat *host.InfoStat) string {
	platform := strings.ToLower(stat.Platform)
	if _, ok := osFamilies[platform]; ok {
		return platform
	}
	family := strings.ToLower(stat.PlatformFamily)
	if _, ok := osFamilies[family]; ok {
		return family
	}
	return "other"
}

func timezone() string {
	if zone := readTrimmed("/etc/timezone"); zone != "" {
		return zone
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if index := strings.Index(target, "zoneinfo/"); index >= 0 {
			return filepath.ToSlash(target[index+len("zoneinfo/"):])
		}
	}
	return time.Now().Location().String()
}

// rate turns two counter readings into bytes per second, treating a
// counter that went backwards as a reset rather than a negative rate.
func rate(previous, current uint64, seconds float64) float64 {
	if current < previous || seconds <= 0 {
		return 0
	}
	return math.Round(float64(current-previous)/seconds*100) / 100
}

func clampPercent(value float64) float64 {
	if math.IsNaN(value) || value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return math.Round(value*100) / 100
}

func parseTabbedPackages(out string) []providers.PackageInfo {
	packages := make([]providers.PackageInfo, 0, 128)
	for _, line := range splitLines(out) {
		name, version, ok := strings.Cut(line, "\t")
		if !ok || name == "" {
			continue
		}
		packages = append(packages, providers.PackageInfo{Name: name, InstalledVersion: strings.TrimSpace(version)})
	}
	return packages
}

// splitAPKVersion splits apk's `name-1.2.3-r0` on the last two dashes,
// which is the only place the version reliably begins.
func splitAPKVersion(entry string) (string, string, bool) {
	release := strings.LastIndex(entry, "-")
	if release <= 0 {
		return "", "", false
	}
	version := strings.LastIndex(entry[:release], "-")
	if version <= 0 {
		return "", "", false
	}
	return entry[:version], entry[version+1:], true
}

func trimRPMArch(entry string) string {
	if dot := strings.LastIndex(entry, "."); dot > 0 {
		return entry[:dot]
	}
	return entry
}

func sortPackages(packages []providers.PackageInfo) {
	sortSlice(packages, func(a, b providers.PackageInfo) bool { return a.Name < b.Name })
}

// checkPackageName keeps an option-looking argument out of the package
// list; argv already prevents a shell, this prevents a flag.
func checkPackageName(name string) error {
	if name == "" || len(name) > 128 || strings.HasPrefix(name, "-") {
		return invalid("package name %q is not usable", name)
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == '-', c == '_', c == '+', c == ':':
		default:
			return invalid("package name %q contains an illegal character", name)
		}
	}
	return nil
}
