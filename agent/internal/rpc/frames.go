package rpc

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * kaname-agent/1 — wire frames.
 *
 * One agent-initiated WebSocket carries request/response, streaming
 * chunks in both directions, unsolicited events and heartbeats. These
 * structs mirror @kaname/contract/agent/protocol.ts frame for frame and
 * tag for tag; the envelope is versioned so the encoding can change
 * without touching call sites.
 * ------------------------------------------------------------------ */

const (
	ProtocolVersion = 1
	Subprotocol     = "kaname-agent.v1"

	// StreamWindow is the number of unacknowledged chunks a sender may
	// have in flight before it must pause. It is what stops a chatty
	// `journalctl -f` from OOMing the control plane.
	StreamWindow = 32

	MaxChunkBytes = 256 * 1024

	PingInterval          = 15 * time.Second
	PingTimeoutMultiplier = 3
)

// Frame tags.
const (
	TagHello    = "hlo"
	TagRequest  = "req"
	TagResponse = "res"
	TagChunk    = "chk"
	TagAck      = "ack"
	TagEnd      = "end"
	TagCancel   = "can"
	TagEvent    = "evt"
	TagPing     = "png"
	TagPong     = "pog"
)

// Encoding of a chunk frame's `data` field.
type Encoding string

const (
	EncodingUTF8   Encoding = "utf8"
	EncodingBase64 Encoding = "base64"
)

// Event topics an agent may push. Anything else is dropped by the hub.
const (
	TopicMetrics          = "metrics"
	TopicServiceChanged   = "service.changed"
	TopicContainerChanged = "container.changed"
	TopicThreatDetected   = "threat.detected"
	TopicSSHSession       = "ssh.session"
	TopicCertExpiring     = "cert.expiring"
	TopicDiskPressure     = "disk.pressure"
	TopicLogAnomaly       = "log.anomaly"
)

/* ------------------------------- errors ------------------------------ */

// ErrorCode is the machine-readable half of an agent error. The control
// plane maps these onto HTTP status codes and remediations, so a new
// code here needs one there too.
type ErrorCode string

const (
	CodeUnknownMethod      ErrorCode = "unknown_method"
	CodeInvalidParams      ErrorCode = "invalid_params"
	CodeUnsupported        ErrorCode = "unsupported"
	CodeNotFound           ErrorCode = "not_found"
	CodePermissionDenied   ErrorCode = "permission_denied"
	CodeConflict           ErrorCode = "conflict"
	CodePreconditionFailed ErrorCode = "precondition_failed"
	CodeTimeout            ErrorCode = "timeout"
	CodeCancelled          ErrorCode = "cancelled"
	CodeIOError            ErrorCode = "io_error"
	CodeExecFailed         ErrorCode = "exec_failed"
	CodeInternal           ErrorCode = "internal"
)

// maxErrorOutput matches the contract's cap on the stderr/journal
// excerpt an error may carry.
const maxErrorOutput = 16 * 1024

// Error is the `error` object of a res or end frame.
type Error struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
	Detail  any       `json:"detail,omitempty"`
	Output  string    `json:"output,omitempty"`
}

func (e *Error) Error() string {
	return string(e.Code) + ": " + e.Message
}

// Errorf builds a coded error for the wire.
func Errorf(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// WithOutput attaches a truncated command excerpt to an error.
func (e *Error) WithOutput(output string) *Error {
	if len(output) > maxErrorOutput {
		output = output[len(output)-maxErrorOutput:]
	}
	e.Output = output
	return e
}

/* ------------------------------- frames ------------------------------ */

// envelope peeks at a frame's tag before the full decode.
type envelope struct {
	T string `json:"t"`
}

type HelloFrame struct {
	T            string             `json:"t"`
	Proto        int                `json:"proto"`
	AgentVersion string             `json:"agent_version"`
	Capabilities []string           `json:"capabilities"`
	Host         providers.HostInfo `json:"host"`
}

type RequestFrame struct {
	T          string          `json:"t"`
	ID         string          `json:"id"`
	Method     string          `json:"method"`
	Params     json.RawMessage `json:"params,omitempty"`
	DeadlineMS int             `json:"deadline_ms"`
	Stream     bool            `json:"stream,omitempty"`
}

type ResponseFrame struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

type ChunkFrame struct {
	T        string   `json:"t"`
	ID       string   `json:"id"`
	Seq      int      `json:"seq"`
	Data     string   `json:"data"`
	Encoding Encoding `json:"encoding"`
}

type AckFrame struct {
	T   string `json:"t"`
	ID  string `json:"id"`
	Seq int    `json:"seq"`
}

type EndFrame struct {
	T     string `json:"t"`
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error *Error `json:"error,omitempty"`
}

type CancelFrame struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

type EventFrame struct {
	T     string `json:"t"`
	Topic string `json:"topic"`
	Ts    string `json:"ts"`
	Data  any    `json:"data"`
}

type PingFrame struct {
	T  string `json:"t"`
	Ts int64  `json:"ts"`
}

type PongFrame struct {
	T  string `json:"t"`
	Ts int64  `json:"ts"`
}
