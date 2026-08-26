package linux

import (
	"errors"
	"strings"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * sshd config rendering.
 *
 * The failure mode here is not a compromised host, it is an unreachable
 * one: a directive that sshd refuses, or an authorized_keys line with a
 * newline in it, and the operator's only way in is gone. Everything below
 * is about what gets written, never about writing it.
 * ------------------------------------------------------------------ */

func intPtr(v int) *int    { return &v }
func boolPtr(v bool) *bool { return &v }

func directiveValue(t *testing.T, directives [][2]string, key string) string {
	t.Helper()
	for _, directive := range directives {
		if strings.EqualFold(directive[0], key) {
			return directive[1]
		}
	}
	t.Fatalf("no %s directive in %v", key, directives)
	return ""
}

func TestSshDirectivesRendersOnlyWhatWasAskedFor(t *testing.T) {
	directives, err := sshDirectives(providers.SSHConfigApplyParams{
		Port:                   intPtr(2222),
		PasswordAuthentication: boolPtr(false),
		PermitRootLogin:        stringPtr("prohibit-password"),
		MaxAuthTries:           intPtr(3),
		AllowUsers:             []string{"deploy", "ops"},
		X11Forwarding:          boolPtr(false),
	})
	if err != nil {
		t.Fatalf("sshDirectives: %v", err)
	}

	// An omitted field means "leave this directive alone", so a directive
	// nobody asked about must not appear at all — writing the default back
	// would quietly override whatever the operator had set by hand.
	for _, directive := range directives {
		if strings.EqualFold(directive[0], "PubkeyAuthentication") || strings.EqualFold(directive[0], "AllowGroups") {
			t.Errorf("an unset field produced the directive %v", directive)
		}
	}

	if got := directiveValue(t, directives, "Port"); got != "2222" {
		t.Errorf("Port = %q, want 2222", got)
	}
	if got := directiveValue(t, directives, "PasswordAuthentication"); got != "no" {
		t.Errorf("PasswordAuthentication = %q, want no", got)
	}
	if got := directiveValue(t, directives, "PermitRootLogin"); got != "prohibit-password" {
		t.Errorf("PermitRootLogin = %q, want prohibit-password", got)
	}
	if got := directiveValue(t, directives, "MaxAuthTries"); got != "3" {
		t.Errorf("MaxAuthTries = %q, want 3", got)
	}
	// sshd takes a space-separated list on one line, not one line per user.
	if got := directiveValue(t, directives, "AllowUsers"); got != "deploy ops" {
		t.Errorf("AllowUsers = %q, want %q", got, "deploy ops")
	}
	if got := directiveValue(t, directives, "X11Forwarding"); got != "no" {
		t.Errorf("X11Forwarding = %q, want no", got)
	}
}

func TestSshDirectivesRefusesTheValuesSshdWouldReject(t *testing.T) {
	cases := []struct {
		name   string
		params providers.SSHConfigApplyParams
	}{
		{"nothing at all", providers.SSHConfigApplyParams{}},
		{"max_auth_tries of zero", providers.SSHConfigApplyParams{MaxAuthTries: intPtr(0)}},
		{"negative max_auth_tries", providers.SSHConfigApplyParams{MaxAuthTries: intPtr(-1)}},
		{"absurd max_auth_tries", providers.SSHConfigApplyParams{MaxAuthTries: intPtr(101)}},
		// An empty AllowUsers is the difference between "leave it alone"
		// and "allow nobody", and sshd reads the second one literally.
		{"empty allow_users", providers.SSHConfigApplyParams{AllowUsers: []string{}}},
		{"empty allow_groups", providers.SSHConfigApplyParams{AllowGroups: []string{}}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := sshDirectives(c.params); !errors.Is(err, providers.ErrInvalidParams) {
				t.Fatalf("%+v produced %v, want a %v", c.params, err, providers.ErrInvalidParams)
			}
		})
	}
}

func TestRenderSSHConfigWritesASelfContainedDropIn(t *testing.T) {
	directives := [][2]string{{"Port", "2222"}, {"PasswordAuthentication", "no"}}
	previous := "# somebody else's drop-in\nPort 9999\n"

	rendered := renderSSHConfig(directives, previous, true)

	if !strings.HasPrefix(rendered, "# Managed by Kaname.") {
		t.Errorf("the drop-in does not announce itself:\n%s", rendered)
	}
	// A drop-in is rewritten wholesale, so nothing of the previous content
	// may survive — otherwise a directive removed from the panel would
	// linger on the host.
	if strings.Contains(rendered, "9999") || strings.Contains(rendered, "somebody else") {
		t.Errorf("the drop-in kept content from the previous file:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Port 2222\n") || !strings.Contains(rendered, "PasswordAuthentication no\n") {
		t.Errorf("the drop-in is missing a directive:\n%s", rendered)
	}
}

// The merge path is the one that touches an operator's own file, so what
// it must not do is more important than what it does.
func TestRenderSSHConfigMergesIntoTheOperatorsFile(t *testing.T) {
	previous := strings.Join([]string{
		"# our hardening notes live here",
		"Port 22",
		"",
		"PasswordAuthentication yes",
		"KexAlgorithms curve25519-sha256",
		"Match User backup",
		"    PasswordAuthentication yes",
	}, "\n") + "\n"

	rendered := renderSSHConfig([][2]string{
		{"Port", "2222"},
		{"PermitRootLogin", "no"},
	}, previous, false)

	if !strings.Contains(rendered, "Port 2222\n") {
		t.Errorf("the managed directive was not replaced:\n%s", rendered)
	}
	if strings.Contains(rendered, "Port 22\n") {
		t.Errorf("the old value survived the merge:\n%s", rendered)
	}
	// Everything the panel does not manage is left exactly as it was.
	for _, keep := range []string{
		"# our hardening notes live here",
		"PasswordAuthentication yes",
		"KexAlgorithms curve25519-sha256",
		"Match User backup",
	} {
		if !strings.Contains(rendered, keep) {
			t.Errorf("the merge dropped %q:\n%s", keep, rendered)
		}
	}
	// A directive the file never had is appended rather than lost.
	if !strings.Contains(rendered, "PermitRootLogin no\n") {
		t.Errorf("a new directive was not appended:\n%s", rendered)
	}
	if !strings.HasSuffix(rendered, "\n") {
		t.Errorf("the rendered config does not end in a newline: %q", rendered)
	}
}

func TestRenderSSHConfigCommentsOutADuplicateRatherThanLeavingIt(t *testing.T) {
	previous := "Port 22\nPasswordAuthentication yes\nPort 2200\n"

	rendered := renderSSHConfig([][2]string{{"Port", "2222"}}, previous, false)

	// OpenSSH takes the first occurrence and ignores the rest. Rewriting
	// only the first and leaving the second would show a config that
	// disagrees with itself the next time somebody reads the file.
	if !strings.Contains(rendered, "Port 2222") {
		t.Errorf("the first occurrence was not replaced:\n%s", rendered)
	}
	if !strings.Contains(rendered, "# Port 2200") {
		t.Errorf("the shadowed duplicate was not commented out:\n%s", rendered)
	}
}

func TestRenderSSHConfigMatchesDirectivesCaseInsensitivelyAndWritesThemBackInCanonicalCase(t *testing.T) {
	// sshd_config keywords are case-insensitive, so a hand-edited file may
	// spell one any way at all. Missing that would append a second Port
	// line below the one already in effect, which OpenSSH would ignore.
	previous := "port 22\nPASSWORDAUTHENTICATION yes\n"

	rendered := renderSSHConfig([][2]string{
		{"Port", "2222"},
		{"PasswordAuthentication", "no"},
	}, previous, false)

	if strings.Count(rendered, "2222") != 1 {
		t.Errorf("Port was written more than once:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Port 2222") {
		t.Errorf("the lowercase directive was not matched:\n%s", rendered)
	}
	if !strings.Contains(rendered, "PasswordAuthentication no") {
		t.Errorf("the uppercase directive was not matched:\n%s", rendered)
	}
	if strings.Contains(rendered, "yes") {
		t.Errorf("the old value survived:\n%s", rendered)
	}
}

func TestRenderSSHConfigIgnoresCommentedOutDirectives(t *testing.T) {
	previous := "# Port 22\n#PasswordAuthentication yes\nPort 22\n"

	rendered := renderSSHConfig([][2]string{{"Port", "2222"}}, previous, false)

	// The commented line is documentation, not configuration; rewriting it
	// would turn a note into a live directive.
	if !strings.Contains(rendered, "# Port 22\n") {
		t.Errorf("a commented directive was rewritten:\n%s", rendered)
	}
	if !strings.Contains(rendered, "\nPort 2222") {
		t.Errorf("the live directive was not replaced:\n%s", rendered)
	}
}

/* ------------------------------ authorized keys ---------------------- */

// A real ed25519 key, so the base64 and the fingerprint are genuine.
const testKeyBlob = "AAAAC3NzaC1lZDI1NTE5AAAAIJ7z3vJ7CvLmQ0MEhJP1IcqTr5F7cLo3CzQRhDvJz3Nx"

func TestNormalizeAuthorizedKeyRefusesAnythingThatCouldForgeALine(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		comment string
	}{
		// A newline in either field would let one requested key become two
		// authorized ones — the second being whatever the caller wanted.
		{"newline in the key", "ssh-ed25519 " + testKeyBlob + "\nssh-ed25519 " + testKeyBlob, "laptop"},
		{"carriage return in the key", "ssh-ed25519 " + testKeyBlob + "\r\nssh-rsa AAAA", "laptop"},
		{"newline in the comment", "ssh-ed25519 " + testKeyBlob, "laptop\nssh-ed25519 " + testKeyBlob},
		{"no blob", "ssh-ed25519", "laptop"},
		{"empty", "", ""},
		{"unknown algorithm", "ssh-rsa-but-not-really " + testKeyBlob, "laptop"},
		// An options prefix carries command= and permitopen=, so accepting
		// one on write would let a caller smuggle a forced command in.
		{"options prefix", `command="/bin/sh" ssh-ed25519 ` + testKeyBlob, "laptop"},
		{"not base64", "ssh-ed25519 ****not base64****", "laptop"},
		{"empty blob", "ssh-ed25519 ''", "laptop"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			line, err := normalizeAuthorizedKey(c.key, c.comment)
			if err == nil {
				t.Fatalf("normalizeAuthorizedKey accepted %q / %q as %q", c.key, c.comment, line)
			}
			if !errors.Is(err, providers.ErrInvalidParams) {
				t.Fatalf("failed with %v, want a %v", err, providers.ErrInvalidParams)
			}
		})
	}
}

func TestNormalizeAuthorizedKeyProducesOneCanonicalLine(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		comment string
		want    string
	}{
		{
			name: "type, blob and comment",
			key:  "ssh-ed25519 " + testKeyBlob, comment: "deploy@laptop",
			want: "ssh-ed25519 " + testKeyBlob + " deploy@laptop",
		},
		{
			name: "surrounding whitespace is dropped",
			key:  "  ssh-ed25519   " + testKeyBlob + "  ", comment: "  deploy@laptop  ",
			want: "ssh-ed25519 " + testKeyBlob + " deploy@laptop",
		},
		{
			// The comment already inside the key is kept when no separate
			// one is given, so re-applying a key does not lose its label.
			name: "the key's own comment is kept",
			key:  "ssh-ed25519 " + testKeyBlob + " from-the-key", comment: "",
			want: "ssh-ed25519 " + testKeyBlob + " from-the-key",
		},
		{
			name: "an explicit comment wins",
			key:  "ssh-ed25519 " + testKeyBlob + " from-the-key", comment: "from-the-panel",
			want: "ssh-ed25519 " + testKeyBlob + " from-the-panel",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := normalizeAuthorizedKey(c.key, c.comment)
			if err != nil {
				t.Fatalf("normalizeAuthorizedKey: %v", err)
			}
			if got != c.want {
				t.Fatalf("= %q, want %q", got, c.want)
			}
			if strings.ContainsAny(got, "\n\r") {
				t.Fatalf("the normalised line spans more than one line: %q", got)
			}
		})
	}
}

func TestParseAuthorizedKeyReadsWhatSshdWouldRead(t *testing.T) {
	line := `no-port-forwarding,command="/usr/bin/rrsync /srv" ssh-ed25519 ` + testKeyBlob + " backup@nas"

	key, ok := parseAuthorizedKey(line, "deploy")
	if !ok {
		t.Fatal("a key behind an options prefix was not recognised")
	}
	// Reading is not writing: an existing line with options is reported so
	// the panel can show it, with the algorithm found past the options.
	if key.Type != "ssh-ed25519" {
		t.Errorf("Type = %q, want ssh-ed25519", key.Type)
	}
	if key.PublicKey != "ssh-ed25519 "+testKeyBlob {
		t.Errorf("PublicKey = %q", key.PublicKey)
	}
	if key.Comment != "backup@nas" {
		t.Errorf("Comment = %q, want backup@nas", key.Comment)
	}
	if key.User != "deploy" {
		t.Errorf("User = %q, want deploy", key.User)
	}
	if !strings.HasPrefix(key.Fingerprint, "SHA256:") || strings.HasSuffix(key.Fingerprint, "=") {
		// ssh-keygen -lf prints the unpadded base64 form; matching it is
		// how an operator compares what the panel shows to what they have.
		t.Errorf("Fingerprint = %q, want an unpadded SHA256: form", key.Fingerprint)
	}
}

func TestParseAuthorizedKeySkipsWhatIsNotAKey(t *testing.T) {
	for _, line := range []string{
		"",
		"   ",
		"# a comment",
		"# ssh-ed25519 " + testKeyBlob,
		"ssh-ed25519",
		"nonsense entirely",
		"ssh-ed25519 !!!not-base64!!!",
	} {
		if key, ok := parseAuthorizedKey(line, "deploy"); ok {
			t.Errorf("parseAuthorizedKey(%q) returned %+v, want it skipped", line, key)
		}
	}
}

func TestKeyFingerprintMatchesOpenSSHsForm(t *testing.T) {
	fingerprint, err := keyFingerprint(testKeyBlob)
	if err != nil {
		t.Fatalf("keyFingerprint: %v", err)
	}
	// SHA-256 is 32 bytes, which is 43 unpadded base64 characters.
	if want := len("SHA256:") + 43; len(fingerprint) != want {
		t.Errorf("fingerprint %q is %d characters, want %d", fingerprint, len(fingerprint), want)
	}

	if _, err := keyFingerprint(""); err == nil {
		t.Error("an empty blob produced a fingerprint")
	}
	if _, err := keyFingerprint("!!!"); err == nil {
		t.Error("a non-base64 blob produced a fingerprint")
	}
}

func TestParseIdleReadsWhosColumn(t *testing.T) {
	cases := map[string]int{
		".":     0,
		"?":     0,
		"old":   86400,
		"00:00": 0,
		"00:07": 420,
		"02:30": 9000,
		"":      0,
		"junk":  0,
	}
	for raw, want := range cases {
		if got := parseIdle(raw); got != want {
			t.Errorf("parseIdle(%q) = %d, want %d", raw, got, want)
		}
	}
}
