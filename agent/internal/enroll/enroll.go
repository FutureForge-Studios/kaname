package enroll

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/config"
	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Enrollment.
 *
 * The keypair is generated here, on the managed host, and the private
 * half never leaves it — only a CSR is transmitted. The control plane
 * signs it with CN = the server's id, which is how every later
 * connection is bound to one row in the panel (PLAN.md 2.3).
 * ------------------------------------------------------------------ */

const requestTimeout = 30 * time.Second

// Request is the body of POST /agent/v1/enroll.
type Request struct {
	Token        string             `json:"token"`
	CSRPEM       string             `json:"csr_pem"`
	Host         providers.HostInfo `json:"host"`
	AgentVersion string             `json:"agent_version"`
}

// Response is what the control plane returns once the CSR is signed.
type Response struct {
	ServerID       string `json:"server_id"`
	CertificatePEM string `json:"certificate_pem"`
	CAPEM          string `json:"ca_pem"`
	ConnectURL     string `json:"connect_url"`
	ExpiresAt      string `json:"expires_at"`
}

type Options struct {
	Token           string
	ControlPlaneURL string
	AgentVersion    string
	Host            providers.HostInfo
	HTTPClient      *http.Client
	Logger          *slog.Logger
}

// Run enrolls this host and persists the resulting identity.
func Run(ctx context.Context, store *config.Store, opts Options) error {
	if opts.Token == "" {
		return errors.New("an enrollment token is required")
	}
	if opts.ControlPlaneURL == "" {
		return errors.New("the control plane url is required")
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	host := opts.Host
	if host.MachineID == "" {
		machineID, err := stableMachineID(store)
		if err != nil {
			return err
		}
		host.MachineID = machineID
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate host key: %w", err)
	}
	csrPEM, err := certificateRequest(key, host.Hostname)
	if err != nil {
		return err
	}
	keyPEM, err := encodeKey(key)
	if err != nil {
		return err
	}

	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: requestTimeout}
	}

	response, err := submit(ctx, client, opts.ControlPlaneURL, Request{
		Token:        opts.Token,
		CSRPEM:       string(csrPEM),
		Host:         host,
		AgentVersion: opts.AgentVersion,
	})
	if err != nil {
		return err
	}

	if err := store.WriteFile(config.KeyFile, keyPEM); err != nil {
		return err
	}
	if err := store.WriteFile(config.CertFile, []byte(response.CertificatePEM)); err != nil {
		return err
	}
	if err := store.WriteFile(config.CAFile, []byte(response.CAPEM)); err != nil {
		return err
	}

	expiresAt, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil {
		expiresAt = time.Time{}
	}

	store.State.ServerID = response.ServerID
	store.State.ControlPlaneURL = strings.TrimRight(opts.ControlPlaneURL, "/")
	store.State.ConnectURL = response.ConnectURL
	store.State.MachineID = host.MachineID
	store.State.AgentVersion = opts.AgentVersion
	store.State.EnrolledAt = time.Now().UTC()
	store.State.CertExpiresAt = expiresAt
	if err := store.Save(); err != nil {
		return err
	}

	log.Info("enrolled",
		"server_id", response.ServerID,
		"hostname", host.Hostname,
		"connect_url", response.ConnectURL,
		"cert_expires_at", response.ExpiresAt,
	)
	return nil
}

func submit(ctx context.Context, client *http.Client, base string, body Request) (Response, error) {
	var out Response

	endpoint, err := url.JoinPath(base, "/agent/v1/enroll")
	if err != nil {
		return out, fmt.Errorf("build enrollment url: %w", err)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return out, fmt.Errorf("encode enrollment request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return out, fmt.Errorf("build enrollment request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return out, fmt.Errorf("enroll against %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return out, fmt.Errorf("read enrollment response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("enrollment rejected (http %d): %s", resp.StatusCode, string(raw))
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("decode enrollment response: %w", err)
	}
	if out.ServerID == "" || out.CertificatePEM == "" || out.CAPEM == "" || out.ConnectURL == "" {
		return out, errors.New("enrollment response is missing an identity field")
	}
	return out, nil
}

func certificateRequest(key *ecdsa.PrivateKey, hostname string) ([]byte, error) {
	// The subject is advisory: the control plane overwrites it with
	// CN = server id, because an agent does not get to name itself.
	template := x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: hostname, Organization: []string{"Kaname Agents"}},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}
	if hostname != "" {
		template.DNSNames = []string{hostname}
	}

	der, err := x509.CreateCertificateRequest(rand.Reader, &template, key)
	if err != nil {
		return nil, fmt.Errorf("create csr: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

func encodeKey(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode host key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

/* ------------------------------ host probe --------------------------- */

// ProbeHost reads the facts that identify this machine. Enrollment runs
// before a provider is chosen, so this deliberately uses nothing but the
// standard library and the files every Linux host has.
func ProbeHost() (providers.HostInfo, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return providers.HostInfo{}, fmt.Errorf("read hostname: %w", err)
	}

	info := providers.HostInfo{
		Hostname:  hostname,
		MachineID: readMachineID(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Kernel:    readTrimmed("/proc/sys/kernel/osrelease"),
		BootTime:  bootTime().UTC().Format(time.RFC3339),
	}

	release := parseOSRelease("/etc/os-release")
	if id := release["ID"]; id != "" {
		info.OS = id
	}
	if version := release["VERSION_ID"]; version != "" {
		info.OSVersion = version
	}
	return info, nil
}

func readMachineID() string {
	for _, candidate := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if id := readTrimmed(candidate); id != "" {
			return id
		}
	}
	return ""
}

// stableMachineID reuses the id from a previous enrollment, or mints one
// for a host that has no /etc/machine-id, so the panel does not see a
// new machine on every restart.
func stableMachineID(store *config.Store) (string, error) {
	if store.State.MachineID != "" {
		return store.State.MachineID, nil
	}
	if id := readMachineID(); id != "" {
		return id, nil
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate machine id: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func parseOSRelease(path string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found {
			continue
		}
		out[key] = strings.Trim(value, `"`)
	}
	return out
}

func bootTime() time.Time {
	uptime := readTrimmed("/proc/uptime")
	if uptime == "" {
		return time.Now()
	}
	seconds, _, _ := strings.Cut(uptime, " ")
	elapsed, err := time.ParseDuration(seconds + "s")
	if err != nil {
		return time.Now()
	}
	return time.Now().Add(-elapsed)
}

func readTrimmed(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
