package rpc

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * The multiplexed agent connection.
 *
 * The agent dials out and never calls net.Listen, so its internet-facing
 * attack surface is nothing at all (KD-002). One socket carries typed
 * request/response, chunk streams in both directions, unsolicited
 * events and heartbeats. Exactly one goroutine owns the socket's write
 * side; everything else hands it frames.
 * ------------------------------------------------------------------ */

var errClosed = errors.New("agent connection is closed")

const (
	// A frame is one chunk plus envelope; twice the chunk cap leaves room
	// for base64 growth and the JSON wrapper.
	readLimit = 2 * MaxChunkBytes

	// How long an inbound chunk may wait for its handler before the whole
	// connection is declared stuck. Dropping the chunk instead would
	// silently corrupt an upload, so a stalled stream fails loudly.
	streamStallTimeout = 30 * time.Second

	tokenRequestTimeout = 20 * time.Second
	maxDeadline         = 6 * time.Hour
	minDeadline         = 100 * time.Millisecond
	shutdownGrace       = 5 * time.Second
)

// Options is everything Dial needs to reach the control plane and
// identify itself.
type Options struct {
	ServerID        string
	ControlPlaneURL string
	ConnectURL      string
	TLS             *tls.Config
	// PrivateKey proves possession of the enrolled identity when asking
	// for a connect token. It never leaves the host.
	PrivateKey   *ecdsa.PrivateKey
	AgentVersion string
	Capabilities []string
	Host         providers.HostInfo
	Registry     *Registry
	Logger       *slog.Logger
}

type Conn struct {
	opts     Options
	log      *slog.Logger
	ws       *websocket.Conn
	out      chan []byte
	serveCtx context.Context

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	streams  map[string]*Stream

	missedPongs atomic.Int32

	handlers  sync.WaitGroup
	closeOnce sync.Once
	closed    chan struct{}
	closeErr  atomic.Value
}

/* -------------------------------- dial ------------------------------- */

// Dial fetches a short-lived bearer over the mTLS-authenticated token
// endpoint, upgrades the WebSocket with it and announces the host.
func Dial(ctx context.Context, opts Options) (*Conn, error) {
	if opts.Registry == nil {
		return nil, errors.New("rpc: a method registry is required")
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:     opts.TLS,
			TLSHandshakeTimeout: 15 * time.Second,
			ForceAttemptHTTP2:   true,
		},
		Timeout: tokenRequestTimeout,
	}

	token, err := fetchToken(ctx, client, opts)
	if err != nil {
		return nil, err
	}

	ws, resp, err := websocket.Dial(ctx, opts.ConnectURL, &websocket.DialOptions{
		HTTPClient:   client,
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
		Subprotocols: []string{Subprotocol},
	})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("connect %s: %w (http %d)", opts.ConnectURL, err, resp.StatusCode)
		}
		return nil, fmt.Errorf("connect %s: %w", opts.ConnectURL, err)
	}
	ws.SetReadLimit(readLimit)

	c := &Conn{
		opts:     opts,
		log:      log,
		ws:       ws,
		out:      make(chan []byte, 256),
		inflight: make(map[string]context.CancelFunc),
		streams:  make(map[string]*Stream),
		closed:   make(chan struct{}),
	}

	hello := HelloFrame{
		T:            TagHello,
		Proto:        ProtocolVersion,
		AgentVersion: opts.AgentVersion,
		Capabilities: opts.Capabilities,
		Host:         opts.Host,
	}
	// Written directly: the writer goroutine only starts in Serve, so
	// there is no second owner of the socket yet.
	raw, err := json.Marshal(hello)
	if err != nil {
		_ = ws.CloseNow()
		return nil, fmt.Errorf("marshal hello: %w", err)
	}
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		_ = ws.CloseNow()
		return nil, fmt.Errorf("send hello: %w", err)
	}

	return c, nil
}

/* -------------------------------- serve ------------------------------ */

// Serve runs the connection until the socket dies or ctx is cancelled.
func (c *Conn) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.serveCtx = ctx

	go c.writeLoop(ctx)
	go c.pingLoop(ctx)

	err := c.readLoop(ctx)
	c.shutdown(err)
	if stored, ok := c.closeErr.Load().(error); ok && stored != nil {
		return stored
	}
	return err
}

func (c *Conn) readLoop(ctx context.Context) error {
	for {
		kind, data, err := c.ws.Read(ctx)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if kind != websocket.MessageText {
			c.log.Debug("ignoring non-text frame", "type", kind.String())
			continue
		}
		c.route(ctx, data)
	}
}

func (c *Conn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case frame := <-c.out:
			if err := c.ws.Write(ctx, websocket.MessageText, frame); err != nil {
				c.fail(fmt.Errorf("write: %w", err))
				return
			}
		}
	}
}

func (c *Conn) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case <-ticker.C:
			if c.missedPongs.Load() >= PingTimeoutMultiplier {
				c.fail(errors.New("control plane missed heartbeats"))
				return
			}
			c.missedPongs.Add(1)
			if err := c.write(ctx, PingFrame{T: TagPing, Ts: time.Now().UnixMilli()}); err != nil {
				return
			}
		}
	}
}

func (c *Conn) route(ctx context.Context, raw []byte) {
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.log.Warn("malformed frame from control plane")
		return
	}

	switch env.T {
	case TagRequest:
		c.handleRequest(ctx, raw)

	case TagCancel:
		var frame CancelFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return
		}
		c.cancelInflight(frame.ID)

	case TagChunk:
		var frame ChunkFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return
		}
		if s := c.stream(frame.ID); s != nil {
			s.deliver(ctx, frame)
		}

	case TagAck:
		var frame AckFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return
		}
		if s := c.stream(frame.ID); s != nil {
			s.acknowledge(frame.Seq)
		}

	case TagEnd:
		var frame EndFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return
		}
		if s := c.stream(frame.ID); s != nil {
			s.closeInput()
		}

	case TagPing:
		var frame PingFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return
		}
		_ = c.write(ctx, PongFrame{T: TagPong, Ts: frame.Ts})

	case TagPong:
		c.missedPongs.Store(0)

	default:
		c.log.Debug("ignoring unknown frame", "t", env.T)
	}
}

/* ------------------------------ requests ----------------------------- */

func (c *Conn) handleRequest(ctx context.Context, raw []byte) {
	var frame RequestFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		c.log.Warn("malformed request frame")
		return
	}
	if frame.ID == "" {
		c.log.Warn("request without an id", "method", frame.Method)
		return
	}

	method, rpcErr := c.opts.Registry.Resolve(frame.Method)
	if rpcErr != nil {
		c.finish(frame.ID, StreamNone, nil, rpcErr)
		return
	}

	// Deadlines are mandatory: an RPC with no bound is a leak waiting for
	// a host that has gone away.
	if frame.DeadlineMS <= 0 {
		c.finish(frame.ID, method.Mode, nil, Errorf(CodeInvalidParams, "deadline_ms is required"))
		return
	}
	deadline := time.Duration(frame.DeadlineMS) * time.Millisecond
	if deadline < minDeadline {
		deadline = minDeadline
	}
	if deadline > maxDeadline {
		deadline = maxDeadline
	}

	reqCtx, cancel := context.WithTimeout(ctx, deadline)

	c.mu.Lock()
	if _, busy := c.inflight[frame.ID]; busy {
		c.mu.Unlock()
		cancel()
		c.finish(frame.ID, method.Mode, nil, Errorf(CodeConflict, "request id %s is already in flight", frame.ID))
		return
	}
	c.inflight[frame.ID] = cancel
	var stream *Stream
	if method.Mode != StreamNone {
		stream = newStream(frame.ID, c)
		c.streams[frame.ID] = stream
	}
	c.mu.Unlock()

	req := &Request{
		ID:       frame.ID,
		Method:   frame.Method,
		Params:   frame.Params,
		Stream:   stream,
		Deadline: deadline,
	}

	c.handlers.Add(1)
	go func() {
		defer c.handlers.Done()
		defer cancel()

		result, err := method.Handler(reqCtx, req)

		c.mu.Lock()
		delete(c.inflight, frame.ID)
		delete(c.streams, frame.ID)
		c.mu.Unlock()
		if stream != nil {
			stream.closeInput()
		}

		c.finish(frame.ID, method.Mode, result, err)
	}()
}

// finish settles one request. A streaming method also gets an end frame:
// the res carries the value the method declares, the end closes the
// chunk stream.
func (c *Conn) finish(id string, mode StreamMode, result any, err error) {
	ctx := c.serveCtx
	if ctx == nil {
		ctx = context.Background()
	}

	if err != nil {
		wireErr := asError(err)
		_ = c.write(ctx, ResponseFrame{T: TagResponse, ID: id, OK: false, Error: wireErr})
		if mode != StreamNone {
			_ = c.write(ctx, EndFrame{T: TagEnd, ID: id, OK: false, Error: wireErr})
		}
		return
	}

	_ = c.write(ctx, ResponseFrame{T: TagResponse, ID: id, OK: true, Result: result})
	if mode != StreamNone {
		_ = c.write(ctx, EndFrame{T: TagEnd, ID: id, OK: true})
	}
}

func (c *Conn) cancelInflight(id string) {
	c.mu.Lock()
	cancel := c.inflight[id]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Conn) stream(id string) *Stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[id]
}

/* ------------------------------- events ------------------------------ */

// Emit pushes an unsolicited event: metrics, state changes, threats.
func (c *Conn) Emit(ctx context.Context, topic string, data any) error {
	return c.write(ctx, EventFrame{
		T:     TagEvent,
		Topic: topic,
		Ts:    time.Now().UTC().Format(time.RFC3339Nano),
		Data:  data,
	})
}

/* ------------------------------ lifecycle ---------------------------- */

func (c *Conn) write(ctx context.Context, frame any) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("marshal frame: %w", err)
	}
	select {
	case c.out <- raw:
		return nil
	case <-c.closed:
		return errClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// fail records the first error that killed the connection and unblocks
// everyone waiting on it.
func (c *Conn) fail(err error) {
	c.closeOnce.Do(func() {
		if err != nil {
			c.closeErr.Store(err)
		}
		close(c.closed)
		_ = c.ws.CloseNow()
	})
}

func (c *Conn) shutdown(cause error) {
	c.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(c.inflight))
	for _, cancel := range c.inflight {
		cancels = append(cancels, cancel)
	}
	c.inflight = make(map[string]context.CancelFunc)
	streams := c.streams
	c.streams = make(map[string]*Stream)
	c.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
	for _, s := range streams {
		s.closeInput()
	}

	c.fail(cause)

	done := make(chan struct{})
	go func() {
		c.handlers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownGrace):
		c.log.Warn("handlers did not stop within the shutdown grace period")
	}
}

// Close ends the connection cleanly, telling the control plane why.
func (c *Conn) Close(reason string) {
	select {
	case <-c.closed:
		return
	default:
	}
	_ = c.ws.Close(websocket.StatusNormalClosure, truncate(reason, 120))
	c.fail(nil)
}

/* ------------------------------- streams ----------------------------- */

// Stream is one request's chunk traffic. Outbound chunks respect the
// contract's 32-chunk window; inbound chunks are acknowledged every half
// window, which is what the control plane's sender waits on.
type Stream struct {
	id   string
	conn *Conn

	mu    sync.Mutex
	next  int
	acked int

	ackSignal chan struct{}
	in        chan []byte
	received  int

	inClosed  chan struct{}
	closeOnce sync.Once
}

func newStream(id string, conn *Conn) *Stream {
	return &Stream{
		id:        id,
		conn:      conn,
		ackSignal: make(chan struct{}, 1),
		in:        make(chan []byte, StreamWindow),
		inClosed:  make(chan struct{}),
	}
}

// Send writes data to the control plane, splitting it into chunks that
// fit the frame cap and pausing when the window is full.
func (s *Stream) Send(ctx context.Context, data []byte, enc providers.Encoding) error {
	if len(data) == 0 {
		return nil
	}

	if enc == providers.EncodingBase64 {
		// 3 raw bytes become 4 encoded ones; stay under the frame cap.
		const raw = MaxChunkBytes / 4 * 3
		for len(data) > 0 {
			n := min(raw, len(data))
			if err := s.emit(ctx, base64.StdEncoding.EncodeToString(data[:n]), EncodingBase64); err != nil {
				return err
			}
			data = data[n:]
		}
		return nil
	}

	for len(data) > 0 {
		n := len(data)
		if n > MaxChunkBytes {
			n = runeBoundary(data, MaxChunkBytes)
		}
		if err := s.emit(ctx, string(data[:n]), EncodingUTF8); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (s *Stream) emit(ctx context.Context, payload string, enc Encoding) error {
	if err := s.awaitWindow(ctx); err != nil {
		return err
	}

	s.mu.Lock()
	seq := s.next
	s.next++
	s.mu.Unlock()

	return s.conn.write(ctx, ChunkFrame{T: TagChunk, ID: s.id, Seq: seq, Data: payload, Encoding: enc})
}

func (s *Stream) awaitWindow(ctx context.Context) error {
	for {
		s.mu.Lock()
		inFlight := s.next - s.acked
		s.mu.Unlock()
		if inFlight < StreamWindow {
			return nil
		}
		select {
		case <-s.ackSignal:
		case <-ctx.Done():
			return ctx.Err()
		case <-s.conn.closed:
			return errClosed
		}
	}
}

func (s *Stream) acknowledge(seq int) {
	s.mu.Lock()
	if seq+1 > s.acked {
		s.acked = seq + 1
	}
	s.mu.Unlock()

	select {
	case s.ackSignal <- struct{}{}:
	default:
	}
}

// Recv reads the next inbound chunk, returning io.EOF once the control
// plane has closed its side.
func (s *Stream) Recv(ctx context.Context) ([]byte, error) {
	select {
	case data := <-s.in:
		return data, nil
	default:
	}

	select {
	case data := <-s.in:
		return data, nil
	case <-s.inClosed:
		return nil, io.EOF
	case <-s.conn.closed:
		return nil, errClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Stream) deliver(ctx context.Context, frame ChunkFrame) {
	data := []byte(frame.Data)
	if frame.Encoding == EncodingBase64 {
		decoded, err := base64.StdEncoding.DecodeString(frame.Data)
		if err != nil {
			s.conn.log.Warn("undecodable chunk", "id", s.id, "seq", frame.Seq)
			return
		}
		data = decoded
	}

	select {
	case s.in <- data:
	case <-s.inClosed:
		return
	case <-s.conn.closed:
		return
	case <-time.After(streamStallTimeout):
		s.conn.fail(fmt.Errorf("stream %s stalled with a full window", s.id))
		return
	}

	s.mu.Lock()
	s.received++
	due := s.received%(StreamWindow/2) == 0
	s.mu.Unlock()

	if due {
		_ = s.conn.write(ctx, AckFrame{T: TagAck, ID: s.id, Seq: frame.Seq})
	}
}

func (s *Stream) closeInput() {
	s.closeOnce.Do(func() { close(s.inClosed) })
}

/* -------------------------------- token ------------------------------ */

type tokenRequest struct {
	ServerID  string `json:"server_id"`
	Nonce     string `json:"nonce"`
	Timestamp int64  `json:"timestamp"`
	Signature string `json:"signature"`
}

type tokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

// fetchToken proves possession of the enrolled private key and exchanges
// that proof for a five-minute bearer. A revoked certificate therefore
// fails within one token lifetime, with no CRL round-trip.
func fetchToken(ctx context.Context, client *http.Client, opts Options) (string, error) {
	if opts.PrivateKey == nil {
		return "", errors.New("rpc: no private key; run `kanamed enroll` first")
	}

	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	timestamp := time.Now().UnixMilli()

	signature, err := signChallenge(opts.PrivateKey, fmt.Sprintf("%s|%s|%d", opts.ServerID, nonce, timestamp))
	if err != nil {
		return "", err
	}

	body, err := json.Marshal(tokenRequest{
		ServerID:  opts.ServerID,
		Nonce:     nonce,
		Timestamp: timestamp,
		Signature: signature,
	})
	if err != nil {
		return "", fmt.Errorf("marshal token request: %w", err)
	}

	endpoint, err := url.JoinPath(opts.ControlPlaneURL, "/agent/v1/token")
	if err != nil {
		return "", fmt.Errorf("build token url: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request connect token: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("read token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("connect token rejected (http %d): %s", resp.StatusCode, truncate(string(payload), 400))
	}

	var parsed tokenResponse
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if parsed.Token == "" {
		return "", errors.New("control plane returned an empty connect token")
	}
	return parsed.Token, nil
}

// signChallenge produces a raw r||s P-256 signature. WebCrypto — which
// is what verifies it — rejects the ASN.1 form crypto.Signer would give.
func signChallenge(key *ecdsa.PrivateKey, message string) (string, error) {
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign challenge: %w", err)
	}

	size := (key.Curve.Params().BitSize + 7) / 8
	out := make([]byte, 2*size)
	padInto(out[:size], r)
	padInto(out[size:], s)
	return base64.RawURLEncoding.EncodeToString(out), nil
}

func padInto(dst []byte, value *big.Int) {
	raw := value.Bytes()
	copy(dst[len(dst)-len(raw):], raw)
}

/* ------------------------------- helpers ----------------------------- */

// asError maps a handler's error onto a wire error code. Context
// outcomes are reported honestly: a deadline is a timeout, a cancel is a
// cancel, neither is an internal failure.
func asError(err error) *Error {
	var coded *Error
	if errors.As(err, &coded) {
		return coded
	}

	var execErr *providers.ExecError
	if errors.As(err, &execErr) {
		return Errorf(CodeExecFailed, "%s", execErr.Error()).WithOutput(execErr.Output)
	}

	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return Errorf(CodeTimeout, "%s", err.Error())
	case errors.Is(err, context.Canceled):
		return Errorf(CodeCancelled, "%s", err.Error())
	case errors.Is(err, providers.ErrUnsupported):
		return Errorf(CodeUnsupported, "%s", err.Error())
	case errors.Is(err, providers.ErrNotFound):
		return Errorf(CodeNotFound, "%s", err.Error())
	case errors.Is(err, providers.ErrPermissionDenied):
		return Errorf(CodePermissionDenied, "%s", err.Error())
	case errors.Is(err, providers.ErrConflict):
		return Errorf(CodeConflict, "%s", err.Error())
	case errors.Is(err, providers.ErrPreconditionFailed):
		return Errorf(CodePreconditionFailed, "%s", err.Error())
	case errors.Is(err, providers.ErrInvalidParams):
		return Errorf(CodeInvalidParams, "%s", err.Error())
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return Errorf(CodeIOError, "%s", err.Error())
	default:
		return Errorf(CodeInternal, "%s", err.Error())
	}
}

// runeBoundary backs a split point up to the start of a rune so a chunk
// never carries half a character into JSON.
func runeBoundary(data []byte, limit int) int {
	n := limit
	for n > 0 && !utf8.RuneStart(data[n]) {
		n--
	}
	if n == 0 {
		return limit
	}
	return n
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit]
}
