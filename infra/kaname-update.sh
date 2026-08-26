#!/bin/sh
# ==================================================================
# Kaname control-plane updater.
#
#   kaname-update.sh <data-dir>
#
# Started by kaname-update.path when the control plane writes
# <data-dir>/updates/queue/request.json. It runs on the HOST, not in a
# container, because the thing it restarts is the container the control
# plane runs in: a shell inside that container would be killed by its
# own `docker compose up` and would never reach the rollback below.
#
# The control plane has already done everything reversible before
# handing over — it snapshotted .env, added any new configuration keys
# and pinned the new image tags. This script pulls, restarts, checks,
# and puts the snapshot back if the new build does not answer.
# ==================================================================
set -eu

DATA_DIR="${1:-/etc/kaname}"
QUEUE="$DATA_DIR/updates/queue/request.json"
LOCAL_API="http://127.0.0.1:4000"
HEALTH_TIMEOUT=120

[ -f "$QUEUE" ] || exit 0

# One field per line, quoted values only. The request is written by the
# control plane, not by a user, and holds nothing but identifiers.
field() {
  tr ',' '\n' <"$QUEUE" | grep "\"$1\"" | head -n 1 | cut -d'"' -f4
}

RUN_ID="$(field run_id)"
TO_VERSION="$(field to_version)"
FROM_VERSION="$(field from_version)"
PROJECT="$(field project)"
SNAPSHOT_DIR="$(field snapshot_dir)"
LOG_FILE="$(field log_file)"

[ -n "$RUN_ID" ] || { echo "kaname-update: unreadable request" >&2; rm -f "$QUEUE"; exit 1; }
[ -n "$LOG_FILE" ] || LOG_FILE="$DATA_DIR/updates/$RUN_ID.log"

mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"
chmod 0600 "$LOG_FILE"

say() {
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"
}

compose() {
  docker compose -p "$PROJECT" -f "$DATA_DIR/docker-compose.yml" --env-file "$DATA_DIR/.env" "$@"
}

# The request is consumed immediately, so a crash below cannot leave a
# path unit re-triggering this in a loop.
rm -f "$QUEUE"

say "==> applying $TO_VERSION over $FROM_VERSION (run $RUN_ID)"

rollback() {
  say "!! $TO_VERSION did not come up"
  if [ -f "$SNAPSHOT_DIR/.env" ]; then
    say "--> restoring the configuration from $SNAPSHOT_DIR"
    cp "$SNAPSHOT_DIR/.env" "$DATA_DIR/.env"
    chmod 0600 "$DATA_DIR/.env"
    if compose up -d --wait control-plane web >>"$LOG_FILE" 2>&1; then
      say "!! rolled back to $FROM_VERSION"
    else
      say "!! the rollback to $FROM_VERSION did not come up either — this needs a person"
    fi
  else
    say "!! no snapshot at $SNAPSHOT_DIR; leaving the deployment as it is"
  fi
  exit 1
}

# 1. Pull first. Nothing is stopped yet, so a pull that fails costs
#    nothing but the time it took.
say "--> pulling images"
if ! compose pull control-plane web >>"$LOG_FILE" 2>&1; then
  say "!! could not pull the images for $TO_VERSION; nothing was stopped"
  rollback
fi

# 2. Restart. Compose waits for the health checks the project declares.
say "--> restarting"
if ! compose up -d --wait control-plane web >>"$LOG_FILE" 2>&1; then
  rollback
fi

# 3. Verify against the running control plane rather than trusting the
#    container's own health check.
say "--> waiting for the control plane to answer"
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -fsS "$LOCAL_API/health" >>"$LOG_FILE" 2>&1; then
    say ""
    say "==> $TO_VERSION is up and answering"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

say "!! no answer from $LOCAL_API/health after ${HEALTH_TIMEOUT}s"
rollback
