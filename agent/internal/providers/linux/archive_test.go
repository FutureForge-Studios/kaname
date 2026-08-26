package linux

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Zip-slip.
 *
 * An archive is attacker-controlled by the time it reaches a host: the
 * operator uploads what a customer sent and asks the panel to unpack it.
 * These tests build the hostile archives for real and assert on the
 * filesystem afterwards, because the only claim worth making is that
 * nothing landed outside the destination.
 * ------------------------------------------------------------------ */

// The member names every extractor gets caught by. Each one is a real
// shape from the zip-slip family.
var hostileMembers = []string{
	"../escaped.txt",
	"../../escaped.txt",
	"../../../../../../../../etc/cron.d/escaped",
	"/etc/cron.d/absolute",
	"//etc/cron.d/doubled",
	"nested/../../escaped.txt",
	"./../escaped.txt",
	`..\escaped.txt`,
	`..\..\windows\escaped.txt`,
}

type tarEntry struct {
	name     string
	body     string
	linkname string
}

func buildTarGz(t *testing.T, path string, entries []tarEntry) {
	t.Helper()

	handle, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer handle.Close()

	gzipped := gzip.NewWriter(handle)
	archive := tar.NewWriter(gzipped)

	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(entry.body))}
		if entry.linkname != "" {
			header = &tar.Header{Name: entry.name, Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: entry.linkname}
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatalf("write header %q: %v", entry.name, err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := archive.Write([]byte(entry.body)); err != nil {
				t.Fatalf("write body %q: %v", entry.name, err)
			}
		}
	}

	if err := archive.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gzipped.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
}

func buildZip(t *testing.T, path string, entries []tarEntry) {
	t.Helper()

	handle, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer handle.Close()

	archive := zip.NewWriter(handle)
	for _, entry := range entries {
		writer, err := archive.Create(entry.name)
		if err != nil {
			t.Fatalf("create zip member %q: %v", entry.name, err)
		}
		if _, err := writer.Write([]byte(entry.body)); err != nil {
			t.Fatalf("write zip member %q: %v", entry.name, err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
}

// assertNothingOutside walks the whole scratch area and fails on any file
// that is not under the destination. It is deliberately blunt: it does
// not care *how* the extractor handled a hostile member, only that the
// member did not end up somewhere it could be executed from.
func assertNothingOutside(t *testing.T, root, destination string) {
	t.Helper()

	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || current == root {
			return nil
		}
		if filepath.Ext(current) == ".tgz" || filepath.Ext(current) == ".zip" {
			return nil // the archive we built
		}
		relative, err := filepath.Rel(destination, current)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			t.Errorf("extraction wrote %s, which is outside the destination %s", current, destination)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}

func TestExtractTarKeepsHostileMembersInsideTheDestination(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "dest")
	source := filepath.Join(root, "payload.tgz")

	entries := make([]tarEntry, 0, len(hostileMembers))
	for _, name := range hostileMembers {
		entries = append(entries, tarEntry{name: name, body: "pwned\n"})
	}
	buildTarGz(t, source, entries)

	if err := os.MkdirAll(destination, defaultDirMode); err != nil {
		t.Fatalf("mkdir %s: %v", destination, err)
	}
	if _, err := extractTar(context.Background(), source, destination, true, func(string) error { return nil }); err != nil {
		t.Fatalf("extractTar: %v", err)
	}

	assertNothingOutside(t, root, destination)

	// Nothing may have been created beside the destination either, so the
	// classic landing spots are checked by name as well.
	for _, escaped := range []string{
		filepath.Join(root, "escaped.txt"),
		filepath.Join(filepath.Dir(root), "escaped.txt"),
		filepath.Join(root, "windows", "escaped.txt"),
	} {
		if _, err := os.Lstat(escaped); err == nil {
			t.Errorf("%s was written outside the destination", escaped)
		}
	}
}

func TestExtractZipKeepsHostileMembersInsideTheDestination(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "dest")
	source := filepath.Join(root, "payload.zip")

	entries := make([]tarEntry, 0, len(hostileMembers))
	for _, name := range hostileMembers {
		entries = append(entries, tarEntry{name: name, body: "pwned\n"})
	}
	buildZip(t, source, entries)

	if err := os.MkdirAll(destination, defaultDirMode); err != nil {
		t.Fatalf("mkdir %s: %v", destination, err)
	}
	if _, err := extractZip(context.Background(), source, destination, true, func(string) error { return nil }); err != nil {
		t.Fatalf("extractZip: %v", err)
	}

	assertNothingOutside(t, root, destination)

	for _, escaped := range []string{
		filepath.Join(root, "escaped.txt"),
		filepath.Join(filepath.Dir(root), "escaped.txt"),
		filepath.Join(root, "windows", "escaped.txt"),
	} {
		if _, err := os.Lstat(escaped); err == nil {
			t.Errorf("%s was written outside the destination", escaped)
		}
	}
}

// A symlink member is the second half of the attack: the link itself is
// harmless, and the regular member written *through* it a moment later is
// what lands on /etc. Refusing the link is the only place this can be
// stopped, because by the time the second member is opened the kernel has
// already followed it.
func TestExtractTarRefusesASymlinkThatLeavesTheDestination(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "dest")
	source := filepath.Join(root, "payload.tgz")

	buildTarGz(t, source, []tarEntry{
		{name: "pwn", linkname: "../../"},
		{name: "pwn/loot.txt", body: "owned\n"},
	})

	if err := os.MkdirAll(destination, defaultDirMode); err != nil {
		t.Fatalf("mkdir %s: %v", destination, err)
	}
	_, err := extractTar(context.Background(), source, destination, true, func(string) error { return nil })
	if err == nil {
		t.Fatal("a symlink member pointing out of the destination was accepted")
	}
	if !errors.Is(err, providers.ErrPermissionDenied) {
		t.Fatalf("the escaping link failed with %v, want a %v", err, providers.ErrPermissionDenied)
	}
	assertNothingOutside(t, root, destination)
}

func TestContainedPathClampsEveryMemberIntoTheDestination(t *testing.T) {
	const destination = "/var/www/uploads"

	cases := []struct {
		name string
		want string
	}{
		{"index.html", "/var/www/uploads/index.html"},
		{"a/b/c.txt", "/var/www/uploads/a/b/c.txt"},
		{"./a/./b.txt", "/var/www/uploads/a/b.txt"},
		// Every one of these is the same claim: whatever the member calls
		// itself, it resolves under the destination and nowhere else.
		{"../escaped.txt", "/var/www/uploads/escaped.txt"},
		{"../../../../etc/shadow", "/var/www/uploads/etc/shadow"},
		{"/etc/shadow", "/var/www/uploads/etc/shadow"},
		{"//etc//shadow", "/var/www/uploads/etc/shadow"},
		{"a/../../escaped.txt", "/var/www/uploads/escaped.txt"},
		{`..\escaped.txt`, "/var/www/uploads/escaped.txt"},
		{`..\..\..\windows\system32\drivers\etc\hosts`, "/var/www/uploads/windows/system32/drivers/etc/hosts"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := containedPath(destination, c.name)
			if err != nil {
				t.Fatalf("containedPath(%q) failed: %v", c.name, err)
			}
			if got != c.want {
				t.Fatalf("containedPath(%q) = %q, want %q", c.name, got, c.want)
			}
			if !within(got, destination) {
				t.Fatalf("containedPath(%q) = %q, which is outside %q", c.name, got, destination)
			}
		})
	}
}

func TestContainedPathRefusesANullByteInAMemberName(t *testing.T) {
	// A null byte truncates the name at whatever opens it, so the path
	// that was checked and the path that is created stop being the same.
	if _, err := containedPath("/var/www", "index.html\x00/../../etc/shadow"); !errors.Is(err, providers.ErrInvalidParams) {
		t.Fatalf("a member name with a null byte produced %v, want a %v", err, providers.ErrInvalidParams)
	}
}

func TestContainedLinkSeparatesLinksThatStayFromLinksThatLeave(t *testing.T) {
	const destination = "/var/www/uploads"

	cases := []struct {
		name     string
		member   string
		linkname string
		ok       bool
	}{
		{"sibling", "a/link", "b.txt", true},
		{"child", "link", "assets/logo.png", true},
		{"back up and in again", "a/b/link", "../../assets/logo.png", true},
		{"absolute but inside", "link", "/var/www/uploads/assets/logo.png", true},

		{"one level out", "link", "../escaped", false},
		{"far out", "a/b/link", "../../../../../../etc", false},
		{"out of the destination's parent", "link", "../../", false},
		{"absolute", "link", "/etc/shadow", false},
		{"absolute onto a sibling directory", "link", "/var/www/uploads-old", false},
		{"windows separators", "link", `..\..\escaped`, false},
		{"empty target", "link", "", false},
		{"null byte", "link", "assets\x00/../../etc", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := containedLink(destination, c.member, c.linkname)
			if c.ok && err != nil {
				t.Fatalf("containedLink(%q -> %q) was refused: %v", c.member, c.linkname, err)
			}
			if !c.ok && err == nil {
				t.Fatalf("containedLink(%q -> %q) was accepted", c.member, c.linkname)
			}
		})
	}
}

// A member whose header understates its size is how a zip bomb gets past
// a size check: the header says four bytes, the stream keeps coming.
func TestWriteMemberRefusesAMemberBiggerThanItsHeaderClaims(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "member.txt")
	const body = "this body is very much longer than four bytes"

	err := writeMember(target, strings.NewReader(body), 0o644, true, 4)
	if !errors.Is(err, providers.ErrPreconditionFailed) {
		t.Fatalf("an oversized member produced %v, want a %v", err, providers.ErrPreconditionFailed)
	}

	// On the managed host the partial file is unlinked outright. What holds
	// on any OS — and is the part that matters — is that a header which
	// lied never yields the member it was hiding.
	if raw, err := os.ReadFile(target); err == nil && string(raw) == body {
		t.Errorf("the oversized member was written to %s in full", target)
	}
}

func TestWriteMemberRefusesToOverwriteWhenNotAsked(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(target, []byte("original\n"), 0o644); err != nil {
		t.Fatalf("seed %s: %v", target, err)
	}

	err := writeMember(target, strings.NewReader("replacement"), 0o644, false, 11)
	if !errors.Is(err, providers.ErrConflict) {
		t.Fatalf("overwriting without permission produced %v, want a %v", err, providers.ErrConflict)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back %s: %v", target, err)
	}
	if string(raw) != "original\n" {
		t.Errorf("the existing file was modified: %q", raw)
	}
}
