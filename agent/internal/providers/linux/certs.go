//go:build linux

package linux

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Certificates.
 *
 * Issuance and renewal are certbot's job; this file only ever hands it
 * an argv slice. Listing does not need certbot at all — the certificates
 * on disk are parsed directly, so a host that got its certificate some
 * other way still shows an honest expiry in the panel.
 *
 * DNS-01 is deliberately not driven from here: authoritative record
 * writes belong to the control plane's DNS provider (PLAN.md 2.4), and
 * an agent that could edit a zone would be a much larger blast radius
 * than one that cannot.
 * ------------------------------------------------------------------ */

const (
	letsEncryptDir = "/etc/letsencrypt/live"
	// Where externally-issued material installed through cert.install
	// lands, so the panel has one predictable place to point a web server at.
	installedCertDir = "/etc/ssl/kaname"
)

type certOps struct{ p *provider }

func (o certOps) List(ctx context.Context) ([]providers.CertificateInfo, error) {
	roots := []string{letsEncryptDir, installedCertDir}
	certificates := make([]providers.CertificateInfo, 0, 8)
	seen := map[string]struct{}{}

	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if ctx.Err() != nil {
				return certificates, ctx.Err()
			}
			if !entry.IsDir() {
				continue
			}
			target := firstExisting(
				path.Join(root, entry.Name(), "fullchain.pem"),
				path.Join(root, entry.Name(), "cert.pem"),
			)
			if target == "" {
				continue
			}
			info, err := readCertificate(target)
			if err != nil {
				o.p.log.Debug("unreadable certificate", "path", target, "error", err)
				continue
			}
			if _, duplicate := seen[info.Subject+info.NotAfter]; duplicate {
				continue
			}
			seen[info.Subject+info.NotAfter] = struct{}{}
			certificates = append(certificates, info)
		}
	}

	sortSlice(certificates, func(a, b providers.CertificateInfo) bool { return a.NotAfter < b.NotAfter })
	return certificates, nil
}

func (o certOps) Issue(ctx context.Context, p providers.CertIssueParams, stream providers.Stream) (providers.CertIssueResult, error) {
	if err := o.p.require(providers.CapCertbot); err != nil {
		return providers.CertIssueResult{}, err
	}
	if p.Challenge == "dns-01" {
		return providers.CertIssueResult{}, unsupported("dns-01 issuance is driven by the control plane's DNS provider, not by the agent")
	}
	for _, domain := range p.Domains {
		if err := checkDomain(domain); err != nil {
			return providers.CertIssueResult{}, err
		}
	}

	name := p.Domains[0]
	args := []string{
		"certonly", "--non-interactive", "--agree-tos", "--keep-until-expiring",
		"--email", p.Email, "--cert-name", name, "--key-type", p.KeyType,
	}
	switch {
	case p.Webroot != "":
		webroot, err := validatePath(p.Webroot)
		if err != nil {
			return providers.CertIssueResult{}, err
		}
		args = append(args, "--webroot", "-w", webroot)
	case o.p.has(providers.CapNginx):
		args = append(args, "--nginx")
	default:
		args = append(args, "--standalone")
	}
	if p.Staging {
		args = append(args, "--staging")
	}
	for _, domain := range p.Domains {
		args = append(args, "-d", domain)
	}

	if _, err := runStream(ctx, stream, execOptions{Name: "certbot", Args: args, Env: cLocale()}); err != nil {
		return providers.CertIssueResult{}, err
	}

	issued, err := readCertificate(path.Join(letsEncryptDir, name, "fullchain.pem"))
	if err != nil {
		return providers.CertIssueResult{}, err
	}
	return providers.CertIssueResult{
		Subject:  issued.Subject,
		Sans:     issued.Sans,
		NotAfter: issued.NotAfter,
		Path:     issued.Path,
	}, nil
}

func (o certOps) Renew(ctx context.Context, p providers.CertRenewParams, stream providers.Stream) (providers.CertRenewResult, error) {
	if err := o.p.require(providers.CapCertbot); err != nil {
		return providers.CertRenewResult{}, err
	}
	if err := checkDomain(p.Subject); err != nil {
		return providers.CertRenewResult{}, err
	}

	args := []string{"renew", "--non-interactive", "--cert-name", p.Subject}
	if p.Force {
		args = append(args, "--force-renewal")
	}
	if _, err := runStream(ctx, stream, execOptions{Name: "certbot", Args: args, Env: cLocale()}); err != nil {
		return providers.CertRenewResult{}, err
	}

	renewed, err := readCertificate(path.Join(letsEncryptDir, p.Subject, "fullchain.pem"))
	if err != nil {
		return providers.CertRenewResult{}, err
	}
	return providers.CertRenewResult{NotAfter: renewed.NotAfter}, nil
}

func (o certOps) Revoke(ctx context.Context, p providers.CertRevokeParams) error {
	if err := o.p.require(providers.CapCertbot); err != nil {
		return err
	}
	if err := checkDomain(p.Subject); err != nil {
		return err
	}
	if err := checkRevocationReason(p.Reason); err != nil {
		return err
	}

	_, err := runWith(ctx, execOptions{
		Name: "certbot",
		Args: []string{
			"revoke", "--non-interactive", "--cert-name", p.Subject,
			"--reason", p.Reason, "--delete-after-revoke",
		},
		Env: cLocale(),
	})
	return err
}

func (o certOps) Install(ctx context.Context, p providers.CertInstallParams) (providers.CertInstallResult, error) {
	if err := checkDomain(p.Subject); err != nil {
		return providers.CertInstallResult{}, err
	}
	if _, err := parsePEMChain([]byte(p.CertificatePEM)); err != nil {
		return providers.CertInstallResult{}, invalid("certificate_pem is not a valid certificate: %s", err)
	}
	if block, _ := pem.Decode([]byte(p.KeyPEM)); block == nil {
		return providers.CertInstallResult{}, invalid("key_pem does not contain a PEM block")
	}

	dir := path.Join(installedCertDir, p.Subject)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return providers.CertInstallResult{}, wrapFsError(dir, err)
	}

	chain := p.CertificatePEM
	if p.ChainPEM != "" {
		chain = strings.TrimRight(p.CertificatePEM, "\n") + "\n" + p.ChainPEM
	}

	// The private key is the one file here that must never be world
	// readable, so it is written 0600 while the chain stays 0644.
	files := []struct {
		name string
		data string
		mode os.FileMode
	}{
		{"cert.pem", p.CertificatePEM, 0o644},
		{"fullchain.pem", chain, 0o644},
		{"privkey.pem", p.KeyPEM, 0o600},
	}
	for _, file := range files {
		if err := writeAtomic(path.Join(dir, file.name), []byte(file.data), file.mode); err != nil {
			return providers.CertInstallResult{}, err
		}
	}

	_ = ctx
	return providers.CertInstallResult{Path: path.Join(dir, "fullchain.pem")}, nil
}

/* ------------------------------- parsing ----------------------------- */

func readCertificate(target string) (providers.CertificateInfo, error) {
	raw, err := os.ReadFile(target)
	if err != nil {
		return providers.CertificateInfo{}, wrapFsError(target, err)
	}
	certificate, err := parsePEMChain(raw)
	if err != nil {
		return providers.CertificateInfo{}, fmt.Errorf("parse %s: %w", target, err)
	}

	sans := append([]string{}, certificate.DNSNames...)
	for _, ip := range certificate.IPAddresses {
		sans = append(sans, ip.String())
	}

	return providers.CertificateInfo{
		Subject:   certificate.Subject.CommonName,
		Sans:      sans,
		Issuer:    certificate.Issuer.CommonName,
		NotBefore: rfc3339(certificate.NotBefore),
		NotAfter:  rfc3339(certificate.NotAfter),
		Path:      target,
		KeyType:   keyType(certificate),
	}, nil
}

// parsePEMChain returns the leaf, which in a fullchain file is always the
// first certificate.
func parsePEMChain(raw []byte) (*x509.Certificate, error) {
	for len(raw) > 0 {
		block, rest := pem.Decode(raw)
		if block == nil {
			break
		}
		raw = rest
		if block.Type != "CERTIFICATE" {
			continue
		}
		return x509.ParseCertificate(block.Bytes)
	}
	return nil, fmt.Errorf("no CERTIFICATE block found")
}

func keyType(certificate *x509.Certificate) string {
	switch key := certificate.PublicKey.(type) {
	case *rsa.PublicKey:
		return "rsa-" + strconv.Itoa(key.N.BitLen())
	case *ecdsa.PublicKey:
		return "ecdsa-" + strconv.Itoa(key.Curve.Params().BitSize)
	case ed25519.PublicKey:
		return "ed25519"
	default:
		return "unknown"
	}
}

/* ------------------------------ validation --------------------------- */

// checkDomain accepts a hostname or a wildcard label and nothing that
// could be read as a flag or a path segment.
func checkDomain(domain string) error {
	if domain == "" || len(domain) > 253 || strings.HasPrefix(domain, "-") {
		return invalid("%q is not a usable domain name", domain)
	}
	if strings.ContainsAny(domain, `/\ `) || strings.ContainsRune(domain, 0) {
		return invalid("%q is not a usable domain name", domain)
	}

	for _, label := range strings.Split(strings.TrimSuffix(domain, "."), ".") {
		if label == "" || len(label) > 63 {
			return invalid("%q is not a usable domain name", domain)
		}
		if label == "*" {
			continue
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			switch {
			case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			default:
				return invalid("%q is not a usable domain name", domain)
			}
		}
	}
	return nil
}

func checkRevocationReason(reason string) error {
	switch reason {
	case "unspecified", "keycompromise", "affiliationchanged", "superseded", "cessationofoperation":
		return nil
	default:
		return invalid("reason %q is not an ACME revocation reason", reason)
	}
}

// certificatePaths reports where a subject's material lives, preferring
// Let's Encrypt's layout and falling back to what cert.install wrote.
func certificatePaths(subject string) (string, string) {
	for _, root := range []string{letsEncryptDir, installedCertDir} {
		chain := filepath.Join(root, subject, "fullchain.pem")
		key := filepath.Join(root, subject, "privkey.pem")
		if fileExists(chain) && fileExists(key) {
			return chain, key
		}
	}
	return "", ""
}
