#!/bin/sh
# ==================================================================
# End to end: install.sh, then `kaname update`, against real containers.
#
#   sudo E2E_CP_IMAGE=<image> E2E_WEB_IMAGE=<image> sh scripts/updater-e2e.sh
#
# E2E_CP_IMAGE and E2E_WEB_IMAGE are the control-plane and web images
# built from this checkout. They are pushed to a registry on
# localhost:5000 under three releases a test manifest describes:
#
#   9.0.0       what install.sh installs
#   9.0.1       what `kaname update --yes` moves to (the panel path)
#   9.1.0-rc.1  a build whose control plane exits at once, so the host
#               unit rolls it back (destructive, on the beta channel)
#
# The manifest, install.sh and infra/ are served over HTTP on loopback
# as KANAME_SOURCE_URL. Run as root on a throwaway host with Docker and
# systemd (the CI runner). E2E_FAKE_SYSTEMD=1 stands in for systemd
# where it is not PID 1: systemctl becomes a no-op and a loop runs
# kaname-host.sh whenever a request appears, as the path unit would.
# E2E_LEGACY=<version> first installs that published release and moves
# it to 9.0.0 (a build without the server console: the direct path).
#
# Exits non-zero on the first assertion that fails. Everything it
# started is removed on exit, unless E2E_KEEP=1.
# ==================================================================
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${E2E_CP_IMAGE:?set E2E_CP_IMAGE to the control-plane image built from this checkout}"
: "${E2E_WEB_IMAGE:?set E2E_WEB_IMAGE to the web image built from this checkout}"

WORK="$(mktemp -d)"
chmod 0755 "$WORK"
SRC="$WORK/source"
DATA="$WORK/data"
REG="localhost:5000"
PORT=8765
SOURCE_URL="http://127.0.0.1:$PORT"
OLD=9.0.0 NEW=9.0.1 BROKEN=9.1.0-rc.1
API="http://127.0.0.1:4000"

PIDS=""
step() { printf '\n\033[1m### %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
pass() { printf '\033[32mok\033[0m   %s\n' "$*"; }

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- the last kaname logs"
    for f in "$DATA"/logs/update-*.log "$DATA"/updates/*.log "$WORK/path-unit.log"; do
      [ -f "$f" ] && { echo "== $f"; tail -n 60 "$f"; }
    done
    if [ -f "$DATA/docker-compose.yml" ]; then
      docker compose -p kaname -f "$DATA/docker-compose.yml" --env-file "$DATA/.env" ps -a || true
      docker compose -p kaname -f "$DATA/docker-compose.yml" --env-file "$DATA/.env" logs --tail 40 control-plane || true
    fi
  fi
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept: $WORK"
    exit "$status"
  fi
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  if [ -f "$DATA/docker-compose.yml" ]; then
    docker compose -p kaname -f "$DATA/docker-compose.yml" --env-file "$DATA/.env" down -v >/dev/null 2>&1 || true
  fi
  docker rm -fv kaname-e2e-registry >/dev/null 2>&1 || true
  if [ "${E2E_FAKE_SYSTEMD:-0}" = 1 ]; then
    rm -f /etc/systemd/system/kaname-update.service /etc/systemd/system/kaname-update.path
  fi
  rm -rf /usr/local/lib/kaname /usr/local/bin/kaname "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

health_version() {
  curl -fsS --max-time 5 "$API/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}
env_version() { sed -n 's/^KANAME_VERSION=//p' "$DATA/.env" | tail -n 1; }

# Runs `kaname` with the test's data root; leaves its status in RC.
kaname() {
  set +e
  KANAME_DATA_DIR="$DATA" /usr/local/bin/kaname "$@" </dev/null
  RC=$?
  set -e
  echo "(exit $RC)"
}

expect_rc() {
  [ "$RC" = "$1" ] || fail "$2: expected exit $1, got $RC"
  pass "$2 (exit $RC)"
}

# ------------------------------------------------------------------
step "registry and images"
docker rm -fv kaname-e2e-registry >/dev/null 2>&1 || true
docker run -d --name kaname-e2e-registry -p 127.0.0.1:5000:5000 "${E2E_REGISTRY_IMAGE:-registry:2}" >/dev/null
i=0
until curl -fsS "http://$REG/v2/" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail "the registry did not start"; sleep 1
done

push() {
  docker tag "$1" "$2"
  docker push -q "$2" >/dev/null
  docker rmi "$2" >/dev/null
}

for v in "$OLD" "$NEW"; do
  push "$E2E_CP_IMAGE" "$REG/kaname-control-plane:$v"
  push "$E2E_WEB_IMAGE" "$REG/kaname-web:$v"
done
printf 'FROM %s\nCMD ["node", "-e", "console.error(\\"e2e: this build never comes up\\"); process.exit(1)"]\n' "$E2E_CP_IMAGE" |
  docker build -q -t kaname-e2e/broken - >/dev/null
push kaname-e2e/broken "$REG/kaname-control-plane:$BROKEN"
push "$E2E_WEB_IMAGE" "$REG/kaname-web:$BROKEN"
if [ -n "${E2E_LEGACY:-}" ]; then
  # Published images: pulled, since a fresh runner has none of them.
  docker pull -q "ghcr.io/futureforge-studios/kaname-control-plane:$E2E_LEGACY"
  docker pull -q "ghcr.io/futureforge-studios/kaname-web:$E2E_LEGACY"
  push "ghcr.io/futureforge-studios/kaname-control-plane:$E2E_LEGACY" "$REG/kaname-control-plane:$E2E_LEGACY"
  push "ghcr.io/futureforge-studios/kaname-web:$E2E_LEGACY" "$REG/kaname-web:$E2E_LEGACY"
fi
pass "pushed $OLD, $NEW and $BROKEN to $REG"

# ------------------------------------------------------------------
step "the source: install.sh, infra/ and a manifest"
mkdir -p "$SRC/infra"
cp "$ROOT/install.sh" "$SRC/install.sh"
cp "$ROOT/infra/docker-compose.yml" "$ROOT/infra/kaname-host.sh" "$ROOT/infra/kaname.sh" "$SRC/infra/"

release() {
  # $1 version, $2 channel, $3 breaking, $4 destructive, $5 summary
  cat <<JSON
    {
      "version": "$1",
      "channel": "$2",
      "released_at": "2026-11-17T00:00:00.000Z",
      "breaking": $3,
      "security": false,
      "summary": "$5",
      "migrations": {
        "destructive": $4,
        "adds_config": [
          "KANAME_E2E_SECRET"
        ]
      },
      "artifacts": {
        "control_plane": "$REG/kaname-control-plane:$1",
        "web": "$REG/kaname-web:$1",
        "agent": {}
      }
    }
JSON
}
{
  echo '{'
  echo '  "schema": 1,'
  echo '  "releases": ['
  release "$BROKEN" beta false true "e2e: a build that never comes up."
  echo '    ,'
  release "$NEW" stable false false "e2e: the release kaname update moves to."
  echo '    ,'
  release "$OLD" stable false false "e2e: the release install.sh installs."
  if [ -n "${E2E_LEGACY:-}" ]; then
    echo '    ,'
    release "$E2E_LEGACY" stable false false "e2e: a published release, without the server console."
  fi
  echo '  ]'
  echo '}'
} >"$SRC/versions.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SRC/versions.json"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SRC" >"$WORK/http.log" 2>&1 &
PIDS="$PIDS $!"
i=0
until curl -fsS "$SOURCE_URL/versions.json" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail "the source server did not start"; sleep 1
done
pass "serving $SRC at $SOURCE_URL"

if [ "${E2E_FAKE_SYSTEMD:-0}" = 1 ]; then
  mkdir -p "$WORK/bin" /etc/systemd/system
  printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/systemctl"
  # What kaname-update.path does: run the helper when a request appears.
  cat >"$WORK/path-unit" <<UNIT
#!/bin/sh
while :; do
  if [ -f "$DATA/updates/queue/request.json" ]; then
    /usr/local/lib/kaname/kaname-host.sh apply "$DATA" >>"$WORK/path-unit.log" 2>&1 || true
  fi
  sleep 1
done
UNIT
  chmod 0755 "$WORK/bin/systemctl" "$WORK/path-unit"
  "$WORK/path-unit" &
  PIDS="$PIDS $!"
  PATH="$WORK/bin:$PATH"
  export PATH
  pass "standing in for systemd"
fi

install_kaname() {
  KANAME_SOURCE_URL="$SOURCE_URL" KANAME_REGISTRY="$REG" KANAME_DATA_DIR="$DATA" \
    sh "$SRC/install.sh" --control-plane-only --version="$1" --public-url=http://127.0.0.1 </dev/null
}

# ------------------------------------------------------------------
if [ -n "${E2E_LEGACY:-}" ]; then
  step "install $E2E_LEGACY, then the direct path to $OLD"
  install_kaname "$E2E_LEGACY"
  [ "$(health_version)" = "$E2E_LEGACY" ] || fail "$E2E_LEGACY is not answering after install"
  [ -x /usr/local/bin/kaname ] || fail "install.sh did not install /usr/local/bin/kaname"
  kaname update --version="$OLD"
  expect_rc 0 "$E2E_LEGACY → $OLD, from a build without the server console"
  [ "$(health_version)" = "$OLD" ] || fail "$OLD is not what answers"
  ls "$DATA"/rollback/host-*/db.sql.gz >/dev/null 2>&1 || fail "the direct path took no database dump"
  grep -q '^KANAME_E2E_SECRET=..*' "$DATA/.env" || fail "adds_config was not merged with a generated secret"
  pass "$OLD answering, dump taken, adds_config merged"
else
  step "install $OLD"
  install_kaname "$OLD"
  [ "$(health_version)" = "$OLD" ] || fail "$OLD is not answering after install"
  [ -x /usr/local/bin/kaname ] || fail "install.sh did not install /usr/local/bin/kaname"
  pass "$OLD answering, kaname installed"
fi

# ------------------------------------------------------------------
step "kaname update --check changes nothing"
before="$(cat "$DATA/.env")"
kaname update --check
expect_rc 10 "--check with an update available"
[ "$before" = "$(cat "$DATA/.env")" ] || fail "--check changed .env"
[ ! -e "$DATA/updates/queue/request.json" ] || fail "--check queued a request"
pass ".env untouched, nothing queued"

step "refusals"
kaname update --version="$BROKEN"
expect_rc 3 "a destructive release without --yes and no terminal"
kaname update --version=0.0.1
expect_rc 1 "a release that is not in the manifest"
kaname update --bogus
expect_rc 2 "an unknown option"

step "busy while a run is in flight"
mkdir -p "$DATA/updates"
printf 'picked_up\n' >"$DATA/updates/host-e2e-inflight.result"
: >"$DATA/updates/host-e2e-inflight.log"
kaname update --check
expect_rc 4 "--check with a run in flight"
rm -f "$DATA/updates/host-e2e-inflight.result" "$DATA/updates/host-e2e-inflight.log"

# ------------------------------------------------------------------
step "kaname update: $OLD → $NEW through the panel"
# The panel's own rule: no backup in the last 24 hours, no update.
kaname update --yes
expect_rc 3 "the panel refuses without a recent backup"
[ "$(env_version)" = "$OLD" ] || fail "a refused update changed .env"
kaname update --yes --skip-backup
expect_rc 0 "update to $NEW"
[ "$(health_version)" = "$NEW" ] || fail "$NEW is not what answers (got $(health_version))"
[ "$(env_version)" = "$NEW" ] || fail ".env is not pinned to $NEW"
pass "$NEW answering"

kaname update
expect_rc 0 "already up to date"

# ------------------------------------------------------------------
step "a build that never comes up, direct path: rolled back"
kaname update --version="$BROKEN" --yes --direct
expect_rc 5 "rolled back"
[ "$(health_version)" = "$NEW" ] || fail "$NEW is not answering after the rollback (got $(health_version))"
[ "$(env_version)" = "$NEW" ] || fail ".env was not put back to $NEW"
# Run ids are UTC stamps, so the glob ends with the newest.
for dump in "$DATA"/rollback/host-*/db.sql.gz; do :; done
gzip -t "$dump" || fail "the dump is not a valid gzip"
gzip -dc "$dump" | grep -q 'PostgreSQL database dump' || fail "the dump is not a pg_dump"
run="$(basename "$(dirname "$dump")")"
grep -qx rolled_back "$DATA/updates/$run.result" || fail "the run's verdict is not rolled_back"
pass "$NEW answering, verdict rolled_back, dump at $dump"

step "a build that never comes up, panel path: rolled back"
kaname update --version="$BROKEN" --yes --skip-backup
expect_rc 5 "rolled back"
[ "$(health_version)" = "$NEW" ] || fail "$NEW is not answering after the rollback"
[ "$(env_version)" = "$NEW" ] || fail ".env was not put back to $NEW"
pass "$NEW answering"

step "every run is in History"
# A verdict on the direct path is left a minute for the command
# following it; a restart makes the control plane look again now rather
# than on its next tick.
sleep 65
compose() { docker compose -p kaname -f "$DATA/docker-compose.yml" --env-file "$DATA/.env" "$@"; }
compose restart control-plane >/dev/null 2>&1
i=0
until [ "$(health_version)" = "$NEW" ]; do
  i=$((i + 1)); [ "$i" -lt 120 ] || fail "the control plane did not come back after a restart"; sleep 1
done
sql() { compose exec -T postgres psql -U kaname -d kaname -tAc "$1" | tr -d ' \r'; }
[ "$(sql "select status from update_runs where log like '%(run $run)%'")" = rolled_back ] ||
  fail "the direct run $run was not filed as rolled_back"
[ ! -e "$DATA/updates/$run.result" ] || fail "the direct run's files were left behind once filed"
want_ok=1
[ -z "${E2E_LEGACY:-}" ] || want_ok=2
by_console() { sql "select count(*) from update_runs where kind = 'control_plane' and started_by_name = 'server console' and status = '$1'"; }
[ "$(by_console succeeded)" = "$want_ok" ] || fail "expected $want_ok succeeded runs by the server console, got $(by_console succeeded)"
[ "$(by_console rolled_back)" = 2 ] || fail "expected 2 rolled_back runs by the server console, got $(by_console rolled_back)"
[ "$(sql "select count(*) from update_runs where status = 'running'")" = 0 ] || fail "a run was left running"
pass "$want_ok succeeded and 2 rolled back runs filed, started by the server console"

step "kaname version"
KANAME_DATA_DIR="$DATA" /usr/local/bin/kaname version

printf '\n\033[32mall updater end-to-end checks passed\033[0m\n'
