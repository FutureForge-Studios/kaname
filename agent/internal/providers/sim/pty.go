package sim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The fake shell.
 *
 * This is the one place the real provider hands a caller free-form
 * execution, so the simulation has to answer in kind — but over the
 * in-memory filesystem rather than a process. It speaks enough of a
 * terminal to convince xterm.js: it echoes what you type, handles
 * backspace, Ctrl+C and Ctrl+D, swallows arrow keys instead of printing
 * escape garbage, and colours its output.
 *
 * There is still no command string anywhere in the RPC surface: what
 * arrives here is keystrokes on a stream that the control plane has
 * separately permissioned, ticketed and recorded (KD-013).
 * ------------------------------------------------------------------ */

const (
	ctrlC     = 0x03
	ctrlD     = 0x04
	ctrlL     = 0x0c
	ctrlU     = 0x15
	backspace = 0x7f
	esc       = 0x1b
)

// ANSI colours, kept in one place so the shell and `ls` cannot drift.
const (
	ansiReset  = "\x1b[0m"
	ansiDir    = "\x1b[1;34m"
	ansiLink   = "\x1b[1;36m"
	ansiExec   = "\x1b[1;32m"
	ansiArchiv = "\x1b[1;31m"
	ansiUser   = "\x1b[1;32m"
	ansiRoot   = "\x1b[1;31m"
	ansiDim    = "\x1b[2m"
	ansiWarn   = "\x1b[33m"
	ansiErr    = "\x1b[31m"
	ansiBold   = "\x1b[1m"
)

type ptySession struct {
	sim   *Sim
	fs    *memfs
	who   string
	user  string
	pid   int
	start time.Time

	mu       sync.Mutex
	cwd      string
	previous string
	cols     int
	rows     int
	cancel   context.CancelFunc

	line   []rune
	escape int
}

func newPtySession(s *Sim, fs *memfs, who, cwd string, cols, rows int) *ptySession {
	user, _, _ := strings.Cut(who, "@")
	if cwd == "" {
		cwd = "/root"
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}

	return &ptySession{
		sim:      s,
		fs:       fs,
		who:      who,
		user:     user,
		pid:      4000 + int(mix(s.seed^uint64(time.Now().UnixNano()))%20000),
		start:    time.Now().UTC(),
		cwd:      cwd,
		previous: cwd,
		cols:     cols,
		rows:     rows,
	}
}

func (p *ptySession) resize(cols, rows int) {
	p.mu.Lock()
	p.cols, p.rows = cols, rows
	p.mu.Unlock()
}

func (p *ptySession) stop() {
	p.mu.Lock()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

/* -------------------------------- loop ------------------------------- */

func (p *ptySession) run(ctx context.Context, stream providers.Stream) (int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	p.mu.Lock()
	p.cancel = cancel
	p.mu.Unlock()

	if err := p.write(ctx, stream, p.banner()+p.prompt()); err != nil {
		return p.pid, err
	}

	for {
		chunk, err := stream.Recv(ctx)
		if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
			return p.pid, nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return p.pid, nil
			}
			return p.pid, fmt.Errorf("read terminal input: %w", err)
		}

		out, quit := p.consume(chunk)
		if out != "" {
			if err := p.write(ctx, stream, out); err != nil {
				return p.pid, err
			}
		}
		if quit {
			return p.pid, nil
		}
	}
}

func (p *ptySession) write(ctx context.Context, stream providers.Stream, text string) error {
	if text == "" {
		return nil
	}
	return stream.Send(ctx, []byte(text), providers.EncodingBase64)
}

// consume feeds one chunk of keystrokes through the line editor and
// returns everything the terminal should render for them.
func (p *ptySession) consume(chunk []byte) (string, bool) {
	var out strings.Builder

	for _, b := range chunk {
		// Arrow keys and friends arrive as escape sequences; a terminal
		// that printed them raw would look broken, so they are swallowed.
		if p.escape > 0 {
			p.escape--
			if p.escape == 0 && !(b >= '@' && b <= '~') {
				p.escape = 1
			}
			continue
		}

		switch b {
		case esc:
			p.escape = 2
		case '\r', '\n':
			line := strings.TrimSpace(string(p.line))
			p.line = p.line[:0]
			out.WriteString("\r\n")

			if line == "exit" || line == "logout" {
				out.WriteString("logout\r\n")
				return out.String(), true
			}
			out.WriteString(p.execute(line))
			out.WriteString(p.prompt())
		case backspace, 0x08:
			if len(p.line) > 0 {
				p.line = p.line[:len(p.line)-1]
				out.WriteString("\b \b")
			}
		case ctrlC:
			p.line = p.line[:0]
			out.WriteString("^C\r\n" + p.prompt())
		case ctrlD:
			if len(p.line) == 0 {
				out.WriteString("exit\r\n")
				return out.String(), true
			}
		case ctrlU:
			for range p.line {
				out.WriteString("\b \b")
			}
			p.line = p.line[:0]
		case ctrlL:
			out.WriteString("\x1b[2J\x1b[H" + p.prompt() + string(p.line))
		case '\t':
			// No completion; a tab that moved the cursor without completing
			// anything would be worse than one that does nothing.
		default:
			if b < 0x20 {
				continue
			}
			p.line = append(p.line, rune(b))
			out.WriteByte(b)
		}
	}

	return out.String(), false
}

func (p *ptySession) banner() string {
	host := p.sim.id.hostname
	return fmt.Sprintf("Linux %s %s #1 SMP PREEMPT_DYNAMIC x86_64\r\n\r\n"+
		ansiDim+"This is a simulated host. Nothing you type here reaches a real machine."+ansiReset+"\r\n"+
		"Type "+ansiBold+"help"+ansiReset+" for the commands it understands.\r\n\r\n", host, p.sim.id.kernel)
}

func (p *ptySession) prompt() string {
	p.mu.Lock()
	cwd := p.cwd
	p.mu.Unlock()

	colour, sigil := ansiUser, "$"
	if p.user == "root" {
		colour, sigil = ansiRoot, "#"
	}
	if cwd == "/root" || cwd == "/home/"+p.user {
		cwd = "~"
	}
	return fmt.Sprintf("%s%s%s:%s%s%s%s ", colour, p.who, ansiReset, ansiDir, cwd, ansiReset, sigil)
}

/* ------------------------------ commands ----------------------------- */

func (p *ptySession) execute(line string) string {
	if line == "" {
		return ""
	}

	argv := splitArgs(line)
	if len(argv) == 0 {
		return ""
	}

	switch argv[0] {
	case "help":
		return p.help()
	case "pwd":
		return p.currentDir() + "\r\n"
	case "whoami":
		return p.user + "\r\n"
	case "hostname":
		return p.sim.id.hostname + "\r\n"
	case "clear":
		return "\x1b[2J\x1b[H"
	case "echo":
		return strings.Join(argv[1:], " ") + "\r\n"
	case "cd":
		return p.cd(argv[1:])
	case "ls", "ll", "dir":
		if argv[0] == "ll" {
			argv = append([]string{"ls", "-l"}, argv[1:]...)
		}
		return p.ls(argv[1:])
	case "cat":
		return p.cat(argv[1:])
	case "tail":
		return p.tail(argv[1:])
	case "uname":
		return p.uname(argv[1:])
	case "uptime":
		return p.uptime()
	case "df":
		return p.df(argv[1:])
	case "free":
		return p.free(argv[1:])
	case "ps":
		return p.ps(argv[1:])
	case "systemctl":
		return p.systemctl(argv[1:])
	case "exit", "logout":
		return ""
	default:
		return fmt.Sprintf("%sbash: %s: command not found%s\r\n", ansiErr, argv[0], ansiReset)
	}
}

func (p *ptySession) help() string {
	rows := [][2]string{
		{"cd [dir]", "change directory (- goes back)"},
		{"ls [-l] [-a] [path]", "list a directory"},
		{"pwd", "print the working directory"},
		{"cat <file>...", "print a file"},
		{"tail [-n N] <file>", "print the end of a file or log"},
		{"echo <text>", "print text"},
		{"whoami", "print the current user"},
		{"uname [-a|-r|-s]", "print kernel information"},
		{"uptime", "how long the host has been up"},
		{"df [-h]", "filesystem usage"},
		{"free [-h]", "memory usage"},
		{"ps [aux]", "process table"},
		{"systemctl status <unit>", "unit state"},
		{"clear", "clear the screen"},
		{"exit", "close the session"},
	}

	var b strings.Builder
	b.WriteString(ansiBold + "Available commands" + ansiReset + "\r\n")
	for _, row := range rows {
		fmt.Fprintf(&b, "  %s%-26s%s %s\r\n", ansiExec, row[0], ansiReset, row[1])
	}
	return b.String()
}

func (p *ptySession) currentDir() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cwd
}

func (p *ptySession) resolve(arg string) string {
	cwd := p.currentDir()
	switch {
	case arg == "" || arg == "~":
		if p.user == "root" {
			return "/root"
		}
		return "/home/" + p.user
	case strings.HasPrefix(arg, "~/"):
		home := "/root"
		if p.user != "root" {
			home = "/home/" + p.user
		}
		return path.Join(home, arg[2:])
	case strings.HasPrefix(arg, "/"):
		return path.Clean(arg)
	default:
		return path.Join(cwd, arg)
	}
}

func (p *ptySession) cd(args []string) string {
	target := ""
	if len(args) > 0 {
		target = args[0]
	}
	if target == "-" {
		p.mu.Lock()
		p.cwd, p.previous = p.previous, p.cwd
		next := p.cwd
		p.mu.Unlock()
		return next + "\r\n"
	}

	resolved := p.resolve(target)

	p.fs.mu.RLock()
	n, actual, err := p.fs.lookup(resolved, true)
	p.fs.mu.RUnlock()

	if err != nil {
		return fmt.Sprintf("%sbash: cd: %s: No such file or directory%s\r\n", ansiErr, resolved, ansiReset)
	}
	if n.kind != "directory" {
		return fmt.Sprintf("%sbash: cd: %s: Not a directory%s\r\n", ansiErr, resolved, ansiReset)
	}

	p.mu.Lock()
	p.previous, p.cwd = p.cwd, actual
	p.mu.Unlock()
	return ""
}

func (p *ptySession) ls(args []string) string {
	long, all, target := false, false, ""
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			long = long || strings.ContainsRune(arg, 'l')
			all = all || strings.ContainsAny(arg, "aA")
			continue
		}
		target = arg
	}

	resolved := p.resolve(target)
	if target == "" {
		resolved = p.currentDir()
	}

	p.fs.mu.RLock()
	defer p.fs.mu.RUnlock()

	n, actual, err := p.fs.lookup(resolved, true)
	if err != nil {
		return fmt.Sprintf("%sls: cannot access '%s': No such file or directory%s\r\n", ansiErr, resolved, ansiReset)
	}
	if n.kind != "directory" {
		return renderEntry(p.fs.entry(n, actual), long) + "\r\n"
	}

	entries := make([]providers.FileEntry, 0, len(n.children))
	for name, child := range n.children {
		if !all && strings.HasPrefix(name, ".") {
			continue
		}
		entries = append(entries, p.fs.entry(child, path.Join(actual, name)))
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	var b strings.Builder
	if long {
		fmt.Fprintf(&b, "total %d\r\n", len(entries)*4)
		for _, entry := range entries {
			b.WriteString(renderEntry(entry, true) + "\r\n")
		}
		return b.String()
	}

	// Four columns is what an 80-column terminal fits comfortably.
	const columns = 4
	width := 0
	for _, entry := range entries {
		width = max(width, len(entry.Name))
	}
	for i, entry := range entries {
		fmt.Fprintf(&b, "%s%-*s%s  ", colourFor(entry), width, entry.Name, ansiReset)
		if (i+1)%columns == 0 {
			b.WriteString("\r\n")
		}
	}
	if len(entries)%columns != 0 {
		b.WriteString("\r\n")
	}
	return b.String()
}

func renderEntry(entry providers.FileEntry, long bool) string {
	if !long {
		return colourFor(entry) + entry.Name + ansiReset
	}

	modified, err := time.Parse(time.RFC3339Nano, entry.ModifiedAt)
	if err != nil {
		modified = time.Now().UTC()
	}
	name := colourFor(entry) + entry.Name + ansiReset
	if entry.Kind == "symlink" && entry.LinkTarget != nil {
		name += " -> " + *entry.LinkTarget
	}

	return fmt.Sprintf("%s %2d %-9s %-9s %8d %s %s",
		modeString(entry.Kind, entry.Mode),
		linkCount(entry),
		entry.Owner, entry.Group, entry.Size,
		modified.Format("Jan  2 15:04"), name)
}

func linkCount(entry providers.FileEntry) int {
	if entry.Kind == "directory" && entry.ChildCount != nil {
		return *entry.ChildCount + 2
	}
	return 1
}

func modeString(kind, octal string) string {
	prefix := "-"
	switch kind {
	case "directory":
		prefix = "d"
	case "symlink":
		prefix = "l"
	case "socket":
		prefix = "s"
	case "fifo":
		prefix = "p"
	case "device":
		prefix = "c"
	}

	digits := octal
	if len(digits) == 4 {
		digits = digits[1:]
	}
	for len(digits) < 3 {
		digits = "0" + digits
	}

	var b strings.Builder
	b.WriteString(prefix)
	for _, digit := range digits {
		value := int(digit - '0')
		for _, bit := range [3]struct {
			mask   int
			letter string
		}{{4, "r"}, {2, "w"}, {1, "x"}} {
			if value&bit.mask != 0 {
				b.WriteString(bit.letter)
			} else {
				b.WriteString("-")
			}
		}
	}
	return b.String()
}

func colourFor(entry providers.FileEntry) string {
	switch {
	case entry.Kind == "directory":
		return ansiDir
	case entry.Kind == "symlink":
		return ansiLink
	case strings.HasPrefix(entry.Mode, "07") || strings.HasSuffix(entry.Mode, "755") || strings.HasSuffix(entry.Mode, "775"):
		if entry.Kind == "file" {
			return ansiExec
		}
	}
	switch path.Ext(entry.Name) {
	case ".gz", ".zst", ".zip", ".tar", ".deb":
		return ansiArchiv
	}
	return ""
}

func (p *ptySession) cat(args []string) string {
	if len(args) == 0 {
		return "usage: cat <file>...\r\n"
	}

	var b strings.Builder
	for _, arg := range args {
		resolved := p.resolve(arg)

		p.fs.mu.RLock()
		n, _, err := p.fs.lookup(resolved, true)
		p.fs.mu.RUnlock()

		switch {
		case err != nil:
			fmt.Fprintf(&b, "%scat: %s: No such file or directory%s\r\n", ansiErr, resolved, ansiReset)
		case n.kind == "directory":
			fmt.Fprintf(&b, "%scat: %s: Is a directory%s\r\n", ansiErr, resolved, ansiReset)
		case n.virtual > int64(len(n.data)):
			if stream := p.sim.logStreamForPath(resolved); stream != nil {
				b.WriteString(p.renderLogLines(stream, 20))
				continue
			}
			fmt.Fprintf(&b, "%scat: %s: binary file (%d bytes)%s\r\n", ansiWarn, resolved, n.size(), ansiReset)
		default:
			b.WriteString(crlf(string(n.data)))
		}
	}
	return b.String()
}

func (p *ptySession) tail(args []string) string {
	lines, target := 10, ""
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "-n" && i+1 < len(args):
			if parsed, err := strconv.Atoi(args[i+1]); err == nil {
				lines = parsed
			}
			i++
		case strings.HasPrefix(args[i], "-n"):
			if parsed, err := strconv.Atoi(strings.TrimPrefix(args[i], "-n")); err == nil {
				lines = parsed
			}
		case strings.HasPrefix(args[i], "-f"):
			// Following would hold the line editor hostage; the Logs module
			// is where a live tail belongs.
		default:
			target = args[i]
		}
	}
	if target == "" {
		return "usage: tail [-n lines] <file>\r\n"
	}
	if lines < 1 || lines > 500 {
		lines = 10
	}

	resolved := p.resolve(target)
	if stream := p.sim.logStreamForPath(resolved); stream != nil {
		return p.renderLogLines(stream, lines)
	}

	p.fs.mu.RLock()
	n, _, err := p.fs.lookup(resolved, true)
	p.fs.mu.RUnlock()
	if err != nil {
		return fmt.Sprintf("%stail: cannot open '%s' for reading: No such file or directory%s\r\n", ansiErr, resolved, ansiReset)
	}
	if n.virtual > int64(len(n.data)) {
		return fmt.Sprintf("%stail: %s: binary file (%d bytes)%s\r\n", ansiWarn, resolved, n.size(), ansiReset)
	}

	all := strings.Split(strings.TrimRight(string(n.data), "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return crlf(strings.Join(all, "\n") + "\n")
}

// renderLogLines lets `cat` and `tail` reach the generated log streams, so
// /var/log/nginx/access.log is not a dead blob in the terminal.
func (p *ptySession) renderLogLines(stream *logStream, lines int) string {
	origin := p.sim.logOrigin()
	last := stream.indexAt(origin, time.Now().UTC())
	first := last - int64(lines)
	if first < 0 {
		first = 0
	}

	var b strings.Builder
	for n := first; n <= last; n++ {
		record := stream.render(p.sim, n, stream.at(origin, n))
		colour := ""
		switch record.Level {
		case "warn":
			colour = ansiWarn
		case "error":
			colour = ansiErr
		}
		fmt.Fprintf(&b, "%s%s%s\r\n", colour, record.Message, ansiReset)
	}
	return b.String()
}

func (s *Sim) logStreamForPath(p string) *logStream {
	byPath := map[string]string{
		"/var/log/nginx/access.log": sourceNginxAccess,
		"/var/log/nginx/error.log":  sourceNginxError,
		"/var/log/syslog":           sourceSyslog,
		"/var/log/auth.log":         sourceAuth,
		"/var/log/mail.log":         sourceMail,
	}
	id, ok := byPath[p]
	if !ok {
		return nil
	}
	stream, err := s.streamFor(id)
	if err != nil {
		return nil
	}
	return stream
}

func (p *ptySession) uname(args []string) string {
	id := p.sim.id
	if len(args) == 0 {
		return "Linux\r\n"
	}
	switch args[0] {
	case "-a":
		return fmt.Sprintf("Linux %s %s #1 SMP PREEMPT_DYNAMIC Debian 6.1.76-1 (2024-02-01) x86_64 GNU/Linux\r\n", id.hostname, id.kernel)
	case "-r":
		return id.kernel + "\r\n"
	case "-n":
		return id.hostname + "\r\n"
	case "-m":
		return "x86_64\r\n"
	case "-s":
		return "Linux\r\n"
	default:
		return "Linux\r\n"
	}
}

func (p *ptySession) uptime() string {
	now := time.Now().UTC()
	sample := p.sim.sample(now)

	p.sim.mu.Lock()
	boot := p.sim.bootTime
	sessions := len(p.sim.sshSessions)
	p.sim.mu.Unlock()

	up := now.Sub(boot)
	days := int(up.Hours()) / 24
	hours := int(up.Hours()) % 24
	minutes := int(up.Minutes()) % 60

	return fmt.Sprintf(" %s up %d days, %2d:%02d,  %d users,  load average: %.2f, %.2f, %.2f\r\n",
		now.Format("15:04:05"), days, hours, minutes, sessions, sample.Load1, sample.Load5, sample.Load15)
}

func (p *ptySession) df(args []string) string {
	human := len(args) > 0 && strings.ContainsRune(strings.Join(args, ""), 'h')
	disks := p.sim.disks(time.Now().UTC())

	var b strings.Builder
	fmt.Fprintf(&b, "%-18s %10s %10s %10s %5s %s\r\n", "Filesystem", sizeHeader(human), "Used", "Avail", "Use%", "Mounted on")
	for _, disk := range disks {
		fmt.Fprintf(&b, "%-18s %10s %10s %10s %4.0f%% %s\r\n",
			disk.Device,
			blockSize(disk.Total, human), blockSize(disk.Used, human), blockSize(disk.Available, human),
			disk.UsedPercent, disk.Mount)
	}
	return b.String()
}

func sizeHeader(human bool) string {
	if human {
		return "Size"
	}
	return "1K-blocks"
}

func blockSize(bytes int64, human bool) string {
	if human {
		return humanBytes(bytes)
	}
	return strconv.FormatInt(bytes/kiB, 10)
}

func humanBytes(bytes int64) string {
	switch {
	case bytes >= giB:
		return fmt.Sprintf("%.1fG", float64(bytes)/float64(giB))
	case bytes >= miB:
		return fmt.Sprintf("%.1fM", float64(bytes)/float64(miB))
	case bytes >= kiB:
		return fmt.Sprintf("%.1fK", float64(bytes)/float64(kiB))
	default:
		return strconv.FormatInt(bytes, 10)
	}
}

func (p *ptySession) free(args []string) string {
	human := strings.ContainsRune(strings.Join(args, ""), 'h')
	sample := p.sim.sample(time.Now().UTC())

	cached := int64(0)
	if sample.MemoryCached != nil {
		cached = *sample.MemoryCached
	}
	free := sample.MemoryTotal - sample.MemoryUsed - cached
	if free < 0 {
		free = 0
	}

	format := func(v int64) string {
		if human {
			return humanBytes(v)
		}
		return strconv.FormatInt(v/kiB, 10)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%15s %11s %11s %11s %11s %11s\r\n", "total", "used", "free", "shared", "buff/cache", "available")
	fmt.Fprintf(&b, "Mem:   %8s %11s %11s %11s %11s %11s\r\n",
		format(sample.MemoryTotal), format(sample.MemoryUsed), format(free),
		format(sample.MemoryTotal/64), format(cached), format(free+cached))
	fmt.Fprintf(&b, "Swap:  %8s %11s %11s\r\n",
		format(sample.SwapTotal), format(sample.SwapUsed), format(sample.SwapTotal-sample.SwapUsed))
	return b.String()
}

func (p *ptySession) ps(args []string) string {
	full := strings.ContainsAny(strings.Join(args, ""), "aeuxf")
	now := time.Now().UTC()

	p.sim.mu.Lock()
	rows := make([]providers.ProcessInfo, 0, len(p.sim.procs))
	for _, proc := range p.sim.procs {
		rows = append(rows, p.sim.live(proc, now))
	}
	total := len(rows)
	p.sim.mu.Unlock()

	sortProcesses(rows, "cpu")
	limit := 24
	if !full {
		limit = 6
	}
	if len(rows) > limit {
		rows = rows[:limit]
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s%-9s %6s %5s %5s %8s %-8s %s%s\r\n", ansiBold, "USER", "PID", "%CPU", "%MEM", "RSS", "STAT", "COMMAND", ansiReset)
	for _, row := range rows {
		fmt.Fprintf(&b, "%-9s %6d %5.1f %5.1f %8d %-8s %s\r\n",
			truncateText(row.User, 9), row.PID, row.CPUPercent, row.MemoryPercent,
			row.MemoryRSS/kiB, statLetter(row.State), truncateText(row.Cmdline, 46))
	}
	if !full {
		fmt.Fprintf(&b, "%s(showing %d of %d; try `ps aux`)%s\r\n", ansiDim, len(rows), total, ansiReset)
	}
	return b.String()
}

func statLetter(state string) string {
	switch state {
	case "running":
		return "R"
	case "sleeping":
		return "S"
	case "disk_sleep":
		return "D"
	case "stopped":
		return "T"
	case "zombie":
		return "Z"
	case "idle":
		return "I"
	default:
		return "?"
	}
}

func (p *ptySession) systemctl(args []string) string {
	if len(args) == 0 {
		return "systemctl: try `systemctl status <unit>`\r\n"
	}
	if args[0] != "status" || len(args) < 2 {
		return fmt.Sprintf("%ssystemctl: only `status <unit>` is available in this shell%s\r\n", ansiWarn, ansiReset)
	}

	name := args[1]
	if !strings.Contains(name, ".") {
		name += ".service"
	}

	p.sim.mu.Lock()
	u := p.sim.findUnitLocked(name)
	if u == nil {
		p.sim.mu.Unlock()
		return fmt.Sprintf("%sUnit %s could not be found.%s\r\n", ansiErr, name, ansiReset)
	}
	info := u.info
	pids := []providers.ProcessInfo{}
	for _, proc := range p.sim.procs {
		if proc.unit == name {
			pids = append(pids, proc.info)
		}
	}
	p.sim.mu.Unlock()

	dot, colour := "●", ansiExec
	switch info.ActiveState {
	case "failed":
		colour = ansiErr
	case "inactive":
		colour = ansiDim
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s%s%s %s - %s\r\n", colour, dot, ansiReset, info.Unit, info.Description)
	fmt.Fprintf(&b, "     Loaded: %s (/lib/systemd/system/%s; %s; preset: enabled)\r\n",
		info.LoadState, info.Unit, enabledWord(info.Enabled))

	since := "n/a"
	if info.ActiveSince != nil {
		if parsed, err := time.Parse(time.RFC3339Nano, *info.ActiveSince); err == nil {
			since = fmt.Sprintf("%s; %s ago", parsed.Format("Mon 2006-01-02 15:04:05 MST"), humanDuration(time.Since(parsed)))
		}
	}
	fmt.Fprintf(&b, "     Active: %s%s (%s)%s since %s\r\n", colour, info.ActiveState, info.SubState, ansiReset, since)

	if info.MainPID != nil {
		fmt.Fprintf(&b, "   Main PID: %d\r\n", *info.MainPID)
	}
	if info.MemoryCurrent != nil {
		fmt.Fprintf(&b, "     Memory: %s\r\n", humanBytes(*info.MemoryCurrent))
	}
	fmt.Fprintf(&b, "      Tasks: %d\r\n", len(pids))

	if len(pids) > 0 {
		fmt.Fprintf(&b, "     CGroup: /system.slice/%s\r\n", info.Unit)
		for i, proc := range pids {
			branch := "├─"
			if i == len(pids)-1 {
				branch = "└─"
			}
			fmt.Fprintf(&b, "             %s%d %s\r\n", branch, proc.PID, truncateText(proc.Cmdline, 52))
		}
	}
	return b.String()
}

func enabledWord(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

/* ------------------------------- helpers ----------------------------- */

// splitArgs handles the quoting a shell user expects without pretending
// to be a shell: no expansion, no substitution, no operators.
func splitArgs(line string) []string {
	var args []string
	var current strings.Builder
	quote := rune(0)

	for _, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
				continue
			}
			current.WriteRune(r)
		case r == '\'' || r == '"':
			quote = r
		case r == ' ' || r == '\t':
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}

// crlf converts to the line endings a raw terminal needs; a bare \n
// leaves the cursor in the middle of the screen.
func crlf(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
}

func truncateText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit-1] + "…"
}

/* --------------------------------- pty ------------------------------- */

type simPTY struct{ *Sim }

func (s simPTY) Open(ctx context.Context, sessionID string, p providers.PtyOpenParams, stream providers.Stream) (providers.PtyOpenResult, error) {
	user := p.User
	if user == "" {
		user = "root"
	}
	cwd := p.Cwd
	if cwd == "" {
		cwd = "/root"
		if user != "root" {
			cwd = "/home/" + user
		}
	}

	session := newPtySession(s.Sim, s.fs, user+"@"+shortHost(s.Sim), cwd, p.Cols, p.Rows)

	s.mu.Lock()
	s.ptys[sessionID] = session
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.ptys, sessionID)
		s.mu.Unlock()
	}()

	pid, err := session.run(ctx, stream)
	return providers.PtyOpenResult{PID: pid}, err
}

func (s simPTY) Resize(_ context.Context, sessionID string, p providers.PtyResizeParams) error {
	s.mu.Lock()
	session := s.ptys[sessionID]
	s.mu.Unlock()

	if session == nil {
		return fmt.Errorf("terminal session %s: %w", sessionID, providers.ErrNotFound)
	}
	session.resize(p.Cols, p.Rows)
	return nil
}

func (s simPTY) Close(_ context.Context, sessionID string) error {
	s.mu.Lock()
	session := s.ptys[sessionID]
	delete(s.ptys, sessionID)
	s.mu.Unlock()

	if session == nil {
		return fmt.Errorf("terminal session %s: %w", sessionID, providers.ErrNotFound)
	}
	session.stop()
	return nil
}
