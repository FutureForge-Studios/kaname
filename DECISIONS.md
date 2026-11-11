# Kaname — Decision Log

Running record of judgment calls, newest sections appended at the bottom. Each entry states the
decision, the alternatives that were seriously considered, and why the alternative lost — so a
future reader can tell whether the reasoning still holds.

Format: `KD-nnn` (Kaname Decision).

---

## KD-001 — Agent is a Go binary, not Rust, not Node

**Decision.** `kanamed` is a single statically-linked Go binary.

**Alternatives.** Rust (equally valid on the dossier's terms); Node with `pkg`/SEA; a Python
daemon; plain SSH from the control plane with no agent at all.

**Why Go.**

- The agent's job is 90% syscalls, process supervision, socket plumbing and JSON. Go's stdlib
  covers nearly all of it; Rust's advantage (fearless concurrency, zero-cost abstractions) buys
  little here while costing real velocity on an already very large surface.
- `CGO_ENABLED=0 go build` produces a ~12 MB binary that runs on any glibc/musl Linux with no
  runtime, no package manager involvement, and no version skew with the host's Python/Node.
- First-class libraries for exactly our needs: `github.com/coreos/go-systemd/v22/dbus`,
  `github.com/docker/docker/client`, `github.com/prometheus/procfs`, `github.com/creack/pty`.
- Cross-compiles from the Windows dev machine to `linux/amd64` and `linux/arm64` with two env
  vars, which matters because the primary dev box here is Windows.
- Go's `net/http` + `crypto/tls` give us mTLS client certs without a third-party stack.

**Why not "just SSH".** SSH from the request path is exactly the architecture the dossier
forbids, and it is the shape that produced the competitors' CVEs: it turns every panel feature
into shell-string construction. A typed RPC surface makes command injection structurally
impossible rather than a code-review responsibility.

---

## KD-002 — Agent dials out over WSS + mTLS; WireGuard is optional, not required

**Decision.** The agent opens an outbound `wss://` connection to the control plane, authenticated
with a client certificate signed by Kaname's internal CA, and carries all RPC over it.

**Alternatives.** WireGuard mesh + gRPC (Coolify's shape); control plane dials the agent over
mTLS HTTPS; NATS or MQTT broker in between.

**Why.**

- Agent-dialed means `kanamed` never binds a port. Its internet-facing attack surface is zero.
  Every "panel got popped" story starts with something listening.
- NAT/CGNAT/security-group traversal is free. A mesh requires per-node endpoint config and
  keepalives; behind a residential or restrictive-egress-only network it needs more work still.
- One socket carries request/response _and_ streams (log tails, PTY, metric push, container
  logs). gRPC would give the same, but adds protoc codegen to the toolchain for both TS and Go
  when our payload shapes already live in Zod. WebSocket + a small versioned frame envelope is
  ~300 LOC per side and is trivially debuggable.
- A broker (NATS) is a third daemon to self-host, for a fleet measured in single digits.

**Cost accepted.** We hand-roll multiplexing, backpressure and cancellation instead of getting
them from HTTP/2. Mitigated by keeping the framing tiny, windowed, and conformance-tested from
both ends.

---

## KD-003 — Postgres-backed job queue instead of Redis/BullMQ

**Decision.** Jobs live in a `jobs` table; workers claim with `FOR UPDATE SKIP LOCKED` and hold
a renewable lease.

**Alternatives.** BullMQ on Redis; Temporal; in-memory queue.

**Why.** The realistic throughput of a server panel is tens of jobs per minute, not thousands
per second — well inside what Postgres handles comfortably. In exchange we get: one fewer
daemon for a self-hoster to run and back up, jobs in the same transaction as the state change
that created them (no "row written, enqueue failed" split brain), and job history queryable
with the same SQL as everything else in the panel. Redis would be the right answer at 100x the
load; we will know well before we get there.

---

## KD-004 — PGlite for development, real Postgres for production

**Decision.** `DATABASE_URL=pglite://./.data/kaname` in dev; `postgres://...` in prod. Same
Drizzle schema, same migrations, same SQL.

**Alternatives.** Require Docker + Postgres for dev; use SQLite in dev and Postgres in prod;
require a hosted dev database.

**Why.** The dev machine for this project is Windows with no Docker. PGlite is real Postgres
compiled to WASM, so dialect-specific things we rely on (`uuid`, `jsonb`, arrays, partial
indexes, `SKIP LOCKED`, `gen_random_uuid()`) behave identically — unlike SQLite, which would
have forced a lowest-common-denominator schema and hidden a class of bugs until deploy.
`pnpm dev` therefore needs nothing installed but Node.

**Cost accepted.** PGlite is single-connection, so the dev worker and API share one client.
That is fine at dev concurrency and is explicitly not the production path.

---

## KD-005 — Accent colour: Keystone Indigo `#5B76F7`

**Decision.** One accent, `#5B76F7` at 500, with a 300–700 ramp.

**Constraint from the dossier.** Near-black monochrome, one sparing accent, avoid violet/purple
(default "AI dashboard" colour, and used by several competitors), indigo/blue-violet acceptable.

**Why this hex.**

- Hue lands near 245 degrees: measurably cooler and less saturated than Linear's violet, and
  distinctly deeper than Vercel/GitHub azure — so it does not read as either a clone or a
  generic AI product.
- It stays out of the way of the semantic triad. In an infrastructure panel green/amber/red
  carry meaning constantly; an accent anywhere near those hues creates ambiguity about whether
  a coloured element is _branding_ or _status_. Blue-indigo is the only large hue region left
  that reads as "interactive" without reading as "state".
- Contrast, measured against `--kn-bg #0B0C0E`:
  - `#8AA0FF` (400) on bg = ~7.6:1 — used for links, active icons, inline emphasis (AAA-ish).
  - `#5B76F7` (500) on bg = ~4.6:1 — used for focus rings and 1px borders, never body text.
  - White on `#4A63E0` (600) = ~5.6:1 — primary button fill, passes AA comfortably.
    So the ramp is not decorative: each stop exists because a specific pairing needed to pass.

**Rejected.** Teal/jade (collides with "healthy"), amber/brass (collides with "warning"),
pure cyan (reads crypto-dashboard), any violet above ~265 degrees (explicitly excluded).

---

## KD-006 — Hand-built SVG charts instead of a charting library

**Decision.** `Sparkline`, `AreaChart`, `BarChart` and `MetricTile` are ~400 LOC of SVG in
`@kaname/ui`.

**Alternatives.** Recharts, Chart.js, visx, uPlot.

**Why.** Every charting library ships opinions about padding, tick density, tooltip chrome,
animation and legend placement, and the work of overriding them to hit a strict 4px grid,
tabular-numeral typography and 120–200 ms motion is comparable to writing the four chart types
we actually need. Our chart requirements are narrow (time-series line/area, categorical bars,
a sparkline) and we control the data shape end to end. uPlot was the closest call — it is fast
and small — but it draws to canvas, which costs us CSS-token theming and accessible markup.

**Revisit if.** We need brushing/zooming on 100k-point series, at which point uPlot returns.

---

## KD-007 — Zod contract package as the single source of truth, JSON Schema generated for Go

**Decision.** `@kaname/contract` holds Zod schemas for every REST payload and every agent RPC
method. The control plane validates with them at the edge; the UI infers types from them; a
build step emits JSON Schema which generates Go structs for the agent.

**Alternatives.** OpenAPI-first with codegen for TS+Go; Protobuf/gRPC; hand-written types on
both sides.

**Why.** TypeScript is where two of the three tiers live, so making TS the authoring language
avoids a codegen round-trip for the majority of the work while still giving the Go tier a
machine-checked contract. Drift between the agent and the control plane becomes a compile error
rather than a runtime `undefined`. Protobuf would be the stronger contract but drags protoc,
a plugin chain and `.proto` as a third source language into a codebase whose payloads are
already fully described in Zod for validation purposes anyway.

---

## KD-008 — Every host-touching mutation is a Job; no synchronous pass-through

**Decision.** No API route performs an agent RPC inline and returns its result. Routes enqueue
a job and return `202 { job }`. Read-only RPCs (list containers, stat a file, tail a log) may
pass through synchronously with a short deadline, because they have no side effect to lose.

**Why.** The dossier makes this a constraint, and it is right for a reason worth writing down:
the work happens on a machine that may be slow, rebooting, or gone. A synchronous design forces
every one of those states into an HTTP timeout, which is the single worst way to learn that a
`systemctl restart` may or may not have happened. With jobs, "we do not know yet" is a
first-class, resumable state that survives a control-plane restart.

**Consequence for UI.** Mutations render a `JobStatusPill`, not a toast. This is a component
contract, not a per-page choice.

---

## KD-009 — Audit log is hash-chained and insert-only

**Decision.** `audit_events` rows carry `prev_hash` and `hash`; the table is protected against
`UPDATE`/`DELETE` at the database-role level; a `verify` command walks the chain.

**Alternatives.** Plain append table; ship everything to an external SIEM.

**Why.** An audit log an attacker can edit after gaining panel access is decoration. The chain
costs one SHA-256 per write and makes selective deletion detectable. It also gives the Security

> Audit page something honest to display ("chain verified through 41,208 events, last checked
> 2 minutes ago") instead of an unfalsifiable list. External SIEM export remains available and is
> complementary, not a substitute.

---

## KD-010 — The agent ships a first-class simulation provider

**Decision.** `kanamed` has a `providers` interface with two implementations: `linux` (real
systemd/Docker/procfs/filesystem) and `sim` (a deterministic, stateful fake host). Selected by
`--simulate`, never auto-detected.

**Alternatives.** Mock at the control-plane boundary; require a real Linux VM for all
development; record/replay fixtures.

**Why.** Mocking at the control-plane boundary would leave the entire agent, the RPC framing,
the job lifecycle and the reconnect logic untested in the normal dev loop — which is precisely
where the hard bugs live. Making the _provider_ the seam means dev and CI exercise the real
protocol, the real hub, the real job worker and the real UI, with only the syscalls faked. It
also makes the product demoable and e2e-testable on Windows, which is where this is being
built.

**Guard.** `--simulate` refuses to run if `KANAME_ENV=production`, and the panel labels
simulated servers unmistakably. A fake fleet that can be mistaken for a real one is worse than
no fake fleet.

---

## KD-011 — Next.js and the control plane are separate processes, one origin

**Decision.** `apps/web` (Next.js) and `apps/control-plane` (Fastify) are separate deployables.
In dev, Next rewrites `/api/*` and `/agent/*` to the control plane; in prod a reverse proxy does
the same. The browser therefore sees one origin and a plain session cookie works.

**Alternatives.** Put the API in Next route handlers; a BFF layer in Next that re-proxies with
its own tokens.

**Why.** The control plane must hold long-lived agent WebSockets and run a job worker on a
schedule. Next.js route handlers are request-scoped and are the wrong host for either. Keeping
them separate also means the API is genuinely usable headlessly (API keys, MCP later) rather
than being an accident of the UI. A BFF was rejected as duplicated surface with no security
gain once both sides are same-origin.

---

## KD-012 — Read-heavy state is cached in the control plane, not fetched live per page view

**Decision.** `services`, `containers`, `processes` (sampled), storage usage, DNS records and
mail auth results are persisted in the control plane and refreshed by agent-pushed events plus a
periodic reconcile. List pages read the cache; a visible "synced 12s ago / Refresh" control
forces a live pull.

**Why.** A fleet page that fans out live RPCs to every host is fast with three servers and
unusable with thirty, and it makes "one host is down" degrade the entire page instead of one
row. Caching also gives us history (when did this container's state change), which live fetching
cannot. The staleness is made visible rather than hidden, which is the honest version of this
trade.

---

## KD-013 — Terminal sessions are ticketed, permission-gated and recorded

**Decision.** `POST /terminal/sessions` checks `terminal.session:exec` for the target server and
returns a single-use, 30-second, IP-bound ticket. The WebSocket upgrade accepts only that
ticket. Every session writes an audit event on open and close, and the full I/O stream is
recorded to `job_logs`-style storage with a retention setting. A container's Exec tab is the same
path: the request names a `container_id`, the socket opens `container.exec` instead of
`pty.open`, and the ticket additionally needs `infra.containers:exec` on that host.

**Why.** The terminal is the one place where the "no shell strings" rule cannot hold, so it gets
compensating controls instead: it is explicitly a separate permission (a Developer role can
manage sites without ever getting a root shell), it cannot be reached by URL guessing, and what
happens in it is not invisible. Recording is on by default and can be disabled per install, but
disabling it is itself an audited settings change.

---

## KD-014 — Agent authentication is proof-of-possession first, mTLS second

**Decision.** The agent authenticates by signing a challenge (`server_id|nonce|timestamp`) with
the private key it generated locally at enrollment. The control plane verifies that signature
against the public key in the certificate it issued, then returns a 5-minute bearer token used
for the WebSocket upgrade. When a peer certificate _is_ available — direct TLS with
`requestCert`, or a reverse proxy explicitly trusted to forward it — the certificate's CN is
additionally pinned to the same server.

**Alternatives.** Require true mTLS on every hop; issue a long-lived shared secret at
enrollment and HMAC with it.

**Why.** PLAN.md commits to mutual TLS, and this keeps its security properties — the private
key never leaves the host, and possession of it is proved on every connection — while surviving
the deployment reality that most self-hosters terminate TLS at Caddy or nginx and cannot easily
pass client certificates through. Requiring end-to-end mTLS would either force Kaname to
terminate TLS itself or produce an install that silently degrades. A long-lived shared secret
was rejected because it is transmitted on every use, where a signature is not.

**What this does not change.** The agent still binds no port, the certificate is still issued
per server with `CN = server_id`, and revoking a server still drops the socket immediately —
revocation is checked against the `servers` table, which is instant, rather than against a CRL.

---

## KD-015 — A minimal purpose-built CA, not a general PKI

**Decision.** `AgentCa` signs exactly one kind of certificate: a client-auth-only leaf with
`CN = <server id>`, 90-day validity, from a self-signed root stored envelope-encrypted in
`secrets`. It uses `@peculiar/x509` over Node's WebCrypto.

**Why.** Node's `crypto` can parse X.509 but not issue it, so something had to fill the gap.
`@peculiar/x509` is the smallest credible option that does not drag in a full PKI framework.
The CA is deliberately incapable of issuing a server certificate or an intermediate: the
`ExtendedKeyUsage` is `clientAuth` and `BasicConstraints` is `CA:false` on every leaf, so a
stolen agent certificate cannot be repurposed to impersonate the panel.

---

## KD-016 — Extensionless relative imports inside `@kaname/db`, bundled build for the control plane

**Decision.** Schema files in `packages/db/src/schema` import each other without the `.js`
extension. The control plane is bundled for production rather than emitted file-by-file.

**Why.** `drizzle-kit` loads the schema through a CJS-flavoured transpiler that cannot resolve
`./common.js` to `./common.ts`, so migration generation fails against ESM-correct source. The
choice was between dropping the extension in one package or introducing a compile step before
every migration. Since every consumer of that source — tsx in development, Next's bundler, and
the production bundle — resolves extensionless TypeScript correctly, the extension buys nothing
here and costs the migration workflow.

**Boundary.** This applies only to `packages/db/src/schema`. `@kaname/contract` keeps explicit
`.js` extensions throughout, because nothing feeds it to drizzle-kit and it is the package most
likely to be consumed from outside this repo one day.

---

## KD-017 — PGlite needed one accommodation, and it is worth knowing about

**Decision.** `createDb` creates the data directory recursively before handing the path to
PGlite.

**Why.** PGlite's Node filesystem shim calls `mkdirSync` without `recursive`, so a nested
default like `.data/kaname` fails on a fresh clone. Recording it because it is exactly the kind
of thing that looks like "PGlite is broken on Windows" the second time someone hits it.

---

## KD-018 — The method registry is contract-checked at build time, but structs are not generated

**Decision.** `packages/contract` emits `agent/methods.json`; the agent embeds it and a test
asserts the live registry matches — same method names, same stream modes, same capability
requirements, same protocol constants. Payload structs stay hand-written (Go then, Rust now:
KD-033).

**Why not full codegen.** KD-007 anticipated generating Go structs from JSON Schema. Having
built both sides, the payoff was not there: the payload structs are stable and read better
hand-written, while the _method list_ is the thing that actually drifts — one side renames a
verb and the failure surfaces as `unknown_method` at 3 a.m. rather than at compile time.
Embedding the manifest catches exactly that class, for about a hundred lines, with no codegen
step in the loop.

**What the test also pins.** That the agent registers nothing the contract does not declare —
an unlisted verb is an unreviewed hole in the attack surface — and that no free-form execution
verb exists outside the audited `pty.*` / `container.exec` paths. The security thesis is
therefore an assertion, not a claim in a document.

---

## KD-019 — `m()` in the method registry is generic, and that is load-bearing

**Decision.** The registry's helper is
`m<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(spec) => { params: P; result: R; ... }`,
not `m(spec: MethodSpec) => MethodSpec`.

**Why it is recorded.** The non-generic form is the obvious one to write and it type-checks
fine. It also widens every `params`/`result` to `ZodTypeAny`, which makes `MethodResult<M>`
resolve to `any` — so every `hub.call(...)` in the control plane silently loses its type, and
several route modules were quietly compiling against `any` before this was caught. Fixing the
helper turned up nothing but green, which is the point: the safety was never real until the
helper preserved the literal types.

---

## KD-020 — The agent subprotocol is `kaname-agent.v1`, not `kaname-agent/1`

**Decision.** The WebSocket subprotocol token contains no slash.

**Why it is recorded.** `kaname-agent/1` reads naturally and is what the first draft used. It is
also illegal: a subprotocol name is an RFC 7230 token, and `/` is a separator. `ws` rejects the
handshake with a bare `400 Invalid Sec-WebSocket-Protocol header` before any route or log line
sees it, so the symptom is an agent that enrolls perfectly and then cannot connect, with nothing
useful on the server side. The version now rides as `.v1`.

The server also selects the subprotocol explicitly via `handleProtocols` rather than leaving
`ws` to ignore the client's offer, because a client that offers one expects one back.

---

## KD-021 — Raw-SQL rows are mapped, never cast

**Decision.** `JobQueue.claim()` runs raw SQL (it needs `FOR UPDATE SKIP LOCKED`) and passes the
result through an explicit `toClaimedJob()` mapper instead of casting it to Drizzle's row type.

**Why.** The cast type-checks and is wrong: raw SQL returns the database's snake_case columns,
so every camelCase field on the "typed" row reads as `undefined`. The failure surfaced as job
handlers rejecting work with "requires a server" while looking at a row that plainly had a
`server_id` — the kind of bug that survives a green test suite, because the unit tests only
touched fields whose names happen to be identical in both conventions.

The regression test now asserts `serverId`, `params`, `maxAttempts` and the date fields on a
claimed row specifically, so a future raw query cannot reintroduce it quietly.

---

## KD-022 — The simulated host's identity comes from its state directory

**Decision.** `sim.New` seeds from the base name of the agent's state directory, falling back to
the machine hostname.

**Why.** Seeding from the hostname is the obvious choice and produces four byte-identical fake
servers when the development fleet runs four agents on one machine — which makes the demo
actively misleading about what the panel can show. The state directory is unique per agent and
stable across restarts, so each simulated host is distinct _and_ still deterministic.

---

## KD-023 — The terminal socket dials the control plane directly in development

**Decision.** `POST /terminal/sessions` builds its `ws_url` from a new `clientApiUrl`: the
panel's own origin in production, `http://localhost:$PORT` in development.

**Why.** KD-011 says the browser sees one origin because Next rewrites `/api/*` to the control
plane. That is true for HTTP and **not** for WebSockets — Next's `rewrites` do not forward
upgrade requests. The terminal is the one browser-facing WebSocket in the product, so it was
the one thing the single-origin story could not deliver, and it failed with a bare "the
connection failed". In production the reverse proxy fronts both and does forward upgrades, so
the one-origin story holds there unchanged; `KANAME_CLIENT_API_URL` exists for deployments
where it does not.

---

## KD-024 — The terminal pane mints its own ticket, per socket

**Decision.** `TerminalPane` takes `connect: (signal) => Promise<{ ws_url }>` rather than a
pre-minted URL, and the page keys it on a generation counter rather than on a ticket.

**Why.** A ticket is spent on redemption (KD-013), which is correct. Handing the pane a URL
therefore broke on every remount — React's development double-invoke, Fast Refresh, any parent
re-key — because the second socket tried to spend a ticket the first had already used. Minting
per socket makes the pane correct under remount and makes reconnect a one-line generation bump
instead of a manual teardown.

The first attempt at this keyed the pane on the ticket the pane itself replaced, so minting
remounted the pane, which minted again: 523 sessions in a minute. The key has to be something
the pane cannot change.

---

## KD-025 — Nothing in the terminal's correctness may depend on a frame

**Decision.** The pane defers opening xterm until the host has a real box and the monospace
face has loaded, buffers output until then, and **flushes synchronously** rather than inside
`requestAnimationFrame`.

**Why.** Three separate failures, all of which presented identically as a blank shell:

- `.xterm` collapsed to zero height. xterm positions its viewport and screen absolutely, so the
  element it mounts into has no height of its own — it measured 930×0 while the rows underneath
  were correctly sized at 936×552. It needs `h-full`.
- Opening before layout or before the font loads leaves the render service without dimensions,
  and every subsequent write throws from inside an animation frame where nothing can catch it.
- The flush was scheduled on `requestAnimationFrame`, which does not run in a hidden or
  non-compositing tab. A terminal opened in a background tab buffered its banner forever and
  only appeared when the operator typed.

The last one is the general lesson: xterm's _rendering_ is legitimately frame-driven, but the
pane's own bookkeeping must not be, or the shell is blank exactly when nobody is looking at it.

---

## KD-026 — Pairing is the enrollment token we already have, not a WireGuard mesh

**Decision.** The installer's "pair this box to the control plane" step and the panel's
"add a server" one-liner both use Kaname's existing enrollment tokens: single-use, 15-minute
TTL, redeemed by an agent that generates its own key and receives a CA-signed certificate.
No WireGuard keypair is generated anywhere.

**Why it is recorded.** The installer spec assumes a WireGuard mesh, because the closest prior
art works that way. Kaname does not: KD-002 chose agent-dialed WSS with a signed challenge
precisely so there is nothing to configure per node and nothing listening on a managed host.
The spec's actual _requirements_ for pairing — short-lived, single-use, scoped to one server
registration, revocable — are already exactly what `enrollment_tokens` provides, so adopting
WireGuard would add a second trust system to satisfy a requirement the first one already meets.

The all-in-one install therefore pairs over plain loopback to `127.0.0.1:4000` rather than over
a local WireGuard interface, and `--agent-only` pairs over whatever address the operator passes.

---

## KD-027 — Packaging is Docker Compose for the control plane, a bare binary for the agent

**Decision.** `install.sh` deploys the control plane, web panel, Postgres and Caddy as a Compose
project under a single data root, and installs the agent as a static binary under systemd.

**Alternatives.** A single all-in-one container; Kubernetes manifests; distro packages.

**Why.** The control plane is four cooperating services with a database and a TLS terminator —
Compose is the least machinery that expresses that, it is what a self-hoster already has if they
have Docker at all, and it makes the upgrade story a tag swap rather than a package upgrade. The
agent is deliberately _not_ containerised: its whole job is to manage the host it runs on
(systemd, the container socket, the filesystem), so putting it in a container would mean handing
that container the very privileges the architecture exists to avoid concentrating.

That asymmetry is the point: the control plane is an app that happens to run on a server, and
the agent is part of the server.

---

## KD-028 — The release manifest is published data, and config is merged from a declared list

**Decision.** A `versions.json` manifest is published with each release. It carries, per version:
the channel, whether the release is `breaking`, whether its migrations are `destructive`, a
`min_upgrade_from` floor, artifact references with sha256 for agent binaries, and an explicit
`migrations.adds_config` list of new configuration keys.

**Why a manifest rather than registry tags.** Tags tell you a version exists. They cannot tell
you whether applying it unattended is safe, and that is the only question that matters at the
moment an automatic updater is deciding. `breaking` and `migrations.destructive` are what make
[KD-029](#kd-029)'s hard rule enforceable rather than aspirational.

**Why a declared key list rather than a diff.** On upgrade, the existing `.env` wins and only the
keys named in `adds_config` are added, generating fresh secrets where required. A heuristic diff
against a template would silently reintroduce a key an operator had deliberately removed, or
overwrite one they had deliberately changed. Upgrade must not be a reinstall that eats your
configuration.

---

## KD-029 — Rollback is image-and-config for the control plane, reinstall for an agent

**Decision.** Before a control-plane update, the current `.env` — which pins the image tags — is
copied to a per-run directory under the data root. If the new build fails to answer its health
check, the snapshot is restored and the stack restarted. If a migration ran, rollback stops and
the run is marked `needs_attention` with the migration named, rather than silently restoring a
schema the old binary cannot read.

"Did a migration run" is not guessed: the number of applied rows in Drizzle's own migrations
table is recorded before the handover and compared afterwards. It is the only signal that
survives the process being replaced.

Agents have no durable state beyond their pairing keys, so an agent rollback is simply
reinstalling the previous binary and restarting the unit.

**Why the asymmetry.** A forward-only migration is not reversible by copying files back. The
honest options are "restore from backup" or "tell a human precisely what happened" — and a
silent half-migrated instance is worse than either, so the system refuses to produce one. That
is also why a destructive migration forces confirmation regardless of the update tier: an
operator who cannot roll back must at least have chosen to go forward.

**Hard rule, restated because it is the one that matters.** A release marked `breaking`, or
whose migrations are marked `destructive`, always requires explicit confirmation before it is
applied to the control plane — under every tier, including `auto_all`. `mayApplyUnattended()` in
`@kaname/contract` is the single function that decides this, and it answers `false` for those
releases before it looks at the tier at all.

---

## KD-030 — The control plane does not restart itself; a host unit does it

**Decision.** The control plane performs every reversible part of its own update — precondition
checks, the `.env` snapshot, the declared-key config merge, pinning the new image tags, recording
the migration count — and then writes a request file into `<data-root>/updates/queue/`. A systemd
path unit installed by `install.sh` picks that up and runs `kaname-update.sh` on the host: pull,
restart, health-check, roll back on failure. Whichever build boots next reads the pending record
and the updater's log and finalises the run as `succeeded`, `rolled_back` or `needs_attention`.

**Alternatives considered.** A detached `sh` inside the control-plane container; mounting the
Docker socket into the control plane; a sidecar "updater" container polling a queue.

**Why.** The first is simply wrong, and attractively so: `spawn(..., {detached: true})` looks
like it survives, but the process it starts lives inside the container that `docker compose up`
is about to recreate. It dies mid-`--wait`, taking the rollback branch with it — so the failure
mode is "the update half-applied and nothing cleaned up", which is the exact failure this whole
section exists to prevent. Mounting the Docker socket would fix that by giving the control plane
root on its own host, which is a much larger grant than "restart yourself". A sidecar works but
adds a container whose only job is to be the thing that is not being restarted; systemd is
already on the box, already supervises the agent, and is already required by the installer.

**What it costs.** Self-update needs `install.sh` to have run on the host. An instance deployed
by hand answers `precondition_failed` with that reason rather than pretending, and its agent
fleet can still be updated from the panel.

---

## KD-031 — A fresh install is claimed with a token, not by whoever finds the port

**Decision.** `bootstrap()` no longer creates an owner account on its own. It does so only when
`KANAME_BOOTSTRAP_EMAIL` **and** `KANAME_BOOTSTRAP_PASSWORD` are both set explicitly — the
development-fleet and CI path. Otherwise the instance mints a one-time setup token, prints it in
the installer's final output and logs it once on every boot while no account exists, and every
`/setup/*` mutation requires it until an owner exists.

**Why.** The window between "the installer finished" and "somebody created an account" is a real
window on a real network, and the previous behaviour resolved it in the worst possible way:
generating a password, printing it to a log, and creating an account nobody chose the address for
or would ever rotate. Gating on a secret only the person at the terminal has seen closes the
window without inventing an account.

**Why not burn the token on first contact.** It is retired when the owner account is created, not
when it is first presented. A browser reload before that point would otherwise strand the person
installing, and the token's whole lifetime is the minutes before an account exists.

**Consequence.** Onboarding is a one-way door. `/setup/token` and `/setup/owner` refuse once an
owner exists; the remaining steps require that owner's session, so a stale setup cookie cannot
keep renaming an instance somebody else now owns.

---

## KD-032 — Notifications are delivered in-process, from the same bus the panel reads

**Decision.** A `NotificationService` in the control plane subscribes to the in-process event bus
— the one `GET /events` fans out to browsers — and turns the events an operator subscribed a
channel to into an email (SMTP via nodemailer), a signed webhook (`X-Kaname-Signature:
sha256=HMAC(secret, "<timestamp>.<body>")`) or a Slack incoming-webhook message. The SMTP
password and webhook signing secrets are sealed into `secrets` with the same envelope encryption
as every other credential; the settings API returns `password_set` / `secret_set` booleans, never
the values. Every channel and the mail server can be tested from Settings, and the answer is the
transport's own error, not "something went wrong".

**Alternatives considered.** A separate notifier daemon reading the database; a job type per
notification so the worker carries it; delivering from the routes that raise the condition.

**Why.** The panel already learns about everything it shows from the bus, so the bus is the one
place a message can be raised once and reach every subscriber. A daemon would be a second process
to install, supervise and update for what is a few hundred lines. Jobs are for work that reaches
a host (KD-008) — an email is not that, and a channel that is down must not clog the queue that
restarts services. Raising from routes would miss everything the reconciler, the worker and the
updater discover on their own, which is most of what is worth an email.

**What keeps it from becoming the thing people mute.** A server has to stay gone for the offline
window (Settings → Agents) before anyone hears about it, and its return is one message under the
same subscription. Repeated threats from one address are one message an hour; a failed unit one
per half hour; a certificate one message per threshold (14, 7, 3, 1, 0 days), not one per sweep;
a release one message, remembered across restarts. Every channel has a ceiling of deliveries per
ten minutes, and the queue behind them is bounded. A delivery failure is `last_error` on the
channel, shown in Settings — it never throws into the publisher and never disables the channel.

**What it costs.** The control plane makes outbound SMTP and HTTPS connections, which it already
did for release manifests and ACME. `nodemailer` is a new runtime dependency, kept external in the
bundle like the other native-adjacent ones; its `sendmail` transport, which spawns a process, is
not used and must not be — the control plane still has no `child_process`.

---

## KD-033 — The agent is Rust; KD-001 is superseded

**Decision.** `kanamed` is a single statically-linked Rust binary (musl, cross-linked with zig,
the same recipe Yunori Mail Server ships with). The Go module is gone. The wire protocol, the
state directory, enrollment, the asset names and the systemd unit are unchanged, so a fleet
updates in place.

**Alternatives.** Keep Go (KD-001 still argued for it on velocity); rewrite only the mail
provider in Rust as a sidecar and keep the Go agent for everything else.

**Why.** FutureForge's infrastructure products are converging on one language: Yunori Mail Server
is Rust, and the mail module now drives it (KD-034). One toolchain, one set of release recipes,
one static-binary story, and the parsers that read Yunori's CLI can be shared verbatim between
the two products. Rust also closes the class of bugs the Go agent had to guard against by
convention: a stream that writes after cancellation, a child process that outlives its request,
a path check skipped on one verb. Ownership and `Drop` make those structural. The surface is the
same 109 verbs behind the same conformance test, so the port was a translation, not a redesign.

**What was kept, deliberately.** The provider seam (KD-010) with a Linux and a simulated
implementation; argv-only execution with no shell anywhere; the path guard that denies the
agent's own key material; the 32-chunk stream window and half-window acks; the raw `r||s` P-256
challenge signature WebCrypto verifies; the 6-hour deadline clamp; the `unsupported`-before-exec
capability gate. The sidecar alternative lost because it would have left two agents on one host
sharing one identity.

**Cost accepted.** A longer compile than `go build`, and a cross-link step for arm64. Both are
confined to CI and the control-plane image.

---

## KD-034 — Mail is Yunori Mail Server; Kaname does not own a mail stack

**Decision.** Kaname no longer writes Postfix or Dovecot configuration. A managed host runs
Yunori Mail Server (`yunori-mail`, which drives an unmodified Stalwart), and Kaname deploys it,
shows what it reports and sends it the mutations an operator asks for. The host advertises the
`yunori` capability when the binary is present; the `mail`, `postfix` and `dovecot` capabilities
are gone. The agent talks to Yunori through exactly one interface: the `yunori-mail` CLI with an
argv slice, which is the root interface that product sanctions and the one place its invariants
(vault-sealed secrets, hash-chained audit, DNS verified against public resolvers) are enforced.
The agent never reads Yunori's database or vault and never talks to Stalwart's API.

**Alternatives.** Keep the Postfix/Dovecot map-file provider; talk to Stalwart's JMAP management
API directly with the admin credential from Yunori's vault; add a loopback machine API to
`yunori-mail` first.

**Why.** The map-file provider was Kaname re-implementing a mail server's control plane
(deliverability checks, DKIM, queue parsing) that Yunori already does better, from the host's
vantage point, with verification instead of self-attestation. Reaching into the vault would make
Kaname a second administrator the audit ledger does not know about. A machine API in Yunori is
the right long-term answer and is the follow-up this decision leaves open: until then the CLI's
`--json` output is used where it exists (`preflight`, `doctor`) and its list formats are parsed
with tests pinned to the exact print statements of the version this ships against.

**What changed in the model.** Forwarders are gone (Yunori aliases deliver to a mailbox on the
same server; an external destination is a client-side rule, not a transport one). Mail DNS
authentication is Yunori's record checklist, not Kaname's checker, so `mail_auth_checks` and the
checker service were deleted rather than adapted. Mail logs are a live journal tail, not rows.
Deploying Yunori is a job that downloads a release archive the control plane resolved from the
Yunori feed, verifies its SHA-256 on the host, installs the binary and runs the unattended
installer; the one-time console setup link it prints is handed to the operator once and redacted
from the job log.

---

## KD-035 — A mailbox credential crosses one response and is never persisted

**Decision.** Creating a mailbox and resetting its password are the two host-touching mutations
that are **not** jobs. The route calls the agent synchronously, returns the generated password in
that one HTTPS response, and never writes it anywhere: not the row, not the job table, not the
audit record, not the log.

**Alternatives.** A job whose result carries the password; the operator chooses the password in
the form (the Postfix-era design); an invite link.

**Why.** Yunori generates mailbox passwords on the host and prints each once; there is no CLI path
for a chosen password, and that is a good property, not a gap. A job result is a persisted row
that outlives the moment, visible to anyone who can read jobs, which is a wider audience than the
person who created the mailbox. KD-008 exists so that a host mutation survives a control-plane
restart and reports honestly; a credential handoff that must not survive anything is the one
mutation where that guarantee is the wrong one. Invite links are Yunori's own self-service portal
and remain available there.

**The same rule for deployment.** The console setup link and the first mailbox's password from
a Yunori deployment live in an in-memory, once-only, fifteen-minute handoff in the control plane
and are redacted from the job log; the job log says where to find them.

---

## KD-036 — The panel wears the FF Studios design, with an Apple UI layer

**Decision.** The token sheet carries the FutureForge Studios design: the ink canvas
(`#0A0A0C`, surfaces `#131316` / `#1A1A1F`, recess `#060608`), white-alpha hairlines, three
text tiers, and brand purple `#7A4FF4` as the only accent. Semantic colour comes from its
secondary hues (teal, yellow, red; info is a derived blue). Dark is the default and the design
target; light is built from the ffstudios paper palette. On top sits an Apple-style UI layer:
continuous rounded corners (6 / 8 / 10 / 14 / 16px), translucent vibrancy materials on the
sidebar and top bar, soft layered shadows on floating surfaces and cards, the
`cubic-bezier(0.32, 0.72, 0, 1)` ease at 140 / 240 / 360 ms, and a 3px focus halo. The
interface face is SF Pro (Inter off Apple platforms), mono is SF Mono (JetBrains Mono
elsewhere), and page titles are Geist Pixel Square at 26.32px. Every `--kn-*` token name is
unchanged, so the component kit and the pages did not move. This replaces the earlier Yunori
skin.

**Why.** The owner asked for the FF Studios design with an Apple UI. FF Studios supplies
identity (palette, accent discipline, the pixel display face); the Apple layer supplies the
feel of a native operator tool. The design-system rules that matter for an infrastructure panel
(status colour means status, two status axes never collapsed, monospace for anything you would
grep, density) are unchanged.

**Deliberate deviations from the ffstudios system.** Its "radius 0 everywhere, no shadows, no
glows" rule is overridden by the Apple layer: corners are rounded, cards and overlays carry
soft neutral shadows (still no coloured glows). Satoshi is not used, because it is licensed to
the ffstudios site and this repository is public. Geist Pixel ships under the OFL in the
`geist` npm package and is redistributable.

**Cost accepted.** Light paper needs its own accent text value (`primary-ink #6A3EE8`), since
ffstudios' accent-fg is 2.4:1 there. The light focus halo is 75% rather than 60% to stay above
3:1. White on the dark danger fill is 3.2:1. Backdrop blur costs GPU time on the two chrome
surfaces; `prefers-reduced-transparency` turns it off.

---

## KD-037 — A job's creator may cancel it; revoking is `infra.servers:delete`

**Decision.** `POST /jobs/:id/cancel` is allowed for the user who created the job, and otherwise
needs `infra.servers:write` on the job's server, as before. `POST /servers/:id/revoke` needs
`infra.servers:delete`, the permission whose description already said it is what revokes. The job
drawer only offers Cancel to someone the API would accept, and the revoke controls follow
`infra.servers:delete`.

**Alternatives.** Cancel with the permission of the job's own spec (`JOB_SPECS[type].permission`);
leave cancel on `infra.servers:write`; change the description of `infra.servers:delete` instead
of the code.

**Why.** Cancelling never does more than the job would have done, so the person who started it
needs no fresher grant than the one that enqueued it — and a Developer who could restart a unit
but not take the restart back had the two verbs the wrong way round. The spec's permission was
the closer runner-up, but one spec can serve several permission sets: every `db.*` spec names
the MySQL set and the route overrides it for PostgreSQL, so a PostgreSQL-only role would have been
refused its own job. Revoking cuts a host off until it is enrolled again; it belongs with removal,
not with renaming, and the sentence an owner reads in the role editor must be the rule the API
applies.

**Cost accepted.** A user cannot cancel a colleague's job without `infra.servers:write`, even one
of a kind they could start themselves. API keys have no creator identity on a job, so they cancel
only with `infra.servers:write`.

## KD-038 — The panel speaks the ffstudios.io design language; KD-036's Apple layer is superseded

**Decision.** The whole product, onboarding through dashboard, is drawn in the design language
of ffstudios.io (FutureForge Studios), adapted to a dense control panel. The Apple UI layer of
KD-036 is removed: no vibrancy or backdrop blur, no soft card shadows on ink, no SF Pro, no
spring ease, no 3px halo. In its place:

- **Canvas.** Flat ink (`#0A0A0C`) with a faint 64px blueprint grid, two vertical frame rails
  bounding the content column, and "+" crosshair marks where a full-bleed hairline meets the
  rails. Sidebar and top bar are solid ink with a hairline.
- **Shape.** Every action is a pill (primary: filled purple, optional trailing arrow;
  secondary: hairline ghost). Chips are 4–6px, fields 8px, cards and tables 14px, dialogs and
  feature cards 18px. Hairlines carry structure; shadows exist only on floating overlays (and
  a very soft card drop on paper).
- **Type.** Geist Sans (OFL, `geist` package, via `next/font`) for interface and tight-tracked
  headlines; JetBrains Mono for data and for the uppercase, 0.14em-tracked labels used by
  navigation groups, tabs, table headers, metric labels, eyebrows and breadcrumbs. Geist Pixel
  is demoted from page titles to an optional small accent.
- **Vocabulary.** New kit primitives carry the site's signature pieces: `Eyebrow`,
  `MonoLabel`, `GradientText`, `LeaderLabel`, `StatusLine`, `SectionHeader` /
  `NumberedSection`, `CheckList` / `CheckItem`, `Card` / `CardInset`, `GridBackdrop`,
  `Crosshair`, `PageHero`, `PageBody`, `SegmentedControl`; `PageHeader` gains `eyebrow`,
  `lede` and `status`, `SectionCard` gains `index` and `caption`, `Button` gains `arrow` and
  size `lg`.
- **Motion.** The site's curves: ease-out-expo `cubic-bezier(.16,1,.3,1)` for movement,
  `cubic-bezier(.4,0,.2,1)` for colour, at 150 / 240 / 400 ms.

Every `--kn-*` token name and every component's public API is unchanged (props were only
added), so no page had to move for the foundation to land. Rules and reasons:
`docs/design-system.md`; migration guide for pages: `docs/redesign-guide.md`.

**Why.** The owner asked for everything to be redesigned in the ffstudios.io language — the
studio's own site — rather than that palette under another platform's manners. One language
across the studio's products is the point; the Apple layer was the part that made Kaname look
like something else.

**Deliberate deviations from the site.** Satoshi is licensed to ffstudios.io and this
repository is public, so headlines are Geist Sans. The marketing scale (64px headlines, the
purple glow, the gradient line) is confined to setup, sign-in, invite and first-run states;
routine pages use the same anatomy at working density (28px titles, 36px rows). Sidebar leaves
stay sentence-case sans — thirty uppercase mono links are slower to scan than the site's five —
while group labels, tabs and breadcrumbs take the mono treatment. The secondary pill rests at
white 16% and reaches the site's 40% line on hover, because a toolbar of five 40% outlines
shouts. Identifiers are never uppercased. The operator rules that predate this (status colour
means status, the two status axes never collapse, monospace for anything greppable, density)
are untouched.

**Cost accepted.** Mono uppercase labels are wider than the sans they replace, so a long table
header or metric label truncates sooner in a narrow column (headers are tracked 0.10em rather
than 0.14em to limit this). Pills round the ends of a button group. The grid and rails are two
more background layers on the scroll container; they are CSS gradients and cost nothing
measurable. Light theme accent text keeps its own value (`#6A3EE8`) because primary-soft is
2.4:1 on paper.

## KD-039 — View modes and scoped accounts: resellers without tenancy

**Decision.** Two independent ideas, never mixed:

- **View mode** (`simplified` | `advanced`) is a per-user preference stored on `users.view_mode`
  and switched from the top bar. It hides pages and changes the home; it never changes what the
  API allows.
- **Audience** (`operator` | `reseller` | `client`) is who the account is. A reseller is a user;
  a client is a user whose `parent_id` is its reseller. There is no `org_id`, no tenant table
  and no billing. What a scoped account may touch is one row per resource in `resource_owners`
  (`site`, `domain`, `mailbox`, `database`), plus the servers listed in `account_limits`.

Scoped accounts get a fixed grant list that is **inert** until a route opts in with
`ownership(req)` (`apps/control-plane/src/routes/_ownership.ts`): that call is the route saying
"I filter by owner", and returns `filter`, `assertOwns` (404, never "exists but not yours"),
`reserve` (quota) and `claim`. A route that never opts in refuses scoped accounts, so every
infrastructure, security and administration route stays operator-only without being edited.
Quotas (sites, domains, mailboxes, databases, disk MB; null = no limit of its own) are set per
reseller by an operator and per client by the reseller within its own; a reseller's usage counts
its clients'. Branding (display name, up to four logo characters, support email/URL) belongs to
the reseller and is shown to its clients.

Owners and admins can **view as client / reseller**: a presentation-only preview held in the
browser. It filters navigation and the home, is bannered, exits in one click, and never grants,
impersonates or changes a request.

**Why.** The owner wants to hand sites and mailboxes to clients and to small resellers without
Kaname becoming shared-hosting software. Ownership rows on top of the existing scoped RBAC give
that with one table and one helper; a tenant column would have touched every query.

**Cost accepted.** Disk usage is what Kaname can measure without walking filesystems (database
sizes plus mailbox allowances), so a site's files do not count. A resource has one owner; a
reseller "sharing" a site with two clients is not modelled. PLAN.md §0's non-goal narrows to
multi-tenant hierarchies and billing.

## KD-040 — Container apps: a typed create with agent-side guards, companions on a private network, loopback-only ports

**Decision.** The app installer provisions image recipes (Ghost, Nextcloud, Uptime Kuma, n8n,
Gitea, Plausible CE) through six new agent verbs: `container.image.pull`,
`container.network.create`, `container.create`, `container.task.run`, `container.app.status` and
`container.app.remove`. There is no Docker API passthrough. `container.create` takes a closed
`ManagedContainerSpec` — install id, role, image, env, bind mounts, published ports, optional
memory/CPU, an optional `nofile` ulimit, entrypoint argument tokens and small read-only config
files — and the agent (`agent/src/providers/managed.rs`) validates it and writes the create body
itself. Those guards live in the agent, not only in the control plane:

- privileged off, `CapAdd` empty, no devices, `no-new-privileges`, private IPC/cgroup namespace,
  no host network/PID/UTS/user namespace, a PIDs limit, bounded json-file logs, restart
  `unless-stopped`; the entrypoint is never replaced and argument tokens cannot hold a space;
- every published port binds `127.0.0.1` (there is no host-IP field), host ports ≥ 1024;
- bind sources and config files only under `/var/lib/kaname-apps/<install_id>/`, checked
  lexically and again after resolving symlinks, so the runtime socket, `/etc` or the agent's key
  cannot be mounted; config files are always mounted read-only and opened with `O_NOFOLLOW`;
- images need an explicit tag or digest;
- names (`kaname-<install>-<role>`, network `kaname-<install>`) and labels (`io.kaname.managed`,
  `io.kaname.install`, `io.kaname.role`) are derived from the install id; `container.create`
  only replaces, and `container.app.remove` only deletes, resources carrying this install's labels.

Each install gets its own bridge network. Databases run as **companion containers** on it,
reachable by role (`db`, `events`) and never published: MySQL 8 for Ghost (the only engine Ghost
supports in production), PostgreSQL 16 for Nextcloud, n8n, Gitea and Plausible, plus ClickHouse
for Plausible with the settings from Plausible's Community Edition compose file. Uptime Kuma keeps
SQLite in its data directory. Generated passwords and keys are sealed in `secrets` under
`app_install:<id>:*` and removed with the install. The app is published on `127.0.0.1:<port>`,
allocated per server from 20000–29999 and recorded on `app_installs.app_port` (migration 0010,
unique per server); the site is a `container` runtime vhost proxying to it (websocket upgrade
headers included), and nginx now answers the ACME challenge from the webroot for proxied sites
instead of passing it to the app. Gitea's SSH is disabled and its port 22 never published: clone
over HTTPS.

**Why.** PLAN.md §0: the web tier must never reach a root primitive. A reachable container socket
is a root shell, and a "create container" verb that accepted a raw body would be one too
(`Privileged: true`, a bind of `/`). A closed shape validated where the socket is makes that
impossible to express rather than merely checked upstream. Per-install networks keep one app's
database unreachable from another app; loopback-only ports mean nginx and its certificate are the
only way in, so a container never bypasses the host firewall the way Docker's published ports do.

**Cost accepted.** The managed root is outside the agent's state directory
(`/var/lib/kaname-apps`, not `/var/lib/kaname/apps`), because that directory is denied to every
file verb. Images are not removed on uninstall (they may be shared). Podman hosts advertise
`podman`, not `docker`, and are not offered image recipes yet. A port someone else binds on the
host after allocation surfaces as a failed container start and a rolled-back install, not as a
reallocation. Upgrading an installed app's image is not covered.

## KD-041 — OS package updates are a cached read and an ordinary job

**Decision.** A host's pending package updates (`system.packages.list`) are cached per server in
`settings` under `os_updates:<server id>` and every page reads the cache. The control plane
refreshes a connected host's cache when it is older than six hours (a background pass every ten
minutes, one host at a time), on an explicit **Check now**, and after every upgrade. Upgrading is
the existing `system.packages.upgrade` job — all packages or `security_only` — under the
permission it was always specced with: `infra.servers:read` to look, `infra.servers:write` to
upgrade or opt a server in to automatic security updates (security-only, at most once a day, never
stacked on an upgrade in flight). "Reboot required" is learned only from an upgrade's result and
cleared by a refresh that sees a later `boot_time`; Kaname never reboots a host by itself.

**Why.** `apt-get update` across a fleet on page load is the KD-012 mistake at its most expensive.
A cache row in `settings` needs no migration and merges atomically (`value || patch`), so a refresh
and a settings change cannot overwrite each other. No new permission: the job spec already named
`infra.servers:write`, which also guards rebooting the same host, and scoped accounts hold neither.

**Cost accepted.** The list can be up to six hours old (the page says how old). Rows for a removed
server linger in `settings` until overwritten; they are never read because every read joins the
fleet. A reboot pending from outside Kaname (an upgrade run over SSH) is not detected.

## KD-042 — App health is probed from the control plane; app alerts are ordinary alert rules

**Decision.** Each active app install gets an HTTP(S) probe of its own address and a configurable
path (default: the recipe's health endpoint, else `/`) once a minute, **from the control plane**,
10 s timeout, eight at a time; a final 2xx is up, anything else (status, timeout, refusal, TLS)
is a failure. Image recipes additionally get one `container.list` with stats **per server** every
other minute (grouped by the `io.kaname.install` label), and one `fs.usage` of the managed data
directory every six hours. Samples live in `app_health_samples` (eight days), the running verdict
in `app_monitors`. Alerting on them is not a second engine: an app rule is an `alert_rules` row
with an app kind as `metric`, `{ kind: "app" }` as scope and `app_install_id` set, evaluated in the
same pass and through the same pending → firing → resolved lifecycle, open-alert key and
notification path as a server rule. Defaults (app down after 3 failed checks; restart loop for
image recipes; certificate expiring for HTTPS) are created once an install is active and cascade
away with it.

**Why.** The control plane is where a visitor stands: a probe from the host itself would pass with
DNS, the firewall or the certificate broken, and needs a new agent verb. One poll per server, not
per install, keeps container stats off the agent's back. Reusing the rule engine means mute,
tune, dedup and channels already work, and Monitoring lists app alerts with no special case.

**Cost accepted.** A control plane that cannot reach the internet (or its own apps' names) sees
every app as down — the probe can be paused per app. A simulated host answers its probe from its
container state (KD-010). The certificate-expiring app rule only marks the app; the certificate
sweep keeps sending the one notification. App rules notify the operator's alert channels — there
is no per-user channel, so a client sees its apps' alerts in the panel, not in its inbox.
