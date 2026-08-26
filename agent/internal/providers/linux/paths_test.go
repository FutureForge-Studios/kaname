package linux

import (
	"errors"
	"io/fs"
	"strings"
	"syscall"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The path guard.
 *
 * Every file verb funnels through checkPath, so a hole here is a hole in
 * fs.read, fs.write, fs.remove, fs.extract and the site verbs at once.
 * The table below is written from the attacker's side: each row is a
 * shape someone would actually send to walk the agent out of bounds.
 * ------------------------------------------------------------------ */

// noSymlinks is a host on which nothing is a link, so a row's verdict is
// decided purely by the syntactic rules.
func noSymlinks(target string) (string, error) { return target, nil }

func TestCheckPathRejectsEverythingThatCouldEscape(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"empty", "", providers.ErrInvalidParams},
		{"relative", "var/www/html", providers.ErrInvalidParams},
		{"dot relative", "./var/www", providers.ErrInvalidParams},
		{"bare traversal", "../../etc/shadow", providers.ErrInvalidParams},
		{"traversal out of a legitimate root", "/var/www/../../etc/shadow", providers.ErrInvalidParams},
		{"traversal wearing a dot segment", "/var/www/./../../etc", providers.ErrInvalidParams},
		{"traversal that lands back inside", "/var/www/site/../site/index.html", providers.ErrInvalidParams},
		{"trailing traversal", "/var/www/..", providers.ErrInvalidParams},
		{"traversal off the root", "/..", providers.ErrInvalidParams},
		{"null byte truncation", "/var/www/index.html\x00.jpg", providers.ErrInvalidParams},
		{"null byte alone", "\x00", providers.ErrInvalidParams},
		{"windows drive path", `C:\Windows\System32\config\SAM`, providers.ErrInvalidParams},
		{"windows unc path", `\\server\share\secret`, providers.ErrInvalidParams},
		{"windows relative backslash", `..\..\etc\shadow`, providers.ErrInvalidParams},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := checkPath(c.raw, noSymlinks)
			if err == nil {
				t.Fatalf("checkPath(%q) accepted the path and returned %q", c.raw, got)
			}
			if !errors.Is(err, c.want) {
				t.Fatalf("checkPath(%q) failed with %v, want a %v", c.raw, err, c.want)
			}
			if got != "" {
				t.Errorf("checkPath(%q) rejected the path but still returned %q", c.raw, got)
			}
		})
	}
}

func TestCheckPathAcceptsLegitimatePathsAndReturnsTheCleanedForm(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"the root itself", "/", "/"},
		{"a plain directory", "/var/www", "/var/www"},
		{"a plain file", "/etc/nginx/sites-available/example.conf", "/etc/nginx/sites-available/example.conf"},
		// The cleaned form is what every caller goes on to open, so a row
		// whose input and output differ is the one that matters: if the
		// guard ever returned `raw`, these would still pass validation and
		// then be handed to the kernel unnormalised.
		{"trailing slash", "/var/www/", "/var/www"},
		{"doubled separators", "/var//www///html", "/var/www/html"},
		{"interior dot segments", "/var/./www/./html", "/var/www/html"},
		{"trailing dot segment", "/var/www/.", "/var/www"},
		// Nothing in the agent percent-decodes a path, so this names a
		// directory that is literally called "..%2f..". Decoding it would
		// be the bug; treating it as one opaque segment is the fix.
		{"percent-encoded traversal is not a traversal", "/var/www/..%2f..", "/var/www/..%2f.."},
		{"a name that merely starts with dots", "/var/www/...cache", "/var/www/...cache"},
		{"spaces and unicode", "/srv/données/mon site", "/srv/données/mon site"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := checkPath(c.raw, noSymlinks)
			if err != nil {
				t.Fatalf("checkPath(%q) rejected a legitimate path: %v", c.raw, err)
			}
			if got != c.want {
				t.Errorf("checkPath(%q) = %q, want %q", c.raw, got, c.want)
			}
		})
	}
}

// A path can be syntactically spotless and still leave its tree once the
// kernel resolves the links on the way. That is the case the resolver
// exists to catch, and the only one a table of strings cannot reach.
func TestCheckPathRejectsASymlinkThatEscapes(t *testing.T) {
	cases := []struct {
		name     string
		resolved string
	}{
		{"link climbs out mid-path", "/var/www/../../etc/shadow"},
		{"link climbs out at the end", "/var/www/.."},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resolve := func(string) (string, error) { return c.resolved, nil }
			got, err := checkPath("/var/www/uploads", resolve)
			if err == nil {
				t.Fatalf("a link resolving to %q was accepted as %q", c.resolved, got)
			}
			if !errors.Is(err, providers.ErrPermissionDenied) {
				t.Fatalf("resolving to %q failed with %v, want a %v", c.resolved, err, providers.ErrPermissionDenied)
			}
		})
	}
}

func TestCheckPathAcceptsASymlinkThatStaysInside(t *testing.T) {
	resolve := func(string) (string, error) { return "/srv/real/uploads", nil }

	got, err := checkPath("/var/www/uploads", resolve)
	if err != nil {
		t.Fatalf("a link that stays on the host was rejected: %v", err)
	}
	// The guard returns the requested path, not the resolved one: the
	// caller asked about /var/www/uploads and that is what it must open,
	// or a later chmod would land on the link's target instead.
	if got != "/var/www/uploads" {
		t.Errorf("checkPath returned %q, want the requested path", got)
	}
}

func TestCheckPathSurfacesAResolverFailure(t *testing.T) {
	sentinel := errors.New("i/o error on the mount")
	resolve := func(string) (string, error) { return "", sentinel }

	if _, err := checkPath("/var/www", resolve); !errors.Is(err, sentinel) {
		// Failing open here would mean a flaky NFS mount silently disables
		// the escape check.
		t.Fatalf("a resolver failure produced %v, want it wrapped", err)
	}
}

// validatePath is the wiring the provider actually calls. It runs against
// the real filesystem, so this only pins that it is wired to checkPath at
// all — the verdicts themselves are covered above.
func TestValidatePathIsWiredToTheGuard(t *testing.T) {
	for _, raw := range []string{"", "relative", "/etc/../etc", "/etc\x00"} {
		if _, err := validatePath(raw); err == nil {
			t.Errorf("validatePath(%q) accepted a path checkPath rejects", raw)
		}
	}
	if got, err := validatePath("/"); err != nil || got != "/" {
		t.Errorf(`validatePath("/") = %q, %v; want "/", nil`, got, err)
	}
}

func TestValidatePathsRejectsTheWholeBatchForOneBadMember(t *testing.T) {
	if _, err := validatePaths(nil); !errors.Is(err, providers.ErrInvalidParams) {
		t.Errorf("an empty batch produced %v, want a %v", err, providers.ErrInvalidParams)
	}

	// fs.remove and fs.chmod take a batch. Returning the good paths
	// alongside an error would let a caller that ignores the error act on
	// half of a request it never validated.
	got, err := validatePaths([]string{"/var/www", "/var/www/../../etc", "/etc/hosts"})
	if err == nil {
		t.Fatalf("a batch containing a traversal was accepted as %v", got)
	}
	if got != nil {
		t.Errorf("a rejected batch still returned %v", got)
	}
}

func TestWithinDoesNotMistakeASiblingForAChild(t *testing.T) {
	cases := []struct {
		candidate string
		root      string
		want      bool
	}{
		{"/var/www", "/var/www", true},
		{"/var/www/html", "/var/www", true},
		{"/var/www/html", "/var/www/", true},
		{"/var/www", "/", true},
		// The prefix trap: "/var/www-old" starts with "/var/www" but is not
		// under it. A guard that compared raw prefixes would confine an
		// archive to the wrong tree.
		{"/var/www-old", "/var/www", false},
		{"/var/wwwfoo/x", "/var/www", false},
		{"/var", "/var/www", false},
		{"/etc/shadow", "/var/www", false},
	}

	for _, c := range cases {
		if got := within(c.candidate, c.root); got != c.want {
			t.Errorf("within(%q, %q) = %v, want %v", c.candidate, c.root, got, c.want)
		}
	}
}

func TestParseModeRefusesAnythingThatIsNotAnOctalPermission(t *testing.T) {
	for _, raw := range []string{"", "rwxr-xr-x", "0999", "-1", "17777", "0x1ff", " 644"} {
		if mode, err := parseMode(raw); err == nil {
			t.Errorf("parseMode(%q) = %v, want a rejection", raw, mode)
		}
	}

	for raw, want := range map[string]uint32{"644": 0o644, "0644": 0o644, "0755": 0o755, "4755": 0o4755, "0": 0} {
		mode, err := parseMode(raw)
		if err != nil {
			t.Errorf("parseMode(%q) was rejected: %v", raw, err)
			continue
		}
		if uint32(mode) != want {
			t.Errorf("parseMode(%q) = %04o, want %04o", raw, uint32(mode), want)
		}
	}
}

// The panel renders "not found" and "permission denied" as different
// states with different remediations, so this mapping is what an operator
// ends up reading instead of an errno.
func TestWrapFsErrorMapsOntoTheProviderSentinels(t *testing.T) {
	if err := wrapFsError("/tmp/x", nil); err != nil {
		t.Errorf("wrapFsError with no error returned %v", err)
	}

	cases := []struct {
		name string
		path string
		err  error
		want error
	}{
		{"missing", "/var/www/missing", fs.ErrNotExist, providers.ErrNotFound},
		{"unreadable", "/etc/shadow", fs.ErrPermission, providers.ErrPermissionDenied},
		{"already there", "/var/www/index.html", fs.ErrExist, providers.ErrConflict},
		{"non-empty directory", "/var/www", syscall.ENOTEMPTY, providers.ErrPreconditionFailed},
		{"disk full", "/var/www/upload", syscall.ENOSPC, providers.ErrPreconditionFailed},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := wrapFsError(c.path, &fs.PathError{Op: "open", Path: c.path, Err: c.err})
			if !errors.Is(got, c.want) {
				t.Fatalf("%v mapped to %v, want a %v", c.err, got, c.want)
			}
			if !strings.Contains(got.Error(), c.path) {
				t.Errorf("the mapped error %q does not name the path", got)
			}
		})
	}

	// An error with no sentinel of its own must still reach the panel
	// rather than being flattened into one of the above.
	other := errors.New("the device reported a checksum failure")
	got := wrapFsError("/var/www", other)
	for _, sentinel := range []error{providers.ErrNotFound, providers.ErrPermissionDenied, providers.ErrConflict, providers.ErrPreconditionFailed} {
		if errors.Is(got, sentinel) {
			t.Errorf("an unrecognised error was mapped to %v", sentinel)
		}
	}
	if !errors.Is(got, other) {
		t.Errorf("an unrecognised error lost its cause: %v", got)
	}
}
