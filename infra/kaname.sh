#!/bin/sh
# ==================================================================
# kaname — the command on a Kaname host.
#
#   sudo kaname update [--version=<v>] [--yes] [--skip-backup] [--check] [--direct]
#   kaname version
#   kaname help
#
# `update` moves this host to a newer release the same way the panel's
# Updates page does, and works when the panel does not. Two paths:
#
#   panel   The control plane is answering and its image has the
#           server console (dist/cli.js). The update is started through
#           `docker compose exec` with the same apply the page calls —
#           same in-flight lock, same refusals, same run in History —
#           with "server console" as who started it.
#   direct  Anything else, or --direct. This script does what the panel
#           would have: checks the release, dumps the database, snapshots
#           .env, pins the new images and queues the request itself.
#
# Either way the restart is done by kaname-update.service, the same host
# unit the panel hands its updates to, and this script only follows the
# files that unit writes. Closing the SSH session cannot leave a restart
# half-done: the unit carries on, and running `kaname update` again
# re-attaches to the run in flight instead of starting another.
#
# Installed by install.sh as /usr/local/bin/kaname, on a fresh install
# and on every repair. Like install.sh it is meant to be read before it
# is run; it fetches only from KANAME_SOURCE_URL and the agent URL the
# release manifest names, and logs every URL first.
# ==================================================================
set -eu

LIB_DIR="${KANAME_LIB_DIR:-/usr/local/lib/kaname}"

# Where releases are read from: the environment, else the source this
# host was installed from, else upstream.
if [ -z "${KANAME_SOURCE_URL:-}" ] && [ -r "$LIB_DIR/source" ]; then
  KANAME_SOURCE_URL="$(head -n 1 "$LIB_DIR/source")"
fi
KANAME_SOURCE_URL="${KANAME_SOURCE_URL:-https://raw.githubusercontent.com/FutureForge-Studios/kaname/main}"
KANAME_SOURCE_URL="${KANAME_SOURCE_URL%/}"

DATA_DIR="${KANAME_DATA_DIR:-/etc/kaname}"
STATE_DIR="${KANAME_STATE_DIR:-/var/lib/kaname}"
BIN_DIR="${KANAME_BIN_DIR:-/usr/local/bin}"
KANAME_LOCAL_API="${KANAME_LOCAL_API:-http://127.0.0.1:4000}"

# The control-plane image runs as this uid; see install.sh.
KANAME_UID=10001

# An update pulls two images and, on the direct path, writes a database
# dump: refused below this much free space where either lands.
MIN_FREE_MB="${KANAME_MIN_FREE_MB:-2048}"
# The path unit fires within seconds; this long means it is not running.
PICKUP_TIMEOUT=120
# A run whose files have not changed for this long, with no helper
# running, is not in flight any more.
STALE_MINUTES=30
AGENT_RECONNECT_TIMEOUT=60

EXIT_OK=0
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_BUSY=4
EXIT_ROLLED_BACK=5
EXIT_ROLLBACK_FAILED=6
EXIT_AVAILABLE=10

usage() {
  cat <<'USAGE'
kaname — the command on a Kaname host

  sudo kaname update         Update this host to the newest release on its channel:
                             the control plane, the panel and the local agent.
    --version=<version>      That release instead. An older one also needs --yes.
    --yes                    Do not ask. Confirms a breaking or destructive release.
    --skip-backup            Panel path: go without the backup from the last 24 hours
                             the panel insists on (written to the audit trail).
                             Direct path: go without the database dump; never for a
                             release whose migration rewrites data.
    --check                  Say what would happen and change nothing.
    --direct                 Queue the update for the host unit directly, even when
                             the control plane is answering.
  kaname version             What this host is running.
  kaname help                This.

  Run `kaname update` again while an update is in flight and it follows that
  one instead of starting another; closing the session never stops one.

Exit status
  0   updated, or already up to date
  1   error
  2   usage
  3   refused: needs --yes, a release in between first, or a backup
  4   another update is in flight
  5   the update failed and was rolled back; the previous version is running
  6   the rollback failed as well; this needs a person
  10  --check only: an update is available

Environment
  KANAME_SOURCE_URL   where versions.json and these scripts come from
                      (default: the source this host was installed from)
  KANAME_THEME        light|dark, when the terminal's background cannot be detected
  NO_COLOR            plain output
USAGE
}

bad_usage() {
  echo "kaname: $*" >&2
  echo "Try: kaname help" >&2
  exit "$EXIT_USAGE"
}

CMD="${1:-help}"
[ $# -eq 0 ] || shift

REQ_VERSION="" YES=0 SKIP_BACKUP=0 CHECK=0 DIRECT=0
case "$CMD" in
  update)
    while [ $# -gt 0 ]; do
      case "$1" in
        --version) [ -n "${2:-}" ] || bad_usage "--version needs a value"; REQ_VERSION="$2"; shift ;;
        --version=*) REQ_VERSION="${1#*=}" ;;
        --yes|-y) YES=1 ;;
        --skip-backup) SKIP_BACKUP=1 ;;
        --check) CHECK=1 ;;
        --direct) DIRECT=1 ;;
        --help|-h) usage; exit 0 ;;
        *) bad_usage "unknown argument to update: $1" ;;
      esac
      shift
    done
    ;;
  version|--version|-V) CMD=version ;;
  help|--help|-h) usage; exit 0 ;;
  *) bad_usage "unknown command: $CMD" ;;
esac

LOG_FILE=""
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

UI_TITLE="Kaname update"
UI_ROLE="update"
UI_TAGLINE="Moves this server to a new release, and back if it does not come up."

# ---- kaname ui: begin ----
# ------------------------------------------------------------------
# Output. On a terminal each stage is one line, in the panel's colours:
#
#   ✓  03/11  Installing Docker Engine   already installed · v29.1.0   0.4s
#
# The mark on the left spins in the accent while the stage runs, the
# time on the right counts up, and the image pull draws a bar beneath
# its line. The detail behind every line goes to the install log.
# Piped, redirected, TERM=dumb or NO_COLOR set, the output is plain
# "==> ..." text, every line of it also in the log.
# ------------------------------------------------------------------
UI=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then UI=1; fi

# Light or dark background, so the palette below can match it:
# KANAME_THEME=light|dark if set, then COLORFGBG (rxvt, Konsole and
# friends), then the terminal itself, asked for its background colour
# (OSC 11) with half a second to answer. Dark when nothing answers.
detect_theme() {
  case "${KANAME_THEME:-}" in light|dark) echo "$KANAME_THEME"; return 0 ;; esac
  case "${COLORFGBG:-}" in
    *\;7|*\;15) echo light; return 0 ;;
    *\;[0-9]|*\;1[0-4]) echo dark; return 0 ;;
  esac
  _tty="$( { stty -g </dev/tty; } 2>/dev/null)" || { echo dark; return 0; }
  { stty -echo -icanon min 0 time 5 </dev/tty; } 2>/dev/null || { echo dark; return 0; }
  printf '%s]11;?%s' "$e" "$e\\" >/dev/tty
  _ans="$(dd bs=128 count=1 </dev/tty 2>/dev/null | tr -d '\033\007')" || _ans=""
  stty "$_tty" </dev/tty 2>/dev/null || true
  # "rgb:RRRR/GGGG/BBBB": the first two hex digits of each are enough.
  _rgb="$(printf '%s' "$_ans" |
    sed -n 's/.*rgb:\([0-9a-fA-F][0-9a-fA-F]\)[0-9a-fA-F]*\/\([0-9a-fA-F][0-9a-fA-F]\)[0-9a-fA-F]*\/\([0-9a-fA-F][0-9a-fA-F]\).*/\1 \2 \3/p')"
  if [ -n "$_rgb" ]; then
    # shellcheck disable=SC2086 # three words on purpose
    set -- $_rgb
    if [ $(( 0x$1 * 299 + 0x$2 * 587 + 0x$3 * 114 )) -gt 127500 ]; then echo light; return 0; fi
  fi
  echo dark
}

# The panel's tokens (packages/ui/src/styles/tokens.css), from its dark
# or its light (paper) theme: accent 400 for text, accent 500 for the
# bar, ok, warn, danger, text-3, and a track for the empty part of the
# bar. Exact on a 24-bit terminal, the nearest xterm-256 colour
# otherwise, and the basic eight on anything older.
C_RESET="" C_BOLD="" C_ACCENT="" C_FILL="" C_OK="" C_WARN="" C_DANGER="" C_MUTED="" C_TRACK=""
CLR="" UP="" HIDE_CURSOR="" SHOW_CURSOR=""
if [ "$UI" = 1 ]; then
  e="$(printf '\033')"
  case "${COLORTERM:-}:${TERM:-}" in
    truecolor:*|24bit:*) PALETTE=rgb ;;
    *256color*) PALETTE=256 ;;
    *) PALETTE=8 ;;
  esac
  # $1 r;g;b, $2 xterm-256 index, $3 basic SGR
  colour() {
    case "$PALETTE" in
      rgb) printf '%s[38;2;%sm' "$e" "$1" ;;
      256) printf '%s[38;5;%sm' "$e" "$2" ;;
      *) printf '%s[%sm' "$e" "$3" ;;
    esac
  }
  C_RESET="${e}[0m" C_BOLD="${e}[1m"
  if [ "$(detect_theme)" = light ]; then
    C_ACCENT="$(colour '106;62;232' 56 35)"
    C_FILL="$(colour '122;79;244' 99 35)"
    C_OK="$(colour '11;117;100' 29 32)"
    C_WARN="$(colour '143;83;0' 130 33)"
    C_DANGER="$(colour '196;43;60' 161 31)"
    C_MUTED="$(colour '107;107;116' 242 2)"
    C_TRACK="$(colour '214;211;204' 252 2)"
  else
    C_ACCENT="$(colour '169;141;248' 141 35)"
    C_FILL="$(colour '122;79;244' 99 35)"
    C_OK="$(colour '79;227;203' 79 36)"
    C_WARN="$(colour '251;177;60' 215 33)"
    C_DANGER="$(colour '244;91;105' 204 31)"
    C_MUTED="$(colour '142;141;139' 245 2)"
    C_TRACK="$(colour '58;58;66' 237 2)"
  fi
  CLR="${e}[2K" UP="${e}[1A" HIDE_CURSOR="${e}[?25l" SHOW_CURSOR="${e}[?25h"
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*)
    TICK="✓" CROSS="✗" SEP=" · " MARK="◆" RULE="─" BAR_ON="━" BAR_OFF="━"
    # The keystone (要, kaname) filling and emptying.
    FRAMES="◇ ◇ ◈ ◆ ◆ ◈" ;;
  *)
    TICK="+" CROSS="x" SEP=", " MARK="*" RULE="-" BAR_ON="=" BAR_OFF="-"
    FRAMES="| / - \\" ;;
esac

# Columns: "  M  NN/TT  <title>  <detail> <time>". The detail takes
# whatever the terminal has left, so a line never wraps (a wrapped line
# cannot be redrawn in place).
COLS="$( { stty size </dev/tty; } 2>/dev/null | cut -d' ' -f2)" || COLS=""
case "$COLS" in ''|*[!0-9]*) COLS=80 ;; esac
TITLE_W=25
DETAIL_W=$((COLS - 47))
[ "$DETAIL_W" -le 44 ] || DETAIL_W=44
[ "$DETAIL_W" -ge 8 ] || DETAIL_W=8
RULE_W=$((COLS - 4))
[ "$RULE_W" -le 72 ] || RULE_W=72

STEP_N=0 STEP_TOTAL=0 STEP_OPEN=0 STEP_T0=0 STEP_WARN="" SPIN_PID="" BAR_LINE=0
STEP_TITLE_F="" STEP_DETAIL_F="" BAR_STATE=""

to_log() { [ -n "$LOG_FILE" ] && printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG_FILE"; return 0; }
log()  { [ "$UI" = 1 ] || printf '%s\n' "$*"; to_log "$*"; }
say()  { printf '%s\n' "$*"; to_log "$*"; }

now_ms() {
  t="$(date +%s%N 2>/dev/null)" || t=""
  case "$t" in
    ''|*[!0-9]*) echo $(( $(date +%s) * 1000 )) ;;
    *) echo $(( t / 1000000 )) ;;
  esac
}
fmt_ms() { printf '%d.%ds' $(( $1 / 1000 )) $(( $1 % 1000 / 100 )); }

# $1 count, $2 character: the character $1 times.
repeat() {
  _r="" _i=0
  while [ "$_i" -lt "$1" ]; do _r="$_r$2"; _i=$((_i + 1)); done
  printf '%s' "$_r"
}

# $1 text, $2 width: exactly $2 columns, padded or cut. A text too long
# turns its " · " into ", " and drops any other non-ASCII before it is
# cut, so a cut can never land inside a multi-byte character.
fit() {
  _n="$(printf '%s' "$1" | wc -m | tr -d ' ')"
  if [ "$_n" -gt "$2" ]; then
    printf "%-$2.$2s" "$(printf '%s' "$1" | sed 's/ · /, /g' | LC_ALL=C tr -cd ' -~')"
  else
    printf "%s%$(( $2 - _n ))s" "$1" ""
  fi
}

# The stage's line into ROW. $1 mark (coloured), $2 time.
row_s() {
  ROW="$(printf '\r%s  %s  %s%02d/%02d%s  %s  %s%s %6s%s' "$CLR" "$1" \
    "$C_MUTED" "$STEP_N" "$STEP_TOTAL" "$C_RESET" "$STEP_TITLE_F" \
    "$C_MUTED" "$STEP_DETAIL_F" "$2" "$C_RESET")"
}
row() { row_s "$@"; printf '%s' "$ROW"; }

# The bar beneath the stage's line into BAR, aligned under the title,
# 30 cells. (Half cells were tried: a half-width glyph leaves a visible
# gap before the track.) $1 progress in tenths of a percent, $2 label.
bar_s() {
  _f=$(( $1 * 30 / 1000 ))
  BAR="$(printf '\r%s            %s%s%s%s%s  %s%3d%%%s  %s%s%s' "$CLR" \
    "$C_FILL" "$(repeat "$_f" "$BAR_ON")" "$C_TRACK" "$(repeat $((30 - _f)) "$BAR_OFF")" "$C_RESET" \
    "$C_ACCENT$C_BOLD" $(( $1 / 10 )) "$C_RESET" "$C_MUTED" "$2" "$C_RESET")"
}

# The spinner owns the terminal while a stage runs: it redraws the line
# (and, during the pull, the bar from BAR_STATE, which the pull writes)
# in one write per frame, so nothing else ever draws over it.
spin_start() {
  [ "$UI" = 1 ] || return 0
  (
    trap - EXIT INT TERM
    set -f
    _shown=0 _target=0 _ceil=0 _label=""
    # shellcheck disable=SC2086 # split into frames on purpose
    set -- $FRAMES
    while :; do
      for f in "$@"; do
        row_s "$C_ACCENT$f$C_RESET" "$(fmt_ms $(( $(now_ms) - STEP_T0 )))"
        if [ "$BAR_LINE" = 1 ]; then
          # A read that races the writer comes back empty; keep the last.
          IFS='|' read -r _p _c _l <"$BAR_STATE" 2>/dev/null || _p=""
          [ -z "$_p" ] || { _target="$_p" _ceil="$_c" _label="$_l"; }
          # Ease toward what the pull reported, then creep toward the
          # next layer's mark without reaching it; never backwards.
          if [ "$_shown" -lt "$_target" ]; then
            _d=$(( (_target - _shown) / 3 ))
            [ "$_d" -ge 10 ] || _d=10
            _shown=$(( _shown + _d ))
            [ "$_shown" -le "$_target" ] || _shown="$_target"
          elif [ "$_shown" -lt $(( _ceil - 15 )) ]; then
            _shown=$(( _shown + 1 ))
          fi
          bar_s "$_shown" "$_label"
          printf '%s%s\n%s' "$UP" "$ROW" "$BAR"
        else
          printf '%s' "$ROW"
        fi
        sleep 0.1 2>/dev/null || sleep 1
      done
    done
  ) 2>/dev/null &
  SPIN_PID=$!
}

spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  # A signal sent while the spinner is still starting up can be lost,
  # so it is asked until it is gone, and told after half a second.
  _k=0
  while kill "$SPIN_PID" 2>/dev/null; do
    _k=$((_k + 1))
    [ "$_k" -lt 10 ] || kill -9 "$SPIN_PID" 2>/dev/null || true
    sleep 0.05 2>/dev/null || sleep 1
  done
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
}

flush_warnings() {
  [ -n "$STEP_WARN" ] || return 0
  printf '%s' "$STEP_WARN" | while IFS= read -r w; do
    printf '             %s%s%s\n' "$C_WARN" "$w" "$C_RESET"
  done
  STEP_WARN=""
}

# Close the open stage with $1 as its mark.
step_close() {
  [ "$STEP_OPEN" = 1 ] || return 0
  STEP_OPEN=0
  [ "$UI" = 1 ] || return 0
  spin_stop
  if [ "$BAR_LINE" = 1 ]; then
    printf '\r%s%s' "$CLR" "$UP"
    BAR_LINE=0
    rm -f "$BAR_STATE"
  fi
  row "$1" "$(fmt_ms $(( $(now_ms) - STEP_T0 )))"
  printf '\n'
  flush_warnings
}

step_end() { step_close "$C_OK$TICK$C_RESET"; }

step() {
  step_end
  STEP_N=$((STEP_N + 1))
  STEP_OPEN=1
  STEP_T0="$(now_ms)"
  [ -n "$LOG_FILE" ] && printf '%s ==> %s\n' "$(date -u +%H:%M:%S)" "$1" >>"$LOG_FILE"
  if [ "$UI" = 1 ]; then
    STEP_TITLE_F="$(fit "$1" "$TITLE_W")"
    STEP_DETAIL_F="$(fit "" "$DETAIL_W")"
    spin_start
  else
    printf '\n==> %s\n' "$1"
  fi
}

# The short note shown beside the open stage, e.g. "v29.1.0".
detail() {
  to_log "    ($1)"
  [ "$UI" = 1 ] || return 0
  STEP_DETAIL_F="$(fit "$1" "$DETAIL_W")"
  # The spinner holds its own copy of the line; restart it to show this.
  if [ -n "$SPIN_PID" ]; then spin_stop; spin_start; fi
}

# Put a bar under the open stage, or ($1 percent, $2 label) move it.
bar_open() {
  [ "$UI" = 1 ] || return 0
  BAR_STATE="$(mktemp)"
  printf '0|0|%s\n' "$1" >"$BAR_STATE"
  spin_stop
  printf '\n'
  BAR_LINE=1
  spin_start
}
# $1 progress and $2 the most the next update can bring, both in tenths
# of a percent, $3 label.
bar_set() { [ -z "$BAR_STATE" ] || printf '%s|%s|%s\n' "$1" "$2" "$3" >"$BAR_STATE"; }

warn() {
  to_log "    !! $*"
  if [ "$UI" != 1 ]; then
    printf '    !! %s\n' "$*"
  elif [ "$STEP_OPEN" = 1 ]; then
    STEP_WARN="$STEP_WARN$*
"
  else
    printf '             %s%s%s\n' "$C_WARN" "$*" "$C_RESET"
  fi
}

die() {
  step_close "$C_DANGER$CROSS$C_RESET"
  printf '\n  %skaname:%s %s\n' "$C_DANGER$C_BOLD" "$C_RESET" "$*" >&2
  [ -n "$LOG_FILE" ] && printf 'FAILED %s\n' "$*" >>"$LOG_FILE"
  [ -n "$LOG_FILE" ] && printf '  %s%s%s\n' "$C_MUTED" "The full log is at $LOG_FILE" "$C_RESET" >&2
  exit "${DIE_STATUS:-1}"
}

# shellcheck disable=SC2329 # run by the EXIT trap
ui_cleanup() {
  spin_stop
  [ -z "$BAR_STATE" ] || rm -f "$BAR_STATE"
  [ "$UI" != 1 ] || printf '%s' "$SHOW_CURSOR"
}
trap ui_cleanup EXIT
trap 'exit 130' INT TERM

HEAD_MARK=""
[ "$UI" != 1 ] || HEAD_MARK="$MARK "

rule() { printf '  %s%s%s\n' "$C_TRACK" "$(repeat "$RULE_W" "$RULE")" "$C_RESET"; }

banner() {
  to_log "$UI_TITLE $STAMP, source $KANAME_SOURCE_URL"
  if [ "$UI" = 1 ]; then
    printf '%s\n' "$HIDE_CURSOR"
    printf '  %s%s%s %skaname%s  %s%s%s\n' "$C_ACCENT" "$MARK" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_MUTED" "$UI_ROLE" "$C_RESET"
    printf '  %s%s%s\n' "$C_MUTED" "$UI_TAGLINE" "$C_RESET"
    rule
    [ -z "$LOG_FILE" ] || kv "log" "$LOG_FILE"
    kv "source" "$KANAME_SOURCE_URL"
    printf '\n'
  else
    printf '%s\n' "$UI_TITLE — $STAMP" "Source: $KANAME_SOURCE_URL"
  fi
}

# A closing line: the accent mark and a bold sentence.
headline() {
  printf '\n'
  [ "$UI" != 1 ] || rule
  printf '  %s%s%s%s%s\n\n' "$C_ACCENT" "${HEAD_MARK:-}" "$C_RESET$C_BOLD" "$1" "$C_RESET"
  to_log "$1"
}

# A summary line: muted label, value. $3 colours the value. The log
# gets it plain.
kv() {
  printf '  %s%-12s%s %s%s%s\n' "$C_MUTED" "$1" "$C_RESET" "${3:-}" "$2" "$C_RESET"
  to_log "  $1  $2"
}
# ---- kaname ui: end ----

# Everything below is the `kaname` command's own.
WORK=""
FOLLOWING=0
FOLLOW_RUN=""
# Set while .env names a release no request has been queued for yet.
ENV_PINNED=0

trap 'ui_cleanup; [ -z "$WORK" ] || rm -rf "$WORK"' EXIT

# Ctrl-C while following leaves the update to the unit doing it.
# shellcheck disable=SC2329 # run by the INT, TERM and HUP traps
interrupted() {
  if [ "$ENV_PINNED" = 1 ]; then
    # Stopped between pinning and queueing: the next `compose up` would
    # otherwise apply a release nobody is going to health-check.
    rm -f "$QUEUE.partial"
    restore_env
    step_close "$C_DANGER$CROSS$C_RESET"
    printf '\n  %s\n' "Interrupted before the handover; $DATA_DIR/.env was put back."
  elif [ "$FOLLOWING" = 1 ]; then
    step_close "$C_WARN$MARK$C_RESET"
    printf '\n  %s\n' "Stopped following. The update carries on in kaname-update.service;"
    printf '  %s\n' "run \`sudo kaname update\` again to pick it back up."
    [ -z "$FOLLOW_RUN" ] || printf '  %s%s%s\n' "$C_MUTED" "run $FOLLOW_RUN" "$C_RESET"
  fi
  exit 130
}
trap interrupted INT TERM HUP

# die, with an exit status of its own.
die_with() {
  DIE_STATUS="$1"
  shift
  die "$@"
}

CURL="curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15"

nap() { sleep "$1" 2>/dev/null || sleep 1; }

compose() {
  docker compose -p "$PROJECT" -f "$DATA_DIR/docker-compose.yml" --env-file "$DATA_DIR/.env" "$@"
}

# One value out of the environment file; the last assignment wins, the
# way Compose reads it.
env_value() {
  sed -n "s/^$1=//p" "$DATA_DIR/.env" 2>/dev/null | tail -n 1
}

valid_version() {
  case "$1" in
    ""|*[!0-9A-Za-z.+-]*) return 1 ;;
  esac
  echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
}

# -1, 0 or 1, the way packages/contract orders releases: a prerelease
# sorts below its release, numeric identifiers compare as numbers (rc.10
# after rc.9), and something that is not a version sorts below everything.
vercmp() {
  awk -v a="$1" -v b="$2" '
    function parse(v, P,   i, c) {
      sub(/^v/, "", v); sub(/\+.*$/, "", v)
      P["pre"] = ""
      i = index(v, "-")
      if (i) { P["pre"] = substr(v, i + 1); v = substr(v, 1, i - 1) }
      if (v !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) return 0
      split(v, c, ".")
      P[1] = c[1] + 0; P[2] = c[2] + 0; P[3] = c[3] + 0
      return 1
    }
    function prerel(x, y,   X, Y, nx, ny, n, i, xn, yn) {
      nx = split(x, X, "."); ny = split(y, Y, ".")
      n = nx < ny ? nx : ny
      for (i = 1; i <= n; i++) {
        if (X[i] "" == Y[i] "") continue
        xn = (X[i] ~ /^[0-9]+$/); yn = (Y[i] ~ /^[0-9]+$/)
        if (xn && yn) return (X[i] + 0 < Y[i] + 0) ? -1 : 1
        if (xn != yn) return xn ? -1 : 1
        return (X[i] "" < Y[i] "") ? -1 : 1
      }
      if (nx == ny) return 0
      return nx < ny ? -1 : 1
    }
    BEGIN {
      okA = parse(a, A); okB = parse(b, B)
      if (!okA || !okB) { r = (okA == okB) ? 0 : (okA ? 1 : -1); print r; exit }
      for (k = 1; k <= 3; k++) if (A[k] != B[k]) { r = (A[k] < B[k]) ? -1 : 1; print r; exit }
      if (A["pre"] == B["pre"]) r = 0
      else if (A["pre"] == "") r = 1
      else if (B["pre"] == "") r = -1
      else r = prerel(A["pre"], B["pre"])
      print r
    }'
}

newer() { [ "$(vercmp "$1" "$2")" = 1 ]; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

free_mb() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'
}

# One field of a JSON line the server console printed.
json_field() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

# One field of a queued request: one key per line, quoted values only,
# the same reading kaname-host.sh does.
request_field() {
  tr ',' '\n' <"$1" 2>/dev/null | grep "\"$2\"" | head -n 1 | cut -d'"' -f4
}

# The last line of a result file, when it is a verdict.
verdict_of() {
  [ -f "$1" ] || return 0
  _v="$(grep -v '^$' "$1" 2>/dev/null | tail -n 1)" || _v=""
  case "$_v" in succeeded|rolled_back|rollback_failed) echo "$_v" ;; esac
}

reason_of() {
  [ -f "$1" ] || return 0
  grep -E '^(pull_failed|restart_failed|health_failed)$' "$1" 2>/dev/null | head -n 1 || true
}

# ------------------------------------------------------------------
# The release manifest
#
# versions.json as scripts/release-manifest.mjs writes it: one key per
# line, which is what lets awk stand in for a JSON parser on a host that
# may not have jq (install.sh reads it the same way). One tab-separated
# line per release:
#
#   1 version  2 channel  3 breaking  4 security  5 destructive
#   6 min_upgrade_from  7 control_plane image  8 web image
#   9 agent url  10 agent sha256 (this host's arch)  11 adds_config
#   12 notes_url  13 summary
# ------------------------------------------------------------------
parse_manifest() {
  awk -v arch="linux-$ARCH" '
    function val(line,   v) {
      v = line
      sub(/^[^:]*:[ \t]*/, "", v)
      sub(/,[ \t]*$/, "", v)
      if (v ~ /^"/) {
        v = substr(v, 2); sub(/"[ \t]*$/, "", v)
        gsub(/\\"/, "\"", v); gsub(/\\\\/, "\\", v)
      }
      gsub(/\t/, " ", v)
      return v
    }
    function emit() {
      if (ver != "")
        print ver "\t" ch "\t" brk "\t" sec "\t" des "\t" minf "\t" cp "\t" web "\t" aurl "\t" asha "\t" adds "\t" notes "\t" summ
      ver = ""
    }
    function reset() {
      ch = "stable"; brk = "false"; sec = "false"; des = "false"; minf = ""
      cp = ""; web = ""; aurl = ""; asha = ""; adds = ""; notes = ""; summ = ""
      agent = ""; inadds = 0
    }
    inadds {
      if ($0 ~ /\]/) { inadds = 0; next }
      v = $0; gsub(/[ \t",]/, "", v)
      if (v != "") adds = adds (adds == "" ? "" : " ") v
      next
    }
    /^[ \t]*"[A-Za-z0-9_-]+":/ {
      k = $0; sub(/^[ \t]*"/, "", k); sub(/".*$/, "", k)
      if (k == "version") { emit(); reset(); ver = val($0); next }
      if (ver == "") next
      if (k == "channel") ch = val($0)
      else if (k == "breaking") brk = val($0)
      else if (k == "security") sec = val($0)
      else if (k == "destructive") des = val($0)
      else if (k == "min_upgrade_from") minf = val($0)
      else if (k == "control_plane") cp = val($0)
      else if (k == "web") web = val($0)
      else if (k == "notes_url") notes = val($0)
      else if (k == "summary") summ = val($0)
      else if (k == "adds_config") {
        if ($0 ~ /\[.*\]/) {
          v = $0; sub(/^[^[]*\[/, "", v); sub(/\].*$/, "", v)
          gsub(/[ \t"]/, "", v); gsub(/,/, " ", v); adds = v
        } else inadds = 1
      }
      else if (k ~ /^linux-/) agent = k
      else if (k == "url" && agent == arch) aurl = val($0)
      else if (k == "sha256" && agent == arch) asha = val($0)
    }
    END { emit() }
  ' "$1"
}

# $1 version, $2 field number.
rel() {
  awk -F'\t' -v v="$1" -v n="$2" '$1 == v { print $n; exit }' "$RELEASES"
}

is_true() { [ "$1" = true ]; }

# Newest release this host may move to from $1 on its channel, the way
# the panel's selectUpgrade picks one: stable only unless the host runs
# a prerelease, and never past a release's min_upgrade_from. Sets TARGET
# (empty when up to date) and SKIPPED (a newer release that has to wait).
choose_default() {
  _cur="$1" TARGET="" SKIPPED=""
  _beta=0
  case "$_cur" in *-*) _beta=1 ;; esac
  # Three words per release; "-" stands for an empty field.
  awk -F'\t' '{ print $1, $2, ($6 == "" ? "-" : $6) }' "$RELEASES" >"$WORK/candidates"
  while read -r _v _ch _min; do
    [ "$_beta" = 1 ] || [ "$_ch" = stable ] || continue
    newer "$_v" "$_cur" || continue
    if [ "$_min" != "-" ] && newer "$_min" "$_cur"; then
      if [ -z "$SKIPPED" ] || newer "$_v" "$SKIPPED"; then SKIPPED="$_v"; fi
      continue
    fi
    if [ -z "$TARGET" ] || newer "$_v" "$TARGET"; then TARGET="$_v"; fi
  done <"$WORK/candidates"
  # A release that waits behind one this host can take is not news.
  if [ -n "$SKIPPED" ] && [ -n "$TARGET" ] && newer "$TARGET" "$SKIPPED"; then SKIPPED=""; fi
}

# ------------------------------------------------------------------
# Runs in flight
# ------------------------------------------------------------------
QUEUE="$DATA_DIR/updates/queue/request.json"

helper_running() {
  if command -v pgrep >/dev/null 2>&1 && pgrep -f 'kaname-host.sh apply' >/dev/null 2>&1; then
    return 0
  fi
  # A oneshot unit is "activating" for as long as it runs.
  case "$(systemctl show -p ActiveState --value kaname-update.service 2>/dev/null)" in
    active|activating|reloading) return 0 ;;
  esac
  return 1
}

# Sets INFLIGHT_RUN, INFLIGHT_LOG and INFLIGHT_RESULT to the run in
# flight, if there is one: a request not yet picked up, or a result with
# no verdict whose files are still moving (or whose helper is).
find_inflight() {
  INFLIGHT_RUN="" INFLIGHT_LOG="" INFLIGHT_RESULT=""
  if [ -f "$QUEUE" ]; then
    INFLIGHT_RUN="$(request_field "$QUEUE" run_id)"
    INFLIGHT_LOG="$(request_field "$QUEUE" log_file)"
    [ -n "$INFLIGHT_LOG" ] || INFLIGHT_LOG="$DATA_DIR/updates/${INFLIGHT_RUN:-host}.log"
    INFLIGHT_RESULT="$(dirname "$INFLIGHT_LOG")/$INFLIGHT_RUN.result"
    return 0
  fi
  for _r in "$DATA_DIR"/updates/*.result; do
    [ -f "$_r" ] || continue
    [ -z "$(verdict_of "$_r")" ] || continue
    _id="$(basename "$_r" .result)"
    _log="$DATA_DIR/updates/$_id.log"
    if helper_running || [ -n "$(find "$_r" "$_log" -mmin "-$STALE_MINUTES" 2>/dev/null)" ]; then
      INFLIGHT_RUN="$_id" INFLIGHT_LOG="$_log" INFLIGHT_RESULT="$_r"
      return 0
    fi
  done
  return 0
}

# ------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $(uname -m). Kaname publishes amd64 and arm64 builds only." ;;
  esac
}

agent_version() {
  [ -x "$BIN_DIR/kanamed" ] || return 0
  "$BIN_DIR/kanamed" version 2>/dev/null | awk '{ print $2; exit }'
}

health() { curl -fsS --max-time 5 "$KANAME_LOCAL_API/health" 2>/dev/null; }

# Free space where the images and the dump land.
check_space() {
  _docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || _docker_root=""
  _least=""
  for _dir in ${_docker_root:+"$_docker_root"} "$DATA_DIR"; do
    _free="$(free_mb "$_dir")"
    case "$_free" in ''|*[!0-9]*) warn "could not read the free space in $_dir"; continue ;; esac
    [ "$_free" -ge "$MIN_FREE_MB" ] ||
      die "only ${_free} MB free in $_dir; an update needs at least $MIN_FREE_MB MB there
for the new images and the database dump. Free some space and run this again
(docker image prune removes images nothing uses)."
    if [ -z "$_least" ] || [ "$_free" -lt "$_least" ]; then
      _least="$_free"
      FREE_DESC="$((_free / 1024)) GB free"
    fi
  done
}

check_host() {
  step "Checking this host"
  [ "$(id -u)" = 0 ] || die "run this as root: sudo kaname update"
  [ "$(uname -s)" = Linux ] || die "Kaname runs on Linux. This is $(uname -s)."
  detect_arch
  command -v curl >/dev/null 2>&1 || die "curl is required and is not installed."

  AGENT_CURRENT="$(agent_version)"
  FREE_DESC=""

  if [ "$MODE" = agent ]; then
    [ -n "$AGENT_CURRENT" ] || die "$BIN_DIR/kanamed does not report a version."
    PATH_KIND=agent INFLIGHT_RUN=""
    STEP_TOTAL=5
    detail "agent only${SEP}kanamed $AGENT_CURRENT"
    return 0
  fi

  command -v docker >/dev/null 2>&1 || die "docker is not installed, and this host runs Kaname in it."
  docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not answering.
Try: systemctl start docker"
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing."
  [ -f "$DATA_DIR/docker-compose.yml" ] ||
    die "$DATA_DIR/docker-compose.yml is missing. Re-run install.sh to repair this install."
  [ -x "$LIB_DIR/kaname-host.sh" ] ||
    die "$LIB_DIR/kaname-host.sh is missing. Re-run install.sh to repair this install;
it installs the unit that applies updates."
  systemctl is-active --quiet kaname-update.path 2>/dev/null ||
    die "kaname-update.path is not running, and it is what applies an update.
Try: systemctl enable --now kaname-update.path
Re-running install.sh puts it back as well."

  if [ "$CHECK" = 0 ]; then check_space; fi

  PANEL_UP=0 PANEL_CONSOLE=0 PANEL_VERSION=""
  if _h="$(health)"; then
    PANEL_UP=1
    PANEL_VERSION="$(printf '%s' "$_h" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    if compose exec -T control-plane test -f dist/cli.js >/dev/null 2>&1; then PANEL_CONSOLE=1; fi
  fi

  find_inflight

  # The path, and so the number of steps, is known from here on.
  CURRENT="$(env_value KANAME_VERSION)"
  DOWNGRADE=0
  if [ -n "$REQ_VERSION" ] && valid_version "${REQ_VERSION#v}" && valid_version "$CURRENT" &&
    newer "$CURRENT" "${REQ_VERSION#v}"; then
    DOWNGRADE=1
  fi
  choose_path
  _agent=0
  [ -z "$AGENT_CURRENT" ] || _agent=1
  if [ -n "$INFLIGHT_RUN" ]; then
    STEP_TOTAL=$((6 + _agent + 1))
  elif [ "$PATH_KIND" = panel ]; then
    STEP_TOTAL=$((3 + 4 + _agent + 1))
  else
    STEP_TOTAL=$((3 + 6 + _agent + 1))
  fi

  _panel="panel down"
  if [ "$PANEL_UP" = 1 ]; then _panel="panel up"; fi
  detail "$ARCH$SEP$_panel${FREE_DESC:+$SEP$FREE_DESC}"
}

# ------------------------------------------------------------------
# Choosing
# ------------------------------------------------------------------
# Fetches and parses the manifest; says why not in MANIFEST_ERROR.
load_manifest() {
  MANIFEST="$WORK/versions.json"
  RELEASES="$WORK/releases.tsv"
  MANIFEST_ERROR=""
  log "    fetching $KANAME_SOURCE_URL/versions.json"
  if ! $CURL "$KANAME_SOURCE_URL/versions.json" -o "$MANIFEST" 2>>"${LOG_FILE:-/dev/null}"; then
    MANIFEST_ERROR="could not download the release manifest from $KANAME_SOURCE_URL/versions.json."
    return 1
  fi
  if ! grep -q '"schema": *1' "$MANIFEST"; then
    MANIFEST_ERROR="$KANAME_SOURCE_URL/versions.json is not a release manifest this command understands."
    return 1
  fi
  parse_manifest "$MANIFEST" >"$RELEASES"
  if [ ! -s "$RELEASES" ]; then
    MANIFEST_ERROR="the release manifest at $KANAME_SOURCE_URL/versions.json lists no releases."
    return 1
  fi
  return 0
}

read_manifest() {
  step "Reading the manifest"
  load_manifest || die "$MANIFEST_ERROR"
  detail "$(wc -l <"$RELEASES" | tr -d ' ') releases"
}

choose_release() {
  step "Choosing the release"
  valid_version "$CURRENT" || die "this host's version is not a release number: '$CURRENT'."

  DOWNGRADE=0 SKIPPED=""
  if [ -n "$REQ_VERSION" ]; then
    REQ_VERSION="${REQ_VERSION#v}"
    [ -n "$(rel "$REQ_VERSION" 1)" ] ||
      die "release $REQ_VERSION is not in the manifest at $KANAME_SOURCE_URL/versions.json."
    TARGET="$REQ_VERSION"
    if [ "$TARGET" = "$CURRENT" ]; then TARGET=""; fi
    if [ -n "$TARGET" ] && newer "$CURRENT" "$TARGET"; then DOWNGRADE=1; fi
  elif [ "$MODE" = agent ] && cp_version_known; then
    # An agent is kept at the release its control plane runs, as the
    # panel's own fleet update does: newer than that is for --version.
    TARGET=""
    if newer "$CP_VERSION" "$CURRENT"; then TARGET="$CP_VERSION"; fi
  else
    choose_default "$CURRENT"
  fi

  if [ -z "$TARGET" ]; then
    detail "$CURRENT${SEP}up to date"
    return 0
  fi

  BREAKING="$(rel "$TARGET" 3)" SECURITY="$(rel "$TARGET" 4)" DESTRUCTIVE="$(rel "$TARGET" 5)"
  MIN_FROM="$(rel "$TARGET" 6)"
  if [ "$MODE" = cp ] && [ "$DOWNGRADE" = 0 ] && [ -n "$MIN_FROM" ] && newer "$MIN_FROM" "$CURRENT"; then
    die_with "$EXIT_REFUSED" "$TARGET cannot be applied directly from $CURRENT: it needs $MIN_FROM or later.
Update to $MIN_FROM first: sudo kaname update --version=$MIN_FROM"
  fi

  # The weightiest flag only; the release block below lists them all.
  _flag=""
  if [ "$DOWNGRADE" = 1 ]; then _flag="downgrade"
  elif is_true "$BREAKING"; then _flag="breaking"
  elif is_true "$DESTRUCTIVE"; then _flag="destructive"
  elif is_true "$SECURITY"; then _flag="security"
  fi
  detail "$CURRENT → $TARGET${_flag:+$SEP$_flag}"
}

# Agent-only host: the release its control plane runs, if that answers
# and is in the manifest. Leaves CP_VERSION.
cp_version_known() {
  CP_VERSION=""
  _url="$(agent_health_url)"
  [ -n "$_url" ] || return 1
  CP_VERSION="$(curl -fsS --max-time 10 "$_url" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" || CP_VERSION=""
  if [ -z "$CP_VERSION" ]; then
    warn "the control plane did not answer on $_url; choosing from the manifest alone"
    return 1
  fi
  if [ -z "$(rel "$CP_VERSION" 1)" ]; then
    warn "the control plane runs $CP_VERSION, which the manifest does not list"
    return 1
  fi
  log "    the control plane runs $CP_VERSION"
  return 0
}

# The path an update would take, and why.
choose_path() {
  PATH_KIND=direct PATH_WHY=""
  if [ "$MODE" = agent ]; then PATH_KIND=agent; return 0; fi
  if [ "$DIRECT" = 1 ]; then PATH_WHY="asked for with --direct"
  elif [ "$DOWNGRADE" = 1 ]; then PATH_WHY="the panel never applies an older release"
  elif [ "$PANEL_UP" = 0 ]; then PATH_WHY="the control plane is not answering"
  elif [ "$PANEL_CONSOLE" = 0 ]; then PATH_WHY="this control plane predates the server console"
  else PATH_KIND=panel PATH_WHY="the control plane is answering"
  fi
}

needs_confirmation() { is_true "$BREAKING" || is_true "$DESTRUCTIVE"; }

# Whether there is a person at a terminal to ask.
can_ask() {
  [ -t 0 ] && { : </dev/tty; } 2>/dev/null
}

# The release, before anything is changed.
show_release() {
  step_end
  printf '\n'
  _flags=""
  ! is_true "$BREAKING" || _flags="${_flags}${_flags:+$SEP}breaking"
  ! is_true "$DESTRUCTIVE" || _flags="${_flags}${_flags:+$SEP}destructive migration"
  ! is_true "$SECURITY" || _flags="${_flags}${_flags:+$SEP}security fix"
  [ "$DOWNGRADE" = 0 ] || _flags="${_flags}${_flags:+$SEP}downgrade"

  kv "release" "$CURRENT → $TARGET  ($(rel "$TARGET" 2))" "$C_BOLD"
  [ -z "$_flags" ] || kv "flags" "$_flags" "$C_WARN"
  _summary="$(rel "$TARGET" 13)"
  if [ -n "$_summary" ]; then
    _first=1
    printf '%s\n' "$_summary" | fold -s -w "$((RULE_W - 13))" | while IFS= read -r _line; do
      if [ "$_first" = 1 ]; then kv "summary" "$_line"; _first=0; else kv "" "$_line"; fi
    done
  fi
  _notes="$(rel "$TARGET" 12)"
  [ -z "$_notes" ] || kv "notes" "$_notes"
  if [ "$MODE" = cp ]; then
    kv "path" "$PATH_KIND${SEP}$PATH_WHY"
  fi
  _agent_to="$(rel "$TARGET" 1)"
  if [ "$MODE" = cp ] && [ -n "$AGENT_CURRENT" ] && [ "$AGENT_CURRENT" != "$_agent_to" ]; then
    kv "agent" "kanamed $AGENT_CURRENT → $_agent_to, once the update has succeeded"
  fi
}

# What --check reports would happen.
show_plan() {
  kv "would" "$1"
  shift
  for _line in "$@"; do kv "" "$_line"; done
}

confirm_release() {
  if [ "$DOWNGRADE" = 1 ]; then
    { [ -n "$REQ_VERSION" ] && [ "$YES" = 1 ]; } ||
      die_with "$EXIT_REFUSED" "$TARGET is older than $CURRENT. A downgrade runs the older build against a
database the newer one may have migrated; restoring the backup taken before
the upgrade is usually the safer way back. To do it anyway:
  sudo kaname update --version=$TARGET --yes"
    to_log "    downgrading from $CURRENT to $TARGET (--yes)"
  fi

  needs_confirmation || return 0
  [ "$YES" = 0 ] || return 0

  _what="breaking changes"
  if ! is_true "$BREAKING"; then _what="a migration that rewrites data"; fi
  if ! can_ask; then
    die_with "$EXIT_REFUSED" "$TARGET contains $_what and has to be confirmed.
Read the notes above, then re-run with --yes."
  fi
  printf '\n  %s%s contains %s.%s Apply it? [y/N] %s' "$C_WARN" "$TARGET" "$_what" "$C_RESET" "$SHOW_CURSOR" >/dev/tty
  _answer=""
  IFS= read -r _answer </dev/tty || _answer=""
  printf '%s\n' "$HIDE_CURSOR" >/dev/tty
  case "$_answer" in
    y|Y|yes|YES|Yes) to_log "    confirmed at the terminal" ;;
    *) die_with "$EXIT_REFUSED" "not confirmed; nothing was changed." ;;
  esac
}

# ------------------------------------------------------------------
# The direct path
# ------------------------------------------------------------------
psql_value() {
  compose exec -T postgres psql -U kaname -d kaname -tAc "$1" 2>>"$LOG_FILE" | tr -d ' \r' | head -n 1
}

backup_database() {
  step "Backing up the database"
  if [ "$SKIP_BACKUP" = 1 ]; then
    if is_true "$DESTRUCTIVE"; then
      warn "--skip-backup is ignored: $TARGET's migration rewrites data"
    else
      warn "no database dump (--skip-backup)"
      detail "skipped (--skip-backup)"
      MIGRATIONS_BEFORE="$(psql_value 'select count(*) from drizzle.__drizzle_migrations' || true)"
      return 0
    fi
  fi

  # The dump is taken from the database container, so it has to be up
  # even when the control plane is not. Its image does not change in an
  # update; starting it is safe.
  if [ -z "$(compose ps -q --status running postgres 2>/dev/null)" ]; then
    detail "starting postgres"
    compose up -d --wait postgres >>"$LOG_FILE" 2>&1 ||
      die_with "$EXIT_REFUSED" "the database container is not running and did not start, so no dump
could be taken. Nothing was changed. See $LOG_FILE."
  fi

  _bytes="$(psql_value "select pg_database_size('kaname')" || true)"
  case "$_bytes" in
    ''|*[!0-9]*) _bytes=0 ;;
  esac
  _need=$((_bytes / 1048576 + 256))
  _free="$(free_mb "$DATA_DIR")"
  case "$_free" in ''|*[!0-9]*) _free="$_need" ;; esac
  [ "$_free" -ge "$_need" ] ||
    die "the database is $((_bytes / 1048576)) MB and only $_free MB is free in $DATA_DIR."

  MIGRATIONS_BEFORE="$(psql_value 'select count(*) from drizzle.__drizzle_migrations' || true)"

  _dump="$SNAP/db.sql.gz"
  rm -f "$WORK/dump.failed"
  # --clean: the dump puts the schema back as it was, whatever a
  # migration from the new release did to it.
  { compose exec -T postgres pg_dump -U kaname -d kaname --clean --if-exists --no-owner 2>>"$LOG_FILE" ||
      : >"$WORK/dump.failed"; } | gzip -c >"$_dump.partial"
  if [ -f "$WORK/dump.failed" ] || ! gzip -t "$_dump.partial" 2>/dev/null ||
    ! gzip -dc "$_dump.partial" 2>/dev/null | head -c 4096 | grep -q 'PostgreSQL database dump'; then
    rm -f "$_dump.partial"
    die_with "$EXIT_REFUSED" "could not dump the database, so there would be no way back from a bad
migration. Nothing was changed. See $LOG_FILE.
(--skip-backup goes without it, except for a release whose migration rewrites data.)"
  fi
  chmod 0600 "$_dump.partial"
  mv "$_dump.partial" "$_dump"
  DUMP="$_dump"
  _size="$(du -k "$DUMP" | cut -f1)"
  log "    database dumped to $DUMP"
  if [ "$_size" -lt 1024 ]; then
    detail "db.sql.gz$SEP$_size KB"
  else
    detail "db.sql.gz$SEP$((_size / 1024)) MB"
  fi
}

# Adds the keys the release declares it needs, an existing value always
# winning (the panel's mergeEnv), and points the deployment at the new
# images (its setEnv). Written to a copy and renamed into place.
write_env() {
  _env="$DATA_DIR/.env"
  _tmp="$DATA_DIR/.env.kaname-update"
  cp "$_env" "$_tmp"
  ADDED=""
  for _key in $(rel "$TARGET" 11); do
    grep -q "^$_key=" "$_tmp" && continue
    _value=""
    case "$_key" in
      *_KEY|*_SECRET|*_PASSWORD|*_TOKEN)
        _value="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '\n')" ;;
    esac
    if [ -z "$ADDED" ]; then printf '\n# added by the upgrade to %s\n' "$TARGET" >>"$_tmp"; fi
    printf '%s=%s\n' "$_key" "$_value" >>"$_tmp"
    ADDED="${ADDED:+$ADDED }$_key"
  done

  awk -v ver="$TARGET" -v cp="$(rel "$TARGET" 7)" -v web="$(rel "$TARGET" 8)" '
    BEGIN { want["KANAME_VERSION"] = ver; want["KANAME_IMAGE_CONTROL_PLANE"] = cp; want["KANAME_IMAGE_WEB"] = web }
    {
      k = $0; sub(/=.*/, "", k)
      if ((k in want) && index($0, "=")) { print k "=" want[k]; done[k] = 1; next }
      print
    }
    END { for (k in want) if (!(k in done)) print k "=" want[k] }
  ' "$_tmp" >"$_tmp.pinned"
  mv "$_tmp.pinned" "$_tmp"
  chmod 0660 "$_tmp"
  chown "root:$KANAME_UID" "$_tmp" 2>/dev/null || true
  mv "$_tmp" "$_env"
}

restore_env() {
  [ -f "$SNAP/.env" ] || return 0
  cp "$SNAP/.env" "$DATA_DIR/.env.kaname-update"
  chmod 0660 "$DATA_DIR/.env.kaname-update"
  chown "root:$KANAME_UID" "$DATA_DIR/.env.kaname-update" 2>/dev/null || true
  mv "$DATA_DIR/.env.kaname-update" "$DATA_DIR/.env"
}

snapshot_settings() {
  step "Snapshotting settings"
  [ -n "$(rel "$TARGET" 7)" ] && [ -n "$(rel "$TARGET" 8)" ] ||
    die "the manifest names no images for $TARGET."
  cp "$DATA_DIR/.env" "$SNAP/.env"
  chmod 0600 "$SNAP/.env"

  # Read by the control plane when it files this run into History: the
  # directory is shared with its uid, the dump and .env are not.
  _breaking=false
  if needs_confirmation; then _breaking=true; fi
  printf '{\n  "version": "%s",\n  "to_version": "%s",\n  "breaking": %s,\n  "migrations_before": %s,\n  "taken_at": "%s",\n  "started_by": "server console"\n}\n' \
    "$CURRENT" "$TARGET" "$_breaking" "${MIGRATIONS_BEFORE:-null}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$SNAP/images.json"
  chmod 0640 "$SNAP/images.json"
  chown "root:$KANAME_UID" "$SNAP/images.json" 2>/dev/null || true

  ENV_PINNED=1
  if ! write_env; then
    restore_env
    ENV_PINNED=0
    die "could not write the new settings into $DATA_DIR/.env; it was put back."
  fi
  log "    snapshot in $SNAP; pinned $TARGET"
  if [ -n "$ADDED" ]; then
    log "    added $ADDED"
    detail "pinned $TARGET${SEP}added $(echo "$ADDED" | wc -w | tr -d ' ') key(s)"
  else
    detail "pinned $TARGET"
  fi
}

# Hands the request to kaname-update.path, exactly as the panel's
# dispatcher does: a temporary name, renamed, readable by root alone.
handover_direct() {
  step "Handing over"
  if [ -f "$QUEUE" ]; then
    restore_env
    ENV_PINNED=0
    die_with "$EXIT_BUSY" "another update was queued while this one was being prepared; .env was put back.
Run \`sudo kaname update\` again to follow it."
  fi
  RUN_LOG="$DATA_DIR/updates/$RUN_ID.log"
  RUN_RESULT="$DATA_DIR/updates/$RUN_ID.result"
  mkdir -p "$DATA_DIR/updates/queue"
  (
    umask 077
    printf '{\n  "kind": "update",\n  "run_id": "%s",\n  "from_version": "%s",\n  "to_version": "%s",\n  "project": "%s",\n  "data_dir": "%s",\n  "snapshot_dir": "%s",\n  "log_file": "%s",\n  "images": {\n    "control_plane": "%s",\n    "web": "%s"\n  }\n}\n' \
      "$RUN_ID" "$CURRENT" "$TARGET" "$PROJECT" "$DATA_DIR" "$SNAP" "$RUN_LOG" \
      "$(rel "$TARGET" 7)" "$(rel "$TARGET" 8)" >"$QUEUE.partial"
  ) || { restore_env; ENV_PINNED=0; die "could not write $QUEUE; .env was put back."; }
  mv "$QUEUE.partial" "$QUEUE"
  ENV_PINNED=0
  log "    queued $QUEUE (run $RUN_ID)"
  detail "queued for kaname-update.service"

  # Picked up when the unit consumes the request. One that never fires
  # is taken back, and .env with it, so a unit that wakes up later
  # cannot apply an update nobody is watching.
  _i=0
  while [ -f "$QUEUE" ]; do
    if [ "$_i" -ge $((PICKUP_TIMEOUT * 5)) ]; then
      if mv "$QUEUE" "$QUEUE.withdrawn" 2>/dev/null; then
        rm -f "$QUEUE.withdrawn"
        restore_env
        die "kaname-update.service never picked the request up, so nothing was applied
and .env was put back. Check:
  systemctl status kaname-update.path kaname-update.service"
      fi
      break
    fi
    _i=$((_i + 1))
    nap 0.2
  done
  detail "picked up by the host unit"
}

# ------------------------------------------------------------------
# The panel path
# ------------------------------------------------------------------
handover_panel() {
  step "Handing over to the panel"
  _out="$WORK/console.out" _err="$WORK/console.err"
  set -- update "--to=$TARGET" --actor=host --manifest=-
  if needs_confirmation; then set -- "$@" --confirm-breaking; fi
  if [ "$SKIP_BACKUP" = 1 ]; then set -- "$@" --skip-backup; fi
  log "    docker compose exec control-plane node dist/cli.js $*"

  # It stays behind after this command exits and follows the host unit
  # from inside the container, the way the panel's own process does, so
  # it must not die with this session.
  _nohup=""
  if command -v nohup >/dev/null 2>&1; then _nohup="nohup"; fi
  $_nohup docker compose -p "$PROJECT" -f "$DATA_DIR/docker-compose.yml" --env-file "$DATA_DIR/.env" \
    exec -T control-plane node dist/cli.js "$@" <"$MANIFEST" >"$_out" 2>"$_err" &
  _pid=$!

  _i=0
  while ! grep -q . "$_out" 2>/dev/null; do
    kill -0 "$_pid" 2>/dev/null || break
    [ "$_i" -lt 600 ] || break
    _i=$((_i + 1))
    nap 0.2
  done
  nap 0.1
  _answer="$(head -n 1 "$_out" 2>/dev/null || true)"
  cat "$_err" >>"$LOG_FILE" 2>/dev/null || true
  to_log "    console: $_answer"

  _code="$(json_field "$_answer" code)"
  _message="$(json_field "$_answer" message)"
  _remedy="$(json_field "$_answer" remediation)"
  case "$_code" in
    handed_over)
      RUN_ID="$(json_field "$_answer" run_id)"
      RUN_LOG="$(json_field "$_answer" log_file)"
      RUN_RESULT="$(json_field "$_answer" result_file)"
      [ -n "$RUN_ID" ] && [ -n "$RUN_LOG" ] || die "the server console answered without a run: $_answer"
      log "    run $RUN_ID"
      detail "run ${RUN_ID%%-*}"
      ;;
    up_to_date)
      die "the control plane says it is already running $TARGET."
      ;;
    busy)
      die_with "$EXIT_BUSY" "${_message:-another update is in flight.} Follow it in Administration > Updates,
or run \`sudo kaname update\` again once the host unit has picked it up."
      ;;
    refused)
      _hint=""
      case "$_message" in
        *backup*) _hint="
Run a backup from the panel first, or re-run with --skip-backup (written to the audit trail)." ;;
      esac
      die_with "$EXIT_REFUSED" "$_message${_remedy:+
$_remedy}$_hint"
      ;;
    "")
      die "the server console did not answer. See $LOG_FILE, or run with --direct."
      ;;
    *)
      die "${_message:-the server console refused: $_answer}"
      ;;
  esac
}

# Where the panel filed a run, once its files are gone.
panel_status() {
  compose exec -T control-plane node dist/cli.js status "--run=$1" 2>/dev/null | head -n 1
}

# ------------------------------------------------------------------
# Following the host unit
#
# kaname-host.sh writes its log line by line and appends a verdict to
# <run>.result last. Both are read here as they grow; the log's own
# markers move the steps along, and docker pull's "<layer>: <status>"
# lines move the bar.
# ------------------------------------------------------------------
IMG_N=2 IMG_I=-1 IMG_LABEL="" LAYERS_SEEN=" " LAYERS_DONE=" " LAYER_TOTAL=0 LAYER_FINISHED=0
FIRST_REASON="" PHASE_STEP="" ROLLING_BACK=0

follow_step() {
  [ "$PHASE_STEP" != "$1" ] || return 0
  PHASE_STEP="$1"
  step "$1"
}

on_host_line() {
  _line="$1"
  case "$_line" in
    *" --> pulling images"*)
      follow_step "Pulling images"
      detail "control-plane${SEP}web"
      bar_open "starting"
      ;;
    *" --> pulling "*)
      follow_step "Pulling images"
      IMG_I=$((IMG_I + 1))
      IMG_LABEL="${_line##*/}"; IMG_LABEL="${IMG_LABEL%%[:@]*}"; IMG_LABEL="${IMG_LABEL#kaname-}"
      LAYERS_SEEN=" " LAYERS_DONE=" " LAYER_TOTAL=0 LAYER_FINISHED=0
      bar_set $((IMG_I * 1000 / IMG_N)) $(((IMG_I + 1) * 1000 / IMG_N)) "$IMG_LABEL"
      log "    pulling ${_line##* --> pulling }"
      ;;
    *" --> restarting"*)
      if [ "$IMG_I" -ge 0 ] && [ "$PHASE_STEP" = "Pulling images" ]; then
        bar_set 1000 1000 "$IMG_N/$IMG_N images"
        # Let the bar finish its run to 100% before the line settles.
        [ "$UI" != 1 ] || nap 0.8
      fi
      follow_step "Restarting"
      detail "control-plane${SEP}web"
      ;;
    *" --> waiting for the control plane to answer"*)
      follow_step "Waiting for health"
      detail "$KANAME_LOCAL_API/health"
      ;;
    *" is up and answering"*)
      detail "answering"
      ;;
    *" --> restoring the configuration"*)
      if [ "$ROLLING_BACK" = 0 ]; then
        ROLLING_BACK=1
        step_close "$C_DANGER$CROSS$C_RESET"
        PHASE_STEP=""
        follow_step "Rolling back"
        detail "putting $CURRENT back"
      fi
      log "    ${_line#* }"
      ;;
    *" !! "*)
      _said="${_line#* !! }"
      [ -n "$FIRST_REASON" ] || FIRST_REASON="$_said"
      [ -z "$PHASE_STEP" ] || detail "$_said"
      log "    !! $_said"
      ;;
    *)
      # docker pull, not on a terminal: "<layer>: <status>".
      _id="${_line%%: *}"
      case "$_id" in ''|*[!0-9a-f]*) return 0 ;; esac
      [ "$_id" != "$_line" ] || return 0
      [ "$IMG_I" -ge 0 ] || return 0
      case "$LAYERS_SEEN" in *" $_id "*) ;; *) LAYERS_SEEN="$LAYERS_SEEN$_id " LAYER_TOTAL=$((LAYER_TOTAL + 1)) ;; esac
      case "${_line#*: }" in
        "Pull complete"*|"Download complete"*|"Already exists"*)
          case "$LAYERS_DONE" in *" $_id "*) ;; *) LAYERS_DONE="$LAYERS_DONE$_id " LAYER_FINISHED=$((LAYER_FINISHED + 1)) ;; esac ;;
      esac
      bar_set $(((IMG_I * 1000 + LAYER_FINISHED * 1000 / LAYER_TOTAL) / IMG_N)) \
        $(((IMG_I * 1000 + (LAYER_FINISHED + 1) * 1000 / LAYER_TOTAL) / IMG_N)) \
        "$IMG_LABEL$SEP$LAYER_FINISHED/$LAYER_TOTAL layers"
      ;;
  esac
}

# Copies the lines the log has gained into this command's own log and
# acts on them. Only whole lines: a partial one is read next time.
SEEN_LINES=0
drain_log() {
  [ -f "$RUN_LOG" ] || return 0
  _n="$(wc -l <"$RUN_LOG" 2>/dev/null | tr -d ' ')" || return 0
  case "$_n" in ''|*[!0-9]*) return 0 ;; esac
  # Truncated: kaname-host.sh starts the log afresh when it picks up.
  [ "$_n" -ge "$SEEN_LINES" ] || SEEN_LINES=0
  [ "$_n" -gt "$SEEN_LINES" ] || return 0
  sed -n "$((SEEN_LINES + 1)),${_n}p" "$RUN_LOG" >"$WORK/chunk" 2>/dev/null || return 0
  SEEN_LINES="$_n"
  while IFS= read -r _l; do
    [ -z "$LOG_FILE" ] || printf '%s\n' "$_l" >>"$LOG_FILE"
    on_host_line "$_l"
  done <"$WORK/chunk"
}

# Follows RUN_ID until it has a verdict, which it leaves in VERDICT.
follow_run() {
  FOLLOWING=1 FOLLOW_RUN="$RUN_ID" VERDICT="" REASON=""
  _changed_at="$(date +%s)" _gone=0 _last_size=""
  while :; do
    drain_log
    VERDICT="$(verdict_of "$RUN_RESULT")"
    if [ -n "$VERDICT" ]; then
      REASON="$(reason_of "$RUN_RESULT")"
      nap 0.2
      drain_log
      break
    fi

    # The panel files its own runs and then deletes their files, and
    # takes back a request the unit never picked up. Either way there is
    # nothing left here to read: ask it.
    if [ "$PATH_KIND" = panel ] && [ ! -f "$QUEUE" ] && [ ! -f "$RUN_LOG" ] && [ ! -f "$RUN_RESULT" ]; then
      _gone=$((_gone + 1))
      if [ "$_gone" -ge 10 ]; then
        _status="$(json_field "$(panel_status "$RUN_ID")" status)"
        case "$_status" in
          succeeded) VERDICT=succeeded ;;
          rolled_back|failed) VERDICT=rolled_back ;;
          needs_attention) VERDICT=rollback_failed ;;
        esac
        if [ -n "$VERDICT" ]; then break; fi
        _gone=0
      fi
    fi

    # Nothing written for half an hour: the unit is gone.
    _size="$(cat "$RUN_LOG" "$RUN_RESULT" 2>/dev/null | wc -c | tr -d ' ')"
    if [ "$_size" != "$_last_size" ]; then _changed_at="$(date +%s)" _last_size="$_size"; fi
    if [ $(($(date +%s) - _changed_at)) -ge $((STALE_MINUTES * 60)) ]; then
      die "kaname-update.service has written nothing for $STALE_MINUTES minutes. Check:
  systemctl status kaname-update.service
  $RUN_LOG"
    fi
    nap 0.25
  done
  FOLLOWING=0
}

describe_reason() {
  case "$1" in
    pull_failed) echo "the images for $TARGET could not be pulled; nothing was stopped" ;;
    restart_failed) echo "$TARGET did not start" ;;
    health_failed) echo "$TARGET did not answer on /health in time" ;;
    *) echo "${FIRST_REASON:-$TARGET did not come up}" ;;
  esac
}

# Run from the data directory, Compose finds the project file and .env
# by itself, which keeps every line short enough to copy.
restore_command() {
  printf '      %s\n' \
    "cd $DATA_DIR" \
    "docker compose -p $PROJECT stop control-plane web" \
    "gunzip -c ${1#"$DATA_DIR"/} |" \
    "  docker compose -p $PROJECT exec -T postgres \\" \
    "  psql -U kaname -d kaname -v ON_ERROR_STOP=1 --single-transaction" \
    "docker compose -p $PROJECT start control-plane web"
}

# The run did not succeed: say what happened and what is running now.
report_failure() {
  _why="$(describe_reason "$REASON")"
  if [ "$VERDICT" = rolled_back ]; then
    step_end
    _status="$EXIT_ROLLED_BACK"
    _head="Kaname $CURRENT → $TARGET failed and was rolled back."
  else
    step_close "$C_DANGER$CROSS$C_RESET"
    _status="$EXIT_ROLLBACK_FAILED"
    _head="Kaname $CURRENT → $TARGET failed, and so did the rollback."
  fi

  printf '\n'
  [ "$UI" != 1 ] || rule
  printf '  %s%s%s %s%s%s\n\n' "$C_DANGER" "$CROSS" "$C_RESET" "$C_BOLD" "$_head" "$C_RESET"
  to_log "$_head"
  kv "reason" "$_why" "$C_DANGER"
  if [ "$VERDICT" = rolled_back ]; then
    kv "running" "$CURRENT, as before"
  else
    kv "running" "unknown; check: docker compose -p $PROJECT -f $DATA_DIR/docker-compose.yml ps"
  fi
  kv "run" "$RUN_ID"
  [ -z "$LOG_FILE" ] || kv "log" "$LOG_FILE"
  [ ! -f "$RUN_LOG" ] || kv "host log" "$RUN_LOG"

  # A migration that ran before the failure has left the old build on a
  # schema it does not know; nothing here restores a database by itself.
  _migrated=0
  if [ "$PATH_KIND" = direct ] && [ -n "${MIGRATIONS_BEFORE:-}" ] && [ "$REASON" != pull_failed ]; then
    _now="$(psql_value 'select count(*) from drizzle.__drizzle_migrations' || true)"
    case "$_now$MIGRATIONS_BEFORE" in
      *[!0-9]*) ;;
      *) [ "$_now" -le "$MIGRATIONS_BEFORE" ] || _migrated=1 ;;
    esac
  fi
  if [ -n "${DUMP:-}" ] && { [ "$_migrated" = 1 ] || is_true "$DESTRUCTIVE"; }; then
    say ""
    if [ "$_migrated" = 1 ]; then
      say "  Migrations from $TARGET ran before it failed: $CURRENT is running against a"
      say "  database it does not know. Put the dump taken before the update back:"
    else
      say "  $TARGET's migration rewrites data. If it ran before the failure, put the"
      say "  dump taken before the update back:"
    fi
    say ""
    restore_command "$DUMP"
    to_log "restore: gunzip -c $DUMP | psql (see above)"
  elif [ -n "${DUMP:-}" ]; then
    kv "dump" "$DUMP"
  fi
  exit "$_status"
}

# ------------------------------------------------------------------
# The agent on this host
# ------------------------------------------------------------------
agent_health_url() {
  if [ "$MODE" = cp ]; then
    echo "$KANAME_LOCAL_API/health"
    return 0
  fi
  _url="$(sed -n 's/.*"control_plane_url": *"\([^"]*\)".*/\1/p' "$STATE_DIR/state.json" 2>/dev/null | head -n 1)"
  [ -z "$_url" ] || echo "${_url%/}/health"
}

# Whether the agent dialled back in since $1 (epoch seconds). Its own
# journal says so exactly; where there is none to read, the panel's
# count of connected agents stands in.
agent_reconnected() {
  _since="$1" _url="$(agent_health_url)" _i=0
  while [ "$_i" -lt "$AGENT_RECONNECT_TIMEOUT" ]; do
    if systemctl is-active --quiet kanamed 2>/dev/null; then
      _journal=""
      if command -v journalctl >/dev/null 2>&1; then
        _journal="$(journalctl -u kanamed --since "@$_since" -o cat --no-pager 2>/dev/null || true)"
      fi
      if [ -n "$_journal" ]; then
        if printf '%s\n' "$_journal" | grep -Eq '(^|[^a-z])connected'; then return 0; fi
      elif [ -n "$_url" ] && curl -fsS --max-time 5 "$_url" 2>/dev/null | grep -q '"agents_connected":[1-9]'; then
        return 0
      fi
    fi
    _i=$((_i + 1))
    nap 1
  done
  return 1
}

# $1 the release the agent should run. Leaves AGENT_RESULT.
update_agent() {
  step "Updating the agent"
  _to="$1"
  AGENT_RESULT=""
  if [ ! -x "$BIN_DIR/kanamed" ]; then
    detail "no agent on this host"
    return 0
  fi
  if [ "$AGENT_CURRENT" = "$_to" ]; then
    AGENT_RESULT="kanamed $_to"
    detail "already $_to"
    return 0
  fi

  _url="$(rel "$_to" 9)" _sha="$(rel "$_to" 10)"
  if [ -z "$_url" ] || [ -z "$_sha" ]; then
    AGENT_RESULT="kanamed $AGENT_CURRENT (no linux-$ARCH build of $_to)"
    warn "the manifest has no linux-$ARCH agent for $_to; kanamed stays at $AGENT_CURRENT"
    return 0
  fi
  case "$_url" in
    https://*) ;;
    *)
      AGENT_RESULT="kanamed $AGENT_CURRENT (refused a non-HTTPS download)"
      warn "the manifest names a non-HTTPS agent URL ($_url); refusing it"
      return 0
      ;;
  esac

  log "    fetching kanamed $_to from $_url"
  detail "downloading $_to"
  if ! $CURL "$_url" -o "$WORK/kanamed" 2>>"${LOG_FILE:-/dev/null}"; then
    AGENT_RESULT="kanamed $AGENT_CURRENT (download failed)"
    warn "could not download the agent from $_url; kanamed stays at $AGENT_CURRENT"
    return 0
  fi
  # The binary runs as root. Nothing is installed until it matches the
  # digest the manifest publishes for it.
  _actual="$(sha256_of "$WORK/kanamed")"
  if [ "$_actual" != "$_sha" ]; then
    AGENT_RESULT="kanamed $AGENT_CURRENT (checksum mismatch)"
    warn "the downloaded agent does not match the manifest's digest"
    warn "(expected $_sha, got $_actual); nothing was installed"
    return 0
  fi
  log "    checksum verified"

  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  cp -p "$BIN_DIR/kanamed" "$STATE_DIR/kanamed.previous"
  # Renamed over the old one, never written into it: the running agent
  # keeps its own copy until it is restarted.
  install -m 0755 "$WORK/kanamed" "$BIN_DIR/.kanamed.new"
  mv -f "$BIN_DIR/.kanamed.new" "$BIN_DIR/kanamed"

  _t0="$(date +%s)"
  detail "restarting kanamed $_to"
  systemctl restart kanamed >>"${LOG_FILE:-/dev/null}" 2>&1 || true
  if agent_reconnected "$_t0"; then
    AGENT_RESULT="kanamed $AGENT_CURRENT → $_to" AGENT_UPDATED=1
    log "    kanamed $_to is connected"
    detail "$AGENT_CURRENT → $_to${SEP}connected"
    return 0
  fi

  # It did not come back: the previous build goes back in.
  install -m 0755 "$STATE_DIR/kanamed.previous" "$BIN_DIR/.kanamed.new"
  mv -f "$BIN_DIR/.kanamed.new" "$BIN_DIR/kanamed"
  systemctl restart kanamed >>"${LOG_FILE:-/dev/null}" 2>&1 || true
  AGENT_RESULT="kanamed $AGENT_CURRENT (put back: $_to did not reconnect)"
  AGENT_RESTORED=1
  step_close "$C_DANGER$CROSS$C_RESET"
  warn "kanamed $_to did not reconnect within ${AGENT_RECONNECT_TIMEOUT}s; $AGENT_CURRENT was put back."
  warn "See: journalctl -u kanamed -n 100"
}

# ------------------------------------------------------------------
# Refreshing this command
# ------------------------------------------------------------------

# $1 url, $2 destination, $3 a line the real file must contain. The new
# copy is written beside the old and renamed over it: this script is
# being read by the shell running it, and a rename leaves that copy be.
refresh_file() {
  _new="$2.new"
  $CURL "$1" -o "$_new" 2>>"${LOG_FILE:-/dev/null}" || { rm -f "$_new"; return 1; }
  if [ "$(head -n 1 "$_new")" != "#!/bin/sh" ] || ! grep -q "$3" "$_new" || ! sh -n "$_new" 2>/dev/null; then
    rm -f "$_new"
    return 1
  fi
  chmod 0755 "$_new"
  mv -f "$_new" "$2"
}

# Fetches the scripts that belong to release $1: from its tag when the
# source is the upstream branch, else from the source itself.
refresh_command() {
  step "Refreshing kaname"
  _bases="$KANAME_SOURCE_URL"
  case "$KANAME_SOURCE_URL" in
    */main) _bases="${KANAME_SOURCE_URL%/main}/v$1 $KANAME_SOURCE_URL" ;;
  esac
  _done=""
  for _base in $_bases; do
    log "    fetching $_base/infra/kaname.sh"
    if refresh_file "$_base/infra/kaname.sh" "$BIN_DIR/kaname" "kaname ui: begin"; then
      _done="kaname"
      if [ "$MODE" = cp ]; then
        if refresh_file "$_base/infra/kaname-host.sh" "$LIB_DIR/kaname-host.sh" "kaname-host.sh caddyfile|apply"; then
          _done="$_done${SEP}host helper"
        else
          warn "could not refresh $LIB_DIR/kaname-host.sh from $_base"
        fi
      fi
      break
    fi
  done
  if [ -z "$_done" ]; then
    warn "could not fetch infra/kaname.sh from $KANAME_SOURCE_URL; this copy stays"
    return 0
  fi
  detail "$_done"
}

# ------------------------------------------------------------------
# kaname version
# ------------------------------------------------------------------
show_version() {
  if [ -r "$DATA_DIR/.env" ]; then
    echo "control plane  $(env_value KANAME_VERSION) (configured in $DATA_DIR/.env)"
    _running="$(health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" || _running=""
    echo "               ${_running:-not answering on $KANAME_LOCAL_API}${_running:+ (answering)}"
  elif [ -f "$DATA_DIR/.env" ]; then
    echo "control plane  (run as root to read $DATA_DIR/.env)"
  fi
  if [ -x "$BIN_DIR/kanamed" ]; then
    echo "agent          $("$BIN_DIR/kanamed" version 2>/dev/null || echo unknown)"
  fi
  echo "source         $KANAME_SOURCE_URL"
}

if [ "$CMD" = version ]; then
  show_version
  exit 0
fi

# ------------------------------------------------------------------
# kaname update
# ------------------------------------------------------------------
if [ -f "$DATA_DIR/.env" ]; then
  MODE="cp"
elif [ -x "$BIN_DIR/kanamed" ]; then
  MODE=agent
else
  echo "kaname: no Kaname install here: neither $DATA_DIR/.env nor $BIN_DIR/kanamed exists." >&2
  exit 1
fi

[ "$(id -u)" = 0 ] || { echo "kaname: run this as root: sudo kaname update" >&2; exit 1; }

# Nothing this writes is anyone else's to read; what has to be is chmod-ed so.
umask 077
WORK="$(mktemp -d)"
if [ "$CHECK" = 0 ]; then
  if [ "$MODE" = cp ]; then _logs="$DATA_DIR/logs"; else _logs="$STATE_DIR/logs"; fi
  mkdir -p "$_logs"
  chmod 0700 "$_logs"
  LOG_FILE="$_logs/update-$STAMP.log"
  : >"$LOG_FILE"
  chmod 0600 "$LOG_FILE"
fi

PROJECT="kaname"
if [ "$MODE" = cp ]; then
  PROJECT="$(env_value KANAME_COMPOSE_PROJECT)"
  PROJECT="${PROJECT:-kaname}"
fi

banner
STEP_TOTAL=11
AGENT_RESULT="" AGENT_RESTORED=0 AGENT_UPDATED=0 DUMP="" MIGRATIONS_BEFORE="" DOWNGRADE=0
BREAKING=false SECURITY=false DESTRUCTIVE=false PATH_KIND=direct
check_host

# --- An update already in flight: follow it rather than start another.
if [ "$MODE" = cp ] && [ -n "$INFLIGHT_RUN" ]; then
  RUN_ID="$INFLIGHT_RUN" RUN_LOG="$INFLIGHT_LOG" RUN_RESULT="$INFLIGHT_RESULT"
  case "$RUN_ID" in host-*) PATH_KIND=direct ;; *) PATH_KIND=panel ;; esac
  if [ "$CHECK" = 1 ]; then
    step_end
    headline "An update is in flight (run $RUN_ID)."
    kv "follow" "sudo kaname update"
    exit "$EXIT_BUSY"
  fi
  if [ -n "$REQ_VERSION" ] || [ "$DIRECT" = 1 ]; then
    warn "an update is already in flight; following it, and ignoring the options given"
  fi
  # The manifest is only needed for what comes after; without it the
  # update itself still stands.
  step "Reading the manifest"
  _have_manifest=1
  if load_manifest; then
    detail "$(wc -l <"$RELEASES" | tr -d ' ') releases"
  else
    _have_manifest=0
    warn "$MANIFEST_ERROR"
    detail "unavailable"
  fi
  step "Following the update"
  # A request not picked up yet names its versions; a log does too.
  if [ -f "$QUEUE" ]; then
    TARGET="$(request_field "$QUEUE" to_version)" CURRENT="$(request_field "$QUEUE" from_version)"
    _i=0
    while [ -f "$QUEUE" ] && [ "$_i" -lt $((PICKUP_TIMEOUT * 5)) ]; do _i=$((_i + 1)); nap 0.2; done
    [ ! -f "$QUEUE" ] ||
      die_with "$EXIT_BUSY" "an update request is queued and kaname-update.service has not picked it up.
Check: systemctl status kaname-update.path kaname-update.service"
  else
    _first="$(grep -m 1 '==> applying' "$RUN_LOG" 2>/dev/null || true)"
    TARGET="$(printf '%s' "$_first" | sed -n 's/.*==> applying \([^ ]*\) over \([^ ]*\).*/\1/p')"
    CURRENT="$(printf '%s' "$_first" | sed -n 's/.*==> applying \([^ ]*\) over \([^ ]*\).*/\2/p')"
  fi
  CURRENT="${CURRENT:-$(env_value KANAME_VERSION)}"
  # What a failure report needs: the run's dump and migration count, if
  # this command took them, and whether the release rewrites data.
  if [ "$PATH_KIND" = direct ]; then
    SNAP="$DATA_DIR/rollback/$RUN_ID"
    [ ! -f "$SNAP/db.sql.gz" ] || DUMP="$SNAP/db.sql.gz"
    MIGRATIONS_BEFORE="$(sed -n 's/.*"migrations_before": *\([0-9][0-9]*\).*/\1/p' "$SNAP/images.json" 2>/dev/null)" ||
      MIGRATIONS_BEFORE=""
  fi
  if [ "$_have_manifest" = 1 ] && [ -n "$TARGET" ] && [ -n "$(rel "$TARGET" 1)" ]; then
    DESTRUCTIVE="$(rel "$TARGET" 5)"
  fi
  detail "re-attached to $RUN_ID"
  follow_run
  if [ "$VERDICT" != succeeded ]; then report_failure; fi
  step_end
  if [ "$_have_manifest" = 1 ] && [ -n "$TARGET" ]; then
    if [ -n "$AGENT_CURRENT" ]; then update_agent "$TARGET"; fi
    refresh_command "$TARGET"
  else
    warn "the agent and this command were left as they are"
  fi
  step_end
  headline "Kaname ${CURRENT:+$CURRENT → }${TARGET:-the new release} is running."
  _url="$(env_value KANAME_PUBLIC_URL)"
  [ -z "$_url" ] || kv "open" "$_url" "$C_ACCENT$C_BOLD"
  kv "run" "$RUN_ID"
  [ -z "$AGENT_RESULT" ] || kv "agent" "$AGENT_RESULT"
  kv "log" "$LOG_FILE"
  exit "$EXIT_OK"
fi

read_manifest

if [ "$MODE" = cp ]; then
  if [ -n "$PANEL_VERSION" ] && [ "$PANEL_VERSION" != "$CURRENT" ]; then
    warn "the control plane answers as $PANEL_VERSION but $DATA_DIR/.env says $CURRENT"
  fi
else
  CURRENT="$AGENT_CURRENT"
fi
choose_release
choose_path

# --- Up to date. On a control-plane host a local agent that fell behind
#     is still brought up to the release the panel runs.
if [ -z "$TARGET" ]; then
  _agent_behind=0
  if [ "$MODE" = cp ] && [ -n "$AGENT_CURRENT" ] && newer "$CURRENT" "$AGENT_CURRENT" && [ -n "$(rel "$CURRENT" 9)" ]; then
    _agent_behind=1
  fi
  [ -z "$SKIPPED" ] || warn "$SKIPPED needs $(rel "$SKIPPED" 6) or later first"
  if [ "$_agent_behind" = 1 ] && [ "$CHECK" = 0 ]; then
    update_agent "$CURRENT"
  fi
  step_end
  headline "Kaname $CURRENT is up to date."
  if [ "$_agent_behind" = 1 ] && [ "$CHECK" = 1 ]; then
    kv "agent" "kanamed $AGENT_CURRENT; \`sudo kaname update\` brings it to $CURRENT"
  fi
  [ -z "$AGENT_RESULT" ] || kv "agent" "$AGENT_RESULT"
  [ -z "$LOG_FILE" ] || kv "log" "$LOG_FILE"
  exit "$EXIT_OK"
fi

show_release

if [ "$CHECK" = 1 ]; then
  _agent_line=""
  if [ -n "$AGENT_CURRENT" ] && [ "$AGENT_CURRENT" != "$TARGET" ]; then
    _agent_line="then update kanamed $AGENT_CURRENT → $TARGET, checked against its sha256"
  fi
  case "$PATH_KIND" in
    panel)
      show_plan "start the update through the control plane's server console" \
        "(its backup check, snapshot of .env and run in History)" \
        "and follow kaname-update.service: pull, restart, health check" ${_agent_line:+"$_agent_line"}
      ;;
    direct)
      _dump_line="dump the database to $DATA_DIR/rollback/host-<time>/db.sql.gz"
      if [ "$SKIP_BACKUP" = 1 ] && ! is_true "$DESTRUCTIVE"; then _dump_line="skip the database dump (--skip-backup)"; fi
      show_plan "$_dump_line" \
        "snapshot .env beside it, pin $TARGET's images" \
        "queue the update for kaname-update.service and follow it" ${_agent_line:+"$_agent_line"}
      ;;
    agent)
      show_plan "download kanamed $TARGET, check its sha256, swap it in and restart" \
        "put $AGENT_CURRENT back if it does not reconnect within ${AGENT_RECONNECT_TIMEOUT}s"
      ;;
  esac
  if needs_confirmation; then
    say ""
    say "  $TARGET has to be confirmed: at the prompt, or with --yes."
  fi
  say ""
  say "  Nothing was changed."
  exit "$EXIT_AVAILABLE"
fi

confirm_release

# --- Agent-only host.
if [ "$MODE" = agent ]; then
  update_agent "$TARGET"
  # The agent is the whole update here: one that did not happen is a
  # failure, and one that was put back is a rollback.
  if [ "$AGENT_UPDATED" = 1 ]; then refresh_command "$TARGET"; fi
  step_end
  if [ "$AGENT_UPDATED" = 1 ]; then
    headline "kanamed $AGENT_CURRENT → $TARGET is running."
  else
    headline "kanamed stays at $AGENT_CURRENT."
  fi
  kv "agent" "$AGENT_RESULT"
  kv "log" "$LOG_FILE"
  if [ "$AGENT_RESTORED" = 1 ]; then exit "$EXIT_ROLLED_BACK"; fi
  if [ "$AGENT_UPDATED" = 0 ]; then exit 1; fi
  exit "$EXIT_OK"
fi

# --- Control-plane host.
if [ "$PATH_KIND" = panel ]; then
  handover_panel
else
  RUN_ID="host-$STAMP"
  SNAP="$DATA_DIR/rollback/$RUN_ID"
  mkdir -p "$SNAP"
  chmod 0750 "$SNAP"
  chown "root:$KANAME_UID" "$SNAP" 2>/dev/null || true
  backup_database
  snapshot_settings
  handover_direct
fi

follow_run
if [ "$VERDICT" != succeeded ]; then report_failure; fi
step_end

if [ -n "$AGENT_CURRENT" ]; then update_agent "$TARGET"; fi
refresh_command "$TARGET"
step_end

_running="$(health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" || _running=""
if [ -n "$_running" ] && [ "$_running" != "$TARGET" ]; then
  warn "the control plane answers as $_running, not $TARGET"
fi

headline "Kaname $CURRENT → $TARGET is running."
_url="$(env_value KANAME_PUBLIC_URL)"
[ -z "$_url" ] || kv "open" "$_url" "$C_ACCENT$C_BOLD"
[ -z "$AGENT_RESULT" ] || kv "agent" "$AGENT_RESULT"
kv "run" "$RUN_ID"
kv "history" "Administration > Updates"
[ -z "$DUMP" ] || kv "dump" "$DUMP"
kv "log" "$LOG_FILE"
exit "$EXIT_OK"
