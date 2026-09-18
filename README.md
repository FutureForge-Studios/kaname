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
> **Beta, and not published yet.** The install below works once this repository has been pushed and
> a `v*` tag has built the images — `.github/workflows/release.yml` publishes them to GHCR and
> writes `versions.json`. Until that first tag exists, the one-liner has nothing to fetch. The
> installer has also never been run end to end on a real server; it is reviewed and
> shellcheck-gated in CI, not proven. See [Status](#status) for the rest.
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

One command on a fresh server. It installs the control plane, the panel, Postgres and Caddy as a
Compose project, serves the panel on that server's IP, and pairs an agent on the same box so it
becomes managed server #1.

```bash
curl -fsSL https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/install.sh | sudo sh
```

No arguments, no domain, no DNS record. When it finishes it prints an address like
`http://203.0.113.10` and a setup token. You can set a domain and get HTTPS later, from inside the
panel — see [Setting a domain](#setting-a-domain).

`install.sh` is POSIX `sh` and is meant to be read before it is run — no obfuscation, and every
file it downloads with `curl` has its URL printed first. (The container images come from
`$KANAME_REGISTRY`, default `ghcr.io/futureforge-studios`, plus `postgres:16-alpine` and
`caddy:2-alpine`; that pull logs to the install log rather than the terminal.) Read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/install.sh | less
```

### What the panel host needs

|              |                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS           | Linux with systemd. Tested on Debian 11+, Ubuntu 20.04+, Rocky/AlmaLinux/RHEL 9+, Fedora 38+. Only the distro **ID** is checked, never the version: `debian, ubuntu, raspbian, rocky, almalinux, rhel, centos, fedora` pass silently at any release; anything else warns and continues. |
| Architecture | `x86_64` or `aarch64`. Nothing else is accepted.                                                                                                                                                                                                                                        |
| Docker       | 24 or newer (server version), with the Compose v2 plugin. Installed from `https://get.docker.com` if absent.                                                                                                                                                                            |
| Also         | `curl` and root.                                                                                                                                                                                                                                                                        |
| Network      | Port 80 reachable, and 443 too once you set a domain. **The installer does not touch your firewall** — open them yourself.                                                                                                                                                              |

### What it does, in order

1. **Root check.** Before anything else, including opening the log — a run without `sudo` gets
   one sentence saying so, not a permission error from `mkdir`.
2. **Open the log.** `/etc/kaname/logs/` is created before any other check runs.
3. **Preflight.** Distribution ID (a distribution not on the tested list warns and continues),
   architecture, systemd, `curl`. Fails loudly and names what is missing rather than
   half-proceeding.
4. **Docker.** Installs it if absent; verifies the server version is 24+ and that the Compose
   plugin is there.
5. **Existing install?** A re-run is a reconfigure-and-repair, never a wipe.
6. **Secrets and address.** Finds this server's primary IPv4 address with `ip route get` — no
   external service is contacted. If that address is private (cloud NAT puts the public one in
   front of the interface), it warns and tells you to re-run with `--public-url`, which also
   works as a repair on an install that already exists. Generates `KANAME_MASTER_KEY`, the Postgres
   password and the setup token with `openssl rand` (or `/dev/urandom` if openssl is absent). No
   placeholder or example credential exists anywhere in the installer or the images.
7. **Deployment files.** Fetches `infra/docker-compose.yml` and `infra/kaname-host.sh`, printing
   each URL first, then generates the Caddyfile from `.env`. Every download retries and times
   out rather than hanging.
8. **Update units.** Writes the two `kaname-update` systemd units and enables the path watcher.
9. **Deploy.** Pulls the pinned images and brings the project up with `--wait`.
10. **Pair.** Unless `--control-plane-only`, downloads `kanamed` from the control plane it just
    started, checks it against the SHA-256 the control plane publishes beside it, and enrols it
    over loopback. Which of those steps still need doing is read off the disk, so a run that
    failed after the download, or a host whose unit or identity was lost, is fixed by running the
    installer again. Once an account exists the setup token can no longer pair, and the installer
    says to re-run with a `--token` from the panel instead.
11. **Verify.** Waits for `/health`, and — in the default mode — for `/health` to report at least
    one connected agent. If either fails it prints what broke and the command to investigate, and
    does not claim success.
12. **Print** the URL, the setup token, and where the secrets live.

Everything is logged to the terminal and to `/etc/kaname/logs/install-<timestamp>.log`.

### Modes

```bash
# Control plane + an agent on this box (the default)
curl -fsSL <installer> | sudo sh

# Control plane only — pair servers separately
curl -fsSL <installer> | sudo sh -s -- --control-plane-only

# A managed server, joining an existing panel
curl -fsSL <installer> | sudo sh -s -- \
  --agent-only --token=<pairing-token> --control-plane=http://203.0.113.10
```

A managed server needs **no Docker** — only systemd, `curl` and root. `--agent-only` skips the
Docker check entirely.

### Flags

Eight, and none of them required.

| Flag                    | Default  |                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `--control-plane-only`  | off      | Install the control plane; pair no agent here.                                                           |
| `--agent-only`          | off      | Install only the agent. Requires `--token` and `--control-plane`.                                        |
| `--token=<token>`       | —        | Pairing token from **Infrastructure → Servers → Add server**. Also re-pairs an all-in-one host.          |
| `--control-plane=<url>` | —        | Where the agent dials.                                                                                   |
| `--public-url=<url>`    | detected | Where the panel is reached, e.g. `http://203.0.113.10`, for hosts whose interface has a private address. |
| `--version=<version>`   | `0.1.0`  | Release to install.                                                                                      |
| `--force`               | off      | Destroy an existing install first, after listing what it will destroy.                                   |
| `--help`                |          | Usage. `-h` also works.                                                                                  |

Every value flag accepts both `--flag value` and `--flag=value`. `KANAME_SOURCE_URL`,
`KANAME_REGISTRY` and `KANAME_PUBLIC_URL` are environment-overridable, which is how you point the
installer at a fork or a private registry, or at the address a NAT puts in front of the box.

### What lands on disk

In the default all-in-one mode:

```
/etc/kaname/                       0750 root:10001 — numeric gid the control-plane image runs as
  .env                             0660 — secrets, the address, and pinned image tags
  docker-compose.yml
  Caddyfile                        generated from .env; edits are lost on the next address change
  logs/                            install and reconfigure logs
  rollback/                        per-update .env snapshots
  updates/queue/                   requests for the host-side helper
/usr/local/bin/kanamed             the agent            — not installed by --control-plane-only
/usr/local/lib/kaname/kaname-host.sh                    — control-plane installs only
/var/lib/kaname/                   0700 — the agent's key, certificate and CA
```

`--agent-only` writes only the agent, `/var/lib/kaname/` and an install log. No host account is
created for gid 10001 — the group is bound by number, so whatever local group holds that gid gets
read access to `.env`.

systemd units: `kanamed.service` (the agent — all-in-one and `--agent-only` only), plus
`kaname-update.path` and the `kaname-update.service` it triggers (control-plane installs only).
Only the `.path` unit is enabled; the service has no `[Install]` section and runs when a request
file appears in the queue.

Ports: Caddy holds **80**, and **443** once a domain is set. The control-plane container publishes
**127.0.0.1:4000** only, so nothing reaches that port directly from outside the box — but the API
itself is public: Caddy proxies `/api/*`, `/agent/*`, `/health`, `/install.sh` and `/download/*` to
it, which is how the browser and remote agents reach it.

> **Back up `KANAME_MASTER_KEY` from `/etc/kaname/.env`, somewhere that is not the server.** It
> wraps every credential Kaname stores for you. Losing it loses all of them, permanently.

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

The binary the one-liner installs is served by the control plane itself, with its SHA-256
published beside it at `/download/kanamed-<target>.sha256`; the installer refuses to install one
that does not match, which matters while the panel is still on plain HTTP.

Nothing was opened inbound. No SSH credential was stored anywhere. Revoking a server invalidates
its certificate and drops the socket immediately. Certificates are valid 90 days and **do not
auto-rotate** — a host has to be re-enrolled by hand after that.

---

## Setting a domain

A fresh install answers on its IP over plain HTTP. There is no certificate, and
`SECURE_COOKIES` is off — a `__Host-` prefixed cookie is never stored over plain HTTP, so the
alternative would be an install nobody can sign in to.

Point an A record at the server, then set the domain from **Administration → Settings → Address**,
or on the last step of onboarding. Ports 80 and 443 both have to be reachable for the certificate
to be issued.

Setting a domain **adds** a site rather than moving one. Caddy's configuration is regenerated with
both the `:80` block and the new name, so the IP address you are currently looking at keeps working
— sign-in included — while the certificate is provisioned. Cookies are chosen per request: a
request over the new name gets a Secure `__Host-` cookie, one over the IP keeps a plain cookie, so a
session belongs to the address it was opened on and the new name asks you to sign in once. There is
no window where the panel is unreachable at the address you arrived by, and clearing the domain
returns you to the IP.

The control plane writes the change into `.env` and queues it for the same host-side unit that
applies updates — a container cannot regenerate the proxy in front of it and restart itself. The
panel blinks for a few seconds while that happens.

## Getting notified

Nothing in the panel needs to be watched to be noticed. **Administration → Settings →
Notifications** holds the channels — an email address, a webhook URL, or a Slack incoming
webhook — and the events each one wants: a failed job, a server going offline (and coming back),
a failed unit, a certificate inside its last two weeks, a failed backup, a threat from one
address, an alert, a failed deployment, a release becoming available, and an update finishing,
being rolled back, or the check for one failing.

Email needs an outgoing mail server, set in the same place (or on the last step of onboarding):
host, port, STARTTLS/TLS, credentials and a sender. The password is stored encrypted like every
other credential Kaname holds and is never shown again; the settings only say whether one is set.
**Send test email** and each channel's **Send test** try the real thing and report exactly what
the far end answered, and every channel shows when it last delivered or why it last failed.

Alert rules under **Monitoring** are evaluated every minute against the raw samples: a rule fires
when its condition has held for its whole duration (the worst sample in the window is what is
compared, so one quiet second cannot hide a sustained breach and one spike cannot fake one) and
resolves when the latest sample is back inside the line. A rule's own channel list narrows who is
told.

Webhooks receive a JSON body and, when the channel has a signing secret, `X-Kaname-Timestamp` and
`X-Kaname-Signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>">`. Delivery is deliberately
quiet: a server has to stay gone for the offline window before anyone hears about it, repeats are
collapsed (one message an hour for the same threat, one per threshold for a certificate, one per
release), and a channel that fails records the error rather than retrying into a queue.

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
Only one can be in flight: a second click, or the scheduler firing during a manual apply, is
answered with a conflict naming the run that is already running. If anything fails before the
handover, the snapshot is put back and the run says so.

While the host unit works, the panel shows its progress live — the pull, the restart, the health
wait — and says that it will be unreachable for about a minute; it reconnects on its own when the
control plane answers again. The unit writes a verdict beside its log (`picked_up`, then
`pull_failed`, `restart_failed` or `health_failed` if something went wrong, then `succeeded`,
`rolled_back` or `rollback_failed`), so a pull that fails before anything is stopped ends the run
as failed within seconds instead of leaving it "running" until the next reboot, and a unit that
never picks the request up is reported as such within two minutes. If the new build does not
answer its health check, that unit puts the snapshot back and restarts the previous version. A run
is filed as `succeeded` only once the new build is actually serving — not when it merely started
its migrations. The next boot judges the rest: a clean revert is filed as `rolled_back` with the
reason the unit recorded, but if migrations from the new version had already run it is filed as
`needs_attention` and says so, rather than quietly reporting a successful rollback onto a schema
the old build does not know.

What a release declares about itself lives in [`release.json`](release.json) at the repository
root — `breaking`, `destructive` (a migration that rewrites data), `security`, `adds_config` (the
configuration keys the new build needs) and `min_upgrade_from` — and the release workflow reads it
from the tag being published, so the facts the hard rule and the config merge depend on are
written by whoever wrote the change, not remembered at tag time. CI refuses a pull request that
adds a migration without touching that file, and the workflow resets it to defaults after every
release. The last manifest fetched is kept with the policy, so "update available" survives a
restart (and a rollback), a check that fails retries with backoff instead of waiting a whole
interval, and a scheduled apply the control plane had to refuse — no recent backup, say — is shown
on the Updates page with the reason rather than logged where nobody looks.

Agent updates are ordinary jobs, tracked per host. An agent that does not dial back in at the new
version within five minutes is filed as `needs_attention` and stays visible until a person
acknowledges it; one whose update was interrupted by a control-plane restart is settled the same
way rather than left "running". Prerelease versions order the way semver says (`rc.10` after
`rc.9`), and an agent whose version cannot be parsed is shown as unknown, never as up to date.

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
infra/                 compose files, Dockerfiles, kaname-host.sh (the host-side helper)
scripts/               verify.mjs, the dev-fleet launcher, the release-manifest builder
docs/                  agent protocol and design-system references
.github/workflows/     CI (pnpm verify + shellcheck) and the tagged release pipeline
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

**Beta.** 0.x, no tag pushed yet, and the images are published by CI on the first `v*` tag rather
than existing today.

**Never run on a real host.** Every host-touching file in the Linux provider is behind
`//go:build linux`; it compiles, cross-compiles, and its pure logic is unit-tested, but this was
built on Windows and that code has never executed. Everything demonstrable today runs through the
simulated provider. The installer likewise has no automated test beyond shellcheck.

**Scaffolding — present in the UI, not wired to a host:**

- Deployments record state but build, clone and copy nothing.
- FTP is panel-side only. The agent has no FTP verb, so no account is ever created, changed or
  removed on the host.
- Adding a mail domain records it and marks it active after reading the host's DKIM key; no
  Postfix or Dovecot configuration is written for it yet.
- DNS is implemented for Cloudflare and manual zones only, despite the wider provider list.
- sshd configuration changes arm a rollback timer on the agent with no way to confirm them, so a
  change made with the default window silently reverts.
- Agent certificates are valid 90 days and do not auto-rotate.
- Terminal recordings are never pruned. (Finished jobs and their logs, expired sessions and spent
  tokens are — after `JOB_RETENTION_DAYS` and `SESSION_RETENTION_DAYS`.)

**What is real**, and covered by the test suites plus an end-to-end Playwright run over four live
simulated agents: the three-tier boundary, enrollment and the RPC protocol, the job queue and its
worker, RBAC with per-server scoping, the audit chain, the mail DNS-authentication engine, the
terminal, onboarding, notification delivery (email, signed webhooks and Slack, with the throttling
that keeps them readable), stream flow control in both directions, and the update system's
decision logic.

## Licence

Not yet chosen. This is a studio-internal tool first; a licence will be attached before any
public release.
