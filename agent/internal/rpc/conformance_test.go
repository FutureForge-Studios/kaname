package rpc

import (
	_ "embed"
	"encoding/json"
	"sort"
	"testing"
)

/* ------------------------------------------------------------------ *
 * Contract conformance (KD-007).
 *
 * methods.json is emitted from packages/contract by
 * `pnpm --filter @kaname/contract emit:agent-manifest`. Embedding it and
 * asserting against the live registry turns "a method was renamed on one
 * side" from a silent runtime failure into a failing build.
 * ------------------------------------------------------------------ */

//go:embed methods.json
var manifestJSON []byte

type manifestMethod struct {
	Name     string   `json:"name"`
	Stream   string   `json:"stream"`
	Requires []string `json:"requires"`
	ReadOnly bool     `json:"read_only"`
	Summary  string   `json:"summary"`
}

type manifest struct {
	Protocol    int    `json:"protocol"`
	Subprotocol string `json:"subprotocol"`
	Limits      struct {
		StreamWindow          int `json:"stream_window"`
		MaxChunkBytes         int `json:"max_chunk_bytes"`
		PingIntervalMS        int `json:"ping_interval_ms"`
		PingTimeoutMultiplier int `json:"ping_timeout_multiplier"`
	} `json:"limits"`
	EventTopics []string         `json:"event_topics"`
	Methods     []manifestMethod `json:"methods"`
}

func loadManifest(t *testing.T) manifest {
	t.Helper()
	var m manifest
	if err := json.Unmarshal(manifestJSON, &m); err != nil {
		t.Fatalf("methods.json is not valid JSON: %v", err)
	}
	if len(m.Methods) == 0 {
		t.Fatal("methods.json declares no methods; run the emit:agent-manifest script")
	}
	return m
}

// registryUnderTest builds the registry the agent actually serves, with
// every capability present so nothing is gated out of the comparison.
func registryUnderTest(t *testing.T) *Registry {
	t.Helper()
	m := loadManifest(t)

	all := map[string]struct{}{}
	for _, method := range m.Methods {
		for _, c := range method.Requires {
			all[c] = struct{}{}
		}
	}
	caps := make([]string, 0, len(all))
	for c := range all {
		caps = append(caps, c)
	}

	r := NewRegistry(NewCapabilityGate(caps))
	RegisterHandlers(r, nil)
	return r
}

func TestProtocolConstantsMatchContract(t *testing.T) {
	m := loadManifest(t)

	if m.Protocol != ProtocolVersion {
		t.Errorf("protocol version: contract %d, agent %d", m.Protocol, ProtocolVersion)
	}
	if m.Subprotocol != Subprotocol {
		t.Errorf("subprotocol: contract %q, agent %q", m.Subprotocol, Subprotocol)
	}
	if m.Limits.StreamWindow != StreamWindow {
		t.Errorf("stream window: contract %d, agent %d", m.Limits.StreamWindow, StreamWindow)
	}
	if m.Limits.MaxChunkBytes != MaxChunkBytes {
		t.Errorf("max chunk bytes: contract %d, agent %d", m.Limits.MaxChunkBytes, MaxChunkBytes)
	}
}

func TestEveryContractMethodIsRegistered(t *testing.T) {
	m := loadManifest(t)
	registered := map[string]struct{}{}
	for _, name := range registryUnderTest(t).Names() {
		registered[name] = struct{}{}
	}

	var missing []string
	for _, method := range m.Methods {
		if _, ok := registered[method.Name]; !ok {
			missing = append(missing, method.Name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("the contract declares %d methods the agent does not serve: %v", len(missing), missing)
	}
}

func TestAgentRegistersNothingOutsideTheContract(t *testing.T) {
	m := loadManifest(t)
	declared := map[string]struct{}{}
	for _, method := range m.Methods {
		declared[method.Name] = struct{}{}
	}

	// An unlisted verb is an unreviewed hole in the attack surface, which
	// is the whole reason the registry is enumerated in the first place.
	var extra []string
	for _, name := range registryUnderTest(t).Names() {
		if _, ok := declared[name]; !ok {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		t.Errorf("the agent serves %d methods the contract does not declare: %v", len(extra), extra)
	}
}

func TestStreamModesMatchContract(t *testing.T) {
	m := loadManifest(t)
	r := registryUnderTest(t)

	for _, method := range m.Methods {
		resolved, rpcErr := r.Resolve(method.Name)
		if rpcErr != nil {
			continue // covered by TestEveryContractMethodIsRegistered
		}
		if string(resolved.Mode) != method.Stream {
			t.Errorf("%s: contract stream mode %q, agent %q", method.Name, method.Stream, resolved.Mode)
		}
	}
}

func TestCapabilityRequirementsMatchContract(t *testing.T) {
	m := loadManifest(t)
	r := registryUnderTest(t)

	for _, method := range m.Methods {
		resolved, rpcErr := r.Resolve(method.Name)
		if rpcErr != nil {
			continue
		}
		want := append([]string(nil), method.Requires...)
		got := append([]string(nil), resolved.Requires...)
		sort.Strings(want)
		sort.Strings(got)
		if len(want) != len(got) {
			t.Errorf("%s: contract requires %v, agent requires %v", method.Name, want, got)
			continue
		}
		for i := range want {
			if want[i] != got[i] {
				t.Errorf("%s: contract requires %v, agent requires %v", method.Name, want, got)
				break
			}
		}
	}
}

func TestNoMethodAcceptsAFreeFormCommand(t *testing.T) {
	m := loadManifest(t)

	// The security thesis in one assertion: there is no verb whose name
	// suggests arbitrary execution outside the deliberately-scoped PTY
	// paths, which are separately permissioned, ticketed and recorded.
	allowed := map[string]struct{}{
		"pty.open":       {},
		"pty.resize":     {},
		"pty.close":      {},
		"container.exec": {},
	}
	for _, method := range m.Methods {
		switch method.Name {
		case "exec", "shell", "run", "command", "eval", "system.exec", "system.shell":
			t.Errorf("%s is a free-form execution verb and must not exist", method.Name)
		}
		if _, ok := allowed[method.Name]; ok {
			continue
		}
		if method.Stream == "bidirectional" && method.Name != "fs.upload" {
			t.Errorf("%s streams bidirectionally but is not one of the audited interactive verbs", method.Name)
		}
	}
}

func TestUnknownMethodIsRejectedBeforeAnyHandlerRuns(t *testing.T) {
	r := registryUnderTest(t)
	_, rpcErr := r.Resolve("definitely.not.a.method")
	if rpcErr == nil {
		t.Fatal("expected an error for an unregistered method")
	}
	if rpcErr.Code != CodeUnknownMethod {
		t.Errorf("expected %q, got %q", CodeUnknownMethod, rpcErr.Code)
	}
}

func TestCapabilityGateRejectsWhatTheHostCannotServe(t *testing.T) {
	// A host with nothing installed should still refuse cleanly rather
	// than failing deep inside a provider.
	bare := NewRegistry(NewCapabilityGate(nil))
	RegisterHandlers(bare, nil)

	if _, rpcErr := bare.Resolve("service.list"); rpcErr == nil {
		t.Error("service.list should be unsupported without systemd")
	} else if rpcErr.Code != CodeUnsupported {
		t.Errorf("expected %q, got %q", CodeUnsupported, rpcErr.Code)
	}

	if _, rpcErr := bare.Resolve("system.info"); rpcErr != nil {
		t.Errorf("system.info requires no capability but was rejected: %v", rpcErr)
	}
}
