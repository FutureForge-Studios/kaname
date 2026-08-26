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
 * Firewall, intrusion observations and SSH.
 *
 * The attackers are a fixed cast drawn from the documentation ranges
 * (RFC 5737), so a demo never points a finger at a real address. They
 * keep trying, their attempt counts accumulate, and once one crosses the
 * jail threshold it lands in the ban list on its own — which is the
 * behaviour the Security module exists to show.
 *
 * `fw.apply` and `ssh.config.apply` honour their rollback window for
 * real: forget to confirm and the previous rule set comes back, exactly
 * like the lockout guard on a live host.
 * ------------------------------------------------------------------ */

// threatSources is deliberately RFC 5737 documentation space. A simulated
// threat feed must never name an address someone could go and block.
var threatSources = []string{
	"203.0.113.7", "203.0.113.42", "203.0.113.88", "203.0.113.201", "203.0.113.240",
	"198.51.100.13", "198.51.100.66", "198.51.100.154", "198.51.100.219",
	"192.0.2.9", "192.0.2.77", "192.0.2.133",
}

// autoBanThreshold mirrors a fail2ban jail: enough failures in the window
// and the address stops being an observation and becomes a ban.
const autoBanThreshold = 120

// rollbackWindow is a staged change that reverts itself unless confirmed.
type rollbackWindow struct {
	kind      string
	rules     []providers.FirewallRuleInfo
	inbound   string
	outbound  string
	sshConfig providers.SSHConfigInfo
	expires   time.Time
}

func (s *Sim) buildSecurity() {
	now := time.Now().UTC()

	s.fwEnabled = true
	s.fwInbound = "deny"
	s.fwOutbound = "allow"
	s.rollbacks = map[string]*rollbackWindow{}

	seeds := []struct {
		priority int
		action   string
		protocol string
		ports    string
		source   string
		comment  string
	}{
		{10, "allow", "tcp", "22", "", "SSH"},
		{20, "allow", "tcp", "80", "", "HTTP"},
		{30, "allow", "tcp", "443", "", "HTTPS"},
		{40, "allow", "tcp", "25", "", "SMTP"},
		{50, "allow", "tcp", "587", "", "Submission"},
		{60, "allow", "tcp", "993", "", "IMAPS"},
		{70, "allow", "icmp", "", "", "ICMP echo"},
		{80, "allow", "tcp", "5432", "10.20.30.0/24", "PostgreSQL from the private network"},
		{90, "deny", "tcp", "3306", "", "MariaDB is loopback only"},
	}

	s.fwRules = make([]providers.FirewallRuleInfo, 0, len(seeds))
	for _, seed := range seeds {
		rule := providers.FirewallRuleInfo{
			ID:        fmt.Sprintf("inet-filter-input-%d", seed.priority),
			Priority:  seed.priority,
			Action:    seed.action,
			Direction: "inbound",
			Protocol:  seed.protocol,
			Comment:   ptr(seed.comment),
			Enabled:   true,
			Backend:   "nftables",
		}
		if seed.ports != "" {
			rule.PortSpec = ptr(seed.ports)
		}
		if seed.source != "" {
			rule.Source = ptr(seed.source)
		}
		s.fwRules = append(s.fwRules, rule)
	}

	s.bans = map[string]providers.BanEntry{}
	s.threats = map[string]*providers.ThreatObservation{}

	for i, ip := range threatSources {
		first := now.Add(-time.Duration(2+mix(s.seed^uint64(i)^0x91)%70) * time.Hour)
		attempts := 6 + int(mix(s.seed^uint64(i)^0x92)%240)
		kind := "ssh_bruteforce"
		target := "sshd:22"
		switch i % 5 {
		case 3:
			kind, target = "web_bruteforce", "nginx:443/wp-login.php"
		case 4:
			kind, target = "mail_bruteforce", "dovecot:993"
		}

		s.threats[ip] = &providers.ThreatObservation{
			Kind:      kind,
			SourceIP:  ip,
			Target:    target,
			Attempts:  attempts,
			FirstSeen: stamp(first),
			LastSeen:  stamp(now.Add(-time.Duration(mix(s.seed^uint64(i)^0x93)%50) * time.Minute)),
			Sample:    threatSample(kind, ip),
		}

		if attempts >= autoBanThreshold {
			bannedAt := now.Add(-time.Duration(mix(s.seed^uint64(i)^0x94)%180) * time.Minute)
			s.bans[ip] = providers.BanEntry{
				IP:        ip,
				Jail:      jailFor(kind),
				BannedAt:  stamp(bannedAt),
				ExpiresAt: stampPtr(bannedAt.Add(time.Hour)),
				Attempts:  attempts,
			}
		}
	}

	s.sshConfig = providers.SSHConfigInfo{
		Port:                   22,
		PermitRootLogin:        "prohibit-password",
		PasswordAuthentication: false,
		PubkeyAuthentication:   true,
		MaxAuthTries:           4,
		AllowUsers:             []string{"root", "deploy"},
		AllowGroups:            []string{"sudo"},
		X11Forwarding:          false,
	}

	s.sshKeys = map[string][]providers.SSHKeyInfo{
		"root": {{
			Fingerprint: "SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5oPqZrTvXyWkE",
			Type:        "ssh-ed25519",
			Comment:     "ops@kaname",
			PublicKey:   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFq8xJ2vZ9nR0dTgY6mC1sL4pW7hB3eKuQaXrN5tOiVd ops@kaname",
			User:        "root",
		}},
		"deploy": {
			{
				Fingerprint: "SHA256:a1Bc2DeFgH3iJkLmN4oPqRsT5uVwXyZ6AbCdEfGhIjK",
				Type:        "ssh-ed25519",
				Comment:     "deploy@workstation",
				PublicKey:   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC7yQ4pXvR2mK9dLwB6nT1sZ0hEaJ3fUgMxOiPqV8rYd deploy@workstation",
				User:        "deploy",
			},
			{
				Fingerprint: "SHA256:z9Yx8Wv7Ut6Sr5Qp4On3Ml2Kj1Ih0Gf9Ed8Cb7Aa6Zy",
				Type:        "ssh-rsa",
				Comment:     "ci@build-runner",
				PublicKey:   "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC9mQ2xR4tYuI7oP0aSdFgHjKlZxCvBnM3qWeRtYuIoPaSdFgHjKlZxCvBnM ci@build-runner",
				User:        "deploy",
			},
		},
	}

	s.sshSessions = []providers.SSHSessionInfo{
		{User: "deploy", FromIP: s.id.privateIP, TTY: "pts/0", PID: 28194, StartedAt: stamp(now.Add(-94 * time.Minute)), IdleSeconds: 212},
		{User: "root", FromIP: "10.20.30.4", TTY: "pts/1", PID: 28712, StartedAt: stamp(now.Add(-11 * time.Minute)), IdleSeconds: 8},
	}
}

func jailFor(kind string) string {
	switch kind {
	case "web_bruteforce":
		return "nginx-http-auth"
	case "mail_bruteforce":
		return "postfix-sasl"
	default:
		return "sshd"
	}
}

func threatSample(kind, ip string) string {
	switch kind {
	case "web_bruteforce":
		return fmt.Sprintf(`%s - - "POST /wp-login.php HTTP/1.1" 401 226`, ip)
	case "mail_bruteforce":
		return fmt.Sprintf("dovecot: imap-login: Aborted login (auth failed, 3 attempts): rip=%s", ip)
	default:
		return fmt.Sprintf("sshd: Failed password for invalid user admin from %s port 51234 ssh2", ip)
	}
}

// recordThreat folds a new burst into the running observation and returns
// the delta. The control plane adds attempts on conflict, so pushing the
// cumulative figure would double-count every tick.
func (s *Sim) recordThreat(ip string, burst int) providers.ThreatObservation {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	observation, ok := s.threats[ip]
	if !ok {
		observation = &providers.ThreatObservation{
			Kind:      "ssh_bruteforce",
			SourceIP:  ip,
			Target:    "sshd:22",
			FirstSeen: stamp(now),
			Sample:    threatSample("ssh_bruteforce", ip),
		}
		s.threats[ip] = observation
	}
	observation.Attempts += burst
	observation.LastSeen = stamp(now)

	if observation.Attempts >= autoBanThreshold {
		if _, banned := s.bans[ip]; !banned {
			s.bans[ip] = providers.BanEntry{
				IP:        ip,
				Jail:      jailFor(observation.Kind),
				BannedAt:  stamp(now),
				ExpiresAt: stampPtr(now.Add(time.Hour)),
				Attempts:  observation.Attempts,
			}
		}
	}

	delta := *observation
	delta.Attempts = burst
	return delta
}

func (s *Sim) rotateSSHSession(round int64) {
	now := time.Now().UTC()
	session := providers.SSHSessionInfo{
		User:        pick(s.seed, round, []string{"deploy", "root", "alice"}),
		FromIP:      pick(s.seed^0x3, round, []string{s.id.privateIP, "10.20.30.4", "10.20.30.22"}),
		TTY:         fmt.Sprintf("pts/%d", round%4),
		PID:         29000 + int(mix(s.seed^uint64(round))%800),
		StartedAt:   stamp(now),
		IdleSeconds: 0,
	}

	s.mu.Lock()
	if len(s.sshSessions) >= 3 {
		s.sshSessions = s.sshSessions[1:]
	}
	s.sshSessions = append(s.sshSessions, session)
	s.mu.Unlock()

	s.emit(topicSSHSession, session)
}

/* ------------------------------ firewall ----------------------------- */

type simFirewall struct{ *Sim }

func (s simFirewall) Status(context.Context) (providers.FirewallStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return providers.FirewallStatus{
		Backend:         "nftables",
		Enabled:         s.fwEnabled,
		DefaultInbound:  s.fwInbound,
		DefaultOutbound: s.fwOutbound,
		RuleCount:       len(s.fwRules),
	}, nil
}

func (s simFirewall) List(context.Context) ([]providers.FirewallRuleInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.FirewallRuleInfo, len(s.fwRules))
	copy(out, s.fwRules)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Priority < out[j].Priority })
	return out, nil
}

func (s simFirewall) Apply(_ context.Context, p providers.FwApplyParams) (providers.FwApplyResult, error) {
	rules := make([]providers.FirewallRuleInfo, 0, len(p.Rules))
	for _, rule := range p.Rules {
		rules = append(rules, providers.FirewallRuleInfo{
			ID:          fmt.Sprintf("inet-filter-%s-%d", rule.Direction, rule.Priority),
			Priority:    rule.Priority,
			Action:      rule.Action,
			Direction:   rule.Direction,
			Protocol:    rule.Protocol,
			PortSpec:    rule.PortSpec,
			Source:      rule.Source,
			Destination: rule.Destination,
			Comment:     rule.Comment,
			Enabled:     true,
			Backend:     "nftables",
		})
	}

	s.mu.Lock()
	previous := &rollbackWindow{
		kind:     "firewall",
		rules:    append([]providers.FirewallRuleInfo(nil), s.fwRules...),
		inbound:  s.fwInbound,
		outbound: s.fwOutbound,
	}
	s.fwRules = rules
	s.fwInbound = p.DefaultInbound
	s.fwOutbound = p.DefaultOutbound

	var token *string
	if p.RollbackSeconds > 0 {
		issued := fmt.Sprintf("fw-%016x", mix(s.seed^uint64(time.Now().UnixNano())))
		previous.expires = time.Now().Add(time.Duration(p.RollbackSeconds) * time.Second)
		s.rollbacks[issued] = previous
		token = &issued
	}
	s.mu.Unlock()

	s.writeNftablesConfig()
	if token != nil {
		s.scheduleRollback(*token, time.Duration(p.RollbackSeconds)*time.Second)
	}

	return providers.FwApplyResult{Applied: len(rules), RollbackToken: token}, nil
}

// scheduleRollback is the lockout guard: an unconfirmed rule set reverts
// itself, so a bad `deny 22` costs a minute rather than the machine.
func (s *Sim) scheduleRollback(token string, after time.Duration) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		select {
		case <-time.After(after):
		case <-s.ctx.Done():
			return
		}

		s.mu.Lock()
		staged, pending := s.rollbacks[token]
		if !pending {
			s.mu.Unlock()
			return
		}
		delete(s.rollbacks, token)
		switch staged.kind {
		case "firewall":
			s.fwRules, s.fwInbound, s.fwOutbound = staged.rules, staged.inbound, staged.outbound
		case "ssh":
			s.sshConfig = staged.sshConfig
		}
		s.mu.Unlock()

		s.log.Warn("rolled back an unconfirmed change", "token", token, "kind", staged.kind)
		if staged.kind == "firewall" {
			s.writeNftablesConfig()
		} else {
			s.writeSSHDConfig()
		}
	}()
}

func (s simFirewall) Confirm(_ context.Context, p providers.FwConfirmParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, pending := s.rollbacks[p.RollbackToken]; !pending {
		return fmt.Errorf("rollback token %s is unknown or already expired: %w", p.RollbackToken, providers.ErrNotFound)
	}
	delete(s.rollbacks, p.RollbackToken)
	return nil
}

func (s simFirewall) Ban(_ context.Context, p providers.FwBanParams) error {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	// The contract carries a single address, so a range is reported by the
	// address it starts at rather than by a string the panel cannot parse.
	address, _, _ := strings.Cut(p.Target, "/")
	entry := providers.BanEntry{
		IP:       address,
		Jail:     "manual",
		BannedAt: stamp(now),
		Attempts: 0,
	}
	if observation, ok := s.threats[p.Target]; ok {
		entry.Jail = jailFor(observation.Kind)
		entry.Attempts = observation.Attempts
	}
	if p.DurationSeconds > 0 {
		entry.ExpiresAt = stampPtr(now.Add(time.Duration(p.DurationSeconds) * time.Second))
	}
	s.bans[p.Target] = entry
	return nil
}

func (s simFirewall) Unban(_ context.Context, p providers.FwUnbanParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, banned := s.bans[p.Target]; !banned {
		return fmt.Errorf("%s is not banned: %w", p.Target, providers.ErrNotFound)
	}
	delete(s.bans, p.Target)
	return nil
}

func (s simFirewall) Bans(context.Context) ([]providers.BanEntry, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.BanEntry, 0, len(s.bans))
	for ip, entry := range s.bans {
		if entry.ExpiresAt != nil {
			if expiry, err := time.Parse(time.RFC3339Nano, *entry.ExpiresAt); err == nil && expiry.Before(now) {
				delete(s.bans, ip)
				continue
			}
		}
		out = append(out, entry)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].BannedAt > out[j].BannedAt })
	return out, nil
}

func (s simFirewall) Threats(_ context.Context, p providers.FwThreatsParams) ([]providers.ThreatObservation, error) {
	var since time.Time
	if p.Since != "" {
		parsed, err := time.Parse(time.RFC3339, p.Since)
		if err != nil {
			return nil, fmt.Errorf("since must be an RFC3339 timestamp: %w", providers.ErrInvalidParams)
		}
		since = parsed.UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.ThreatObservation, 0, len(s.threats))
	for _, observation := range s.threats {
		if !since.IsZero() {
			last, err := time.Parse(time.RFC3339Nano, observation.LastSeen)
			if err == nil && last.Before(since) {
				continue
			}
		}
		out = append(out, *observation)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastSeen > out[j].LastSeen })
	if p.Limit > 0 && len(out) > p.Limit {
		out = out[:p.Limit]
	}
	return out, nil
}

// writeNftablesConfig keeps /etc/nftables.conf in step with the rule set,
// so reading the file in the editor shows what `fw.list` reports.
func (s *Sim) writeNftablesConfig() {
	s.mu.Lock()
	rules := append([]providers.FirewallRuleInfo(nil), s.fwRules...)
	inbound, outbound := s.fwInbound, s.fwOutbound
	s.mu.Unlock()

	sort.SliceStable(rules, func(i, j int) bool { return rules[i].Priority < rules[j].Priority })

	var b strings.Builder
	b.WriteString("#!/usr/sbin/nft -f\nflush ruleset\n\ntable inet filter {\n")
	for _, chain := range []struct {
		name      string
		direction string
		policy    string
	}{
		{"input", "inbound", inbound},
		{"output", "outbound", outbound},
	} {
		policy := "accept"
		if chain.policy == "deny" {
			policy = "drop"
		}
		fmt.Fprintf(&b, "    chain %s {\n        type filter hook %s priority 0; policy %s;\n", chain.name, chain.name, policy)
		if chain.name == "input" {
			b.WriteString("        ct state established,related accept\n        iif \"lo\" accept\n")
		}
		for _, rule := range rules {
			if rule.Direction != chain.direction || !rule.Enabled {
				continue
			}
			b.WriteString("        " + nftLine(rule) + "\n")
		}
		b.WriteString("    }\n\n")
	}
	b.WriteString("}\n")

	s.fs.mu.Lock()
	s.fs.file("/etc/nftables.conf", b.String())
	s.fs.mu.Unlock()
}

func nftLine(rule providers.FirewallRuleInfo) string {
	var parts []string
	if rule.Source != nil && *rule.Source != "" {
		parts = append(parts, "ip saddr "+*rule.Source)
	}
	if rule.Destination != nil && *rule.Destination != "" {
		parts = append(parts, "ip daddr "+*rule.Destination)
	}
	switch rule.Protocol {
	case "icmp":
		parts = append(parts, "ip protocol icmp")
	case "any":
	default:
		if rule.PortSpec != nil && *rule.PortSpec != "" {
			parts = append(parts, fmt.Sprintf("%s dport { %s }", rule.Protocol, *rule.PortSpec))
		} else {
			parts = append(parts, "meta l4proto "+rule.Protocol)
		}
	}

	verb := map[string]string{"allow": "accept", "deny": "drop", "reject": "reject"}[rule.Action]
	line := strings.Join(append(parts, verb), " ")
	if rule.Comment != nil && *rule.Comment != "" {
		line += fmt.Sprintf(" comment %q", *rule.Comment)
	}
	return line
}

/* -------------------------------- ssh -------------------------------- */

type simSSH struct{ *Sim }

func (s simSSH) ListKeys(_ context.Context, p providers.SSHKeysListParams) ([]providers.SSHKeyInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := []providers.SSHKeyInfo{}
	for user, keys := range s.sshKeys {
		if p.User != "" && user != p.User {
			continue
		}
		out = append(out, keys...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].User != out[j].User {
			return out[i].User < out[j].User
		}
		return out[i].Comment < out[j].Comment
	})
	return out, nil
}

func (s simSSH) ApplyKeys(_ context.Context, p providers.SSHKeysApplyParams) (int, error) {
	keys := make([]providers.SSHKeyInfo, 0, len(p.Keys))
	var authorized strings.Builder

	for _, key := range p.Keys {
		fields := strings.Fields(key.PublicKey)
		if len(fields) < 2 {
			return 0, fmt.Errorf("public key for %s is malformed: %w", p.User, providers.ErrInvalidParams)
		}
		keys = append(keys, providers.SSHKeyInfo{
			Fingerprint: fingerprintOf(fields[1]),
			Type:        fields[0],
			Comment:     key.Comment,
			PublicKey:   key.PublicKey,
			User:        p.User,
		})
		authorized.WriteString(key.PublicKey)
		if key.Comment != "" && !strings.HasSuffix(key.PublicKey, key.Comment) {
			authorized.WriteString(" " + key.Comment)
		}
		authorized.WriteString("\n")
	}

	s.mu.Lock()
	s.sshKeys[p.User] = keys
	s.mu.Unlock()

	home := "/home/" + p.User
	if p.User == "root" {
		home = "/root"
	}
	s.fs.mu.Lock()
	s.fs.dirAs(home+"/.ssh", "0700", p.User, uidFor(p.User))
	s.fs.fileAs(home+"/.ssh/authorized_keys", authorized.String(), "0600", p.User, uidFor(p.User))
	s.fs.mu.Unlock()

	return len(keys), nil
}

// fingerprintOf is a stand-in for a real SHA-256 of the decoded blob: it
// is stable per key, which is the only property a listing depends on.
func fingerprintOf(blob string) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	seed := hashString(blob)

	var b strings.Builder
	b.WriteString("SHA256:")
	for i := 0; i < 43; i++ {
		seed = mix(seed)
		b.WriteByte(alphabet[seed%uint64(len(alphabet))])
	}
	return b.String()
}

func (s simSSH) ReadConfig(context.Context) (providers.SSHConfigInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sshConfig, nil
}

func (s simSSH) ApplyConfig(_ context.Context, p providers.SSHConfigApplyParams) (providers.SSHConfigApplyResult, error) {
	s.mu.Lock()

	previous := &rollbackWindow{kind: "ssh", sshConfig: s.sshConfig}
	next := s.sshConfig
	if p.Port != nil {
		next.Port = *p.Port
	}
	if p.PermitRootLogin != nil {
		next.PermitRootLogin = *p.PermitRootLogin
	}
	if p.PasswordAuthentication != nil {
		next.PasswordAuthentication = *p.PasswordAuthentication
	}
	if p.PubkeyAuthentication != nil {
		next.PubkeyAuthentication = *p.PubkeyAuthentication
	}
	if p.MaxAuthTries != nil {
		next.MaxAuthTries = *p.MaxAuthTries
	}
	if p.AllowUsers != nil {
		next.AllowUsers = p.AllowUsers
	}
	if p.AllowGroups != nil {
		next.AllowGroups = p.AllowGroups
	}
	if p.X11Forwarding != nil {
		next.X11Forwarding = *p.X11Forwarding
	}
	s.sshConfig = next

	var token *string
	if p.RollbackSeconds > 0 {
		issued := fmt.Sprintf("ssh-%016x", mix(s.seed^uint64(time.Now().UnixNano())))
		previous.expires = time.Now().Add(time.Duration(p.RollbackSeconds) * time.Second)
		s.rollbacks[issued] = previous
		token = &issued
	}
	s.mu.Unlock()

	s.writeSSHDConfig()
	if token != nil {
		s.scheduleRollback(*token, time.Duration(p.RollbackSeconds)*time.Second)
	}

	return providers.SSHConfigApplyResult{RollbackToken: token}, nil
}

func (s *Sim) writeSSHDConfig() {
	s.mu.Lock()
	config := s.sshConfig
	s.mu.Unlock()

	var b strings.Builder
	b.WriteString("Include /etc/ssh/sshd_config.d/*.conf\n\n")
	fmt.Fprintf(&b, "Port %d\n", config.Port)
	b.WriteString("AddressFamily any\nListenAddress 0.0.0.0\n\n")
	fmt.Fprintf(&b, "PermitRootLogin %s\n", config.PermitRootLogin)
	fmt.Fprintf(&b, "PubkeyAuthentication %s\n", yesNo(config.PubkeyAuthentication))
	fmt.Fprintf(&b, "PasswordAuthentication %s\n", yesNo(config.PasswordAuthentication))
	b.WriteString("KbdInteractiveAuthentication no\n")
	fmt.Fprintf(&b, "MaxAuthTries %d\n", config.MaxAuthTries)
	if len(config.AllowUsers) > 0 {
		fmt.Fprintf(&b, "AllowUsers %s\n", strings.Join(config.AllowUsers, " "))
	}
	if len(config.AllowGroups) > 0 {
		fmt.Fprintf(&b, "AllowGroups %s\n", strings.Join(config.AllowGroups, " "))
	}
	b.WriteString("\nUsePAM yes\n")
	fmt.Fprintf(&b, "X11Forwarding %s\n", yesNo(config.X11Forwarding))
	b.WriteString("PrintMotd no\nClientAliveInterval 300\nClientAliveCountMax 2\n\nAcceptEnv LANG LC_*\nSubsystem sftp /usr/lib/openssh/sftp-server\n")

	s.fs.mu.Lock()
	s.fs.file("/etc/ssh/sshd_config", b.String())
	s.fs.mu.Unlock()
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

func (s simSSH) Sessions(context.Context) ([]providers.SSHSessionInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.SSHSessionInfo, len(s.sshSessions))
	copy(out, s.sshSessions)
	return out, nil
}
