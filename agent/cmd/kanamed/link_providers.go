package main

// Providers register themselves from their own init, so the set this
// binary can serve is decided by what is linked in rather than by a
// switch statement.
//
// The linux package registers a real provider on Linux and one that
// refuses with `unsupported` everywhere else, which is what keeps
// `go build` green on a Windows or macOS dev machine.
//
// The sim package is always linked because it is not a toy: it is how
// the whole product is developed, demoed and end-to-end tested without
// a Linux host (KD-010). Selecting it needs an explicit --simulate, and
// it refuses to start when KANAME_ENV=production.
import (
	_ "github.com/futureforge/kaname/agent/internal/providers/linux"
	_ "github.com/futureforge/kaname/agent/internal/providers/sim"
)
