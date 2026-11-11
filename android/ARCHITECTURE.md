# Kaname for Android — architecture

A native client for Kaname control planes ("Termius, but for Kaname"): save one or more
panels, sign in to each, see the fleet, open a server. Standalone Gradle project; it is
**not** part of the pnpm workspace.

## Build

```sh
cd android
# once per machine: point Gradle at an SDK (local.properties is gitignored)
echo "sdk.dir=/root/android-sdk" > local.properties   # or export ANDROID_HOME=/root/android-sdk
./gradlew assembleDebug testDebugUnitTest lint
```

- Toolchain: Gradle 8.14.3 (wrapper), AGP 8.13.2, Kotlin 2.2.21, JDK 17+ (21 works),
  compileSdk/targetSdk 36, minSdk 26. Versions live in `gradle/libs.versions.toml`.
- SDK packages used: `platforms;android-36`, `build-tools;35.0.0` / `36.0.0`, `platform-tools`.
- Debug APK: `app/build/outputs/apk/debug/app-debug.apk`.
- Lint aborts on errors; the remaining warnings are "newer version available" only.

### Live test against the dev stack

`LiveStackTest` is skipped unless `KANAME_LIVE_URL` is set. With `pnpm dev` + `pnpm dev:fleet`
running at the repo root:

```sh
KANAME_LIVE_URL=http://localhost:4000 ./gradlew testDebugUnitTest --tests '*LiveStackTest*'
```

It signs in with the dev seed owner, lists servers, mints a terminal ticket, opens the
WebSocket on the URL rebuilt by `PanelUrls`, waits for PTY bytes, and signs out.

On an emulator, the host's dev stack is `http://10.0.2.2:4000` (the control plane listens on
all interfaces in dev).

## Package layout (`app/src/main/java/io/ffstudios/kaname`)

```
KanameApp.kt / AppContainer.kt   manual DI: one AppContainer on the Application
MainActivity.kt                  single FragmentActivity (BiometricPrompt needs one), app-lock gate
navigation/
  Routes.kt                      every route string + builders
  KanameNavHost.kt               NavHost; global 401 → login redirect
core/api/                        no Android dependencies — unit-testable on the JVM
  KanameApiClient.kt             per-panel REST client: envelopes, errors, 401 event
  Endpoints.kt                   typed groups: AuthApi, FleetApi, JobsApi, TerminalApi
  Dtos.kt                        @Serializable mirrors of packages/contract (snake_case via @SerialName)
  ApiException.kt / ApiResult.kt error model (mirrors apps/web/lib/api.ts ApiError)
  PanelUrls.kt                   base-URL parsing, /api/v1 joining, terminal ws URL builder
  KanameJson.kt                  the one Json config (ignoreUnknownKeys, coerceInputValues)
core/auth/
  PanelSessions.kt               one OkHttp client + cookie jar per panel; sessionExpired flow
  AuthRepository.kt              login / TOTP / logout / probe → PanelStatus
core/storage/
  SecretCipher.kt                AES-256-GCM with an Android Keystore key
  CookieStorage.kt               encrypted per-panel cookie files (noBackupFilesDir/sessions)
  PersistentCookieJar.kt         OkHttp CookieJar; persists cookies that have an expiry
  PanelRepository.kt             saved panels + app settings (DataStore)
core/model/Panel.kt              a saved panel
feature/panels/                  home (panel cards) + add/edit
feature/login/                   email/password/remember, then TOTP or recovery code
feature/fleet/                   server list: search, pull-to-refresh, both status chips
feature/server/                  server header + tabs (Overview real, others placeholders)
feature/terminal/                placeholder screen
feature/settings/                app lock toggle (BiometricPrompt), AppLockController
ui/theme/                        palette from packages/ui/src/styles/tokens.css, dark + light
ui/components/                   ConnectionChip, HealthChip, badges, ErrorPanel, Format, VM helper
```

## Routes

| Route | Screen | Notes |
|---|---|---|
| `panels` | `PanelsScreen` | start destination |
| `panel/edit?panelId={panelId}` | `PanelEditScreen` | no arg = add |
| `login/{panelId}?expired={bool}` | `LoginScreen` | `expired=true` when bounced by a 401 |
| `fleet/{panelId}` | `FleetScreen` | |
| `server/{panelId}/{serverId}` | `ServerDetailScreen` | **server-detail agent** |
| `terminal/{panelId}/{serverId}` | `TerminalScreen` | **terminal agent** |
| `settings` | `SettingsScreen` | |

Build routes with `Routes.server(panelId, serverId)` etc.; never by hand. Arguments arrive in
the ViewModel's `SavedStateHandle` under `Routes.ARG_PANEL_ID` / `Routes.ARG_SERVER_ID`.

## Conventions

- **ViewModels**: `val vm = kanameViewModel { FooViewModel(it, createSavedStateHandle()) }` —
  `it` is the `AppContainer`. Load the panel with `container.panelRepository.get(panelId)`, then
  get APIs from `container.panelSessions` (`fleet(panel)`, `jobs(panel)`, `terminal(panel)`,
  or `client(panel)` for new groups).
- **New endpoints**: add a class next to `FleetApi` in `core/api/Endpoints.kt` (or a new file in
  `core/api/`) that calls `client.get / getPage / post / postForJob`, plus DTOs in `Dtos.kt`.
  Keep enum-ish wire values as `String` with a typed accessor (see `Server.connectionState`) so
  a new server-side value never breaks parsing. Add a fixture captured from the dev stack to
  `app/src/test/resources/fixtures/` and a parsing test.
- **Errors**: everything returns `ApiResult<T>`; render failures with `ErrorPanel(error)`,
  which shows message, remediation summary, copyable values, field errors and request id.
  `errorHeadline()` spells out 429 waits from `Retry-After`.
- **401**: any authenticated call that gets 401 emits on `PanelSessions.sessionExpired`; the nav
  host routes to `login/{panelId}?expired=true`. Use `allowUnauthenticated = true` only for
  auth probes.
- **Mutations that reach a host** return `202 {data:{job}}` → `client.postForJob(path)` gives the
  `Job`; poll `JobsApi.get(id)` (or a future SSE bridge) for progress.
- **Status**: reachability and health are separate axes. Always render `ConnectionChip` *and*
  `HealthChip`; never fold them into one indicator (docs/design-system.md §6).
- **Simulated hosts**: show `SimulatedBadge` when `server.simulated`.

## Extension points

### Server detail (services / containers / processes / jobs)

`feature/server/ServerDetailScreen.kt`:
- `ServerTab` enum lists the tabs; `ServerTabContent(tab, panelId, server)` is the single
  `when` that maps a tab to its composable — replace each `PlaceholderTab(...)` with a real
  tab, ideally in its own package (`feature/server/services/ServicesTab.kt` with its own
  ViewModel built from the same SavedStateHandle args).
- Endpoints to add (see apps/control-plane/src/routes): `services.ts`, `containers.ts`,
  `processes.ts` (never cached), `jobs.ts` (`JobsApi` exists already, `list(serverId=…)`).
  DTO shapes are in packages/contract/src/resources/fleet.ts (`service`, `container`,
  `processRow`) and jobs.ts.
- `ServerDetailViewModel.refresh()` reloads the header.

### Terminal

`feature/terminal/TerminalScreen.kt` is a placeholder with the plumbing documented in its KDoc:
- `container.panelSessions.terminal(panel).openSession(serverId, cols, rows)` →
  `TerminalApi.Opened(ticket, webSocketUrl)`. **Use `webSocketUrl`**, rebuilt from the panel's
  base URL by `PanelUrls.terminalWebSocketUrl`, not `ticket.wsUrl` (that one comes from the
  server's `KANAME_CLIENT_API_URL` and may name a host the phone can't reach).
- Connect right away with `container.panelSessions.client(panel).okHttp.newWebSocket(...)`:
  tickets are single-use, 30 s, IP-bound. The base client already sets a 25 s ping interval.
- Protocol (apps/control-plane/src/routes/terminal.ts): binary frames are raw PTY bytes in
  both directions; text frames are control, e.g. `{"t":"resize","cols":120,"rows":40}`.
- Terminals require a cookie user session; API keys are refused by the server.
- The open button on the server screen is visually muted when `!server.canOpenTerminal`
  (agent not connected/degraded) but still navigates; the terminal screen should show the
  server's `agent_offline` error if it occurs.

## Security model

- **Cookies**: whatever the server sets is kept (`kaname_session` over http,
  `__Host-kaname_session` over https) — nothing hard-codes the name. Cookies with an expiry
  ("Keep me signed in") are encrypted with AES-256-GCM using a non-exportable Android Keystore
  key, one file per panel, panel id as AAD, in `noBackupFilesDir`. Session cookies
  (`remember=false`) stay in memory only. Undecryptable files are deleted (fail closed).
- **TLS** is strict: system CAs only, no user CAs, no self-signed override. Plain `http://` is
  allowed for IP/LAN installs (the installer's default) and is badged **NOT ENCRYPTED**
  wherever the panel appears.
- **Backups** are disabled (`allowBackup=false`, data-extraction rules exclude everything).
- **App lock** (Settings): BiometricPrompt with `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`; relocks
  after 30 s in the background; toggling it requires authenticating.
- Passwords are never stored; only the last email per panel, for pre-fill.

## Known gaps

- No API-key mode (cookie login only, which the terminal requires anyway).
- Dashboard and metrics endpoints are wired (`FleetApi.dashboard()`, `serverMetrics()`) but
  returned as raw `JsonObject`; no screen uses them yet.
- No background polling / SSE; lists refresh on pull or on resume.
- Toolchain pinned to AGP 8.13 / compileSdk 36 to match the provided Gradle 8.14.3; moving to
  AGP 9 / API 37 is a separate upgrade.
