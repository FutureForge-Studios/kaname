# Kaname Desktop — frontend ⇄ Rust interface

Kaname Desktop is a Tauri v2 client, in the spirit of Termius, that keeps a list of Kaname
panels ("connections"), signs in to them, and lets you work with their fleet: browse servers,
start/stop/restart services and containers, follow jobs, and open terminal tabs.

It talks only to the control plane's public API (`/api/v1`), exactly as the browser does. It
never SSHes to a host and never talks to `kanamed` directly — that is the whole security model
of Kaname (see `PLAN.md` §1, `DECISIONS.md` KD-013), and the desktop client must not weaken it.

Layout:

```
apps/desktop/
  package.json, index.html, vite.config.ts, tsconfig.json   (frontend, Vite + React + TS)
  src/                                                         (frontend)
  src-tauri/                                                   (Rust, own Cargo project)
    Cargo.toml, tauri.conf.json, build.rs, capabilities/, icons/, src/
```

Vite dev server: `http://localhost:1420`. Build output: `apps/desktop/dist`.

All commands are invoked with `invoke(name, args)` from `@tauri-apps/api/core`. Argument keys
are camelCase on the JS side (Tauri's default conversion of snake_case Rust params). Every
command returns `Result<T, DesktopError>`; a rejected promise carries a `DesktopError`.

## Shared types (TypeScript view; Rust uses serde with `rename_all = "snake_case"` fields)

```ts
type AuthKind = "session" | "api_key";

interface Connection {
  id: string;                 // uuid v4, minted by Rust
  name: string;               // "Production panel"
  base_url: string;           // "https://panel.example.com" — origin only, no /api/v1
  auth_kind: AuthKind;
  email: string | null;       // remembered login email (session kind)
  color: string | null;       // accent for the sidebar dot, e.g. "#5B76F7"
  accept_invalid_certs: boolean; // for self-signed panels reached by IP
  created_at: string;         // ISO
  last_connected_at: string | null;
  has_credential: boolean;    // a session token or API key is stored in the OS keyring
}

interface ConnectionInput {
  id?: string;                // present = update
  name: string;
  base_url: string;
  auth_kind: AuthKind;
  email?: string | null;
  color?: string | null;
  accept_invalid_certs?: boolean;
  api_key?: string | null;    // only for auth_kind "api_key"; stored in keyring, never returned
}

interface DesktopError {
  code: string;               // Kaname API error code ("unauthenticated", "forbidden", ...) or
                              // a local one: "network", "tls", "not_found", "keyring", "invalid_input",
                              // "not_signed_in", "terminal_needs_user"
  message: string;
  status: number | null;      // HTTP status when it came from the panel
  remediation: { summary: string; actions: { label: string; href?: string; action?: string; copy?: string }[] } | null;
  fields?: Record<string, string>; // per-field messages from the panel's `validation_failed`; omitted when empty
}
// Further local codes: "storage" (connections.json unreadable/unwritable), "invalid_response"
// (non-JSON body, or a login with no session cookie). When the panel's error body cannot be read
// the code is derived from the HTTP status ("unavailable", "rate_limited", ...).

type LoginResult =
  | { status: "ok"; session: unknown }                 // body of GET /api/v1/auth/session
  | { status: "totp_required"; challenge: string };

interface ApiResponse<T = unknown> {
  status: number;             // HTTP status (2xx only — non-2xx rejects with DesktopError)
  data: T | null;             // the panel's `data` field (null for 204)
  meta: unknown | null;       // the panel's `meta` field
}

interface TerminalOpened {
  terminal_id: string;        // local id for this tab's socket
  server_id: string;
  server_name: string;
  container_name: string | null;
  recorded: boolean;
}

type TerminalEvent =
  | { kind: "data"; b64: string }        // raw PTY bytes, base64
  | { kind: "closed"; code: number | null; reason: string }
  | { kind: "error"; message: string };
```

## Commands

### Connections (stored in the app config dir as `connections.json`; secrets in OS keyring)

| command | args | returns |
| --- | --- | --- |
| `connections_list` | — | `Connection[]` |
| `connection_save` | `{ input: ConnectionInput }` | `Connection` |
| `connection_delete` | `{ id }` | `null` (also deletes its keyring entries and closes its terminals) |
| `connection_test` | `{ baseUrl, acceptInvalidCerts }` | `{ reachable: boolean, version: string \| null, setup_required: boolean }` — `setup_required` is `needs_onboarding` from `GET /api/v1/setup/state`, `version` comes from `GET /health`. Resolves `reachable: false` only when nothing answered; **rejects** with `tls` on a certificate problem and `not_found` when the address answers but is not a Kaname panel |

### Auth

| command | args | returns |
| --- | --- | --- |
| `auth_login` | `{ id, email, password, remember }` | `LoginResult` — `POST /api/v1/auth/login`; on success captures the session token from `Set-Cookie` (`kaname_session` or `__Host-kaname_session`), stores it in the keyring, and remembers `email` on the connection |
| `auth_totp` | `{ id, challenge, code }` | `LoginResult` — `POST /api/v1/auth/totp` |
| `auth_session` | `{ id }` | `unknown` — `GET /api/v1/auth/session` (works for both auth kinds); rejects `not_signed_in` if no credential |
| `auth_logout` | `{ id }` | `null` — `POST /api/v1/auth/logout` for sessions (best-effort), then forgets the stored token |

### Generic API proxy (the frontend drives every panel screen through this)

| command | args | returns |
| --- | --- | --- |
| `api_request` | `{ id, method, path, query?, body? }` | `ApiResponse` |

- `path` is relative to `/api/v1` and must start with `/` (e.g. `/servers`, `/services/abc/restart`).
  Rust rejects absolute URLs, `..` segments and paths outside `/api/v1` with `invalid_input`.
- `query` is `Record<string, string | number | boolean>`.
- Auth: `Authorization: Bearer <key>` for `api_key`, `Cookie: <name>=<token>` for `session`.
- A 401 from the panel clears the stored session token and rejects with `code: "unauthenticated"`
  so the UI can show the sign-in sheet.

### Terminal

| command | args | returns |
| --- | --- | --- |
| `terminal_open` | `{ id, serverId, cols, rows, user?, containerId?, onEvent: Channel<TerminalEvent> }` | `TerminalOpened` |
| `terminal_write` | `{ terminalId, b64 }` | `null` — sent as a **binary** WS frame |
| `terminal_resize` | `{ terminalId, cols, rows }` | `null` — sent as a **text** frame `{"t":"resize","cols":N,"rows":N}` |
| `terminal_close` | `{ terminalId }` | `null` — closes with 1000 "pane closed" |

`terminal_open` does `POST /api/v1/terminal/sessions { server_id, cols, rows, user?, container_id? }`,
gets `{ ticket, ws_url, ... }`, and dials `ws_url`. `ws_url` is built from the panel's
`clientApiUrl` and may point at a host the desktop cannot reach (e.g. an internal address);
Rust rebuilds it on the connection's `base_url` origin keeping the path and query, switching
`http→ws` / `https→wss`. Tickets are single-use, expire in 30 s and are bound to the caller's IP,
so open the socket immediately. Server output arrives as binary frames (forward as `data`).
Close codes 4400/4401/4403 mean the ticket was refused — surface the reason.

Terminals require a **user** session: the panel refuses API-key principals. With `auth_kind:
"api_key"` reject early with `code: "terminal_needs_user"`.

## Panel endpoints the UI uses (all via `api_request`)

See `PLAN.md` §4 and `apps/control-plane/src/routes/*.ts` for exact shapes; responses are
`{ data, meta? }`, lists take `?page=&per_page=&q=`. Mutations that reach a host return `202`
with `{ data: { job } }` — follow them with `GET /jobs/:id` polling.

- `GET /servers`, `GET /servers/:id`, `GET /servers/:id/metrics`
- `GET /services?server_id=` · `POST /services/:id/{start,stop,restart,reload}`
- `GET /containers?server_id=` · `POST /containers/:id/{start,stop,restart}`
- `GET /processes?server_id=`
- `GET /jobs?…`, `GET /jobs/:id`, `POST /jobs/:id/cancel`
- `GET /monitoring/overview`

## Behaviour notes (as implemented)

- `auth_login` with `remember: false` keeps the session in memory only; it is gone when the app quits.
- A successful login answers `{ status: "ok", user }` from the panel, so Rust follows up with
  `GET /auth/session` to fill `session`.
- Any response that rotates the session cookie replaces the stored token; a cleared cookie is forgotten.
- `auth_logout` on an `api_key` connection deletes the stored key. A 401 on an `api_key`
  connection does **not** delete it — only session tokens are cleared.
- Changing a connection's `base_url` drops its stored credentials and closes its terminals.
- Redirects are never followed, so a credential cannot leave the panel's origin.
- `terminal_close` on an already-closed terminal succeeds. A `TerminalEvent` of kind `error` is
  informational; only `closed` ends the session.
- Links open in the system browser through `tauri-plugin-opener`:
  `invoke("plugin:opener|open_url", { url })`.
