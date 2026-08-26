//go:build !linux

// Package linux registers the real host provider. Everything it does is
// Linux-only, so on any other OS it registers a factory that refuses
// rather than disappearing: `kanamed run` then reports that this build
// cannot manage this machine, which is the honest answer, and the module
// still compiles on a Windows or macOS dev box.
package linux

import (
	"context"
	"fmt"
	"runtime"

	"github.com/futureforge/kaname/agent/internal/providers"
)

func init() {
	providers.Register("linux", func(ctx context.Context, opts providers.Options) (providers.Provider, error) {
		return nil, fmt.Errorf("managed hosts are Linux only, this is %s: %w", runtime.GOOS, providers.ErrUnsupported)
	})
}
