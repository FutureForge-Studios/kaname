//go:build linux

package linux

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Mail, and DNS from the host's own vantage point.
 *
 * The mail stack Kaname manages is Postfix for transport plus Dovecot
 * for delivery and authentication, wired together by flat map files this
 * agent owns end to end. Owning the files is what makes the panel's view
 * authoritative: nothing is inferred from a database Kaname did not write.
 *
 * Passwords never appear in an argv. `doveadm pw` reads them from stdin,
 * so a hash can be produced without the plaintext ever being visible in
 * /proc to every user on the box.
 *
 * DNS lives here because the checks that matter — SPF, DKIM, DMARC, PTR —
 * are only meaningful when resolved from the machine that sends the mail,
 * not from wherever the panel happens to run.
 * ------------------------------------------------------------------ */

const (
	postfixDir = "/etc/postfix"
	dovecotDir = "/etc/dovecot"

	// The three map files Kaname owns. Anything else in the mail config is
	// the operator's and is never rewritten.
	kanameUsersFile      = "kaname-users"
	kanameAliasesFile    = "kaname-aliases"
	kanameForwardersFile = "kaname-forwarders"
	kanameMailboxesFile  = "kaname-mailboxes"

	// Dovecot's passwd-file marks a disabled account by commenting it out;
	// this prefix keeps the record so it can be switched back on.
	disabledMarker = "#kaname-disabled "

	dkimOpendkimDir = "/etc/opendkim/keys"
	dkimRspamdDir   = "/var/lib/rspamd/dkim"
)

var dkimTxtValue = regexp.MustCompile(`"([^"]*)"`)

type mailOps struct{ p *provider }

/* ----------------------------- mailboxes ----------------------------- */

func (o mailOps) ListMailboxes(ctx context.Context, p providers.MailboxListParams) ([]providers.MailboxInfo, error) {
	if err := o.p.require(providers.CapMail); err != nil {
		return nil, err
	}
	if p.Domain != "" {
		if err := checkDomain(p.Domain); err != nil {
			return nil, err
		}
	}

	accounts, err := readAccounts()
	if err != nil {
		return nil, err
	}
	used := o.quotaUsage(ctx)

	mailboxes := make([]providers.MailboxInfo, 0, len(accounts))
	for _, account := range accounts {
		if p.Domain != "" && !strings.EqualFold(domainOf(account.Address), p.Domain) {
			continue
		}
		mailboxes = append(mailboxes, providers.MailboxInfo{
			Address:    account.Address,
			QuotaBytes: account.Quota,
			UsedBytes:  used[strings.ToLower(account.Address)],
			Active:     account.Active,
		})
	}

	sortSlice(mailboxes, func(a, b providers.MailboxInfo) bool { return a.Address < b.Address })
	return mailboxes, nil
}

func (o mailOps) CreateMailbox(ctx context.Context, p providers.MailboxCreateParams) error {
	if err := o.p.require(providers.CapDovecot); err != nil {
		return err
	}

	accounts, err := readAccounts()
	if err != nil {
		return err
	}
	if _, existing := findAccount(accounts, p.Address); existing >= 0 {
		return fmt.Errorf("mailbox %s already exists: %w", p.Address, providers.ErrConflict)
	}

	hash, err := hashPassword(ctx, p.Password)
	if err != nil {
		return err
	}
	uid, gid := vmailIdentity()

	accounts = append(accounts, mailAccount{
		Address:  strings.ToLower(p.Address),
		Hash:     hash,
		UID:      uid,
		GID:      gid,
		Name:     sanitizeField(p.DisplayName),
		Home:     maildirFor(p.Address),
		Quota:    p.QuotaBytes,
		Active:   true,
		Extras:   nil,
		HasQuota: p.QuotaBytes > 0,
	})
	return o.commitAccounts(ctx, accounts)
}

func (o mailOps) UpdateMailbox(ctx context.Context, p providers.MailboxUpdateParams) error {
	if err := o.p.require(providers.CapDovecot); err != nil {
		return err
	}

	accounts, err := readAccounts()
	if err != nil {
		return err
	}
	_, index := findAccount(accounts, p.Address)
	if index < 0 {
		return notFound("mailbox %s", p.Address)
	}

	if p.QuotaBytes != nil {
		accounts[index].Quota = *p.QuotaBytes
		accounts[index].HasQuota = *p.QuotaBytes > 0
	}
	if p.Active != nil {
		accounts[index].Active = *p.Active
	}
	if p.DisplayName != nil {
		accounts[index].Name = sanitizeField(*p.DisplayName)
	}
	return o.commitAccounts(ctx, accounts)
}

func (o mailOps) DeleteMailbox(ctx context.Context, p providers.MailboxDeleteParams) error {
	if err := o.p.require(providers.CapDovecot); err != nil {
		return err
	}

	accounts, err := readAccounts()
	if err != nil {
		return err
	}
	account, index := findAccount(accounts, p.Address)
	if index < 0 {
		return notFound("mailbox %s", p.Address)
	}

	accounts = append(accounts[:index], accounts[index+1:]...)
	if err := o.commitAccounts(ctx, accounts); err != nil {
		return err
	}

	if p.DeleteMaildir && account.Home != "" {
		if _, protected := protectedRoots[account.Home]; protected {
			return fmt.Errorf("%s is protected from recursive deletion: %w", account.Home, providers.ErrPermissionDenied)
		}
		if err := os.RemoveAll(account.Home); err != nil {
			return wrapFsError(account.Home, err)
		}
	}
	return nil
}

func (o mailOps) SetMailboxPassword(ctx context.Context, p providers.MailboxPasswordParams) error {
	if err := o.p.require(providers.CapDovecot); err != nil {
		return err
	}

	accounts, err := readAccounts()
	if err != nil {
		return err
	}
	_, index := findAccount(accounts, p.Address)
	if index < 0 {
		return notFound("mailbox %s", p.Address)
	}

	hash, err := hashPassword(ctx, p.Password)
	if err != nil {
		return err
	}
	accounts[index].Hash = hash
	if err := o.commitAccounts(ctx, accounts); err != nil {
		return err
	}
	if !p.RevokeSessions {
		return nil
	}

	// The new hash only bites at the next login; a client that is already
	// authenticated keeps its session until it is kicked. doveadm exits
	// 68 (EX_NOHOST, "not found") when no connection matched, which for
	// a reset is the outcome wanted rather than a failure.
	_, err = runWith(ctx, execOptions{Name: "doveadm", Args: []string{"kick", strings.ToLower(p.Address)}, Env: cLocale()})
	if err != nil && !isExitCode(err, 68) {
		return err
	}
	return nil
}

/* -------------------------- aliases and forwarding -------------------- */

func (o mailOps) ApplyAliases(ctx context.Context, p providers.MailAliasApplyParams) error {
	if err := o.p.require(providers.CapPostfix); err != nil {
		return err
	}
	if err := checkDomain(p.Domain); err != nil {
		return err
	}

	entries := make([]mapEntry, 0, len(p.Aliases))
	for _, alias := range p.Aliases {
		if err := checkMailAddress(alias.Address, p.Domain); err != nil {
			return err
		}
		for _, destination := range alias.Destinations {
			if err := checkMailAddress(destination, ""); err != nil {
				return err
			}
		}
		entries = append(entries, mapEntry{Key: alias.Address, Value: strings.Join(alias.Destinations, ", ")})
	}
	return o.applyMap(ctx, kanameAliasesFile, "virtual_alias_maps", p.Domain, entries)
}

func (o mailOps) ApplyForwarders(ctx context.Context, p providers.MailForwarderApplyParams) error {
	if err := o.p.require(providers.CapPostfix); err != nil {
		return err
	}
	if err := checkDomain(p.Domain); err != nil {
		return err
	}

	entries := make([]mapEntry, 0, len(p.Forwarders))
	for _, forwarder := range p.Forwarders {
		if err := checkMailAddress(forwarder.Source, p.Domain); err != nil {
			return err
		}
		if err := checkMailAddress(forwarder.Destination, ""); err != nil {
			return err
		}
		destinations := []string{forwarder.Destination}
		if forwarder.KeepCopy {
			// Listing the source alongside the destination is how Postfix
			// expresses "deliver locally as well as forward".
			destinations = append(destinations, forwarder.Source)
		}
		entries = append(entries, mapEntry{Key: forwarder.Source, Value: strings.Join(destinations, ", ")})
	}
	return o.applyMap(ctx, kanameForwardersFile, "virtual_alias_maps", p.Domain, entries)
}

/* -------------------------------- dkim -------------------------------- */

func (o mailOps) ReadDKIM(ctx context.Context, p providers.MailDkimReadParams) (providers.DkimKeyInfo, error) {
	if err := o.p.require(providers.CapMail); err != nil {
		return providers.DkimKeyInfo{}, err
	}
	if err := checkDomain(p.Domain); err != nil {
		return providers.DkimKeyInfo{}, err
	}
	_ = ctx

	if info, err := readOpendkimKey(p.Domain); err == nil {
		return info, nil
	}
	if info, err := readRspamdKey(p.Domain); err == nil {
		return info, nil
	}
	return providers.DkimKeyInfo{}, notFound("no DKIM key for %s under %s or %s", p.Domain, dkimOpendkimDir, dkimRspamdDir)
}

/* -------------------------------- queue ------------------------------- */

func (o mailOps) Queue(ctx context.Context, p providers.MailQueueListParams) ([]providers.MailQueueEntry, error) {
	if err := o.p.require(providers.CapPostfix); err != nil {
		return nil, err
	}

	out, err := runWith(ctx, execOptions{Name: "postqueue", Args: []string{"-j"}, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	limit := p.Limit
	if limit <= 0 {
		limit = 200
	}
	entries := make([]providers.MailQueueEntry, 0, 32)
	for _, line := range splitLines(out) {
		var record struct {
			QueueID     string `json:"queue_id"`
			QueueName   string `json:"queue_name"`
			ArrivalTime int64  `json:"arrival_time"`
			MessageSize int64  `json:"message_size"`
			Sender      string `json:"sender"`
			Recipients  []struct {
				Address     string `json:"address"`
				DelayReason string `json:"delay_reason"`
			} `json:"recipients"`
		}
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}

		entry := providers.MailQueueEntry{
			QueueID:   record.QueueID,
			From:      record.Sender,
			To:        []string{},
			Size:      record.MessageSize,
			ArrivedAt: rfc3339(time.Unix(record.ArrivalTime, 0)),
		}
		for _, recipient := range record.Recipients {
			entry.To = append(entry.To, recipient.Address)
			if entry.Reason == nil && recipient.DelayReason != "" {
				entry.Reason = stringPtr(recipient.DelayReason)
			}
		}
		entries = append(entries, entry)
		if len(entries) >= limit {
			break
		}
	}
	return entries, nil
}

/* -------------------------------- logs -------------------------------- */

func (o mailOps) Logs(ctx context.Context, p providers.MailLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	if err := o.p.require(providers.CapMail); err != nil {
		return nil, err
	}

	filter := recordFilter{query: p.Query}
	if o.p.has(providers.CapSystemd) {
		query := journalQuery{
			Args:   []string{"--unit=postfix.service", "--unit=postfix@-.service", "--unit=dovecot.service"},
			Source: "mail",
			Lines:  p.Lines,
			Follow: p.Follow,
			Filter: filter,
		}
		return journal(ctx, query, stream)
	}

	target := firstExisting("/var/log/mail.log", "/var/log/maillog")
	if target == "" {
		return nil, notFound("no mail log on this host")
	}
	return tailFile(ctx, target, p.Lines, p.Follow, filter, stream)
}

/* ------------------------------ persistence --------------------------- */

// mailAccount is one line of Dovecot's passwd-file userdb, kept whole so
// a field this agent does not understand survives a rewrite.
type mailAccount struct {
	Address  string
	Hash     string
	UID      int
	GID      int
	Name     string
	Home     string
	Shell    string
	Quota    int64
	HasQuota bool
	Active   bool
	Extras   []string
}

func usersPath() string {
	return path.Join(dovecotDir, kanameUsersFile)
}

func readAccounts() ([]mailAccount, error) {
	raw, err := os.ReadFile(usersPath())
	if err != nil {
		if isNotExist(err) {
			return []mailAccount{}, nil
		}
		return nil, wrapFsError(usersPath(), err)
	}

	accounts := make([]mailAccount, 0, 32)
	for _, line := range splitLines(string(raw)) {
		active := true
		if strings.HasPrefix(line, disabledMarker) {
			active = false
			line = strings.TrimPrefix(line, disabledMarker)
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		fields := strings.Split(line, ":")
		if len(fields) < 2 || fields[0] == "" {
			continue
		}
		account := mailAccount{Address: fields[0], Hash: fields[1], Active: active}
		if len(fields) > 2 {
			account.UID, _ = strconv.Atoi(fields[2])
		}
		if len(fields) > 3 {
			account.GID, _ = strconv.Atoi(fields[3])
		}
		if len(fields) > 4 {
			account.Name = fields[4]
		}
		if len(fields) > 5 {
			account.Home = fields[5]
		}
		if len(fields) > 6 {
			account.Shell = fields[6]
		}
		for _, extra := range fields[7:] {
			if quota, ok := parseQuotaRule(extra); ok {
				account.Quota, account.HasQuota = quota, true
				continue
			}
			account.Extras = append(account.Extras, extra)
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

func renderAccounts(accounts []mailAccount) string {
	var b strings.Builder
	b.WriteString("# Managed by Kaname. Edits are overwritten on the next mailbox change.\n")

	for _, account := range accounts {
		fields := []string{
			account.Address,
			account.Hash,
			strconv.Itoa(account.UID),
			strconv.Itoa(account.GID),
			account.Name,
			account.Home,
			account.Shell,
		}
		if account.HasQuota && account.Quota > 0 {
			fields = append(fields, "userdb_quota_rule=*:bytes="+strconv.FormatInt(account.Quota, 10))
		}
		fields = append(fields, account.Extras...)

		if !account.Active {
			b.WriteString(disabledMarker)
		}
		b.WriteString(strings.Join(fields, ":"))
		b.WriteByte('\n')
	}
	return b.String()
}

// commitAccounts rewrites the userdb and the mailbox map together, then
// reloads. The two files must agree: an account Dovecot knows but Postfix
// does not is a silently bouncing mailbox.
func (o mailOps) commitAccounts(ctx context.Context, accounts []mailAccount) error {
	sortSlice(accounts, func(a, b mailAccount) bool { return a.Address < b.Address })

	if err := os.MkdirAll(dovecotDir, defaultDirMode); err != nil {
		return wrapFsError(dovecotDir, err)
	}
	// The file holds password hashes, so it is never world readable.
	if err := writeAtomic(usersPath(), []byte(renderAccounts(accounts)), 0o640); err != nil {
		return err
	}

	if o.p.has(providers.CapPostfix) {
		entries := make([]mapEntry, 0, len(accounts))
		for _, account := range accounts {
			if !account.Active {
				continue
			}
			entries = append(entries, mapEntry{Key: account.Address, Value: strings.TrimSuffix(account.Home, "/") + "/"})
		}
		if err := o.writeMap(ctx, kanameMailboxesFile, "virtual_mailbox_maps", entries); err != nil {
			return err
		}
	}

	if o.p.has(providers.CapSystemd) {
		if _, err := runWith(ctx, execOptions{Name: "systemctl", Args: []string{"reload-or-restart", "dovecot"}, Env: cLocale()}); err != nil {
			return err
		}
	}
	return nil
}

// mapEntry is one `key value` line of a Postfix lookup table.
type mapEntry struct {
	Key   string
	Value string
}

// applyMap replaces the entries for one domain and leaves every other
// domain's entries in the file untouched, which is what makes
// mail.alias.apply a per-domain operation rather than a fleet-wide one.
func (o mailOps) applyMap(ctx context.Context, name, parameter, domain string, entries []mapEntry) error {
	existing, err := readMap(path.Join(postfixDir, name))
	if err != nil {
		return err
	}

	kept := make([]mapEntry, 0, len(existing)+len(entries))
	for _, entry := range existing {
		if !strings.EqualFold(domainOf(entry.Key), domain) {
			kept = append(kept, entry)
		}
	}
	kept = append(kept, entries...)
	return o.writeMap(ctx, name, parameter, kept)
}

func (o mailOps) writeMap(ctx context.Context, name, parameter string, entries []mapEntry) error {
	sortSlice(entries, func(a, b mapEntry) bool { return a.Key < b.Key })

	var b strings.Builder
	b.WriteString("# Managed by Kaname. Edits are overwritten on the next apply.\n")
	for _, entry := range entries {
		fmt.Fprintf(&b, "%s %s\n", entry.Key, entry.Value)
	}

	target := path.Join(postfixDir, name)
	if err := writeAtomic(target, []byte(b.String()), 0o644); err != nil {
		return err
	}
	if _, err := runWith(ctx, execOptions{Name: "postmap", Args: []string{target}, Env: cLocale()}); err != nil {
		return err
	}
	if err := o.ensureMapReferenced(ctx, parameter, target); err != nil {
		return err
	}

	_, err := runWith(ctx, execOptions{Name: "postfix", Args: []string{"reload"}, Env: cLocale()})
	return err
}

// ensureMapReferenced adds Kaname's table to a Postfix parameter without
// disturbing whatever the operator already had there. A map file nothing
// reads would make every apply a silent no-op.
func (o mailOps) ensureMapReferenced(ctx context.Context, parameter, target string) error {
	current, err := runWith(ctx, execOptions{Name: "postconf", Args: []string{"-h", parameter}, Env: cLocale()})
	if err != nil {
		return err
	}

	reference := "hash:" + target
	value := strings.TrimSpace(current)
	if strings.Contains(value, target) {
		return nil
	}
	if value != "" {
		reference = value + " " + reference
	}

	_, err = runWith(ctx, execOptions{Name: "postconf", Args: []string{"-e", parameter + "=" + reference}, Env: cLocale()})
	return err
}

func readMap(target string) ([]mapEntry, error) {
	raw, err := os.ReadFile(target)
	if err != nil {
		if isNotExist(err) {
			return nil, nil
		}
		return nil, wrapFsError(target, err)
	}

	entries := make([]mapEntry, 0, 32)
	for _, line := range splitLines(string(raw)) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, value, ok := strings.Cut(trimmed, " ")
		if !ok {
			key, value, ok = strings.Cut(trimmed, "\t")
		}
		if !ok {
			continue
		}
		entries = append(entries, mapEntry{Key: key, Value: strings.TrimSpace(value)})
	}
	return entries, nil
}

/* -------------------------------- dovecot ----------------------------- */

// hashPassword shells out to doveadm with the plaintext on stdin. Passing
// it as `-p` would put every mailbox password in /proc for any user on
// the host to read.
func hashPassword(ctx context.Context, password string) (string, error) {
	out, err := runWith(ctx, execOptions{
		Name:  "doveadm",
		Args:  []string{"pw", "-s", "SHA512-CRYPT"},
		Stdin: []byte(password + "\n" + password + "\n"),
		Env:   cLocale(),
	})
	if err != nil {
		return "", err
	}

	hash := strings.TrimSpace(out)
	if !strings.HasPrefix(hash, "{") {
		return "", fmt.Errorf("doveadm returned an unexpected hash form: %w", providers.ErrPreconditionFailed)
	}
	return hash, nil
}

// quotaUsage asks Dovecot for every mailbox's usage in one call rather
// than one exec per row.
func (o mailOps) quotaUsage(ctx context.Context) map[string]int64 {
	used := map[string]int64{}
	if !o.p.has(providers.CapDovecot) {
		return used
	}

	out, err := runWith(ctx, execOptions{Name: "doveadm", Args: []string{"-f", "tab", "quota", "get", "-A"}, Env: cLocale()})
	if err != nil {
		return used
	}
	for _, line := range splitLines(out) {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "Username" {
			continue
		}
		if fields[2] != "STORAGE" {
			continue
		}
		// doveadm reports storage in kibibytes.
		if value, err := strconv.ParseInt(strings.TrimSpace(fields[3]), 10, 64); err == nil {
			used[strings.ToLower(fields[0])] = value * 1024
		}
	}
	return used
}

func vmailIdentity() (int, int) {
	for _, name := range []string{"vmail", "vhost", "dovecot"} {
		account, err := user.Lookup(name)
		if err != nil {
			continue
		}
		uid, _ := strconv.Atoi(account.Uid)
		gid, _ := strconv.Atoi(account.Gid)
		return uid, gid
	}
	return 5000, 5000
}

func maildirRoot() string {
	if root := firstExisting("/var/mail/vhosts", "/var/vmail", "/var/mail/vmail"); root != "" {
		return root
	}
	return "/var/mail/vhosts"
}

func maildirFor(address string) string {
	local, domain := splitAddress(address)
	return path.Join(maildirRoot(), domain, local)
}

func parseQuotaRule(field string) (int64, bool) {
	const prefix = "userdb_quota_rule=*:bytes="
	if !strings.HasPrefix(field, prefix) {
		return 0, false
	}
	value, err := strconv.ParseInt(strings.TrimPrefix(field, prefix), 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

func findAccount(accounts []mailAccount, address string) (mailAccount, int) {
	for i, account := range accounts {
		if strings.EqualFold(account.Address, address) {
			return account, i
		}
	}
	return mailAccount{}, -1
}

/* --------------------------------- dkim ------------------------------- */

func readOpendkimKey(domain string) (providers.DkimKeyInfo, error) {
	dir := path.Join(dkimOpendkimDir, domain)
	matches, err := filepath.Glob(path.Join(dir, "*.txt"))
	if err != nil || len(matches) == 0 {
		return providers.DkimKeyInfo{}, notFound("no DKIM record under %s", dir)
	}

	target := matches[0]
	raw, err := os.ReadFile(target)
	if err != nil {
		return providers.DkimKeyInfo{}, wrapFsError(target, err)
	}

	// The .txt file is a BIND record whose value is split across quoted
	// chunks; rejoining them is what produces the string DNS should hold.
	var value strings.Builder
	for _, match := range dkimTxtValue.FindAllStringSubmatch(string(raw), -1) {
		value.WriteString(match[1])
	}
	txt := value.String()
	if txt == "" {
		return providers.DkimKeyInfo{}, fmt.Errorf("%s holds no quoted record value: %w", target, providers.ErrPreconditionFailed)
	}

	publicKey := tagValue(txt, "p=")
	return providers.DkimKeyInfo{
		Selector:  strings.TrimSuffix(filepath.Base(target), ".txt"),
		PublicKey: publicKey,
		KeyBits:   rsaBitsFromBase64(publicKey),
		TxtValue:  txt,
	}, nil
}

func readRspamdKey(domain string) (providers.DkimKeyInfo, error) {
	matches, err := filepath.Glob(path.Join(dkimRspamdDir, domain+".*.key"))
	if err != nil || len(matches) == 0 {
		return providers.DkimKeyInfo{}, notFound("no DKIM key under %s", dkimRspamdDir)
	}

	target := matches[0]
	raw, err := os.ReadFile(target)
	if err != nil {
		return providers.DkimKeyInfo{}, wrapFsError(target, err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return providers.DkimKeyInfo{}, fmt.Errorf("%s holds no PEM block: %w", target, providers.ErrPreconditionFailed)
	}

	private, err := parseRSAPrivateKey(block.Bytes)
	if err != nil {
		return providers.DkimKeyInfo{}, fmt.Errorf("parse %s: %w", target, err)
	}
	der, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		return providers.DkimKeyInfo{}, fmt.Errorf("encode public key: %w", err)
	}

	encoded := base64.StdEncoding.EncodeToString(der)
	selector := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(target), domain+"."), ".key")
	return providers.DkimKeyInfo{
		Selector:  selector,
		PublicKey: encoded,
		KeyBits:   private.N.BitLen(),
		TxtValue:  "v=DKIM1; k=rsa; p=" + encoded,
	}, nil
}

func parseRSAPrivateKey(der []byte) (*rsa.PrivateKey, error) {
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("DKIM key is not RSA")
	}
	return key, nil
}

func rsaBitsFromBase64(encoded string) int {
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return 0
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return 0
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return 0
	}
	return key.N.BitLen()
}

func tagValue(record, tag string) string {
	for _, part := range strings.Split(record, ";") {
		trimmed := strings.TrimSpace(part)
		if strings.HasPrefix(trimmed, tag) {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, tag))
		}
	}
	return ""
}

/* --------------------------------- dns -------------------------------- */

type dnsOps struct{ p *provider }

func (o dnsOps) Resolve(ctx context.Context, p providers.DNSResolveParams) ([]providers.ResolvedRecord, error) {
	if err := checkDomain(strings.TrimSuffix(p.Name, ".")); err != nil {
		return nil, err
	}

	recordType := strings.ToUpper(p.Type)
	resolver, label, err := buildResolver(p.Resolver)
	if err != nil {
		return nil, err
	}

	values, err := lookup(ctx, resolver, recordType, p.Name)
	if err != nil {
		var dnsErr *net.DNSError
		// A name that simply does not exist is an answer, not a failure:
		// half the mail-authentication checks are "is this record absent".
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return []providers.ResolvedRecord{}, nil
		}
		if errors.Is(err, errCAAUnsupported) {
			return nil, unsupported("CAA lookups need dig, which is not installed")
		}
		return nil, fmt.Errorf("resolve %s %s: %w", recordType, p.Name, err)
	}

	// The stdlib resolver does not surface TTLs, and inventing one would
	// be worse than admitting the panel does not know.
	return []providers.ResolvedRecord{{
		Name:     strings.TrimSuffix(p.Name, "."),
		Type:     recordType,
		Values:   values,
		Resolver: label,
	}}, nil
}

var errCAAUnsupported = fmt.Errorf("caa lookup requires dig")

func lookup(ctx context.Context, resolver *net.Resolver, recordType, name string) ([]string, error) {
	switch recordType {
	case "A", "AAAA":
		network := "ip4"
		if recordType == "AAAA" {
			network = "ip6"
		}
		addresses, err := resolver.LookupIP(ctx, network, name)
		if err != nil {
			return nil, err
		}
		return mapStrings(addresses, func(ip net.IP) string { return ip.String() }), nil

	case "CNAME":
		target, err := resolver.LookupCNAME(ctx, name)
		if err != nil {
			return nil, err
		}
		return []string{strings.TrimSuffix(target, ".")}, nil

	case "MX":
		records, err := resolver.LookupMX(ctx, name)
		if err != nil {
			return nil, err
		}
		return mapStrings(records, func(mx *net.MX) string {
			return strconv.Itoa(int(mx.Pref)) + " " + strings.TrimSuffix(mx.Host, ".")
		}), nil

	case "TXT":
		return resolver.LookupTXT(ctx, name)

	case "NS":
		records, err := resolver.LookupNS(ctx, name)
		if err != nil {
			return nil, err
		}
		return mapStrings(records, func(ns *net.NS) string { return strings.TrimSuffix(ns.Host, ".") }), nil

	case "SRV":
		_, records, err := resolver.LookupSRV(ctx, "", "", name)
		if err != nil {
			return nil, err
		}
		return mapStrings(records, func(srv *net.SRV) string {
			return fmt.Sprintf("%d %d %d %s", srv.Priority, srv.Weight, srv.Port, strings.TrimSuffix(srv.Target, "."))
		}), nil

	case "PTR":
		// The caller asks the way DNS does, by the in-addr.arpa or
		// ip6.arpa name; the stdlib wants the address itself.
		names, err := resolver.LookupAddr(ctx, ptrTarget(name))
		if err != nil {
			return nil, err
		}
		return mapStrings(names, func(entry string) string { return strings.TrimSuffix(entry, ".") }), nil

	case "CAA":
		// The stdlib has no CAA support, so this is the one record type
		// that needs an external resolver binary.
		if !hasBinary("dig") {
			return nil, errCAAUnsupported
		}
		out, err := runWith(ctx, execOptions{Name: "dig", Args: []string{"+short", "CAA", name}, Env: cLocale()})
		if err != nil {
			return nil, err
		}
		return splitLines(out), nil

	default:
		return nil, invalid("record type %q is not supported", recordType)
	}
}

func buildResolver(address string) (*net.Resolver, string, error) {
	if address == "" {
		return net.DefaultResolver, "system", nil
	}
	if err := checkResolver(address); err != nil {
		return nil, "", err
	}

	target := address
	if _, _, err := net.SplitHostPort(target); err != nil {
		target = net.JoinHostPort(target, "53")
	}
	// PreferGo keeps the query on the requested server rather than letting
	// libc quietly consult /etc/resolv.conf instead.
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, target)
		},
	}, address, nil
}

// ptrTarget turns a reverse-zone name back into the address it stands
// for, and leaves anything else (a bare address) alone.
func ptrTarget(name string) string {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	if v4, ok := strings.CutSuffix(name, ".in-addr.arpa"); ok {
		parts := strings.Split(v4, ".")
		if len(parts) != 4 {
			return name
		}
		for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
			parts[i], parts[j] = parts[j], parts[i]
		}
		return strings.Join(parts, ".")
	}
	if v6, ok := strings.CutSuffix(name, ".ip6.arpa"); ok {
		nibbles := strings.Split(v6, ".")
		if len(nibbles) != 32 {
			return name
		}
		var b strings.Builder
		for i := len(nibbles) - 1; i >= 0; i-- {
			b.WriteString(nibbles[i])
			if i%4 == 0 && i > 0 {
				b.WriteByte(':')
			}
		}
		if ip := net.ParseIP(b.String()); ip != nil {
			return ip.String()
		}
	}
	return name
}

func checkResolver(address string) error {
	host := address
	if h, _, err := net.SplitHostPort(address); err == nil {
		host = h
	}
	if net.ParseIP(host) == nil {
		return invalid("resolver must be an IP address")
	}
	return nil
}

func mapStrings[T any](items []T, render func(T) string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, render(item))
	}
	return out
}

/* ------------------------------ validation ---------------------------- */

// checkMailAddress accepts a full address, and — when a domain is given —
// insists it belongs to that domain, so one domain's alias map can never
// be used to capture another's mail.
func checkMailAddress(address, domain string) error {
	local, at := splitAddress(address)
	if local == "" || at == "" {
		return invalid("%q is not a mail address", address)
	}
	if len(address) > 320 || strings.ContainsAny(address, " \t\r\n,;") || strings.ContainsRune(address, 0) {
		return invalid("%q is not a mail address", address)
	}
	if err := checkDomain(at); err != nil {
		return err
	}
	if domain != "" && !strings.EqualFold(at, domain) {
		return invalid("%s does not belong to %s", address, domain)
	}
	return nil
}

func splitAddress(address string) (string, string) {
	local, domain, ok := strings.Cut(address, "@")
	if !ok {
		return "", ""
	}
	return local, domain
}

func domainOf(address string) string {
	_, domain := splitAddress(address)
	return domain
}

// sanitizeField strips the separators that would otherwise let a display
// name inject extra fields into the passwd-file line.
func sanitizeField(value string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case ':', '\n', '\r', 0:
			return -1
		}
		return r
	}, value)
}
