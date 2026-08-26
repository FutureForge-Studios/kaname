// Package selfupdate replaces the running agent binary with a verified
// build.
//
// Two rules hold here. The digest is checked before the download is ever
// made executable, so a truncated transfer or a substituted artifact
// cannot become the thing that runs as root on the next boot. And the
// binary that was running is kept, so an agent that comes back broken
// can be put back by hand from the box itself.
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ErrDigestMismatch is returned when the downloaded bytes are not the
// bytes the control plane said they would be.
var ErrDigestMismatch = errors.New("downloaded binary does not match the expected sha256")

// MaxBinaryBytes caps a download. The agent is a single static binary of
// a few tens of megabytes; anything an order of magnitude larger is a
// misconfiguration or something worse, and filling the disk of a managed
// host is not an acceptable way to find out.
const MaxBinaryBytes = 256 << 20

// Download fetches url into dst and verifies its digest. On any failure
// dst is removed, so a half-written file can never be swapped in.
func Download(ctx context.Context, client *http.Client, url, want, dst string) error {
	want = strings.ToLower(strings.TrimSpace(want))
	if len(want) != 64 {
		return fmt.Errorf("expected a 64-character sha256, got %d characters", len(want))
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: the server answered %s", url, response.Status)
	}

	file, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}

	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(response.Body, MaxBinaryBytes+1))
	closeErr := file.Close()

	if copyErr != nil {
		os.Remove(dst)
		return fmt.Errorf("downloading %s: %w", url, copyErr)
	}
	if closeErr != nil {
		os.Remove(dst)
		return closeErr
	}
	if written > MaxBinaryBytes {
		os.Remove(dst)
		return fmt.Errorf("the binary at %s is larger than %d bytes", url, MaxBinaryBytes)
	}

	got := hex.EncodeToString(digest.Sum(nil))
	if got != want {
		os.Remove(dst)
		return fmt.Errorf("%w: expected %s, got %s", ErrDigestMismatch, want, got)
	}

	return nil
}

// Swap puts staged in place of binary, keeping the previous build at
// backup.
//
// The order matters. The backup is a copy rather than a move, so the
// running binary is never absent from its own path; the new build then
// arrives by rename, which is atomic within a filesystem. On Linux,
// renaming over a running executable is allowed — the kernel keeps the
// old inode alive for the process that is executing it, which is exactly
// why the caller can go on to answer the request that asked for this.
func Swap(binary, staged, backup string) error {
	if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
		return err
	}
	if err := copyFile(binary, backup, 0o700); err != nil {
		return fmt.Errorf("keeping a copy of the current binary: %w", err)
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return err
	}
	if err := os.Rename(staged, binary); err != nil {
		return fmt.Errorf("replacing %s: %w", binary, err)
	}
	return nil
}

func copyFile(from, to string, mode os.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()

	target, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}

	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}
