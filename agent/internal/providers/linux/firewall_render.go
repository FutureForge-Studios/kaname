package linux

import (
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Firewall rendering.
 *
 * Turning a rule set into something a backend understands is the part of
 * the firewall that has no business touching the host, so it does not.
 * nftables is fed a script over stdin with a fixed argv; iptables and ufw
 * are fed argv slices. In all three cases nothing an operator typed is
 * ever concatenated into a command line, which is why a comment reading
 * `x; nft flush ruleset` is one comment and not two commands.
 * ------------------------------------------------------------------ */

const (
	// The table Kaname owns. Nothing outside it is ever rewritten.
	nftTable = "kaname"
	// Bans live in their own table so replacing the rule set does not
	// quietly unban everything.
	nftBanTable = "kaname_bans"

	iptablesBanComment = "kaname-ban"
	ufwRulesDir        = "/etc/ufw"
)

var portSpecOK = regexp.MustCompile(`^[0-9]{1,5}(?:[-:][0-9]{1,5})?(?:,[0-9]{1,5}(?:[-:][0-9]{1,5})?)*$`)

// orderedRules sorts a rule set by priority without disturbing the
// caller's slice, so every backend installs rules in the same order.
func orderedRules(rules []providers.FirewallRule) []providers.FirewallRule {
	ordered := append([]providers.FirewallRule(nil), rules...)
	sortSlice(ordered, func(a, b providers.FirewallRule) bool { return a.Priority < b.Priority })
	return ordered
}

/* ------------------------------ nftables ----------------------------- */

// renderNftScript builds the whole table as one script. nft either takes
// all of it or leaves the kernel untouched, so there is no window in
// which half the rules are live.
func renderNftScript(p providers.FwApplyParams) string {
	var b strings.Builder
	// Declaring the table before deleting it makes the delete succeed on a
	// host where it does not exist yet.
	fmt.Fprintf(&b, "table inet %s\n", nftTable)
	fmt.Fprintf(&b, "delete table inet %s\n", nftTable)
	fmt.Fprintf(&b, "table inet %s {\n", nftTable)

	ordered := orderedRules(p.Rules)
	for _, chain := range []struct {
		name      string
		hook      string
		policy    string
		direction string
	}{
		{"input", "input", nftPolicy(p.DefaultInbound), "inbound"},
		{"output", "output", nftPolicy(p.DefaultOutbound), "outbound"},
	} {
		fmt.Fprintf(&b, "  chain %s {\n", chain.name)
		// Numeric priority rather than the `filter` keyword: the keyword
		// only arrived in nft 0.9 and this has to load on an older host too.
		fmt.Fprintf(&b, "    type filter hook %s priority 0; policy %s;\n", chain.hook, chain.policy)
		b.WriteString("    ct state established,related accept\n")
		b.WriteString("    ct state invalid drop\n")
		if chain.name == "input" {
			b.WriteString("    iif lo accept\n")
		} else {
			b.WriteString("    oif lo accept\n")
		}

		for _, rule := range ordered {
			if rule.Direction != chain.direction {
				continue
			}
			b.WriteString("    " + renderNftRule(rule) + "\n")
		}
		b.WriteString("  }\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func renderNftRule(rule providers.FirewallRule) string {
	parts := make([]string, 0, 6)

	addressFamily := "ip"
	if rule.Source != nil && strings.Contains(*rule.Source, ":") {
		addressFamily = "ip6"
	}
	if rule.Destination != nil && strings.Contains(*rule.Destination, ":") {
		addressFamily = "ip6"
	}

	switch rule.Protocol {
	case "tcp", "udp":
		if rule.PortSpec != nil && *rule.PortSpec != "" {
			parts = append(parts, rule.Protocol+" dport "+nftPortSpec(*rule.PortSpec))
		} else {
			parts = append(parts, "meta l4proto "+rule.Protocol)
		}
	case "icmp":
		if addressFamily == "ip6" {
			parts = append(parts, "meta l4proto ipv6-icmp")
		} else {
			parts = append(parts, "meta l4proto icmp")
		}
	}
	if rule.Source != nil && *rule.Source != "" {
		parts = append(parts, addressFamily+" saddr "+*rule.Source)
	}
	if rule.Destination != nil && *rule.Destination != "" {
		parts = append(parts, addressFamily+" daddr "+*rule.Destination)
	}

	parts = append(parts, nftVerdict(rule.Action))
	if rule.Comment != nil && *rule.Comment != "" {
		parts = append(parts, `comment "`+sanitizeComment(*rule.Comment)+`"`)
	}
	return strings.Join(parts, " ")
}

/* ------------------------------ iptables ----------------------------- */

// iptablesPrelude is the fixed part of an apply. iptables has no atomic
// transaction, so the order matters: the established-connection and
// loopback rules go in before the default policy flips, or the operator's
// own session is dropped in the gap.
func iptablesPrelude(p providers.FwApplyParams) [][]string {
	return [][]string{
		{"-F"},
		{"-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "INPUT", "-i", "lo", "-j", "ACCEPT"},
		{"-P", "INPUT", iptablesPolicy(p.DefaultInbound)},
		{"-P", "OUTPUT", iptablesPolicy(p.DefaultOutbound)},
		{"-P", "FORWARD", "DROP"},
	}
}

func iptablesArgs(rule providers.FirewallRule) ([]string, bool) {
	chain := "INPUT"
	if rule.Direction == "outbound" {
		chain = "OUTPUT"
	}
	args := []string{"-A", chain}

	if rule.Protocol != "any" {
		args = append(args, "-p", rule.Protocol)
	}
	if rule.PortSpec != nil && *rule.PortSpec != "" {
		if rule.Protocol != "tcp" && rule.Protocol != "udp" {
			return nil, false
		}
		if strings.ContainsAny(*rule.PortSpec, ",") {
			args = append(args, "-m", "multiport", "--dports", *rule.PortSpec)
		} else {
			args = append(args, "--dport", strings.ReplaceAll(*rule.PortSpec, "-", ":"))
		}
	}
	if rule.Source != nil && *rule.Source != "" {
		args = append(args, "-s", *rule.Source)
	}
	if rule.Destination != nil && *rule.Destination != "" {
		args = append(args, "-d", *rule.Destination)
	}
	if rule.Comment != nil && *rule.Comment != "" {
		args = append(args, "-m", "comment", "--comment", sanitizeComment(*rule.Comment))
	}
	return append(args, "-j", iptablesTarget(rule.Action)), true
}

/* --------------------------------- ufw -------------------------------- */

func ufwPrelude(p providers.FwApplyParams) [][]string {
	return [][]string{
		{"--force", "reset"},
		{"default", p.DefaultInbound, "incoming"},
		{"default", p.DefaultOutbound, "outgoing"},
	}
}

func ufwArgs(rule providers.FirewallRule) ([]string, bool) {
	args := []string{rule.Action}
	if rule.Direction == "outbound" {
		args = append(args, "out")
	} else {
		args = append(args, "in")
	}
	if rule.Source != nil && *rule.Source != "" {
		args = append(args, "from", *rule.Source)
	} else {
		args = append(args, "from", "any")
	}
	if rule.PortSpec != nil && *rule.PortSpec != "" {
		if rule.Protocol != "tcp" && rule.Protocol != "udp" {
			return nil, false
		}
		args = append(args, "to", "any", "port", *rule.PortSpec, "proto", rule.Protocol)
	} else if rule.Protocol == "tcp" || rule.Protocol == "udp" {
		args = append(args, "to", "any", "proto", rule.Protocol)
	}
	if rule.Comment != nil && *rule.Comment != "" {
		args = append(args, "comment", sanitizeComment(*rule.Comment))
	}
	return args, true
}

/* ------------------------------ validation ---------------------------- */

func checkRule(rule providers.FirewallRule) error {
	if rule.PortSpec != nil && *rule.PortSpec != "" {
		if !portSpecOK.MatchString(*rule.PortSpec) {
			return invalid("port_spec %q must be a port, range or comma-separated list", *rule.PortSpec)
		}
		if rule.Protocol != "tcp" && rule.Protocol != "udp" {
			return invalid("a port_spec needs protocol tcp or udp")
		}
	}
	for _, address := range []*string{rule.Source, rule.Destination} {
		if address == nil || *address == "" {
			continue
		}
		if _, _, err := parseTarget(*address); err != nil {
			return err
		}
	}
	if rule.Comment != nil && len(*rule.Comment) > 200 {
		return invalid("comment may not exceed 200 characters")
	}
	return nil
}

// parseTarget normalises an address or CIDR and reports its family, so a
// v6 ban never lands in a v4 set.
func parseTarget(target string) (string, string, error) {
	if address, network, err := net.ParseCIDR(target); err == nil {
		family := "ip"
		if address.To4() == nil {
			family = "ip6"
		}
		return network.String(), family, nil
	}
	address := net.ParseIP(target)
	if address == nil {
		return "", "", invalid("%q is not an address or CIDR range", target)
	}
	if address.To4() == nil {
		return address.String(), "ip6", nil
	}
	return address.String(), "ip", nil
}

/* -------------------------------- shapes ------------------------------ */

func banSet(family string) string {
	if family == "ip6" {
		return "banned6"
	}
	return "banned4"
}

func nftPortSpec(spec string) string {
	normalized := strings.ReplaceAll(spec, ":", "-")
	if strings.ContainsAny(normalized, ",") {
		return "{ " + normalized + " }"
	}
	return normalized
}

func nftPolicy(value string) string {
	if value == "deny" {
		return "drop"
	}
	return "accept"
}

func nftVerdict(action string) string {
	switch action {
	case "deny":
		return "drop"
	case "reject":
		return "reject"
	default:
		return "accept"
	}
}

func iptablesPolicy(value string) string {
	if value == "deny" {
		return "DROP"
	}
	return "ACCEPT"
}

func iptablesTarget(action string) string {
	switch action {
	case "deny":
		return "DROP"
	case "reject":
		return "REJECT"
	default:
		return "ACCEPT"
	}
}

func policyFromNft(ruleset, chain string) string {
	for _, line := range splitLines(ruleset) {
		if !strings.Contains(line, "hook "+chain+" ") {
			continue
		}
		if strings.Contains(line, "policy drop") {
			return "deny"
		}
		return "allow"
	}
	return "allow"
}

func policyFromIptables(policy string) string {
	if policy == "DROP" || policy == "REJECT" {
		return "deny"
	}
	return "allow"
}

func directionFromChain(chain string) string {
	switch strings.ToLower(chain) {
	case "output", "postrouting":
		return "outbound"
	default:
		return "inbound"
	}
}

func actionFromTarget(target string) string {
	switch strings.ToUpper(target) {
	case "DROP", "DENY":
		return "deny"
	case "REJECT":
		return "reject"
	default:
		return "allow"
	}
}

func normalizeFirewallProtocol(value string) string {
	switch strings.ToLower(value) {
	case "tcp", "udp", "icmp":
		return strings.ToLower(value)
	case "ipv6-icmp", "icmpv6":
		return "icmp"
	default:
		return "any"
	}
}

func splitUfwTarget(target string) (string, string) {
	fields := strings.Fields(target)
	if len(fields) == 0 {
		return "", ""
	}
	port, protocol, ok := strings.Cut(fields[0], "/")
	if !ok {
		return fields[0], ""
	}
	return port, normalizeFirewallProtocol(protocol)
}

// sanitizeComment strips the characters that would end a quoted nft
// comment or confuse an iptables match.
func sanitizeComment(comment string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '"', '\\', '\n', '\r', ';', 0:
			return -1
		}
		return r
	}, comment)
}
