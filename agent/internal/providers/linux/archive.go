package linux

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Archive extraction.
 *
 * An archive is attacker-controlled input by the time it reaches a host:
 * an operator uploads what a customer sent them and asks the panel to
 * unpack it. Two things therefore hold for every member. Its name is
 * resolved against the destination and clamped there, so a `../` or an
 * absolute path lands inside rather than beside. And a symlink member is
 * refused outright if the link would resolve out of the destination,
 * because a later member can be written *through* it.
 * ------------------------------------------------------------------ */

func extractTar(ctx context.Context, source, destination string, overwrite bool, progress func(string) error) (int, error) {
	handle, err := os.Open(source)
	if err != nil {
		return 0, wrapFsError(source, err)
	}
	defer handle.Close()

	var reader io.Reader = handle
	if !strings.HasSuffix(strings.ToLower(source), ".tar") {
		gzipped, err := gzip.NewReader(handle)
		if err != nil {
			return 0, fmt.Errorf("open %s as gzip: %w", source, err)
		}
		defer gzipped.Close()
		reader = gzipped
	}

	archive := tar.NewReader(reader)
	extracted := 0
	for {
		if ctx.Err() != nil {
			return extracted, ctx.Err()
		}
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return extracted, nil
		}
		if err != nil {
			return extracted, fmt.Errorf("read %s: %w", source, err)
		}

		target, err := containedPath(destination, header.Name)
		if err != nil {
			return extracted, err
		}
		mode := header.FileInfo().Mode()

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, mode.Perm()); err != nil {
				return extracted, wrapFsError(target, err)
			}
		case tar.TypeSymlink:
			// A link whose target escapes the destination is the same
			// attack as a "../" member, one indirection later.
			if err := containedLink(destination, header.Name, header.Linkname); err != nil {
				return extracted, err
			}
			if overwrite {
				os.Remove(target)
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return extracted, wrapFsError(target, err)
			}
		case tar.TypeReg:
			if err := writeMember(target, archive, mode.Perm(), overwrite, header.Size); err != nil {
				return extracted, err
			}
		default:
			continue
		}

		extracted++
		if err := progress(header.Name); err != nil {
			return extracted, err
		}
	}
}

func extractZip(ctx context.Context, source, destination string, overwrite bool, progress func(string) error) (int, error) {
	archive, err := zip.OpenReader(source)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", source, err)
	}
	defer archive.Close()

	extracted := 0
	for _, member := range archive.File {
		if ctx.Err() != nil {
			return extracted, ctx.Err()
		}
		target, err := containedPath(destination, member.Name)
		if err != nil {
			return extracted, err
		}

		if member.FileInfo().IsDir() {
			if err := os.MkdirAll(target, member.Mode().Perm()); err != nil {
				return extracted, wrapFsError(target, err)
			}
			extracted++
			continue
		}

		reader, err := member.Open()
		if err != nil {
			return extracted, fmt.Errorf("open %s in %s: %w", member.Name, source, err)
		}
		err = writeMember(target, reader, member.Mode().Perm(), overwrite, int64(member.UncompressedSize64))
		reader.Close()
		if err != nil {
			return extracted, err
		}

		extracted++
		if err := progress(member.Name); err != nil {
			return extracted, err
		}
	}
	return extracted, nil
}

func writeMember(target string, source io.Reader, mode os.FileMode, overwrite bool, size int64) error {
	if !overwrite {
		if _, err := os.Lstat(target); err == nil {
			return fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
		}
	}
	if err := os.MkdirAll(path.Dir(target), defaultDirMode); err != nil {
		return wrapFsError(path.Dir(target), err)
	}

	handle, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return wrapFsError(target, err)
	}
	defer handle.Close()

	// Reading one byte past the declared size catches a header that lies
	// about how big its member is, which is how a zip bomb fills a disk.
	written, err := io.Copy(handle, io.LimitReader(source, size+1))
	if err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	if written > size {
		os.Remove(target)
		return fmt.Errorf("archive member %s is larger than its header declares: %w", target, providers.ErrPreconditionFailed)
	}
	return nil
}

// containedPath resolves an archive member against its destination and
// refuses anything that lands outside it — the zip-slip guard. Cleaning
// the name against "/" first is what makes "../etc/shadow" and
// "/etc/shadow" both land inside the destination rather than beside it.
func containedPath(destination, name string) (string, error) {
	if strings.ContainsRune(name, 0) {
		return "", invalid("archive member name contains a null byte")
	}
	cleaned := path.Clean("/" + strings.ReplaceAll(name, `\`, "/"))
	target := path.Join(destination, cleaned)
	if !within(target, destination) {
		return "", fmt.Errorf("archive member %q escapes the destination: %w", name, providers.ErrPermissionDenied)
	}
	return target, nil
}

// containedLink refuses a symlink member whose target would resolve out
// of the destination. containedPath cannot answer this question: it
// clamps a member name at the root, which is the right answer for a file
// about to be written and the wrong one for a link that a later member
// can be written through.
func containedLink(destination, name, linkname string) error {
	if linkname == "" {
		return invalid("archive member %q is a symlink with no target", name)
	}
	if strings.ContainsRune(linkname, 0) {
		return invalid("archive member name contains a null byte")
	}

	// An absolute link target is already the host's path, so it is only
	// safe if it happens to point back inside the destination.
	resolved := strings.ReplaceAll(linkname, `\`, "/")
	if !strings.HasPrefix(resolved, "/") {
		member, err := containedPath(destination, name)
		if err != nil {
			return err
		}
		// path.Join cleans without clamping at the root, so a "../" here
		// really does climb out of the member's directory.
		resolved = path.Join(path.Dir(member), resolved)
	}
	if !within(resolved, destination) {
		return fmt.Errorf("archive member %q links to %q, which escapes the destination: %w", name, linkname, providers.ErrPermissionDenied)
	}
	return nil
}
