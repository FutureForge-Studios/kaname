package rpc

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * In-process protocol harness.
 *
 * A real httptest server plays the control plane: it issues the connect
 * token, accepts the WebSocket upgrade with the contract's subprotocol,
 * and then drives the wire by hand. Every test in conn_test.go therefore
 * exercises the actual framing, multiplexing, streaming and backpressure
 * code rather than a stand-in for it.
 * ------------------------------------------------------------------ */

const (
	// Long enough to survive a loaded CI box under -race, short enough
	// that a genuinely stuck connection fails the test rather than the
	// package timeout.
	peerTimeout = 3 * time.Second

	// How long "and nothing more arrives" is observed for. This is the
	// assertion backpressure hangs on, so it has to outlast a scheduler
	// hiccup without making the suite slow.
	quietWindow = 250 * time.Millisecond

	testServerID = "11111111-2222-3333-4444-555555555555"
	testToken    = "kn_connect_test_token"
)

/* -------------------------- frames off the wire ---------------------- */

// wireFrame is every field an agent-sent frame may carry. Tests decode
// once and assert on the fields their tag defines. `ts` stays raw
// because a ping carries a number there and an event carries a string.
type wireFrame struct {
	T            string             `json:"t"`
	ID           string             `json:"id"`
	OK           bool               `json:"ok"`
	Result       json.RawMessage    `json:"result"`
	Error        *Error             `json:"error"`
	Seq          int                `json:"seq"`
	Data         json.RawMessage    `json:"data"`
	Encoding     Encoding           `json:"encoding"`
	Topic        string             `json:"topic"`
	Ts           json.RawMessage    `json:"ts"`
	Proto        int                `json:"proto"`
	AgentVersion string             `json:"agent_version"`
	Capabilities []string           `json:"capabilities"`
	Host         providers.HostInfo `json:"host"`

	raw []byte
}

// text is a chunk frame's data field as the string it is on the wire,
// before the declared encoding is undone.
func (f wireFrame) text(t *testing.T) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(f.Data, &s); err != nil {
		t.Fatalf("chunk %d carries no string in data: %v", f.Seq, err)
	}
	return s
}

// bytes returns the chunk payload with the frame's declared encoding
// undone, which is what a control plane would hand its consumer.
func (f wireFrame) bytes(t *testing.T) []byte {
	t.Helper()
	payload := f.text(t)
	if f.Encoding == EncodingBase64 {
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			t.Fatalf("chunk %d is not decodable base64: %v", f.Seq, err)
		}
		return decoded
	}
	return []byte(payload)
}

/* ----------------------------- the peer ------------------------------ */

// peer is the control-plane side of the socket: one reader goroutine
// feeding a channel, so a test can assert on what did *not* arrive
// without a read deadline tearing the connection down.
type peer struct {
	ws     *websocket.Conn
	frames chan wireFrame
	dead   chan struct{}
}

func (p *peer) read() {
	defer close(p.dead)
	for {
		_, data, err := p.ws.Read(context.Background())
		if err != nil {
			return
		}
		var f wireFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return
		}
		f.raw = data
		select {
		case p.frames <- f:
		default:
			return // the test stopped reading; nothing left to assert
		}
	}
}

// await waits up to d for the agent's next frame. The heartbeat tests
// have to outlast a whole ping interval, which is why the wait is a
// parameter rather than the constant.
func (p *peer) await(t *testing.T, d time.Duration) wireFrame {
	t.Helper()
	select {
	case f := <-p.frames:
		return f
	case <-p.dead:
		select {
		case f := <-p.frames:
			return f
		default:
			t.Fatal("the agent closed the socket while a frame was expected")
		}
	case <-time.After(d):
		t.Fatal("timed out waiting for a frame from the agent")
	}
	return wireFrame{}
}

// next returns the agent's next frame, failing the test if the agent
// goes quiet or the socket dies first.
func (p *peer) next(t *testing.T) wireFrame {
	t.Helper()
	return p.await(t, peerTimeout)
}

// expect is next plus a tag assertion.
func (p *peer) expect(t *testing.T, tag string) wireFrame {
	t.Helper()
	f := p.next(t)
	if f.T != tag {
		t.Fatalf("expected a %q frame, got %q: %s", tag, f.T, truncate(string(f.raw), 240))
	}
	return f
}

// quiet asserts the agent sends nothing at all for d. It is how a
// blocked producer is distinguished from a slow one.
func (p *peer) quiet(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case f := <-p.frames:
		t.Fatalf("expected silence, got a %q frame: %s", f.T, truncate(string(f.raw), 240))
	case <-time.After(d):
	}
}

func (p *peer) send(t *testing.T, frame any) {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame for the agent: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), peerTimeout)
	defer cancel()
	if err := p.ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write frame to the agent: %v", err)
	}
}

/* ---------------------------- the harness ---------------------------- */

type harness struct {
	t    *testing.T
	conn *Conn
	peer *peer

	key   *ecdsa.PrivateKey
	hello wireFrame
	// token is the proof-of-possession the agent presented at the token
	// endpoint, and auth the bearer it then carried into the upgrade.
	token tokenRequest
	auth  string

	serveErr   chan error
	serveOnce  sync.Once
	serveOut   error
	serveEnded bool
}

// dial stands the control plane up and brings the agent connection to
// the point just after its hello frame. Serve is not running yet.
func dial(t *testing.T, registry *Registry) *harness {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate an agent key: %v", err)
	}

	tokenReqs := make(chan tokenRequest, 4)
	auths := make(chan string, 4)
	accepted := make(chan *websocket.Conn, 1)
	done := make(chan struct{})

	mux := http.NewServeMux()
	mux.HandleFunc("/agent/v1/token", func(w http.ResponseWriter, r *http.Request) {
		var req tokenRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		select {
		case tokenReqs <- req:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tokenResponse{
			Token:     testToken,
			ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/agent/v1/connect", func(w http.ResponseWriter, r *http.Request) {
		select {
		case auths <- r.Header.Get("Authorization"):
		default:
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Subprotocol}})
		if err != nil {
			return
		}
		// Chunk frames run to MAX_CHUNK_BYTES plus their envelope, well
		// past this library's 32 KiB default.
		ws.SetReadLimit(4 * MaxChunkBytes)
		accepted <- ws
		<-done
		_ = ws.CloseNow()
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(done) })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := Dial(ctx, Options{
		ServerID:        testServerID,
		ControlPlaneURL: srv.URL,
		ConnectURL:      "ws" + strings.TrimPrefix(srv.URL, "http") + "/agent/v1/connect",
		PrivateKey:      key,
		AgentVersion:    "0.0.0-test",
		Capabilities:    []string{providers.CapSystemd, providers.CapDocker, providers.CapSimulate},
		Host: providers.HostInfo{
			Hostname:  "harness-01",
			MachineID: "machine-harness-01",
			OS:        "linux",
			OSVersion: "12",
			Arch:      "amd64",
			Kernel:    "6.1.0-test",
			BootTime:  time.Unix(1700000000, 0).UTC().Format(time.RFC3339),
			Simulated: true,
		},
		Registry: registry,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("dial the control plane: %v", err)
	}

	var ws *websocket.Conn
	select {
	case ws = <-accepted:
	case <-time.After(peerTimeout):
		t.Fatal("the control plane never accepted the upgrade")
	}

	h := &harness{
		t:    t,
		conn: conn,
		peer: &peer{ws: ws, frames: make(chan wireFrame, 4096), dead: make(chan struct{})},
	}
	h.key = key
	select {
	case h.token = <-tokenReqs:
	default:
		t.Fatal("the agent connected without asking for a token")
	}
	select {
	case h.auth = <-auths:
	default:
	}

	go h.peer.read()
	h.hello = h.peer.expect(t, TagHello)
	return h
}

// serve runs the connection loops for the rest of the test.
func (h *harness) serve() {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.serveErr = make(chan error, 1)
	go func() { h.serveErr <- h.conn.Serve(ctx) }()
	h.t.Cleanup(func() {
		cancel()
		h.waitServe()
	})
}

// waitServe returns whatever Serve returned, once, so a test and the
// cleanup can both ask.
func (h *harness) waitServe() error {
	h.serveOnce.Do(func() {
		select {
		case err := <-h.serveErr:
			h.serveOut = err
			h.serveEnded = true
		case <-time.After(3 * peerTimeout):
		}
	})
	if !h.serveEnded {
		h.t.Error("Serve never returned")
	}
	return h.serveOut
}

// connect is dial plus serve: the shape almost every test wants.
func connect(t *testing.T, registry *Registry) *harness {
	t.Helper()
	h := dial(t, registry)
	h.serve()
	return h
}

func (h *harness) request(id, method string, params any, deadline time.Duration) {
	h.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		h.t.Fatalf("marshal params: %v", err)
	}
	h.peer.send(h.t, RequestFrame{
		T:          TagRequest,
		ID:         id,
		Method:     method,
		Params:     raw,
		DeadlineMS: int(deadline / time.Millisecond),
	})
}

/* ---------------------------- test methods --------------------------- */

// probes is the observation surface of the test handlers: what ran, what
// each handler's context reported when it woke, and how far a producer
// got before backpressure stopped it.
type probes struct {
	calls   atomic.Int32
	sent    atomic.Int32
	started chan string
	ctxErrs chan error

	mu       sync.Mutex
	releases map[string]chan struct{}
}

func newProbes() *probes {
	return &probes{
		started:  make(chan string, 16),
		ctxErrs:  make(chan error, 16),
		releases: map[string]chan struct{}{},
	}
}

// release returns the gate for one request key, creating it on first
// use so the test can hold it open before the request is even sent.
func (p *probes) release(key string) chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	ch, ok := p.releases[key]
	if !ok {
		ch = make(chan struct{})
		p.releases[key] = ch
	}
	return ch
}

func (p *probes) letGo(key string) { close(p.release(key)) }

// awaitStart blocks until n handlers have entered, returning their keys.
func (p *probes) awaitStart(t *testing.T, n int) []string {
	t.Helper()
	keys := make([]string, 0, n)
	for i := 0; i < n; i++ {
		select {
		case key := <-p.started:
			keys = append(keys, key)
		case <-time.After(peerTimeout):
			t.Fatalf("only %d of %d handlers started", len(keys), n)
		}
	}
	return keys
}

// awaitCtxErr returns what a handler's context reported when it woke.
func (p *probes) awaitCtxErr(t *testing.T) error {
	t.Helper()
	select {
	case err := <-p.ctxErrs:
		return err
	case <-time.After(peerTimeout):
		t.Fatal("the handler's context was never cancelled")
	}
	return nil
}

type blockParams struct {
	Key string `json:"key"`
}

// testRegistry is a purpose-built verb list. The connection tests must
// fail on framing, not on a provider, so none of these touch one.
func testRegistry(p *probes) *Registry {
	r := NewRegistry(NewCapabilityGate(nil))

	// test.block parks until the test releases it or its context ends,
	// which is what makes deadlines, cancellation, duplicate ids and
	// socket loss observable.
	r.Register(Method{Name: "test.block", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p.calls.Add(1)
		var args blockParams
		_ = json.Unmarshal(req.Params, &args)
		p.started <- args.Key

		select {
		case <-p.release(args.Key):
			return map[string]string{"key": args.Key}, nil
		case <-ctx.Done():
			p.ctxErrs <- ctx.Err()
			return nil, ctx.Err()
		}
	}})

	// test.stream emits `count` small chunks and optionally fails after
	// them, which covers ordering, termination and mid-flight errors.
	r.Register(Method{Name: "test.stream", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p.calls.Add(1)
		var args struct {
			Count int  `json:"count"`
			Fail  bool `json:"fail"`
		}
		if err := json.Unmarshal(req.Params, &args); err != nil {
			return nil, Errorf(CodeInvalidParams, "%s", err)
		}
		for i := 0; i < args.Count; i++ {
			if err := req.Stream.Send(ctx, []byte(fmt.Sprintf("chunk-%d", i)), providers.EncodingUTF8); err != nil {
				return nil, err
			}
			p.sent.Add(1)
		}
		if args.Fail {
			return nil, Errorf(CodeIOError, "the log source went away")
		}
		return map[string]any{"count": args.Count}, nil
	}})

	// test.text sends one oversized UTF-8 payload in a single Send, so
	// the split is entirely the stream's decision.
	r.Register(Method{Name: "test.text", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p.calls.Add(1)
		var args struct {
			Runes int `json:"runes"`
		}
		if err := json.Unmarshal(req.Params, &args); err != nil {
			return nil, Errorf(CodeInvalidParams, "%s", err)
		}
		if err := req.Stream.Send(ctx, snowfield(args.Runes), providers.EncodingUTF8); err != nil {
			return nil, err
		}
		return map[string]any{"bytes": len(snowfield(args.Runes))}, nil
	}})

	// test.binary is the same for the base64 path.
	r.Register(Method{Name: "test.binary", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p.calls.Add(1)
		var args struct {
			Bytes int `json:"bytes"`
		}
		if err := json.Unmarshal(req.Params, &args); err != nil {
			return nil, Errorf(CodeInvalidParams, "%s", err)
		}
		if err := req.Stream.Send(ctx, blob(args.Bytes), providers.EncodingBase64); err != nil {
			return nil, err
		}
		return map[string]any{"bytes": args.Bytes}, nil
	}})

	// test.sink drains an inbound stream, which is the direction the
	// agent's own ack cadence lives on.
	r.Register(Method{Name: "test.sink", Mode: StreamBidirectional, Handler: func(ctx context.Context, req *Request) (any, error) {
		p.calls.Add(1)
		var got []byte
		chunks := 0
		for {
			data, err := req.Stream.Recv(ctx)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, err
			}
			got = append(got, data...)
			chunks++
		}
		// b64 as well as text: a JSON string cannot carry arbitrary bytes
		// intact, so the binary assertion needs a lossless field.
		return map[string]any{
			"chunks": chunks,
			"text":   string(got),
			"b64":    base64.StdEncoding.EncodeToString(got),
		}, nil
	}})

	return r
}

/* ------------------------------ payloads ----------------------------- */

// snowfield is a run of three-byte runes. 3 does not divide
// MAX_CHUNK_BYTES, so a naive split lands one byte inside a rune —
// exactly the case runeBoundary exists for.
func snowfield(runes int) []byte {
	return []byte(strings.Repeat("☃", runes))
}

// blob is deterministic non-text bytes for the base64 path.
func blob(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i*7 + 11)
	}
	return out
}

/* ------------------------------- helpers ----------------------------- */

// verifySignature checks the agent's proof of possession the way the
// control plane does: raw r||s over sha256("server_id|nonce|timestamp").
func verifySignature(t *testing.T, key *ecdsa.PrivateKey, req tokenRequest) bool {
	t.Helper()
	sig, err := base64.RawURLEncoding.DecodeString(req.Signature)
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	if len(sig) != 64 {
		t.Fatalf("expected a 64-byte P-256 signature, got %d bytes", len(sig))
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", req.ServerID, req.Nonce, req.Timestamp)))
	return ecdsa.Verify(&key.PublicKey, digest[:],
		new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func decodeResult(t *testing.T, f wireFrame, into any) {
	t.Helper()
	if err := json.Unmarshal(f.Result, into); err != nil {
		t.Fatalf("decode result of %s: %v", f.ID, err)
	}
}
