//go:build linux

package linux

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Firewall.
 *
 * nftables is preferred, iptables and ufw are the fallbacks, and the
 * backend is decided once by what is actually installed.
 *
 * The important part of this file is the rollback window. fw.apply
 * snapshots the live ruleset, installs the new one, and schedules a
 * revert. Only an fw.confirm carrying the matching token cancels it. An
 * operator who firewalls themselves out therefore gets their box back in
 * under a minute instead of needing console access — which is the single
 * most common way a panel bricks a remote server.
 * ------------------------------------------------------------------ */

var (
	ipv4Pattern = regexp.MustCompile(`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`)
	ipv6Pattern = regexp.MustCompile(`\b(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\b`)
	ufwRule     = regexp.MustCompile(`^\[\s*(\d+)\]\s+(.*?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s*(.*)$`)
)

type firewallOps struct{ p *provider }

// backend picks the mechanism this host will be managed through. It is
// derived from what is installed rather than configured, because a
// backend that is not present cannot be made to work.
func (o firewallOps) backend() (string, error) {
	switch {
	case o.p.has(providers.CapNftables):
		return providers.CapNftables, nil
	case o.p.has(providers.CapIptables):
		return providers.CapIptables, nil
	case o.p.has(providers.CapUfw):
		return providers.CapUfw, nil
	default:
		return "", unsupported("no firewall backend on this host")
	}
}

/* -------------------------------- status ------------------------------ */

func (o firewallOps) Status(ctx context.Context) (providers.FirewallStatus, error) {
	backend, err := o.backend()
	if err != nil {
		return providers.FirewallStatus{}, err
	}

	status := providers.FirewallStatus{Backend: backend, DefaultInbound: "allow", DefaultOutbound: "allow"}
	rules, err := o.List(ctx)
	if err != nil {
		return status, err
	}
	status.RuleCount = len(rules)

	switch backend {
	case providers.CapNftables:
		out, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"list", "table", "inet", nftTable}, Env: cLocale()})
		if err != nil {
			return status, nil
		}
		status.Enabled = true
		status.DefaultInbound = policyFromNft(out, "input")
		status.DefaultOutbound = policyFromNft(out, "output")

	case providers.CapIptables:
		out, err := runWith(ctx, execOptions{Name: "iptables", Args: []string{"-S"}, Env: cLocale()})
		if err != nil {
			return status, err
		}
		status.Enabled = true
		for _, line := range splitLines(out) {
			fields := strings.Fields(line)
			if len(fields) != 3 || fields[0] != "-P" {
				continue
			}
			switch fields[1] {
			case "INPUT":
				status.DefaultInbound = policyFromIptables(fields[2])
			case "OUTPUT":
				status.DefaultOutbound = policyFromIptables(fields[2])
			}
		}

	case providers.CapUfw:
		out, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"status", "verbose"}, Env: cLocale()})
		if err != nil {
			return status, err
		}
		status.Enabled = strings.Contains(out, "Status: active")
		for _, line := range splitLines(out) {
			if !strings.HasPrefix(line, "Default:") {
				continue
			}
			if strings.Contains(line, "deny (incoming)") || strings.Contains(line, "reject (incoming)") {
				status.DefaultInbound = "deny"
			}
			if strings.Contains(line, "deny (outgoing)") || strings.Contains(line, "reject (outgoing)") {
				status.DefaultOutbound = "deny"
			}
		}
	}
	return status, nil
}

/* --------------------------------- list ------------------------------- */

func (o firewallOps) List(ctx context.Context) ([]providers.FirewallRuleInfo, error) {
	backend, err := o.backend()
	if err != nil {
		return nil, err
	}

	switch backend {
	case providers.CapNftables:
		return o.listNft(ctx)
	case providers.CapIptables:
		return o.listIptables(ctx)
	default:
		return o.listUfw(ctx)
	}
}

// nftRuleset is the subset of `nft -j list ruleset` this agent reads.
type nftRuleset struct {
	Nftables []struct {
		Rule *struct {
			Family  string            `json:"family"`
			Table   string            `json:"table"`
			Chain   string            `json:"chain"`
			Handle  int               `json:"handle"`
			Comment string            `json:"comment"`
			Expr    []json.RawMessage `json:"expr"`
		} `json:"rule"`
		Chain *struct {
			Family string `json:"family"`
			Table  string `json:"table"`
			Name   string `json:"name"`
			Policy string `json:"policy"`
		} `json:"chain"`
	} `json:"nftables"`
}

func (o firewallOps) listNft(ctx context.Context) ([]providers.FirewallRuleInfo, error) {
	out, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"-j", "list", "ruleset"}, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	var parsed nftRuleset
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return nil, fmt.Errorf("decode nft ruleset: %w", err)
	}

	rules := make([]providers.FirewallRuleInfo, 0, 32)
	priority := 0
	for _, node := range parsed.Nftables {
		if node.Rule == nil {
			continue
		}
		priority++
		rule := providers.FirewallRuleInfo{
			ID:        fmt.Sprintf("nft:%s:%s:%d", node.Rule.Table, node.Rule.Chain, node.Rule.Handle),
			Priority:  priority,
			Action:    "allow",
			Direction: directionFromChain(node.Rule.Chain),
			Protocol:  "any",
			Enabled:   true,
			Backend:   providers.CapNftables,
		}
		if node.Rule.Comment != "" {
			rule.Comment = stringPtr(node.Rule.Comment)
		}
		describeNftExpressions(node.Rule.Expr, &rule)
		rules = append(rules, rule)
	}
	return rules, nil
}

// describeNftExpressions reduces one rule's expression list to the flat
// shape the panel renders. Anything it does not recognise is left at its
// default rather than guessed at.
func describeNftExpressions(expressions []json.RawMessage, rule *providers.FirewallRuleInfo) {
	for _, raw := range expressions {
		var node map[string]json.RawMessage
		if err := json.Unmarshal(raw, &node); err != nil {
			continue
		}

		for key, value := range node {
			switch key {
			case "accept":
				rule.Action = "allow"
			case "drop":
				rule.Action = "deny"
			case "reject":
				rule.Action = "reject"
			case "match":
				describeNftMatch(value, rule)
			}
		}
	}
}

func describeNftMatch(raw json.RawMessage, rule *providers.FirewallRuleInfo) {
	var match struct {
		Left struct {
			Payload *struct {
				Protocol string `json:"protocol"`
				Field    string `json:"field"`
			} `json:"payload"`
			Meta *struct {
				Key string `json:"key"`
			} `json:"meta"`
		} `json:"left"`
		Right json.RawMessage `json:"right"`
	}
	if err := json.Unmarshal(raw, &match); err != nil {
		return
	}
	value := renderNftValue(match.Right)

	if match.Left.Meta != nil && match.Left.Meta.Key == "l4proto" {
		rule.Protocol = normalizeFirewallProtocol(value)
		return
	}
	if match.Left.Payload == nil {
		return
	}
	switch match.Left.Payload.Field {
	case "dport":
		rule.PortSpec = stringPtr(value)
		rule.Protocol = normalizeFirewallProtocol(match.Left.Payload.Protocol)
	case "sport":
		rule.PortSpec = stringPtr(value)
	case "saddr":
		rule.Source = stringPtr(value)
	case "daddr":
		rule.Destination = stringPtr(value)
	}
}

// renderNftValue flattens the several shapes nft uses for the right side
// of a match: a scalar, a set, a range or a prefix.
func renderNftValue(raw json.RawMessage) string {
	var scalar any
	if err := json.Unmarshal(raw, &scalar); err != nil {
		return ""
	}

	switch value := scalar.(type) {
	case string:
		return value
	case float64:
		return strconv.FormatInt(int64(value), 10)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			encoded, err := json.Marshal(item)
			if err != nil {
				continue
			}
			parts = append(parts, renderNftValue(encoded))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		// A set element with a timeout is wrapped twice: {"elem":{"val":…}}.
		for _, key := range []string{"set", "elem", "val"} {
			nested, ok := value[key]
			if !ok {
				continue
			}
			encoded, err := json.Marshal(nested)
			if err == nil {
				return renderNftValue(encoded)
			}
		}
		if prefix, ok := value["prefix"].(map[string]any); ok {
			return fmt.Sprintf("%v/%v", prefix["addr"], prefix["len"])
		}
		if window, ok := value["range"].([]any); ok && len(window) == 2 {
			return fmt.Sprintf("%v-%v", window[0], window[1])
		}
	}
	return ""
}

func (o firewallOps) listIptables(ctx context.Context) ([]providers.FirewallRuleInfo, error) {
	out, err := runWith(ctx, execOptions{Name: "iptables", Args: []string{"-S"}, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	rules := make([]providers.FirewallRuleInfo, 0, 32)
	priority := 0
	for _, line := range splitLines(out) {
		if !strings.HasPrefix(line, "-A ") {
			continue
		}
		priority++
		rules = append(rules, parseIptablesRule(line, priority))
	}
	return rules, nil
}

func parseIptablesRule(line string, priority int) providers.FirewallRuleInfo {
	fields := strings.Fields(line)
	rule := providers.FirewallRuleInfo{
		ID:        fmt.Sprintf("iptables:%d", priority),
		Priority:  priority,
		Action:    "allow",
		Direction: "inbound",
		Protocol:  "any",
		Enabled:   true,
		Backend:   providers.CapIptables,
	}

	for i := 0; i < len(fields); i++ {
		switch fields[i] {
		case "-A":
			if i+1 < len(fields) {
				rule.Direction = directionFromChain(fields[i+1])
			}
		case "-p":
			if i+1 < len(fields) {
				rule.Protocol = normalizeFirewallProtocol(fields[i+1])
			}
		case "--dport", "--dports":
			if i+1 < len(fields) {
				rule.PortSpec = stringPtr(fields[i+1])
			}
		case "-s":
			if i+1 < len(fields) {
				rule.Source = stringPtr(fields[i+1])
			}
		case "-d":
			if i+1 < len(fields) {
				rule.Destination = stringPtr(fields[i+1])
			}
		case "-j":
			if i+1 < len(fields) {
				rule.Action = actionFromTarget(fields[i+1])
			}
		case "--comment":
			if i+1 < len(fields) {
				rule.Comment = stringPtr(strings.Trim(fields[i+1], `"`))
			}
		}
	}
	return rule
}

func (o firewallOps) listUfw(ctx context.Context) ([]providers.FirewallRuleInfo, error) {
	out, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"status", "numbered"}, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	rules := make([]providers.FirewallRuleInfo, 0, 32)
	for _, line := range splitLines(out) {
		match := ufwRule.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			continue
		}
		priority, _ := strconv.Atoi(match[1])

		rule := providers.FirewallRuleInfo{
			ID:        "ufw:" + match[1],
			Priority:  priority,
			Action:    actionFromTarget(match[3]),
			Direction: "inbound",
			Protocol:  "any",
			Enabled:   true,
			Backend:   providers.CapUfw,
		}
		if match[4] == "OUT" {
			rule.Direction = "outbound"
		}
		port, protocol := splitUfwTarget(match[2])
		if port != "" {
			rule.PortSpec = stringPtr(port)
		}
		if protocol != "" {
			rule.Protocol = protocol
		}
		if source := strings.TrimSpace(match[5]); source != "" && source != "Anywhere" {
			rule.Source = stringPtr(source)
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

/* -------------------------------- apply ------------------------------- */

func (o firewallOps) Apply(ctx context.Context, p providers.FwApplyParams) (providers.FwApplyResult, error) {
	backend, err := o.backend()
	if err != nil {
		return providers.FwApplyResult{}, err
	}
	for _, rule := range p.Rules {
		if err := checkRule(rule); err != nil {
			return providers.FwApplyResult{}, err
		}
	}

	// The snapshot is taken before anything changes, because it is the
	// only thing that can put the host back.
	snapshot, err := o.snapshot(ctx, backend)
	if err != nil {
		return providers.FwApplyResult{}, err
	}

	switch backend {
	case providers.CapNftables:
		err = o.applyNft(ctx, p)
	case providers.CapIptables:
		err = o.applyIptables(ctx, p)
	default:
		err = o.applyUfw(ctx, p)
	}
	if err != nil {
		// A half-applied rule set is worse than the old one, so the
		// snapshot goes back immediately rather than after the window.
		if restoreErr := o.restore(ctx, snapshot); restoreErr != nil {
			o.p.log.Error("could not restore the firewall after a failed apply", "error", restoreErr)
		}
		return providers.FwApplyResult{}, err
	}

	token, err := o.p.rollback.arm("firewall", p.RollbackSeconds, func(revertCtx context.Context) error {
		return o.restore(revertCtx, snapshot)
	})
	if err != nil {
		return providers.FwApplyResult{}, err
	}
	return providers.FwApplyResult{Applied: len(p.Rules), RollbackToken: token}, nil
}

func (o firewallOps) Confirm(ctx context.Context, p providers.FwConfirmParams) error {
	_ = ctx
	return o.p.rollback.confirm(p.RollbackToken)
}

// applyNft loads the whole table in one atomic transaction: nft either
// takes the entire script or leaves the kernel untouched, so there is no
// window in which half the rules are live. The argv is a constant; the
// rule set travels on stdin.
func (o firewallOps) applyNft(ctx context.Context, p providers.FwApplyParams) error {
	_, err := runWith(ctx, execOptions{
		Name:  "nft",
		Args:  []string{"-f", "-"},
		Stdin: []byte(renderNftScript(p)),
		Env:   cLocale(),
	})
	return err
}

func (o firewallOps) applyIptables(ctx context.Context, p providers.FwApplyParams) error {
	for _, args := range iptablesPrelude(p) {
		if _, err := runWith(ctx, execOptions{Name: "iptables", Args: args, Env: cLocale()}); err != nil {
			return err
		}
	}

	for _, rule := range orderedRules(p.Rules) {
		args, ok := iptablesArgs(rule)
		if !ok {
			continue
		}
		if _, err := runWith(ctx, execOptions{Name: "iptables", Args: args, Env: cLocale()}); err != nil {
			return err
		}
	}
	return nil
}

func (o firewallOps) applyUfw(ctx context.Context, p providers.FwApplyParams) error {
	for _, args := range ufwPrelude(p) {
		if _, err := runWith(ctx, execOptions{Name: "ufw", Args: args, Env: cLocale()}); err != nil {
			return err
		}
	}

	for _, rule := range orderedRules(p.Rules) {
		args, ok := ufwArgs(rule)
		if !ok {
			continue
		}
		if _, err := runWith(ctx, execOptions{Name: "ufw", Args: args, Env: cLocale()}); err != nil {
			return err
		}
	}

	_, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"--force", "enable"}, Env: cLocale()})
	return err
}

/* ------------------------------ snapshots ----------------------------- */

// firewallSnapshot is everything needed to put the previous rule set
// back, held in memory for the duration of the rollback window.
type firewallSnapshot struct {
	backend string
	ruleset []byte
	rules6  []byte
}

func (o firewallOps) snapshot(ctx context.Context, backend string) (*firewallSnapshot, error) {
	snapshot := &firewallSnapshot{backend: backend}

	switch backend {
	case providers.CapNftables:
		out, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"list", "ruleset"}, Env: cLocale()})
		if err != nil {
			return nil, err
		}
		snapshot.ruleset = []byte(out)

	case providers.CapIptables:
		out, err := runWith(ctx, execOptions{Name: "iptables-save", Env: cLocale()})
		if err != nil {
			return nil, err
		}
		snapshot.ruleset = []byte(out)
		if out6, err := runWith(ctx, execOptions{Name: "ip6tables-save", Env: cLocale()}); err == nil {
			snapshot.rules6 = []byte(out6)
		}

	case providers.CapUfw:
		// ufw keeps its rule set on disk, so the files are the snapshot.
		raw, err := os.ReadFile(filepath.Join(ufwRulesDir, "user.rules"))
		if err != nil {
			return nil, wrapFsError(filepath.Join(ufwRulesDir, "user.rules"), err)
		}
		snapshot.ruleset = raw
		if raw6, err := os.ReadFile(filepath.Join(ufwRulesDir, "user6.rules")); err == nil {
			snapshot.rules6 = raw6
		}
	}
	return snapshot, nil
}

func (o firewallOps) restore(ctx context.Context, snapshot *firewallSnapshot) error {
	if snapshot == nil {
		return nil
	}

	switch snapshot.backend {
	case providers.CapNftables:
		script := append([]byte("flush ruleset\n"), snapshot.ruleset...)
		_, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"-f", "-"}, Stdin: script, Env: cLocale()})
		return err

	case providers.CapIptables:
		if _, err := runWith(ctx, execOptions{Name: "iptables-restore", Stdin: snapshot.ruleset, Env: cLocale()}); err != nil {
			return err
		}
		if len(snapshot.rules6) > 0 {
			if _, err := runWith(ctx, execOptions{Name: "ip6tables-restore", Stdin: snapshot.rules6, Env: cLocale()}); err != nil {
				return err
			}
		}
		return nil

	case providers.CapUfw:
		if err := writeAtomic(filepath.Join(ufwRulesDir, "user.rules"), snapshot.ruleset, 0o640); err != nil {
			return err
		}
		if len(snapshot.rules6) > 0 {
			if err := writeAtomic(filepath.Join(ufwRulesDir, "user6.rules"), snapshot.rules6, 0o640); err != nil {
				return err
			}
		}
		_, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"reload"}, Env: cLocale()})
		return err
	}
	return nil
}

/* --------------------------------- bans ------------------------------- */

func (o firewallOps) Ban(ctx context.Context, p providers.FwBanParams) error {
	backend, err := o.backend()
	if err != nil {
		return err
	}
	target, family, err := parseTarget(p.Target)
	if err != nil {
		return err
	}

	switch backend {
	case providers.CapNftables:
		if err := o.ensureBanTable(ctx); err != nil {
			return err
		}
		element := target
		if p.DurationSeconds > 0 {
			element += " timeout " + strconv.Itoa(p.DurationSeconds) + "s"
		}
		_, err := runWith(ctx, execOptions{
			Name: "nft",
			Args: []string{"add", "element", "inet", nftBanTable, banSet(family), "{ " + element + " }"},
			Env:  cLocale(),
		})
		return err

	case providers.CapIptables:
		binary := "iptables"
		if family == "ip6" {
			binary = "ip6tables"
		}
		_, err := runWith(ctx, execOptions{
			Name: binary,
			Args: []string{"-I", "INPUT", "1", "-s", target, "-m", "comment", "--comment", iptablesBanComment, "-j", "DROP"},
			Env:  cLocale(),
		})
		return err

	default:
		_, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"insert", "1", "deny", "from", target}, Env: cLocale()})
		return err
	}
}

func (o firewallOps) Unban(ctx context.Context, p providers.FwUnbanParams) error {
	backend, err := o.backend()
	if err != nil {
		return err
	}
	target, family, err := parseTarget(p.Target)
	if err != nil {
		return err
	}

	switch backend {
	case providers.CapNftables:
		_, err := runWith(ctx, execOptions{
			Name: "nft",
			Args: []string{"delete", "element", "inet", nftBanTable, banSet(family), "{ " + target + " }"},
			Env:  cLocale(),
		})
		return err

	case providers.CapIptables:
		binary := "iptables"
		if family == "ip6" {
			binary = "ip6tables"
		}
		_, err := runWith(ctx, execOptions{
			Name: binary,
			Args: []string{"-D", "INPUT", "-s", target, "-m", "comment", "--comment", iptablesBanComment, "-j", "DROP"},
			Env:  cLocale(),
		})
		return err

	default:
		_, err := runWith(ctx, execOptions{Name: "ufw", Args: []string{"--force", "delete", "deny", "from", target}, Env: cLocale()})
		return err
	}
}

func (o firewallOps) Bans(ctx context.Context) ([]providers.BanEntry, error) {
	bans := make([]providers.BanEntry, 0, 32)

	if o.p.has(providers.CapNftables) {
		out, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"-j", "list", "table", "inet", nftBanTable}, Env: cLocale()})
		if err == nil {
			bans = append(bans, parseNftBans(out)...)
		}
	}
	if o.p.has(providers.CapFail2ban) {
		bans = append(bans, o.fail2banBans(ctx)...)
	}

	sortSlice(bans, func(a, b providers.BanEntry) bool { return a.IP < b.IP })
	return bans, nil
}

// ensureBanTable creates the ban table on demand, so fw.ban works on a
// host whose rule set Kaname has never applied.
func (o firewallOps) ensureBanTable(ctx context.Context) error {
	script := fmt.Sprintf(`table inet %s {
  set banned4 { type ipv4_addr; flags interval,timeout; }
  set banned6 { type ipv6_addr; flags interval,timeout; }
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr @banned4 drop
    ip6 saddr @banned6 drop
  }
}
`, nftBanTable)

	_, err := runWith(ctx, execOptions{Name: "nft", Args: []string{"-f", "-"}, Stdin: []byte(script), Env: cLocale()})
	return err
}

func parseNftBans(out string) []providers.BanEntry {
	var parsed struct {
		Nftables []struct {
			Set *struct {
				Name string `json:"name"`
				Elem []any  `json:"elem"`
			} `json:"set"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return nil
	}

	bans := make([]providers.BanEntry, 0, 16)
	for _, node := range parsed.Nftables {
		if node.Set == nil {
			continue
		}
		for _, element := range node.Set.Elem {
			encoded, err := json.Marshal(element)
			if err != nil {
				continue
			}
			address := renderNftValue(encoded)
			if address == "" {
				continue
			}
			bans = append(bans, providers.BanEntry{IP: address, Jail: "kaname", BannedAt: nowRFC3339()})
		}
	}
	return bans
}

func (o firewallOps) fail2banBans(ctx context.Context) []providers.BanEntry {
	out, err := runWith(ctx, execOptions{Name: "fail2ban-client", Args: []string{"status"}, Env: cLocale()})
	if err != nil {
		return nil
	}

	jails := []string{}
	for _, line := range splitLines(out) {
		if !strings.Contains(line, "Jail list:") {
			continue
		}
		_, list, _ := strings.Cut(line, ":")
		for _, jail := range strings.Split(list, ",") {
			if trimmed := strings.TrimSpace(jail); trimmed != "" {
				jails = append(jails, trimmed)
			}
		}
	}

	bans := make([]providers.BanEntry, 0, 16)
	for _, jail := range jails {
		status, err := runWith(ctx, execOptions{Name: "fail2ban-client", Args: []string{"status", jail}, Env: cLocale()})
		if err != nil {
			continue
		}
		attempts := 0
		for _, line := range splitLines(status) {
			if strings.Contains(line, "Total failed:") {
				_, value, _ := strings.Cut(line, ":")
				attempts, _ = strconv.Atoi(strings.TrimSpace(value))
			}
			if !strings.Contains(line, "Banned IP list:") {
				continue
			}
			_, list, _ := strings.Cut(line, ":")
			for _, address := range strings.Fields(list) {
				bans = append(bans, providers.BanEntry{
					IP:       address,
					Jail:     jail,
					BannedAt: nowRFC3339(),
					Attempts: attempts,
				})
			}
		}
	}
	return bans
}

/* -------------------------------- threats ----------------------------- */

// observation accumulates repeated failures from one address, because a
// single failed login is noise and forty in a minute is an incident.
type observation struct {
	kind      string
	target    string
	attempts  int
	firstSeen time.Time
	lastSeen  time.Time
	sample    string
}

func (o firewallOps) Threats(ctx context.Context, p providers.FwThreatsParams) ([]providers.ThreatObservation, error) {
	records, err := o.authRecords(ctx, p)
	if err != nil {
		return nil, err
	}

	seen := map[string]*observation{}
	for _, record := range records {
		kind, target, ok := classifyThreat(record.Message)
		if !ok {
			continue
		}
		address := ipv4Pattern.FindString(record.Message)
		if address == "" {
			address = ipv6Pattern.FindString(record.Message)
		}
		if address == "" || net.ParseIP(address) == nil {
			continue
		}

		timestamp, err := time.Parse(time.RFC3339, record.Ts)
		if err != nil {
			timestamp = time.Now()
		}
		entry, known := seen[address+kind]
		if !known {
			entry = &observation{kind: kind, target: target, firstSeen: timestamp, sample: record.Message}
			seen[address+kind] = entry
		}
		entry.attempts++
		entry.lastSeen = timestamp
		if timestamp.Before(entry.firstSeen) {
			entry.firstSeen = timestamp
		}
	}

	observations := make([]providers.ThreatObservation, 0, len(seen))
	for key, entry := range seen {
		address := strings.TrimSuffix(key, entry.kind)
		observations = append(observations, providers.ThreatObservation{
			Kind:      entry.kind,
			SourceIP:  address,
			Target:    entry.target,
			Attempts:  entry.attempts,
			FirstSeen: rfc3339(entry.firstSeen),
			LastSeen:  rfc3339(entry.lastSeen),
			Sample:    truncateString(entry.sample, 500),
		})
	}

	sortSlice(observations, func(a, b providers.ThreatObservation) bool { return a.Attempts > b.Attempts })
	if p.Limit > 0 && len(observations) > p.Limit {
		observations = observations[:p.Limit]
	}
	return observations, nil
}

// authRecords reads the authentication trail, from journald where there
// is one and from the traditional log file otherwise.
func (o firewallOps) authRecords(ctx context.Context, p providers.FwThreatsParams) ([]providers.LogRecord, error) {
	// Four log lines per observation is a generous ceiling on how much
	// history a limit of N observations needs.
	lines := p.Limit * 4
	if lines <= 0 || lines > 20000 {
		lines = 2000
	}

	if o.p.has(providers.CapSystemd) {
		query := journalQuery{
			Args: []string{
				"--unit=ssh.service", "--unit=sshd.service",
				"--unit=dovecot.service", "--unit=postfix.service",
			},
			Source: "auth",
			Lines:  lines,
		}
		if p.Since != "" {
			since, err := journalSince(p.Since)
			if err != nil {
				return nil, err
			}
			query.Args = append(query.Args, "--since="+since)
		}
		return journal(ctx, query, nil)
	}

	target := firstExisting("/var/log/auth.log", "/var/log/secure")
	if target == "" {
		return nil, unsupported("no authentication log on this host")
	}
	return tailFile(ctx, target, lines, false, recordFilter{}, nil)
}

// classifyThreat recognises the failure shapes worth reporting. Anything
// unrecognised is dropped rather than filed under a guess.
func classifyThreat(message string) (string, string, bool) {
	lowered := strings.ToLower(message)
	switch {
	case strings.Contains(lowered, "failed password"), strings.Contains(lowered, "invalid user"),
		strings.Contains(lowered, "failed publickey"), strings.Contains(lowered, "authentication failure"):
		return "ssh_bruteforce", "sshd", true
	case strings.Contains(lowered, "auth failed"), strings.Contains(lowered, "aborted login"):
		return "mail_bruteforce", "dovecot", true
	case strings.Contains(lowered, "sasl login authentication failed"):
		return "mail_bruteforce", "postfix", true
	case strings.Contains(lowered, "did not receive identification string"):
		return "port_scan", "sshd", true
	default:
		return "", "", false
	}
}
