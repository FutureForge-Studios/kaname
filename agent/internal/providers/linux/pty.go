//go:build linux

package linux

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The terminal.
 *
 * This is the one place in the agent where free-form execution is
 * possible at all, which is exactly why it is the one place the control
 * plane permissions separately, tickets and records (KD-013). Even here
 * nothing takes a command string over the wire: pty.open starts the
 * account's own login shell and the operator's keystrokes go to it as
 * bytes, the same as if they had typed them into ssh.
 *
 * A session is keyed by the id of the request that opened it, and it is
 * torn down when that request's stream ends, when pty.close arrives, or
 * when the connection dies — never left orphaned holding a root shell.
 * ------------------------------------------------------------------ */

const (
	// How long a closing session is given to exit on SIGHUP before it is
	// killed outright.
	ptyHangupGrace = 2 * time.Second
	ptyReadBuffer  = 32 << 10
)

// The shells a login is allowed to land in. A passwd entry naming
// anything else falls back rather than executing it.
var loginShells = []string{"/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/zsh", "/usr/bin/zsh", "/bin/ash"}

type ptySession struct {
	master *os.File
	cmd    *exec.Cmd
	closed chan struct{}
	once   sync.Once
}

func (s *ptySession) close() {
	s.once.Do(func() {
		close(s.closed)
		if s.cmd.Process != nil {
			// Signalling the process group takes the shell's children with
			// it; killing only the shell would leave them holding the pty.
			_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGHUP)
			time.AfterFunc(ptyHangupGrace, func() {
				_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
			})
		}
		_ = s.master.Close()
	})
}

type ptyOps struct{ p *provider }

func (o ptyOps) Open(ctx context.Context, sessionID string, p providers.PtyOpenParams, stream providers.Stream) (providers.PtyOpenResult, error) {
	account, err := resolveAccount(p.User)
	if err != nil {
		return providers.PtyOpenResult{}, err
	}

	workdir := p.Cwd
	if workdir == "" {
		workdir = account.HomeDir
	}
	if workdir, err = validatePath(workdir); err != nil {
		return providers.PtyOpenResult{}, err
	}
	if !dirExists(workdir) {
		workdir = "/"
	}

	shell := loginShell(account)
	// `-l` so the operator gets the same profile and PATH they would get
	// over ssh, rather than a bare shell with a surprising environment.
	cmd := exec.Command(shell, "-l")
	cmd.Dir = workdir
	cmd.Env = []string{
		"TERM=" + sanitizeTerm(p.Term),
		"HOME=" + account.HomeDir,
		"USER=" + account.Username,
		"LOGNAME=" + account.Username,
		"SHELL=" + shell,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=" + orDefault(os.Getenv("LANG"), "C.UTF-8"),
	}

	if account.Username != currentUsername() {
		credentials, err := credential(account.Username)
		if err != nil {
			return providers.PtyOpenResult{}, err
		}
		cmd.SysProcAttr = credentials
	}

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(p.Rows), Cols: uint16(p.Cols)})
	if err != nil {
		return providers.PtyOpenResult{}, fmt.Errorf("start %s for %s: %w", shell, account.Username, err)
	}

	session := &ptySession{master: master, cmd: cmd, closed: make(chan struct{})}
	o.p.registerPTY(sessionID, session)
	defer o.p.releasePTY(sessionID)

	o.p.log.Info("terminal opened", "session", sessionID, "user", account.Username, "shell", shell, "pid", cmd.Process.Pid)
	result := providers.PtyOpenResult{PID: cmd.Process.Pid}

	if err := pump(ctx, session, stream); err != nil {
		return result, err
	}
	return result, nil
}

func (o ptyOps) Resize(ctx context.Context, sessionID string, p providers.PtyResizeParams) error {
	session, ok := o.p.lookupPTY(sessionID)
	if !ok {
		return notFound("terminal session %s", sessionID)
	}
	_ = ctx

	if err := pty.Setsize(session.master, &pty.Winsize{Rows: uint16(p.Rows), Cols: uint16(p.Cols)}); err != nil {
		return fmt.Errorf("resize terminal: %w", err)
	}
	return nil
}

func (o ptyOps) Close(ctx context.Context, sessionID string) error {
	session, ok := o.p.lookupPTY(sessionID)
	if !ok {
		return notFound("terminal session %s", sessionID)
	}
	_ = ctx

	session.close()
	o.p.releasePTY(sessionID)
	return nil
}

/* -------------------------------- pumping ----------------------------- */

// pump wires the pty to the RPC stream in both directions and returns
// once either the shell exits, the operator disconnects, or the request
// is cancelled. Whichever happens first tears the other side down.
func pump(ctx context.Context, session *ptySession, stream providers.Stream) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var once sync.Once
	failure := make(chan error, 3)
	report := func(err error) { once.Do(func() { failure <- err }) }

	go func() {
		select {
		case <-ctx.Done():
		case <-session.closed:
		}
		session.close()
	}()

	go func() {
		buffer := make([]byte, ptyReadBuffer)
		for {
			n, err := session.master.Read(buffer)
			if n > 0 {
				// Terminal output is arbitrary bytes, not text: base64 keeps
				// an escape sequence intact instead of mangling it into JSON.
				if sendErr := stream.Send(ctx, buffer[:n], providers.EncodingBase64); sendErr != nil {
					report(sendErr)
					return
				}
			}
			if err != nil {
				// A closed pty reports EIO once the child is gone, which is
				// the normal end of a session rather than a failure.
				report(nil)
				return
			}
		}
	}()

	go func() {
		for {
			data, err := stream.Recv(ctx)
			if err != nil {
				if errors.Is(err, io.EOF) {
					report(nil)
					return
				}
				report(nil)
				return
			}
			if _, err := session.master.Write(data); err != nil {
				report(err)
				return
			}
		}
	}()

	go func() {
		_ = session.cmd.Wait()
		report(nil)
	}()

	err := <-failure
	session.close()
	return err
}

/* ------------------------------- registry ----------------------------- */

func (p *provider) registerPTY(id string, session *ptySession) {
	p.ptyMu.Lock()
	previous := p.ptys[id]
	p.ptys[id] = session
	p.ptyMu.Unlock()

	if previous != nil {
		previous.close()
	}
}

func (p *provider) lookupPTY(id string) (*ptySession, bool) {
	p.ptyMu.Lock()
	defer p.ptyMu.Unlock()
	session, ok := p.ptys[id]
	return session, ok
}

func (p *provider) releasePTY(id string) {
	p.ptyMu.Lock()
	delete(p.ptys, id)
	p.ptyMu.Unlock()
}

// closeAllPTYs is called when the provider shuts down. A root shell that
// outlives the agent that opened it is exactly the kind of thing this
// design exists to prevent.
func (p *provider) closeAllPTYs() {
	p.ptyMu.Lock()
	sessions := make([]*ptySession, 0, len(p.ptys))
	for id, session := range p.ptys {
		sessions = append(sessions, session)
		delete(p.ptys, id)
	}
	p.ptyMu.Unlock()

	for _, session := range sessions {
		session.close()
	}
}

/* -------------------------------- helpers ----------------------------- */

func resolveAccount(name string) (*user.User, error) {
	if name == "" {
		if account, err := user.Current(); err == nil {
			return account, nil
		}
		name = "root"
	}
	account, err := user.Lookup(name)
	if err != nil {
		return nil, notFound("user %s", name)
	}
	return account, nil
}

func currentUsername() string {
	account, err := user.Current()
	if err != nil {
		return ""
	}
	return account.Username
}

// loginShell prefers the account's own shell and falls back to the first
// real shell on the host, so a user whose passwd entry says nologin
// still gets a usable terminal rather than an immediate exit.
func loginShell(account *user.User) string {
	if shell := passwdShell(account.Username); shell != "" {
		return shell
	}
	for _, candidate := range loginShells {
		if fileExists(candidate) {
			return candidate
		}
	}
	return "/bin/sh"
}

func passwdShell(username string) string {
	raw, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return ""
	}
	for _, line := range splitLines(string(raw)) {
		fields := strings.Split(line, ":")
		if len(fields) < 7 || fields[0] != username {
			continue
		}
		shell := fields[6]
		if shell == "" || strings.HasSuffix(shell, "nologin") || strings.HasSuffix(shell, "false") {
			return ""
		}
		if !strings.HasPrefix(shell, "/") || !fileExists(shell) {
			return ""
		}
		return shell
	}
	return ""
}

// sanitizeTerm keeps a terminfo name to the characters terminfo itself
// allows, since it is handed to the child as an environment variable.
func sanitizeTerm(term string) string {
	if term == "" {
		return "xterm-256color"
	}
	for i := 0; i < len(term); i++ {
		c := term[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
		default:
			return "xterm-256color"
		}
	}
	return term
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
