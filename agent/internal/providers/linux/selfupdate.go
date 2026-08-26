//go:build linux

package linux

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
	"github.com/futureforge/kaname/agent/internal/selfupdate"
)

/* ------------------------------------------------------------------ *
 * Replacing the agent.
 *
 * The awkward part of updating an agent is that the thing being
 * replaced is the thing answering the request. So this does everything
 * it can while it is still alive — download, verify, keep a copy of the
 * current build, swap — reports "restarting", and only then asks
 * systemd for a new process. Claiming success from a process that is
 * about to die would be a claim it has no way to check.
 * ------------------------------------------------------------------ */

// Long enough for the response and its stream to reach the control
// plane before this process goes away.
const restartDelay = 1500 * time.Millisecond

func (s systemOps) SelfUpdate(
	ctx context.Context,
	p providers.SelfUpdateParams,
	stream providers.Stream,
) (providers.SelfUpdateResult, error) {
	var result providers.SelfUpdateResult

	binary, err := os.Executable()
	if err != nil {
		return result, fmt.Errorf("finding the running agent binary: %w", err)
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return result, fmt.Errorf("resolving %s: %w", binary, err)
	}

	staged := binary + ".new"
	backup := filepath.Join(s.p.opts.StateDir, "kanamed.previous")

	say(ctx, stream, "downloading kanamed %s", p.Version)
	client := &http.Client{Timeout: 10 * time.Minute}
	if err := selfupdate.Download(ctx, client, p.URL, p.SHA256, staged); err != nil {
		return result, err
	}
	say(ctx, stream, "sha256 verified")

	say(ctx, stream, "keeping the current binary at %s", backup)
	if err := selfupdate.Swap(binary, staged, backup); err != nil {
		return result, err
	}
	say(ctx, stream, "installed %s at %s", p.Version, binary)
	say(ctx, stream, "restarting; the control plane will see this agent reconnect at %s", p.Version)

	// Signalled rather than exec'd: systemd owns this unit's lifecycle,
	// Restart=always brings it straight back, and re-execing would leave
	// the unit pointing at a process systemd did not start.
	go func() {
		time.Sleep(restartDelay)
		s.p.log.Info("restarting after self-update", "version", p.Version)
		_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
	}()

	return providers.SelfUpdateResult{
		PreviousVersion:    s.p.opts.AgentVersion,
		Version:            p.Version,
		Restarting:         true,
		PreviousBinaryPath: backup,
	}, nil
}

func say(ctx context.Context, stream providers.Stream, format string, args ...any) {
	line := fmt.Sprintf(format, args...) + "\n"
	_ = stream.Send(ctx, []byte(line), providers.EncodingUTF8)
}
