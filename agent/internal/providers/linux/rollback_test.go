package linux

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The rollback window.
 *
 * fw.apply and ssh.config.apply are the two verbs that can put a remote
 * host out of reach. Both survive a mistake the same way: install the
 * change, arm a revert, and let only a matching confirm cancel it. The
 * window is expressed in whole seconds by the contract, so these tests
 * use the shortest real window there is rather than pretending to inject
 * a clock the type does not take.
 * ------------------------------------------------------------------ */

// A revert that records that it fired, so a test can wait for it rather
// than sleep and hope.
type revertSpy struct {
	fired chan struct{}

	mu    sync.Mutex
	count int
	err   error
}

func newRevertSpy() *revertSpy { return &revertSpy{fired: make(chan struct{}, 4)} }

func (s *revertSpy) revert(context.Context) error {
	s.mu.Lock()
	s.count++
	err := s.err
	s.mu.Unlock()
	s.fired <- struct{}{}
	return err
}

func (s *revertSpy) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count
}

// awaitRevert waits for the window to lapse, with generous slack so a
// loaded CI box does not fail a timing test that is really about state.
func (s *revertSpy) awaitRevert(t *testing.T) {
	t.Helper()
	select {
	case <-s.fired:
	case <-time.After(5 * time.Second):
		t.Fatal("the window lapsed but the change was never reverted")
	}
}

func (s *revertSpy) assertQuiet(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-s.fired:
		t.Fatal("a confirmed change was reverted anyway")
	case <-time.After(within):
	}
}

// armedCount reads the guard's state under its own lock, because a timer
// goroutine may be unwinding one of these windows while the test looks.
func armedCount(g *rollbackGuard) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.pending)
}

func testGuard() *rollbackGuard {
	return newRollbackGuard(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestArmingWithNoWindowSchedulesNothing(t *testing.T) {
	guard := testGuard()
	spy := newRevertSpy()

	// A zero window is the caller saying it takes responsibility, so there
	// is no token to confirm and nothing to time out.
	token, err := guard.arm("firewall", 0, spy.revert)
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	if token != nil {
		t.Fatalf("a zero window returned the token %q", *token)
	}
	if armedCount(guard) != 0 {
		t.Fatalf("a zero window left %d armed reverts", armedCount(guard))
	}

	if token, err := guard.arm("firewall", -30, spy.revert); err != nil || token != nil {
		t.Fatalf("a negative window returned %v, %v", token, err)
	}
	spy.assertQuiet(t, 100*time.Millisecond)
}

func TestAnUnconfirmedChangeRevertsWhenTheWindowLapses(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	spy := newRevertSpy()

	token, err := guard.arm("firewall", 1, spy.revert)
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	if token == nil || *token == "" {
		t.Fatal("arming a real window returned no token")
	}

	spy.awaitRevert(t)
	if got := spy.calls(); got != 1 {
		t.Errorf("the revert ran %d times, want once", got)
	}

	// A window that has already fired is spent: confirming it afterwards
	// must say so rather than silently succeeding, or the panel would show
	// a change as kept that the host has already thrown away.
	if err := guard.confirm(*token); !errors.Is(err, providers.ErrNotFound) {
		t.Errorf("confirming a lapsed window produced %v, want a %v", err, providers.ErrNotFound)
	}
}

func TestConfirmingCancelsTheRevert(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	spy := newRevertSpy()

	token, err := guard.arm("firewall", 1, spy.revert)
	if err != nil || token == nil {
		t.Fatalf("arm: %v, %v", token, err)
	}
	if err := guard.confirm(*token); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if armedCount(guard) != 0 {
		t.Errorf("confirming left %d armed reverts", armedCount(guard))
	}

	// Well past the window it was armed for.
	spy.assertQuiet(t, 1500*time.Millisecond)
	if got := spy.calls(); got != 0 {
		t.Errorf("the revert ran %d times after a confirm", got)
	}
}

func TestConfirmingWithTheWrongTokenChangesNothing(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	spy := newRevertSpy()

	token, err := guard.arm("firewall", 1, spy.revert)
	if err != nil || token == nil {
		t.Fatalf("arm: %v, %v", token, err)
	}

	for _, wrong := range []string{"", "not-a-token", *token + "0", (*token)[1:]} {
		if err := guard.confirm(wrong); !errors.Is(err, providers.ErrNotFound) {
			t.Errorf("confirm(%q) produced %v, want a %v", wrong, err, providers.ErrNotFound)
		}
	}
	// The real window is untouched by the failed attempts and still fires.
	spy.awaitRevert(t)
}

// One armed window per scope. A second apply supersedes the first, or two
// timers would race and the loser would restore a snapshot that is two
// changes stale.
func TestASecondApplyInTheSameScopeSupersedesTheFirst(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	first, second := newRevertSpy(), newRevertSpy()

	firstToken, err := guard.arm("firewall", 1, first.revert)
	if err != nil || firstToken == nil {
		t.Fatalf("arm: %v, %v", firstToken, err)
	}
	secondToken, err := guard.arm("firewall", 1, second.revert)
	if err != nil || secondToken == nil {
		t.Fatalf("arm: %v, %v", secondToken, err)
	}

	if *firstToken == *secondToken {
		t.Fatal("both applies were handed the same token")
	}
	if armedCount(guard) != 1 {
		t.Fatalf("%d reverts are armed for one scope, want 1", armedCount(guard))
	}
	// The superseded token is dead, so a late confirm for the first apply
	// cannot cancel the second apply's window.
	if err := guard.confirm(*firstToken); !errors.Is(err, providers.ErrNotFound) {
		t.Errorf("the superseded token confirmed with %v, want a %v", err, providers.ErrNotFound)
	}

	second.awaitRevert(t)
	if got := first.calls(); got != 0 {
		t.Errorf("the superseded revert ran %d times, want never", got)
	}
}

// The firewall and sshd share one guard, and they must not cancel each
// other: confirming a firewall apply is not a statement about ssh.
func TestScopesAreIndependent(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	firewall, ssh := newRevertSpy(), newRevertSpy()

	firewallToken, err := guard.arm("firewall", 1, firewall.revert)
	if err != nil || firewallToken == nil {
		t.Fatalf("arm firewall: %v, %v", firewallToken, err)
	}
	sshToken, err := guard.arm("ssh", 1, ssh.revert)
	if err != nil || sshToken == nil {
		t.Fatalf("arm ssh: %v, %v", sshToken, err)
	}
	if armedCount(guard) != 2 {
		t.Fatalf("%d reverts are armed across two scopes, want 2", armedCount(guard))
	}

	if err := guard.confirm(*firewallToken); err != nil {
		t.Fatalf("confirm firewall: %v", err)
	}

	// The ssh window was never confirmed, so it still lapses.
	ssh.awaitRevert(t)
	if got := firewall.calls(); got != 0 {
		t.Errorf("the confirmed firewall change was reverted %d times", got)
	}
}

func TestStopDisarmsEverythingAtShutdown(t *testing.T) {
	guard := testGuard()
	firewall, ssh := newRevertSpy(), newRevertSpy()

	if _, err := guard.arm("firewall", 1, firewall.revert); err != nil {
		t.Fatalf("arm firewall: %v", err)
	}
	if _, err := guard.arm("ssh", 1, ssh.revert); err != nil {
		t.Fatalf("arm ssh: %v", err)
	}

	// Closing the provider means the agent is going away. Reverting on the
	// way out would undo a change during a routine restart.
	guard.stop()
	if armedCount(guard) != 0 {
		t.Fatalf("stop left %d armed reverts", armedCount(guard))
	}
	firewall.assertQuiet(t, 1500*time.Millisecond)
	if got := ssh.calls(); got != 0 {
		t.Errorf("the ssh revert ran %d times after stop", got)
	}
}

// A revert that fails is logged, not retried, and must not leave the
// token behind for a confirm to find.
func TestAFailingRevertStillClearsItsToken(t *testing.T) {
	guard := testGuard()
	defer guard.stop()
	spy := newRevertSpy()
	spy.err = errors.New("nft is no longer installed")

	token, err := guard.arm("firewall", 1, spy.revert)
	if err != nil || token == nil {
		t.Fatalf("arm: %v, %v", token, err)
	}

	spy.awaitRevert(t)
	// Give the timer goroutine a moment past the send to finish unwinding.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := guard.confirm(*token); errors.Is(err, providers.ErrNotFound) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("a failed revert left its token armed")
}

func TestTokensAreUnguessable(t *testing.T) {
	guard := testGuard()
	defer guard.stop()

	seen := map[string]struct{}{}
	for i := 0; i < 32; i++ {
		token, err := guard.arm("scope"+string(rune('a'+i)), 60, func(context.Context) error { return nil })
		if err != nil || token == nil {
			t.Fatalf("arm: %v, %v", token, err)
		}
		// 16 random bytes, hex-encoded. A short or repeating token would
		// let a caller confirm a window it never armed.
		if len(*token) != 32 {
			t.Fatalf("token %q is %d characters, want 32", *token, len(*token))
		}
		if _, repeat := seen[*token]; repeat {
			t.Fatalf("token %q was issued twice", *token)
		}
		seen[*token] = struct{}{}
	}
}
