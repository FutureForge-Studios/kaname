package linux

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Path validation.
 *
 * Every path that reaches a file verb passes through here, even though
 * the RPC layer already checked it: the control plane is trusted to be
 * correct, not trusted to be uncompromised. A path is accepted only if
 * it is absolute, carries no null byte, names no `..` segment, and does
 * not reach out of itself once the symlinks on the way are resolved.
 * ------------------------------------------------------------------ */

const (
	defaultFileMode = os.FileMode(0o644)
	defaultDirMode  = os.FileMode(0o755)
)

// Roots a recursive destructive verb refuses to touch. The panel has no
// legitimate reason to `rm -rf /usr`, and an off-by-one in a caller must
// not be able to end the host.
var protectedRoots = map[string]struct{}{
	"/": {}, "/bin": {}, "/boot": {}, "/dev": {}, "/etc": {}, "/lib": {},
	"/lib32": {}, "/lib64": {}, "/proc": {}, "/root": {}, "/sbin": {},
	"/sys": {}, "/usr": {}, "/var": {},
}

// pathResolver answers what a path really points at. checkPath takes one
// rather than calling the filesystem itself, so the escape rule can be
// proved against a link that leaves the tree without a host that carries
// one.
type pathResolver func(string) (string, error)

// validatePath re-checks what the RPC layer already checked.
func validatePath(raw string) (string, error) {
	return checkPath(raw, resolveExisting)
}

func validatePaths(raws []string) ([]string, error) {
	if len(raws) == 0 {
		return nil, invalid("at least one path is required")
	}
	out := make([]string, 0, len(raws))
	for _, raw := range raws {
		cleaned, err := validatePath(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, cleaned)
	}
	return out, nil
}

func checkPath(raw string, resolve pathResolver) (string, error) {
	if raw == "" {
		return "", invalid("path is required")
	}
	if strings.ContainsRune(raw, 0) {
		return "", invalid("path may not contain a null byte")
	}
	if !strings.HasPrefix(raw, "/") {
		return "", invalid("path must be absolute: %s", raw)
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", invalid("path may not traverse upwards: %s", raw)
		}
	}

	cleaned := path.Clean(raw)
	resolved, err := resolve(cleaned)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", cleaned, err)
	}
	if strings.Contains(resolved, "/../") || strings.HasSuffix(resolved, "/..") {
		return "", fmt.Errorf("path escapes through a symlink: %s: %w", raw, providers.ErrPermissionDenied)
	}
	return cleaned, nil
}

// resolveExisting resolves the symlinks of the deepest existing part of
// a path and re-attaches the rest, so a file being created still has its
// parents checked.
func resolveExisting(target string) (string, error) {
	current := target
	remainder := ""

	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			return path.Join(resolved, remainder), nil
		}
		if !isNotExist(err) {
			return "", err
		}
		parent := path.Dir(current)
		if parent == current {
			return target, nil
		}
		remainder = path.Join(path.Base(current), remainder)
		current = parent
	}
}

func within(candidate, root string) bool {
	return candidate == root || strings.HasPrefix(candidate, strings.TrimSuffix(root, "/")+"/")
}

func parseMode(mode string) (os.FileMode, error) {
	if mode == "" {
		return 0, invalid("mode is required")
	}
	parsed, err := strconv.ParseUint(mode, 8, 32)
	if err != nil || parsed > 0o7777 {
		return 0, invalid("mode must be an octal string like 0644")
	}
	return os.FileMode(parsed), nil
}

// wrapFsError maps the kernel's answers onto the provider sentinels so
// the panel can say "not found" or "permission denied" rather than
// surfacing an errno.
func wrapFsError(target string, err error) error {
	switch {
	case err == nil:
		return nil
	case isNotExist(err):
		return notFound("%s", target)
	case errors.Is(err, fs.ErrPermission):
		return fmt.Errorf("%s: %w", target, providers.ErrPermissionDenied)
	// ENOTEMPTY comes before ErrExist deliberately: the standard library
	// classifies it *as* ErrExist, so the other order reports a directory
	// that still has files in it as "already exists".
	case errors.Is(err, syscall.ENOTEMPTY):
		return fmt.Errorf("%s is not empty: %w", target, providers.ErrPreconditionFailed)
	case errors.Is(err, fs.ErrExist):
		return fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
	case errors.Is(err, syscall.ENOSPC):
		return fmt.Errorf("no space left for %s: %w", target, providers.ErrPreconditionFailed)
	default:
		return fmt.Errorf("%s: %w", target, err)
	}
}
