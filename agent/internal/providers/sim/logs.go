package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Logs.
 *
 * Lines are a pure function of (source, index): line n happens at a
 * time derived from the source's rate plus a deterministic jitter, and
 * its contents come from the same seed. That gives three properties at
 * once — history reaches arbitrarily far back without a ring buffer, a
 * follow-tail produces a few lines a second in real time, and two runs
 * on the same host produce the same log.
 *
 * The wire format is newline-delimited JSON records, which is what the
 * control plane's decoder expects; a chunk boundary mid-record is safe
 * because it reassembles on newlines.
 * ------------------------------------------------------------------ */

const (
	sourceJournal     = "journal"
	sourceSyslog      = "syslog"
	sourceAuth        = "auth"
	sourceNginxAccess = "nginx-access"
	sourceNginxError  = "nginx-error"
	sourceMail        = "mail"
	sourceContainer   = "container"
)

// logStream is one generator: a rate and a renderer.
type logStream struct {
	id     string
	label  string
	kind   string
	ref    string
	size   int64
	rate   float64
	render func(s *Sim, n int64, at time.Time) providers.LogRecord
}

// at places line n on the clock. The jitter stays inside the interval so
// the sequence is still strictly increasing.
func (g *logStream) at(origin time.Time, n int64) time.Time {
	seed := hashString(g.id)
	step := float64(n) / g.rate
	jitter := 0.4 * lattice(seed, n) / g.rate
	return origin.Add(time.Duration((step + jitter) * float64(time.Second)))
}

func (g *logStream) indexAt(origin time.Time, t time.Time) int64 {
	n := int64(t.Sub(origin).Seconds() * g.rate)
	if n < 0 {
		return 0
	}
	return n
}

/* ------------------------------ catalogue ---------------------------- */

func (s *Sim) logStreams() []*logStream {
	streams := []*logStream{
		{id: sourceJournal, label: "systemd journal", kind: "journald", ref: "*", size: 117_440_512, rate: 1.6, render: renderJournal("")},
		{id: sourceSyslog, label: "/var/log/syslog", kind: "file", ref: "/var/log/syslog", size: 18_432_112, rate: 0.9, render: renderSyslog},
		{id: sourceAuth, label: "/var/log/auth.log", kind: "file", ref: "/var/log/auth.log", size: 2_884_213, rate: 0.35, render: renderAuth},
		{id: sourceNginxAccess, label: "nginx access", kind: "nginx_access", ref: "/var/log/nginx/access.log", size: 214_884_112, rate: 3.4, render: renderNginxAccess},
		{id: sourceNginxError, label: "nginx error", kind: "nginx_error", ref: "/var/log/nginx/error.log", size: 4_118_223, rate: 0.14, render: renderNginxError},
		{id: sourceMail, label: "mail transport", kind: "mail", ref: "/var/log/mail.log", size: 9_442_881, rate: 0.6, render: renderMail},
	}

	s.mu.Lock()
	for _, c := range s.containers {
		if c.info.State != "running" {
			continue
		}
		streams = append(streams, containerStream(c.info.Name, c.info.Image))
	}
	s.mu.Unlock()

	return streams
}

func containerStream(name, image string) *logStream {
	return &logStream{
		id:     sourceContainer + ":" + name,
		label:  "container " + name,
		kind:   "container",
		ref:    name,
		size:   12_884_901,
		rate:   0.45,
		render: renderContainer(name, image),
	}
}

// streamFor resolves a source id. `journal:<unit>` narrows the journal to
// one unit, which is what service.logs needs.
func (s *Sim) streamFor(id string) (*logStream, error) {
	if unit, ok := strings.CutPrefix(id, sourceJournal+":"); ok {
		return &logStream{
			id: id, label: "journal " + unit, kind: "journald", ref: unit,
			size: 12_582_912, rate: 0.5, render: renderJournal(unit),
		}, nil
	}
	if name, ok := strings.CutPrefix(id, sourceContainer+":"); ok {
		s.mu.Lock()
		c := s.findContainerLocked(name)
		s.mu.Unlock()
		if c == nil {
			return nil, fmt.Errorf("log source %s: %w", id, providers.ErrNotFound)
		}
		return containerStream(c.info.Name, c.info.Image), nil
	}
	for _, stream := range s.logStreams() {
		if stream.id == id {
			return stream, nil
		}
	}
	return nil, fmt.Errorf("log source %s: %w", id, providers.ErrNotFound)
}

/* ------------------------------- tailing ----------------------------- */

type tailRequest struct {
	source    string
	unit      string
	container string
	lines     int
	follow    bool
	level     string
	query     string
	since     string
}

// tail returns the backlog for a settled read, and streams backlog then
// live lines for a follow. It never does both: the control plane prefers
// streamed records over the settled result, so sending each line once
// keeps the two paths from disagreeing.
func (s *Sim) tail(ctx context.Context, stream providers.Stream, req tailRequest) ([]providers.LogRecord, error) {
	id := req.source
	switch {
	case req.unit != "":
		id = sourceJournal + ":" + req.unit
	case req.container != "":
		id = sourceContainer + ":" + req.container
	}

	generator, err := s.streamFor(id)
	if err != nil {
		return nil, err
	}

	lines := req.lines
	if lines <= 0 {
		lines = 200
	}
	origin := s.logOrigin()
	now := time.Now().UTC()
	last := generator.indexAt(origin, now)

	first := last - int64(lines)
	if since, err := time.Parse(time.RFC3339, req.since); req.since != "" && err == nil {
		if from := generator.indexAt(origin, since.UTC()); from > first {
			first = from
		}
	}
	if first < 0 {
		first = 0
	}

	backlog := make([]providers.LogRecord, 0, lines)
	for n := first; n <= last; n++ {
		record := generator.render(s, n, generator.at(origin, n))
		if !matchesFilter(record, req.level, req.query) {
			continue
		}
		backlog = append(backlog, record)
	}

	if !req.follow {
		return backlog, nil
	}

	for _, record := range backlog {
		if err := sendRecord(ctx, stream, record); err != nil {
			return nil, err
		}
	}

	for n := last + 1; ; n++ {
		at := generator.at(origin, n)
		if wait := time.Until(at); wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		record := generator.render(s, n, at)
		if !matchesFilter(record, req.level, req.query) {
			continue
		}
		if err := sendRecord(ctx, stream, record); err != nil {
			return nil, err
		}
	}
}

// logOrigin anchors line zero. Using the boot time means the journal
// reaches back exactly as far as the host has been up, like a real one.
func (s *Sim) logOrigin() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bootTime
}

func sendRecord(ctx context.Context, stream providers.Stream, record providers.LogRecord) error {
	payload, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode log record: %w", err)
	}
	return stream.Send(ctx, append(payload, '\n'), providers.EncodingUTF8)
}

func matchesFilter(record providers.LogRecord, level, query string) bool {
	if level != "" && record.Level != level {
		return false
	}
	if query != "" && !strings.Contains(strings.ToLower(record.Message), strings.ToLower(query)) {
		return false
	}
	return true
}

/* -------------------------------- logs ------------------------------- */

type simLogs struct{ *Sim }

func (s simLogs) Sources(context.Context) ([]providers.LogSource, error) {
	streams := s.logStreams()
	out := make([]providers.LogSource, 0, len(streams))
	for _, stream := range streams {
		out = append(out, providers.LogSource{
			ID:             stream.id,
			Label:          stream.label,
			Kind:           stream.kind,
			Ref:            stream.ref,
			Size:           ptr(stream.size),
			SupportsFollow: true,
		})
	}
	return out, nil
}

func (s simLogs) Tail(ctx context.Context, p providers.LogTailParams, stream providers.Stream) ([]providers.LogRecord, error) {
	return s.tail(ctx, stream, tailRequest{
		source: p.Source,
		lines:  p.Lines,
		follow: p.Follow,
		level:  p.Level,
		query:  p.Query,
		since:  p.Since,
	})
}

/* ----------------------------- renderers ----------------------------- */

// pickLevel weights the distribution the way a healthy host reads:
// mostly information, a steady trickle of warnings, the occasional error.
func pickLevel(seed uint64, n int64) string {
	roll := (lattice(seed, n) + 1) / 2
	switch {
	case roll < 0.005:
		return "debug"
	case roll < 0.83:
		return "info"
	case roll < 0.90:
		return "notice"
	case roll < 0.972:
		return "warn"
	default:
		return "error"
	}
}

var journalUnits = []string{
	"nginx", "postgresql@16-main", "dockerd", "containerd", "postfix/smtpd",
	"dovecot", "sshd", "CRON", "systemd", "fail2ban.actions", "kanamed", "systemd-timesyncd",
}

func renderJournal(unit string) func(*Sim, int64, time.Time) providers.LogRecord {
	return func(s *Sim, n int64, at time.Time) providers.LogRecord {
		seed := hashString("journal|" + unit)
		name := unit
		if name == "" {
			name = pick(seed, n, journalUnits)
		}
		name = strings.TrimSuffix(name, ".service")

		level, message := journalMessage(s, seed, name, n)
		pid := 300 + int(mix(seed^uint64(n)^0x1a)%28000)

		return providers.LogRecord{
			Ts:      stamp(at),
			Level:   level,
			Source:  sourceJournal,
			Message: fmt.Sprintf("%s %s[%d]: %s", shortHost(s), name, pid, message),
			Fields: map[string]string{
				"_SYSTEMD_UNIT": name + ".service",
				"_PID":          fmt.Sprint(pid),
				"_HOSTNAME":     s.id.hostname,
			},
			Cursor: fmt.Sprintf("journal:%d", n),
		}
	}
}

func journalMessage(s *Sim, seed uint64, unit string, n int64) (string, string) {
	level := pickLevel(seed^0x9, n)

	switch unit {
	case "nginx":
		if level == "error" {
			return "error", fmt.Sprintf("upstream timed out (110: Connection timed out) while reading response header from upstream, client: %s", pick(seed, n, threatSources))
		}
		return level, pick(seed, n, []string{
			"signal process started",
			"reopening logs",
			"worker process " + fmt.Sprint(1200+n%40) + " exited with code 0",
			"gracefully shutting down worker",
		})
	case "postgresql@16-main":
		if level == "warn" {
			return "warn", fmt.Sprintf("checkpoints are occurring too frequently (%d seconds apart)", 18+n%12)
		}
		return level, pick(seed, n, []string{
			"checkpoint starting: time",
			fmt.Sprintf("checkpoint complete: wrote %d buffers (2.1%%)", 400+n%900),
			"automatic vacuum of table \"kaname.public.jobs\": index scans: 1",
			"received SIGHUP, reloading configuration files",
		})
	case "dockerd", "containerd":
		return level, pick(seed, n, []string{
			"loading containers: start.",
			fmt.Sprintf("shim disconnected id=%016x", mix(seed^uint64(n))),
			"API listen on /run/docker.sock",
			"cleaning up dead shim",
		})
	case "postfix/smtpd":
		return level, pick(seed, n, []string{
			fmt.Sprintf("connect from unknown[%s]", pick(seed, n, threatSources)),
			fmt.Sprintf("disconnect from mail-out.example.net[198.51.100.%d] ehlo=1 mail=1 rcpt=1 data=1 quit=1", 10+n%40),
			"NOQUEUE: reject: RCPT from unknown: 554 5.7.1 Relay access denied",
		})
	case "dovecot":
		return level, pick(seed, n, []string{
			fmt.Sprintf("imap-login: Login: user=<ops@%s>, method=PLAIN, rip=%s, lip=%s, TLS", s.id.mailDomain, s.id.privateIP, s.id.privateIP),
			fmt.Sprintf("imap(ops@%s): Logged out in=412 out=28194", s.id.mailDomain),
			"master: Warning: Growing pool of imap-login to 4 processes",
		})
	case "sshd":
		if level == "warn" || level == "error" {
			return "warn", fmt.Sprintf("Failed password for invalid user %s from %s port %d ssh2",
				pick(seed, n, []string{"admin", "test", "ubuntu", "oracle", "postgres"}),
				pick(seed, n, threatSources), 40000+n%20000)
		}
		return "info", fmt.Sprintf("Accepted publickey for deploy from %s port %d ssh2: ED25519 SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5o", s.id.privateIP, 50000+n%12000)
	case "CRON":
		return "info", fmt.Sprintf("(%s) CMD (%s)", pick(seed, n, []string{"root", "deploy"}), pick(seed, n, []string{
			"cd / && run-parts --report /etc/cron.hourly",
			"/usr/local/bin/kaname-nightly.sh >/dev/null 2>&1",
			"test -x /usr/sbin/anacron || run-parts --report /etc/cron.daily",
		}))
	case "fail2ban.actions":
		return "notice", fmt.Sprintf("[sshd] Ban %s", pick(seed, n, threatSources))
	case "kanamed":
		return level, pick(seed, n, []string{
			"metrics sample pushed",
			"connected url=wss://panel.kaname.internal/agent/v1/connect",
			"reconcile complete units=35 containers=6",
		})
	case "systemd-timesyncd":
		return "info", "Contacted time server 185.125.190.56:123 (ntp.ubuntu.com)."
	default:
		return level, pick(seed, n, []string{
			"Starting Daily apt download activities...",
			"Finished Daily apt download activities.",
			"Started Session " + fmt.Sprint(400+n%80) + " of User deploy.",
			"Reloading.",
		})
	}
}

var accessPaths = []string{
	"/", "/index.html", "/assets/app.css", "/assets/app.js", "/favicon.ico",
	"/api/v1/status", "/api/v1/servers", "/api/v1/jobs?page=1", "/robots.txt",
	"/blog/2026/08/shipping-kaname", "/pricing", "/docs/getting-started",
	"/wp-login.php", "/.env", "/admin/config.php", "/api/v1/metrics?range=24h",
}

var userAgents = []string{
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	"curl/8.5.0",
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"python-requests/2.32.3",
	"Go-http-client/2.0",
}

var visitorIPs = []string{
	"81.2.69.142", "24.48.0.1", "203.0.113.24", "198.51.100.77", "192.0.2.211",
	"91.198.174.192", "8.8.8.8", "45.33.32.156", "104.28.14.10", "34.107.221.82",
}

func renderNginxAccess(s *Sim, n int64, at time.Time) providers.LogRecord {
	seed := hashString(sourceNginxAccess)
	path := pick(seed, n, accessPaths)
	method := pick(seed^0x5, n, []string{"GET", "GET", "GET", "GET", "POST", "HEAD"})

	status := 200
	level := "info"
	switch {
	case strings.HasPrefix(path, "/wp-login") || path == "/.env" || strings.HasPrefix(path, "/admin"):
		status, level = 404, "warn"
	case mix(seed^uint64(n)^0x77)%50 == 0:
		status, level = 502, "error"
	case mix(seed^uint64(n)^0x31)%17 == 0:
		status = 304
	case method == "POST" && mix(seed^uint64(n))%9 == 0:
		status, level = 401, "warn"
	}

	client := pick(seed^0xa, n, visitorIPs)
	bytes := 180 + mix(seed^uint64(n)^0x44)%48_000
	referer := "-"
	if mix(seed^uint64(n)^0x55)%3 == 0 {
		referer = "https://" + s.id.domain + "/"
	}

	message := fmt.Sprintf(`%s - - [%s] "%s %s HTTP/1.1" %d %d "%s" "%s"`,
		client, at.Format("02/Jan/2006:15:04:05 -0700"), method, path, status, bytes, referer,
		pick(seed^0xb, n, userAgents))

	return providers.LogRecord{
		Ts:      stamp(at),
		Level:   level,
		Source:  sourceNginxAccess,
		Message: message,
		Fields: map[string]string{
			"status":      fmt.Sprint(status),
			"method":      method,
			"path":        path,
			"remote_addr": client,
		},
		Cursor: fmt.Sprintf("%s:%d", sourceNginxAccess, n),
	}
}

func renderNginxError(s *Sim, n int64, at time.Time) providers.LogRecord {
	seed := hashString(sourceNginxError)
	client := pick(seed, n, threatSources)
	pid := 1040 + int(mix(seed^uint64(n))%4)

	variants := []string{
		fmt.Sprintf(`*%d open() "/var/www/%s/public%s" failed (2: No such file or directory), client: %s, server: %s, request: "GET %s HTTP/1.1", host: "%s"`,
			30000+n, s.id.domain, pick(seed^0x2, n, []string{"/wp-login.php", "/.env", "/phpmyadmin/index.php"}), client, s.id.domain,
			pick(seed^0x2, n, []string{"/wp-login.php", "/.env", "/phpmyadmin/index.php"}), s.id.domain),
		fmt.Sprintf(`*%d upstream timed out (110: Connection timed out) while reading response header from upstream, client: %s, server: api.%s, request: "GET /api/v1/servers HTTP/1.1", upstream: "http://127.0.0.1:3000/api/v1/servers"`,
			30000+n, client, s.id.domain),
		fmt.Sprintf(`*%d client intended to send too large body: %d bytes, client: %s, server: %s`, 30000+n, 12_582_912+n*17, client, s.id.domain),
	}

	level := "error"
	if mix(seed^uint64(n)^0x91)%3 == 0 {
		level = "warn"
	}

	return providers.LogRecord{
		Ts:      stamp(at),
		Level:   level,
		Source:  sourceNginxError,
		Message: fmt.Sprintf("%s [%s] %d#%d: %s", at.Format("2006/01/02 15:04:05"), level, pid, pid, pick(seed^0x3, n, variants)),
		Fields:  map[string]string{"client": client},
		Cursor:  fmt.Sprintf("%s:%d", sourceNginxError, n),
	}
}

func renderMail(s *Sim, n int64, at time.Time) providers.LogRecord {
	seed := hashString(sourceMail)
	queueID := fmt.Sprintf("%010X", mix(seed^uint64(n))%0xFFFFFFFFFF)
	recipient := fmt.Sprintf("%s@%s", pick(seed, n, []string{"anna", "sam", "billing", "hello", "noreply"}),
		pick(seed^0x4, n, []string{"example.net", "example.org", "mail.example.co", "contoso.example"}))

	level, message := "info", ""
	switch mix(seed^uint64(n)^0x66) % 20 {
	case 0, 1:
		level = "warn"
		message = fmt.Sprintf("postfix/smtp[%d]: %s: to=<%s>, relay=mx1.example.net[198.51.100.10]:25, delay=%d.%d, delays=0.05/0/2.1/%d.%d, dsn=4.4.1, status=deferred (connect to mx1.example.net[198.51.100.10]:25: Connection timed out)",
			24000+n%900, queueID, recipient, 30+n%40, n%9, 28+n%30, n%9)
	case 2:
		level = "error"
		message = fmt.Sprintf("postfix/smtp[%d]: %s: to=<%s>, relay=mx2.example.org[203.0.113.19]:25, delay=1.4, dsn=5.1.1, status=bounced (host mx2.example.org said: 550 5.1.1 <%s>: Recipient address rejected: User unknown)",
			24000+n%900, queueID, recipient, recipient)
	case 3, 4:
		message = fmt.Sprintf("postfix/cleanup[%d]: %s: message-id=<%016x@mail.%s>", 24000+n%900, queueID, mix(seed^uint64(n)^0x12), s.id.mailDomain)
	case 5:
		message = fmt.Sprintf("opendkim[%d]: %s: DKIM-Signature field added (s=mail, d=%s)", 22000+n%400, queueID, s.id.mailDomain)
	default:
		message = fmt.Sprintf("postfix/smtp[%d]: %s: to=<%s>, relay=mx1.example.net[198.51.100.10]:25, delay=%d.%d, delays=0.04/0/0.3/%d.%d, dsn=2.0.0, status=sent (250 2.0.0 OK)",
			24000+n%900, queueID, recipient, 1+n%4, n%9, 1+n%3, n%9)
	}

	return providers.LogRecord{
		Ts:      stamp(at),
		Level:   level,
		Source:  sourceMail,
		Message: message,
		Fields:  map[string]string{"queue_id": queueID, "to": recipient},
		Cursor:  fmt.Sprintf("%s:%d", sourceMail, n),
	}
}

func renderAuth(s *Sim, n int64, at time.Time) providers.LogRecord {
	seed := hashString(sourceAuth)
	pid := 28000 + int(mix(seed^uint64(n))%900)

	level, message := "info", ""
	switch mix(seed^uint64(n)^0x24) % 10 {
	case 0, 1, 2, 3, 4, 5:
		level = "warn"
		message = fmt.Sprintf("sshd[%d]: Failed password for invalid user %s from %s port %d ssh2",
			pid, pick(seed, n, []string{"admin", "test", "ubuntu", "oracle", "git", "pi"}),
			pick(seed^0x7, n, threatSources), 40000+n%20000)
	case 6:
		level = "error"
		message = fmt.Sprintf("sshd[%d]: error: maximum authentication attempts exceeded for invalid user admin from %s port %d ssh2 [preauth]",
			pid, pick(seed^0x7, n, threatSources), 40000+n%20000)
	case 7:
		message = fmt.Sprintf("sudo: deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl reload nginx")
	case 8:
		message = fmt.Sprintf("sshd[%d]: Accepted publickey for deploy from %s port %d ssh2: ED25519 SHA256:kJ8sQ2fVn0LpRt3xWzYcMb1eA7uHgD5o", pid, s.id.privateIP, 50000+n%12000)
	default:
		message = fmt.Sprintf("systemd-logind[%d]: New session %d of user deploy.", 700+int(n%9), 400+n%120)
	}

	return providers.LogRecord{
		Ts:      stamp(at),
		Level:   level,
		Source:  sourceAuth,
		Message: fmt.Sprintf("%s %s %s", at.Format("Jan  2 15:04:05"), shortHost(s), message),
		Cursor:  fmt.Sprintf("%s:%d", sourceAuth, n),
	}
}

func renderSyslog(s *Sim, n int64, at time.Time) providers.LogRecord {
	seed := hashString(sourceSyslog)
	level, message := journalMessage(s, seed, pick(seed, n, journalUnits), n)

	return providers.LogRecord{
		Ts:      stamp(at),
		Level:   level,
		Source:  sourceSyslog,
		Message: fmt.Sprintf("%s %s %s", at.Format("Jan  2 15:04:05"), shortHost(s), message),
		Cursor:  fmt.Sprintf("%s:%d", sourceSyslog, n),
	}
}

func renderContainer(name, image string) func(*Sim, int64, time.Time) providers.LogRecord {
	return func(s *Sim, n int64, at time.Time) providers.LogRecord {
		seed := hashString("container|" + name)
		level := pickLevel(seed, n)

		var message string
		switch {
		case strings.HasPrefix(image, "redis"):
			message = pick(seed, n, []string{
				fmt.Sprintf("%d:M %s * Background saving terminated with success", 1, at.Format("02 Jan 2006 15:04:05.000")),
				fmt.Sprintf("%d:M %s * DB saved on disk", 1, at.Format("02 Jan 2006 15:04:05.000")),
				fmt.Sprintf("%d:M %s # Warning: 12 clients connected", 1, at.Format("02 Jan 2006 15:04:05.000")),
			})
		case strings.HasPrefix(image, "minio"):
			message = pick(seed, n, []string{
				"API: SYSTEM.scanner  Time: " + at.Format("15:04:05 MST 01/02/2006"),
				fmt.Sprintf("PUT /kaname-backups/2026/08/snapshot-%04d.tar.zst 200 OK", n%9999),
				"Automatically configured API requests per node based on available memory",
			})
		case strings.Contains(image, "uptime-kuma"):
			message = pick(seed, n, []string{
				fmt.Sprintf("[Monitor] [#%d %s] Down: connect ETIMEDOUT", 3+n%6, "api."+s.id.domain),
				fmt.Sprintf("[Monitor] [#%d %s] Up: 200 - OK (%dms)", 1+n%9, s.id.domain, 40+n%320),
				"Adding a new monitor to the queue",
			})
		case strings.Contains(image, "n8n"):
			message = pick(seed, n, []string{
				"Workflow execution finished successfully",
				fmt.Sprintf("Workflow execution %d failed: ECONNREFUSED 127.0.0.1:5432", 1200+n),
			})
		default:
			message = pick(seed, n, []string{
				"listening on 0.0.0.0",
				"health check ok",
				"reloading configuration",
			})
		}

		return providers.LogRecord{
			Ts:      stamp(at),
			Level:   level,
			Source:  sourceContainer + ":" + name,
			Message: message,
			Fields:  map[string]string{"container": name, "image": image},
			Cursor:  fmt.Sprintf("container:%s:%d", name, n),
		}
	}
}

func shortHost(s *Sim) string {
	return strings.SplitN(s.id.hostname, ".", 2)[0]
}
