//go:build linux

package linux

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Files.
 *
 * Every path is re-validated here even though the RPC layer already
 * checked it: the agent must not be walkable out of bounds by a control
 * plane that has been compromised. Writes are atomic (temp, fsync,
 * rename) so a crash never leaves a half-written config behind, and
 * archive extraction refuses any member that would land outside the
 * destination.
 * ------------------------------------------------------------------ */

const (
	// Transfers move in the contract's chunk size, so one read maps to
	// one frame.
	transferChunk = 256 << 10
	// A file larger than this is offered for download but never opened in
	// the panel's editor.
	editableLimit = 2 << 20
)

var editableExtensions = map[string]struct{}{
	".conf": {}, ".cfg": {}, ".ini": {}, ".json": {}, ".yaml": {}, ".yml": {},
	".toml": {}, ".env": {}, ".sh": {}, ".service": {}, ".txt": {}, ".md": {},
	".html": {}, ".css": {}, ".js": {}, ".ts": {}, ".py": {}, ".php": {},
	".sql": {}, ".log": {}, ".xml": {}, ".key": {}, ".pem": {}, ".crt": {},
}

type fileOps struct{ p *provider }

func (o fileOps) List(ctx context.Context, p providers.FsListParams) (providers.DirectoryListing, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.DirectoryListing{}, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return providers.DirectoryListing{}, wrapFsError(target, err)
	}

	listing := providers.DirectoryListing{Path: target, Entries: []providers.FileEntry{}}
	if target != "/" {
		listing.Parent = stringPtr(path.Dir(target))
	}

	limit := p.Limit
	if limit <= 0 {
		limit = 1000
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return listing, ctx.Err()
		}
		if !p.ShowHidden && strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		listing.Total++
		if len(listing.Entries) >= limit {
			listing.Truncated = true
			continue
		}
		child := path.Join(target, entry.Name())
		info, err := os.Lstat(child)
		if err != nil {
			continue
		}
		listing.Entries = append(listing.Entries, o.describe(child, info, false))
	}

	sortSlice(listing.Entries, func(a, b providers.FileEntry) bool {
		if (a.Kind == "directory") != (b.Kind == "directory") {
			return a.Kind == "directory"
		}
		return a.Name < b.Name
	})
	return listing, nil
}

func (o fileOps) Stat(ctx context.Context, target string) (providers.FileEntry, error) {
	cleaned, err := validatePath(target)
	if err != nil {
		return providers.FileEntry{}, err
	}
	info, err := os.Lstat(cleaned)
	if err != nil {
		return providers.FileEntry{}, wrapFsError(cleaned, err)
	}
	_ = ctx
	return o.describe(cleaned, info, true), nil
}

func (o fileOps) Read(ctx context.Context, p providers.FsReadParams) (providers.FsReadResult, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FsReadResult{}, err
	}

	info, err := os.Stat(target)
	if err != nil {
		return providers.FsReadResult{}, wrapFsError(target, err)
	}
	if info.IsDir() {
		return providers.FsReadResult{}, invalid("%s is a directory", target)
	}

	handle, err := os.Open(target)
	if err != nil {
		return providers.FsReadResult{}, wrapFsError(target, err)
	}
	defer handle.Close()

	limit := p.MaxBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	// Reading one byte past the cap is how truncation is detected without
	// a second stat that could race the writer.
	raw, err := io.ReadAll(io.LimitReader(handle, limit+1))
	if err != nil {
		return providers.FsReadResult{}, fmt.Errorf("read %s: %w", target, err)
	}

	result := providers.FsReadResult{Size: info.Size()}
	if int64(len(raw)) > limit {
		raw = raw[:limit]
		result.Truncated = true
	}
	if isTextual(raw) {
		result.Content, result.Encoding = string(raw), "utf8"
	} else {
		result.Content, result.Encoding = base64.StdEncoding.EncodeToString(raw), "base64"
	}
	_ = ctx
	return result, nil
}

func (o fileOps) Write(ctx context.Context, p providers.FsWriteParams) (providers.FileEntry, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}

	var payload []byte
	switch p.Encoding {
	case "base64":
		payload, err = base64.StdEncoding.DecodeString(p.Content)
		if err != nil {
			return providers.FileEntry{}, invalid("content is not valid base64")
		}
	default:
		payload = []byte(p.Content)
	}

	if p.CreateParents {
		if err := os.MkdirAll(path.Dir(target), defaultDirMode); err != nil {
			return providers.FileEntry{}, wrapFsError(path.Dir(target), err)
		}
	}

	mode := defaultFileMode
	if existing, err := os.Stat(target); err == nil {
		mode = existing.Mode().Perm()
	}
	if p.Mode != "" {
		if mode, err = parseMode(p.Mode); err != nil {
			return providers.FileEntry{}, err
		}
	}

	if err := writeAtomic(target, payload, mode); err != nil {
		return providers.FileEntry{}, wrapFsError(target, err)
	}
	return o.Stat(ctx, target)
}

func (o fileOps) Mkdir(ctx context.Context, p providers.FsMkdirParams) (providers.FileEntry, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}

	mode := defaultDirMode
	if p.Mode != "" {
		if mode, err = parseMode(p.Mode); err != nil {
			return providers.FileEntry{}, err
		}
	}

	if p.Parents {
		err = os.MkdirAll(target, mode)
	} else {
		err = os.Mkdir(target, mode)
	}
	if err != nil && !(p.Parents && errors.Is(err, fs.ErrExist)) {
		return providers.FileEntry{}, wrapFsError(target, err)
	}
	// MkdirAll honours umask on the leaf, so the requested mode is applied
	// explicitly rather than approximately.
	if err := os.Chmod(target, mode); err != nil {
		return providers.FileEntry{}, wrapFsError(target, err)
	}
	return o.Stat(ctx, target)
}

func (o fileOps) Move(ctx context.Context, p providers.FsMoveParams) (providers.FileEntry, error) {
	from, err := validatePath(p.From)
	if err != nil {
		return providers.FileEntry{}, err
	}
	to, err := validatePath(p.To)
	if err != nil {
		return providers.FileEntry{}, err
	}
	if err := ensureTarget(to, p.Overwrite); err != nil {
		return providers.FileEntry{}, err
	}

	if err := os.Rename(from, to); err != nil {
		// A rename across filesystems is refused by the kernel, so fall
		// back to copy-then-delete rather than reporting a failure.
		if !errors.Is(err, syscall.EXDEV) {
			return providers.FileEntry{}, wrapFsError(from, err)
		}
		if err := copyTree(ctx, from, to); err != nil {
			return providers.FileEntry{}, err
		}
		if err := os.RemoveAll(from); err != nil {
			return providers.FileEntry{}, wrapFsError(from, err)
		}
	}
	return o.Stat(ctx, to)
}

func (o fileOps) Copy(ctx context.Context, p providers.FsCopyParams) (providers.FileEntry, error) {
	from, err := validatePath(p.From)
	if err != nil {
		return providers.FileEntry{}, err
	}
	to, err := validatePath(p.To)
	if err != nil {
		return providers.FileEntry{}, err
	}
	if err := ensureTarget(to, p.Overwrite); err != nil {
		return providers.FileEntry{}, err
	}
	if within(to, from) {
		return providers.FileEntry{}, invalid("cannot copy %s into itself", from)
	}
	if err := copyTree(ctx, from, to); err != nil {
		return providers.FileEntry{}, err
	}
	return o.Stat(ctx, to)
}

func (o fileOps) Remove(ctx context.Context, p providers.FsRemoveParams) (int, error) {
	targets, err := validatePaths(p.Paths)
	if err != nil {
		return 0, err
	}

	removed := 0
	for _, target := range targets {
		if ctx.Err() != nil {
			return removed, ctx.Err()
		}
		info, err := os.Lstat(target)
		if err != nil {
			if isNotExist(err) {
				continue
			}
			return removed, wrapFsError(target, err)
		}

		if info.IsDir() {
			if !p.Recursive {
				return removed, fmt.Errorf("%s is a directory and recursive was not requested: %w", target, providers.ErrPreconditionFailed)
			}
			if _, protected := protectedRoots[target]; protected {
				return removed, fmt.Errorf("%s is protected from recursive deletion: %w", target, providers.ErrPermissionDenied)
			}
			count, err := countTree(target)
			if err != nil {
				return removed, err
			}
			if err := os.RemoveAll(target); err != nil {
				return removed, wrapFsError(target, err)
			}
			removed += count
			continue
		}

		if err := os.Remove(target); err != nil {
			return removed, wrapFsError(target, err)
		}
		removed++
	}
	return removed, nil
}

func (o fileOps) Chmod(ctx context.Context, p providers.FsChmodParams) error {
	targets, err := validatePaths(p.Paths)
	if err != nil {
		return err
	}
	mode, err := parseMode(p.Mode)
	if err != nil {
		return err
	}

	for _, target := range targets {
		if err := applyToTree(ctx, target, p.Recursive, func(current string) error {
			return os.Chmod(current, mode)
		}); err != nil {
			return err
		}
	}
	return nil
}

func (o fileOps) Chown(ctx context.Context, p providers.FsChownParams) error {
	targets, err := validatePaths(p.Paths)
	if err != nil {
		return err
	}

	uid, gid := -1, -1
	if p.Owner != "" {
		account, err := user.Lookup(p.Owner)
		if err != nil {
			return notFound("user %s", p.Owner)
		}
		uid, _ = strconv.Atoi(account.Uid)
	}
	if p.Group != "" {
		group, err := user.LookupGroup(p.Group)
		if err != nil {
			return notFound("group %s", p.Group)
		}
		gid, _ = strconv.Atoi(group.Gid)
	}

	for _, target := range targets {
		if err := applyToTree(ctx, target, p.Recursive, func(current string) error {
			// Lchown, so a symlink's own ownership changes rather than
			// silently retargeting whatever it points at.
			return os.Lchown(current, uid, gid)
		}); err != nil {
			return err
		}
	}
	return nil
}

func (o fileOps) Archive(ctx context.Context, p providers.FsArchiveParams, stream providers.Stream) (providers.FileEntry, error) {
	sources, err := validatePaths(p.Paths)
	if err != nil {
		return providers.FileEntry{}, err
	}
	destination, err := validatePath(p.Destination)
	if err != nil {
		return providers.FileEntry{}, err
	}

	switch p.Format {
	case "tar.gz", "zip":
	case "tar.zst":
		return providers.FileEntry{}, unsupported("tar.zst archives need a zstd encoder this build does not carry")
	default:
		return providers.FileEntry{}, invalid("format %q is not supported", p.Format)
	}

	handle, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, defaultFileMode)
	if err != nil {
		return providers.FileEntry{}, wrapFsError(destination, err)
	}
	defer handle.Close()

	progress := func(name string) error {
		if stream == nil {
			return nil
		}
		return stream.Send(ctx, []byte(name+"\n"), providers.EncodingUTF8)
	}

	if p.Format == "zip" {
		err = writeZip(ctx, handle, sources, progress)
	} else {
		err = writeTarGz(ctx, handle, sources, progress)
	}
	if err != nil {
		os.Remove(destination)
		return providers.FileEntry{}, err
	}
	if err := handle.Sync(); err != nil {
		return providers.FileEntry{}, fmt.Errorf("sync %s: %w", destination, err)
	}
	return o.Stat(ctx, destination)
}

func (o fileOps) Extract(ctx context.Context, p providers.FsExtractParams, stream providers.Stream) (int, error) {
	source, err := validatePath(p.Path)
	if err != nil {
		return 0, err
	}
	destination, err := validatePath(p.Destination)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(destination, defaultDirMode); err != nil {
		return 0, wrapFsError(destination, err)
	}

	progress := func(name string) error {
		if stream == nil {
			return nil
		}
		return stream.Send(ctx, []byte(name+"\n"), providers.EncodingUTF8)
	}

	lowered := strings.ToLower(source)
	switch {
	case strings.HasSuffix(lowered, ".zip"):
		return extractZip(ctx, source, destination, p.Overwrite, progress)
	case strings.HasSuffix(lowered, ".tar.gz"), strings.HasSuffix(lowered, ".tgz"), strings.HasSuffix(lowered, ".tar"):
		return extractTar(ctx, source, destination, p.Overwrite, progress)
	default:
		return 0, unsupported("cannot extract %s: only .tar, .tar.gz, .tgz and .zip are understood", filepath.Base(source))
	}
}

func (o fileOps) Download(ctx context.Context, p providers.FsDownloadParams, stream providers.Stream) (providers.FsDownloadResult, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FsDownloadResult{}, err
	}

	info, err := os.Stat(target)
	if err != nil {
		return providers.FsDownloadResult{}, wrapFsError(target, err)
	}
	if info.IsDir() {
		return providers.FsDownloadResult{}, invalid("%s is a directory; archive it first", target)
	}

	handle, err := os.Open(target)
	if err != nil {
		return providers.FsDownloadResult{}, wrapFsError(target, err)
	}
	defer handle.Close()

	buffer := make([]byte, transferChunk)
	sent := int64(0)
	for {
		if ctx.Err() != nil {
			return providers.FsDownloadResult{}, ctx.Err()
		}
		n, err := handle.Read(buffer)
		if n > 0 {
			if err := stream.Send(ctx, buffer[:n], providers.EncodingBase64); err != nil {
				return providers.FsDownloadResult{}, err
			}
			sent += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return providers.FsDownloadResult{}, fmt.Errorf("read %s: %w", target, err)
		}
	}
	return providers.FsDownloadResult{Size: sent, Mime: mimeType(target)}, nil
}

func (o fileOps) Upload(ctx context.Context, p providers.FsUploadParams, stream providers.Stream) (providers.FileEntry, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}
	if err := ensureTarget(target, p.Overwrite); err != nil {
		return providers.FileEntry{}, err
	}

	mode := defaultFileMode
	if p.Mode != "" {
		if mode, err = parseMode(p.Mode); err != nil {
			return providers.FileEntry{}, err
		}
	}

	dir := path.Dir(target)
	if err := os.MkdirAll(dir, defaultDirMode); err != nil {
		return providers.FileEntry{}, wrapFsError(dir, err)
	}

	temp, err := os.CreateTemp(dir, "."+path.Base(target)+".upload.*")
	if err != nil {
		return providers.FileEntry{}, wrapFsError(dir, err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	written := int64(0)
	for {
		chunk, err := stream.Recv(ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			temp.Close()
			return providers.FileEntry{}, err
		}
		if p.Size > 0 && written+int64(len(chunk)) > p.Size {
			temp.Close()
			return providers.FileEntry{}, fmt.Errorf("upload exceeded the declared size of %d bytes: %w", p.Size, providers.ErrPreconditionFailed)
		}
		if _, err := temp.Write(chunk); err != nil {
			temp.Close()
			return providers.FileEntry{}, fmt.Errorf("write %s: %w", tempName, err)
		}
		written += int64(len(chunk))
	}

	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return providers.FileEntry{}, fmt.Errorf("chmod %s: %w", tempName, err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return providers.FileEntry{}, fmt.Errorf("sync %s: %w", tempName, err)
	}
	if err := temp.Close(); err != nil {
		return providers.FileEntry{}, fmt.Errorf("close %s: %w", tempName, err)
	}
	if err := os.Rename(tempName, target); err != nil {
		return providers.FileEntry{}, wrapFsError(target, err)
	}
	if err := syncDir(dir); err != nil {
		return providers.FileEntry{}, err
	}
	return o.Stat(ctx, target)
}

func (o fileOps) Usage(ctx context.Context, p providers.FsUsageParams) (providers.FsUsageResult, error) {
	target, err := validatePath(p.Path)
	if err != nil {
		return providers.FsUsageResult{}, err
	}
	depth := p.Depth
	if depth <= 0 {
		depth = 1
	}

	info, err := os.Stat(target)
	if err != nil {
		return providers.FsUsageResult{}, wrapFsError(target, err)
	}
	if !info.IsDir() {
		return providers.FsUsageResult{
			Entries: []providers.StorageUsageEntry{{Path: target, Bytes: info.Size(), Kind: "directory"}},
			Total:   info.Size(),
		}, nil
	}

	mounts := map[string]struct{}{}
	if disks, err := collectDisks(ctx); err == nil {
		for _, d := range disks {
			mounts[d.Mount] = struct{}{}
		}
	}

	entries, total, err := o.walkUsage(ctx, target, depth, mounts)
	if err != nil {
		return providers.FsUsageResult{}, err
	}

	sortSlice(entries, func(a, b providers.StorageUsageEntry) bool { return a.Bytes > b.Bytes })
	return providers.FsUsageResult{Entries: entries, Total: total}, nil
}

// walkUsage reports every directory down to `depth` levels with its full
// recursive size. Depth bounds how many rows come back, never how much
// of the tree is measured — a breakdown whose figures stopped one level
// down would be worse than no breakdown.
func (o fileOps) walkUsage(ctx context.Context, dir string, depth int, mounts map[string]struct{}) ([]providers.StorageUsageEntry, int64, error) {
	entries := []providers.StorageUsageEntry{}
	total := int64(0)

	children, err := os.ReadDir(dir)
	if err != nil {
		return entries, 0, wrapFsError(dir, err)
	}

	for _, child := range children {
		if ctx.Err() != nil {
			return entries, total, ctx.Err()
		}
		full := path.Join(dir, child.Name())

		if !child.IsDir() {
			if info, err := child.Info(); err == nil {
				total += info.Size()
			}
			continue
		}

		bytes, inodes := treeSize(ctx, full)
		kind := "directory"
		if _, mounted := mounts[full]; mounted {
			kind = "mount"
		}
		entries = append(entries, providers.StorageUsageEntry{
			Path:   full,
			Bytes:  bytes,
			Inodes: int64Ptr(inodes),
			Kind:   kind,
			Label:  child.Name(),
		})
		total += bytes

		if depth > 1 {
			nested, _, err := o.walkUsage(ctx, full, depth-1, mounts)
			if err != nil {
				continue
			}
			entries = append(entries, nested...)
		}
	}
	return entries, total, nil
}

/* ------------------------------ describing --------------------------- */

func (o fileOps) describe(target string, info os.FileInfo, withChildren bool) providers.FileEntry {
	entry := providers.FileEntry{
		Name:       filepath.Base(target),
		Path:       target,
		Kind:       fileKind(info.Mode()),
		Size:       info.Size(),
		Mode:       fmt.Sprintf("%04o", info.Mode().Perm()),
		ModifiedAt: rfc3339(info.ModTime()),
	}

	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		entry.UID, entry.GID = int(stat.Uid), int(stat.Gid)
		entry.Owner = o.p.names.user(entry.UID)
		entry.Group = o.p.names.group(entry.GID)
	}
	if entry.Kind == "symlink" {
		if resolved, err := os.Readlink(target); err == nil {
			entry.LinkTarget = stringPtr(resolved)
		}
	}
	if entry.Kind == "file" {
		kind := mimeType(target)
		entry.Mime = stringPtr(kind)
		entry.IsEditable = info.Size() <= editableLimit && isEditableMime(kind, target)
	}
	if withChildren && entry.Kind == "directory" {
		if children, err := os.ReadDir(target); err == nil {
			count := len(children)
			entry.ChildCount = &count
		}
	}
	return entry
}

func fileKind(mode os.FileMode) string {
	switch {
	case mode&os.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "directory"
	case mode&os.ModeSocket != 0:
		return "socket"
	case mode&os.ModeNamedPipe != 0:
		return "fifo"
	case mode&(os.ModeDevice|os.ModeCharDevice) != 0:
		return "device"
	default:
		return "file"
	}
}

func mimeType(target string) string {
	if kind := mime.TypeByExtension(strings.ToLower(filepath.Ext(target))); kind != "" {
		return kind
	}
	if isTextFile(target) {
		return "text/plain"
	}
	return "application/octet-stream"
}

func isEditableMime(kind, target string) bool {
	if strings.HasPrefix(kind, "text/") {
		return true
	}
	if _, ok := editableExtensions[strings.ToLower(filepath.Ext(target))]; ok {
		return true
	}
	switch kind {
	case "application/json", "application/xml", "application/javascript", "application/x-sh":
		return true
	}
	return isTextFile(target)
}

// isTextFile samples the head of a file, which is the only reliable way
// to tell a config from a binary when the name carries no extension.
func isTextFile(target string) bool {
	handle, err := os.Open(target)
	if err != nil {
		return false
	}
	defer handle.Close()

	head := make([]byte, 1024)
	n, err := handle.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	return isTextual(head[:n])
}

func isTextual(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return utf8.Valid(data)
}

/* ------------------------------- archives ---------------------------- */

func writeTarGz(ctx context.Context, out io.Writer, sources []string, progress func(string) error) error {
	gzipped := gzip.NewWriter(out)
	defer gzipped.Close()
	archive := tar.NewWriter(gzipped)

	for _, source := range sources {
		base := path.Dir(source)
		err := filepath.WalkDir(source, func(current string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}

			link := ""
			if info.Mode()&os.ModeSymlink != 0 {
				if link, err = os.Readlink(current); err != nil {
					return err
				}
			}
			header, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return fmt.Errorf("describe %s: %w", current, err)
			}
			header.Name = strings.TrimPrefix(strings.TrimPrefix(current, base), "/")
			if header.Name == "" {
				header.Name = filepath.Base(current)
			}
			if err := archive.WriteHeader(header); err != nil {
				return fmt.Errorf("write header for %s: %w", current, err)
			}
			if err := progress(header.Name); err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}

			handle, err := os.Open(current)
			if err != nil {
				return wrapFsError(current, err)
			}
			defer handle.Close()
			if _, err := io.Copy(archive, handle); err != nil {
				return fmt.Errorf("archive %s: %w", current, err)
			}
			return nil
		})
		if err != nil {
			archive.Close()
			return err
		}
	}
	return archive.Close()
}

func writeZip(ctx context.Context, out io.Writer, sources []string, progress func(string) error) error {
	archive := zip.NewWriter(out)

	for _, source := range sources {
		base := path.Dir(source)
		err := filepath.WalkDir(source, func(current string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			// Zip has no symlink semantics worth relying on, so links are
			// skipped rather than stored as their (possibly huge) target.
			if info.Mode()&os.ModeSymlink != 0 {
				return nil
			}

			header, err := zip.FileInfoHeader(info)
			if err != nil {
				return fmt.Errorf("describe %s: %w", current, err)
			}
			header.Name = strings.TrimPrefix(strings.TrimPrefix(current, base), "/")
			if header.Name == "" {
				header.Name = filepath.Base(current)
			}
			if info.IsDir() {
				header.Name += "/"
			} else {
				header.Method = zip.Deflate
			}

			writer, err := archive.CreateHeader(header)
			if err != nil {
				return fmt.Errorf("write header for %s: %w", current, err)
			}
			if err := progress(header.Name); err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}

			handle, err := os.Open(current)
			if err != nil {
				return wrapFsError(current, err)
			}
			defer handle.Close()
			if _, err := io.Copy(writer, handle); err != nil {
				return fmt.Errorf("archive %s: %w", current, err)
			}
			return nil
		})
		if err != nil {
			archive.Close()
			return err
		}
	}
	return archive.Close()
}

/* -------------------------------- trees ------------------------------ */

func copyTree(ctx context.Context, from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return wrapFsError(from, err)
	}

	if !info.IsDir() {
		return copyOne(from, to, info)
	}
	return filepath.WalkDir(from, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		relative := strings.TrimPrefix(strings.TrimPrefix(current, from), "/")
		target := to
		if relative != "" {
			target = path.Join(to, relative)
		}

		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		return copyOne(current, target, info)
	})
}

func copyOne(from, to string, info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		resolved, err := os.Readlink(from)
		if err != nil {
			return wrapFsError(from, err)
		}
		os.Remove(to)
		return os.Symlink(resolved, to)
	}
	if !info.Mode().IsRegular() {
		// Sockets, fifos and devices are not copyable in any way the panel
		// means; skipping them beats failing the whole tree.
		return nil
	}

	source, err := os.Open(from)
	if err != nil {
		return wrapFsError(from, err)
	}
	defer source.Close()

	if err := os.MkdirAll(path.Dir(to), defaultDirMode); err != nil {
		return wrapFsError(path.Dir(to), err)
	}
	destination, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return wrapFsError(to, err)
	}
	defer destination.Close()

	if _, err := io.Copy(destination, source); err != nil {
		return fmt.Errorf("copy %s to %s: %w", from, to, err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		_ = os.Chown(to, int(stat.Uid), int(stat.Gid))
	}
	return os.Chtimes(to, time.Now(), info.ModTime())
}

func applyToTree(ctx context.Context, target string, recursive bool, apply func(string) error) error {
	if !recursive {
		if err := apply(target); err != nil {
			return wrapFsError(target, err)
		}
		return nil
	}
	if _, protected := protectedRoots[target]; protected {
		return fmt.Errorf("%s is protected from recursive changes: %w", target, providers.ErrPermissionDenied)
	}

	return filepath.WalkDir(target, func(current string, _ fs.DirEntry, err error) error {
		if err != nil {
			return wrapFsError(current, err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := apply(current); err != nil {
			return wrapFsError(current, err)
		}
		return nil
	})
}

func countTree(target string) (int, error) {
	count := 0
	err := filepath.WalkDir(target, func(_ string, _ fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		count++
		return nil
	})
	if err != nil {
		return 0, wrapFsError(target, err)
	}
	return count, nil
}

// treeSize sums a whole subtree. An entry that vanishes or cannot be
// read mid-walk is skipped: usage is a sample, not a transaction.
func treeSize(ctx context.Context, target string) (int64, int64) {
	var bytes, inodes int64

	_ = filepath.WalkDir(target, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		inodes++
		if entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			bytes += info.Size()
		}
		return nil
	})
	return bytes, inodes
}

/* ------------------------------ validation --------------------------- */

func ensureTarget(target string, overwrite bool) error {
	if overwrite {
		return nil
	}
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
	}
	return nil
}
