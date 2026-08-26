# Kaname — Build Plan

> **要** — the keystone. The control plane for your infrastructure.

This document is the architecture and build plan for Kaname, derived from the context dossier.
Everything the dossier marked **fixed** is treated as a constraint. Everything else is decided
here, with the reasoning for non-obvious calls recorded in [DECISIONS.md](DECISIONS.md).

---

## 0. What this is

A self-hosted, single-tenant **control OS** for a small fleet of Linux servers, built for an
owner-operator (not a shared-hosting reseller). One panel for infrastructure, websites, files,
email, databases, security, backups, monitoring, logs and a terminal.

Non-goals (explicitly out of scope, so we do not drift):

- Multi-tenant reseller hierarchies, billing, quotas-as-a-product.
- Windows server management. Managed nodes are Linux (systemd) only.
- Being a PaaS. Kaname manages servers; Coolify-style app deploys are a thin `Deployments`
  module on top of git + a build command, not a Heroku clone.

### The one thing we must be better at than the competition

Every panel in the landscape section of the dossier that has had a serious CVE had the same
shape of bug: **the web tier could reach a root-level primitive directly** (the Docker socket,
`sudo` with a shell string, raw SQL as superuser, a PHP process running as root). Kaname's
answer is structural, not a hardening checklist:

- The control plane **never** executes anything on a managed host.
- The agent **never** accepts a shell string as an RPC parameter. Every RPC is a typed,
  enumerated verb with validated arguments. There is no `exec(cmd string)` in the RPC surface
  except the deliberately-scoped `pty.*` terminal, which is permission-gated, audited, and
  session-recorded.
- The agent listens on **no network port at all**. It dials out.

Everything else — density, keyboard-first UX, real RBAC — is product quality. That is the
security thesis.

---

## 1. Stack

| Tier                         | Choice                                                                                                          | Why (short — long form in DECISIONS.md)                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| UI                           | Next.js 15 (App Router) + React 19 + TypeScript                                                                 | Studio already runs Next; App Router gives us streaming lists and a real router for a ~40-route product.                                |
| UI styling                   | Tailwind CSS v4 (CSS-first `@theme`) + custom component kit                                                     | v4's `@theme` makes design tokens the single source of truth; no config-file drift.                                                     |
| UI charts                    | Hand-built SVG primitives in `@kaname/ui`                                                                       | Recharts/Chart.js fight the design system. ~400 LOC gets us exactly the calm charts we want.                                            |
| Terminal                     | `@xterm/xterm`                                                                                                  | Only serious browser terminal.                                                                                                          |
| Code/file editor             | CodeMirror 6                                                                                                    | A third of Monaco's weight, better fit for a dense panel.                                                                               |
| Icons                        | `lucide-react`                                                                                                  | One clean line family, consistent 16/20/24px.                                                                                           |
| Typefaces                    | Inter Variable (UI), JetBrains Mono (technical)                                                                 | Self-hosted via `@fontsource*`. No runtime CDN.                                                                                         |
| Control plane                | Node 22+ / TypeScript / Fastify 5                                                                               | Needs a long-lived process to hold agent WebSockets and run the job worker; Fastify's schema-first routing pairs with our Zod contract. |
| Database                     | PostgreSQL 16 (prod) / PGlite (dev)                                                                             | Same dialect both ways; dev needs zero install and no Docker.                                                                           |
| ORM / migrations             | Drizzle ORM + drizzle-kit                                                                                       | SQL-shaped, no query-engine binary, works over both drivers.                                                                            |
| Job queue                    | Postgres `SELECT ... FOR UPDATE SKIP LOCKED`                                                                    | One fewer daemon to self-host than Redis/BullMQ; our job rate is tens/minute, not thousands/second.                                     |
| Control plane to UI realtime | SSE for events/jobs, WebSocket for PTY only                                                                     | SSE reconnects for free and is one-way, which is all a job feed needs.                                                                  |
| Agent                        | **Go 1.22+**, single static binary `kanamed`                                                                    | ~12 MB static binary, no runtime on the managed box, first-class systemd/dbus + Docker SDK, trivial cross-compile from any dev machine. |
| Control plane to agent       | Agent-dialed **WSS + mTLS**, multiplexed typed RPC                                                              | No inbound port on managed hosts, works behind NAT/CGNAT, gives bidirectional streams (logs, PTY) on one connection.                    |
| Contract                     | Zod schemas in `@kaname/contract`, shared by UI + control plane; generated JSON Schema consumed by the Go agent | One definition of every payload; the Go side gets generated structs so drift is a build error.                                          |

### Repo layout

```
kaname/
├── apps/
│   ├── web/                 Next.js UI (the only thing a human talks to)
│   └── control-plane/       Fastify API + job worker + agent hub
├── packages/
│   ├── contract/            Zod: REST contract, agent RPC contract, shared enums
│   ├── db/                  Drizzle schema, migrations, seed, repositories
│   └── ui/                  Design tokens + shared component kit
├── agent/                   Go module: kanamed
│   ├── cmd/kanamed/
│   └── internal/{rpc,providers,enroll,pty,collect}
├── infra/                   docker-compose, systemd units, install.sh, caddy samples
├── docs/                    API reference, agent protocol, runbooks
├── PLAN.md
└── DECISIONS.md
```

pnpm workspaces + Turborepo for the TS side; the Go module is standalone and built by
`turbo run build --filter=agent` shelling out to `go build`.

---

## 2. Architecture

### 2.1 The three tiers

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser — apps/web (Next.js)                                    │
│  - Never holds a server credential. Never opens a socket to an   │
│    agent. Talks to exactly one origin: the control plane.        │
└───────────────┬──────────────────────────────────────────────────┘
                │  HTTPS (session cookie) · SSE /events · WS /pty
┌───────────────▼──────────────────────────────────────────────────┐
│  Control plane — apps/control-plane (Fastify)                    │
│  Owns: users, roles, sessions, API keys, audit chain, server     │
│  inventory, DNS/cert/site/mail/db state, job queue, agent hub.   │
│  Has no shell, no ssh client, no docker socket, no root.         │
│  Every server-touching mutation becomes a Job.                   │
└───────────────┬──────────────────────────────────────────────────┘
                │  WSS + mTLS, agent-initiated, multiplexed RPC
┌───────────────▼──────────────────────────────────────────────────┐
│  Agent — kanamed (Go), one per managed host, runs as root        │
│  The ONLY thing that touches systemd, the container socket,      │
│  package managers, nginx/dovecot/postfix config, the filesystem. │
│  Exposes a narrow versioned verb list. Binds no port.            │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Why the agent dials out

The dossier allows either a WireGuard mesh or an alternative mTLS tunnel. We chose
**agent-initiated WSS with mutual TLS**:

- Zero inbound firewall surface on a managed box — the attack surface of `kanamed` from the
  internet is literally nothing, because it never calls `listen()`.
- Works unchanged behind NAT, CGNAT, cloud security groups and residential links, which a
  WireGuard mesh only handles with extra endpoint/keepalive configuration per node.
- The connection we need is inherently long-lived and bidirectional (log tails, PTY, metric
  push). A single upgraded socket gives that; REST-over-WireGuard would need long-polling or a
  second channel.
- WireGuard remains a supported _deployment_ option (put the control plane on a WG address and
  the same mTLS applies) — it is just not a _requirement_.

### 2.3 Enrollment and identity

1. Operator creates a Server in the panel. The control plane mints a single-use enrollment
   token (`kn_enroll_...`, 15-minute TTL, bound to the server row).
2. Operator runs the printed one-liner on the box. `kanamed enroll --token ... --url ...`:
   - generates an EC P-256 keypair **on the host** (the private key never leaves it),
   - sends a CSR plus host fingerprint (machine-id, hostname, OS, arch) over TLS,
   - the control plane's internal CA signs a client cert with `CN=<server_id>`, 90-day validity.
3. Steady state: the agent dials `wss://panel/agent/v1/connect` with that client cert. The
   control plane pins `CN` to the server row. A short-lived bearer token (5 min, HMAC over
   `server_id|nonce|exp`, obtained from the mTLS-only `/agent/v1/token` endpoint) is attached
   per connection, so a stolen-but-revoked cert fails fast without CRL round-trips.
4. Certs auto-rotate at 2/3 of lifetime over the existing authenticated channel.
5. Revoking a server in the panel invalidates the cert serial; the hub drops the socket.

### 2.4 Agent RPC protocol (`kaname-agent.v1`)

One WebSocket, JSON frames (the envelope is versioned so the encoding can change later without
touching call sites).

```
-> req   { t:"req", id, method, params, deadline_ms }
<- res   { t:"res", id, ok:true,  result }
<- res   { t:"res", id, ok:false, error:{ code, message, detail? } }
<- chk   { t:"chk", id, seq, data }        // streaming responses (logs, downloads, PTY out)
-> chk   { t:"chk", id, seq, data }        // streaming requests (uploads, PTY in)
   end   { t:"end", id, ok, error? }
-> can   { t:"can", id }                   // cancellation
<- evt   { t:"evt", topic, data }          // unsolicited: metrics, state changes, threat events
   png   { t:"png", ts } / pog { t:"pog", ts }
<- hlo   { t:"hlo", agent_version, proto, capabilities:[...], host:{...} }
```

Rules baked into the implementation:

- **Every** method is an enumerated constant validated against a generated schema on both ends.
  There is no dynamic dispatch by string from user input.
- `capabilities` is how a host advertises what it can do (`mail`, `docker`, `podman`, `mysql`,
  `postgres`, `nginx`, `nftables`, ...). The UI greys out modules a host cannot serve rather
  than failing at call time.
- Deadlines are mandatory. The hub cancels in-flight calls on socket loss and fails their job.
- Backpressure: chunk streams are windowed (32 unacked chunks) so a `journalctl -f` on a chatty
  host cannot OOM the control plane.

Method namespaces (v1):

| Namespace   | Methods                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `system`    | `info`, `metrics`, `uptime`, `reboot`, `packages.list`, `packages.upgrade`                                                                |
| `service`   | `list`, `status`, `start`, `stop`, `restart`, `reload`, `enable`, `disable`, `logs`                                                       |
| `process`   | `list`, `tree`, `signal`                                                                                                                  |
| `container` | `list`, `inspect`, `start`, `stop`, `restart`, `remove`, `logs`, `exec`, `images.list`, `prune`                                           |
| `fs`        | `list`, `stat`, `read`, `write`, `mkdir`, `move`, `copy`, `remove`, `chmod`, `chown`, `archive`, `extract`, `download`, `upload`, `usage` |
| `site`      | `list`, `create`, `update`, `remove`, `reload`, `test_config`                                                                             |
| `cert`      | `list`, `issue`, `renew`, `revoke`, `install`                                                                                             |
| `dns`       | `resolve`, `zone.read` (authoritative writes go through the provider API from the control plane)                                          |
| `mail`      | `mailbox.*`, `alias.*`, `forwarder.*`, `dkim.read`, `queue.list`, `logs`                                                                  |
| `db`        | `instance.list`, `database.*`, `user.*`, `grant.*`, `size`, `dump`, `restore`                                                             |
| `fw`        | `list`, `apply`, `add`, `remove`, `status`, `ban`, `unban`, `bans.list`                                                                   |
| `ssh`       | `keys.list`, `keys.add`, `keys.remove`, `config.read`, `config.apply`, `sessions.list`                                                    |
| `backup`    | `run`, `restore`, `list`, `verify`, `prune`                                                                                               |
| `log`       | `sources`, `tail`                                                                                                                         |
| `pty`       | `open`, `write`, `resize`, `close`                                                                                                        |

### 2.5 Jobs: every mutation is async

Any action that crosses the network to a host is a `Job`. The UI never shows a
spinner-then-toast for these; it shows a **job status pill** that moves
`queued -> running -> succeeded | failed` (plus `cancelled`, `timed_out`), streams job log
lines, and links to the audit entry.

Worker loop (in-process in the control plane, safe to run on N replicas):

```sql
UPDATE jobs SET status='running', lease_until=now()+interval '60 seconds', attempt=attempt+1
WHERE id = (
  SELECT id FROM jobs
  WHERE status='queued' AND run_after <= now()
  ORDER BY priority DESC, created_at
  FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;
```

- Leases are renewed while the RPC is in flight; a crashed worker's job returns to `queued`
  when its lease expires.
- Retries are **opt-in per job type**. `service.restart` retries; `mailbox.create` does not.
  Idempotency is declared per type, never assumed.
- Jobs carry `correlation_id` so a UI action that fans out to five hosts is one row in the
  activity feed with five children.
- If the target server's agent is offline the job stays `queued` with reason `agent_offline`
  and is picked up on reconnect, bounded by `expires_at`.

### 2.6 Two independent status axes

The dossier calls this out and it drives the component kit:

- `AgentConnectionIndicator` — `connected` / `degraded` (stale heartbeat) / `disconnected` /
  `never_enrolled` / `revoked`. Answers _can we reach the box_.
- `HealthBadge` — `healthy` / `warning` / `critical` / `unknown`. Answers _is the box OK_.

A server can be `connected` + `critical` (disk full) or `disconnected` + `unknown`. Both are
always rendered; neither is ever collapsed into a single dot.

### 2.7 Audit: append-only and tamper-evident

`audit_events` is insert-only (enforced by a Postgres rule and a DB role without
`UPDATE`/`DELETE`). Each row stores `prev_hash` and `hash = sha256(prev_hash || canonical(row))`,
forming a chain per install. `kaname audit verify` walks it. Every mutation from every surface —
UI session, API key, terminal command, agent-initiated event — writes one, with actor, actor
type, source IP, target resource, before/after diff (secrets redacted) and the originating job.

---

## 3. Data model

Single-tenant: no `org_id`. All tables have `id uuid pk default gen_random_uuid()`,
`created_at`, `updated_at` unless noted.

**Identity and access**

- `users` — email, name, password_hash (argon2id), totp_secret_enc, totp_enabled, status, last_login_at
- `roles` — name, slug, description, is_system
- `permissions` — static seed of `module.resource:action` strings
- `role_grants` — role_id, permission, scope_kind (`global` | `servers`), scope_ids uuid[]
- `user_roles` — user_id, role_id
- `sessions` — user_id, token_hash, ip, user_agent, expires_at, revoked_at
- `api_keys` — name, prefix, secret_hash, scopes[], scope_kind/scope_ids, expires_at, last_used_at, created_by
- `audit_events` — ts, actor_type (`user`|`api_key`|`agent`|`system`), actor_id, action, target_type, target_id, server_id, ip, metadata, diff, job_id, prev_hash, hash

**Fleet**

- `servers` — name, hostname, address, provider, os, os_version, arch, kernel, agent_version, capabilities[], status, health, last_seen_at, enrolled_at, cert_serial, cert_expires_at, labels jsonb, notes
- `enrollment_tokens` — server_id, token_hash, expires_at, used_at
- `server_metrics` — server_id, ts, cpu_pct, mem_used, mem_total, swap_used, disk jsonb, net_rx, net_tx, load1/5/15, procs (90-day retention, 5-minute rollups)
- `services` — server_id, unit, description, load_state, active_state, sub_state, enabled, last_synced_at
- `containers` — server_id, container_id, name, image, image_id, state, status, ports jsonb, labels jsonb, created_at_host, last_synced_at
- `alert_rules` / `alerts` — metric, comparator, threshold, duration, scope, severity, channels; firing/resolved instances

**Websites**

- `sites` — server_id, name, webroot, runtime (`static`|`php`|`node`|`python`|`proxy`), runtime_version, status, primary_domain_id, config jsonb
- `domains` — name, site_id, server_id, dns_provider (`cloudflare`|`route53`|`manual`|...), dns_zone_id, proxied, status, registrar, expires_at
- `dns_records` — domain_id, type, name, content, ttl, priority, proxied, managed_by (`kaname`|`external`), external_id, last_synced_at, drift
- `certificates` — domain_id, subject, sans[], issuer, challenge (`http-01`|`dns-01`), key_type, issued_at, expires_at, auto_renew, status, last_renewal_job_id
- `deployments` — site_id, source (`git`|`upload`), repo_url, branch, commit_sha, commit_message, status, started_at, finished_at, duration_ms, triggered_by, job_id

**Files**

- `ftp_accounts` — server_id, username, protocol (`sftp`|`ftps`), home_dir, quota_bytes, used_bytes, status, ssh_key_id, last_login_at
- `storage_usage` — server_id, path, bytes, inodes, kind, sampled_at

**Email**

- `mail_domains` — domain_id, server_id, status, dkim_selector, dkim_public_key, catchall_target
- `mailboxes` — mail_domain_id, local_part, address, display_name, quota_bytes, used_bytes, status, last_login_at
- `mail_aliases` — mail_domain_id, address, destinations[], enabled
- `mail_forwarders` — mail_domain_id, source, destination, keep_copy, enabled
- `mail_auth_checks` — mail_domain_id, check, status (`pass`|`warn`|`fail`|`unknown`), expected, actual, remediation, checked_at
- `mail_log_entries` — server_id, ts, queue_id, from, to, status, relay, delay, dsn, message

**Databases**

- `db_instances` — server_id, engine (`mysql`|`mariadb`|`postgres`), version, host, port, status
- `db_databases` — instance_id, name, encoding, collation, owner, size_bytes, table_count
- `db_users` — instance_id, username, host_pattern, auth_plugin, status
- `db_grants` — database_id, db_user_id, privileges[], grant_option
- `db_credentials` — envelope-encrypted connection secrets

**Security**

- `firewall_rules` — server_id, priority, action, direction, protocol, port_spec, source_cidr, dest_cidr, comment, enabled, managed_by
- `threat_events` — server_id, kind, source_ip, source_country, target, attempts, first_seen, last_seen, action (`observed`|`banned`|`ignored`)
- `ip_blocks` — server_id (null = fleet-wide), cidr, reason, source (`manual`|`fail2ban`|`rule`), expires_at, created_by
- `ssh_keys` — name, public_key, fingerprint, type, user_id, server_ids[], added_at, last_used_at
- `ssh_config` — server_id, port, permit_root_login, password_auth, allow_users[], max_auth_tries, last_applied_at
- `ssh_sessions` — server_id, user, from_ip, tty, pid, started_at

**Backups**

- `backup_destinations` — name, kind (`s3`|`b2`|`sftp`|`local`), config_enc, status, last_checked_at, used_bytes
- `backup_schedules` — name, server_id, scope jsonb, cron, timezone, destination_id, retention jsonb, encryption, enabled, last_run_at, next_run_at
- `backup_runs` — schedule_id, server_id, trigger, status, bytes, files, started_at, finished_at, job_id, error
- `restore_points` — run_id, label, taken_at, bytes, manifest_ref, verified_at

**Platform**

- `jobs`, `job_logs` — as described in 2.5
- `settings` — key, value jsonb, updated_by
- `secrets` — envelope-encrypted blobs (AES-256-GCM, DEK per row, KEK from `KANAME_MASTER_KEY`)
- `notification_channels` — kind (`email`|`webhook`|`slack`), config_enc, events[]

---

## 4. API contract

Base: `/api/v1`. JSON only. Auth: `__Host-kaname_session` cookie (browser) or
`Authorization: Bearer kn_live_...` (API key). Every response is `{ data, meta? }` or
`{ error: { code, message, detail?, remediation? } }`.

**Conventions**

- List endpoints take `?q=&sort=&order=&page=&per_page=&filter[...]=` and return
  `meta: { page, per_page, total, has_more }`. Every list page in the UI maps 1:1 to this.
- Any mutation that reaches a host returns `202` with `{ data: { job } }`.
  Control-plane-only mutations return `200/201` with the resource.
- `POST /:resource/bulk` for bulk actions returns a parent job with children.
- Errors carry a machine `code` **and** a `remediation` object, so the UI can render
  "DNS record `_acme-challenge.example.com` not found — [Check DNS] [Retry]" rather than
  "something went wrong". Remediation actions are `{ label, href | action }` pairs.

**Surface** (one group per nav leaf)

```
/auth            login, logout, session, totp/{setup,verify,disable}, password
/me              profile, preferences, sessions, api-keys
/servers         CRUD · /:id/enroll-token · /:id/metrics · /:id/reboot · /:id/revoke
/services        ?server_id= · /:id/{start,stop,restart,reload,enable,disable,logs}
/processes       ?server_id= · /:id/signal
/containers      ?server_id= · /:id/{start,stop,restart,remove,logs,exec} · /images · /prune
/sites           CRUD · /:id/{reload,test-config,deployments}
/domains         CRUD · /:id/verify
/dns             ?domain_id= · CRUD · /sync · /validate
/certificates    CRUD · /:id/{issue,renew,revoke} · /expiring
/deployments     ?site_id= · POST trigger · /:id/{log,rollback}
/files           ?server_id=&path= · list/stat/read/write/mkdir/move/copy/delete/chmod/chown/archive/extract/upload/download
/ftp-accounts    CRUD · /:id/{reset-password,sessions}
/storage         ?server_id= usage breakdown
/mailboxes       CRUD · /:id/{reset-password,quota}
/mail-aliases    CRUD
/mail-forwarders CRUD
/mail-auth       ?domain_id= · /check · /:check/fix
/mail-logs       ?server_id= search + tail
/db-instances    list · /:id/{databases,users}
/databases       CRUD · /:id/{dump,restore,size}
/db-users        CRUD · /:id/grants
/firewall        CRUD · /apply · /status
/threats         list · /:ip/{ban,unban,ignore}
/ssh             /keys CRUD · /config · /sessions
/audit           list · /verify · /export
/backups         /destinations CRUD · /schedules CRUD · /runs · /restore-points · /:id/restore
/monitoring      /overview · /series?metric=&range= · /alerts · /alert-rules
/logs            /sources · /search · /tail (SSE)
/terminal        POST /sessions -> { ws_url, ticket } · WS /terminal/:ticket
/users /roles /permissions /api-keys /settings
/jobs            list · /:id · /:id/logs (SSE) · /:id/cancel
/events          SSE multiplexed feed (?topics=jobs,servers,threats,...)
/search          command palette backend: cross-resource search + actions
```

---

## 5. RBAC

Permissions are `module.resource:action` strings; roles are collections of **grants**, and a
grant is `(permission, scope)` where scope is `global` or an explicit server list. This is the
part several competitors do poorly (a single admin flag), so it is modelled properly from day
one.

Actions: `read`, `write`, `delete`, `exec`, `approve`.

```
infra.servers:{read,write,delete}      websites.sites:{read,write,delete}
infra.services:{read,exec}             websites.domains:{read,write,delete}
infra.processes:{read,exec}            websites.dns:{read,write,delete}
infra.containers:{read,exec,delete}    websites.ssl:{read,write,delete}
files.manager:{read,write,delete}      websites.deployments:{read,exec}
files.ftp:{read,write,delete}          email.mailboxes:{read,write,delete}
databases.mysql:{read,write,delete}    email.routing:{read,write,delete}
databases.postgres:{read,write,delete} email.auth:{read,exec}
security.firewall:{read,write}         email.logs:{read}
security.threats:{read,write}          backups.schedules:{read,write,delete}
security.ssh:{read,write}              backups.restore:{exec}
security.audit:{read}                  monitoring.metrics:{read}
terminal.session:{exec}                monitoring.alerts:{read,write}
admin.users:{read,write,delete}        logs.streams:{read}
admin.roles:{read,write,delete}        admin.api_keys:{read,write,delete}
admin.settings:{read,write}
```

System roles seeded: **Owner** (all, global, undeletable), **Operator** (everything except
`admin.*` and `backups.restore:exec`), **Developer** (sites/deployments/files/logs/databases on
scoped servers; no security, email or admin), **Auditor** (all `:read` plus
`security.audit:read`), **Viewer** (dashboard and monitoring read only).

Enforcement is a single Fastify `preHandler` that resolves `(actor, permission, server_id)` to
allow/deny, plus a UI-side `useCan()` that hides what you cannot do (defence in depth, never
the only check). API keys carry a subset of their creator's grants — never more.

---

## 6. Design system

### Tokens

Near-black, monochrome, one accent. **Accent: Keystone Indigo `#5B76F7`** (hue ~245 degrees).
It sits deliberately between Vercel azure and Linear violet — reads structural/instrument-panel,
not "AI product" — and does not collide with the semantic triad (green ok / amber warn / red
error), which matters more in an infrastructure panel than in a marketing app. Full reasoning
and the contrast math is in DECISIONS.md.

```
--kn-bg          #0B0C0E   canvas
--kn-surface     #111316   cards, tables
--kn-surface-2   #16191D   raised / hover
--kn-border      #22262C   hairlines
--kn-border-str  #2E333A   emphasized
--kn-text        #E7E9EC   primary
--kn-text-2      #9BA3AE   secondary
--kn-text-3      #6B7280   tertiary / disabled
--kn-accent-300  #A9B8FF
--kn-accent-400  #8AA0FF   links / icons on dark
--kn-accent-500  #5B76F7   brand, focus ring
--kn-accent-600  #4A63E0   primary fill (white text = 5.6:1)
--kn-accent-700  #3A4FBF   pressed
--kn-ok #3FB950   --kn-warn #D29922   --kn-danger #F85149   --kn-info #58A6FF
```

- **Spacing:** strict 4px grid (Tailwind default scale, no arbitrary values in components).
- **Radius:** `--kn-r-sm 6px`, `--kn-r-md 8px`, `--kn-r-lg 10px`. `9999px` **only** on status badges.
- **Type:** Inter Variable, 13/14px base for dense surfaces; JetBrains Mono for every IP, port,
  path, hash, unit name, log line and identifier. Tabular numerals on all metrics.
- **Motion:** 120–200 ms, `opacity`/`transform` only, `cubic-bezier(0.2,0,0,1)`. Everything
  respects `prefers-reduced-motion`.
- A light theme ships too (same token names, inverted values), but dark is the default and the
  design target.

### Component kit (`@kaname/ui`) — the whole product is built from these, no forks

Primitives: `Button` `IconButton` `Input` `Textarea` `Select` `Combobox` `Checkbox` `Radio`
`Switch` `Label` `FormField` `Kbd` `Badge` `StatusBadge` `Tag` `Avatar` `Tooltip` `Popover`
`DropdownMenu` `Dialog` `Drawer` `Tabs` `Accordion` `Separator` `ScrollArea` `Progress`
`Spinner` `Skeleton` `Toast`.

Product components: `DataTable` (search/filter/sort/paginate/bulk/row-actions/column-visibility/
sticky header/keyboard nav), `ResourceHeader`, `DetailLayout`, `PropertyList`, `EmptyState`,
`ErrorState` (code + remediation actions), `ConfirmDialog` (typed confirmation for destructive
ops), `JobStatusPill`, `JobDrawer`, `AgentConnectionIndicator`, `HealthBadge`, `MetricTile`,
`Sparkline`, `AreaChart`, `BarChart`, `TimeRangePicker`, `LogViewer` (virtualized, follow-tail,
level filter, regex search, pause), `Terminal`, `CodeEditor`, `FileTree`, `PathBreadcrumb`,
`CommandPalette`, `KeyboardShortcutsDialog`, `PageHeader`, `SectionCard`, `InlineEdit`,
`CopyButton`, `RelativeTime`, `ByteSize`, `Duration`.

Every list page ships: search, filter, sort, pagination, bulk actions, skeleton loading that
matches the real row shape, an empty state with the primary action, and a specific error state.

### Interaction

- `Cmd/Ctrl+K` command palette is first-class: searches servers, sites, domains, mailboxes,
  databases, containers, files, jobs and users — and exposes _actions_ (`restart nginx on
web-01`, `issue cert for example.com`), not just navigation.
- `g` then a letter jumps between sections; `/` focuses list search; `j`/`k` move rows;
  `Enter` opens; `x` selects; `?` opens the shortcut sheet. Full tab order and visible focus
  rings everywhere.
- Desktop-first; at or below 1024px the sidebar collapses to a drawer and tables become
  responsive stacks with row actions in an overflow menu.

---

## 7. Build order

Each phase leaves the tree green (`typecheck`, `lint`, `test`, `build`).

**Phase 0 — Foundation.** pnpm/turbo workspace, TS config, lint, `@kaname/contract` (all Zod
schemas + generated JSON Schema for Go), `@kaname/db` (full Drizzle schema + migrations + seed),
design tokens.

**Phase 1 — Control plane core.** Fastify bootstrap, config, logging, error envelope, auth
(argon2id, sessions, TOTP), RBAC middleware, audit chain, job table + worker, agent hub
(mTLS termination, enrollment, RPC multiplexer), SSE event bus, `/health`.

**Phase 2 — Agent.** Go module, RPC client + framing, enrollment, a provider interface with two
implementations: `linux` (real) and `sim` (deterministic fake fleet). Metrics collector,
systemd, processes, containers, fs, logs, PTY. The `sim` provider is not a toy — it is how the
whole product is developed and demoed on a machine without a Linux host, and how e2e tests run
in CI.

**Phase 3 — UI kit and shell.** `@kaname/ui`, app shell (sidebar, topbar, breadcrumbs, job
drawer, toasts), command palette, auth screens, Command Center.

**Phase 4 — Modules, in dependency order.**

1. Infrastructure (servers, services, processes, containers) — proves the whole job/agent path.
2. Monitoring, Logs, Terminal — proves streaming.
3. Files, FTP/SFTP, Storage.
4. Websites (sites, domains, DNS, SSL, deployments).
5. Email (mailboxes, aliases, forwarders, **DNS authentication**, mail logs).
6. Databases (MySQL/MariaDB and PostgreSQL).
7. Security (firewall, threats, SSH, audit).
8. Backups.
9. Administration (users, roles, API keys, settings).

**Phase 5 — Hardening.** e2e (Playwright) over the sim fleet, agent protocol conformance tests,
audit-chain verification test, RBAC matrix test, `install.sh` + systemd units + docker-compose,
docs.

### The mail DNS-authentication check (called out because it is where real setups break)

`mail_auth_checks` runs a named check list per mail domain, and each failure carries a human
remediation, not a raw record dump:

| Check            | Fails when                                                                                                           | Remediation shown                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mx`             | MX missing, points elsewhere, or the MX host has no A record                                                         | the exact MX record to add                                                                  |
| `host_spf`       | the **mail hostname** has no SPF TXT of its own, separate from the apex                                              | `mail.example.com. IN TXT "v=spf1 a -all"`                                                  |
| `spf`            | apex SPF missing, multiple SPF records, `?all`/`+all`, more than 10 lookups                                          | a merged record proposal                                                                    |
| `dkim`           | selector missing, key mismatch against the agent's local key, key under 1024-bit                                     | the exact selector TXT read from the host                                                   |
| `dmarc`          | missing, `p=none` with no `rua`, or a syntax error                                                                   | a staged policy proposal                                                                    |
| `ptr`            | reverse DNS missing or not matching HELO                                                                             | the value to set at the provider                                                            |
| `proxy_exposure` | the mail hostname resolves into a proxy/CDN range (e.g. Cloudflare orange-cloud) or is covered by a proxied wildcard | "set `mail.example.com` to DNS-only — proxying breaks SMTP and hides your real IP from SPF" |
| `tls`            | STARTTLS unavailable or the cert does not cover the HELO name                                                        | a cert issuance action                                                                      |

---

## 8. Dev and operations

- `pnpm dev` runs the control plane (tsx watch, PGlite at `.data/kaname`), Next.js, and
  `kanamed --simulate` with a seeded fake fleet — the entire product, no Docker, no Linux box,
  on Windows or macOS.
- `pnpm dev:pg` swaps PGlite for a real Postgres via `DATABASE_URL`.
- Production: one command — `curl -fsSL https://get.kaname.dev/install.sh | sudo sh` — which
  deploys the Compose project and pairs an agent on the same box. Further servers join with
  `... | sudo sh -s -- --agent-only --token=<pairing-token> --control-plane=<url>`. See section 9.
- Secrets: `KANAME_MASTER_KEY` (32-byte base64) is required at boot; the process refuses to
  start without it. All at-rest secrets are envelope-encrypted with per-row DEKs.
- Kaname backs itself up: the control plane's own Postgres is a first-class backup scope.

## 9. Lifecycle — install, first run, and updating itself

Three systems that only make sense together: a box goes from bare to running in one command, the
first person to open it becomes the owner and nobody else can, and the thing stays current
without an operator having to remember it exists.

### 9.1 Packaging

`install.sh` at the repo root is the only entry point. One constant, `KANAME_SOURCE_URL`, drives
every self-reference in it, so moving to `get.kaname.dev` is a one-line change. It fetches
exactly three files and prints each URL before fetching it.

| Piece                | Shipped as                                                              |
| -------------------- | ----------------------------------------------------------------------- |
| Control plane, panel | Container images, pinned by tag in `.env`                               |
| Postgres, Caddy      | Upstream images                                                         |
| Deployment           | `infra/docker-compose.yml` — no build context, so it works with no repo |
| Agent                | A static Go binary under systemd, served by the control plane itself    |
| Host updater         | `infra/kaname-update.sh` plus a systemd path unit                       |

Compose, not Kubernetes and not one big container: see [KD-027](DECISIONS.md#kd-027). The agent
is deliberately not containerised — its job is to manage the host, so containing it would mean
handing that container the privileges the architecture exists to avoid concentrating.

Modes: all-in-one by default (control plane plus an agent paired over loopback), with
`--control-plane-only` and `--agent-only --token=… --control-plane=…`. Re-running is a
reconfigure-and-repair pass; `--force` is the only thing that destroys anything, and it lists
what it is about to destroy first.

Secrets — the master key, the database password, the setup token — come from `openssl rand` on
the machine being installed. There is no default, placeholder or example credential anywhere in
the installer, the compose file or the images.

### 9.2 First run

Onboarding runs exactly once, and every guard is server-side. `bootstrap()` no longer invents an
owner account ([KD-031](DECISIONS.md#kd-031)); a fresh instance mints a one-time setup token,
which the installer prints and the control plane logs on every boot until an account exists.

Six screens, all driven by `GET /setup/state` rather than by client-side step state, so a closed
tab resumes where it left off:

1. **Check the install** — live control-plane and agent status. On an all-in-one install this is
   not skippable past a failed agent, server-side as well as in the UI.
2. **Create your account** — password strength evaluated by `assessPassword()` on the control
   plane. A long passphrase waives the composition rules but never the "do not reuse your own
   address" one.
3. **Name this instance** — one field.
4. **Confirm your first server** — shows the paired host with its real facts, or hands over a
   copyable one-liner and a waiting state that resolves itself over the event stream.
5. **Preferences** — update cadence, one notification channel, ACME address. Entirely skippable.
6. **Done** — into the Command Center, with a per-account nudge that never returns once closed.

After an owner exists, `/setup/token` and `/setup/owner` refuse outright; the rest require that
owner's session. `apps/web/middleware.ts` routes accordingly, but the API is the control.

### 9.3 Version manifest

`versions.json`, published alongside releases and validated by `releaseManifest` in
`@kaname/contract`. Per release: `version`, `channel`, `released_at`, `breaking`, `security`,
`summary`, `notes_url`, `min_upgrade_from`, `migrations.destructive`, `migrations.adds_config`,
and artifact references including a sha256 for every agent binary.

It is published data rather than something inferred from registry tags because tags cannot answer
the only question an unattended updater is actually asking — _is applying this without a human
safe_ ([KD-028](DECISIONS.md#kd-028)). `scripts/release-manifest.mjs` builds it and digests
whatever agent builds are present.

Four cadence tiers in Administration → Settings: `off`, `notify` (the default), `auto_minor`, and
`auto_all` — which cannot be reached without an explicit acknowledgement, enforced by the API and
not just by the dialog.

**The hard rule.** A release marked `breaking`, or whose migrations are marked `destructive`, is
never applied to the control plane without explicit confirmation, under every tier including
`auto_all`. `mayApplyUnattended()` is the single function that decides it, and it answers `false`
for those releases before it looks at the tier at all.

### 9.4 Applying and rolling back

The control plane cannot restart itself and still be there to judge the result, so it does not
try ([KD-030](DECISIONS.md#kd-030)). The sequence splits at the restart:

**While it is alive** — refuse unless confirmed or permitted; require a backup that succeeded in
the last 24 hours (skipping is allowed and audited); snapshot `.env`; add only the keys the
release declares in `adds_config`, generating real secrets for any that are obviously secrets;
pin the new image tags; record how many migrations the database has applied; write a pending
record; hand over.

**On the host** — `kaname-update.sh`, started by a systemd path unit: pull first so a failed pull
costs nothing, restart with `--wait`, verify `/health` directly, and on any failure restore the
snapshot and bring the previous version back.

**On the next boot** — `reconcile()` reads the pending record and the updater's log. Same version
as the target, `succeeded`. Back on the old version with the migration count unchanged,
`rolled_back`. Back on the old version with migrations that ran, `needs_attention`, naming what
happened — because restoring an image over a migrated schema silently is worse than saying so.

Agent updates are ordinary jobs, one per host, tracked as one `update_runs` row each. The agent
verifies the sha256 before the download is ever made executable, keeps the previous binary, and
reports only `restarting` — reconnecting at the new version is what the control plane counts as
success. A host that never comes back lands in `needs_attention` and stays visible until someone
acknowledges it.

---

## 10. Questions parked deliberately

- DNS providers at launch: Cloudflare plus manual. Route53/DigitalOcean sit behind the same
  `DnsProvider` interface and get added when needed.
- An MCP server over the API (Coolify shipped one): the REST contract is designed to be
  mechanically wrappable, but MCP is post-1.0.
- cPanel/Plesk import (Panelica ships this): the data model leaves room for it; not in v1.
