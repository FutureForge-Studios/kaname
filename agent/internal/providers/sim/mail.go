package sim

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Mail, and the DNS view from this host.
 *
 * The two belong together: what makes a mail-authentication check
 * meaningful is that the answers come from the mail server's own
 * resolver, not the panel's. The zone served here is deliberately
 * *almost* right — SPF and DKIM line up, DMARC is still at p=quarantine
 * and the PTR does not match the HELO name — so the Email > DNS
 * authentication page has real findings to render instead of a row of
 * green ticks.
 * ------------------------------------------------------------------ */

const dkimSelector = "mail"

// dkimPublicKey is inert filler shaped like a 2048-bit RSA SPKI. Nothing
// here is a key; it exists so the DNS TXT record and `mail.dkim.read`
// can agree with each other, which is what the check compares.
const dkimPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsimulatedKAName0AgentKeyMaterialFor" +
	"DevelopmentOnlyQm5kZXZlbG9wbWVudE9ubHkxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1" +
	"dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODkrLzAxMjM0NTY3ODlhYmNkZWZn" +
	"aGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaMDEyMzQ1Njc4OSsvQUJD" +
	"REVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcAIDAQAB"

func (s *Sim) buildMail() {
	domain := s.id.mailDomain
	now := time.Now().UTC()

	seeds := []struct {
		local   string
		display string
		quota   int64
		used    int64
		active  bool
		lastAgo time.Duration
	}{
		{"ops", "Operations", 5 * giB, 1_884_301_824, true, 4 * time.Minute},
		{"sales", "Sales", 2 * giB, 1_112_490_496, true, 38 * time.Minute},
		{"billing", "Billing", 2 * giB, 284_115_968, true, 6 * time.Hour},
		{"alice", "Alice Nakamura", 10 * giB, 7_912_407_040, true, 22 * time.Minute},
		{"support", "Support", 5 * giB, 3_984_588_800, true, 2 * time.Hour},
		{"noreply", "No Reply", 512 * miB, 12_582_912, true, 0},
		{"webmaster", "Webmaster", 1 * giB, 4_194_304, false, 0},
	}

	s.mailboxes = make([]*providers.MailboxInfo, 0, len(seeds))
	for _, seed := range seeds {
		box := &providers.MailboxInfo{
			Address:    seed.local + "@" + domain,
			QuotaBytes: seed.quota,
			UsedBytes:  seed.used,
			Active:     seed.active,
		}
		if seed.lastAgo > 0 {
			box.LastLogin = stampPtr(now.Add(-seed.lastAgo))
		}
		s.mailboxes = append(s.mailboxes, box)

		s.fs.mu.Lock()
		s.fs.dirAs("/var/vmail/"+domain+"/"+seed.local+"/cur", "0700", "vmail", 5000)
		s.fs.dirAs("/var/vmail/"+domain+"/"+seed.local+"/new", "0700", "vmail", 5000)
		s.fs.mu.Unlock()
	}

	s.aliases = map[string][]providers.MailAlias{
		domain: {
			{Address: "postmaster@" + domain, Destinations: []string{"ops@" + domain}},
			{Address: "abuse@" + domain, Destinations: []string{"ops@" + domain}},
			{Address: "info@" + domain, Destinations: []string{"sales@" + domain, "ops@" + domain}},
			{Address: "hello@" + domain, Destinations: []string{"sales@" + domain}},
		},
	}
	s.forwarders = map[string][]providers.MailForwarder{
		domain: {
			{Source: "support@" + domain, Destination: "support@helpdesk.example.net", KeepCopy: true},
			{Source: "billing@" + domain, Destination: "ap@accounting.example.org", KeepCopy: false},
		},
	}

	s.writeMailMaps(domain)
	s.writeDkimFiles(domain)
	s.mailQueue = s.seedMailQueue(now, 6)
}

func (s *Sim) seedMailQueue(now time.Time, count int) []providers.MailQueueEntry {
	domain := s.id.mailDomain
	reasons := []string{
		"connect to mx1.example.net[198.51.100.10]:25: Connection timed out",
		"host mx.contoso.example[203.0.113.19] refused to talk to me: 421 4.7.0 Try again later",
		"delivery temporarily suspended: lost connection with mx2.example.org while sending RCPT TO",
	}

	out := make([]providers.MailQueueEntry, 0, count)
	for i := 0; i < count; i++ {
		arrived := now.Add(-time.Duration(7+mix(s.seed^uint64(i)^0xb1)%600) * time.Minute)
		out = append(out, providers.MailQueueEntry{
			QueueID: fmt.Sprintf("%010X", mix(s.seed^uint64(i)^0xb2)%0xFFFFFFFFFF),
			From:    pick(s.seed, int64(i), []string{"noreply", "billing", "sales"}) + "@" + domain,
			To: []string{fmt.Sprintf("%s@%s",
				pick(s.seed^0x1, int64(i), []string{"anna", "sam", "ap", "hello"}),
				pick(s.seed^0x2, int64(i), []string{"example.net", "example.org", "contoso.example"}))},
			Size:      int64(2_048 + mix(s.seed^uint64(i)^0xb3)%400_000),
			ArrivedAt: stamp(arrived),
			Reason:    ptr(pick(s.seed^0x3, int64(i), reasons)),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ArrivedAt > out[j].ArrivedAt })
	return out
}

// mailQueueLoop keeps the deferred queue moving: entries drain and new
// ones arrive, so the Mail > Queue page is never a frozen screenshot.
func (s *Sim) mailQueueLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(90 * time.Second)
	defer ticker.Stop()

	var round int64
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		round++

		now := time.Now().UTC()
		s.mu.Lock()
		if len(s.mailQueue) > 0 && mix(s.seed^uint64(round))%3 != 0 {
			s.mailQueue = s.mailQueue[1:]
		}
		if len(s.mailQueue) < 9 && mix(s.seed^uint64(round)^0x7)%2 == 0 {
			s.mailQueue = append(s.seedMailQueue(now, 1), s.mailQueue...)
		}
		s.mu.Unlock()
	}
}

func (s *Sim) writeMailMaps(domain string) {
	s.mu.Lock()
	aliases := append([]providers.MailAlias(nil), s.aliases[domain]...)
	forwarders := append([]providers.MailForwarder(nil), s.forwarders[domain]...)
	boxes := make([]string, 0, len(s.mailboxes))
	for _, box := range s.mailboxes {
		if strings.HasSuffix(box.Address, "@"+domain) {
			boxes = append(boxes, box.Address)
		}
	}
	s.mu.Unlock()

	sort.Strings(boxes)

	var virtual strings.Builder
	for _, alias := range aliases {
		fmt.Fprintf(&virtual, "%s\t%s\n", alias.Address, strings.Join(alias.Destinations, ", "))
	}
	for _, forwarder := range forwarders {
		destinations := forwarder.Destination
		if forwarder.KeepCopy {
			destinations += ", " + forwarder.Source
		}
		fmt.Fprintf(&virtual, "%s\t%s\n", forwarder.Source, destinations)
	}

	var vmailbox strings.Builder
	for _, address := range boxes {
		local, _, _ := strings.Cut(address, "@")
		fmt.Fprintf(&vmailbox, "%s\t%s/%s/\n", address, domain, local)
	}

	s.fs.mu.Lock()
	s.fs.file("/etc/postfix/virtual", virtual.String())
	s.fs.file("/etc/postfix/vmailbox", vmailbox.String())
	s.fs.mu.Unlock()
}

func (s *Sim) writeDkimFiles(domain string) {
	s.fs.mu.Lock()
	defer s.fs.mu.Unlock()

	dir := "/etc/opendkim/keys/" + domain
	s.fs.dirAs(dir, "0750", "opendkim", uidFor("opendkim"))
	s.fs.fileAs(dir+"/"+dkimSelector+".private",
		"-----BEGIN RSA PRIVATE KEY-----\n(simulated; no key material is kept)\n-----END RSA PRIVATE KEY-----\n",
		"0600", "opendkim", uidFor("opendkim"))
	s.fs.fileAs(dir+"/"+dkimSelector+".txt",
		fmt.Sprintf("%s._domainkey\tIN\tTXT\t( \"v=DKIM1; h=sha256; k=rsa; \"\n\t  \"p=%s\" )  ; ----- DKIM key %s for %s\n",
			dkimSelector, dkimPublicKey, dkimSelector, domain),
		"0644", "opendkim", uidFor("opendkim"))
	s.fs.file("/etc/opendkim/key.table", fmt.Sprintf("%s._domainkey.%s %s:%s:%s/%s.private\n", dkimSelector, domain, domain, dkimSelector, dir, dkimSelector))
	s.fs.file("/etc/opendkim/signing.table", fmt.Sprintf("*@%s %s._domainkey.%s\n", domain, dkimSelector, domain))
}

/* -------------------------------- mail ------------------------------- */

type simMail struct{ *Sim }

func (s *Sim) findMailboxLocked(address string) *providers.MailboxInfo {
	for _, box := range s.mailboxes {
		if strings.EqualFold(box.Address, address) {
			return box
		}
	}
	return nil
}

func (s simMail) ListMailboxes(_ context.Context, p providers.MailboxListParams) ([]providers.MailboxInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.MailboxInfo, 0, len(s.mailboxes))
	for _, box := range s.mailboxes {
		if p.Domain != "" && !strings.HasSuffix(box.Address, "@"+p.Domain) {
			continue
		}
		out = append(out, *box)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return out, nil
}

func (s simMail) CreateMailbox(_ context.Context, p providers.MailboxCreateParams) error {
	local, domain, _ := strings.Cut(p.Address, "@")

	s.mu.Lock()
	if s.findMailboxLocked(p.Address) != nil {
		s.mu.Unlock()
		return fmt.Errorf("mailbox %s already exists: %w", p.Address, providers.ErrConflict)
	}
	s.mailboxes = append(s.mailboxes, &providers.MailboxInfo{
		Address:    p.Address,
		QuotaBytes: p.QuotaBytes,
		Active:     true,
	})
	s.mu.Unlock()

	s.fs.mu.Lock()
	for _, sub := range []string{"cur", "new", "tmp"} {
		s.fs.dirAs("/var/vmail/"+domain+"/"+local+"/"+sub, "0700", "vmail", 5000)
	}
	s.fs.mu.Unlock()

	s.writeMailMaps(domain)
	return nil
}

func (s simMail) UpdateMailbox(_ context.Context, p providers.MailboxUpdateParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	box := s.findMailboxLocked(p.Address)
	if box == nil {
		return fmt.Errorf("mailbox %s: %w", p.Address, providers.ErrNotFound)
	}
	if p.QuotaBytes != nil {
		box.QuotaBytes = *p.QuotaBytes
	}
	if p.Active != nil {
		box.Active = *p.Active
	}
	return nil
}

func (s simMail) DeleteMailbox(_ context.Context, p providers.MailboxDeleteParams) error {
	local, domain, _ := strings.Cut(p.Address, "@")

	s.mu.Lock()
	index := -1
	for i, box := range s.mailboxes {
		if strings.EqualFold(box.Address, p.Address) {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return fmt.Errorf("mailbox %s: %w", p.Address, providers.ErrNotFound)
	}
	s.mailboxes = append(s.mailboxes[:index], s.mailboxes[index+1:]...)
	s.mu.Unlock()

	if p.DeleteMaildir {
		maildir := "/var/vmail/" + domain + "/" + local
		s.fs.mu.Lock()
		if parent, err := s.fs.parentOf(maildir); err == nil {
			if n, ok := parent.children[local]; ok {
				s.accountBytes(-treeSize(n))
				delete(parent.children, local)
			}
		}
		s.fs.mu.Unlock()
	}

	s.writeMailMaps(domain)
	return nil
}

// SetMailboxPassword accepts the change and keeps nothing: a simulated
// host has no business holding anything that looks like a credential.
func (s simMail) SetMailboxPassword(_ context.Context, p providers.MailboxPasswordParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.findMailboxLocked(p.Address) == nil {
		return fmt.Errorf("mailbox %s: %w", p.Address, providers.ErrNotFound)
	}
	return nil
}

func (s simMail) ApplyAliases(_ context.Context, p providers.MailAliasApplyParams) error {
	s.mu.Lock()
	s.aliases[p.Domain] = append([]providers.MailAlias(nil), p.Aliases...)
	s.mu.Unlock()

	s.writeMailMaps(p.Domain)
	return nil
}

func (s simMail) ApplyForwarders(_ context.Context, p providers.MailForwarderApplyParams) error {
	s.mu.Lock()
	s.forwarders[p.Domain] = append([]providers.MailForwarder(nil), p.Forwarders...)
	s.mu.Unlock()

	s.writeMailMaps(p.Domain)
	return nil
}

func (s simMail) ReadDKIM(_ context.Context, p providers.MailDkimReadParams) (providers.DkimKeyInfo, error) {
	if !strings.EqualFold(p.Domain, s.id.mailDomain) {
		return providers.DkimKeyInfo{}, fmt.Errorf("no DKIM key for %s: %w", p.Domain, providers.ErrNotFound)
	}
	return providers.DkimKeyInfo{
		Selector:  dkimSelector,
		PublicKey: dkimPublicKey,
		KeyBits:   2048,
		TxtValue:  "v=DKIM1; h=sha256; k=rsa; p=" + dkimPublicKey,
	}, nil
}

func (s simMail) Queue(_ context.Context, p providers.MailQueueListParams) ([]providers.MailQueueEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.MailQueueEntry, len(s.mailQueue))
	copy(out, s.mailQueue)
	if p.Limit > 0 && len(out) > p.Limit {
		out = out[:p.Limit]
	}
	return out, nil
}

func (s simMail) Logs(ctx context.Context, p providers.MailLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	return s.tail(ctx, stream, tailRequest{
		source: sourceMail,
		lines:  p.Lines,
		follow: p.Follow,
		query:  p.Query,
	})
}

/* -------------------------------- dns -------------------------------- */

type simDNS struct{ *Sim }

// zone is what this host's resolver believes. It is deliberately not
// perfect: DMARC sits at p=quarantine and the PTR does not match the
// HELO name, so the mail-authentication checks have something true to
// report rather than a screen of green.
func (s *Sim) zone() map[string]map[string][]string {
	domain := s.id.mailDomain
	mail := "mail." + domain

	return map[string]map[string][]string{
		domain: {
			"A":     {s.id.publicIP},
			"MX":    {"10 " + mail + "."},
			"NS":    {"ns1.example-dns.net.", "ns2.example-dns.net."},
			"TXT":   {"v=spf1 mx a:" + mail + " -all", "google-site-verification=kAn4mE_5imUl4t3d"},
			"CAA":   {`0 issue "letsencrypt.org"`},
			"SOA":   {"ns1.example-dns.net. hostmaster." + domain + ". 2026082601 7200 3600 1209600 3600"},
			"AAAA":  {},
			"CNAME": {},
		},
		"www." + domain:                        {"CNAME": {domain + "."}, "A": {s.id.publicIP}},
		"api." + domain:                        {"A": {s.id.publicIP}},
		"blog." + domain:                       {"A": {s.id.publicIP}},
		"app." + domain:                        {"A": {s.id.publicIP}},
		"staging." + domain:                    {"A": {s.id.publicIP}},
		mail:                                   {"A": {s.id.publicIP}, "TXT": {"v=spf1 a -all"}},
		"imap." + domain:                       {"CNAME": {mail + "."}},
		"smtp." + domain:                       {"CNAME": {mail + "."}},
		dkimSelector + "._domainkey." + domain: {"TXT": {"v=DKIM1; h=sha256; k=rsa; p=" + dkimPublicKey}},
		"_dmarc." + domain:                     {"TXT": {"v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain + "; pct=100; adkim=r; aspf=r"}},
		"_autodiscover._tcp." + domain:         {"SRV": {"0 0 443 " + mail + "."}},
		reverseName(s.id.publicIP):             {"PTR": {s.id.hostname + "."}},
	}
}

func reverseName(ip string) string {
	parts := strings.Split(ip, ".")
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, ".") + ".in-addr.arpa"
}

func (s simDNS) Resolve(_ context.Context, p providers.DNSResolveParams) ([]providers.ResolvedRecord, error) {
	resolver := p.Resolver
	if resolver == "" {
		resolver = "127.0.0.53"
	}

	name := strings.TrimSuffix(strings.ToLower(p.Name), ".")
	recordType := strings.ToUpper(p.Type)

	values := s.zone()[name][recordType]
	if len(values) == 0 {
		// An empty answer is not an error: "the record is missing" is
		// exactly what a mail-authentication check needs to be told.
		return []providers.ResolvedRecord{}, nil
	}

	ttl := 300
	switch recordType {
	case "NS", "SOA":
		ttl = 86400
	case "MX", "TXT":
		ttl = 3600
	}

	return []providers.ResolvedRecord{{
		Name:     name,
		Type:     recordType,
		Values:   values,
		TTL:      ptr(ttl),
		Resolver: resolver,
	}}, nil
}
