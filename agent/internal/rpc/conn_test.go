package rpc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

/* ------------------------------------------------------------------ *
 * The connection itself.
 *
 * conformance_test.go pins the method registry against the contract.
 * This file pins the socket: framing, multiplexing, deadlines,
 * cancellation, streaming, the 32-chunk window, chunk splitting,
 * heartbeats and what happens when the socket dies. Every test drives a
 * real WebSocket from the control-plane side.
 * ------------------------------------------------------------------ */

/* -------------------------------- hello ------------------------------ */

func TestHelloIsTheFirstFrameAndDescribesTheHost(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	// dial() reads exactly one frame before anything else happens, so
	// arriving here at all means hello came first.
	if h.hello.T != TagHello {
		t.Fatalf("the first frame was %q, not %q", h.hello.T, TagHello)
	}
	if h.hello.Proto != ProtocolVersion {
		t.Errorf("hello announced proto %d, contract says %d", h.hello.Proto, ProtocolVersion)
	}
	if h.hello.AgentVersion != "0.0.0-test" {
		t.Errorf("hello announced agent version %q", h.hello.AgentVersion)
	}

	want := []string{"systemd", "docker", "simulated"}
	if len(h.hello.Capabilities) != len(want) {
		t.Fatalf("hello announced capabilities %v, want %v", h.hello.Capabilities, want)
	}
	for i := range want {
		if h.hello.Capabilities[i] != want[i] {
			t.Fatalf("hello announced capabilities %v, want %v", h.hello.Capabilities, want)
		}
	}

	// The hub pins the server row from these, so a dropped field is not
	// cosmetic.
	if h.hello.Host.Hostname != "harness-01" || h.hello.Host.MachineID != "machine-harness-01" {
		t.Errorf("hello lost host identity: %+v", h.hello.Host)
	}
	if h.hello.Host.Arch != "amd64" || h.hello.Host.Kernel != "6.1.0-test" {
		t.Errorf("hello lost host detail: %+v", h.hello.Host)
	}
	if !h.hello.Host.Simulated {
		t.Error("a simulated host must say so in hello (KD-010)")
	}
}

func TestConnectProvesPossessionOfTheEnrolledKey(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	if h.token.ServerID != testServerID {
		t.Errorf("token request carried server id %q", h.token.ServerID)
	}
	if h.token.Nonce == "" {
		t.Error("token request carried no nonce")
	}
	if drift := time.Since(time.UnixMilli(h.token.Timestamp)); drift < 0 || drift > time.Minute {
		t.Errorf("token request timestamp is %v off", drift)
	}
	// KD-014: the control plane verifies raw r||s over
	// sha256("server_id|nonce|timestamp"). Anything else fails there.
	if !verifySignature(t, h.key, h.token) {
		t.Error("the challenge signature does not verify against the agent's public key")
	}

	if h.auth != "Bearer "+testToken {
		t.Errorf("the upgrade carried %q, not the connect token", h.auth)
	}
	// KD-020: a subprotocol name is an RFC 7230 token, and the server
	// only ever selects this one.
	if got := h.peer.ws.Subprotocol(); got != Subprotocol {
		t.Errorf("negotiated subprotocol %q, want %q", got, Subprotocol)
	}
}

/* --------------------------- request/response ------------------------ */

func TestRequestGetsExactlyOneResponse(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	p.letGo("solo")
	h.request("r1", "test.block", blockParams{Key: "solo"}, time.Second)

	res := h.peer.expect(t, TagResponse)
	if res.ID != "r1" {
		t.Fatalf("response correlated to %q, not r1", res.ID)
	}
	if !res.OK {
		t.Fatalf("expected a successful response, got %v", res.Error)
	}
	var out blockParams
	decodeResult(t, res, &out)
	if out.Key != "solo" {
		t.Errorf("response carried key %q", out.Key)
	}

	// A non-streaming method gets a res and nothing else — no end frame,
	// no duplicate response.
	h.peer.quiet(t, quietWindow)
}

func TestConcurrentRequestsDoNotCrossResults(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("req-a", "test.block", blockParams{Key: "a"}, 5*time.Second)
	h.request("req-b", "test.block", blockParams{Key: "b"}, 5*time.Second)

	started := p.awaitStart(t, 2)
	seen := map[string]bool{started[0]: true, started[1]: true}
	if !seen["a"] || !seen["b"] {
		t.Fatalf("both handlers should be in flight, saw %v", started)
	}

	// Finish them in the opposite order to their arrival: the responses
	// must follow the handlers, not the requests.
	p.letGo("b")
	first := h.peer.expect(t, TagResponse)
	p.letGo("a")
	second := h.peer.expect(t, TagResponse)

	for _, c := range []struct{ id, key string }{{first.ID, "b"}, {second.ID, "a"}} {
		if c.id != "req-"+c.key {
			t.Fatalf("expected the %q result on req-%s, got it on %q", c.key, c.key, c.id)
		}
	}
	for _, res := range []wireFrame{first, second} {
		var out blockParams
		decodeResult(t, res, &out)
		if "req-"+out.Key != res.ID {
			t.Errorf("response %s carried key %q — results crossed", res.ID, out.Key)
		}
	}
}

func TestDuplicateRequestIDIsRejected(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("dup", "test.block", blockParams{Key: "held"}, 5*time.Second)
	p.awaitStart(t, 1)

	// Reusing an in-flight id would make the second result unroutable,
	// so it is refused rather than silently overwriting the first.
	h.request("dup", "test.block", blockParams{Key: "other"}, 5*time.Second)
	res := h.peer.expect(t, TagResponse)
	if res.OK || res.Error == nil || res.Error.Code != CodeConflict {
		t.Fatalf("expected a %q error, got ok=%v err=%v", CodeConflict, res.OK, res.Error)
	}
	if calls := p.calls.Load(); calls != 1 {
		t.Errorf("the duplicate reached a handler: %d calls", calls)
	}

	p.letGo("held")
	if first := h.peer.expect(t, TagResponse); !first.OK {
		t.Errorf("the original request was disturbed: %v", first.Error)
	}
}

func TestUnknownMethodNeverReachesAHandler(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("u1", "definitely.not.a.method", blockParams{Key: "x"}, time.Second)

	res := h.peer.expect(t, TagResponse)
	if res.ID != "u1" {
		t.Fatalf("response correlated to %q, not u1", res.ID)
	}
	if res.OK || res.Error == nil {
		t.Fatalf("an unregistered method must fail, got ok=%v", res.OK)
	}
	if res.Error.Code != CodeUnknownMethod {
		t.Errorf("expected %q, got %q", CodeUnknownMethod, res.Error.Code)
	}
	// The registry is the attack surface; nothing outside it may run.
	if calls := p.calls.Load(); calls != 0 {
		t.Errorf("%d handlers ran for an unregistered method", calls)
	}
	h.peer.quiet(t, quietWindow)
}

/* ------------------------------ deadlines ---------------------------- */

func TestRequestWithoutADeadlineIsRejected(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	// Deadlines are mandatory: an unbounded RPC is a leak waiting for a
	// host that has gone away.
	h.peer.send(t, RequestFrame{T: TagRequest, ID: "nd", Method: "test.block", DeadlineMS: 0})

	res := h.peer.expect(t, TagResponse)
	if res.OK || res.Error == nil || res.Error.Code != CodeInvalidParams {
		t.Fatalf("expected %q, got ok=%v err=%v", CodeInvalidParams, res.OK, res.Error)
	}
	if calls := p.calls.Load(); calls != 0 {
		t.Errorf("a deadline-less request reached %d handlers", calls)
	}
}

func TestDeadlineCancelsTheHandlerAndTellsThePeer(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("dl", "test.block", blockParams{Key: "never"}, 150*time.Millisecond)
	p.awaitStart(t, 1)

	// The context the handler was handed is the thing that has to fire;
	// a response the handler never agreed to would leave work running.
	if err := p.awaitCtxErr(t); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("handler context reported %v, want DeadlineExceeded", err)
	}

	res := h.peer.expect(t, TagResponse)
	if res.OK || res.Error == nil || res.Error.Code != CodeTimeout {
		t.Fatalf("expected %q, got ok=%v err=%v", CodeTimeout, res.OK, res.Error)
	}
}

func TestCancelFrameStopsAnInFlightRequest(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("cx", "test.block", blockParams{Key: "hold"}, 30*time.Second)
	p.awaitStart(t, 1)
	h.peer.send(t, CancelFrame{T: TagCancel, ID: "cx"})

	if err := p.awaitCtxErr(t); !errors.Is(err, context.Canceled) {
		t.Fatalf("handler context reported %v, want Canceled", err)
	}
	res := h.peer.expect(t, TagResponse)
	if res.OK || res.Error == nil || res.Error.Code != CodeCancelled {
		t.Fatalf("expected %q, got ok=%v err=%v", CodeCancelled, res.OK, res.Error)
	}
}

func TestCancellingOneRequestLeavesTheOthersAlone(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("keep", "test.block", blockParams{Key: "keep"}, 30*time.Second)
	h.request("kill", "test.block", blockParams{Key: "kill"}, 30*time.Second)
	p.awaitStart(t, 2)

	h.peer.send(t, CancelFrame{T: TagCancel, ID: "kill"})
	res := h.peer.expect(t, TagResponse)
	if res.ID != "kill" {
		t.Fatalf("cancel took down %q instead", res.ID)
	}
	if res.Error == nil || res.Error.Code != CodeCancelled {
		t.Fatalf("expected %q, got %v", CodeCancelled, res.Error)
	}

	p.letGo("keep")
	survivor := h.peer.expect(t, TagResponse)
	if survivor.ID != "keep" || !survivor.OK {
		t.Fatalf("the untouched request came back as %s ok=%v err=%v", survivor.ID, survivor.OK, survivor.Error)
	}
}

/* ------------------------------ streaming ---------------------------- */

func TestResponseStreamIsOrderedAndTerminated(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	h.request("st", "test.stream", map[string]any{"count": 5}, 5*time.Second)
	chunks, res, end := drainStream(t, h.peer, "st")

	if len(chunks) != 5 {
		t.Fatalf("expected 5 chunks, got %d", len(chunks))
	}
	assertSeq(t, chunks, 0)
	for i, f := range chunks {
		if got, want := f.text(t), "chunk-"+strconv.Itoa(i); got != want {
			t.Errorf("chunk %d carried %q, want %q", i, got, want)
		}
		if f.Encoding != EncodingUTF8 {
			t.Errorf("chunk %d declared encoding %q", i, f.Encoding)
		}
	}

	if !res.OK {
		t.Fatalf("expected a successful response, got %v", res.Error)
	}
	var out struct {
		Count int `json:"count"`
	}
	decodeResult(t, res, &out)
	if out.Count != 5 {
		t.Errorf("response carried count %d", out.Count)
	}
	if !end.OK || end.ID != "st" {
		t.Errorf("stream ended as ok=%v on %q", end.OK, end.ID)
	}
}

func TestStreamThatFailsMidFlightEndsNotOK(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	h.request("bad", "test.stream", map[string]any{"count": 3, "fail": true}, 5*time.Second)
	chunks, res, end := drainStream(t, h.peer, "bad")

	// The chunks already delivered stay delivered; the failure rides on
	// the terminator so a consumer knows the tail is missing.
	if len(chunks) != 3 {
		t.Fatalf("expected the 3 chunks sent before the failure, got %d", len(chunks))
	}
	assertSeq(t, chunks, 0)

	if res.OK || res.Error == nil || res.Error.Code != CodeIOError {
		t.Fatalf("expected the response to carry %q, got ok=%v err=%v", CodeIOError, res.OK, res.Error)
	}
	if end.OK {
		t.Fatal("a stream that failed mid-flight must end with ok:false")
	}
	if end.Error == nil || end.Error.Code != CodeIOError {
		t.Fatalf("end frame carried %v", end.Error)
	}
}

/* ---------------------------- backpressure --------------------------- */

// This is the property that stops a chatty `journalctl -f` from OOMing
// the control plane: a producer faster than its consumer has to stop at
// the window, not buffer.
func TestOutboundStreamBlocksOnTheWindowUntilAcked(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	const total = 2 * StreamWindow
	h.request("bp", "test.stream", map[string]any{"count": total}, 30*time.Second)

	first := readChunks(t, h.peer, "bp", StreamWindow)
	assertSeq(t, first, 0)

	// Nothing has been acknowledged, so the window is full and the
	// producer must be parked inside Send.
	h.peer.quiet(t, quietWindow)
	if sent := p.sent.Load(); sent != StreamWindow {
		t.Fatalf("the producer got %d chunks out with a full window; the window is %d", sent, StreamWindow)
	}

	// Acknowledging half the window releases exactly half of it.
	h.peer.send(t, AckFrame{T: TagAck, ID: "bp", Seq: StreamWindow/2 - 1})
	second := readChunks(t, h.peer, "bp", StreamWindow/2)
	assertSeq(t, second, StreamWindow)

	h.peer.quiet(t, quietWindow)
	if sent := p.sent.Load(); sent != StreamWindow+StreamWindow/2 {
		t.Fatalf("after one half-window ack the producer had sent %d chunks", sent)
	}

	// Draining the rest lets it run to completion.
	h.peer.send(t, AckFrame{T: TagAck, ID: "bp", Seq: total - StreamWindow/2 - 1})
	rest, res, end := drainStream(t, h.peer, "bp")
	if len(rest) != StreamWindow/2 {
		t.Fatalf("expected the final %d chunks, got %d", StreamWindow/2, len(rest))
	}
	assertSeq(t, rest, StreamWindow+StreamWindow/2)
	if !res.OK || !end.OK {
		t.Fatalf("the stream should have finished cleanly: res=%v end=%v", res.Error, end.Error)
	}

	all := append(append(first, second...), rest...)
	for i, f := range all {
		if got, want := f.text(t), "chunk-"+strconv.Itoa(i); got != want {
			t.Fatalf("chunk %d carried %q, want %q — the window reordered the stream", i, got, want)
		}
	}
}

func TestInboundChunksAreAckedEveryHalfWindow(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	h.request("sink", "test.sink", map[string]any{}, 10*time.Second)
	for i := 0; i < StreamWindow; i++ {
		h.peer.send(t, ChunkFrame{T: TagChunk, ID: "sink", Seq: i, Data: "x", Encoding: EncodingUTF8})
	}
	h.peer.send(t, EndFrame{T: TagEnd, ID: "sink", OK: true})

	// The control plane's sender waits on these; missing one stalls an
	// upload permanently instead of visibly.
	for _, want := range []int{StreamWindow/2 - 1, StreamWindow - 1} {
		ack := h.peer.expect(t, TagAck)
		if ack.ID != "sink" {
			t.Fatalf("ack landed on stream %q", ack.ID)
		}
		if ack.Seq != want {
			t.Fatalf("expected an ack at seq %d, got %d", want, ack.Seq)
		}
	}

	res := h.peer.expect(t, TagResponse)
	if !res.OK {
		t.Fatalf("the sink failed: %v", res.Error)
	}
	var out struct {
		Chunks int    `json:"chunks"`
		Text   string `json:"text"`
	}
	decodeResult(t, res, &out)
	if out.Chunks != StreamWindow || out.Text != strings.Repeat("x", StreamWindow) {
		t.Errorf("the handler saw %d chunks / %q", out.Chunks, out.Text)
	}
	if end := h.peer.expect(t, TagEnd); !end.OK {
		t.Errorf("end frame reported %v", end.Error)
	}
}

func TestInboundBase64ChunksAreDecodedForTheHandler(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	payload := []byte("binary\x00\xff payload")
	h.request("b64", "test.sink", map[string]any{}, 5*time.Second)
	h.peer.send(t, ChunkFrame{
		T:        TagChunk,
		ID:       "b64",
		Seq:      0,
		Data:     base64.StdEncoding.EncodeToString(payload),
		Encoding: EncodingBase64,
	})
	h.peer.send(t, EndFrame{T: TagEnd, ID: "b64", OK: true})

	res := h.peer.expect(t, TagResponse)
	if !res.OK {
		t.Fatalf("the sink failed: %v", res.Error)
	}
	var out struct {
		Chunks int    `json:"chunks"`
		B64    string `json:"b64"`
	}
	decodeResult(t, res, &out)
	if out.Chunks != 1 {
		t.Fatalf("the handler saw %d chunks", out.Chunks)
	}
	got, err := base64.StdEncoding.DecodeString(out.B64)
	if err != nil {
		t.Fatalf("the handler reported undecodable bytes: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("the handler received %q, want %q", got, payload)
	}
}

/* ----------------------------- chunk sizing -------------------------- */

func TestOversizedTextIsSplitOnRuneBoundaries(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	// Three-byte runes, and 3 does not divide MAX_CHUNK_BYTES: a naive
	// split lands one byte inside a rune.
	const runes = 100_000
	want := snowfield(runes)
	if len(want) <= MaxChunkBytes {
		t.Fatalf("the payload must exceed the chunk cap; it is %d bytes", len(want))
	}

	h.request("big", "test.text", map[string]any{"runes": runes}, 20*time.Second)
	chunks, res, end := drainStream(t, h.peer, "big")

	if len(chunks) < 2 {
		t.Fatalf("a %d-byte payload should have been split, got %d chunk(s)", len(want), len(chunks))
	}
	assertSeq(t, chunks, 0)

	var joined []byte
	for _, f := range chunks {
		payload := f.text(t)
		if len(payload) > MaxChunkBytes {
			t.Fatalf("chunk %d is %d bytes, over the %d cap", f.Seq, len(payload), MaxChunkBytes)
		}
		if !utf8.ValidString(payload) {
			t.Fatalf("chunk %d is not valid UTF-8", f.Seq)
		}
		// A split inside a rune survives the JSON encoder as U+FFFD, so
		// validity alone would not catch it. The source has none.
		if strings.ContainsRune(payload, utf8.RuneError) {
			t.Fatalf("chunk %d contains a replacement character — the split broke a rune", f.Seq)
		}
		joined = append(joined, payload...)
	}
	if !bytes.Equal(joined, want) {
		t.Fatalf("reassembled %d bytes, want %d, and they differ", len(joined), len(want))
	}
	if !res.OK || !end.OK {
		t.Fatalf("the stream should have finished cleanly: res=%v end=%v", res.Error, end.Error)
	}
}

func TestOversizedBinaryIsSplitInsideTheFrameCap(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	const size = 500_000
	want := blob(size)

	h.request("bin", "test.binary", map[string]any{"bytes": size}, 20*time.Second)
	chunks, res, end := drainStream(t, h.peer, "bin")

	if len(chunks) < 2 {
		t.Fatalf("a %d-byte payload should have been split, got %d chunk(s)", size, len(chunks))
	}
	assertSeq(t, chunks, 0)

	var joined []byte
	for _, f := range chunks {
		if f.Encoding != EncodingBase64 {
			t.Fatalf("chunk %d declared encoding %q", f.Seq, f.Encoding)
		}
		// The cap applies to what goes on the wire, so base64 growth has
		// to be accounted for before the split, not after.
		if n := len(f.text(t)); n > MaxChunkBytes {
			t.Fatalf("chunk %d encodes to %d bytes, over the %d cap", f.Seq, n, MaxChunkBytes)
		}
		joined = append(joined, f.bytes(t)...)
	}
	if !bytes.Equal(joined, want) {
		t.Fatalf("reassembled %d bytes, want %d, and they differ", len(joined), size)
	}
	if !res.OK || !end.OK {
		t.Fatalf("the stream should have finished cleanly: res=%v end=%v", res.Error, end.Error)
	}
}

/* ------------------------------ heartbeats --------------------------- */

func TestPingIsAnswered(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	h.peer.send(t, PingFrame{T: TagPing, Ts: 424242})
	pong := h.peer.expect(t, TagPong)

	// The timestamp round-trips so the control plane can measure RTT.
	var ts int64
	if err := json.Unmarshal(pong.Ts, &ts); err != nil {
		t.Fatalf("pong carried no numeric ts: %v", err)
	}
	if ts != 424242 {
		t.Errorf("pong echoed ts %d, want 424242", ts)
	}
}

func TestPongClearsTheMissCounter(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	h.conn.missedPongs.Store(PingTimeoutMultiplier - 1)
	h.peer.send(t, PongFrame{T: TagPong, Ts: 1})
	// Frames are routed in order on one goroutine, so the answer to this
	// ping proves the pong ahead of it has already been handled.
	h.peer.send(t, PingFrame{T: TagPing, Ts: 2})
	h.peer.expect(t, TagPong)

	if missed := h.conn.missedPongs.Load(); missed != 0 {
		t.Errorf("a pong left the miss counter at %d", missed)
	}
}

// The two tests below each cost one ping interval, which is the price of
// PingInterval being a protocol constant rather than a knob. They run in
// parallel with each other so the suite pays for one, not two, and they
// drive pingLoop directly rather than through Serve so the miss counter
// can be primed to the tick that matters.

func TestUnansweredPingsAccumulate(t *testing.T) {
	t.Parallel()
	h := dial(t, testRegistry(newProbes()))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go h.conn.writeLoop(ctx)
	go h.conn.pingLoop(ctx)

	// The agent heartbeats on its own schedule; the control plane here
	// deliberately never answers.
	ping := h.peer.await(t, PingInterval+5*time.Second)
	if ping.T != TagPing {
		t.Fatalf("expected a %q frame, got %q", TagPing, ping.T)
	}
	var ts int64
	if err := json.Unmarshal(ping.Ts, &ts); err != nil {
		t.Fatalf("ping carried no numeric ts: %v", err)
	}
	if drift := time.Since(time.UnixMilli(ts)); drift < 0 || drift > time.Minute {
		t.Errorf("ping timestamp is %v off", drift)
	}

	// The miss is counted before the ping goes out, so seeing the ping
	// means the count has already moved. Without this the connection
	// would never notice a peer that stopped answering.
	if missed := h.conn.missedPongs.Load(); missed != 1 {
		t.Errorf("one unanswered ping left the miss counter at %d, want 1", missed)
	}
}

func TestSilentControlPlaneIsDropped(t *testing.T) {
	t.Parallel()
	h := dial(t, testRegistry(newProbes()))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Primed to the multiplier, so the loop decides on its first tick
	// instead of its fourth.
	h.conn.missedPongs.Store(PingTimeoutMultiplier)
	go h.conn.writeLoop(ctx)
	go h.conn.pingLoop(ctx)

	select {
	case <-h.conn.closed:
	case <-time.After(PingInterval + 5*time.Second):
		t.Fatal("the connection survived PING_TIMEOUT_MULTIPLIER unanswered pings")
	}

	err, _ := h.conn.closeErr.Load().(error)
	if err == nil || !strings.Contains(err.Error(), "heartbeat") {
		t.Fatalf("expected a heartbeat failure, got %v", err)
	}
	// It gives up rather than sending yet another ping into the void.
	h.peer.quiet(t, quietWindow)
}

/* ----------------------------- socket loss --------------------------- */

func TestSocketLossCancelsEveryInFlightRequest(t *testing.T) {
	p := newProbes()
	h := connect(t, testRegistry(p))

	h.request("l1", "test.block", blockParams{Key: "one"}, 30*time.Second)
	h.request("l2", "test.block", blockParams{Key: "two"}, 30*time.Second)
	p.awaitStart(t, 2)

	// The control plane vanishes mid-call. Leaving the handlers running
	// would leak work whose result can never be delivered.
	_ = h.peer.ws.CloseNow()

	for i := 0; i < 2; i++ {
		if err := p.awaitCtxErr(t); !errors.Is(err, context.Canceled) {
			t.Fatalf("handler %d reported %v, want Canceled", i, err)
		}
	}
	if err := h.waitServe(); err == nil {
		t.Error("Serve returned nil after the socket died")
	}
}

/* -------------------------------- events ----------------------------- */

func TestEmitPushesAnEventFrame(t *testing.T) {
	h := connect(t, testRegistry(newProbes()))

	if err := h.conn.Emit(context.Background(), TopicMetrics, map[string]any{"cpu_pct": 12.5}); err != nil {
		t.Fatalf("emit: %v", err)
	}
	evt := h.peer.expect(t, TagEvent)

	if evt.Topic != TopicMetrics {
		t.Errorf("event carried topic %q", evt.Topic)
	}
	var ts string
	if err := json.Unmarshal(evt.Ts, &ts); err != nil {
		t.Fatalf("event ts is not a string: %v", err)
	}
	if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
		t.Errorf("event ts %q is not RFC 3339: %v", ts, err)
	}
	var payload struct {
		CPU float64 `json:"cpu_pct"`
	}
	if err := json.Unmarshal(evt.Data, &payload); err != nil {
		t.Fatalf("decode event data: %v", err)
	}
	if payload.CPU != 12.5 {
		t.Errorf("event data carried cpu_pct %v", payload.CPU)
	}
}

/* ------------------------------- helpers ----------------------------- */

// readChunks takes exactly n chunk frames off one stream, failing on
// anything else — a res arriving early is the failure mode this catches.
func readChunks(t *testing.T, p *peer, id string, n int) []wireFrame {
	t.Helper()
	out := make([]wireFrame, 0, n)
	for i := 0; i < n; i++ {
		f := p.expect(t, TagChunk)
		if f.ID != id {
			t.Fatalf("chunk %d belongs to stream %q, not %q", f.Seq, f.ID, id)
		}
		out = append(out, f)
	}
	return out
}

// drainStream collects the rest of a response stream: every chunk up to
// the res, plus the end frame that terminates it.
func drainStream(t *testing.T, p *peer, id string) (chunks []wireFrame, res, end wireFrame) {
	t.Helper()
	for {
		f := p.next(t)
		if f.ID != id {
			t.Fatalf("frame %q arrived on stream %q", f.T, f.ID)
		}
		switch f.T {
		case TagChunk:
			chunks = append(chunks, f)
		case TagResponse:
			return chunks, f, p.expect(t, TagEnd)
		default:
			t.Fatalf("unexpected %q frame inside a response stream", f.T)
		}
	}
}

// assertSeq pins chunk ordering: seq is monotonic and gapless from from.
func assertSeq(t *testing.T, chunks []wireFrame, from int) {
	t.Helper()
	for i, f := range chunks {
		if f.Seq != from+i {
			t.Fatalf("chunk %d has seq %d, want %d", i, f.Seq, from+i)
		}
	}
}
