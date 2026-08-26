<div align="center">

# Kaname

**要** — the keystone. The control plane for your infrastructure.

</div>

Kaname is a self-hosted control panel for a small fleet of Linux servers: infrastructure,
websites, files, email, databases, security, backups, monitoring, logs and a terminal, in one
place, owned entirely by the person running it.

It is built for an owner-operator, not for a shared-hosting reseller. That shapes every
decision in it — see [PLAN.md](PLAN.md) for the architecture and [DECISIONS.md](DECISIONS.md)
for why each call was made.

> [!IMPORTANT]
> **Pre-release — the install below does not work yet.** Nothing has been published: this
> repository has no commits, so the `curl` in the one-liner 404s before `sh` ever runs. Given the
> script locally it then fails fetching the deployment files from the same unpublished ref, and
> after that would fail pulling `ghcr.io/futureforge-studios/*`, which has never been pushed.
> The installer is written and reviewed but has **no automated test and has never been run end to
> end**. See [Status](#status) for the rest of what is and is not real.
>
> What works today is [running it from source](#running-it-from-source) against a simulated fleet.

---

## The idea

Three tiers, with a hard line between them:

```
Browser ──HTTPS──▶ Control plane ──WSS + signed assertion──▶ kanamed (one per host)
                   no shell, no root,                        the only thing that touches
                   no container socket                       systemd, docker, the filesystem
```

The control plane never executes anything on a managed host — it has no `child_process`, no SSH
client and no container-socket dependency. The agent's 100 RPC methods are enumerated verbs that
decode into typed parameter structs, and there is no `exec(command)` among them; a Go conformance
test keeps that list honest against the contract. It binds no network port at all, because it
dials out.

Every panel in this category that has had a serious CVE had the same shape of bug: the web tier
could reach a root-level primitive directly. Kaname answers that structurally rather than with a
hardening checklist.

Two consequences you will notice immediately:

- **Mutations that reach a host are jobs.** Restarting a service returns `202` and a job whose
  pill moves `queued → running → succeeded`, streams its log, and survives a control-plane
  restart. Not a spinner that lies. (Reads pass through synchronously; the terminal, file upload
  and the firewall-confirm race are three deliberate streaming exceptions.)
- **Reachability and health are separate axes.** A server can be connected and critical, or
  disconnected and unknown. Both are always shown; neither collapses into one dot.

---

## Install

One command on a fresh server installs the control plane, the panel, Postgres and Caddy as a
Compose project, and pairs an agent on that same box so it becomes managed server #1.

```bash
curl -fsSL https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/install.sh | sudo sh -s -- --domain=panel.example.com
```

`install.sh` is POSIX `sh` and is meant to be read before it is run — no obfuscation, and every
file it downloads with `curl` has its URL printed first. (The container images it pulls come from
`$KANAME_REGISTRY`, default `ghcr.io/futureforge-studios`, plus `postgres:16-alpine` and
`caddy:2-alpine`; that pull logs to the install log rather than the terminal.) Read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/install.sh | less
```

> **Pass `--domain`.** Without it Caddy's only site address is the literal `localhost`, while the
> installer still prints `http://<this box's first IP>` as the URL to open — an address Caddy will
> not answer for. Nothing serves the panel until you set a domain.

### What the panel host needs

|              |                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS           | Linux with systemd. Tested on Debian 11+, Ubuntu 20.04+, Rocky/AlmaLinux/RHEL 9+, Fedora 38+. Only the distro **ID** is checked, never the version: `debian, ubuntu, raspbian, rocky, almalinux, rhel, centos, fedora` pass silently at any release; anything else warns and continues. |
| Architecture | `x86_64` or `aarch64`. Nothing else is accepted.                                                                                                                                                                                                                                        |
| Docker       | 24 or newer (server version), with the Compose v2 plugin. Installed from `https://get.docker.com` if absent.                                                                                                                                                                            |
| Also         | `curl`, `tar`, and root.                                                                                                                                                                                                                                                                |
| Network      | Ports 80 and 443 reachable. **The installer does not touch your firewall** — open them yourself.                                                                                                                                                                                        |

### What it does, in order

1. **Open the log.** `<data-dir>/logs/` is created before any check runs — so a non-root
   invocation dies on that `mkdir`, not on the friendly root check below.
2. **Preflight.** OS, architecture, systemd, root, `curl`/`tar`. Fails loudly and names what is
   missing rather than half-proceeding.
3. **Docker.** Installs it if absent; verifies the server version is 24+ and that the Compose
   plugin is there.
4. **Existing install?** A re-run is a reconfigure-and-repair, never a wipe. Secrets and data are
   kept, deployment files and units are refreshed.
5. **Secrets.** `KANAME_MASTER_KEY`, the Postgres password and the setup token are generated on
   the machine with `openssl rand` (or `/dev/urandom` if openssl is absent). No placeholder or
   example credential exists anywhere in the installer or the images.
6. **Deployment files.** Fetches `infra/docker-compose.yml`, `infra/Caddyfile` and
   `infra/kaname-update.sh` from `KANAME_SOURCE_URL`, printing each URL first.
7. **Update units.** Writes the two `kaname-update` systemd units and enables the path watcher.
8. **Deploy.** Pulls the pinned images and brings the project up with `--wait`.
9. **Pair.** On a _first_ install in the default mode, mints an enrollment token through the
   control plane on loopback and enrols a local `kanamed`. Skipped by `--control-plane-only`,
   `--agent-only`, `--no-start` — and skipped on any re-run, which restarts the agent already
   paired here instead of pairing a second time.
10. **Verify.** Waits for `/health`, and — in the default mode — waits up to 60 seconds for
    `/health` to report at least one connected agent. If either fails it prints what broke and the
    exact command to investigate, and does not claim success.
11. **Print** the URL, the setup token, and where the secrets live.

Everything is logged to the terminal and to `<data-dir>/logs/install-<timestamp>.log`.

> A failure _before_ pairing is safe to re-run over. A failure **at** pairing is not: `.env`
> already exists by then, so the re-run is treated as a repair, skips pairing, and fails
> verification every time. Clear it with `--force`, or enrol the agent by hand.

### Modes

```bash
# Control plane + an agent on this box (the default)
curl -fsSL <installer> | sudo sh -s -- --domain=panel.example.com

# Control plane only — pair servers separately
curl -fsSL <installer> | sudo sh -s -- --domain=panel.example.com --control-plane-only

# A managed server, joining an existing panel
curl -fsSL <installer> | sudo sh -s -- \
  --agent-only --token=<pairing-token> --control-plane=https://panel.example.com
```

A managed server needs **no Docker** — only systemd, `curl`, `tar` and root. `--agent-only` skips
the Docker check entirely.

### Flags

| Flag                    | Default           |                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--domain=<domain>`     | `localhost`       | Public domain. Caddy gets a certificate for it.                                                                                                                                                                                                                   |
| `--control-plane-only`  | off               | Install the control plane; pair no agent here.                                                                                                                                                                                                                    |
| `--agent-only`          | off               | Install only the agent. Requires `--token` and `--control-plane`.                                                                                                                                                                                                 |
| `--token=<token>`       | —                 | Pairing token from **Infrastructure → Servers → Add server**.                                                                                                                                                                                                     |
| `--control-plane=<url>` | —                 | Where the agent dials. (`--url` is accepted as an alias.)                                                                                                                                                                                                         |
| `--version=<version>`   | `0.1.0`           | Release to install.                                                                                                                                                                                                                                               |
| `--data-dir=<path>`     | `/etc/kaname`     | Install root.                                                                                                                                                                                                                                                     |
| `--state-dir=<path>`    | `/var/lib/kaname` | Agent identity directory.                                                                                                                                                                                                                                         |
| `--force`               | off               | Only when `<data-dir>/.env` exists: `docker compose down -v` and delete the data root, after listing what it will destroy. Leaves the agent behind — the binary, `kanamed.service`, the identity in `/var/lib/kaname` and both `kaname-update` units all survive. |
| `--no-start`            | off               | Write the deployment files and the systemd units; start no containers. The `kaname-update.path` watcher **is** enabled and started, and Docker is installed and started if it was absent.                                                                         |
| `--debug`               | off               | `set -x`.                                                                                                                                                                                                                                                         |
| `--help`                |                   | Usage. `-h` also works.                                                                                                                                                                                                                                           |

Every value flag accepts both `--flag value` and `--flag=value`. `KANAME_SOURCE_URL` and
`KANAME_REGISTRY` are environment-overridable, which is how you point the installer at a fork or
a private registry.

Re-running with `--domain`, `--version` or a different image changes nothing that is deployed:
those live in `<data-dir>/.env`, which an existing install keeps. (The closing banner still echoes
whatever `--version` you passed — trust the `.env` over it.) Edit that file, or use `--force`, to
change them.

### What lands on disk

In the default all-in-one mode:

```
/etc/kaname/                       0750 root:10001 — numeric gid the control-plane image runs as
  .env                             0640 — secrets and pinned image tags
  docker-compose.yml
  Caddyfile
  logs/                            install logs
  rollback/                        per-update .env snapshots
  updates/queue/                   update requests for the host-side updater
/usr/local/bin/kanamed             the agent            — not installed by --control-plane-only
/usr/local/lib/kaname/kaname-update.sh                  — control-plane installs only
/var/lib/kaname/                   0700 — the agent's key, certificate and CA
```

`--agent-only` writes only the agent, `/var/lib/kaname/` and an install log. No host account is
created for gid 10001 — the group is bound by number, so whatever local group holds that gid gets
read access to `.env`.

systemd units: `kanamed.service` (the agent — all-in-one and `--agent-only` only), plus
`kaname-update.path` and the `kaname-update.service` it triggers (control-plane installs only).
Only the `.path` unit is enabled; the service has no `[Install]` section and runs when a request
file appears in the queue.

Ports: Caddy holds **80** and **443**. The control-plane container publishes **127.0.0.1:4000**
only, so nothing reaches that port directly from outside the box — but the API itself is public:
Caddy proxies `/api/*`, `/agent/*`, `/health`, `/install.sh` and `/download/*` to it on 443, which
is how the browser and remote agents reach it.

> **Back up `KANAME_MASTER_KEY` from `<data-dir>/.env`, somewhere that is not the server.** It
> wraps every credential Kaname stores for you. Losing it loses all of them, permanently.

---

## First run

A freshly installed panel is answering on the network before anybody has an account on it. So
onboarding is gated on the **setup token** the installer prints — without it, the first stranger
to find the port would own the fleet. It can be presented as often as you need until an owner
exists, and is retired the moment one does.

Lost it? While no account exists it is logged on every boot:

```bash
docker compose -p kaname logs control-plane | grep setup_token
```

It lasts 24 hours. Because the installer writes it into `<data-dir>/.env`, restarting the control
plane re-arms and re-logs that same token.

Then six steps, driven by the server rather than by the browser, so closing the tab resumes in
place:

1. **Check the install** — live control-plane and agent status. On an all-in-one install this
   screen will not advance while the local agent is not connected.
2. **Create your account** — the first account owns everything. Password strength is enforced on
   the control plane, not by a client-side regex.
3. **Name this instance** — one field.
4. **Confirm your first server** — the paired host with its real facts, or a copyable pairing
   one-liner and a waiting state that resolves itself when the agent dials in.
5. **Preferences** — update cadence, one notification channel, an ACME address. Skippable.
6. **Done** — into the Command Center.

Creating the owner retires the setup token and closes the account step. Completing the wizard
closes the rest: after that `/setup` refuses outright, and anyone who navigates there lands on the
login form.

### Adding more servers

**Infrastructure → Servers → Add server** generates a single-use pairing token that expires in
15 minutes, and the one-liner to run on the new host. The agent generates an EC P-256 keypair
**on that machine**, sends a CSR, and receives a client certificate with `CN = <server id>`; the
private key never leaves the box. It then dials back out over `wss://` and appears as connected.

Nothing was opened inbound. No SSH credential was stored anywhere. Revoking a server invalidates
its certificate and drops the socket immediately. Certificates are valid 90 days and **do not
auto-rotate** — a host has to be re-enrolled by hand after that.

---

## Keeping it current

**Administration → Updates** shows what the control plane is running, what every agent is
running, and every past update run with its full output. Cadence is set in
**Administration → Settings**:

| Tier                  |                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| Off                   | Never check.                                                                          |
| **Notify only**       | Check on a schedule and surface it in the panel. Nothing applies itself. **Default.** |
| Apply patch and minor | Majors still ask.                                                                     |
| Apply everything      | Requires an explicit acknowledgement to turn on.                                      |

**A release marked breaking, or one whose migration rewrites data, always requires explicit
confirmation before it touches the control plane — under every tier, including "apply
everything".** Two functions enforce it, the one the scheduler asks and the one the apply endpoint
asks, and neither consults the tier before answering "no". Silent majors are not an acceptable
failure mode for software that runs other people's infrastructure.

An update first insists on a backup that succeeded in the last 24 hours — skippable, and the skip
is written to the audit trail — then snapshots `<data-dir>/.env`, adds only the configuration keys
the release declares it needs, pins the new images, and hands the restart to the host-side unit.
If the new build does not answer its health check, that unit puts the snapshot back and restarts
the previous version. The next boot judges what happened: a clean revert is filed as
`rolled_back`, but if migrations from the new version had already run it is filed as
`needs_attention` and says so, rather than quietly reporting a successful rollback onto a schema
the old build does not know.

Agent updates are ordinary jobs, tracked per host. An agent that does not dial back in at the new
version within five minutes is filed as `needs_attention` and stays visible until a person
acknowledges it.

---

## Running it from source

This is the path that works today. No Docker, no Postgres install — development runs on PGlite,
real Postgres compiled to WASM, so it is identical on Windows, macOS and Linux.

Requires **Node 22+**, **pnpm 10** and **Go 1.23+**.

```bash
git clone https://github.com/FutureForge-Studios/kaname.git   # once a first commit exists
cd kaname
pnpm install
cp .env.example .env      # for the seeded owner account and pnpm dev:fleet
pnpm db:migrate
pnpm db:seed              # a plausible 4-server fleet with 48h of history
pnpm dev                  # control plane on :4000, panel on :3000
```

Then, in a second terminal:

```bash
pnpm dev:fleet            # one simulated agent per seeded server
```

Sign in at <http://localhost:3000> with the credentials in `.env`
(`owner@kaname.local` / `kaname-development-only`). Those two `KANAME_BOOTSTRAP_*` variables are
what skip the onboarding wizard; unset them and you get `/setup` and a token in the log instead.
`pnpm dev:fleet` needs them, and needs `pnpm db:seed` to have run.

`pnpm dev:fleet` is not a mock. It signs in through the real API, requests real enrollment
tokens, and runs the real `kanamed` binary with its provider layer swapped for a simulated host —
so the dev loop exercises the same protocol, the same hub, the same job worker and the same UI
that production does. Simulated servers are labelled unmistakably in the panel.

### Useful commands

```bash
pnpm verify           # the gate: manifest + typechecks + go vet/build/cross-compile + suites
pnpm test:e2e         # Playwright on a stack it boots itself, isolated on :3100/:4100
pnpm typecheck        # every package (needs Go — the agent's typecheck is `go vet`)
pnpm test             # unit + integration, including `go test ./...`
pnpm db:reset         # drop, migrate, reseed
pnpm db:generate      # regenerate migrations after a schema change
pnpm agent:build      # build kanamed for the host platform
pnpm format           # prettier
```

`pnpm verify` is what has to be green. It emits the agent method manifest first, so the Go
conformance test compares against current schemas rather than a stale copy, then typechecks five
of the six TypeScript packages (everything but the e2e suite), vets and builds the agent for the
host _and_ cross-compiles it for `linux/amd64`, and runs the contract, UI, control-plane and agent
suites. It stops at the first category that fails and prints only that failure. It does not run
Playwright — `pnpm test:e2e` does.

`pnpm test:e2e` boots a whole stack in `globalSetup`: it resets and reseeds a separate database,
builds the agent, runs a full `next build`, starts the control plane, enrols four agents and
serves the panel. It uses ports 3100/4100 and `.data/e2e`, so it will not take your dev database
or dev ports — but it shares `apps/web/.next` with `next dev`, so stop `pnpm dev` first. The first
run needs `pnpm exec playwright install`.

Cross-compiling the agent:

```bash
cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/kanamed-linux-amd64 ./cmd/kanamed
```

---

## Layout

```
apps/web/              Next.js 15 panel — talks only to the control plane
apps/control-plane/    Fastify API, job worker, agent hub, internal CA
packages/contract/     Zod: every REST payload and every agent RPC method
packages/db/           Drizzle schema, migrations, demo seed
packages/ui/           Design tokens and the shared component system
agent/                 kanamed — Go, static binary, no listening socket
e2e/                   Playwright over a stack it boots from source
infra/                 compose files, Dockerfiles, Caddyfile, the host-side updater
scripts/               verify.mjs, the dev-fleet launcher, the release-manifest builder
docs/                  agent protocol and design-system references
install.sh             the one-line installer
versions.json          the published release manifest
```

`@kaname/contract` is the spine. The UI infers its types from it, the control plane validates
with it at the edge, and the agent's method registry is generated from it — so a payload can
only drift in one place, and it fails the build when it does.

Further reading: [`docs/agent-protocol.md`](docs/agent-protocol.md) for the wire protocol,
[`docs/design-system.md`](docs/design-system.md) for the design rules.

---

## Security notes worth knowing

- **The agent dials out.** It never calls `listen()`. Managed hosts need no inbound rule, no
  exposed SSH, and no credential stored in the panel.
- **Authentication is proof-of-possession**, not a shared secret: the agent signs
  `server_id|nonce|timestamp` with the key it generated locally, and the control plane verifies it
  against the certificate it issued. The nonce is agent-chosen and not yet server-issued, so a
  captured token request is replayable inside the 60-second clock-skew window. Client-certificate
  pinning is applied on top wherever the deployment presents a peer certificate — the Compose
  deployment does not, so today the signature is the whole check.
- **No verb takes a command.** No RPC method accepts a command, script, argv or SQL string as a
  parameter, and there is no `sh -c` anywhere in the Linux provider. Parameters are validated by
  the control plane at the edge; the agent adds its own checks on the arguments that matter —
  paths, container ids, engine names, package names.
- **The audit trail is insert-only and hash-chained.** Rewrite rules turn any `UPDATE` or `DELETE`
  on `audit_events` into a no-op — note that the statement _succeeds_ and changes nothing rather
  than erroring — so the chain, not the rule, is the real guarantee. **Security → Audit** shows the
  verification state and can re-verify on demand.
- **Firewall changes apply behind a rollback window.** If you do not confirm within the timeout,
  the host reverts. This is what stops you locking yourself out. (sshd changes arm the same window
  on the agent, but the panel has no confirm path for them yet — see Status.)
- **Terminal sessions are a separate permission** (`terminal.session:exec`), ticketed, IP-bound,
  audited on open and close, and recorded by default. Note this is not a privilege boundary on its
  own: `files.manager:write` reaches every path on the host through a root agent, so any role
  holding it — including the seeded Developer role — is root-equivalent on the servers it is
  scoped to.
- **Roles carry per-permission, per-server scopes** — 72 permissions across 11 modules, 5 system
  roles — rather than a single admin flag.

---

## Status

Honest about what is and is not real.

**Not released.** No tag, no published images, no CI, and the repository has no commits yet.

**Never run on a real host.** Every host-touching file in the Linux provider is behind
`//go:build linux`; it compiles, cross-compiles, and its pure logic is unit-tested, but this was
built on Windows and that code has never executed. Everything demonstrable today runs through the
simulated provider.

**Known bugs that block a real install:**

- The control plane serves `/install.sh` and `/download/kanamed-linux-*` from a path resolved
  relative to its own module, which is only correct in a source checkout — inside the built image
  both 404, so all-in-one pairing and the add-a-server one-liner cannot fetch the agent.
- The control plane cannot write `<data-dir>/.env` (it is `0640 root:10001` in a `0750` directory,
  so its uid has read but not write), which is the first thing a self-update tries to do. That
  path has only ever run against a temp-directory fixture.
- A rolled-back update re-`chmod`s `.env` to `0600`, after which the control plane cannot read it
  either.

**Scaffolding — present in the UI, not wired to a host:**

- Deployments record state but build, clone and copy nothing.
- FTP is panel-side only. The agent has no FTP verb, so no account is ever created, changed or
  removed on the host.
- Adding a mail domain records it but provisions nothing.
- DNS is implemented for Cloudflare and manual zones only, despite the wider provider list.
- Notification channels are stored but nothing sends to them — an available update or a failed job
  shows up in the panel, not in your inbox.
- sshd configuration changes arm a rollback timer on the agent with no way to confirm them, so a
  change made with the default window silently reverts.
- The job drawer links to a job-detail page that does not exist.
- Terminal recordings are never pruned.

**What is real**, and covered by the test suites plus an end-to-end Playwright run over four live
simulated agents: the three-tier boundary, enrollment and the RPC protocol, the job queue and its
worker, RBAC with per-server scoping, the audit chain, the mail DNS-authentication engine, the
terminal, onboarding, and the update system's decision logic.

---

## Licence

Not yet chosen. This is a studio-internal tool first; a licence will be attached before any
public release.
