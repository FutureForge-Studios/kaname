package linux

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* --------------------------- rollback window -------------------------- */

// rollbackGuard is the lockout-safe apply window shared by fw.apply and
// ssh.config.apply: the change goes in, a revert is scheduled, and only a
// confirm carrying the matching token cancels it. It is the difference
// between a mistyped rule and a box you can no longer reach.
type rollbackGuard struct {
	log *slog.Logger

	mu      sync.Mutex
	pending map[string]*pendingRevert
}

type pendingRevert struct {
	timer *time.Timer
	scope string
}

func newRollbackGuard(log *slog.Logger) *rollbackGuard {
	return &rollbackGuard{log: log, pending: map[string]*pendingRevert{}}
}

// arm schedules revert unless a matching confirm arrives first. A window
// of zero means the caller took responsibility and no revert is armed.
func (g *rollbackGuard) arm(scope string, seconds int, revert func(context.Context) error) (*string, error) {
	if seconds <= 0 {
		return nil, nil
	}

	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("generate rollback token: %w", err)
	}
	token := hex.EncodeToString(raw)

	g.mu.Lock()
	defer g.mu.Unlock()

	// One armed window per scope: a second apply supersedes the first, and
	// leaving both timers running would revert to the wrong snapshot.
	for existing, entry := range g.pending {
		if entry.scope == scope {
			entry.timer.Stop()
			delete(g.pending, existing)
		}
	}

	timer := time.AfterFunc(time.Duration(seconds)*time.Second, func() {
		g.mu.Lock()
		delete(g.pending, token)
		g.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := revert(ctx); err != nil {
			g.log.Error("rollback failed", "scope", scope, "error", err)
			return
		}
		g.log.Warn("rolled back unconfirmed change", "scope", scope)
	})
	g.pending[token] = &pendingRevert{timer: timer, scope: scope}

	return &token, nil
}

func (g *rollbackGuard) confirm(token string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	entry, ok := g.pending[token]
	if !ok {
		return fmt.Errorf("no pending change carries that token: %w", providers.ErrNotFound)
	}
	entry.timer.Stop()
	delete(g.pending, token)
	return nil
}

func (g *rollbackGuard) stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for token, entry := range g.pending {
		entry.timer.Stop()
		delete(g.pending, token)
	}
}
