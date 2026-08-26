package linux

import (
	"errors"
	"strings"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Firewall rendering.
 *
 * The security thesis says a rule value can never become a second
 * command. These tests hold the agent to it structurally: the iptables
 * and ufw backends are asserted as argv slices, so a value carrying
 * `; nft flush ruleset` is one element of that slice and not a shell
 * fragment, and the nftables backend is asserted to travel on stdin under
 * a constant argv.
 * ------------------------------------------------------------------ */

func rule(mutate func(*providers.FirewallRule)) providers.FirewallRule {
	r := providers.FirewallRule{Priority: 10, Action: "allow", Direction: "inbound", Protocol: "tcp"}
	mutate(&r)
	return r
}

func joinArgs(args []string) string { return strings.Join(args, "\x1f") }

func assertArgs(t *testing.T, got []string, ok bool, want []string) {
	t.Helper()
	if !ok {
		t.Fatalf("the rule was dropped, want argv %v", want)
	}
	if joinArgs(got) != joinArgs(want) {
		t.Fatalf("argv = %#v, want %#v", got, want)
	}
}

/* ------------------------------ iptables ----------------------------- */

func TestIptablesArgsAreExactlyTheExpectedArgv(t *testing.T) {
	cases := []struct {
		name string
		rule providers.FirewallRule
		want []string
	}{
		{
			name: "a single inbound port",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("22") }),
			want: []string{"-A", "INPUT", "-p", "tcp", "--dport", "22", "-j", "ACCEPT"},
		},
		{
			// iptables spells a range with a colon, the contract with a
			// hyphen. Getting this backwards opens one port instead of a
			// thousand, silently.
			name: "a port range is rewritten for iptables",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("6000-6010") }),
			want: []string{"-A", "INPUT", "-p", "tcp", "--dport", "6000:6010", "-j", "ACCEPT"},
		},
		{
			name: "a port list needs the multiport match",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("80,443") }),
			want: []string{"-A", "INPUT", "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "ACCEPT"},
		},
		{
			name: "an outbound deny with a source",
			rule: rule(func(r *providers.FirewallRule) {
				r.Action, r.Direction = "deny", "outbound"
				r.Source = stringPtr("10.0.0.0/8")
				r.PortSpec = nil
			}),
			want: []string{"-A", "OUTPUT", "-p", "tcp", "-s", "10.0.0.0/8", "-j", "DROP"},
		},
		{
			name: "a reject with a destination",
			rule: rule(func(r *providers.FirewallRule) {
				r.Action = "reject"
				r.Destination = stringPtr("192.0.2.10")
				r.PortSpec = stringPtr("25")
			}),
			want: []string{"-A", "INPUT", "-p", "tcp", "--dport", "25", "-d", "192.0.2.10", "-j", "REJECT"},
		},
		{
			// Protocol "any" means the -p flag is left off entirely rather
			// than passed as the literal word "any".
			name: "protocol any omits the flag",
			rule: rule(func(r *providers.FirewallRule) {
				r.Protocol, r.PortSpec = "any", nil
				r.Source = stringPtr("203.0.113.0/24")
			}),
			want: []string{"-A", "INPUT", "-s", "203.0.113.0/24", "-j", "ACCEPT"},
		},
		{
			name: "a comment becomes its own argv elements",
			rule: rule(func(r *providers.FirewallRule) {
				r.PortSpec = stringPtr("443")
				r.Comment = stringPtr("https for the storefront")
			}),
			want: []string{"-A", "INPUT", "-p", "tcp", "--dport", "443", "-m", "comment", "--comment", "https for the storefront", "-j", "ACCEPT"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := iptablesArgs(c.rule)
			assertArgs(t, got, ok, c.want)
		})
	}
}

func TestIptablesDropsAPortSpecItCannotExpress(t *testing.T) {
	// A port on a protocol iptables has no port concept for is refused
	// rather than emitted without --dport, which would silently widen the
	// rule from "port 22" to "all icmp".
	if args, ok := iptablesArgs(rule(func(r *providers.FirewallRule) {
		r.Protocol, r.PortSpec = "icmp", stringPtr("22")
	})); ok {
		t.Fatalf("an icmp rule with a port produced %v, want it dropped", args)
	}
}

func TestIptablesPreludeKeepsTheSessionAliveBeforeThePolicyFlips(t *testing.T) {
	prelude := iptablesPrelude(providers.FwApplyParams{DefaultInbound: "deny", DefaultOutbound: "allow"})

	want := [][]string{
		{"-F"},
		{"-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "INPUT", "-i", "lo", "-j", "ACCEPT"},
		{"-P", "INPUT", "DROP"},
		{"-P", "OUTPUT", "ACCEPT"},
		{"-P", "FORWARD", "DROP"},
	}
	if len(prelude) != len(want) {
		t.Fatalf("prelude has %d commands, want %d: %#v", len(prelude), len(want), prelude)
	}
	for i := range want {
		if joinArgs(prelude[i]) != joinArgs(want[i]) {
			t.Errorf("prelude[%d] = %#v, want %#v", i, prelude[i], want[i])
		}
	}

	// The ordering is the whole point: iptables has no transaction, so an
	// ESTABLISHED accept installed *after* `-P INPUT DROP` would cut the
	// operator's own ssh session in the gap between the two calls.
	established, policy := -1, -1
	for i, args := range prelude {
		for _, arg := range args {
			if arg == "ESTABLISHED,RELATED" {
				established = i
			}
		}
		if len(args) == 3 && args[0] == "-P" && args[1] == "INPUT" {
			policy = i
		}
	}
	if established < 0 || policy < 0 || established > policy {
		t.Errorf("the established-connection rule is at %d and the INPUT policy at %d; the rule must come first", established, policy)
	}
}

/* --------------------------------- ufw -------------------------------- */

func TestUfwArgsAreExactlyTheExpectedArgv(t *testing.T) {
	cases := []struct {
		name string
		rule providers.FirewallRule
		want []string
	}{
		{
			name: "an inbound allow with no source",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("22") }),
			want: []string{"allow", "in", "from", "any", "to", "any", "port", "22", "proto", "tcp"},
		},
		{
			name: "an outbound deny from a range",
			rule: rule(func(r *providers.FirewallRule) {
				r.Action, r.Direction = "deny", "outbound"
				r.Source, r.PortSpec = stringPtr("10.0.0.0/8"), stringPtr("25")
			}),
			want: []string{"deny", "out", "from", "10.0.0.0/8", "to", "any", "port", "25", "proto", "tcp"},
		},
		{
			name: "a protocol with no port",
			rule: rule(func(r *providers.FirewallRule) { r.Protocol, r.PortSpec = "udp", nil }),
			want: []string{"allow", "in", "from", "any", "to", "any", "proto", "udp"},
		},
		{
			name: "a comment is one argv element",
			rule: rule(func(r *providers.FirewallRule) {
				r.PortSpec, r.Comment = stringPtr("443"), stringPtr("https")
			}),
			want: []string{"allow", "in", "from", "any", "to", "any", "port", "443", "proto", "tcp", "comment", "https"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ufwArgs(c.rule)
			assertArgs(t, got, ok, c.want)
		})
	}
}

func TestUfwPreludeResetsBeforeSettingDefaults(t *testing.T) {
	prelude := ufwPrelude(providers.FwApplyParams{DefaultInbound: "deny", DefaultOutbound: "allow"})
	want := [][]string{
		{"--force", "reset"},
		{"default", "deny", "incoming"},
		{"default", "allow", "outgoing"},
	}
	if len(prelude) != len(want) {
		t.Fatalf("prelude = %#v, want %#v", prelude, want)
	}
	for i := range want {
		if joinArgs(prelude[i]) != joinArgs(want[i]) {
			t.Errorf("prelude[%d] = %#v, want %#v", i, prelude[i], want[i])
		}
	}
}

/* ------------------------------ nftables ----------------------------- */

func TestRenderNftRuleProducesTheExpectedExpression(t *testing.T) {
	cases := []struct {
		name string
		rule providers.FirewallRule
		want string
	}{
		{
			name: "a tcp port",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("22") }),
			want: "tcp dport 22 accept",
		},
		{
			name: "a port range uses nft's hyphen",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("6000:6010") }),
			want: "tcp dport 6000-6010 accept",
		},
		{
			name: "a port list becomes an anonymous set",
			rule: rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("80,443") }),
			want: "tcp dport { 80,443 } accept",
		},
		{
			name: "a protocol with no port",
			rule: rule(func(r *providers.FirewallRule) { r.Protocol, r.PortSpec = "udp", nil }),
			want: "meta l4proto udp accept",
		},
		{
			name: "a v4 source",
			rule: rule(func(r *providers.FirewallRule) {
				r.PortSpec, r.Source = nil, stringPtr("203.0.113.0/24")
				r.Protocol = "any"
			}),
			want: "ip saddr 203.0.113.0/24 accept",
		},
		{
			// The address family has to follow the address, or nft rejects
			// the whole script and the apply fails atomically.
			name: "a v6 source switches the family keyword",
			rule: rule(func(r *providers.FirewallRule) {
				r.PortSpec, r.Source = nil, stringPtr("2001:db8::/32")
				r.Protocol, r.Action = "any", "deny"
			}),
			want: "ip6 saddr 2001:db8::/32 drop",
		},
		{
			name: "icmp over v6 is a different protocol number",
			rule: rule(func(r *providers.FirewallRule) {
				r.Protocol, r.PortSpec = "icmp", nil
				r.Source = stringPtr("2001:db8::1")
			}),
			want: "meta l4proto ipv6-icmp ip6 saddr 2001:db8::1 accept",
		},
		{
			name: "reject is its own verdict",
			rule: rule(func(r *providers.FirewallRule) { r.Action, r.PortSpec = "reject", stringPtr("25") }),
			want: "tcp dport 25 reject",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := renderNftRule(c.rule); got != c.want {
				t.Fatalf("renderNftRule = %q, want %q", got, c.want)
			}
		})
	}
}

func TestRenderNftScriptBuildsOneAtomicTable(t *testing.T) {
	script := renderNftScript(providers.FwApplyParams{
		DefaultInbound:  "deny",
		DefaultOutbound: "allow",
		Rules: []providers.FirewallRule{
			{Priority: 20, Action: "allow", Direction: "inbound", Protocol: "tcp", PortSpec: stringPtr("443")},
			{Priority: 10, Action: "allow", Direction: "inbound", Protocol: "tcp", PortSpec: stringPtr("22")},
			{Priority: 30, Action: "deny", Direction: "outbound", Protocol: "tcp", PortSpec: stringPtr("25")},
		},
	})

	for _, want := range []string{
		"table inet kaname\n",
		"delete table inet kaname\n",
		"type filter hook input priority 0; policy drop;",
		"type filter hook output priority 0; policy accept;",
		"ct state established,related accept",
		"iif lo accept",
		"oif lo accept",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("the script is missing %q:\n%s", want, script)
		}
	}

	// Priority is what an operator uses to put a deny in front of an
	// allow, so the order in the script has to follow it rather than the
	// order the rules happened to arrive in.
	port22 := strings.Index(script, "tcp dport 22")
	port443 := strings.Index(script, "tcp dport 443")
	if port22 < 0 || port443 < 0 || port22 > port443 {
		t.Errorf("rules are not ordered by priority (22 at %d, 443 at %d):\n%s", port22, port443, script)
	}

	// A rule belongs to exactly one chain: an outbound rule leaking into
	// the input chain would open a port nobody asked to open.
	input := script[strings.Index(script, "chain input"):strings.Index(script, "chain output")]
	if strings.Contains(input, "dport 25") {
		t.Errorf("the outbound rule was rendered into the input chain:\n%s", script)
	}
}

func TestRenderNftScriptDeclaresTheTableBeforeDeletingIt(t *testing.T) {
	script := renderNftScript(providers.FwApplyParams{DefaultInbound: "allow", DefaultOutbound: "allow"})

	declare := strings.Index(script, "table inet kaname\n")
	remove := strings.Index(script, "delete table inet kaname")
	if declare < 0 || remove < 0 || declare > remove {
		// Without the declaration first, the delete fails on a host Kaname
		// has never applied to, and the very first fw.apply errors out.
		t.Fatalf("the table is not declared before it is deleted:\n%s", script)
	}
}

/* ------------------------------ injection ---------------------------- */

// The one that matters. Every one of these values is an attempt to end
// the current command and start another; none of them may survive into a
// position where a backend would read it as one.
func TestARuleValueCannotBecomeASecondCommand(t *testing.T) {
	hostile := []string{
		`22; nft flush ruleset`,
		"22\nflush ruleset",
		`22" ; rm -rf /; echo "`,
		"22 && reboot",
		"22 | tee /etc/passwd",
		"$(reboot)",
		"`reboot`",
		"22\x00; reboot",
	}

	for _, value := range hostile {
		t.Run(value, func(t *testing.T) {
			// A hostile port spec never reaches a backend at all: the
			// grammar admits digits, commas, hyphens and colons only.
			if err := checkRule(rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr(value) })); err == nil {
				t.Errorf("port_spec %q was accepted", value)
			}
			// Same for an address, which must parse as an IP or a CIDR.
			for _, field := range []string{"source", "destination"} {
				r := rule(func(r *providers.FirewallRule) { r.PortSpec = nil })
				if field == "source" {
					r.Source = stringPtr(value)
				} else {
					r.Destination = stringPtr(value)
				}
				if err := checkRule(r); !errors.Is(err, providers.ErrInvalidParams) {
					t.Errorf("%s %q produced %v, want a %v", field, value, err, providers.ErrInvalidParams)
				}
			}
		})
	}
}

// A comment is the one free-text field a rule carries, so it is the one
// value that cannot simply be rejected. It is stripped instead, and what
// survives has to be inert in all three backends.
func TestAHostileCommentIsStrippedRatherThanEscaped(t *testing.T) {
	hostile := "storefront\"; drop table kaname; #\n\r\\ end\x00"

	sanitized := sanitizeComment(hostile)
	for _, forbidden := range []string{`"`, `\`, "\n", "\r", ";", "\x00"} {
		if strings.Contains(sanitized, forbidden) {
			t.Errorf("sanitizeComment kept %q in %q", forbidden, sanitized)
		}
	}

	// In nft the comment is written inside quotes, so a surviving quote or
	// semicolon would end the comment and start a statement.
	nft := renderNftRule(rule(func(r *providers.FirewallRule) {
		r.PortSpec, r.Comment = stringPtr("443"), stringPtr(hostile)
	}))
	if strings.Count(nft, `"`) != 2 {
		t.Errorf("the rendered rule does not have exactly one quoted comment: %q", nft)
	}
	if strings.ContainsAny(nft, "\n\r;") {
		t.Errorf("the rendered rule carries a statement separator: %q", nft)
	}

	// In iptables and ufw the comment is a single argv element, so even an
	// unsanitised one could not become a command — but it must still be
	// exactly one element, not several.
	args, ok := iptablesArgs(rule(func(r *providers.FirewallRule) {
		r.PortSpec, r.Comment = stringPtr("443"), stringPtr(hostile)
	}))
	if !ok {
		t.Fatal("the rule was dropped")
	}
	index := -1
	for i, arg := range args {
		if arg == "--comment" {
			index = i + 1
		}
	}
	if index < 0 || index >= len(args) {
		t.Fatalf("no comment element in %#v", args)
	}
	if args[index] != sanitized {
		t.Errorf("the comment argument is %q, want the sanitised %q", args[index], sanitized)
	}
	if len(args) != index+3 {
		t.Errorf("the comment produced more argv elements than expected: %#v", args)
	}
}

func TestCheckRuleAcceptsTheShapesTheContractAllows(t *testing.T) {
	cases := []providers.FirewallRule{
		rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("22") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("6000-6010") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("6000:6010") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec = stringPtr("80,443,8080-8090") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec, r.Source = nil, stringPtr("203.0.113.4") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec, r.Source = nil, stringPtr("2001:db8::/32") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec, r.Destination = nil, stringPtr("10.0.0.0/8") }),
		rule(func(r *providers.FirewallRule) { r.PortSpec, r.Comment = nil, stringPtr(strings.Repeat("a", 200)) }),
	}

	for _, c := range cases {
		if err := checkRule(c); err != nil {
			t.Errorf("a legitimate rule %+v was rejected: %v", c, err)
		}
	}
}

func TestCheckRuleRefusesAPortWithoutATransportProtocol(t *testing.T) {
	// nft and iptables both need to know tcp or udp before a port means
	// anything; accepting this would render a rule that matches nothing.
	err := checkRule(rule(func(r *providers.FirewallRule) {
		r.Protocol, r.PortSpec = "any", stringPtr("22")
	}))
	if !errors.Is(err, providers.ErrInvalidParams) {
		t.Fatalf("a port on protocol any produced %v, want a %v", err, providers.ErrInvalidParams)
	}
}

func TestCheckRuleRefusesAnOverlongComment(t *testing.T) {
	err := checkRule(rule(func(r *providers.FirewallRule) {
		r.PortSpec, r.Comment = nil, stringPtr(strings.Repeat("a", 201))
	}))
	if !errors.Is(err, providers.ErrInvalidParams) {
		t.Fatalf("a 201-character comment produced %v, want a %v", err, providers.ErrInvalidParams)
	}
}

func TestParseTargetNormalisesAndReportsTheFamily(t *testing.T) {
	cases := []struct {
		raw    string
		want   string
		family string
	}{
		{"203.0.113.4", "203.0.113.4", "ip"},
		{"203.0.113.0/24", "203.0.113.0/24", "ip"},
		// A host bit left set in a CIDR is masked off rather than refused,
		// so the rule that is installed is the rule that was meant.
		{"203.0.113.7/24", "203.0.113.0/24", "ip"},
		{"2001:db8::1", "2001:db8::1", "ip6"},
		{"2001:db8:abcd::/48", "2001:db8:abcd::/48", "ip6"},
		{"::1", "::1", "ip6"},
	}

	for _, c := range cases {
		got, family, err := parseTarget(c.raw)
		if err != nil {
			t.Errorf("parseTarget(%q) failed: %v", c.raw, err)
			continue
		}
		if got != c.want || family != c.family {
			t.Errorf("parseTarget(%q) = %q/%q, want %q/%q", c.raw, got, family, c.want, c.family)
		}
		// A v6 ban landing in the v4 set is a ban that silently does
		// nothing, so the set name has to follow the family.
		if want := "banned4"; c.family == "ip" && banSet(family) != want {
			t.Errorf("banSet(%q) = %q, want %q", family, banSet(family), want)
		}
		if want := "banned6"; c.family == "ip6" && banSet(family) != want {
			t.Errorf("banSet(%q) = %q, want %q", family, banSet(family), want)
		}
	}

	for _, raw := range []string{"", "example.com", "999.1.1.1", "203.0.113.0/33", "10.0.0.1 -j ACCEPT", "*"} {
		if got, _, err := parseTarget(raw); err == nil {
			t.Errorf("parseTarget(%q) = %q, want a rejection", raw, got)
		}
	}
}

func TestOrderedRulesLeavesTheCallersSliceAlone(t *testing.T) {
	rules := []providers.FirewallRule{
		{Priority: 30, Action: "deny"},
		{Priority: 10, Action: "allow"},
		{Priority: 20, Action: "reject"},
	}

	ordered := orderedRules(rules)
	if ordered[0].Priority != 10 || ordered[1].Priority != 20 || ordered[2].Priority != 30 {
		t.Fatalf("orderedRules did not sort by priority: %+v", ordered)
	}
	// fw.apply hands the same slice to a backend and then to the snapshot
	// path; sorting in place would reorder it under the caller.
	if rules[0].Priority != 30 {
		t.Errorf("orderedRules mutated the caller's slice: %+v", rules)
	}
}
