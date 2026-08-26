# kaname-agent.v1 — wire protocol

The contract between the control plane and `kanamed`. The authoritative definition is
[`packages/contract/src/agent/`](../packages/contract/src/agent); this document explains the
shape and the reasoning so the code reads faster.

---

## 1. Connection

The agent **dials out**. It never calls `listen()`, so its internet-facing attack surface is
nothing at all.

```
kanamed ──▶ POST /agent/v1/enroll   (once, with a single-use token)
kanamed ──▶ POST /agent/v1/token    (signed challenge → 5-minute bearer)
kanamed ──▶ GET  /agent/v1/connect  (WebSocket upgrade, subprotocol kaname-agent.v1)
```

### Enrollment

1. The operator creates a Server in the panel; the control plane mints `kn_enroll_…` with a
   15-minute TTL bound to that server row.
2. `kanamed enroll` generates an **EC P-256 keypair on the host** and sends a CSR plus a host
   fingerprint. The private key never leaves the machine.
3. The control plane's internal CA signs a client certificate with `CN = <server id>`, 90-day
   validity, `ExtendedKeyUsage = clientAuth` only, `CA:false`. A stolen agent certificate
   therefore cannot be repurposed to serve TLS as the panel.
4. The agent stores `key.pem`, `cert.pem` and `ca.pem` in its state directory at mode `0600`.

### Per-connection authentication

Before each connect the agent proves possession of its private key:

```
signature = ECDSA-SHA256(privateKey, "<server_id>|<nonce>|<timestamp>")
POST /agent/v1/token  { server_id, nonce, timestamp, signature }
→ { token: "<server_id>.<expires_at>.<hmac>", expires_at }
```

The control plane verifies the signature against the public key in the certificate it issued,
rejects a clock more than 60 s out, and returns a 5-minute bearer. Where a peer certificate is
also available — direct TLS with `requestCert`, or a reverse proxy explicitly trusted to
forward it — the certificate CN is additionally pinned to the same server. See
[KD-014](../DECISIONS.md) for why the signed challenge is the primary mechanism.

Revocation is instant: the `servers` row is authoritative, so revoking drops the live socket
and refuses the next token without waiting for a CRL.

---

## 2. Frames

JSON text frames. The envelope is versioned, so the encoding can change later without touching
call sites.

| `t` | Direction | Meaning |
|---|---|---|
| `hlo` | agent → plane | Hello: protocol version, agent version, capabilities, host identity |
| `req` | plane → agent | Request: `{ id, method, params, deadline_ms, stream? }` |
| `res` | agent → plane | Terminal response: `{ id, ok, result }` or `{ id, ok:false, error }` |
| `chk` | both | Stream chunk: `{ id, seq, data, encoding }` |
| `ack` | both | Flow control: `{ id, seq }`, sent every `STREAM_WINDOW/2` chunks |
| `end` | both | Stream finished: `{ id, ok, error? }` |
| `can` | plane → agent | Cancel an in-flight request |
| `evt` | agent → plane | Unsolicited push: `{ topic, ts, data }` |
| `png` / `pog` | both | Heartbeat |

Constants live in `protocol.ts`: `STREAM_WINDOW = 32`, `MAX_CHUNK_BYTES = 256 KiB`,
`PING_INTERVAL_MS = 15000`, dead after `PING_TIMEOUT_MULTIPLIER = 3` missed pongs.

### Streams

Three shapes, declared per method:

- `none` — one `req`, one `res`.
- `response` — one `req`, then `chk` frames until `end`. Log tails, downloads, long-running
  package upgrades.
- `bidirectional` — `chk` frames flow both ways until either side sends `end`. Uploads, PTY,
  container exec.

Chunk streams are windowed. Without that, `journalctl -f` on a chatty host would OOM the
control plane; with it, the agent stops sending until an `ack` catches up.

### Deadlines and cancellation

`deadline_ms` is mandatory on every request. The control plane arms a timer, sends `can` when
it fires, and fails the owning job. A dropped socket cancels every in-flight call on that
connection immediately rather than leaving jobs hanging until their lease expires.

---

## 3. Methods

The registry in [`methods.ts`](../packages/contract/src/agent/methods.ts) **is** the agent's
attack surface. Every entry is an enumerated verb with a Zod-validated parameter schema.

There is no `exec(command: string)`. The only free-form execution paths are `pty.*` and
`container.exec`, which stream a real PTY and are separately permissioned, ticketed and
recorded ([KD-013](../DECISIONS.md)). When the agent shells out to a real binary internally it
uses an argv slice — never a string handed to `sh -c`.

Namespaces: `system`, `service`, `process`, `container`, `fs`, `site`, `cert`, `dns`, `mail`,
`db`, `fw`, `ssh`, `backup`, `log`, `pty`.

Each method declares:

- `params` / `result` — Zod schemas, validated on both ends.
- `stream` — `none` / `response` / `bidirectional`.
- `requires` — host capabilities. The hub fails the call with `unsupported` before it reaches
  the agent, so the UI can grey a feature out instead of showing an error.
- `readOnly` — whether it may be passed through synchronously from a request handler. Anything
  with a side effect must go through the job queue ([KD-008](../DECISIONS.md)).

### Path safety

Every path parameter is validated twice: by `absolutePath` in the contract before it leaves the
control plane, and again by the agent, which requires an absolute path, rejects any `..`
segment and any NUL byte, applies `filepath.Clean`, and refuses symlink escapes out of the
requested root. Archive extraction additionally guards against zip-slip.

---

## 4. Events

Unsolicited pushes from the agent. Anything not in this list is dropped rather than forwarded.

| Topic | Payload | What the control plane does with it |
|---|---|---|
| `metrics` | `MetricsSample` | Inserts a row, re-derives `servers.health` |
| `service.changed` | unit + state | Re-syncs the cached unit list, publishes SSE |
| `container.changed` | container id | Re-syncs the cached container list |
| `threat.detected` | `ThreatObservation` | Upserts `threat_events` |
| `ssh.session` | session info | SSE only |
| `cert.expiring` | subject + days | SSE, surfaces on the Command Center |
| `disk.pressure` | mount + percent | SSE |
| `log.anomaly` | source + excerpt | SSE |

---

## 5. Capabilities

`hlo.capabilities` is how a host says what it can actually do: `systemd`, `docker`, `podman`,
`nginx`, `mysql`, `postgres`, `mail`, `nftables`, `fail2ban`, `restic`, and so on. The Linux
provider probes for each at startup; the simulated provider reports a fixed plausible set plus
`simulated`, so the panel can label those servers unmistakably
([KD-010](../DECISIONS.md)).

The panel uses capabilities to decide what to show. A host without `mail` does not get an Email
section that fails when clicked — it does not get one at all.

---

## 6. Error codes

| Code | Meaning | Maps to |
|---|---|---|
| `unknown_method` | Not in the registry | `agent_error` 502 |
| `invalid_params` | Failed schema validation agent-side | `validation_failed` 422 |
| `unsupported` | Host lacks the capability | `agent_unsupported` 501 |
| `not_found` | Unit, container, path or record missing | `not_found` 404 |
| `permission_denied` | The OS refused | `forbidden` 403 |
| `conflict` | Already exists, or busy | `conflict` 409 |
| `precondition_failed` | State changed underneath | `precondition_failed` 412 |
| `timeout` | Exceeded `deadline_ms` | `agent_timeout` 504 |
| `cancelled` | `can` frame, or socket lost | job retries if idempotent |
| `io_error` / `exec_failed` / `internal` | Everything else | `agent_error` 502 |

Errors may carry `output` — a truncated stderr or journal excerpt — which is what lets the
panel show the actual nginx error rather than "reload failed".
