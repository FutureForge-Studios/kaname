//go:build linux

package linux

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * SSH.
 *
 * ssh.config.apply is the second place in this agent that can lock an
 * operator out of their own machine, so it works the same way the
 * firewall does: write a candidate, prove it with `sshd -t`, reload, and
 * schedule a revert that only a matching confirm cancels. A config that
 * fails validation never reaches the running daemon at all.
 * ------------------------------------------------------------------ */

const (
	sshConfigPath  = "/etc/ssh/sshd_config"
	sshDropInDir   = "/etc/ssh/sshd_config.d"
	sshDropInFile  = "50-kaname.conf"
	authorizedKeys = ".ssh/authorized_keys"
)

type sshOps struct{ p *provider }

/* --------------------------------- keys ------------------------------- */

func (o sshOps) ListKeys(ctx context.Context, p providers.SSHKeysListParams) ([]providers.SSHKeyInfo, error) {
	accounts, err := loginAccounts(p.User)
	if err != nil {
		return nil, err
	}

	keys := make([]providers.SSHKeyInfo, 0, 16)
	for _, account := range accounts {
		if ctx.Err() != nil {
			return keys, ctx.Err()
		}
		raw, err := os.ReadFile(filepath.Join(account.HomeDir, authorizedKeys))
		if err != nil {
			continue
		}
		for _, line := range splitLines(string(raw)) {
			key, ok := parseAuthorizedKey(line, account.Username)
			if !ok {
				continue
			}
			keys = append(keys, key)
		}
	}

	sortSlice(keys, func(a, b providers.SSHKeyInfo) bool {
		if a.User != b.User {
			return a.User < b.User
		}
		return a.Comment < b.Comment
	})
	return keys, nil
}

func (o sshOps) ApplyKeys(ctx context.Context, p providers.SSHKeysApplyParams) (int, error) {
	account, err := user.Lookup(p.User)
	if err != nil {
		return 0, notFound("user %s", p.User)
	}
	uid, _ := strconv.Atoi(account.Uid)
	gid, _ := strconv.Atoi(account.Gid)

	sshDir := filepath.Join(account.HomeDir, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		return 0, wrapFsError(sshDir, err)
	}
	if err := os.Chown(sshDir, uid, gid); err != nil {
		return 0, wrapFsError(sshDir, err)
	}
	if err := os.Chmod(sshDir, 0o700); err != nil {
		return 0, wrapFsError(sshDir, err)
	}

	var b strings.Builder
	b.WriteString("# Managed by Kaname. Edits are overwritten on the next key apply.\n")
	applied := 0
	for _, key := range p.Keys {
		normalized, err := normalizeAuthorizedKey(key.PublicKey, key.Comment)
		if err != nil {
			return 0, err
		}
		b.WriteString(normalized)
		b.WriteByte('\n')
		applied++
	}

	target := filepath.Join(account.HomeDir, authorizedKeys)
	if err := writeAtomic(target, []byte(b.String()), 0o600); err != nil {
		return 0, err
	}
	// sshd refuses a key file it does not trust the ownership of, so this
	// is not cosmetic.
	if err := os.Chown(target, uid, gid); err != nil {
		return 0, wrapFsError(target, err)
	}

	_ = ctx
	return applied, nil
}

/* -------------------------------- config ------------------------------ */

func (o sshOps) ReadConfig(ctx context.Context) (providers.SSHConfigInfo, error) {
	config := providers.SSHConfigInfo{
		Port:                   22,
		PermitRootLogin:        "prohibit-password",
		PasswordAuthentication: true,
		PubkeyAuthentication:   true,
		MaxAuthTries:           6,
		AllowUsers:             []string{},
		AllowGroups:            []string{},
	}

	// `sshd -T` prints the effective configuration, includes and all,
	// which is the only honest answer once drop-ins are in play.
	directives, err := o.effectiveConfig(ctx)
	if err != nil {
		return config, err
	}

	for key, values := range directives {
		value := strings.Join(values, " ")
		switch key {
		case "port":
			if port, err := strconv.Atoi(values[0]); err == nil {
				config.Port = port
			}
		case "permitrootlogin":
			config.PermitRootLogin = value
		case "passwordauthentication":
			config.PasswordAuthentication = value == "yes"
		case "pubkeyauthentication":
			config.PubkeyAuthentication = value == "yes"
		case "maxauthtries":
			if tries, err := strconv.Atoi(values[0]); err == nil {
				config.MaxAuthTries = tries
			}
		case "allowusers":
			config.AllowUsers = strings.Fields(value)
		case "allowgroups":
			config.AllowGroups = strings.Fields(value)
		case "x11forwarding":
			config.X11Forwarding = value == "yes"
		}
	}
	return config, nil
}

func (o sshOps) ApplyConfig(ctx context.Context, p providers.SSHConfigApplyParams) (providers.SSHConfigApplyResult, error) {
	binary := sshdBinary()
	if binary == "" {
		return providers.SSHConfigApplyResult{}, unsupported("sshd is not installed")
	}

	target, useDropIn := sshTargetFile()
	previous, previousErr := os.ReadFile(target)
	if previousErr != nil && !isNotExist(previousErr) {
		return providers.SSHConfigApplyResult{}, wrapFsError(target, previousErr)
	}

	rendered, err := o.renderConfig(ctx, p, string(previous), useDropIn)
	if err != nil {
		return providers.SSHConfigApplyResult{}, err
	}
	if useDropIn {
		if err := os.MkdirAll(sshDropInDir, 0o755); err != nil {
			return providers.SSHConfigApplyResult{}, wrapFsError(sshDropInDir, err)
		}
	}
	if err := writeAtomic(target, []byte(rendered), 0o600); err != nil {
		return providers.SSHConfigApplyResult{}, err
	}

	restore := func(restoreCtx context.Context) error {
		if previousErr != nil {
			if err := os.Remove(target); err != nil && !isNotExist(err) {
				return wrapFsError(target, err)
			}
		} else if err := writeAtomic(target, previous, 0o600); err != nil {
			return err
		}
		return o.reload(restoreCtx)
	}

	// Validating before reloading is the whole point: a syntax error that
	// reaches sshd takes the only way back in with it.
	if out, err := runCombined(ctx, execOptions{Name: binary, Args: []string{"-t"}, Env: cLocale()}); err != nil {
		_ = restore(ctx)
		return providers.SSHConfigApplyResult{}, &providers.ExecError{
			Op:     "sshd -t",
			Output: tailBytes(out, execOutputLimit),
			Err:    providers.ErrPreconditionFailed,
		}
	}
	if err := o.reload(ctx); err != nil {
		_ = restore(ctx)
		return providers.SSHConfigApplyResult{}, err
	}

	token, err := o.p.rollback.arm("ssh", p.RollbackSeconds, restore)
	if err != nil {
		return providers.SSHConfigApplyResult{}, err
	}
	return providers.SSHConfigApplyResult{RollbackToken: token}, nil
}

// renderConfig decides what to write and then refuses the one shape that
// cannot be undone from the panel: a change that excludes the account
// currently holding the session applying it.
func (o sshOps) renderConfig(ctx context.Context, p providers.SSHConfigApplyParams, previous string, useDropIn bool) (string, error) {
	directives, err := sshDirectives(p)
	if err != nil {
		return "", err
	}
	// Locking out the account that is currently connected is the failure
	// mode this whole method exists to prevent, so it is refused outright.
	if err := o.checkNotSelfLocking(ctx, p); err != nil {
		return "", err
	}
	return renderSSHConfig(directives, previous, useDropIn), nil
}

// checkNotSelfLocking refuses a change that would exclude every account
// with an active session.
func (o sshOps) checkNotSelfLocking(ctx context.Context, p providers.SSHConfigApplyParams) error {
	if p.AllowUsers == nil {
		return nil
	}
	sessions, err := o.Sessions(ctx)
	if err != nil || len(sessions) == 0 {
		return nil
	}

	allowed := map[string]struct{}{}
	for _, name := range p.AllowUsers {
		allowed[name] = struct{}{}
	}
	for _, session := range sessions {
		if _, ok := allowed[session.User]; ok {
			return nil
		}
	}
	return precondition("allow_users excludes every account with an open session")
}

func (o sshOps) reload(ctx context.Context) error {
	if !o.p.has(providers.CapSystemd) {
		return unsupported("reloading sshd needs systemd on this host")
	}
	// Debian calls the unit ssh, Red Hat calls it sshd, and a host may
	// carry an alias for the other.
	var lastErr error
	for _, unit := range []string{"ssh", "sshd"} {
		_, err := runWith(ctx, execOptions{Name: "systemctl", Args: []string{"reload", unit}, Env: cLocale()})
		if err == nil {
			return nil
		}
		lastErr = err
	}
	return lastErr
}

func (o sshOps) effectiveConfig(ctx context.Context) (map[string][]string, error) {
	directives := map[string][]string{}

	if binary := sshdBinary(); binary != "" {
		out, err := runWith(ctx, execOptions{Name: binary, Args: []string{"-T"}, Env: cLocale()})
		if err == nil {
			for _, line := range splitLines(out) {
				key, value, ok := strings.Cut(strings.TrimSpace(line), " ")
				if !ok {
					continue
				}
				lowered := strings.ToLower(key)
				directives[lowered] = append(directives[lowered], strings.TrimSpace(value))
			}
			return directives, nil
		}
	}

	// A host where sshd cannot be executed still has a config worth
	// reading, even if it is only the literal file.
	raw, err := os.ReadFile(sshConfigPath)
	if err != nil {
		return nil, wrapFsError(sshConfigPath, err)
	}
	for _, line := range splitLines(string(raw)) {
		fields := strings.Fields(line)
		if len(fields) < 2 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		key := strings.ToLower(fields[0])
		directives[key] = append(directives[key], strings.Join(fields[1:], " "))
	}
	return directives, nil
}

/* ------------------------------- sessions ----------------------------- */

func (o sshOps) Sessions(ctx context.Context) ([]providers.SSHSessionInfo, error) {
	out, err := runWith(ctx, execOptions{Name: "who", Args: []string{"-u"}, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	sessions := make([]providers.SSHSessionInfo, 0, 8)
	for _, line := range splitLines(out) {
		// who -u: user tty date time idle pid (host)
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}

		session := providers.SSHSessionInfo{
			User:        fields[0],
			TTY:         fields[1],
			IdleSeconds: parseIdle(fields[4]),
			StartedAt:   parseWhoTimestamp(fields[2], fields[3]),
		}
		if pid, err := strconv.Atoi(fields[5]); err == nil {
			session.PID = pid
		}
		if len(fields) > 6 {
			session.FromIP = strings.Trim(fields[6], "()")
		}
		// A row with no remote address is a local console login, which is
		// not an SSH session.
		if session.FromIP == "" {
			continue
		}
		sessions = append(sessions, session)
	}
	return sessions, nil
}

/* -------------------------------- helpers ----------------------------- */

// loginAccounts lists the accounts worth inspecting: root plus the
// regular users, read from /etc/passwd because the os/user package
// cannot enumerate.
func loginAccounts(only string) ([]*user.User, error) {
	if only != "" {
		account, err := user.Lookup(only)
		if err != nil {
			return nil, notFound("user %s", only)
		}
		return []*user.User{account}, nil
	}

	raw, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return nil, wrapFsError("/etc/passwd", err)
	}

	accounts := make([]*user.User, 0, 16)
	for _, line := range splitLines(string(raw)) {
		fields := strings.Split(line, ":")
		if len(fields) < 7 {
			continue
		}
		uid, err := strconv.Atoi(fields[2])
		if err != nil {
			continue
		}
		if uid != 0 && uid < 1000 {
			continue
		}
		if strings.HasSuffix(fields[6], "nologin") || strings.HasSuffix(fields[6], "false") {
			continue
		}
		accounts = append(accounts, &user.User{
			Uid:      fields[2],
			Gid:      fields[3],
			Username: fields[0],
			Name:     fields[4],
			HomeDir:  fields[5],
		})
	}
	return accounts, nil
}

func sshdBinary() string {
	if hasBinary("sshd") {
		return "sshd"
	}
	for _, candidate := range []string{"/usr/sbin/sshd", "/sbin/sshd", "/usr/bin/sshd"} {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

// sshTargetFile prefers a drop-in when the main config includes one,
// because writing there leaves the operator's own file untouched.
func sshTargetFile() (string, bool) {
	raw, err := os.ReadFile(sshConfigPath)
	if err != nil {
		return sshConfigPath, false
	}
	for _, line := range splitLines(string(raw)) {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "Include") {
			continue
		}
		if strings.HasPrefix(fields[1], sshDropInDir) {
			return filepath.Join(sshDropInDir, sshDropInFile), true
		}
	}
	return sshConfigPath, false
}

func parseWhoTimestamp(date, clock string) string {
	parsed, err := time.ParseInLocation("2006-01-02 15:04", date+" "+clock, time.Local)
	if err != nil {
		return nowRFC3339()
	}
	return rfc3339(parsed)
}
