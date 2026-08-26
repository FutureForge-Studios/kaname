package sim

import (
	"context"
	"errors"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

// A simulated host exists so the panel can be developed without a
// fleet. The one thing it must never do is claim to have carried out a
// destructive operation it did not carry out.
func TestSelfUpdateIsRefused(t *testing.T) {
	provider, err := New(context.Background(), providers.Options{
		AgentVersion: "0.1.0",
		StateDir:     t.TempDir(),
	})
	if err != nil {
		t.Fatalf("opening the simulator: %v", err)
	}
	t.Cleanup(func() { _ = provider.Close() })

	result, err := provider.System().SelfUpdate(
		context.Background(),
		providers.SelfUpdateParams{Version: "0.2.0", URL: "https://example.com/kanamed", SHA256: "0"},
		nil,
	)
	if !errors.Is(err, providers.ErrUnsupported) {
		t.Fatalf("expected ErrUnsupported, got %v", err)
	}
	if result.Restarting {
		t.Fatal("a simulated host reported that it was restarting")
	}
}
