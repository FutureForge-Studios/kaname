# Kaname Desktop

A Tauri v2 desktop client for Kaname panels, in the spirit of Termius. It keeps a list of panels
("connections") and signs in to each one, with email, password and two-factor code or with an API
key. From there you can browse the fleet, start, stop and restart services and containers, follow
the jobs those actions create, and open terminal tabs on servers and containers.

It talks **only** to each panel's public `/api/v1`, exactly as the browser does. It has no SSH
client and never contacts `kanamed` directly, so the control plane remains the only way to reach a
host. Terminals use the panel's single-use, IP-bound tickets, are audited, and are recorded where
the panel records them.

The contract between the UI and the Rust side is [INTERFACE.md](INTERFACE.md).

## Develop

```bash
pnpm install
pnpm --filter @kaname/desktop dev          # UI only, in a browser, against an in-memory mock
cd apps/desktop && pnpm tauri dev          # the real app (needs a display)
```

The browser mock (`src/lib/mock.ts`) loads automatically outside Tauri. `?seed` starts with a
signed-in demo connection, and `?latency=N` sets the delay of each mocked call in milliseconds.

On Linux, Tauri needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev`. At
runtime it needs a Secret Service (GNOME Keyring or KWallet) for stored credentials. Without one,
saving a credential fails rather than falling back to plaintext.

## Check

```bash
pnpm --filter @kaname/desktop typecheck && pnpm --filter @kaname/desktop test && pnpm --filter @kaname/desktop build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```

CI runs both in the `desktop` job of `.github/workflows/ci.yml`.

## Release

Bump `version` in `src-tauri/tauri.conf.json`, then push a `desktop-v<version>` tag.
`.github/workflows/release-desktop.yml` builds installers for Linux, Windows and macOS into a draft
GitHub release. Builds are signed when the `APPLE_*` or `WINDOWS_CERTIFICATE*` secrets are set and
unsigned otherwise.
