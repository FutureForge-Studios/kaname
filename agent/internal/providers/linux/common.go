package linux

import (
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Shared helpers.
 *
 * This file carries no build tag, and neither do the other files that
 * hold this package's pure logic. The host a Kaname agent manages is
 * always Linux, but the machine it is built and tested on usually is
 * not — so the parts that decide whether a path is safe, what argv a
 * firewall rule becomes, or when an unconfirmed change reverts are kept
 * free of syscalls and compile, and are proved, everywhere.
 * ------------------------------------------------------------------ */

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

func nowRFC3339() string {
	return rfc3339(time.Now())
}

func stringPtr(s string) *string { return &s }

func int64Ptr(v int64) *int64 { return &v }

func notFound(format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), providers.ErrNotFound)
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), providers.ErrInvalidParams)
}

func unsupported(format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), providers.ErrUnsupported)
}

func precondition(format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), providers.ErrPreconditionFailed)
}

func splitLines(s string) []string {
	trimmed := strings.TrimRight(s, "\n")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}

// isNotExist keeps the fs and syscall spellings of "missing" in one place.
func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func sortSlice[T any](items []T, less func(a, b T) bool) {
	sort.Slice(items, func(i, j int) bool { return less(items[i], items[j]) })
}
