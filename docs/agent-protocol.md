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

| `t`           | Direction     | Meaning                                                              |
| ------------- | ------------- | -------------------------------------------------------------------- |
| `hlo`         | agent → plane | Hello: protocol version, agent version, capabilities, host identity  |
| `req`         | plane → agent | Request: `{ id, method, params, deadline_ms, stream? }`              |
| `res`         | agent → plane | Terminal response: `{ id, ok, result }` or `{ id, ok:false, error }` |
| `chk`         | both          | Stream chunk: `{ id, seq, data, encoding }`                          |
| `ack`         | both          | Flow control: `{ id, seq }`, sent every `STREAM_WINDOW/2` chunks     |
| `end`         | both          | Stream finished: `{ id, ok, error? }`                                |
| `can`         | plane → agent | Cancel an in-flight request                                          |
| `evt`         | agent → plane | Unsolicited push: `{ topic, ts, data }`                              |
| `png` / `pog` | both          | Heartbeat                                                            |

Constants live in `protocol.ts`: `STREAM_WINDOW = 32`, `MAX_CHUNK_BYTES = 256 KiB`,
`PING_INTERVAL_MS = 15000`, dead after `PING_TIMEOUT_MULTIPLIER = 3` missed pongs.

### Streams

Three shapes, declared per method:

- `none` — one `req`, one `res`.
- `response` — one `req`, then `chk` frames until `end`. Log tails, downloads, long-running
  package upgrades.
- `bidirectional` — `chk` frames flow both ways until either side sends `end`. Uploads, PTY,
  container exec.

Chunk streams are windowed, and both ends enforce it. Without that, `journalctl -f` on a
chatty host would OOM the control plane; with it, the agent stops sending until an `ack`
catches up. The control plane holds the same line in both directions: it does not `ack` a chunk
until the browser (or file, or terminal socket) it is writing to has drained, and it does not
send an upload chunk while `STREAM_WINDOW` of them are unacknowledged or its own socket buffer
is full. So a slow reader on either side pauses the producer instead of growing a buffer.

### Deadlines and cancellation

`deadline_ms` is mandatory on every request and is clamped to `MAX_DEADLINE_MS` (six hours) on
both sides — a shell or a followed log that outlives it is closed with `timeout`, not silently
by one end. The control plane arms a timer, sends `can` when it fires, and fails the owning
job. `can` also settles the call locally, so an abandoned stream releases its buffers at once
rather than when the agent gets round to answering. A dropped socket cancels every in-flight
call on that connection immediately rather than leaving jobs hanging until their lease expires.

---

## 3. Methods

The registry in [`methods.ts`](../packages/contract/src/agent/methods.ts) **is** the agent's
attack surface. Every entry is an enumerated verb with a Zod-validated parameter schema.

There is no `exec(command: string)`. The only free-form execution paths are `pty.*` and
`container.exec`, which stream a real PTY and are separately permissioned, ticketed and
recorded ([KD-013](../DECISIONS.md)). When the agent shells out to a real binary internally it
uses an argv slice — never a string handed to `sh -c`.

Namespaces: `system`, `service`, `process`, `container`, `fs`, `site`, `cert`, `dns`, `mail`,
`db`, `fw`, `ssh`, `ftp`, `backup`, `log`, `pty`.

The managed-container verbs (`container.image.pull`, `container.network.create`,
`container.create`, `container.task.run`, `container.app.status`, `container.app.remove`) are
how the app installer runs image recipes ([KD-040](../DECISIONS.md)). `container.create` takes a
closed spec (unknown fields are a decode error) and the agent builds the Engine API body itself:
no privileged mode, no added capabilities, no host network/PID/IPC, no devices, `no-new-privileges`,
restart `unless-stopped`, ports bound to `127.0.0.1` only, bind sources only under
`/var/lib/kaname-apps/<install_id>/` (checked lexically and after resolving symlinks), images with
an explicit tag or digest, and Kaname labels plus an install-derived name on everything created.
`container.app.remove` acts only on resources carrying this install's labels.

The `ftp` namespace manages transfer accounts as real POSIX users (`ftp.account.create`,
`.update`, `.passwd`, `.delete`). Each requires `sftp` (sshd is installed) or `vsftpd`, and the
agent then insists on the one the account's protocol needs. The password reaches `chpasswd` on
stdin, never an argv, and no result echoes it; the job carries only a `secrets` ref, which the
control plane unseals at call time and deletes once the host has the credential. A user the
agent did not create (its GECOS lacks the Kaname marker, or its uid is 0) is refused with
`conflict` rather than re-passworded or removed.

The `backup` namespace drives restic (`backup.run`, `.list`, `.restore`, `.verify`, `.prune`).
Those verbs name the repository password only by reference (`password_ref`): a bare name
(`[A-Za-z0-9._-]`, at most 128, starting with a letter or digit, no `..`, not ending in `.env`)
that resolves to `<state_dir>/backup-secrets/<ref>`, with the destination's credentials beside it
in `<ref>.env`. The control plane, which keeps them envelope-encrypted at rest, provisions them
once per job, right before the restic verbs, with the write-only `backup.secret_put`
(`ref`, `password`, and `env` limited to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_DEFAULT_REGION`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` and `KANAME_S3_BUCKET_LOOKUP` =
`auto|dns|path`; any other key is a decode error). The agent writes both files 0600 in a 0700
directory through an `O_NOFOLLOW` directory descriptor, each via a fresh temporary renamed over
the target, so a planted symlink is replaced rather than followed; an empty `env` removes
`<ref>.env`. Nothing returns the values, no error quotes them, and restic reads them from
`RESTIC_PASSWORD_FILE` and its environment, never an argv. `backup.secret_delete` removes both
files (a missing one is not an error). When reading, the agent refuses a secret file that is a
symlink and passes only the closed set of `.env` keys to restic. The files stay on the host on
purpose: a host whose control plane is gone can still be restored by hand. The simulator applies
the same validation and refuses the restic verbs for a reference that was never provisioned.

The `mail` namespace is Yunori Mail Server ([KD-034](../DECISIONS.md#kd-034)): every verb is one
`yunori-mail` CLI invocation on the host (`mail.status`, `mail.preflight`, `mail.doctor`,
`mail.deploy`, `mail.update`, `mail.domain.*`, `mail.mailbox.*`, `mail.alias.*`,
`mail.certificate.*`, `mail.logs`). `mail.deploy` is gated on `systemd` because it is what
installs the binary; everything else requires the `yunori` capability, which the agent advertises
when `/usr/local/bin/yunori-mail` exists. `mail.mailbox.add` and `mail.mailbox.passwd` return a
generated password once; the control plane never persists it ([KD-035](../DECISIONS.md#kd-035)).

Deployments use `site.release.create`, which writes `<root>/releases/<release>` (a `git` clone
with `.git` removed, or a copy of the staged upload) and swaps `<root>/current` onto it with one
rename, and `site.release.activate`, which swaps `current` onto a release already on disk. The
agent refuses a release path outside `<root>/releases/`, a repository or branch git would read as
an option, and a real directory at `current`. `cert.install` takes the private key in its params;
the control plane carries it to the job sealed and the job's stored params are redacted once it
ends. `dns.publish` requires `simulated`: it hands a simulated host's resolver the zone Kaname
manages, which stands in for public DNS there, and no real host advertises it.

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
segment and any NUL byte, cleans it with POSIX rules, and refuses symlink escapes out of the
requested root. Archive extraction additionally guards against zip-slip.

---

## 4. Events

Unsolicited pushes from the agent. Anything not in this list is dropped rather than forwarded.

| Topic               | Payload             | What the control plane does with it          |
| ------------------- | ------------------- | -------------------------------------------- |
| `metrics`           | `MetricsSample`     | Inserts a row, re-derives `servers.health`   |
| `service.changed`   | unit + state        | Re-syncs the cached unit list, publishes SSE |
| `container.changed` | container id        | Re-syncs the cached container list           |
| `threat.detected`   | `ThreatObservation` | Upserts `threat_events`                      |
| `ssh.session`       | session info        | SSE only                                     |
| `cert.expiring`     | subject + days      | SSE, surfaces on the Command Center          |
| `disk.pressure`     | mount + percent     | SSE                                          |
| `log.anomaly`       | source + excerpt    | SSE                                          |

---

## 5. Capabilities

`hlo.capabilities` is how a host says what it can actually do: `systemd`, `docker`, `podman`,
`nginx`, `mysql`, `postgres`, `yunori`, `nftables`, `fail2ban`, `restic`, `sftp`, `vsftpd`,
and so on. The Linux
provider probes for each at startup; the simulated provider reports a fixed plausible set plus
`simulated`, so the panel can label those servers unmistakably
([KD-010](../DECISIONS.md)).

The panel uses capabilities to decide what to show. A host without `yunori` is offered **Deploy
Yunori Mail Server**, not an Email section that fails when clicked.

---

## 6. Error codes

| Code                                    | Meaning                                 | Maps to                   |
| --------------------------------------- | --------------------------------------- | ------------------------- |
| `unknown_method`                        | Not in the registry                     | `agent_error` 502         |
| `invalid_params`                        | Failed schema validation agent-side     | `validation_failed` 422   |
| `unsupported`                           | Host lacks the capability               | `agent_unsupported` 501   |
| `not_found`                             | Unit, container, path or record missing | `not_found` 404           |
| `permission_denied`                     | The OS refused                          | `forbidden` 403           |
| `conflict`                              | Already exists, or busy                 | `conflict` 409            |
| `precondition_failed`                   | State changed underneath                | `precondition_failed` 412 |
| `timeout`                               | Exceeded `deadline_ms`                  | `agent_timeout` 504       |
| `cancelled`                             | `can` frame, or socket lost             | job retries if idempotent |
| `io_error` / `exec_failed` / `internal` | Everything else                         | `agent_error` 502         |

Errors may carry `output` — a truncated stderr or journal excerpt — which is what lets the
panel show the actual nginx error rather than "reload failed".
