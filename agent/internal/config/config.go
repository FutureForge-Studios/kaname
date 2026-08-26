package config

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

/* ------------------------------------------------------------------ *
 * Agent state.
 *
 * One directory, four files, all 0600 inside a 0700 directory:
 *
 *   key.pem     the EC P-256 private key, generated on this host and
 *               never transmitted anywhere
 *   cert.pem    the client certificate the control plane signed, CN =
 *               the server's id
 *   ca.pem      the control plane's agent CA
 *   state.json  everything else the agent must remember across restarts
 *
 * Writes go through a temp file and a rename so a crash mid-write
 * cannot leave the agent with a half-written identity.
 * ------------------------------------------------------------------ */

const (
	KeyFile   = "key.pem"
	CertFile  = "cert.pem"
	CAFile    = "ca.pem"
	StateFile = "state.json"

	dirPerm  = 0o700
	filePerm = 0o600
)

// ErrNotEnrolled is returned when the state directory holds no identity.
var ErrNotEnrolled = errors.New("this host is not enrolled")

// State is the contents of state.json.
type State struct {
	ServerID string `json:"server_id"`
	// ControlPlaneURL is the https origin used for token requests.
	ControlPlaneURL string `json:"control_plane_url"`
	// ConnectURL is the wss endpoint the control plane assigned at
	// enrollment.
	ConnectURL string `json:"connect_url"`
	// MachineID is persisted so a host without /etc/machine-id still
	// presents a stable identity across restarts.
	MachineID     string    `json:"machine_id"`
	AgentVersion  string    `json:"agent_version"`
	EnrolledAt    time.Time `json:"enrolled_at"`
	CertExpiresAt time.Time `json:"cert_expires_at"`
}

// Store is an opened state directory.
type Store struct {
	dir   string
	State State
}

// DefaultStateDir is where a packaged agent keeps its identity.
func DefaultStateDir() string {
	if runtime.GOOS == "linux" {
		return "/var/lib/kaname"
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(".", ".kaname")
	}
	return filepath.Join(base, "kaname")
}

// Open creates the state directory if needed and loads state.json.
func Open(dir string) (*Store, error) {
	if dir == "" {
		dir = DefaultStateDir()
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve state dir: %w", err)
	}
	if err := os.MkdirAll(absolute, dirPerm); err != nil {
		return nil, fmt.Errorf("create state dir %s: %w", absolute, err)
	}

	store := &Store{dir: absolute}

	raw, err := os.ReadFile(filepath.Join(absolute, StateFile))
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", StateFile, err)
	}
	if err := json.Unmarshal(raw, &store.State); err != nil {
		return nil, fmt.Errorf("parse %s: %w", StateFile, err)
	}
	return store, nil
}

func (s *Store) Dir() string { return s.dir }

// Path resolves one of the state directory's files.
func (s *Store) Path(name string) string { return filepath.Join(s.dir, name) }

// Enrolled reports whether this host has a usable identity.
func (s *Store) Enrolled() bool {
	if s.State.ServerID == "" {
		return false
	}
	for _, name := range []string{KeyFile, CertFile, CAFile} {
		if _, err := os.Stat(s.Path(name)); err != nil {
			return false
		}
	}
	return true
}

// Save writes state.json atomically.
func (s *Store) Save() error {
	raw, err := json.MarshalIndent(s.State, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", StateFile, err)
	}
	return s.WriteFile(StateFile, append(raw, '\n'))
}

// WriteFile writes one state file atomically with 0600 permissions.
func (s *Store) WriteFile(name string, data []byte) error {
	target := s.Path(name)

	temp, err := os.CreateTemp(s.dir, "."+name+".*")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", name, err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if err := temp.Chmod(filePerm); err != nil {
		temp.Close()
		return fmt.Errorf("chmod %s: %w", name, err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync %s: %w", name, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}
	if err := os.Rename(tempName, target); err != nil {
		return fmt.Errorf("install %s: %w", name, err)
	}
	return nil
}

// ReadFile reads one state file.
func (s *Store) ReadFile(name string) ([]byte, error) {
	raw, err := os.ReadFile(s.Path(name))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return raw, nil
}

// PrivateKey loads the host's enrolled key. It is read here and nowhere
// else, and it is never sent anywhere: only signatures made with it are.
func (s *Store) PrivateKey() (*ecdsa.PrivateKey, error) {
	raw, err := s.ReadFile(KeyFile)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s does not contain a PEM block", KeyFile)
	}

	switch block.Type {
	case "EC PRIVATE KEY":
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", KeyFile, err)
		}
		return key, nil
	case "PRIVATE KEY":
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", KeyFile, err)
		}
		key, ok := parsed.(*ecdsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("%s is not an EC key", KeyFile)
		}
		return key, nil
	default:
		return nil, fmt.Errorf("%s holds an unexpected %q block", KeyFile, block.Type)
	}
}

// TLSConfig builds the client side of the mTLS connection.
func (s *Store) TLSConfig() (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(s.Path(CertFile), s.Path(KeyFile))
	if err != nil {
		return nil, fmt.Errorf("load client certificate: %w", err)
	}

	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	// A self-hosted panel commonly serves TLS from the same internal CA
	// that signed this agent, and that CA arrived over an already
	// verified enrollment connection.
	if ca, err := s.ReadFile(CAFile); err == nil {
		roots.AppendCertsFromPEM(ca)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// CertificateExpiry reads not-after from the installed certificate.
func (s *Store) CertificateExpiry() (time.Time, error) {
	raw, err := s.ReadFile(CertFile)
	if err != nil {
		return time.Time{}, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return time.Time{}, fmt.Errorf("%s does not contain a PEM block", CertFile)
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse %s: %w", CertFile, err)
	}
	return certificate.NotAfter, nil
}
