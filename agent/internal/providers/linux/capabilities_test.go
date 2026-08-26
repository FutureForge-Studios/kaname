package linux

import (
	"sort"
	"strings"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Capability detection.
 *
 * The hello frame's capability list is what the panel greys modules out
 * on, and what the RPC registry gates verbs on. Advertising something the
 * host cannot serve turns a greyed-out button into a failing job; missing
 * something it can serve hides a module the operator paid for. Both
 * directions are checked below against a fake probe.
 * ------------------------------------------------------------------ */

// probeWith builds a host that answers yes to exactly the named binaries
// and paths and no to everything else.
func probeWith(runtime string, present ...string) hostProbe {
	set := map[string]struct{}{}
	for _, name := range present {
		set[name] = struct{}{}
	}
	answer := func(name string) bool {
		_, ok := set[name]
		return ok
	}
	return hostProbe{
		hasBinary:        answer,
		fileExists:       answer,
		dirExists:        answer,
		containerRuntime: runtime,
	}
}

func TestABareHostAdvertisesNothing(t *testing.T) {
	// A host with none of the daemons installed must advertise an empty
	// list, not a default set — every verb behind a capability would
	// otherwise be offered and then fail.
	if got := detectCapabilities(probeWith("")); len(got) != 0 {
		t.Fatalf("a bare host advertised %v", got)
	}
}

func TestDetectCapabilitiesFromAFakeProbe(t *testing.T) {
	cases := []struct {
		name    string
		probe   hostProbe
		want    []string
		wantNot []string
	}{
		{
			name:  "systemd needs both a run marker and the client",
			probe: probeWith("", "/run/systemd/system", "systemctl"),
			want:  []string{providers.CapSystemd},
		},
		{
			// The marker alone means systemd is installed, not running.
			// Advertising it would make every service verb fail at call time.
			name:    "the run marker alone is not enough",
			probe:   probeWith("", "/run/systemd/system"),
			wantNot: []string{providers.CapSystemd},
		},
		{
			name:    "the client alone is not enough",
			probe:   probeWith("", "systemctl"),
			wantNot: []string{providers.CapSystemd},
		},
		{
			name:  "the private socket also proves the manager is up",
			probe: probeWith("", "/run/systemd/private", "systemctl"),
			want:  []string{providers.CapSystemd},
		},
		{
			name:  "so does the dbus socket",
			probe: probeWith("", "/run/dbus/system_bus_socket", "systemctl"),
			want:  []string{providers.CapSystemd},
		},
		{
			name:  "docker advertises only docker",
			probe: probeWith(providers.CapDocker),
			want:  []string{providers.CapDocker},
			// Podman is a different runtime; claiming it would send podman
			// verbs at a docker daemon.
			wantNot: []string{providers.CapPodman},
		},
		{
			// Podman serves the Docker API on its compatible socket, so the
			// container verbs work either way and the hub gates on `docker`.
			name:  "podman advertises docker as well as itself",
			probe: probeWith(providers.CapPodman),
			want:  []string{providers.CapPodman, providers.CapDocker},
		},
		{
			name:    "no runtime advertises neither",
			probe:   probeWith(""),
			wantNot: []string{providers.CapDocker, providers.CapPodman},
		},
		{
			name:  "apache is spelled three ways across distributions",
			probe: probeWith("", "httpd"),
			want:  []string{providers.CapApache},
		},
		{
			name:  "apache2ctl counts too",
			probe: probeWith("", "apache2ctl"),
			want:  []string{providers.CapApache},
		},
		{
			name:  "php-fpm alone is php",
			probe: probeWith("", "php-fpm"),
			want:  []string{providers.CapPHP},
		},
		{
			// mail is the umbrella the RPC registry gates the mail verbs on,
			// and either half of a mail stack earns it.
			name:  "postfix needs both of its tools and implies mail",
			probe: probeWith("", "postconf", "postqueue"),
			want:  []string{providers.CapPostfix, providers.CapMail},
		},
		{
			name:    "half of postfix is not postfix",
			probe:   probeWith("", "postconf"),
			wantNot: []string{providers.CapPostfix, providers.CapMail},
		},
		{
			name:    "dovecot alone still implies mail",
			probe:   probeWith("", "doveadm"),
			want:    []string{providers.CapDovecot, providers.CapMail},
			wantNot: []string{providers.CapPostfix},
		},
		{
			name:  "a full mail host advertises both halves",
			probe: probeWith("", "postconf", "postqueue", "doveadm"),
			want:  []string{providers.CapPostfix, providers.CapDovecot, providers.CapMail},
		},
		{
			name:  "every firewall backend that is installed is advertised",
			probe: probeWith("", "nft", "iptables", "ufw", "fail2ban-client"),
			want:  []string{providers.CapNftables, providers.CapIptables, providers.CapUfw, providers.CapFail2ban},
		},
		{
			name:  "database clients",
			probe: probeWith("", "mysql", "mariadb", "psql"),
			want:  []string{providers.CapMySQL, providers.CapMariaDB, providers.CapPostgres},
		},
		{
			name:    "python2 only does not count as python",
			probe:   probeWith("", "python"),
			want:    []string{providers.CapPython},
			wantNot: []string{providers.CapNodeJS},
		},
		{
			name:  "certbot and restic are their own capabilities",
			probe: probeWith("", "certbot", "restic"),
			want:  []string{providers.CapCertbot, providers.CapRestic},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := detectCapabilities(c.probe)
			set := map[string]struct{}{}
			for _, capability := range got {
				set[capability] = struct{}{}
			}

			for _, want := range c.want {
				if _, ok := set[want]; !ok {
					t.Errorf("%s is missing from %v", want, got)
				}
			}
			for _, wantNot := range c.wantNot {
				if _, ok := set[wantNot]; ok {
					t.Errorf("%s was advertised in %v", wantNot, got)
				}
			}
		})
	}
}

func TestAFullyEquippedHostAdvertisesEverythingExactlyOnce(t *testing.T) {
	probe := probeWith(providers.CapPodman,
		"/run/systemd/system", "/run/systemd/private", "/run/dbus/system_bus_socket", "systemctl",
		"nginx", "apache2ctl", "apachectl", "httpd", "caddy", "php", "php-fpm", "node", "python3", "python",
		"mysql", "mariadb", "psql", "postconf", "postqueue", "doveadm",
		"nft", "iptables", "ufw", "fail2ban-client", "certbot", "restic",
	)

	got := detectCapabilities(probe)

	want := []string{
		providers.CapSystemd, providers.CapPodman, providers.CapDocker,
		providers.CapNginx, providers.CapApache, providers.CapCaddy,
		providers.CapPHP, providers.CapNodeJS, providers.CapPython,
		providers.CapMySQL, providers.CapMariaDB, providers.CapPostgres,
		providers.CapPostfix, providers.CapDovecot, providers.CapMail,
		providers.CapNftables, providers.CapIptables, providers.CapUfw,
		providers.CapFail2ban, providers.CapCertbot, providers.CapRestic,
	}
	sort.Strings(want)

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("capabilities =\n  %v\nwant\n  %v", got, want)
	}
}

func TestTheCapabilityListIsSortedAndFreeOfDuplicates(t *testing.T) {
	// The list rides in the hello frame and is stored on the server row, so
	// an unstable order would make every reconnect look like a change. A
	// duplicate would do the same after the panel deduplicated it once.
	probe := probeWith(providers.CapPodman, "nginx", "php", "php-fpm", "python", "python3", "httpd", "apachectl")
	got := detectCapabilities(probe)

	if !sort.StringsAreSorted(got) {
		t.Errorf("the capability list is not sorted: %v", got)
	}
	seen := map[string]struct{}{}
	for _, capability := range got {
		if _, repeat := seen[capability]; repeat {
			t.Errorf("%s appears twice in %v", capability, got)
		}
		seen[capability] = struct{}{}
	}

	// Detection is a pure function of the probe, so two runs agree.
	if again := detectCapabilities(probe); strings.Join(again, ",") != strings.Join(got, ",") {
		t.Errorf("two runs disagreed: %v then %v", got, again)
	}
}

// Every capability the agent can advertise has to be one the contract
// knows about, or the panel receives a string it cannot map to a module.
func TestNoCapabilityIsInventedOutsideTheKnownSet(t *testing.T) {
	known := map[string]struct{}{}
	for _, capability := range []string{
		providers.CapSystemd, providers.CapDocker, providers.CapPodman, providers.CapNginx,
		providers.CapApache, providers.CapCaddy, providers.CapPHP, providers.CapNodeJS,
		providers.CapPython, providers.CapMySQL, providers.CapMariaDB, providers.CapPostgres,
		providers.CapMail, providers.CapDovecot, providers.CapPostfix, providers.CapNftables,
		providers.CapIptables, providers.CapUfw, providers.CapFail2ban, providers.CapCertbot,
		providers.CapRestic, providers.CapSimulate,
	} {
		known[capability] = struct{}{}
	}

	// Answer yes to everything, so any capability the detector can produce
	// is produced.
	everything := hostProbe{
		hasBinary:        func(string) bool { return true },
		fileExists:       func(string) bool { return true },
		dirExists:        func(string) bool { return true },
		containerRuntime: providers.CapPodman,
	}
	for _, capability := range detectCapabilities(everything) {
		if _, ok := known[capability]; !ok {
			t.Errorf("%q is advertised but is not a capability the contract declares", capability)
		}
	}
}
