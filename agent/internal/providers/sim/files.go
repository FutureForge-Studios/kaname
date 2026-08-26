package sim

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The in-memory filesystem, plus the two things that live in it:
 * nginx virtual hosts and certificates.
 *
 * Writes persist for the life of the process, which is the point — the
 * file manager, the code editor, the terminal and `site.create` all see
 * the same tree, so editing a vhost in the editor really does change
 * what `site.list` reports.
 *
 * Every path is re-validated here even though the RPC layer already
 * checked it: a provider that trusts its caller is one compromised
 * caller away from being a file-disclosure bug.
 * ------------------------------------------------------------------ */

const (
	maxSymlinkDepth = 32
	editableLimit   = 2 * miB
	dirSize         = 4096
)

var errSymlinkLoop = errors.New("too many levels of symbolic links")

type node struct {
	name     string
	kind     string
	mode     string
	uid      int
	gid      int
	owner    string
	group    string
	modified time.Time
	data     []byte
	// virtual is the declared size of a file whose bytes we do not keep,
	// like a kernel image or a rotated journal.
	virtual  int64
	target   string
	children map[string]*node
}

func (n *node) size() int64 {
	switch n.kind {
	case "directory":
		return dirSize
	case "symlink":
		return int64(len(n.target))
	default:
		if n.virtual > int64(len(n.data)) {
			return n.virtual
		}
		return int64(len(n.data))
	}
}

type memfs struct {
	mu   sync.RWMutex
	root *node
	sim  *Sim
	// epoch anchors every seeded mtime so a fresh tree looks lived-in
	// rather than created a millisecond ago.
	epoch time.Time
}

func newMemFS(s *Sim) *memfs {
	epoch := time.Now().UTC().Add(-37 * 24 * time.Hour)
	return &memfs{
		sim:   s,
		epoch: epoch,
		root: &node{
			name: "/", kind: "directory", mode: "0755",
			owner: "root", group: "root", modified: epoch,
			children: map[string]*node{},
		},
	}
}

/* ------------------------------ seeding ------------------------------ */

func (f *memfs) dir(p string) { f.dirAs(p, "0755", "root", 0) }

func (f *memfs) dirAs(p, mode, owner string, uid int) {
	n := f.mkdirAllLocked(p)
	n.mode, n.owner, n.group, n.uid, n.gid = mode, owner, owner, uid, uid
}

func (f *memfs) file(p, content string) { f.fileAs(p, content, "0644", "root", 0) }

func (f *memfs) fileAs(p, content, mode, owner string, uid int) {
	parent := f.mkdirAllLocked(path.Dir(p))
	parent.children[path.Base(p)] = &node{
		name: path.Base(p), kind: "file", mode: mode,
		owner: owner, group: owner, uid: uid, gid: uid,
		modified: f.epoch.Add(time.Duration(mix(uint64(len(p)))%(20*24*3600)) * time.Second),
		data:     []byte(content),
	}
}

// blob is a file whose bytes are not worth keeping but whose size is:
// kernel images, rotated journals, database heaps.
func (f *memfs) blob(p string, size int64) {
	parent := f.mkdirAllLocked(path.Dir(p))
	parent.children[path.Base(p)] = &node{
		name: path.Base(p), kind: "file", mode: "0644",
		owner: "root", group: "root",
		modified: f.epoch.Add(time.Duration(mix(uint64(len(p))^0x5a)%(20*24*3600)) * time.Second),
		virtual:  size,
	}
}

func (f *memfs) link(p, target string) {
	parent := f.mkdirAllLocked(path.Dir(p))
	parent.children[path.Base(p)] = &node{
		name: path.Base(p), kind: "symlink", mode: "0777",
		owner: "root", group: "root", modified: f.epoch, target: target,
	}
}

func (f *memfs) mkdirAllLocked(p string) *node {
	cur := f.root
	for _, segment := range strings.Split(strings.Trim(path.Clean(p), "/"), "/") {
		if segment == "" || segment == "." {
			continue
		}
		child, ok := cur.children[segment]
		if !ok || child.kind != "directory" {
			child = &node{
				name: segment, kind: "directory", mode: "0755",
				owner: "root", group: "root", modified: f.epoch,
				children: map[string]*node{},
			}
			cur.children[segment] = child
		}
		cur = child
	}
	return cur
}

/* ----------------------------- resolution ---------------------------- */

// walk resolves a path, following symlinks on every intermediate
// component and on the final one when follow is set. Depth is bounded so
// a cycle fails loudly instead of hanging a request.
func (f *memfs) walk(p string, follow bool, depth int) (*node, string, error) {
	if depth > maxSymlinkDepth {
		return nil, "", errSymlinkLoop
	}

	cur, curPath := f.root, "/"
	segments := strings.Split(strings.Trim(path.Clean(p), "/"), "/")

	for i, segment := range segments {
		if segment == "" || segment == "." {
			continue
		}
		if cur.kind != "directory" {
			return nil, "", fmt.Errorf("%s: not a directory: %w", curPath, providers.ErrNotFound)
		}
		child, ok := cur.children[segment]
		if !ok {
			return nil, "", fmt.Errorf("%s: %w", path.Join(curPath, segment), providers.ErrNotFound)
		}

		last := i == len(segments)-1
		if child.kind == "symlink" && (!last || follow) {
			target := child.target
			if !strings.HasPrefix(target, "/") {
				target = path.Join(curPath, target)
			}
			rest := append([]string{path.Clean(target)}, segments[i+1:]...)
			return f.walk(path.Join(rest...), follow, depth+1)
		}

		cur, curPath = child, path.Join(curPath, segment)
	}
	return cur, curPath, nil
}

func (f *memfs) lookup(p string, follow bool) (*node, string, error) {
	return f.walk(p, follow, 0)
}

// parentOf resolves a path's directory, which is what every mutation
// needs before it can attach or detach a child.
func (f *memfs) parentOf(p string) (*node, error) {
	parent, _, err := f.walk(path.Dir(p), true, 0)
	if err != nil {
		return nil, err
	}
	if parent.kind != "directory" {
		return nil, fmt.Errorf("%s: not a directory: %w", path.Dir(p), providers.ErrInvalidParams)
	}
	return parent, nil
}

/* ------------------------------ entries ------------------------------ */

func (f *memfs) entry(n *node, p string) providers.FileEntry {
	e := providers.FileEntry{
		Name:       path.Base(p),
		Path:       p,
		Kind:       n.kind,
		Size:       n.size(),
		Mode:       n.mode,
		Owner:      n.owner,
		Group:      n.group,
		UID:        n.uid,
		GID:        n.gid,
		ModifiedAt: stamp(n.modified),
	}
	if p == "/" {
		e.Name = "/"
	}
	if n.kind == "symlink" {
		e.LinkTarget = ptr(n.target)
	}
	if n.kind == "directory" {
		e.ChildCount = ptr(len(n.children))
	}
	if n.kind == "file" {
		mime := mimeOf(e.Name)
		e.Mime = ptr(mime)
		e.IsEditable = e.Size <= editableLimit && n.virtual == 0 && isTextMime(mime)
	}
	return e
}

var mimeByExt = map[string]string{
	".html": "text/html", ".htm": "text/html", ".css": "text/css",
	".js": "application/javascript", ".mjs": "application/javascript",
	".json": "application/json", ".yml": "application/yaml", ".yaml": "application/yaml",
	".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain",
	".conf": "text/plain", ".cf": "text/plain", ".ini": "text/plain",
	".sh": "application/x-shellscript", ".php": "application/x-httpd-php",
	".py": "text/x-python", ".sql": "application/sql", ".env": "text/plain",
	".pem": "application/x-pem-file", ".key": "application/x-pem-file",
	".crt": "application/x-x509-ca-cert", ".png": "image/png", ".jpg": "image/jpeg",
	".svg": "image/svg+xml", ".ico": "image/vnd.microsoft.icon",
	".gz": "application/gzip", ".zst": "application/zstd", ".zip": "application/zip",
	".tar": "application/x-tar", ".deb": "application/vnd.debian.binary-package",
	".service": "text/plain", ".timer": "text/plain", ".socket": "text/plain",
}

func mimeOf(name string) string {
	if mime, ok := mimeByExt[strings.ToLower(path.Ext(name))]; ok {
		return mime
	}
	if !strings.Contains(name, ".") {
		return "text/plain"
	}
	return "application/octet-stream"
}

func isTextMime(mime string) bool {
	switch {
	case strings.HasPrefix(mime, "text/"):
		return true
	case mime == "application/json", mime == "application/yaml",
		mime == "application/javascript", mime == "application/sql",
		mime == "application/x-shellscript", mime == "application/x-httpd-php",
		mime == "application/x-pem-file":
		return true
	}
	return false
}

/* ------------------------------ accounting --------------------------- */

// accountBytes keeps the root filesystem gauge honest: writing a large
// file through the panel really does move the disk chart.
func (s *Sim) accountBytes(delta int64) { s.written.Add(delta) }

/* --------------------------- path validation ------------------------- */

// cleanPath re-validates a path agent-side. The RPC layer already did
// this; doing it again here means a provider is safe to call directly
// from a test or a future caller that forgets.
func cleanPath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("path is required: %w", providers.ErrInvalidParams)
	}
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("path may not contain a null byte: %w", providers.ErrInvalidParams)
	}
	if !strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("path must be absolute: %s: %w", p, providers.ErrInvalidParams)
	}
	for _, segment := range strings.Split(p, "/") {
		if segment == ".." {
			return "", fmt.Errorf("path may not traverse upwards: %s: %w", p, providers.ErrInvalidParams)
		}
	}
	return path.Clean(p), nil
}

func cleanPaths(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, p := range in {
		cleaned, err := cleanPath(p)
		if err != nil {
			return nil, err
		}
		out = append(out, cleaned)
	}
	return out, nil
}

/* -------------------------------- files ------------------------------ */

type simFiles struct{ *Sim }

func (s simFiles) List(_ context.Context, p providers.FsListParams) (providers.DirectoryListing, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.DirectoryListing{}, err
	}

	s.fs.mu.RLock()
	defer s.fs.mu.RUnlock()

	n, resolved, err := s.fs.lookup(target, true)
	if err != nil {
		return providers.DirectoryListing{}, err
	}
	if n.kind != "directory" {
		return providers.DirectoryListing{}, fmt.Errorf("%s is not a directory: %w", target, providers.ErrInvalidParams)
	}

	entries := make([]providers.FileEntry, 0, len(n.children))
	for name, child := range n.children {
		if !p.ShowHidden && strings.HasPrefix(name, ".") {
			continue
		}
		entries = append(entries, s.fs.entry(child, path.Join(resolved, name)))
	}
	sortEntries(entries)

	total := len(entries)
	truncated := false
	if p.Limit > 0 && len(entries) > p.Limit {
		entries, truncated = entries[:p.Limit], true
	}

	listing := providers.DirectoryListing{
		Path:      target,
		Entries:   entries,
		Truncated: truncated,
		Total:     total,
	}
	if target != "/" {
		listing.Parent = ptr(path.Dir(target))
	}
	return listing, nil
}

// sortEntries puts directories first and then sorts by name, which is
// the order a file manager has to render anyway.
func sortEntries(entries []providers.FileEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if (a.Kind == "directory") != (b.Kind == "directory") {
			return a.Kind == "directory"
		}
		return a.Name < b.Name
	})
}

func (s simFiles) Stat(_ context.Context, p string) (providers.FileEntry, error) {
	target, err := cleanPath(p)
	if err != nil {
		return providers.FileEntry{}, err
	}

	s.fs.mu.RLock()
	defer s.fs.mu.RUnlock()

	n, _, err := s.fs.lookup(target, false)
	if err != nil {
		return providers.FileEntry{}, err
	}
	return s.fs.entry(n, target), nil
}

func (s simFiles) Read(_ context.Context, p providers.FsReadParams) (providers.FsReadResult, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FsReadResult{}, err
	}

	s.fs.mu.RLock()
	defer s.fs.mu.RUnlock()

	n, _, err := s.fs.lookup(target, true)
	if err != nil {
		return providers.FsReadResult{}, err
	}
	if n.kind != "file" {
		return providers.FsReadResult{}, fmt.Errorf("%s is not a regular file: %w", target, providers.ErrInvalidParams)
	}

	data := n.data
	if n.virtual > int64(len(data)) {
		data = binaryFiller(target, n.virtual)
	}

	size := int64(len(data))
	truncated := false
	if p.MaxBytes > 0 && size > p.MaxBytes {
		data, truncated = data[:p.MaxBytes], true
	}

	if utf8.Valid(data) {
		return providers.FsReadResult{Content: string(data), Encoding: "utf8", Truncated: truncated, Size: n.size()}, nil
	}
	return providers.FsReadResult{
		Content:   base64.StdEncoding.EncodeToString(data),
		Encoding:  "base64",
		Truncated: truncated,
		Size:      n.size(),
	}, nil
}

// binaryFiller materialises a blob's bytes on demand so downloading a
// kernel image produces something of the right size and shape without
// the tree carrying megabytes of nothing.
func binaryFiller(p string, size int64) []byte {
	if size > 8*miB {
		size = 8 * miB
	}
	out := make([]byte, size)
	seed := mix(uint64(len(p)) ^ 0xb10b)
	for i := range out {
		if i%8 == 0 {
			seed = mix(seed)
		}
		out[i] = byte(seed >> (8 * (i % 8)))
	}
	return out
}

func (s simFiles) Write(_ context.Context, p providers.FsWriteParams) (providers.FileEntry, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}

	data := []byte(p.Content)
	if p.Encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(p.Content)
		if err != nil {
			return providers.FileEntry{}, fmt.Errorf("content is not valid base64: %w", providers.ErrInvalidParams)
		}
		data = decoded
	}

	mode := p.Mode
	if mode == "" {
		mode = "0644"
	}
	return s.writeFile(target, data, mode, p.CreateParents)
}

func (s *Sim) writeFile(target string, data []byte, mode string, createParents bool) (providers.FileEntry, error) {
	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	if createParents {
		s.fs.mkdirAllLocked(path.Dir(target))
	}
	parent, err := s.fs.parentOf(target)
	if err != nil {
		return providers.FileEntry{}, err
	}

	name := path.Base(target)
	existing := parent.children[name]
	if existing != nil && existing.kind == "directory" {
		return providers.FileEntry{}, fmt.Errorf("%s is a directory: %w", target, providers.ErrConflict)
	}

	var delta int64
	if existing != nil {
		delta -= existing.size()
	}
	delta += int64(len(data))
	s.accountBytes(delta)

	n := &node{
		name: name, kind: "file", mode: mode,
		owner: "root", group: "root",
		modified: time.Now().UTC(),
		data:     data,
	}
	if existing != nil {
		n.owner, n.group, n.uid, n.gid = existing.owner, existing.group, existing.uid, existing.gid
	}
	parent.children[name] = n

	return s.fs.entry(n, target), nil
}

func (s simFiles) Mkdir(_ context.Context, p providers.FsMkdirParams) (providers.FileEntry, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	if !p.Parents {
		if _, err := s.fs.parentOf(target); err != nil {
			return providers.FileEntry{}, err
		}
	}
	if existing, _, err := s.fs.lookup(target, false); err == nil {
		if existing.kind != "directory" {
			return providers.FileEntry{}, fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
		}
		return s.fs.entry(existing, target), nil
	}

	n := s.fs.mkdirAllLocked(target)
	n.modified = time.Now().UTC()
	if p.Mode != "" {
		n.mode = p.Mode
	}
	return s.fs.entry(n, target), nil
}

func (s simFiles) Move(_ context.Context, p providers.FsMoveParams) (providers.FileEntry, error) {
	from, err := cleanPath(p.From)
	if err != nil {
		return providers.FileEntry{}, err
	}
	to, err := cleanPath(p.To)
	if err != nil {
		return providers.FileEntry{}, err
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	source, err := s.fs.parentOf(from)
	if err != nil {
		return providers.FileEntry{}, err
	}
	n, ok := source.children[path.Base(from)]
	if !ok {
		return providers.FileEntry{}, fmt.Errorf("%s: %w", from, providers.ErrNotFound)
	}
	if from == "/" || strings.HasPrefix(to, from+"/") {
		return providers.FileEntry{}, fmt.Errorf("cannot move %s into itself: %w", from, providers.ErrInvalidParams)
	}

	target, err := s.fs.parentOf(to)
	if err != nil {
		return providers.FileEntry{}, err
	}
	name := path.Base(to)
	if existing, clash := target.children[name]; clash {
		if !p.Overwrite {
			return providers.FileEntry{}, fmt.Errorf("%s already exists: %w", to, providers.ErrConflict)
		}
		s.accountBytes(-treeSize(existing))
	}

	delete(source.children, path.Base(from))
	n.name = name
	n.modified = time.Now().UTC()
	target.children[name] = n

	return s.fs.entry(n, to), nil
}

func (s simFiles) Copy(_ context.Context, p providers.FsCopyParams) (providers.FileEntry, error) {
	from, err := cleanPath(p.From)
	if err != nil {
		return providers.FileEntry{}, err
	}
	to, err := cleanPath(p.To)
	if err != nil {
		return providers.FileEntry{}, err
	}
	if strings.HasPrefix(to, from+"/") {
		return providers.FileEntry{}, fmt.Errorf("cannot copy %s into itself: %w", from, providers.ErrInvalidParams)
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	n, _, err := s.fs.lookup(from, false)
	if err != nil {
		return providers.FileEntry{}, err
	}
	target, err := s.fs.parentOf(to)
	if err != nil {
		return providers.FileEntry{}, err
	}

	name := path.Base(to)
	if existing, clash := target.children[name]; clash {
		if !p.Overwrite {
			return providers.FileEntry{}, fmt.Errorf("%s already exists: %w", to, providers.ErrConflict)
		}
		s.accountBytes(-treeSize(existing))
	}

	clone := cloneNode(n, name)
	target.children[name] = clone
	s.accountBytes(treeSize(clone))

	return s.fs.entry(clone, to), nil
}

func cloneNode(n *node, name string) *node {
	out := *n
	out.name = name
	if n.data != nil {
		out.data = append([]byte(nil), n.data...)
	}
	if n.children != nil {
		out.children = make(map[string]*node, len(n.children))
		for childName, child := range n.children {
			out.children[childName] = cloneNode(child, childName)
		}
	}
	return &out
}

func treeSize(n *node) int64 {
	if n.kind != "directory" {
		return n.size()
	}
	var total int64
	for _, child := range n.children {
		total += treeSize(child)
	}
	return total
}

func (s simFiles) Remove(_ context.Context, p providers.FsRemoveParams) (int, error) {
	targets, err := cleanPaths(p.Paths)
	if err != nil {
		return 0, err
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	removed := 0
	for _, target := range targets {
		if target == "/" {
			return removed, fmt.Errorf("refusing to remove /: %w", providers.ErrPermissionDenied)
		}
		parent, err := s.fs.parentOf(target)
		if err != nil {
			return removed, err
		}
		name := path.Base(target)
		n, ok := parent.children[name]
		if !ok {
			return removed, fmt.Errorf("%s: %w", target, providers.ErrNotFound)
		}
		if n.kind == "directory" && len(n.children) > 0 && !p.Recursive {
			return removed, fmt.Errorf("%s is not empty: %w", target, providers.ErrConflict)
		}

		s.accountBytes(-treeSize(n))
		delete(parent.children, name)
		removed += countNodes(n)
	}
	return removed, nil
}

func countNodes(n *node) int {
	if n.kind != "directory" {
		return 1
	}
	total := 1
	for _, child := range n.children {
		total += countNodes(child)
	}
	return total
}

func (s simFiles) Chmod(_ context.Context, p providers.FsChmodParams) error {
	targets, err := cleanPaths(p.Paths)
	if err != nil {
		return err
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	for _, target := range targets {
		n, _, err := s.fs.lookup(target, false)
		if err != nil {
			return err
		}
		applyRecursive(n, p.Recursive, func(x *node) { x.mode = p.Mode })
	}
	return nil
}

func (s simFiles) Chown(_ context.Context, p providers.FsChownParams) error {
	targets, err := cleanPaths(p.Paths)
	if err != nil {
		return err
	}

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	for _, target := range targets {
		n, _, err := s.fs.lookup(target, false)
		if err != nil {
			return err
		}
		applyRecursive(n, p.Recursive, func(x *node) {
			if p.Owner != "" {
				x.owner, x.uid = p.Owner, uidFor(p.Owner)
			}
			if p.Group != "" {
				x.group, x.gid = p.Group, uidFor(p.Group)
			}
		})
	}
	return nil
}

func applyRecursive(n *node, recursive bool, apply func(*node)) {
	apply(n)
	if !recursive || n.kind != "directory" {
		return
	}
	for _, child := range n.children {
		applyRecursive(child, true, apply)
	}
}

// uidFor keeps the same name mapping to the same id for the life of the
// process, which is all a listing needs to look coherent.
func uidFor(name string) int {
	switch name {
	case "root":
		return 0
	case "www-data":
		return 33
	case "postgres":
		return 108
	case "mysql":
		return 110
	case "postfix":
		return 111
	case "vmail":
		return 5000
	case "deploy":
		return 1000
	}
	return 1000 + int(mix(uint64(len(name))^hashString(name))%4000)
}

func (s simFiles) Archive(ctx context.Context, p providers.FsArchiveParams, stream providers.Stream) (providers.FileEntry, error) {
	sources, err := cleanPaths(p.Paths)
	if err != nil {
		return providers.FileEntry{}, err
	}
	destination, err := cleanPath(p.Destination)
	if err != nil {
		return providers.FileEntry{}, err
	}

	s.fs.mu.RLock()
	var raw int64
	var files int
	for _, source := range sources {
		n, _, err := s.fs.lookup(source, true)
		if err != nil {
			s.fs.mu.RUnlock()
			return providers.FileEntry{}, err
		}
		raw += treeSize(n)
		files += countNodes(n)
	}
	s.fs.mu.RUnlock()

	if err := progress(ctx, stream, 0, "creating %s (%s)", destination, p.Format); err != nil {
		return providers.FileEntry{}, err
	}
	for _, source := range sources {
		if err := progress(ctx, stream, 90*time.Millisecond, "adding: %s", source); err != nil {
			return providers.FileEntry{}, err
		}
	}

	// Compression ratios differ enough between formats that reporting one
	// number for all three would look wrong next to the real thing.
	ratio := map[string]float64{"tar.gz": 0.38, "tar.zst": 0.31, "zip": 0.44}[p.Format]
	if ratio == 0 {
		ratio = 0.4
	}
	compressed := int64(float64(raw) * ratio)

	s.fs.mu.Lock()
	parent := s.fs.mkdirAllLocked(path.Dir(destination))
	name := path.Base(destination)
	n := &node{
		name: name, kind: "file", mode: "0644",
		owner: "root", group: "root", modified: time.Now().UTC(),
		virtual: compressed,
	}
	parent.children[name] = n
	entry := s.fs.entry(n, destination)
	s.fs.mu.Unlock()
	s.accountBytes(compressed)

	_ = progress(ctx, stream, 0, "wrote %s (%d files, %d bytes)", destination, files, compressed)
	return entry, nil
}

func (s simFiles) Extract(ctx context.Context, p providers.FsExtractParams, stream providers.Stream) (int, error) {
	source, err := cleanPath(p.Path)
	if err != nil {
		return 0, err
	}
	destination, err := cleanPath(p.Destination)
	if err != nil {
		return 0, err
	}

	s.fs.mu.RLock()
	archive, _, err := s.fs.lookup(source, true)
	s.fs.mu.RUnlock()
	if err != nil {
		return 0, err
	}
	if archive.kind != "file" {
		return 0, fmt.Errorf("%s is not an archive: %w", source, providers.ErrInvalidParams)
	}

	base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(path.Base(source), ".gz"), ".zst"), ".tar")
	base = strings.TrimSuffix(base, ".zip")
	members := []string{
		base + "/",
		base + "/README.md",
		base + "/index.html",
		base + "/assets/app.css",
		base + "/assets/app.js",
	}

	if err := progress(ctx, stream, 0, "extracting %s into %s", source, destination); err != nil {
		return 0, err
	}

	extracted := 0
	for _, member := range members {
		target := path.Join(destination, member)
		if err := progress(ctx, stream, 70*time.Millisecond, "  inflating: %s", target); err != nil {
			return extracted, err
		}

		s.fs.mu.Lock()
		if strings.HasSuffix(member, "/") {
			s.fs.mkdirAllLocked(target)
		} else {
			if _, clash, _ := s.fs.lookup(target, false); clash != "" && !p.Overwrite {
				s.fs.mu.Unlock()
				return extracted, fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
			}
			s.fs.mkdirAllLocked(path.Dir(target))
			parent, _ := s.fs.parentOf(target)
			content := fmt.Sprintf("extracted from %s\n", path.Base(source))
			parent.children[path.Base(target)] = &node{
				name: path.Base(target), kind: "file", mode: "0644",
				owner: "root", group: "root", modified: time.Now().UTC(),
				data: []byte(content),
			}
			s.accountBytes(int64(len(content)))
		}
		s.fs.mu.Unlock()
		extracted++
	}

	_ = progress(ctx, stream, 0, "extracted %d entries", extracted)
	return extracted, nil
}

func (s simFiles) Download(ctx context.Context, p providers.FsDownloadParams, stream providers.Stream) (providers.FsDownloadResult, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FsDownloadResult{}, err
	}

	s.fs.mu.RLock()
	n, _, err := s.fs.lookup(target, true)
	if err != nil {
		s.fs.mu.RUnlock()
		return providers.FsDownloadResult{}, err
	}
	if n.kind != "file" {
		s.fs.mu.RUnlock()
		return providers.FsDownloadResult{}, fmt.Errorf("%s is not a regular file: %w", target, providers.ErrInvalidParams)
	}
	data := n.data
	if n.virtual > int64(len(data)) {
		data = binaryFiller(target, n.virtual)
	}
	payload := append([]byte(nil), data...)
	s.fs.mu.RUnlock()

	const window = 64 * 1024
	for offset := 0; offset < len(payload); offset += window {
		end := min(offset+window, len(payload))
		if err := stream.Send(ctx, payload[offset:end], providers.EncodingBase64); err != nil {
			return providers.FsDownloadResult{}, fmt.Errorf("stream %s: %w", target, err)
		}
	}

	return providers.FsDownloadResult{Size: int64(len(payload)), Mime: mimeOf(path.Base(target))}, nil
}

func (s simFiles) Upload(ctx context.Context, p providers.FsUploadParams, stream providers.Stream) (providers.FileEntry, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FileEntry{}, err
	}

	s.fs.mu.RLock()
	_, existing, _ := s.fs.lookup(target, false)
	s.fs.mu.RUnlock()
	if existing != "" && !p.Overwrite {
		return providers.FileEntry{}, fmt.Errorf("%s already exists: %w", target, providers.ErrConflict)
	}

	var buffer []byte
	for {
		chunk, err := stream.Recv(ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return providers.FileEntry{}, fmt.Errorf("receive upload for %s: %w", target, err)
		}
		buffer = append(buffer, chunk...)
		if int64(len(buffer)) > p.Size && p.Size > 0 {
			return providers.FileEntry{}, fmt.Errorf("upload exceeded the declared %d bytes: %w", p.Size, providers.ErrInvalidParams)
		}
	}

	mode := p.Mode
	if mode == "" {
		mode = "0644"
	}
	return s.writeFile(target, buffer, mode, true)
}

func (s simFiles) Usage(_ context.Context, p providers.FsUsageParams) (providers.FsUsageResult, error) {
	target, err := cleanPath(p.Path)
	if err != nil {
		return providers.FsUsageResult{}, err
	}

	s.fs.mu.RLock()
	defer s.fs.mu.RUnlock()

	root, resolved, err := s.fs.lookup(target, true)
	if err != nil {
		return providers.FsUsageResult{}, err
	}

	mounts := map[string]bool{}
	for _, disk := range s.id.disks {
		mounts[disk.mount] = true
	}

	entries := []providers.StorageUsageEntry{}
	collect(root, resolved, 1, p.Depth, mounts, &entries)
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Bytes > entries[j].Bytes })

	return providers.FsUsageResult{Entries: entries, Total: treeSize(root)}, nil
}

func collect(n *node, at string, depth, maxDepth int, mounts map[string]bool, out *[]providers.StorageUsageEntry) {
	if n.kind != "directory" || depth > maxDepth {
		return
	}
	for name, child := range n.children {
		childPath := path.Join(at, name)
		kind := "directory"
		if mounts[childPath] {
			kind = "mount"
		} else if child.kind != "directory" {
			kind = "category"
		}
		*out = append(*out, providers.StorageUsageEntry{
			Path:   childPath,
			Bytes:  treeSize(child),
			Inodes: ptr(int64(countNodes(child))),
			Kind:   kind,
		})
		collect(child, childPath, depth+1, maxDepth, mounts, out)
	}
}

/* ---------------------------- the host tree -------------------------- */

// buildFilesystem lays out a believable Debian host. It is deliberately
// wide rather than deep: the file manager, the terminal and the editor
// all want somewhere real to go.
func buildFilesystem(s *Sim) *memfs {
	f := newMemFS(s)
	id := s.id
	short := strings.SplitN(id.hostname, ".", 2)[0]

	for _, d := range []string{
		"/boot", "/dev", "/etc", "/home", "/media", "/mnt", "/opt", "/proc",
		"/root", "/run", "/srv", "/sys", "/tmp", "/usr", "/var", "/lost+found",
	} {
		f.dir(d)
	}
	f.dirAs("/root", "0700", "root", 0)
	f.dirAs("/tmp", "1777", "root", 0)

	f.link("/bin", "usr/bin")
	f.link("/sbin", "usr/sbin")
	f.link("/lib", "usr/lib")

	/* --------------------------- /boot ---------------------------- */
	f.blob("/boot/vmlinuz-6.1.0-18-amd64", 8_284_672)
	f.blob("/boot/initrd.img-6.1.0-18-amd64", 42_118_912)
	f.blob("/boot/System.map-6.1.0-18-amd64", 5_412_336)
	f.file("/boot/config-6.1.0-18-amd64", "CONFIG_LOCALVERSION=\"-18-amd64\"\nCONFIG_64BIT=y\nCONFIG_X86_64=y\nCONFIG_SMP=y\n")
	f.file("/boot/grub/grub.cfg", "set default=\"0\"\nset timeout=5\n\nmenuentry 'Debian GNU/Linux' {\n\tlinux /boot/vmlinuz-6.1.0-18-amd64 root=/dev/vda1 ro quiet\n\tinitrd /boot/initrd.img-6.1.0-18-amd64\n}\n")

	/* ---------------------------- /etc ---------------------------- */
	f.file("/etc/os-release", "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\nVERSION=\"12 (bookworm)\"\nVERSION_CODENAME=bookworm\nID=debian\nHOME_URL=\"https://www.debian.org/\"\nSUPPORT_URL=\"https://www.debian.org/support\"\nBUG_REPORT_URL=\"https://bugs.debian.org/\"\n")
	f.file("/etc/hostname", short+"\n")
	f.file("/etc/hosts", fmt.Sprintf("127.0.0.1\tlocalhost\n127.0.1.1\t%s %s\n%s\t%s\n\n::1\tlocalhost ip6-localhost ip6-loopback\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n", id.hostname, short, id.privateIP, id.hostname))
	f.file("/etc/machine-id", id.machineID+"\n")
	f.file("/etc/timezone", id.timezone+"\n")
	f.file("/etc/resolv.conf", "nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch kaname.internal\n")
	f.file("/etc/fstab", "# /etc/fstab: static file system information.\nUUID=9f2c1b70-4d5e-4b21-9c0a-2f1a7e6d4c33 /               ext4    errors=remount-ro 0 1\nUUID=1a4d-9C2E                            /boot           ext4    defaults          0 2\nUUID=c81f9a5d-3e7b-4f10-8a26-5d9e0c4b7a12 /srv            xfs     defaults,noatime  0 2\nUUID=7b3e2c41-8f6a-4d09-b52c-16e8d3f0a945 /var/lib/docker ext4    defaults          0 2\n/dev/vda3                                 none            swap    sw                0 0\n")
	f.file("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nsys:x:3:3:sys:/dev:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nmessagebus:x:100:107::/nonexistent:/usr/sbin/nologin\nsshd:x:104:65534::/run/sshd:/usr/sbin/nologin\npostgres:x:108:117:PostgreSQL administrator,,,:/var/lib/postgresql:/bin/bash\nmysql:x:110:120:MariaDB Server,,,:/nonexistent:/bin/false\npostfix:x:111:121::/var/spool/postfix:/usr/sbin/nologin\ndovecot:x:112:122:Dovecot mail server,,,:/usr/lib/dovecot:/usr/sbin/nologin\ndovenull:x:113:123:Dovecot login user,,,:/nonexistent:/usr/sbin/nologin\nopendkim:x:114:124::/run/opendkim:/usr/sbin/nologin\nvmail:x:5000:5000:Virtual mail,,,:/var/vmail:/usr/sbin/nologin\ndeploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash\nalice:x:1001:1001:Alice Nakamura,,,:/home/alice:/bin/bash\n")
	f.file("/etc/group", "root:x:0:\nadm:x:4:deploy,alice\nsudo:x:27:deploy\nwww-data:x:33:deploy\nshadow:x:42:\ndocker:x:998:deploy\ndeploy:x:1000:\nalice:x:1001:\nvmail:x:5000:\n")
	// The hashes are placeholders on purpose: nothing in a simulated host
	// should ever look like a credential worth trying somewhere else.
	f.fileAs("/etc/shadow", "root:*:19800:0:99999:7:::\ndaemon:*:19800:0:99999:7:::\nwww-data:*:19800:0:99999:7:::\ndeploy:!:19850:0:99999:7:::\nalice:!:19851:0:99999:7:::\n", "0640", "root", 0)
	f.file("/etc/crontab", "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || run-parts --report /etc/cron.daily\n12 3\t* * *\tdeploy\t/usr/local/bin/kaname-nightly.sh >/dev/null 2>&1\n")
	f.file("/etc/sudoers", "Defaults\tenv_reset\nDefaults\tsecure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"\n\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n")
	f.file("/etc/apt/sources.list", "deb http://deb.debian.org/debian bookworm main contrib non-free-firmware\ndeb http://deb.debian.org/debian bookworm-updates main contrib non-free-firmware\ndeb http://security.debian.org/debian-security bookworm-security main contrib non-free-firmware\n")
	f.file("/etc/apt/sources.list.d/docker.list", "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n")

	f.file("/etc/nginx/nginx.conf", nginxMainConfig)
	f.dir("/etc/nginx/conf.d")
	f.dir("/etc/nginx/sites-available")
	f.dir("/etc/nginx/sites-enabled")
	f.file("/etc/nginx/snippets/ssl-params.conf", "ssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;\nssl_session_cache shared:SSL:10m;\nssl_session_timeout 1d;\nadd_header Strict-Transport-Security \"max-age=63072000\" always;\n")
	f.blob("/etc/nginx/mime.types", 5_349)

	f.file("/etc/ssh/sshd_config", sshdConfigFile)
	f.file("/etc/ssh/ssh_host_ed25519_key.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1sIm9kQ2Fq7Rr0dY6vQ3sT8xN4mZ5wLpCe2hUjKt0F root@"+id.hostname+"\n")
	f.fileAs("/etc/ssh/ssh_host_ed25519_key", "-----BEGIN OPENSSH PRIVATE KEY-----\n(simulated host key; no key material is kept)\n-----END OPENSSH PRIVATE KEY-----\n", "0600", "root", 0)

	f.file("/etc/postfix/main.cf", postfixMainConfig(id))
	f.file("/etc/postfix/master.cf", "smtp       inet  n       -       y       -       -       smtpd\nsubmission inet  n       -       y       -       -       smtpd\n  -o syslog_name=postfix/submission\n  -o smtpd_tls_security_level=encrypt\npickup     unix  n       -       y       60      1       pickup\nqmgr       unix  n       -       n       300     1       qmgr\ncleanup    unix  n       -       y       -       0       cleanup\nlocal      unix  -       n       n       -       -       local\n")
	f.file("/etc/postfix/aliases", "postmaster: root\nroot: ops@"+id.mailDomain+"\nabuse: postmaster\n")
	f.file("/etc/dovecot/dovecot.conf", "protocols = imap lmtp\nlisten = *, ::\nmail_location = maildir:/var/vmail/%d/%n\n!include conf.d/*.conf\n")
	f.file("/etc/dovecot/conf.d/10-mail.conf", "mail_location = maildir:/var/vmail/%d/%n\nnamespace inbox {\n  inbox = yes\n}\nmail_uid = vmail\nmail_gid = vmail\n")
	f.file("/etc/dovecot/conf.d/10-auth.conf", "disable_plaintext_auth = yes\nauth_mechanisms = plain login\n!include auth-passwdfile.conf.ext\n")
	f.file("/etc/opendkim.conf", "Syslog\t\t\tyes\nUMask\t\t\t007\nCanonicalization\trelaxed/simple\nMode\t\t\tsv\nSubDomains\t\tno\nKeyTable\t\t/etc/opendkim/key.table\nSigningTable\t\trefile:/etc/opendkim/signing.table\n")

	f.file("/etc/postgresql/16/main/postgresql.conf", "data_directory = '/var/lib/postgresql/16/main'\nhba_file = '/etc/postgresql/16/main/pg_hba.conf'\nport = 5432\nmax_connections = 100\nshared_buffers = 512MB\nwork_mem = 8MB\nwal_level = replica\nlog_line_prefix = '%m [%p] %q%u@%d '\n")
	f.file("/etc/postgresql/16/main/pg_hba.conf", "local   all             postgres                                peer\nlocal   all             all                                     scram-sha-256\nhost    all             all             127.0.0.1/32            scram-sha-256\nhost    all             all             ::1/128                 scram-sha-256\n")
	f.file("/etc/mysql/mariadb.conf.d/50-server.cnf", "[mysqld]\nbind-address = 127.0.0.1\nmax_connections = 151\ninnodb_buffer_pool_size = 512M\ncharacter-set-server = utf8mb4\ncollation-server = utf8mb4_general_ci\n")

	f.file("/etc/nftables.conf", nftablesConfig)
	f.file("/etc/fail2ban/jail.local", "[DEFAULT]\nbantime  = 1h\nfindtime = 10m\nmaxretry = 5\nbackend  = systemd\n\n[sshd]\nenabled = true\n\n[nginx-http-auth]\nenabled = true\n\n[postfix-sasl]\nenabled = true\n")
	f.file("/etc/logrotate.d/nginx", "/var/log/nginx/*.log {\n\tdaily\n\tmissingok\n\trotate 14\n\tcompress\n\tdelaycompress\n\tnotifempty\n\tcreate 0640 www-data adm\n}\n")
	f.file("/etc/systemd/system/kanamed.service", "[Unit]\nDescription=Kaname agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/kanamed run\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n")
	f.dir("/etc/letsencrypt/live")
	f.dir("/etc/letsencrypt/archive")
	f.fileAs("/etc/kaname/agent.env", "KANAME_URL=https://panel.kaname.internal\nKANAME_LOG_LEVEL=info\n", "0640", "root", 0)

	/* --------------------------- /home ---------------------------- */
	for _, account := range []struct {
		name string
		uid  int
	}{{"deploy", 1000}, {"alice", 1001}} {
		home := "/home/" + account.name
		f.dirAs(home, "0750", account.name, account.uid)
		f.fileAs(home+"/.bashrc", "# ~/.bashrc\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nexport PS1='\\u@\\h:\\w\\$ '\nalias ll='ls -alF'\n", "0644", account.name, account.uid)
		f.fileAs(home+"/.profile", "if [ -n \"$BASH_VERSION\" ] && [ -f \"$HOME/.bashrc\" ]; then\n\t. \"$HOME/.bashrc\"\nfi\nPATH=\"$HOME/.local/bin:$PATH\"\n", "0644", account.name, account.uid)
		f.dirAs(home+"/.ssh", "0700", account.name, account.uid)
		f.fileAs(home+"/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC7yQ4pXvR2mK9dLwB6nT1sZ0hEaJ3fUgMxOiPqV8rYd "+account.name+"@workstation\n", "0600", account.name, account.uid)
	}
	f.dirAs("/home/deploy/projects/storefront", "0755", "deploy", 1000)
	f.fileAs("/home/deploy/projects/storefront/README.md", "# storefront\n\nDeployed to /var/www/example.com by the nightly job.\n\n    pnpm install\n    pnpm build\n", "0644", "deploy", 1000)
	f.fileAs("/home/deploy/projects/storefront/package.json", "{\n  \"name\": \"storefront\",\n  \"version\": \"2.4.1\",\n  \"private\": true,\n  \"scripts\": {\n    \"build\": \"vite build\",\n    \"dev\": \"vite\"\n  }\n}\n", "0644", "deploy", 1000)
	f.fileAs("/home/deploy/deploy.sh", "#!/bin/sh\nset -eu\ncd /home/deploy/projects/storefront\ngit pull --ff-only\npnpm install --frozen-lockfile\npnpm build\nrsync -a --delete dist/ /var/www/example.com/public/\nsystemctl reload nginx\n", "0755", "deploy", 1000)

	f.fileAs("/root/.bashrc", "export PS1='\\[\\e[1;31m\\]\\u@\\h\\[\\e[0m\\]:\\w# '\nalias ll='ls -alF'\nalias la='ls -A'\n", "0644", "root", 0)
	f.fileAs("/root/.profile", ". \"$HOME/.bashrc\"\n", "0644", "root", 0)
	f.dirAs("/root/.ssh", "0700", "root", 0)
	f.fileAs("/root/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFq8xJ2vZ9nR0dTgY6mC1sL4pW7hB3eKuQaXrN5tOiVd ops@kaname\n", "0600", "root", 0)

	/* ---------------------------- /var ---------------------------- */
	f.dir("/var/backups")
	f.blob("/var/backups/apt.extended_states.0", 62_118)
	f.dirAs("/var/www", "0755", "www-data", 33)
	f.dir("/var/lib/docker/containers")
	f.dir("/var/lib/docker/overlay2")
	f.dirAs("/var/lib/postgresql/16/main", "0700", "postgres", 108)
	f.blob("/var/lib/postgresql/16/main/pg_wal", 402_653_184)
	f.dirAs("/var/lib/mysql", "0700", "mysql", 110)
	f.blob("/var/lib/mysql/ibdata1", 79_691_776)
	f.dirAs("/var/vmail", "0770", "vmail", 5000)
	f.dirAs("/var/spool/postfix", "0755", "postfix", 111)
	f.dir("/var/spool/cron/crontabs")
	f.dir("/var/cache/apt/archives")

	f.blob("/var/log/syslog", 18_432_112)
	f.blob("/var/log/syslog.1", 41_119_744)
	f.blob("/var/log/auth.log", 2_884_213)
	f.blob("/var/log/mail.log", 9_442_881)
	f.blob("/var/log/dpkg.log", 1_204_338)
	f.blob("/var/log/kern.log", 3_918_204)
	f.dirAs("/var/log/nginx", "0750", "www-data", 33)
	f.blob("/var/log/nginx/access.log", 214_884_112)
	f.blob("/var/log/nginx/error.log", 4_118_223)
	f.blob("/var/log/nginx/access.log.1", 188_291_072)
	f.blob("/var/log/journal/"+id.machineID+"/system.journal", 117_440_512)
	f.blob("/var/log/journal/"+id.machineID+"/user-1000.journal", 8_388_608)

	/* ---------------------------- /srv ---------------------------- */
	f.dir("/srv/minio/kaname-backups")
	f.dir("/srv/uptime-kuma")
	f.dir("/srv/n8n")
	f.blob("/srv/backups/kaname-2026-08-25.tar.zst", 4_294_967_296)

	/* ---------------------------- /usr ---------------------------- */
	f.dir("/usr/local/bin")
	f.dir("/usr/share/nginx")
	for name, size := range map[string]int64{
		"bash": 1_265_648, "cat": 43_936, "ls": 142_144, "grep": 199_720,
		"sed": 129_768, "awk": 694_320, "tar": 499_072, "curl": 253_616,
		"git": 3_723_048, "psql": 727_800, "systemctl": 1_035_896,
		"journalctl": 92_312, "docker": 65_339_392, "python3": 7_968, "node": 92_450_816,
	} {
		f.blob("/usr/bin/"+name, size)
	}
	for name, size := range map[string]int64{
		"sshd": 924_120, "nginx": 1_285_680, "postfix": 178_432, "dovecot": 512_296,
		"nft": 226_808, "cron": 55_824, "service": 9_136,
	} {
		f.blob("/usr/sbin/"+name, size)
	}
	f.blob("/usr/local/bin/kanamed", 12_582_912)
	f.fileAs("/usr/local/bin/kaname-nightly.sh", "#!/bin/sh\nset -eu\n/usr/local/bin/kanamed version\nrestic backup /var/www /etc --tag nightly\n", "0755", "root", 0)

	/* -------------------- procfs, close enough -------------------- */
	f.file("/proc/version", fmt.Sprintf("Linux version %s (debian-kernel@lists.debian.org) (gcc-12 (Debian 12.2.0-14) 12.2.0) #1 SMP PREEMPT_DYNAMIC Debian 6.1.76-1 (2024-02-01)\n", id.kernel))
	f.file("/proc/cpuinfo", cpuinfoFile(id))
	f.file("/proc/meminfo", meminfoFile(id))
	f.file("/proc/mounts", "/dev/vda1 / ext4 rw,relatime,errors=remount-ro 0 0\n/dev/vda2 /boot ext4 rw,relatime 0 0\n/dev/vdb1 /srv xfs rw,noatime 0 0\n/dev/vdc1 /var/lib/docker ext4 rw,relatime 0 0\n")

	return f
}

func cpuinfoFile(id identity) string {
	var b strings.Builder
	for core := 0; core < id.cpuCores; core++ {
		fmt.Fprintf(&b, "processor\t: %d\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel name\t: %s\ncpu MHz\t\t: 2900.000\ncache size\t: 55296 KB\nsiblings\t: %d\ncore id\t\t: %d\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat\n\n",
			core, id.cpuModel, id.cpuCores, core)
	}
	return b.String()
}

func meminfoFile(id identity) string {
	total := id.memoryTotal / kiB
	return fmt.Sprintf("MemTotal:       %8d kB\nMemFree:        %8d kB\nMemAvailable:   %8d kB\nBuffers:        %8d kB\nCached:         %8d kB\nSwapTotal:      %8d kB\nSwapFree:       %8d kB\n",
		total, total*22/100, total*49/100, total*3/100, total*24/100, id.swapTotal/kiB, id.swapTotal/kiB*93/100)
}

// buildContainerFilesystem gives `container.exec` somewhere honest to
// land: the container's own root, not the host's.
func buildContainerFilesystem(s *Sim, c *container) *memfs {
	f := newMemFS(s)
	for _, d := range []string{"/bin", "/dev", "/etc", "/proc", "/root", "/sys", "/tmp", "/usr/bin", "/usr/local/bin", "/var/log"} {
		f.dir(d)
	}
	f.file("/etc/hostname", c.info.ID[:12]+"\n")
	f.file("/etc/hosts", "127.0.0.1\tlocalhost\n172.18.0.2\t"+c.info.ID[:12]+"\n")
	f.file("/etc/os-release", "PRETTY_NAME=\"Alpine Linux v3.20\"\nNAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.1\n")
	f.file("/etc/resolv.conf", "nameserver 127.0.0.11\noptions ndots:0\n")
	for _, name := range []string{"sh", "ls", "cat", "env"} {
		f.blob("/bin/"+name, 812_408)
	}
	f.blob("/usr/local/bin/"+c.process, 24_117_248)

	switch {
	case strings.HasPrefix(c.info.Image, "redis"):
		f.blob("/data/dump.rdb", 18_874_368)
		f.file("/etc/redis.conf", "bind 0.0.0.0\nport 6379\nappendonly yes\nsave 900 1\n")
	case strings.HasPrefix(c.info.Image, "minio"):
		f.dir("/data/kaname-backups")
	case strings.Contains(c.info.Image, "uptime-kuma"), strings.Contains(c.info.Image, "n8n"):
		f.file("/app/package.json", "{\n  \"name\": \""+c.info.Name+"\",\n  \"private\": true\n}\n")
		f.blob("/app/server/server.js", 284_112)
	}
	return f
}

/* ------------------------------- sites ------------------------------- */

type site struct {
	info       providers.SiteInfo
	upstream   string
	forceHTTPS bool
}

type certificate struct {
	subject   string
	sans      []string
	issuer    string
	notBefore time.Time
	notAfter  time.Time
	path      string
	keyType   string
}

func (s *Sim) buildWeb() {
	domain := s.id.domain
	now := time.Now().UTC()

	seeds := []struct {
		name     string
		names    []string
		webroot  string
		runtime  string
		version  string
		upstream string
		enabled  bool
	}{
		{domain, []string{domain, "www." + domain}, "/var/www/" + domain + "/public", "static", "", "", true},
		{"api." + domain, []string{"api." + domain}, "/var/www/api." + domain + "/public", "proxy", "", "http://127.0.0.1:3000", true},
		{"blog." + domain, []string{"blog." + domain}, "/var/www/blog." + domain + "/public", "php", "8.2", "", true},
		{"app." + domain, []string{"app." + domain}, "/var/www/app." + domain + "/current", "node", "20", "http://127.0.0.1:4000", true},
		{"staging." + domain, []string{"staging." + domain}, "/var/www/staging." + domain + "/public", "static", "", "", false},
	}

	s.sites = make([]*site, 0, len(seeds))
	for _, seed := range seeds {
		info := providers.SiteInfo{
			Name:        seed.name,
			Webroot:     seed.webroot,
			ServerNames: seed.names,
			Runtime:     seed.runtime,
			Enabled:     seed.enabled,
			ConfigPath:  "/etc/nginx/sites-available/" + seed.name,
		}
		if seed.version != "" {
			info.RuntimeVersion = ptr(seed.version)
		}
		entry := &site{info: info, upstream: seed.upstream, forceHTTPS: true}
		s.sites = append(s.sites, entry)

		s.fs.mu.Lock()
		s.fs.file(entry.info.ConfigPath, renderSiteConfig(entry))
		if seed.enabled {
			s.fs.link("/etc/nginx/sites-enabled/"+seed.name, "../sites-available/"+seed.name)
		}
		s.fs.dirAs(seed.webroot, "0755", "www-data", 33)
		s.fs.mu.Unlock()
		s.seedWebroot(entry)
	}

	certSeeds := []struct {
		subject string
		sans    []string
		days    int
	}{
		{domain, []string{domain, "www." + domain}, 63},
		{"api." + domain, []string{"api." + domain}, 41},
		{"blog." + domain, []string{"blog." + domain}, 12},
		{"mail." + domain, []string{"mail." + domain, "imap." + domain, "smtp." + domain}, 78},
	}

	s.certs = make([]*certificate, 0, len(certSeeds))
	for _, seed := range certSeeds {
		cert := &certificate{
			subject:   seed.subject,
			sans:      seed.sans,
			issuer:    "C=US, O=Let's Encrypt, CN=R11",
			notBefore: now.Add(-time.Duration(90-seed.days) * 24 * time.Hour),
			notAfter:  now.Add(time.Duration(seed.days) * 24 * time.Hour),
			path:      "/etc/letsencrypt/live/" + seed.subject + "/fullchain.pem",
			keyType:   "ecdsa",
		}
		s.certs = append(s.certs, cert)
		s.writeCertFiles(cert)
	}
}

func (s *Sim) seedWebroot(entry *site) {
	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	root := entry.info.Webroot
	switch entry.info.Runtime {
	case "php":
		s.fs.fileAs(root+"/index.php", "<?php\ndeclare(strict_types=1);\nrequire __DIR__ . '/../vendor/autoload.php';\n\n$app = new App\\Kernel();\n$app->handle($_SERVER, $_GET, $_POST);\n", "0644", "www-data", 33)
		s.fs.fileAs(root+"/.htaccess", "RewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^ index.php [L]\n", "0644", "www-data", 33)
		s.fs.dirAs(root+"/wp-content/uploads", "0755", "www-data", 33)
		s.fs.blob(root+"/wp-content/uploads/2026-08-hero.jpg", 1_884_112)
	case "node":
		s.fs.fileAs(root+"/server.js", "import { createServer } from 'node:http';\n\ncreateServer((_req, res) => {\n  res.writeHead(200, { 'content-type': 'application/json' });\n  res.end(JSON.stringify({ ok: true }));\n}).listen(4000);\n", "0644", "deploy", 1000)
		s.fs.fileAs(root+"/package.json", "{\n  \"name\": \""+entry.info.Name+"\",\n  \"type\": \"module\",\n  \"private\": true\n}\n", "0644", "deploy", 1000)
	case "proxy":
		s.fs.fileAs(root+"/index.html", "<!doctype html>\n<title>upstream</title>\n<p>Requests are proxied to the application server.</p>\n", "0644", "www-data", 33)
	default:
		s.fs.fileAs(root+"/index.html", staticIndexHTML(entry.info.Name), "0644", "www-data", 33)
		s.fs.fileAs(root+"/robots.txt", "User-agent: *\nDisallow:\n", "0644", "www-data", 33)
		s.fs.fileAs(root+"/assets/app.css", ":root{color-scheme:dark}\nbody{margin:0;font:16px/1.6 system-ui,sans-serif;background:#0b0c0e;color:#e7e9ec}\nmain{max-width:60ch;margin:12vh auto;padding:0 1.5rem}\n", "0644", "www-data", 33)
		s.fs.blob(root+"/assets/app.js", 118_442)
		s.fs.blob(root+"/favicon.ico", 15_086)
	}
}

func staticIndexHTML(name string) string {
	return fmt.Sprintf(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>%s</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <main>
      <h1>%s</h1>
      <p>Served by nginx from this host.</p>
    </main>
    <script src="/assets/app.js" defer></script>
  </body>
</html>
`, name, name)
}

func renderSiteConfig(entry *site) string {
	var b strings.Builder
	names := strings.Join(entry.info.ServerNames, " ")

	if entry.forceHTTPS {
		fmt.Fprintf(&b, "server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n    return 301 https://$host$request_uri;\n}\n\n", names)
	}
	fmt.Fprintf(&b, "server {\n    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n    server_name %s;\n\n", names)
	fmt.Fprintf(&b, "    ssl_certificate     /etc/letsencrypt/live/%s/fullchain.pem;\n", entry.info.Name)
	fmt.Fprintf(&b, "    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;\n", entry.info.Name)
	b.WriteString("    include snippets/ssl-params.conf;\n\n")
	fmt.Fprintf(&b, "    root %s;\n", entry.info.Webroot)
	fmt.Fprintf(&b, "    access_log /var/log/nginx/%s.access.log;\n", entry.info.Name)
	fmt.Fprintf(&b, "    error_log  /var/log/nginx/%s.error.log;\n\n", entry.info.Name)

	switch entry.info.Runtime {
	case "php":
		version := "8.2"
		if entry.info.RuntimeVersion != nil {
			version = *entry.info.RuntimeVersion
		}
		b.WriteString("    index index.php index.html;\n\n    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n\n")
		fmt.Fprintf(&b, "    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:/run/php/php%s-fpm.sock;\n    }\n", version)
	case "proxy", "node", "container":
		upstream := entry.upstream
		if upstream == "" {
			upstream = "http://127.0.0.1:3000"
		}
		fmt.Fprintf(&b, "    location / {\n        proxy_pass %s;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n", upstream)
	case "python":
		b.WriteString("    location / {\n        include uwsgi_params;\n        uwsgi_pass unix:/run/uwsgi/app.sock;\n    }\n")
	default:
		b.WriteString("    index index.html;\n\n    location / {\n        try_files $uri $uri/ =404;\n    }\n")
	}

	b.WriteString("}\n")
	return b.String()
}

type simSites struct{ *Sim }

func (s simSites) List(context.Context) ([]providers.SiteInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.SiteInfo, 0, len(s.sites))
	for _, entry := range s.sites {
		out = append(out, entry.info)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s simSites) Create(_ context.Context, p providers.SiteCreateParams) (providers.SiteConfigResult, error) {
	webroot, err := cleanPath(p.Webroot)
	if err != nil {
		return providers.SiteConfigResult{}, err
	}

	s.mu.Lock()
	for _, existing := range s.sites {
		if existing.info.Name == p.Name {
			s.mu.Unlock()
			return providers.SiteConfigResult{}, fmt.Errorf("site %s already exists: %w", p.Name, providers.ErrConflict)
		}
	}

	info := providers.SiteInfo{
		Name:        p.Name,
		Webroot:     webroot,
		ServerNames: p.ServerNames,
		Runtime:     p.Runtime,
		Enabled:     true,
		ConfigPath:  "/etc/nginx/sites-available/" + p.Name,
	}
	if p.RuntimeVersion != "" {
		info.RuntimeVersion = ptr(p.RuntimeVersion)
	}
	entry := &site{info: info, upstream: p.Upstream, forceHTTPS: p.ForceHTTPS}
	s.sites = append(s.sites, entry)
	s.mu.Unlock()

	owner, uid := "www-data", 33
	if p.Owner != "" {
		owner, uid = p.Owner, uidFor(p.Owner)
	}

	s.fs.mu.Lock()
	s.fs.file(info.ConfigPath, renderSiteConfig(entry))
	s.fs.link("/etc/nginx/sites-enabled/"+p.Name, "../sites-available/"+p.Name)
	s.fs.dirAs(webroot, "0755", owner, uid)
	s.fs.mu.Unlock()
	s.seedWebroot(entry)

	return providers.SiteConfigResult{ConfigPath: info.ConfigPath}, nil
}

func (s simSites) Update(_ context.Context, p providers.SiteUpdateParams) (providers.SiteConfigResult, error) {
	s.mu.Lock()

	var entry *site
	for _, candidate := range s.sites {
		if candidate.info.Name == p.Name {
			entry = candidate
			break
		}
	}
	if entry == nil {
		s.mu.Unlock()
		return providers.SiteConfigResult{}, fmt.Errorf("site %s: %w", p.Name, providers.ErrNotFound)
	}

	if len(p.ServerNames) > 0 {
		entry.info.ServerNames = p.ServerNames
	}
	if p.Webroot != "" {
		webroot, err := cleanPath(p.Webroot)
		if err != nil {
			s.mu.Unlock()
			return providers.SiteConfigResult{}, err
		}
		entry.info.Webroot = webroot
	}
	if p.RuntimeVersion != "" {
		entry.info.RuntimeVersion = ptr(p.RuntimeVersion)
	}
	if p.Upstream != "" {
		entry.upstream = p.Upstream
	}
	if p.ForceHTTPS != nil {
		entry.forceHTTPS = *p.ForceHTTPS
	}
	if p.Enabled != nil {
		entry.info.Enabled = *p.Enabled
	}
	snapshot, configPath, enabled := *entry, entry.info.ConfigPath, entry.info.Enabled
	s.mu.Unlock()

	s.fs.mu.Lock()
	s.fs.file(configPath, renderSiteConfig(&snapshot))
	link := "/etc/nginx/sites-enabled/" + p.Name
	if enabled {
		s.fs.link(link, "../sites-available/"+p.Name)
	} else if parent, err := s.fs.parentOf(link); err == nil {
		delete(parent.children, path.Base(link))
	}
	s.fs.mu.Unlock()

	return providers.SiteConfigResult{ConfigPath: configPath}, nil
}

func (s simSites) Remove(_ context.Context, p providers.SiteRemoveParams) error {
	s.mu.Lock()

	index := -1
	for i, entry := range s.sites {
		if entry.info.Name == p.Name {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return fmt.Errorf("site %s: %w", p.Name, providers.ErrNotFound)
	}
	webroot := s.sites[index].info.Webroot
	configPath := s.sites[index].info.ConfigPath
	s.sites = append(s.sites[:index], s.sites[index+1:]...)
	s.mu.Unlock()

	s.fs.mu.Lock()
	for _, target := range []string{configPath, "/etc/nginx/sites-enabled/" + p.Name} {
		if parent, err := s.fs.parentOf(target); err == nil {
			delete(parent.children, path.Base(target))
		}
	}
	if p.DeleteWebroot {
		if parent, err := s.fs.parentOf(webroot); err == nil {
			if n, ok := parent.children[path.Base(webroot)]; ok {
				s.accountBytes(-treeSize(n))
				delete(parent.children, path.Base(webroot))
			}
		}
	}
	s.fs.mu.Unlock()

	return nil
}

func (s simSites) TestConfig(context.Context) (providers.SiteTestConfigResult, error) {
	return providers.SiteTestConfigResult{
		Valid: true,
		Output: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n" +
			"nginx: configuration file /etc/nginx/nginx.conf test is successful\n",
	}, nil
}

func (s simSites) Reload(context.Context) error {
	_, err := s.transition("nginx.service", "reload")
	return err
}

/* --------------------------- certificates ---------------------------- */

func (s *Sim) writeCertFiles(cert *certificate) {
	dir := "/etc/letsencrypt/live/" + cert.subject

	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	s.fs.dir(dir)
	body := fmt.Sprintf("# simulated leaf for %s\n# sans: %s\n# not_after: %s\n",
		cert.subject, strings.Join(cert.sans, ", "), stamp(cert.notAfter))
	s.fs.file(dir+"/fullchain.pem", "-----BEGIN CERTIFICATE-----\n"+body+"-----END CERTIFICATE-----\n")
	s.fs.file(dir+"/cert.pem", "-----BEGIN CERTIFICATE-----\n"+body+"-----END CERTIFICATE-----\n")
	s.fs.file(dir+"/chain.pem", "-----BEGIN CERTIFICATE-----\n# ISRG Root X1 chain\n-----END CERTIFICATE-----\n")
	s.fs.fileAs(dir+"/privkey.pem", "-----BEGIN PRIVATE KEY-----\n(simulated; no key material is kept)\n-----END PRIVATE KEY-----\n", "0600", "root", 0)
}

type simCerts struct{ *Sim }

func (s simCerts) List(context.Context) ([]providers.CertificateInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.CertificateInfo, 0, len(s.certs))
	for _, cert := range s.certs {
		out = append(out, providers.CertificateInfo{
			Subject:   cert.subject,
			Sans:      cert.sans,
			Issuer:    cert.issuer,
			NotBefore: stamp(cert.notBefore),
			NotAfter:  stamp(cert.notAfter),
			Path:      cert.path,
			KeyType:   cert.keyType,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Subject < out[j].Subject })
	return out, nil
}

func (s simCerts) Issue(ctx context.Context, p providers.CertIssueParams, stream providers.Stream) (providers.CertIssueResult, error) {
	subject := p.Domains[0]
	directory := "https://acme-v02.api.letsencrypt.org/directory"
	if p.Staging {
		directory = "https://acme-staging-v02.api.letsencrypt.org/directory"
	}

	steps := []string{
		"Saving debug log to /var/log/letsencrypt/letsencrypt.log",
		"Account registered with " + directory,
		"Requesting a certificate for " + strings.Join(p.Domains, ", "),
	}
	for _, domain := range p.Domains {
		if p.Challenge == "dns-01" {
			steps = append(steps, fmt.Sprintf("Waiting for verification of _acme-challenge.%s", domain))
			continue
		}
		steps = append(steps, fmt.Sprintf("http-01 challenge for %s served from %s", domain, p.Webroot))
	}
	steps = append(steps, "Challenges validated", "Downloading the certificate chain")

	for _, step := range steps {
		if err := progress(ctx, stream, 320*time.Millisecond, "%s", step); err != nil {
			return providers.CertIssueResult{}, err
		}
	}

	now := time.Now().UTC()
	cert := &certificate{
		subject:   subject,
		sans:      p.Domains,
		issuer:    "C=US, O=Let's Encrypt, CN=R11",
		notBefore: now,
		notAfter:  now.Add(90 * 24 * time.Hour),
		path:      "/etc/letsencrypt/live/" + subject + "/fullchain.pem",
		keyType:   p.KeyType,
	}
	if p.Staging {
		cert.issuer = "C=US, O=(STAGING) Let's Encrypt, CN=(STAGING) False Fennel E6"
	}

	s.mu.Lock()
	replaced := false
	for i, existing := range s.certs {
		if existing.subject == subject {
			s.certs[i] = cert
			replaced = true
			break
		}
	}
	if !replaced {
		s.certs = append(s.certs, cert)
	}
	delete(s.announced, subject)
	s.mu.Unlock()

	s.writeCertFiles(cert)
	_ = progress(ctx, stream, 0, "Certificate saved at %s", cert.path)

	return providers.CertIssueResult{
		Subject:  cert.subject,
		Sans:     cert.sans,
		NotAfter: stamp(cert.notAfter),
		Path:     cert.path,
	}, nil
}

func (s simCerts) Renew(ctx context.Context, p providers.CertRenewParams, stream providers.Stream) (providers.CertRenewResult, error) {
	s.mu.Lock()
	var cert *certificate
	for _, candidate := range s.certs {
		if candidate.subject == p.Subject {
			cert = candidate
			break
		}
	}
	if cert == nil {
		s.mu.Unlock()
		return providers.CertRenewResult{}, fmt.Errorf("certificate %s: %w", p.Subject, providers.ErrNotFound)
	}
	remaining := time.Until(cert.notAfter)
	s.mu.Unlock()

	if remaining > 30*24*time.Hour && !p.Force {
		_ = progress(ctx, stream, 0, "Certificate not yet due for renewal (%d days remaining)", int(remaining.Hours()/24))
		return providers.CertRenewResult{}, fmt.Errorf("%s is not due for renewal: %w", p.Subject, providers.ErrPreconditionFailed)
	}

	for _, step := range []string{
		"Processing /etc/letsencrypt/renewal/" + p.Subject + ".conf",
		"Renewing an existing certificate for " + p.Subject,
		"Challenges validated",
	} {
		if err := progress(ctx, stream, 300*time.Millisecond, "%s", step); err != nil {
			return providers.CertRenewResult{}, err
		}
	}

	now := time.Now().UTC()
	s.mu.Lock()
	cert.notBefore = now
	cert.notAfter = now.Add(90 * 24 * time.Hour)
	delete(s.announced, cert.subject)
	notAfter := cert.notAfter
	s.mu.Unlock()

	s.writeCertFiles(cert)
	_ = progress(ctx, stream, 0, "Renewal successful, new expiry %s", stamp(notAfter))

	return providers.CertRenewResult{NotAfter: stamp(notAfter)}, nil
}

func (s simCerts) Revoke(_ context.Context, p providers.CertRevokeParams) error {
	s.mu.Lock()

	index := -1
	for i, cert := range s.certs {
		if cert.subject == p.Subject {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return fmt.Errorf("certificate %s: %w", p.Subject, providers.ErrNotFound)
	}
	s.certs = append(s.certs[:index], s.certs[index+1:]...)
	s.mu.Unlock()

	s.fs.mu.Lock()
	dir := "/etc/letsencrypt/live/" + p.Subject
	if parent, err := s.fs.parentOf(dir); err == nil {
		delete(parent.children, path.Base(dir))
	}
	s.fs.mu.Unlock()

	return nil
}

func (s simCerts) Install(_ context.Context, p providers.CertInstallParams) (providers.CertInstallResult, error) {
	now := time.Now().UTC()
	dir := "/etc/ssl/kaname/" + p.Subject
	cert := &certificate{
		subject:   p.Subject,
		sans:      []string{p.Subject},
		issuer:    "externally issued",
		notBefore: now,
		notAfter:  now.Add(365 * 24 * time.Hour),
		path:      dir + "/fullchain.pem",
		keyType:   "rsa",
	}

	s.mu.Lock()
	replaced := false
	for i, existing := range s.certs {
		if existing.subject == p.Subject {
			s.certs[i] = cert
			replaced = true
			break
		}
	}
	if !replaced {
		s.certs = append(s.certs, cert)
	}
	s.mu.Unlock()

	s.fs.mu.Lock()
	s.fs.dir(dir)
	s.fs.file(dir+"/fullchain.pem", p.CertificatePEM+p.ChainPEM)
	s.fs.fileAs(dir+"/privkey.pem", p.KeyPEM, "0600", "root", 0)
	s.fs.mu.Unlock()

	return providers.CertInstallResult{Path: cert.path}, nil
}

/* --------------------------- config bodies --------------------------- */

const nginxMainConfig = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 1024;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`

const sshdConfigFile = `Include /etc/ssh/sshd_config.d/*.conf

Port 22
AddressFamily any
ListenAddress 0.0.0.0

PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 4
AllowUsers root deploy

UsePAM yes
X11Forwarding no
PrintMotd no
ClientAliveInterval 300
ClientAliveCountMax 2

AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
`

const nftablesConfig = `#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        ct state established,related accept
        iif "lo" accept
        ip protocol icmp accept
        tcp dport { 22, 25, 80, 443, 587, 993 } accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
`

func postfixMainConfig(id identity) string {
	return fmt.Sprintf(`smtpd_banner = $myhostname ESMTP $mail_name (Debian/GNU)
biff = no
append_dot_mydomain = no

myhostname = mail.%s
mydomain = %s
myorigin = $mydomain
mydestination = localhost
relayhost =
mynetworks = 127.0.0.0/8 [::1]/128 %s/32
inet_interfaces = all
inet_protocols = all

virtual_mailbox_domains = %s
virtual_mailbox_base = /var/vmail
virtual_mailbox_maps = hash:/etc/postfix/vmailbox
virtual_alias_maps = hash:/etc/postfix/virtual

smtpd_tls_cert_file = /etc/letsencrypt/live/mail.%s/fullchain.pem
smtpd_tls_key_file = /etc/letsencrypt/live/mail.%s/privkey.pem
smtpd_tls_security_level = may
smtp_tls_security_level = may

milter_default_action = accept
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = $smtpd_milters
`, id.mailDomain, id.mailDomain, id.privateIP, id.mailDomain, id.mailDomain, id.mailDomain)
}
