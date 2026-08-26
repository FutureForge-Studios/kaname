package sim

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * systemd.
 *
 * Units are real state: starting one adds its processes to the table
 * and pushes a service.changed event, stopping one takes them away
 * again, and killing a unit's main pid drops it into `failed`. The
 * fleet ships with one genuinely failed unit, because a wall of green
 * teaches an operator nothing about what a problem looks like.
 * ------------------------------------------------------------------ */

// unit is a systemd unit plus the resident memory it reports while up.
type unit struct {
	info   providers.ServiceInfo
	memory int64
}

type unitSeed struct {
	name        string
	description string
	enabled     bool
	active      string
	sub         string
	memory      int64
	restarts    int
}

var unitCatalogue = []unitSeed{
	{"systemd-journald.service", "Journal Service", true, "active", "running", 78 * miB, 0},
	{"systemd-udevd.service", "Rule-based Manager for Device Events and Files", true, "active", "running", 9 * miB, 0},
	{"systemd-logind.service", "User Login Management", true, "active", "running", 7 * miB, 0},
	{"systemd-resolved.service", "Network Name Resolution", true, "active", "running", 14 * miB, 0},
	{"systemd-timesyncd.service", "Network Time Synchronization", true, "active", "running", 5 * miB, 0},
	{"systemd-networkd.service", "Network Configuration", true, "active", "running", 8 * miB, 0},
	{"dbus.service", "D-Bus System Message Bus", true, "active", "running", 6 * miB, 0},
	{"cron.service", "Regular background program processing daemon", true, "active", "running", 4 * miB, 0},
	{"rsyslog.service", "System Logging Service", true, "active", "running", 11 * miB, 0},
	{"ssh.service", "OpenBSD Secure Shell server", true, "active", "running", 34 * miB, 0},
	{"nginx.service", "A high performance web server and a reverse proxy server", true, "active", "running", 97 * miB, 2},
	{"php8.2-fpm.service", "The PHP 8.2 FastCGI Process Manager", true, "active", "running", 374 * miB, 1},
	{"postgresql.service", "PostgreSQL RDBMS", true, "active", "exited", 0, 0},
	{"postgresql@16-main.service", "PostgreSQL Cluster 16-main", true, "active", "running", 218 * miB, 0},
	{"mariadb.service", "MariaDB 10.11.6 database server", true, "active", "running", 412 * miB, 0},
	{"docker.socket", "Docker Socket for the API", true, "active", "listening", 0, 0},
	{"docker.service", "Docker Application Container Engine", true, "active", "running", 118 * miB, 0},
	{"containerd.service", "containerd container runtime", true, "active", "running", 152 * miB, 0},
	{"postfix.service", "Postfix Mail Transport Agent", true, "active", "exited", 0, 0},
	{"postfix@-.service", "Postfix Mail Transport Agent (instance -)", true, "active", "running", 43 * miB, 0},
	{"dovecot.service", "Dovecot IMAP/POP3 email server", true, "active", "running", 60 * miB, 0},
	{"opendkim.service", "OpenDKIM DomainKeys Identified Mail (DKIM) Milter", true, "active", "running", 13 * miB, 0},
	{"fail2ban.service", "Fail2Ban Service", true, "active", "running", 31 * miB, 0},
	{"nftables.service", "nftables", true, "active", "exited", 0, 0},
	{"kanamed.service", "Kaname agent", true, "active", "running", 26 * miB, 0},
	{"unattended-upgrades.service", "Unattended Upgrades Shutdown", true, "active", "running", 22 * miB, 0},
	{"clamav-freshclam.service", "ClamAV virus database updater", true, "failed", "failed", 0, 5},
	{"ufw.service", "Uncomplicated firewall", false, "inactive", "dead", 0, 0},
	{"redis-server.service", "Advanced key-value store", false, "inactive", "dead", 0, 0},
	{"apt-daily.timer", "Daily apt download activities", true, "active", "waiting", 0, 0},
	{"apt-daily-upgrade.timer", "Daily apt upgrade and clean activities", true, "active", "waiting", 0, 0},
	{"certbot.timer", "Run certbot twice daily", true, "active", "waiting", 0, 0},
	{"logrotate.timer", "Daily rotation of log files", true, "active", "waiting", 0, 0},
	{"e2scrub_all.timer", "Periodic ext4 Online Metadata Check for All Filesystems", true, "active", "waiting", 0, 0},
	{"man-db.timer", "Daily man-db regeneration", true, "active", "waiting", 0, 0},
}

func (s *Sim) buildUnits() {
	s.units = make([]*unit, 0, len(unitCatalogue))

	for i, seed := range unitCatalogue {
		info := providers.ServiceInfo{
			Unit:         seed.name,
			Description:  seed.description,
			LoadState:    "loaded",
			ActiveState:  seed.active,
			SubState:     seed.sub,
			Enabled:      seed.enabled,
			RestartCount: seed.restarts,
		}
		if seed.active == "active" {
			since := s.bootTime.Add(time.Duration(3+mix(s.seed^uint64(i)^0x81)%180) * time.Second)
			info.ActiveSince = stampPtr(since)
			info.CPUUsageNs = ptr(float64(mix(s.seed^uint64(i)^0x82) % 900_000_000_000))
			if seed.memory > 0 {
				info.MemoryCurrent = ptr(seed.memory)
			}
		}
		s.units = append(s.units, &unit{info: info, memory: seed.memory})
	}
}

func (s *Sim) unitActiveLocked(name string) bool {
	for _, u := range s.units {
		if u.info.Unit == name {
			return u.info.ActiveState == "active"
		}
	}
	return false
}

func (s *Sim) findUnitLocked(name string) *unit {
	for _, u := range s.units {
		if u.info.Unit == name {
			return u
		}
	}
	return nil
}

// syncUnitPIDsLocked points every running unit at the first process it
// owns, which is what `MainPID` means on a real host.
func (s *Sim) syncUnitPIDsLocked() {
	owned := map[string]*process{}
	for _, proc := range s.procs {
		if proc.unit == "" {
			continue
		}
		if _, seen := owned[proc.unit]; !seen {
			owned[proc.unit] = proc
		}
	}

	for _, u := range s.units {
		proc, ok := owned[u.info.Unit]
		if !ok {
			u.info.MainPID = nil
			continue
		}
		u.info.MainPID = ptr(proc.info.PID)
		if u.memory > 0 {
			u.info.MemoryCurrent = ptr(u.memory)
		}
	}
}

/* ------------------------- unit process table ------------------------ */

// unitProcessSpecs is the process table a unit owns while it is up. It
// is the single definition used both when the fleet is built and when a
// unit is started later, so a restarted nginx comes back with the same
// worker count it had.
func (s *Sim) unitProcessSpecs(name string, systemd int) []procSpec {
	switch name {
	case "systemd-journald.service":
		return []procSpec{{command: "systemd-journal", cmdline: "/lib/systemd/systemd-journald", user: "root", unit: name, ppid: systemd, rss: 78 * miB, threads: 1, cpu: 0.4}}
	case "systemd-udevd.service":
		return []procSpec{{command: "systemd-udevd", cmdline: "/lib/systemd/systemd-udevd", user: "root", unit: name, ppid: systemd, rss: 9 * miB, threads: 1}}
	case "systemd-logind.service":
		return []procSpec{{command: "systemd-logind", cmdline: "/lib/systemd/systemd-logind", user: "root", unit: name, ppid: systemd, rss: 7 * miB, threads: 1}}
	case "systemd-resolved.service":
		return []procSpec{{command: "systemd-resolve", cmdline: "/lib/systemd/systemd-resolved", user: "systemd-resolve", unit: name, ppid: systemd, rss: 14 * miB, threads: 1}}
	case "systemd-timesyncd.service":
		return []procSpec{{command: "systemd-timesyn", cmdline: "/lib/systemd/systemd-timesyncd", user: "systemd-timesync", unit: name, ppid: systemd, rss: 5 * miB, threads: 2}}
	case "systemd-networkd.service":
		return []procSpec{{command: "systemd-network", cmdline: "/lib/systemd/systemd-networkd", user: "systemd-network", unit: name, ppid: systemd, rss: 8 * miB, threads: 1}}
	case "dbus.service":
		return []procSpec{{command: "dbus-daemon", cmdline: "/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only", user: "messagebus", unit: name, ppid: systemd, rss: 6 * miB, threads: 1}}
	case "cron.service":
		return []procSpec{{command: "cron", cmdline: "/usr/sbin/cron -f", user: "root", unit: name, ppid: systemd, rss: 4 * miB, threads: 1}}
	case "rsyslog.service":
		return []procSpec{{command: "rsyslogd", cmdline: "/usr/sbin/rsyslogd -n -iNONE", user: "root", unit: name, ppid: systemd, rss: 11 * miB, threads: 4, cpu: 0.2}}
	case "kanamed.service":
		return []procSpec{{command: "kanamed", cmdline: "/usr/local/bin/kanamed run --simulate", user: "root", unit: name, ppid: systemd, rss: 26 * miB, threads: 9, cpu: 0.6}}
	case "unattended-upgrades.service":
		return []procSpec{{command: "unattended-upgr", cmdline: "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal", user: "root", unit: name, ppid: systemd, rss: 22 * miB, threads: 1}}
	case "opendkim.service":
		return []procSpec{{command: "opendkim", cmdline: "/usr/sbin/opendkim -x /etc/opendkim.conf -u opendkim -P /run/opendkim/opendkim.pid", user: "opendkim", unit: name, ppid: systemd, rss: 13 * miB, threads: 4}}
	case "fail2ban.service":
		return []procSpec{{command: "fail2ban-server", cmdline: "/usr/bin/python3 /usr/bin/fail2ban-server -xf start", user: "root", unit: name, ppid: systemd, rss: 31 * miB, threads: 7, cpu: 0.5}}
	case "mariadb.service":
		return []procSpec{{command: "mariadbd", cmdline: "/usr/sbin/mariadbd", user: "mysql", unit: name, ppid: systemd, rss: 412 * miB, threads: 21, cpu: 1.8}}
	case "redis-server.service":
		return []procSpec{{command: "redis-server", cmdline: "/usr/bin/redis-server 127.0.0.1:6379", user: "redis", unit: name, ppid: systemd, rss: 46 * miB, threads: 5, cpu: 0.7}}
	case "clamav-freshclam.service":
		return []procSpec{{command: "freshclam", cmdline: "/usr/bin/freshclam -d --foreground=true", user: "clamav", unit: name, ppid: systemd, rss: 88 * miB, threads: 1}}
	case "ufw.service":
		return nil

	case "ssh.service":
		return []procSpec{
			{command: "sshd", cmdline: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", user: "root", unit: name, ppid: systemd, rss: 12 * miB, threads: 1},
			{command: "sshd", cmdline: "sshd: deploy [priv]", user: "root", unit: name, ppid: systemd, rss: 14 * miB, threads: 1},
			{command: "sshd", cmdline: "sshd: deploy@pts/0", user: "deploy", unit: name, ppid: systemd, rss: 8 * miB, threads: 1},
		}

	case "nginx.service":
		specs := []procSpec{{command: "nginx", cmdline: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", user: "root", unit: name, ppid: systemd, rss: 9 * miB, threads: 1}}
		for i := 0; i < 4; i++ {
			specs = append(specs, procSpec{command: "nginx", cmdline: "nginx: worker process", user: "www-data", unit: name, ppid: systemd, rss: 22 * miB, threads: 1, cpu: 1.4})
		}
		return specs

	case "php8.2-fpm.service":
		specs := []procSpec{{command: "php-fpm8.2", cmdline: "php-fpm: master process (/etc/php/8.2/fpm/php-fpm.conf)", user: "root", unit: name, ppid: systemd, rss: 34 * miB, threads: 1}}
		for i := 0; i < 5; i++ {
			specs = append(specs, procSpec{command: "php-fpm8.2", cmdline: "php-fpm: pool www", user: "www-data", unit: name, ppid: systemd, rss: 68 * miB, threads: 1, cpu: 2.1})
		}
		return specs

	case "postgresql@16-main.service":
		specs := []procSpec{{
			command: "postgres",
			cmdline: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf",
			user:    "postgres", unit: name, ppid: systemd, rss: 44 * miB, threads: 1, cpu: 0.9,
		}}
		for _, aux := range []string{"checkpointer", "background writer", "walwriter", "autovacuum launcher", "logical replication launcher"} {
			specs = append(specs, procSpec{command: "postgres", cmdline: "postgres: 16/main: " + aux, user: "postgres", unit: name, ppid: systemd, rss: 18 * miB, threads: 1})
		}
		for i := 0; i < 6; i++ {
			specs = append(specs, procSpec{
				command: "postgres",
				cmdline: fmt.Sprintf("postgres: 16/main: kaname kaname 127.0.0.1(5%04d) idle", 1000+i*37),
				user:    "postgres", unit: name, ppid: systemd, rss: 26 * miB, threads: 1, cpu: 0.7,
			})
		}
		return specs

	case "docker.service":
		return []procSpec{{command: "dockerd", cmdline: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock", user: "root", unit: name, ppid: systemd, rss: 118 * miB, threads: 24, cpu: 1.1}}

	case "containerd.service":
		specs := []procSpec{{command: "containerd", cmdline: "/usr/bin/containerd", user: "root", unit: name, ppid: systemd, rss: 74 * miB, threads: 18, cpu: 0.8}}
		for _, c := range s.containers {
			if c.info.State != "running" {
				continue
			}
			specs = append(specs,
				procSpec{
					command: "containerd-shim",
					cmdline: "/usr/bin/containerd-shim-runc-v2 -namespace moby -id " + c.info.ID + " -address /run/containerd/containerd.sock",
					user:    "root", unit: name, ppid: systemd, rss: 12 * miB, threads: 12,
				},
				procSpec{command: c.process, cmdline: c.processArgs, user: c.processUser, unit: name, ppid: systemd, rss: c.rssBase, threads: 6, cpu: 1.6},
			)
		}
		return specs

	case "postfix@-.service":
		return []procSpec{
			{command: "master", cmdline: "/usr/lib/postfix/sbin/master -w", user: "root", unit: name, ppid: systemd, rss: 7 * miB, threads: 1},
			{command: "qmgr", cmdline: "qmgr -l -t unix -u", user: "postfix", unit: name, ppid: systemd, rss: 9 * miB, threads: 1},
			{command: "pickup", cmdline: "pickup -l -t unix -u -c", user: "postfix", unit: name, ppid: systemd, rss: 8 * miB, threads: 1},
			{command: "tlsmgr", cmdline: "tlsmgr -l -t unix -u -c", user: "postfix", unit: name, ppid: systemd, rss: 8 * miB, threads: 1},
			{command: "smtpd", cmdline: "smtpd -n smtp -t inet -u -c -o stress=", user: "postfix", unit: name, ppid: systemd, rss: 11 * miB, threads: 1, cpu: 0.5},
		}

	case "dovecot.service":
		return []procSpec{
			{command: "dovecot", cmdline: "/usr/sbin/dovecot -F", user: "root", unit: name, ppid: systemd, rss: 6 * miB, threads: 1},
			{command: "anvil", cmdline: "dovecot/anvil", user: "dovenull", unit: name, ppid: systemd, rss: 3 * miB, threads: 1},
			{command: "log", cmdline: "dovecot/log", user: "root", unit: name, ppid: systemd, rss: 3 * miB, threads: 1},
			{command: "config", cmdline: "dovecot/config", user: "root", unit: name, ppid: systemd, rss: 4 * miB, threads: 1},
			{command: "imap-login", cmdline: "dovecot/imap-login", user: "dovenull", unit: name, ppid: systemd, rss: 5 * miB, threads: 1},
			{command: "imap-login", cmdline: "dovecot/imap-login", user: "dovenull", unit: name, ppid: systemd, rss: 5 * miB, threads: 1},
			{command: "imap", cmdline: "dovecot/imap", user: "vmail", unit: name, ppid: systemd, rss: 17 * miB, threads: 1, cpu: 0.9},
			{command: "imap", cmdline: "dovecot/imap", user: "vmail", unit: name, ppid: systemd, rss: 17 * miB, threads: 1, cpu: 0.6},
		}
	}
	return nil
}

/* ------------------------------ services ----------------------------- */

type simServices struct{ *Sim }

func (s simServices) List(_ context.Context, p providers.ServiceListParams) ([]providers.ServiceInfo, error) {
	pattern := strings.ToLower(strings.TrimSpace(p.Pattern))

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.ServiceInfo, 0, len(s.units))
	for _, u := range s.units {
		if pattern != "" && !matchesUnit(u.info, pattern) {
			continue
		}
		if p.State != "" && u.info.ActiveState != p.State {
			continue
		}
		out = append(out, u.info)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Unit < out[j].Unit })
	return out, nil
}

func matchesUnit(info providers.ServiceInfo, pattern string) bool {
	pattern = strings.TrimSuffix(pattern, "*")
	return strings.Contains(strings.ToLower(info.Unit), pattern) ||
		strings.Contains(strings.ToLower(info.Description), pattern)
}

func (s simServices) Status(_ context.Context, name string) (providers.ServiceInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	u := s.findUnitLocked(name)
	if u == nil {
		return providers.ServiceInfo{}, fmt.Errorf("unit %s: %w", name, providers.ErrNotFound)
	}
	return u.info, nil
}

func (s simServices) Start(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "start")
}

func (s simServices) Stop(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "stop")
}

func (s simServices) Restart(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "restart")
}

func (s simServices) Reload(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "reload")
}

func (s simServices) Enable(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "enable")
}

func (s simServices) Disable(_ context.Context, name string) (providers.ServiceInfo, error) {
	return s.transition(name, "disable")
}

// transition is the whole unit state machine in one place, so start and
// restart cannot drift apart in what they do to the process table.
func (s *Sim) transition(name, action string) (providers.ServiceInfo, error) {
	s.mu.Lock()

	u := s.findUnitLocked(name)
	if u == nil {
		s.mu.Unlock()
		return providers.ServiceInfo{}, fmt.Errorf("unit %s: %w", name, providers.ErrNotFound)
	}

	before := u.info.ActiveState
	now := time.Now().UTC()

	switch action {
	case "start":
		if u.info.ActiveState != "active" {
			s.bringUpLocked(u, now)
		}
	case "stop":
		if u.info.ActiveState != "inactive" {
			s.bringDownLocked(u, "inactive", "dead")
		}
	case "restart":
		s.bringDownLocked(u, "inactive", "dead")
		s.bringUpLocked(u, now)
		u.info.RestartCount++
	case "reload":
		if u.info.ActiveState != "active" {
			s.mu.Unlock()
			return providers.ServiceInfo{}, fmt.Errorf("unit %s is not running: %w", name, providers.ErrPreconditionFailed)
		}
	case "enable":
		u.info.Enabled = true
	case "disable":
		u.info.Enabled = false
	}

	info := u.info
	s.mu.Unlock()

	if info.ActiveState != before {
		s.emit(topicServiceChanged, map[string]any{"unit": name, "state": info.ActiveState})
	}
	return info, nil
}

func (s *Sim) bringUpLocked(u *unit, now time.Time) {
	u.info.ActiveState = "active"
	u.info.SubState = "running"
	u.info.ActiveSince = stampPtr(now)
	if u.memory > 0 {
		u.info.MemoryCurrent = ptr(u.memory)
	}
	if u.info.CPUUsageNs == nil {
		u.info.CPUUsageNs = ptr(0.0)
	}

	specs := s.unitProcessSpecs(u.info.Unit, 1)
	if len(specs) == 0 {
		// Oneshot units and timers reach `active` without a process.
		u.info.SubState = "exited"
		if strings.HasSuffix(u.info.Unit, ".timer") {
			u.info.SubState = "waiting"
		}
		return
	}
	for _, spec := range specs {
		s.addProcessLocked(spec)
	}
	s.syncUnitPIDsLocked()
}

func (s *Sim) bringDownLocked(u *unit, active, sub string) {
	kept := s.procs[:0]
	for _, proc := range s.procs {
		if proc.unit == u.info.Unit {
			continue
		}
		kept = append(kept, proc)
	}
	s.procs = kept

	u.info.ActiveState = active
	u.info.SubState = sub
	u.info.MainPID = nil
	u.info.MemoryCurrent = nil
	u.info.ActiveSince = nil
}

func (s simServices) Logs(ctx context.Context, p providers.ServiceLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	s.mu.Lock()
	known := s.findUnitLocked(p.Unit) != nil
	s.mu.Unlock()
	if !known {
		return nil, fmt.Errorf("unit %s: %w", p.Unit, providers.ErrNotFound)
	}

	return s.tail(ctx, stream, tailRequest{
		source: sourceJournal,
		unit:   p.Unit,
		lines:  p.Lines,
		follow: p.Follow,
		since:  p.Since,
	})
}
