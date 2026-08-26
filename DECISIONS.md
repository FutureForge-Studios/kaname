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
recorded to `job_logs`-style storage with a retention setting.

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

**Decision.** `packages/contract` emits `agent/internal/rpc/methods.json`; the Go agent embeds
it and a test asserts the live registry matches — same method names, same stream modes, same
capability requirements, same protocol constants. Go structs stay hand-written.

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
