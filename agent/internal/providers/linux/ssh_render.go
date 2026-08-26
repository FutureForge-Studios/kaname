package linux

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * sshd config rendering.
 *
 * Deciding what goes into sshd_config is separate from writing it,
 * because the writing half is the half that can strand an operator. What
 * is rendered here is either a self-contained drop-in or the operator's
 * own file with exactly the managed directives replaced — never a file
 * assembled from text the control plane supplied verbatim.
 * ------------------------------------------------------------------ */

// The public key algorithms OpenSSH accepts in an authorized_keys line.
var sshKeyTypes = map[string]struct{}{
	"ssh-rsa": {}, "ssh-ed25519": {}, "ssh-dss": {},
	"ecdsa-sha2-nistp256": {}, "ecdsa-sha2-nistp384": {}, "ecdsa-sha2-nistp521": {},
	"sk-ssh-ed25519@openssh.com": {}, "sk-ecdsa-sha2-nistp256@openssh.com": {},
}

// sshDirectives turns the partial config into the ordered list of
// directives to write, refusing the values sshd would reject and the
// ones that would leave nobody able to log in.
func sshDirectives(p providers.SSHConfigApplyParams) ([][2]string, error) {
	directives := make([][2]string, 0, 8)
	add := func(key, value string) { directives = append(directives, [2]string{key, value}) }

	if p.Port != nil {
		add("Port", strconv.Itoa(*p.Port))
	}
	if p.PermitRootLogin != nil {
		add("PermitRootLogin", *p.PermitRootLogin)
	}
	if p.PasswordAuthentication != nil {
		add("PasswordAuthentication", yesNo(*p.PasswordAuthentication))
	}
	if p.PubkeyAuthentication != nil {
		add("PubkeyAuthentication", yesNo(*p.PubkeyAuthentication))
	}
	if p.MaxAuthTries != nil {
		if *p.MaxAuthTries < 1 || *p.MaxAuthTries > 100 {
			return nil, invalid("max_auth_tries must be between 1 and 100")
		}
		add("MaxAuthTries", strconv.Itoa(*p.MaxAuthTries))
	}
	if p.AllowUsers != nil {
		if len(p.AllowUsers) == 0 {
			return nil, invalid("allow_users may not be empty; omit it to leave the directive alone")
		}
		add("AllowUsers", strings.Join(p.AllowUsers, " "))
	}
	if p.AllowGroups != nil {
		if len(p.AllowGroups) == 0 {
			return nil, invalid("allow_groups may not be empty; omit it to leave the directive alone")
		}
		add("AllowGroups", strings.Join(p.AllowGroups, " "))
	}
	if p.X11Forwarding != nil {
		add("X11Forwarding", yesNo(*p.X11Forwarding))
	}
	if len(directives) == 0 {
		return nil, invalid("no directive was supplied")
	}
	return directives, nil
}

// renderSSHConfig produces the file to write: a self-contained drop-in
// when the host supports one, or the original config with the touched
// directives replaced in place when it does not.
func renderSSHConfig(directives [][2]string, previous string, useDropIn bool) string {
	if useDropIn {
		var b strings.Builder
		b.WriteString("# Managed by Kaname. Edits are overwritten on the next ssh config apply.\n")
		for _, directive := range directives {
			fmt.Fprintf(&b, "%s %s\n", directive[0], directive[1])
		}
		return b.String()
	}
	return mergeDirectives(previous, directives)
}

// mergeDirectives replaces the directives Kaname manages and leaves every
// other line of the operator's config untouched.
func mergeDirectives(previous string, directives [][2]string) string {
	managed := map[string]string{}
	for _, directive := range directives {
		managed[strings.ToLower(directive[0])] = directive[1]
	}

	lines := strings.Split(previous, "\n")
	applied := map[string]bool{}
	for i, line := range lines {
		fields := strings.Fields(line)
		if len(fields) == 0 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		key := strings.ToLower(fields[0])
		value, ok := managed[key]
		if !ok {
			continue
		}
		if applied[key] {
			// A directive OpenSSH would ignore anyway (first one wins) is
			// commented out rather than left to confuse the next reader.
			lines[i] = "# " + line
			continue
		}
		lines[i] = properCase(directives, key) + " " + value
		applied[key] = true
	}

	var b strings.Builder
	b.WriteString(strings.Join(lines, "\n"))
	if !strings.HasSuffix(b.String(), "\n") {
		b.WriteByte('\n')
	}
	for _, directive := range directives {
		if applied[strings.ToLower(directive[0])] {
			continue
		}
		fmt.Fprintf(&b, "%s %s\n", directive[0], directive[1])
	}
	return b.String()
}

func properCase(directives [][2]string, key string) string {
	for _, directive := range directives {
		if strings.EqualFold(directive[0], key) {
			return directive[0]
		}
	}
	return key
}

/* --------------------------------- keys ------------------------------- */

func parseAuthorizedKey(line, owner string) (providers.SSHKeyInfo, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return providers.SSHKeyInfo{}, false
	}

	fields := strings.Fields(trimmed)
	// An options prefix may precede the algorithm, so the key starts at
	// the first field that names one.
	start := -1
	for i, field := range fields {
		if _, ok := sshKeyTypes[field]; ok {
			start = i
			break
		}
	}
	if start < 0 || start+1 >= len(fields) {
		return providers.SSHKeyInfo{}, false
	}

	algorithm, blob := fields[start], fields[start+1]
	comment := strings.Join(fields[start+2:], " ")
	fingerprint, err := keyFingerprint(blob)
	if err != nil {
		return providers.SSHKeyInfo{}, false
	}

	return providers.SSHKeyInfo{
		Fingerprint: fingerprint,
		Type:        algorithm,
		Comment:     comment,
		PublicKey:   algorithm + " " + blob,
		User:        owner,
	}, true
}

// normalizeAuthorizedKey re-parses a key before it is written, so a
// malformed or multi-line value can never land in authorized_keys.
func normalizeAuthorizedKey(publicKey, comment string) (string, error) {
	if strings.ContainsAny(publicKey, "\n\r") || strings.ContainsAny(comment, "\n\r") {
		return "", invalid("a public key and its comment must each be a single line")
	}

	fields := strings.Fields(strings.TrimSpace(publicKey))
	if len(fields) < 2 {
		return "", invalid("public key must be `<type> <base64>`")
	}
	if _, ok := sshKeyTypes[fields[0]]; !ok {
		return "", invalid("%q is not a supported key type", fields[0])
	}
	if _, err := keyFingerprint(fields[1]); err != nil {
		return "", invalid("public key is not valid base64")
	}

	line := fields[0] + " " + fields[1]
	if trimmed := strings.TrimSpace(comment); trimmed != "" {
		line += " " + trimmed
	} else if len(fields) > 2 {
		line += " " + strings.Join(fields[2:], " ")
	}
	return line, nil
}

// keyFingerprint produces the SHA256 form OpenSSH prints, so what the
// panel shows matches `ssh-keygen -lf`.
func keyFingerprint(blob string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		return "", err
	}
	if len(decoded) == 0 {
		return "", errors.New("empty key blob")
	}
	sum := sha256.Sum256(decoded)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:]), nil
}

/* -------------------------------- helpers ----------------------------- */

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

// parseIdle reads who's idle column, which is "." for active, "old" for
// a very long idle, or HH:MM.
func parseIdle(value string) int {
	switch value {
	case ".", "?":
		return 0
	case "old":
		return 86400
	}
	hours, minutes, ok := strings.Cut(value, ":")
	if !ok {
		return 0
	}
	h, err := strconv.Atoi(hours)
	if err != nil {
		return 0
	}
	m, err := strconv.Atoi(minutes)
	if err != nil {
		return 0
	}
	return h*3600 + m*60
}
