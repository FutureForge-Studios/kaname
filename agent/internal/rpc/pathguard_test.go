package rpc

import (
	"errors"
	"testing"
)

/* ------------------------------------------------------------------ *
 * The path guard at the RPC boundary.
 *
 * This is the first thing every path argument meets, before any provider
 * sees it, and it carries one rule the provider's own guard does not: a
 * denied set covering the agent's state directory, which holds the
 * private key the host enrolled with. A file verb that could read or
 * overwrite that key would turn a file browser into an identity theft.
 * ------------------------------------------------------------------ */

// The denied set is built here rather than through newPathGuard because
// newPathGuard runs filepath.Abs, which on a non-Linux dev box prefixes a
// drive letter and stops matching the POSIX paths a managed host sends.
// What is under test is check(), not the constructor's absolutisation.
func guardDenying(dirs ...string) pathGuard { return pathGuard{denied: dirs} }

func codeOf(t *testing.T, err error) ErrorCode {
	t.Helper()
	var rpcErr *Error
	if !errors.As(err, &rpcErr) {
		t.Fatalf("error %v is not an *Error and would not reach the panel with a code", err)
	}
	return rpcErr.Code
}

func TestPathGuardRejectsEverythingThatCouldEscape(t *testing.T) {
	guard := guardDenying()

	cases := []struct {
		name string
		raw  string
		code ErrorCode
	}{
		{"empty", "", CodeInvalidParams},
		{"relative", "var/www/html", CodeInvalidParams},
		{"dot relative", "./var/www", CodeInvalidParams},
		{"bare traversal", "../../etc/shadow", CodeInvalidParams},
		{"traversal out of a legitimate root", "/var/www/../../etc/shadow", CodeInvalidParams},
		{"traversal wearing a dot segment", "/var/www/./../../etc", CodeInvalidParams},
		{"trailing traversal", "/var/www/..", CodeInvalidParams},
		{"traversal off the root", "/..", CodeInvalidParams},
		{"null byte truncation", "/var/www/index.html\x00.jpg", CodeInvalidParams},
		{"windows drive path", `C:\Windows\System32\config\SAM`, CodeInvalidParams},
		{"windows unc path", `\\server\share\secret`, CodeInvalidParams},
		{"windows relative backslash", `..\..\etc\shadow`, CodeInvalidParams},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := guard.check(c.raw)
			if err == nil {
				t.Fatalf("check(%q) accepted the path and returned %q", c.raw, got)
			}
			if code := codeOf(t, err); code != c.code {
				t.Fatalf("check(%q) failed with code %q, want %q", c.raw, code, c.code)
			}
			if got != "" {
				t.Errorf("check(%q) rejected the path but still returned %q", c.raw, got)
			}
		})
	}
}

func TestPathGuardAcceptsLegitimatePathsAndReturnsTheCleanedForm(t *testing.T) {
	guard := guardDenying()

	cases := []struct {
		raw  string
		want string
	}{
		{"/", "/"},
		{"/var/www", "/var/www"},
		{"/var/www/", "/var/www"},
		{"/var//www///html", "/var/www/html"},
		{"/var/./www/./html", "/var/www/html"},
		{"/etc/nginx/sites-available/example.conf", "/etc/nginx/sites-available/example.conf"},
		// Nothing in the agent percent-decodes a path, so this is a
		// directory literally called "..%2f..", not a traversal.
		{"/var/www/..%2f..", "/var/www/..%2f.."},
	}

	for _, c := range cases {
		got, err := guard.check(c.raw)
		if err != nil {
			t.Errorf("check(%q) rejected a legitimate path: %v", c.raw, err)
			continue
		}
		// Handlers overwrite their parameter with this value, so a guard
		// that returned the raw string would hand the provider an
		// unnormalised path it had never validated.
		if got != c.want {
			t.Errorf("check(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestPathGuardRefusesTheAgentsOwnStateDirectory(t *testing.T) {
	guard := guardDenying("/var/lib/kaname")

	denied := []string{
		"/var/lib/kaname",
		"/var/lib/kaname/",
		"/var/lib/kaname/agent.key",
		"/var/lib/kaname/certs/client.pem",
		"/var/lib/kaname/./agent.key",
		"/var/lib//kaname//agent.key",
	}
	for _, raw := range denied {
		got, err := guard.check(raw)
		if err == nil {
			t.Errorf("check(%q) reached the agent's key material as %q", raw, got)
			continue
		}
		if code := codeOf(t, err); code != CodePermissionDenied {
			t.Errorf("check(%q) failed with code %q, want %q", raw, code, CodePermissionDenied)
		}
	}

	// The prefix trap: a sibling whose name merely starts with the guarded
	// one is an ordinary directory and must stay reachable.
	allowed := []string{
		"/var/lib/kaname-backups",
		"/var/lib/kaname.old/notes.txt",
		"/var/lib",
		"/var/lib/other/kaname",
	}
	for _, raw := range allowed {
		if _, err := guard.check(raw); err != nil {
			t.Errorf("check(%q) was denied: %v", raw, err)
		}
	}
}

func TestPathGuardHonoursEveryDeniedDirectory(t *testing.T) {
	guard := guardDenying("/var/lib/kaname", "/etc/kaname")

	for _, raw := range []string{"/var/lib/kaname/agent.key", "/etc/kaname/agent.toml"} {
		if _, err := guard.check(raw); err == nil {
			t.Errorf("check(%q) was allowed past a denied directory", raw)
		}
	}
	if _, err := guard.check("/srv/app"); err != nil {
		t.Errorf("an unrelated path was denied: %v", err)
	}
}

func TestPathGuardChecksEveryMemberOfABatch(t *testing.T) {
	guard := guardDenying("/var/lib/kaname")

	if _, err := guard.checkAll(nil); err == nil {
		t.Error("an empty batch was accepted")
	}

	// fs.remove and fs.chmod take a batch. Returning the good paths
	// alongside an error would let a caller that ignores the error act on
	// half a request that was never validated.
	for _, batch := range [][]string{
		{"/var/www", "/var/www/../../etc/shadow"},
		{"/var/www", "/var/lib/kaname/agent.key"},
		{"/var/www", "relative"},
		{"/var/www", ""},
	} {
		got, err := guard.checkAll(batch)
		if err == nil {
			t.Errorf("checkAll(%v) was accepted as %v", batch, got)
		}
		if got != nil {
			t.Errorf("checkAll(%v) rejected the batch but returned %v", batch, got)
		}
	}

	got, err := guard.checkAll([]string{"/var/www/", "/etc//nginx"})
	if err != nil {
		t.Fatalf("a legitimate batch was rejected: %v", err)
	}
	if len(got) != 2 || got[0] != "/var/www" || got[1] != "/etc/nginx" {
		t.Errorf("checkAll returned %v, want the cleaned paths", got)
	}
}

func TestWithinDoesNotMistakeASiblingForAChild(t *testing.T) {
	cases := []struct {
		candidate string
		root      string
		want      bool
	}{
		{"/var/lib/kaname", "/var/lib/kaname", true},
		{"/var/lib/kaname/agent.key", "/var/lib/kaname", true},
		// The prefix trap that decides whether the denied set works.
		{"/var/lib/kaname-backups", "/var/lib/kaname", false},
		{"/var/lib/kanameX", "/var/lib/kaname", false},
		{"/var/lib", "/var/lib/kaname", false},
		{"/etc/shadow", "/var/lib/kaname", false},
	}

	for _, c := range cases {
		if got := within(c.candidate, c.root); got != c.want {
			t.Errorf("within(%q, %q) = %v, want %v", c.candidate, c.root, got, c.want)
		}
	}
}
