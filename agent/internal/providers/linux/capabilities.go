package linux

import (
	"sort"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* --------------------------- capabilities ---------------------------- */

// hostProbe is everything capability detection is allowed to ask about
// the machine. It is a parameter rather than a set of direct calls to
// exec.LookPath so the advertised capability set is a pure function of
// what the host reports — which is the thing the panel greys modules out
// on, and therefore the thing worth pinning.
type hostProbe struct {
	hasBinary  func(string) bool
	fileExists func(string) bool
	dirExists  func(string) bool
	// containerRuntime is the capability name of the runtime whose socket
	// answered at startup: providers.CapDocker, providers.CapPodman, or
	// empty when neither did.
	containerRuntime string
}

// detectCapabilities decides what this host can serve, sorted so the
// hello frame is stable across restarts.
func detectCapabilities(probe hostProbe) []string {
	caps := map[string]struct{}{}
	add := func(capability string) { caps[capability] = struct{}{} }

	// systemd announces itself with /run/systemd/system; the private
	// socket confirms the manager is actually up rather than merely
	// installed.
	if (probe.dirExists("/run/systemd/system") || probe.fileExists("/run/systemd/private") ||
		probe.fileExists("/run/dbus/system_bus_socket")) && probe.hasBinary("systemctl") {
		add(providers.CapSystemd)
	}

	if probe.containerRuntime != "" {
		add(probe.containerRuntime)
		if probe.containerRuntime == providers.CapPodman {
			// Podman serves the Docker API on its compatible socket, so the
			// container verbs work either way and the hub gates on `docker`.
			add(providers.CapDocker)
		}
	}

	if probe.hasBinary("nginx") {
		add(providers.CapNginx)
	}
	if probe.hasBinary("apache2ctl") || probe.hasBinary("apachectl") || probe.hasBinary("httpd") {
		add(providers.CapApache)
	}
	if probe.hasBinary("caddy") {
		add(providers.CapCaddy)
	}
	if probe.hasBinary("php") || probe.hasBinary("php-fpm") {
		add(providers.CapPHP)
	}
	if probe.hasBinary("node") {
		add(providers.CapNodeJS)
	}
	if probe.hasBinary("python3") || probe.hasBinary("python") {
		add(providers.CapPython)
	}

	if probe.hasBinary("mysql") {
		add(providers.CapMySQL)
	}
	if probe.hasBinary("mariadb") {
		add(providers.CapMariaDB)
	}
	if probe.hasBinary("psql") {
		add(providers.CapPostgres)
	}

	postfix := probe.hasBinary("postconf") && probe.hasBinary("postqueue")
	dovecot := probe.hasBinary("doveadm")
	if postfix {
		add(providers.CapPostfix)
	}
	if dovecot {
		add(providers.CapDovecot)
	}
	if postfix || dovecot {
		add(providers.CapMail)
	}

	if probe.hasBinary("nft") {
		add(providers.CapNftables)
	}
	if probe.hasBinary("iptables") {
		add(providers.CapIptables)
	}
	if probe.hasBinary("ufw") {
		add(providers.CapUfw)
	}
	if probe.hasBinary("fail2ban-client") {
		add(providers.CapFail2ban)
	}
	if probe.hasBinary("certbot") {
		add(providers.CapCertbot)
	}
	if probe.hasBinary("restic") {
		add(providers.CapRestic)
	}

	list := make([]string, 0, len(caps))
	for capability := range caps {
		list = append(list, capability)
	}
	sort.Strings(list)
	return list
}
