package rpc

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

/* ------------------------------------------------------------------ *
 * Method registry.
 *
 * This map IS the agent's attack surface. Every entry is an enumerated
 * verb with a typed parameter struct; there is no dynamic dispatch by
 * string from user input and no verb that accepts a shell command. A
 * name that is not in this map is answered with `unknown_method` before
 * any provider sees it.
 * ------------------------------------------------------------------ */

// StreamMode describes a method's chunk traffic, mirroring the
// contract's StreamMode.
type StreamMode string

const (
	StreamNone          StreamMode = "none"
	StreamResponse      StreamMode = "response"
	StreamBidirectional StreamMode = "bidirectional"
)

// Request is one inbound call. Stream is non-nil exactly when the
// method's mode is not StreamNone.
type Request struct {
	ID       string
	Method   string
	Params   json.RawMessage
	Stream   *Stream
	Deadline time.Duration
}

// Handler serves one request. A streaming handler writes its chunks to
// req.Stream and returns the method's declared result when the stream is
// finished.
type Handler func(ctx context.Context, req *Request) (any, error)

// Method is a registered verb.
type Method struct {
	Name string
	Mode StreamMode
	// Requires lists host capabilities, any one of which admits the call.
	// Empty means every host can serve it.
	Requires []string
	Handler  Handler
}

// CapabilityGate answers "can this host serve this method at all",
// using the same capability set the agent advertised in its hello frame.
// Failing here is what turns a missing daemon into a fast `unsupported`
// instead of a confusing exec failure deep in a provider.
type CapabilityGate struct {
	have map[string]struct{}
}

func NewCapabilityGate(capabilities []string) CapabilityGate {
	have := make(map[string]struct{}, len(capabilities))
	for _, c := range capabilities {
		have[c] = struct{}{}
	}
	return CapabilityGate{have: have}
}

func (g CapabilityGate) Has(capability string) bool {
	_, ok := g.have[capability]
	return ok
}

// Allows reports whether any one of the required capabilities is
// present. An empty requirement list always passes.
func (g CapabilityGate) Allows(required []string) bool {
	if len(required) == 0 {
		return true
	}
	for _, c := range required {
		if g.Has(c) {
			return true
		}
	}
	return false
}

type Registry struct {
	mu      sync.RWMutex
	methods map[string]Method
	gate    CapabilityGate
}

func NewRegistry(gate CapabilityGate) *Registry {
	return &Registry{methods: make(map[string]Method), gate: gate}
}

// Register adds a verb. A duplicate name replaces nothing and panics,
// because two handlers for one method name is a build-time mistake.
func (r *Registry) Register(m Method) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.methods[m.Name]; exists {
		panic("rpc: method registered twice: " + m.Name)
	}
	r.methods[m.Name] = m
}

// Resolve looks a method up and gates it on host capabilities.
func (r *Registry) Resolve(name string) (Method, *Error) {
	r.mu.RLock()
	m, ok := r.methods[name]
	r.mu.RUnlock()

	if !ok {
		return Method{}, Errorf(CodeUnknownMethod, "no such method: %s", name)
	}
	if !r.gate.Allows(m.Requires) {
		return Method{}, Errorf(CodeUnsupported, "host does not provide %s", joinOr(m.Requires))
	}
	return m, nil
}

// Names lists every registered method, sorted.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.methods))
	for name := range r.methods {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func joinOr(items []string) string {
	switch len(items) {
	case 0:
		return "anything"
	case 1:
		return items[0]
	}
	out := items[0]
	for _, item := range items[1:] {
		out += " or " + item
	}
	return out
}
