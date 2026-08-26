//go:build linux

package linux

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Logs.
 *
 * journald is read through `journalctl --output=json` invoked with an
 * argv slice — never a shell string, because a unit name is attacker
 * influenced. Plain files are tailed directly, with rotation detected by
 * inode identity rather than by guessing from the size.
 *
 * Streamed lines travel as newline-delimited JSON records; the settled
 * result carries the backlog that was already there when the tail began.
 * ------------------------------------------------------------------ */

const (
	// How long a file tail sleeps between polls when it is caught up.
	tailPollInterval = 500 * time.Millisecond
	// Bound on a single log line, so one runaway process cannot make the
	// agent allocate without limit.
	maxLogLine = 1 << 20
)

// Well-known files worth offering even before anything has been
// configured. Anything absent is simply not advertised.
var wellKnownLogFiles = []struct {
	path  string
	label string
	kind  string
}{
	{"/var/log/syslog", "System log", "file"},
	{"/var/log/messages", "System messages", "file"},
	{"/var/log/auth.log", "Authentication", "file"},
	{"/var/log/secure", "Authentication", "file"},
	{"/var/log/kern.log", "Kernel", "file"},
	{"/var/log/mail.log", "Mail transport", "mail"},
	{"/var/log/maillog", "Mail transport", "mail"},
	{"/var/log/nginx/access.log", "nginx access", "nginx_access"},
	{"/var/log/nginx/error.log", "nginx error", "nginx_error"},
	{"/var/log/apache2/access.log", "Apache access", "nginx_access"},
	{"/var/log/apache2/error.log", "Apache error", "nginx_error"},
}

type logOps struct{ p *provider }

func (o logOps) Sources(ctx context.Context) ([]providers.LogSource, error) {
	sources := make([]providers.LogSource, 0, 16)

	if o.p.has(providers.CapSystemd) {
		sources = append(sources, providers.LogSource{
			ID:             "journald",
			Label:          "System journal",
			Kind:           "journald",
			Ref:            "",
			SupportsFollow: true,
		})
	}

	seen := map[string]struct{}{}
	addFile := func(path, label, kind string) {
		if _, duplicate := seen[path]; duplicate {
			return
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			return
		}
		seen[path] = struct{}{}
		sources = append(sources, providers.LogSource{
			ID:             "file:" + path,
			Label:          label,
			Kind:           kind,
			Ref:            path,
			Size:           int64Ptr(info.Size()),
			SupportsFollow: true,
		})
	}

	for _, candidate := range wellKnownLogFiles {
		addFile(candidate.path, candidate.label, candidate.kind)
	}
	for _, dir := range []string{"/var/log/nginx", "/var/log/apache2", "/var/log/caddy"} {
		matches, err := filepath.Glob(filepath.Join(dir, "*.log"))
		if err != nil {
			continue
		}
		for _, match := range matches {
			kind := "file"
			switch {
			case strings.Contains(match, "error"):
				kind = "nginx_error"
			case strings.Contains(match, "access"):
				kind = "nginx_access"
			}
			addFile(match, filepath.Base(dir)+" "+filepath.Base(match), kind)
		}
	}

	if o.p.docker != nil {
		var containers []dockerContainer
		if err := o.p.docker.get(ctx, "/containers/json?all=0", &containers); err == nil {
			for _, container := range containers {
				sources = append(sources, providers.LogSource{
					ID:             "container:" + container.ID,
					Label:          containerName(container.Names),
					Kind:           "container",
					Ref:            container.ID,
					SupportsFollow: true,
				})
			}
		}
	}
	return sources, nil
}

func (o logOps) Tail(ctx context.Context, p providers.LogTailParams, stream providers.Stream) ([]providers.LogRecord, error) {
	kind, ref, err := parseLogSource(p.Source)
	if err != nil {
		return nil, err
	}

	filter := recordFilter{level: p.Level, query: p.Query}
	if err := filter.validate(); err != nil {
		return nil, err
	}

	switch kind {
	case "journald":
		if err := o.p.require(providers.CapSystemd); err != nil {
			return nil, err
		}
		query := journalQuery{Source: p.Source, Lines: p.Lines, Follow: p.Follow, Filter: filter}
		if ref != "" {
			query.Args = append(query.Args, "--unit="+qualify(ref))
		}
		if p.Since != "" {
			since, err := journalSince(p.Since)
			if err != nil {
				return nil, err
			}
			query.Args = append(query.Args, "--since="+since)
		}
		return journal(ctx, query, stream)

	case "container":
		return containerOps{o.p}.Logs(ctx, providers.ContainerLogsParams{
			ID:     ref,
			Lines:  p.Lines,
			Follow: p.Follow,
			Since:  p.Since,
		}, stream)

	case "file":
		return tailFile(ctx, ref, p.Lines, p.Follow, filter, stream)

	default:
		return nil, invalid("unknown log source %q", p.Source)
	}
}

/* ------------------------------- journald ---------------------------- */

type journalQuery struct {
	// Args are extra journalctl selectors, already built as argv items.
	Args   []string
	Source string
	Lines  int
	Follow bool
	Filter recordFilter
}

// journalRecord is the subset of journald's JSON export the panel uses.
type journalRecord struct {
	Cursor    string          `json:"__CURSOR"`
	Realtime  string          `json:"__REALTIME_TIMESTAMP"`
	Priority  string          `json:"PRIORITY"`
	Message   json.RawMessage `json:"MESSAGE"`
	Unit      string          `json:"_SYSTEMD_UNIT"`
	Syslog    string          `json:"SYSLOG_IDENTIFIER"`
	PID       string          `json:"_PID"`
	Hostname  string          `json:"_HOSTNAME"`
	Transport string          `json:"_TRANSPORT"`
}

// journal runs journalctl and returns the backlog it printed first,
// streaming everything after that as it arrives.
func journal(ctx context.Context, q journalQuery, stream providers.Stream) ([]providers.LogRecord, error) {
	lines := q.Lines
	if lines <= 0 {
		lines = 200
	}

	args := []string{"--no-pager", "--output=json", "--lines=" + strconv.Itoa(lines)}
	if priority, ok := journalPriority(q.Filter.level); ok {
		args = append(args, "--priority="+strconv.Itoa(priority))
	}
	args = append(args, q.Args...)
	if q.Follow {
		args = append(args, "--follow")
	}

	path, err := exec.LookPath("journalctl")
	if err != nil {
		return nil, unsupported("journalctl is not installed")
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = cLocale()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open journalctl pipe: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, execError("journalctl", stderr.String(), err)
	}
	// journalctl --follow never ends on its own, so it is killed before it
	// is reaped: waiting on a live process nobody is reading from would
	// hang the handler for as long as the host stays up.
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	backlog := make([]providers.LogRecord, 0, lines)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLogLine)

	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		var parsed journalRecord
		if err := json.Unmarshal(scanner.Bytes(), &parsed); err != nil {
			continue
		}
		record := parsed.toRecord(q.Source)
		if !q.Filter.matches(record) {
			continue
		}
		if len(backlog) < lines {
			backlog = append(backlog, record)
			continue
		}
		if !q.Follow || stream == nil {
			continue
		}
		if err := sendRecord(ctx, stream, record); err != nil {
			return backlog, err
		}
	}

	if err := scanner.Err(); err != nil && ctx.Err() == nil && !errors.Is(err, os.ErrClosed) {
		return backlog, fmt.Errorf("read journal: %w", err)
	}
	return backlog, nil
}

func (r journalRecord) toRecord(source string) providers.LogRecord {
	record := providers.LogRecord{
		Ts:      nowRFC3339(),
		Level:   journalLevel(r.Priority),
		Source:  source,
		Message: decodeJournalMessage(r.Message),
		Cursor:  r.Cursor,
	}
	if micros, err := strconv.ParseInt(r.Realtime, 10, 64); err == nil && micros > 0 {
		record.Ts = rfc3339(time.UnixMicro(micros))
	}

	fields := map[string]string{}
	if r.Unit != "" {
		fields["unit"] = r.Unit
	}
	if r.Syslog != "" {
		fields["identifier"] = r.Syslog
	}
	if r.PID != "" {
		fields["pid"] = r.PID
	}
	if r.Transport != "" {
		fields["transport"] = r.Transport
	}
	if len(fields) > 0 {
		record.Fields = fields
	}
	return record
}

// decodeJournalMessage copes with journald exporting a non-UTF8 message
// as an array of byte values rather than as a string.
func decodeJournalMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var octets []byte
	if err := json.Unmarshal(raw, &octets); err == nil {
		return string(octets)
	}
	return string(raw)
}

func journalLevel(priority string) string {
	switch priority {
	case "0", "1", "2":
		return "fatal"
	case "3":
		return "error"
	case "4":
		return "warn"
	case "5":
		return "notice"
	case "7":
		return "debug"
	default:
		return "info"
	}
}

// journalPriority turns a requested level into journald's "this severity
// or worse" selector, which is the filter an operator actually wants.
func journalPriority(level string) (int, bool) {
	switch level {
	case "fatal":
		return 2, true
	case "error":
		return 3, true
	case "warn":
		return 4, true
	case "notice":
		return 5, true
	case "info":
		return 6, true
	case "debug", "trace":
		return 7, true
	default:
		return 0, false
	}
}

/* ------------------------------ file tails --------------------------- */

// tailFile returns the last `lines` of a file and, when following,
// streams what is appended after that. A rotation — the path pointing at
// a different inode, or the file having been truncated — reopens from
// the top instead of silently tailing a deleted file forever.
func tailFile(ctx context.Context, path string, lines int, follow bool, filter recordFilter, stream providers.Stream) ([]providers.LogRecord, error) {
	if lines <= 0 {
		lines = 200
	}

	source := "file:" + path
	tail, offset, err := lastLines(path, lines)
	if err != nil {
		return nil, err
	}

	backlog := make([]providers.LogRecord, 0, len(tail))
	for _, line := range tail {
		record := fileRecord(source, line)
		if filter.matches(record) {
			backlog = append(backlog, record)
		}
	}
	if !follow || stream == nil {
		return backlog, nil
	}

	handle, err := os.Open(path)
	if err != nil {
		return backlog, fmt.Errorf("open %s: %w", path, err)
	}
	defer handle.Close()

	if _, err := handle.Seek(offset, io.SeekStart); err != nil {
		return backlog, fmt.Errorf("seek %s: %w", path, err)
	}
	known, err := handle.Stat()
	if err != nil {
		return backlog, fmt.Errorf("stat %s: %w", path, err)
	}

	reader := bufio.NewReaderSize(handle, 64<<10)
	pending := ""

	for {
		if ctx.Err() != nil {
			return backlog, nil
		}

		line, err := reader.ReadString('\n')
		if err == nil {
			full := pending + strings.TrimRight(line, "\r\n")
			pending = ""
			record := fileRecord(source, full)
			if filter.matches(record) {
				if err := sendRecord(ctx, stream, record); err != nil {
					return backlog, err
				}
			}
			continue
		}
		if !errors.Is(err, io.EOF) {
			return backlog, fmt.Errorf("read %s: %w", path, err)
		}
		// A partial line is held until its newline arrives, so a log
		// writer's non-atomic append is never split into two records.
		pending += line

		select {
		case <-ctx.Done():
			return backlog, nil
		case <-time.After(tailPollInterval):
		}

		rotated, reopened, newReader, newKnown := detectRotation(path, handle, known, reader)
		if rotated {
			if reopened == nil {
				continue
			}
			handle.Close()
			handle = reopened
			reader = newReader
			known = newKnown
			pending = ""
		}
	}
}

// detectRotation reports whether the path now names a different file, or
// the same file truncated, and hands back a reader positioned for it.
func detectRotation(path string, handle *os.File, known os.FileInfo, reader *bufio.Reader) (bool, *os.File, *bufio.Reader, os.FileInfo) {
	current, err := os.Stat(path)
	if err != nil {
		return false, nil, reader, known
	}

	position, err := handle.Seek(0, io.SeekCurrent)
	if err != nil {
		return false, nil, reader, known
	}
	truncated := current.Size() < position-int64(reader.Buffered())

	if os.SameFile(known, current) && !truncated {
		return false, nil, reader, known
	}

	reopened, err := os.Open(path)
	if err != nil {
		return true, nil, reader, known
	}
	return true, reopened, bufio.NewReaderSize(reopened, 64<<10), current
}

// lastLines reads the tail of a file by walking backwards in blocks, so
// a multi-gigabyte access log costs one seek rather than a full read.
func lastLines(path string, count int) ([]string, int64, error) {
	handle, err := os.Open(path)
	if err != nil {
		if isNotExist(err) {
			return nil, 0, notFound("log file %s", path)
		}
		return nil, 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer handle.Close()

	info, err := handle.Stat()
	if err != nil {
		return nil, 0, fmt.Errorf("stat %s: %w", path, err)
	}
	size := info.Size()
	if size == 0 {
		return nil, 0, nil
	}

	const block = 64 << 10
	var collected []byte
	offset := size
	newlines := 0

	for offset > 0 && newlines <= count && int64(len(collected)) < maxLogLine*int64(count+1) {
		chunk := int64(block)
		if offset < chunk {
			chunk = offset
		}
		offset -= chunk

		buffer := make([]byte, chunk)
		if _, err := handle.ReadAt(buffer, offset); err != nil && !errors.Is(err, io.EOF) {
			return nil, 0, fmt.Errorf("read %s: %w", path, err)
		}
		collected = append(buffer, collected...)
		newlines = bytes.Count(collected, []byte{'\n'})
	}

	all := splitLines(strings.ReplaceAll(string(collected), "\r\n", "\n"))
	if offset > 0 && len(all) > 0 {
		// The first line of the window is probably a fragment.
		all = all[1:]
	}
	if len(all) > count {
		all = all[len(all)-count:]
	}
	return all, size, nil
}

func fileRecord(source, line string) providers.LogRecord {
	return providers.LogRecord{
		Ts:      nowRFC3339(),
		Level:   guessLevel(line),
		Source:  source,
		Message: line,
	}
}

// guessLevel reads a severity out of an unstructured line. It is a hint
// for the log viewer's filter, never a claim about the writer's intent.
func guessLevel(line string) string {
	lowered := strings.ToLower(line)
	switch {
	case strings.Contains(lowered, "emerg"), strings.Contains(lowered, "fatal"), strings.Contains(lowered, "panic"):
		return "fatal"
	case strings.Contains(lowered, "error"), strings.Contains(lowered, "[crit"), strings.Contains(lowered, " err "):
		return "error"
	case strings.Contains(lowered, "warn"):
		return "warn"
	case strings.Contains(lowered, "notice"):
		return "notice"
	case strings.Contains(lowered, "debug"):
		return "debug"
	default:
		return "info"
	}
}

/* ------------------------------- filtering --------------------------- */

// recordFilter is the server-side half of the log viewer's controls:
// filtering here is what keeps a chatty host from saturating the socket.
type recordFilter struct {
	level string
	query string
}

func (f recordFilter) validate() error {
	if f.level == "" {
		return nil
	}
	switch f.level {
	case "trace", "debug", "info", "notice", "warn", "error", "fatal":
		return nil
	default:
		return invalid("level %q is not a log level", f.level)
	}
}

func (f recordFilter) matches(record providers.LogRecord) bool {
	if f.level != "" && severity(record.Level) > severity(f.level) {
		return false
	}
	if f.query != "" && !strings.Contains(strings.ToLower(record.Message), strings.ToLower(f.query)) {
		return false
	}
	return true
}

// severity orders the contract's levels so "warn and worse" is a
// comparison rather than a set membership test.
func severity(level string) int {
	switch level {
	case "fatal":
		return 0
	case "error":
		return 1
	case "warn":
		return 2
	case "notice":
		return 3
	case "info":
		return 4
	case "debug":
		return 5
	default:
		return 6
	}
}

/* -------------------------------- shared ----------------------------- */

// sendRecord puts one record on the wire as a newline-delimited JSON
// object, which is the framing every log stream in this agent uses.
func sendRecord(ctx context.Context, stream providers.Stream, record providers.LogRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode log record: %w", err)
	}
	return stream.Send(ctx, append(encoded, '\n'), providers.EncodingUTF8)
}

func parseLogSource(source string) (string, string, error) {
	if source == "" {
		return "", "", invalid("source is required")
	}
	if strings.HasPrefix(source, "/") {
		path, err := validatePath(source)
		return "file", path, err
	}

	kind, ref, ok := strings.Cut(source, ":")
	if !ok {
		if source == "journald" {
			return "journald", "", nil
		}
		return "", "", invalid("source %q must be journald, journald:<unit>, file:<path> or container:<id>", source)
	}

	switch kind {
	case "journald":
		if ref != "" {
			if err := checkUnitPattern(ref); err != nil {
				return "", "", err
			}
		}
		return "journald", ref, nil
	case "file":
		path, err := validatePath(ref)
		return "file", path, err
	case "container":
		if ref == "" {
			return "", "", invalid("container source needs an id")
		}
		return "container", ref, nil
	default:
		return "", "", invalid("unknown log source kind %q", kind)
	}
}

// parseSince accepts an absolute RFC3339 stamp or a relative window like
// "-2h", because both shapes reach the agent from different UI controls.
func parseSince(value string) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed, nil
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds > 0 {
		return time.Unix(seconds, 0), nil
	}

	window := strings.TrimPrefix(value, "-")
	elapsed, err := time.ParseDuration(window)
	if err != nil {
		return time.Time{}, invalid("since must be an RFC3339 timestamp or a duration like 2h")
	}
	return time.Now().Add(-elapsed), nil
}

// journalSince renders a timestamp in the only form journalctl parses
// unambiguously across versions.
func journalSince(value string) (string, error) {
	parsed, err := parseSince(value)
	if err != nil {
		return "", err
	}
	return parsed.Local().Format("2006-01-02 15:04:05"), nil
}
