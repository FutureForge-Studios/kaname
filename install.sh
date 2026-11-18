#!/bin/sh
# ==================================================================
# Kaname installer.
#
#   curl -fsSL https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/install.sh | sudo sh
#
# That installs the control plane and pairs this box as the first
# managed server. --control-plane-only skips the agent; --agent-only
# --token=<token> --control-plane=<url> enrols another server against a
# panel that already exists.
#
# The panel is served over plain HTTP on port 80 at this server's IPv4
# address: nothing to answer, no domain to own. A domain and HTTPS are
# set later from Administration in the panel, and the IP address keeps
# working afterwards, so setting one cannot lock anyone out.
#
# This script is meant to be read before it is run. It fetches exactly
# three files, all from KANAME_SOURCE_URL below — the Compose file, the
# host helper and the `kaname` command (`sudo kaname update`) — names
# that source when it starts and logs each URL before it fetches it.
# Re-running it is a repair, never a wipe: --force
# is the only thing that destroys data, and it says what first.
# ==================================================================
set -eu

# The only place a URL is spelled out. Point these somewhere else and
# the whole installer follows.
KANAME_SOURCE_URL="${KANAME_SOURCE_URL:-https://raw.githubusercontent.com/FutureForge-Studios/kaname/main}"
KANAME_REGISTRY="${KANAME_REGISTRY:-ghcr.io/futureforge-studios}"
KANAME_DOCKER_INSTALL_URL="https://get.docker.com"

KANAME_DEFAULT_VERSION="0.3.0"
KANAME_MIN_DOCKER_MAJOR=24
KANAME_COMPOSE_PROJECT="kaname"

# KANAME_DATA_DIR moves the data root; the end-to-end tests use a throwaway one.
DATA_DIR="${KANAME_DATA_DIR:-/etc/kaname}"
STATE_DIR="/var/lib/kaname"
BIN_DIR="/usr/local/bin"
LIB_DIR="/usr/local/lib/kaname"

# The control-plane image runs as this uid, fixed in its Dockerfile so
# the paths it has to write can be owned by it without running as root.
KANAME_UID=10001

# Where the control plane answers on the loopback interface. Caddy
# fronts port 80; this is bound to 127.0.0.1 only, and is what the local
# agent dials and what this script health-checks.
KANAME_LOCAL_API="http://127.0.0.1:4000"

# Options
MODE="all-in-one"          # all-in-one | control-plane-only | agent-only
# Deliberately not called VERSION: /etc/os-release defines that, and
# anything that sources it would overwrite the release we install.
REQ_VERSION="$KANAME_DEFAULT_VERSION"
TOKEN=""
CONTROL_PLANE=""
PUBLIC_URL="${KANAME_PUBLIC_URL:-}"
FORCE=0

usage() {
  cat <<'USAGE'
kaname installer, by FutureForge Studios

  --control-plane-only     Install the control plane, do not pair an agent here.
  --agent-only             Install only the agent. Requires --token and --control-plane.
  --token=<token>          Pairing token, printed by the panel when adding a server.
  --control-plane=<url>    Where the agent should dial, e.g. http://203.0.113.10
  --version=<version>      Release to install. Defaults to the one this script ships with.
  --public-url=<url>       Address the panel is reached at, e.g. http://203.0.113.10 — for hosts
                           whose own interface carries a private address (cloud NAT).
                           KANAME_PUBLIC_URL in the environment does the same.
  --force                  Destroy an existing install first. Never the default.
                           KANAME_THEME=light|dark picks the colours when the
                           terminal's background cannot be detected.
  --help                   This.
USAGE
}

need() {
  # $1 flag, $2 the argument after it
  [ -n "$2" ] || { echo "kaname: $1 needs a value" >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --control-plane-only) MODE="control-plane-only" ;;
    --agent-only) MODE="agent-only" ;;
    --token) need "$1" "${2:-}"; TOKEN="$2"; shift ;;
    --token=*) TOKEN="${1#*=}" ;;
    --control-plane) need "$1" "${2:-}"; CONTROL_PLANE="$2"; shift ;;
    --control-plane=*) CONTROL_PLANE="${1#*=}" ;;
    --version) need "$1" "${2:-}"; REQ_VERSION="$2"; shift ;;
    --version=*) REQ_VERSION="${1#*=}" ;;
    --public-url) need "$1" "${2:-}"; PUBLIC_URL="$2"; shift ;;
    --public-url=*) PUBLIC_URL="${1#*=}" ;;
    --force) FORCE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "kaname: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# The log lives under /etc, so this has to come before the log is opened
# or a run without sudo dies on that mkdir instead of on this sentence.
[ "$(id -u)" = "0" ] || { echo "kaname: run this as root (prefix the command with sudo)." >&2; exit 1; }

case "$PUBLIC_URL" in
  ""|http://*|https://*) ;;
  *) echo "kaname: --public-url must start with http:// or https:// (got '$PUBLIC_URL')" >&2; exit 2 ;;
esac
PUBLIC_URL="${PUBLIC_URL%/}"

# Everything said below also goes to a log under the data root, so a
# failed install can be read afterwards without scrolling back.
LOG_FILE=""
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# What the banner calls this script. Everything between the two ui
# markers below is shared, byte for byte, with infra/kaname.sh (the
# `kaname` command); CI fails if the copies drift apart.
UI_TITLE="Kaname installer"
UI_ROLE="installer"
UI_TAGLINE="One panel for your servers. This sets it up; nothing to answer."

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
    printf '  %s%s%s %skaname%s  %s%s%sby%s FutureForge Studios\n' "$C_ACCENT" "$MARK" "$C_RESET" \
      "$C_BOLD" "$C_RESET" "$C_MUTED" "$UI_ROLE" "$SEP" "$C_RESET"
    printf '  %s%s%s\n' "$C_MUTED" "$UI_TAGLINE" "$C_RESET"
    rule
    [ -z "$LOG_FILE" ] || kv "log" "$LOG_FILE"
    kv "source" "$KANAME_SOURCE_URL"
    printf '\n'
  else
    printf '%s\n' "$UI_TITLE by FutureForge Studios — $STAMP" "Source: $KANAME_SOURCE_URL"
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

open_log() {
  mkdir -p "$DATA_DIR/logs"
  chmod 0700 "$DATA_DIR" "$DATA_DIR/logs"
  LOG_FILE="$DATA_DIR/logs/install-$STAMP.log"
  : >"$LOG_FILE"
  chmod 0600 "$LOG_FILE"
}

compose() {
  docker compose -p "$KANAME_COMPOSE_PROJECT" -f "$DATA_DIR/docker-compose.yml" --env-file "$DATA_DIR/.env" "$@"
}

# 1. Preflight
preflight() {
  step "Checking this host"

  [ "$(id -u)" = "0" ] || die "run this as root (prefix the command with sudo)."

  [ "$(uname -s)" = "Linux" ] ||
    die "Kaname manages Linux servers and its agent is a Linux binary. This is $(uname -s)."

  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $(uname -m). Kaname publishes amd64 and arm64 builds only." ;;
  esac

  command -v systemctl >/dev/null 2>&1 ||
    die "systemd is required. The agent runs as a systemd unit, and control-plane updates are
applied by a systemd unit on the host."

  command -v curl >/dev/null 2>&1 || die "curl is required and is not installed."

  # Read, not sourced: /etc/os-release defines VERSION, and sourcing it
  # would overwrite the release this script is about to install.
  OS_ID="$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"')"
  case "$OS_ID" in
    debian|ubuntu|raspbian|rocky|almalinux|rhel|centos|fedora) ;;
    '') warn "could not read /etc/os-release; continuing" ;;
    *) warn "untested distribution '$OS_ID'; continuing" ;;
  esac

  OS_VERSION="$(sed -n 's/^VERSION_ID=//p' /etc/os-release 2>/dev/null | tr -d '"')"
  log "    Linux/$ARCH${OS_ID:+ ($OS_ID${OS_VERSION:+ $OS_VERSION})}, systemd present"
  detail "linux/$ARCH${OS_ID:+$SEP$OS_ID${OS_VERSION:+ $OS_VERSION}}"
}

# Every download retries a few times and never hangs: a blip on the way
# to GitHub or to the panel is not a reason to leave an install half-done.
CURL="curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15"

# 2. Docker
# A fresh Ubuntu or Debian host runs unattended-upgrades for its first
# minutes, and the Docker installer's apt-get fails outright on the lock
# it holds. Wait for it, up to five minutes, saying so.
wait_for_apt() {
  command -v apt-get >/dev/null 2>&1 || return 0
  command -v pgrep >/dev/null 2>&1 || return 0
  _w=0
  # unattended-upgrades by full command line: its idle shutdown helper,
  # always running, shares the short name "unattended-upgr" and never exits.
  while pgrep '^(apt|apt-get|dpkg|apt.systemd.dai)$' >/dev/null 2>&1 ||
    pgrep -f 'bin/unattended-upgrade( |$)' >/dev/null 2>&1; do
    [ "$_w" -gt 0 ] || { detail "waiting for apt (unattended-upgrades)"; log "    apt is busy; waiting for it"; }
    _w=$((_w + 2))
    [ "$_w" -lt 300 ] || die "apt has been busy for five minutes (most likely unattended-upgrades).
Let it finish, or see what holds it with: ps -ef | grep -E 'apt|dpkg'
Then run this again."
    sleep 2
  done
  return 0
}

ensure_docker() {
  step "Installing Docker Engine"
  docker_how="already installed$SEP"

  # Docker from the snap store is confined: it cannot read $DATA_DIR, so
  # the panel would fail in ways that point nowhere near the cause.
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    die "Docker is installed as a snap (Ubuntu's 'snap install docker'). Kaname needs
the Docker Engine package: the snap is confined and cannot use $DATA_DIR.
Remove it (this deletes the snap's containers and images), then run this again
and the official Docker Engine is installed for you:
  sudo snap remove --purge docker"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    docker_how=""
    wait_for_apt
    detail "installing from get.docker.com"
    log "    not installed; fetching the official installer from $KANAME_DOCKER_INSTALL_URL"
    $CURL "$KANAME_DOCKER_INSTALL_URL" -o /tmp/get-docker.sh ||
      die "could not download the Docker installer from $KANAME_DOCKER_INSTALL_URL.
Install Docker yourself and run this again: https://docs.docker.com/engine/install/"
    sh /tmp/get-docker.sh >>"$LOG_FILE" 2>&1 ||
      die "the Docker installer failed. Its output is in $LOG_FILE.
Install Docker yourself and run this again: https://docs.docker.com/engine/install/"
    rm -f /tmp/get-docker.sh
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  docker info >/dev/null 2>&1 ||
    die "Docker is installed but the daemon is not answering.
Try: systemctl start docker"

  DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
  DOCKER_MAJOR="${DOCKER_VERSION%%.*}"
  case "$DOCKER_MAJOR" in
    ''|*[!0-9]*) die "could not read the Docker version (got '$DOCKER_VERSION')." ;;
  esac
  [ "$DOCKER_MAJOR" -ge "$KANAME_MIN_DOCKER_MAJOR" ] ||
    die "Docker $DOCKER_VERSION is too old. Kaname needs $KANAME_MIN_DOCKER_MAJOR or newer,
because the deployment uses Compose v2 and health-gated startup.
Upgrade Docker and run this again: https://docs.docker.com/engine/install/"

  docker compose version >/dev/null 2>&1 ||
    die "the Docker Compose plugin is missing. Kaname is deployed as a Compose project.
Install it and run this again: https://docs.docker.com/compose/install/linux/"

  log "    Docker $DOCKER_VERSION with the Compose plugin"
  detail "${docker_how}v$DOCKER_VERSION"
}

# 3. Existing install. Re-running is a repair; only --force destroys, and
#    only after saying exactly what it is about to destroy.
check_existing() {
  step "Checking existing install"
  if [ ! -f "$DATA_DIR/.env" ]; then
    detail "none found${SEP}fresh install"
    return 0
  fi

  if [ "$FORCE" = "1" ]; then
    detail "removing it (--force)"
    warn "--force: removing the existing install. This deletes:"
    warn "  - the Kaname database, including every server, user and audit record"
    warn "  - $DATA_DIR (secrets, rollback snapshots, logs)"
    warn "  - the Compose project '$KANAME_COMPOSE_PROJECT' and its volumes"
    warn "  - $STATE_DIR, this host's agent identity, which the new database would not know"
    compose down -v >>"$LOG_FILE" 2>&1 || true
    systemctl stop kanamed >/dev/null 2>&1 || true
    # The log lives under here, so it is moved aside first.
    mv "$LOG_FILE" "/tmp/kaname-install-$STAMP.log" 2>/dev/null || true
    rm -rf "$DATA_DIR" "$STATE_DIR"
    open_log
    log "    removed."
    detail "removed (--force)"
    return 0
  fi

  detail "found${SEP}repairing it"
  log "    found an existing install at $DATA_DIR"
  log "    re-running as a repair: existing secrets, data and version are kept,"
  log "    the deployment files and units are refreshed, and the services are restarted."
  log "    to wipe and start over instead, re-run with --force."
}

# 4. Data root and secrets. Every secret comes from openssl's CSPRNG;
#    none ships with the software and none is printed except the setup
#    token, which dies as soon as an account is created.
random_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1"
  else
    # /dev/urandom is the same CSPRNG openssl draws from.
    head -c "$1" /dev/urandom | base64 | tr -d '\n'
  fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

detect_ip() {
  # No external service is consulted: the route the kernel would take to
  # a public address already names the address it would send from.
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.][0-9.]*\).*/\1/p' | head -n 1)"
  [ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$IP" ] ||
    die "could not work out this server's IPv4 address from 'ip route' or 'hostname -I'.
The panel is served at that address, so there is nothing to point a browser at.
Give this host an IPv4 address and run this again."
}

# On every major cloud the interface carries a private address and the
# public one is NAT in front of it. Served at the private address, the
# panel prints a URL nobody outside the VPC can open and hands every new
# server a pairing command that dials it.
private_ip() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|169.254.*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

# The address the panel is served at: --public-url when given, the
# detected interface address otherwise. Sets PANEL_URL.
resolve_public_url() {
  if [ -n "$PUBLIC_URL" ]; then
    PANEL_URL="$PUBLIC_URL"
    log "    serving the panel at $PANEL_URL (from --public-url)"
    return 0
  fi
  detect_ip
  PANEL_URL="http://$IP"
  log "    serving the panel at $PANEL_URL"
  if private_ip "$IP"; then
    warn "$IP is a private address. If this host sits behind cloud NAT, the panel"
    warn "and every pairing command it prints will name an address nothing outside"
    warn "the network can reach. Re-run with --public-url=http://<public-ip> to fix"
    warn "that; a re-run is a repair and keeps everything else."
  fi
}

# A release looks like 1.2.3, optionally with a pre-release suffix.
# Anything else in KANAME_VERSION is not something a registry can serve,
# and is worth failing on here rather than inside `docker compose pull`.
valid_version() {
  case "$1" in
    ""|*[!0-9A-Za-z.+-]*) return 1 ;;
  esac
  echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
}

env_value() {
  # $1 key. Prints nothing when the key is absent.
  grep "^$1=" "$DATA_DIR/.env" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

set_env_value() {
  # $1 key, $2 value. Replaces in place, appends when absent.
  tmp="$DATA_DIR/.env.tmp"
  if grep -q "^$1=" "$DATA_DIR/.env" 2>/dev/null; then
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      "$DATA_DIR/.env" >"$tmp"
  else
    cp "$DATA_DIR/.env" "$tmp"
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
  fi
  cat "$tmp" >"$DATA_DIR/.env"
  rm -f "$tmp"
}

# The version and the two image tags are ours, not the operator's. On a
# repair they are left alone unless --version asked for something else,
# or what is stored could never have worked -- an earlier installer
# sourced /etc/os-release, which defines VERSION, and wrote the
# distribution's name into the image tag.
reconcile_version() {
  stored="$(env_value KANAME_VERSION)"

  if [ "$REQ_VERSION" != "$KANAME_DEFAULT_VERSION" ] && [ "$REQ_VERSION" != "$stored" ]; then
    log "    moving this install from ${stored:-unknown} to $REQ_VERSION"
  elif valid_version "$stored"; then
    REQ_VERSION="$stored"
    return 0
  else
    warn "the stored version is not a release number: '${stored}'"
    warn "rewriting it to $REQ_VERSION; the images it named could never have been pulled."
  fi

  set_env_value KANAME_VERSION "$REQ_VERSION"
  set_env_value KANAME_IMAGE_CONTROL_PLANE "$KANAME_REGISTRY/kaname-control-plane:$REQ_VERSION"
  set_env_value KANAME_IMAGE_WEB "$KANAME_REGISTRY/kaname-web:$REQ_VERSION"
  chmod 0660 "$DATA_DIR/.env"
  chown "root:$KANAME_UID" "$DATA_DIR/.env"
}

prepare_data_dir() {
  step "Preparing $DATA_DIR"

  mkdir -p "$DATA_DIR" "$DATA_DIR/logs" "$DATA_DIR/rollback" "$DATA_DIR/updates/queue"
  chmod 0700 "$DATA_DIR/logs"
  chmod 0750 "$DATA_DIR" "$DATA_DIR/rollback" "$DATA_DIR/updates" "$DATA_DIR/updates/queue"

  # The control plane writes rollback snapshots, update requests and the
  # environment file it is upgrading. Those three, and only those three,
  # are handed to its uid; the root of the install stays root-owned and
  # unreadable by anything else on the box.
  chown "root:$KANAME_UID" "$DATA_DIR"
  chown -R "$KANAME_UID:$KANAME_UID" "$DATA_DIR/rollback" "$DATA_DIR/updates"

  if [ -f "$DATA_DIR/.env" ]; then
    log "    keeping the existing secrets in $DATA_DIR/.env"
    detail "kept existing secrets"
    reconcile_version
    # A repair is how a wrong address gets corrected: the new URL lands
    # in .env and the Caddyfile is regenerated from it below. The domain
    # is left alone; that is set from inside the panel.
    if [ -n "$PUBLIC_URL" ] && [ "$(env_value KANAME_PUBLIC_URL)" != "$PUBLIC_URL" ]; then
      log "    changing the panel address to $PUBLIC_URL"
      set_env_value KANAME_PUBLIC_URL "$PUBLIC_URL"
      chmod 0660 "$DATA_DIR/.env"
      chown "root:$KANAME_UID" "$DATA_DIR/.env"
    fi
    return 0
  fi

  resolve_public_url
  log "    generating secrets with openssl rand"
  detail "generated secrets"
  MASTER_KEY="$(random_b64 32)"
  POSTGRES_PASSWORD="$(random_b64 24 | tr -d '/+=' | cut -c1-32)"
  SETUP_TOKEN="kn_setup_$(random_hex 24)"
  ALL_IN_ONE=false
  [ "$MODE" = "all-in-one" ] && ALL_IN_ONE=true

  umask 077
  cat >"$DATA_DIR/.env" <<ENV
# Written by the Kaname installer on $STAMP. Every value below was
# generated on this machine; none of it came with the software.
#
# Losing KANAME_MASTER_KEY means losing every credential Kaname stores
# for you. Back this file up somewhere the panel cannot reach.

KANAME_ENV=production
KANAME_VERSION=$REQ_VERSION
KANAME_DEPLOYMENT=compose
KANAME_COMPOSE_PROJECT=$KANAME_COMPOSE_PROJECT
KANAME_DATA_DIR=$DATA_DIR

KANAME_IMAGE_CONTROL_PLANE=$KANAME_REGISTRY/kaname-control-plane:$REQ_VERSION
KANAME_IMAGE_WEB=$KANAME_REGISTRY/kaname-web:$REQ_VERSION

KANAME_MASTER_KEY=$MASTER_KEY
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

# Empty until a domain is set from Administration in the panel. A
# __Host- prefixed cookie is never stored by a browser over plain HTTP,
# so secure cookies stay off until there is HTTPS to put them behind.
KANAME_DOMAIN=
KANAME_PUBLIC_URL=$PANEL_URL
KANAME_SECURE_COOKIES=false

# Consumed once, on first boot, to gate onboarding.
KANAME_SETUP_TOKEN=$SETUP_TOKEN
KANAME_ALL_IN_ONE=$ALL_IN_ONE
ENV
  # 0660, not 0640: the control plane rewrites this file itself when it
  # pins new image tags for an update.
  chmod 0660 "$DATA_DIR/.env"
  chown "root:$KANAME_UID" "$DATA_DIR/.env"
  log "    wrote $DATA_DIR/.env (0660 root:$KANAME_UID)"
}

# 5. Deployment files
fetch() {
  # $1 url, $2 destination
  log "    fetching $1"
  $CURL "$1" -o "$2.partial" || die "could not download $1"
  mv "$2.partial" "$2"
}

# `kaname`, the command that updates this host later (`sudo kaname
# update`). Swapped in with a rename, never rewritten in place: it may be
# the very script a shell is running. The source it came from is kept
# beside the host helper, so an update reads the same manifest this
# install did.
install_kaname_command() {
  mkdir -p "$LIB_DIR"
  printf '%s\n' "$KANAME_SOURCE_URL" >"$LIB_DIR/source"
  log "    fetching $KANAME_SOURCE_URL/infra/kaname.sh"
  $CURL "$KANAME_SOURCE_URL/infra/kaname.sh" -o "$BIN_DIR/kaname.new" 2>>"$LOG_FILE" ||
    { rm -f "$BIN_DIR/kaname.new"; return 1; }
  chmod 0755 "$BIN_DIR/kaname.new"
  mv "$BIN_DIR/kaname.new" "$BIN_DIR/kaname"
}

fetch_deployment() {
  step "Downloading files"
  mkdir -p "$LIB_DIR"
  fetch "$KANAME_SOURCE_URL/infra/docker-compose.yml" "$DATA_DIR/docker-compose.yml"
  fetch "$KANAME_SOURCE_URL/infra/kaname-host.sh" "$LIB_DIR/kaname-host.sh"
  chmod 0755 "$LIB_DIR/kaname-host.sh"
  install_kaname_command || die "could not download $KANAME_SOURCE_URL/infra/kaname.sh"

  # The Caddyfile is generated from .env rather than downloaded, so it
  # can never disagree with the configuration it is supposed to serve.
  "$LIB_DIR/kaname-host.sh" caddyfile "$DATA_DIR" >>"$LOG_FILE" 2>&1 ||
    die "could not generate $DATA_DIR/Caddyfile. See $LOG_FILE."
  log "    generated $DATA_DIR/Caddyfile"
  detail "compose${SEP}helpers${SEP}Caddyfile"
}

# 6. The host-side helper. A container cannot restart itself and still be
#    around to check whether the new build came up, so it does not try:
#    the control plane queues a request and this unit, on the host, does
#    the pull, the restart, the health check and the rollback.
install_host_units() {
  step "Installing host units"

  cat >/etc/systemd/system/kaname-update.service <<UNIT
[Unit]
Description=Apply a queued Kaname host request
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$LIB_DIR/kaname-host.sh apply $DATA_DIR
TimeoutStartSec=1800
UNIT

  cat >/etc/systemd/system/kaname-update.path <<UNIT
[Unit]
Description=Watch for a Kaname host request

[Path]
PathExists=$DATA_DIR/updates/queue/request.json
Unit=kaname-update.service

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now kaname-update.path >>"$LOG_FILE" 2>&1
  log "    kaname-update.path is watching $DATA_DIR/updates/queue"
  detail "kaname-update.path"
}

# 7. Deploy
# Read off "<layer>: <status>" lines on stdin (docker pull, not on a
# terminal) and redraw the bar. $1 images already pulled, $2 in all,
# $3 the image's short name. Fails unless the pull said it finished.
pull_progress() {
  _rc=1 _seen=" " _done=" " _total=0 _finished=0
  while IFS= read -r line; do
    printf '%s\n' "$line" >>"$LOG_FILE"
    [ "$line" != "__kaname_pulled" ] || { _rc=0; continue; }
    _id="${line%%: *}"
    case "$_id" in ''|*[!0-9a-f]*) continue ;; esac
    case "$_seen" in *" $_id "*) ;; *) _seen="$_seen$_id " _total=$((_total + 1)) ;; esac
    case "${line#*: }" in
      "Download complete"*|"Pull complete"*|"Already exists"*)
        case "$_done" in *" $_id "*) ;; *) _done="$_done$_id " _finished=$((_finished + 1)) ;; esac ;;
    esac
    bar_set $(( ($1 * 1000 + _finished * 1000 / _total) / $2 )) \
      $(( ($1 * 1000 + (_finished + 1) * 1000 / _total) / $2 )) "$3$SEP$_finished/$_total layers"
  done
  return "$_rc"
}

pull_images() {
  step "Pulling images"
  images="$(compose config --images 2>>"$LOG_FILE")" || images=""

  # No terminal to draw on, or a Compose too old to list its images:
  # one plain pull, as before.
  if [ "$UI" != 1 ] || [ -z "$images" ]; then
    compose pull >>"$LOG_FILE" 2>&1 ||
      die "could not pull the Kaname images. See $LOG_FILE."
    log "    images pulled"
    return 0
  fi

  names="" n=0
  for img in $images; do
    short="${img##*/}"; short="${short%%[:@]*}"; short="${short#kaname-}"
    names="${names:+$names$SEP}$short"
    n=$((n + 1))
  done
  detail "$names"
  bar_open "starting"

  i=0
  for img in $images; do
    short="${img##*/}"; short="${short%%[:@]*}"; short="${short#kaname-}"
    log "    pulling $img"
    { docker pull "$img" 2>&1 && echo "__kaname_pulled"; } | pull_progress "$i" "$n" "$short" ||
      die "could not pull $img. See $LOG_FILE."
    i=$((i + 1))
    bar_set $(( i * 1000 / n )) $(( i * 1000 / n )) "$i/$n images"
  done
  # Let the bar finish its run to 100% before the line settles.
  sleep 0.8 2>/dev/null || true
}

deploy() {
  step "Starting control plane"

  compose up -d --wait >>"$LOG_FILE" 2>&1 ||
    die "the containers did not become healthy. See $LOG_FILE, and:
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml ps
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"

  log "    containers are up"
  detail "$(compose ps -q 2>/dev/null | wc -l | tr -d ' ') containers healthy"
}

wait_for_api() {
  # $1 seconds
  i=0
  while [ "$i" -lt "$1" ]; do
    if curl -fsS "$KANAME_LOCAL_API/health" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# Reads one field ("url" or "sha256") of this host's agent artifact for
# release $1 out of versions.json ($2). The manifest is generated with
# one key per line (scripts/release-manifest.mjs), which is what lets
# awk stand in for a JSON parser on a host that may not have jq.
manifest_agent_field() {
  awk -v ver="$1" -v key="\"linux-$ARCH\"" -v field="\"$3\"" '
    /"version":/ { v = $2; gsub(/[",]/, "", v); inrel = (v == ver); inkey = 0 }
    inrel && index($0, key) { inkey = 1; next }
    inrel && inkey && index($0, field) {
      line = $0
      sub(/^[^:]*:[ \t]*"/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }
  ' "$2"
}

# Downloads release $REQ_VERSION's agent from its GitHub release into $1
# and leaves the manifest's digest for it in RELEASE_AGENT_SHA256.
fetch_release_agent() {
  log "    this control plane publishes no checksum; using the $REQ_VERSION release instead"
  manifest="$(dirname "$1")/versions.json"
  $CURL "$KANAME_SOURCE_URL/versions.json" -o "$manifest" ||
    die "could not download the release manifest from $KANAME_SOURCE_URL/versions.json."
  url="$(manifest_agent_field "$REQ_VERSION" "$manifest" url)"
  RELEASE_AGENT_SHA256="$(manifest_agent_field "$REQ_VERSION" "$manifest" sha256)"
  if [ -z "$url" ] || [ -z "$RELEASE_AGENT_SHA256" ]; then
    die "the release manifest has no linux-$ARCH agent for $REQ_VERSION."
  fi
  case "$url" in
    https://*) ;;
    *) die "the release manifest names a non-HTTPS agent URL ($url); refusing it." ;;
  esac
  log "    fetching kanamed $REQ_VERSION from $url"
  $CURL "$url" -o "$1" ||
    die "could not download the agent from $url."
}

# 8. The agent. Three steps that are each safe to repeat, because a
#    re-run has to be able to pick up wherever the last one stopped:
#    after the download, after enrollment, or after the unit was lost.
fetch_agent_binary() {
  # $1 control plane url
  tmp="$(mktemp -d)"
  log "    fetching kanamed (linux/$ARCH) from $1"
  $CURL "$1/download/kanamed-linux-$ARCH" -o "$tmp/kanamed" ||
    die "could not download the agent from $1/download/kanamed-linux-$ARCH.
The agent is served by the control plane itself, so this also means the
control plane is not reachable from here."

  # The binary runs as root on this host and, until a domain is set,
  # travelled over plain HTTP. The control plane publishes its digest
  # beside it; nothing is installed until the two agree.
  code="$(curl -sSL --retry 3 --retry-delay 2 --connect-timeout 15 \
    -o "$tmp/kanamed.sha256" -w '%{http_code}' \
    "$1/download/kanamed-linux-$ARCH.sha256" 2>>"$LOG_FILE")" || code=000
  case "$code" in
    200)
      expected="$(cut -d' ' -f1 "$tmp/kanamed.sha256")"
      source_desc="the checksum the control plane published"
      ;;
    404)
      # A control plane older than this script (0.1.0 and earlier) has
      # no checksum route. install.sh is served from main but pins the
      # last stable release, so that is the normal case right after a
      # release, not an attack. Take that release's agent from GitHub
      # instead, checked against the digest in the release manifest:
      # both come over HTTPS from the same place as this script.
      fetch_release_agent "$tmp/kanamed"
      expected="$RELEASE_AGENT_SHA256"
      source_desc="the digest in the $REQ_VERSION release manifest"
      ;;
    *)
      die "could not download the agent's checksum from $1/download/kanamed-linux-$ARCH.sha256 (HTTP $code)."
      ;;
  esac
  actual="$(sha256_of "$tmp/kanamed")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    die "the downloaded agent does not match $source_desc
(expected ${expected:-nothing}, got $actual). Nothing was installed. A truncated
download or something on the path between this host and $1 changed the file;
run this again, and if it repeats, look at what sits between the two."
  fi
  log "    checksum verified"

  # Stopped first: replacing a running binary in place is what breaks a
  # re-run halfway through.
  systemctl stop kanamed >/dev/null 2>&1 || true
  install -m 0755 "$tmp/kanamed" "$BIN_DIR/kanamed"
  rm -rf "$tmp"
}

enroll_agent() {
  # $1 control plane url, $2 pairing token
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  log "    enrolling with $1"
  "$BIN_DIR/kanamed" enroll --url "$1" --token "$2" --state-dir "$STATE_DIR" >>"$LOG_FILE" 2>&1 ||
    die "enrollment failed. See $LOG_FILE.
A pairing token is single-use and expires in minutes; generate a fresh one
in the panel under Infrastructure > Servers > Add server."
}

write_agent_unit() {
  cat >/etc/systemd/system/kanamed.service <<UNIT
[Unit]
Description=Kaname agent
Documentation=https://github.com/FutureForge-Studios/kaname
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN_DIR/kanamed run --state-dir $STATE_DIR
Restart=always
RestartSec=5
StateDirectory=kaname
StateDirectoryMode=0700

# The agent needs root to manage the host, but nothing beyond it.
NoNewPrivileges=yes
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=no
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native

# It dials out only; it never listens.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
}

start_agent() {
  systemctl enable --now kanamed >>"$LOG_FILE" 2>&1 ||
    die "kanamed did not start. See $LOG_FILE, and:
  systemctl status kanamed
  journalctl -u kanamed -n 100"
  log "    kanamed installed and started"
}

install_agent() {
  # $1 control plane url, $2 pairing token
  fetch_agent_binary "$1"
  enroll_agent "$1" "$2"
  write_agent_unit
  start_agent
  detail "kanamed enrolled"
}

# The all-in-one repair. Which of the three steps are missing is read off
# the disk, not off .env: a run that failed after the download, or a host
# whose unit or identity was lost, is fixed by running this again.
repair_local_agent() {
  step "Pairing this host"
  [ -x "$BIN_DIR/kanamed" ] || fetch_agent_binary "$KANAME_LOCAL_API"

  if [ ! -f "$STATE_DIR/cert.pem" ]; then
    if [ -n "$TOKEN" ]; then
      enroll_agent "$KANAME_LOCAL_API" "$TOKEN"
    elif setup_has_owner; then
      die "this host is not enrolled, and the setup token can no longer pair it because
an account already exists. Generate a pairing token in the panel under
Infrastructure > Servers > Add server, then run this again with --token=<token>."
    else
      pair_local_agent
    fi
  else
    log "    this host is already enrolled"
  fi

  write_agent_unit
  # Restarted, not merely started: the binary or the unit may be new.
  systemctl restart kanamed >>"$LOG_FILE" 2>&1 || start_agent
  log "    kanamed is running"
  detail "kanamed running as $(hostname -s)"
}

# Public by necessity: the panel asks the same question before anyone
# can be signed in.
setup_has_owner() {
  curl -fsS "$KANAME_LOCAL_API/api/v1/setup/state" 2>/dev/null | grep -q '"has_owner":true'
}

pair_local_agent() {
  log "    pairing this host as the first managed server"

  # The pairing token comes from the control plane that was just
  # started, authorised by the setup token this installer generated —
  # there is no account yet to sign in as.
  SETUP_TOKEN_VALUE="$(grep '^KANAME_SETUP_TOKEN=' "$DATA_DIR/.env" | cut -d= -f2-)"
  response="$(curl -fsS -X POST "$KANAME_LOCAL_API/api/v1/setup/pair" \
    -H 'content-type: application/json' \
    -H "x-kaname-setup-token: $SETUP_TOKEN_VALUE" \
    -d "{\"name\":\"$(hostname -s)\",\"hostname\":\"$(hostname -f 2>/dev/null || hostname)\"}" 2>>"$LOG_FILE")" || {
    if setup_has_owner; then
      die "the setup token cannot pair this host any more: an account already exists.
Generate a pairing token in the panel under Infrastructure > Servers > Add server,
then run this again with --token=<token>."
    fi
    die "the control plane refused to issue a pairing token. See $LOG_FILE."
  }

  # One field, one grep. Pulling in a JSON parser for this would be a
  # dependency nobody asked for.
  PAIR_TOKEN="$(printf '%s' "$response" | tr ',' '\n' | grep '"token"' | cut -d'"' -f4)"
  [ -n "$PAIR_TOKEN" ] || die "could not read the pairing token out of the control plane's answer."

  install_agent "$KANAME_LOCAL_API" "$PAIR_TOKEN"
}

# 9. Verification. "It installed" is not "it works", and a success banner
#    over a broken install is worse than no banner at all.
verify_agent() {
  step "Verifying the agent"
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS "$KANAME_LOCAL_API/health" 2>/dev/null | grep -q '"agents_connected":[1-9]'; then
      log "    agent is connected"
      detail "connected to the panel"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  die "the agent on this host did not connect within 60 seconds.
  systemctl status kanamed
  journalctl -u kanamed -n 100"
}

summary() {
  # Read back rather than reprint: on a repair the .env on disk is the
  # truth, and --version was not applied to it.
  url="$(grep '^KANAME_PUBLIC_URL=' "$DATA_DIR/.env" | cut -d= -f2-)"
  token="$(grep '^KANAME_SETUP_TOKEN=' "$DATA_DIR/.env" | cut -d= -f2-)"
  installed="$(grep '^KANAME_VERSION=' "$DATA_DIR/.env" | cut -d= -f2-)"

  step_end
  headline "Kaname $installed is running."
  kv "open" "$url" "$C_ACCENT$C_BOLD"
  kv "setup token" "$token" "$C_BOLD"
  say ""
  say "  The token is asked for once, on the first screen, and stops working as"
  say "  soon as an account exists."
  say ""
  kv "secrets" "$DATA_DIR/.env  (back up KANAME_MASTER_KEY)"
  kv "update" "sudo kaname update  (or Administration > Updates)"
  kv "install log" "$LOG_FILE"
  say ""
  say "  A domain and HTTPS can be set later from Administration in the panel."
  say "  $url keeps working after that."
}

# Run
if [ "$MODE" = "agent-only" ]; then
  [ -n "$TOKEN" ] || die "--agent-only needs --token=<pairing-token>, generated by the panel
under Infrastructure > Servers > Add server. Tokens are single-use and
expire in minutes."
  [ -n "$CONTROL_PLANE" ] || die "--agent-only needs --control-plane=<url>, the address this
agent should dial, e.g. http://203.0.113.10"

  open_log
  banner
  STEP_TOTAL=2
  preflight
  step "Installing the agent"
  install_agent "$CONTROL_PLANE" "$TOKEN"
  # The agent is what this run is for; a source that cannot be reached
  # only costs the update command, which a re-run puts back.
  install_kaname_command ||
    warn "could not install the kaname command from $KANAME_SOURCE_URL; re-run this to add it"
  step_end

  headline "kanamed is installed and dialling $CONTROL_PLANE."
  say "  It should appear in the panel within a few seconds."
  say ""
  kv "status" "systemctl status kanamed"
  kv "logs" "journalctl -u kanamed -f"
  [ ! -x "$BIN_DIR/kaname" ] || kv "update" "sudo kaname update"
  kv "install log" "$LOG_FILE"
  exit 0
fi

open_log
banner
STEP_TOTAL=9
[ "$MODE" != "all-in-one" ] || STEP_TOTAL=11

preflight
ensure_docker
check_existing
prepare_data_dir
fetch_deployment
install_host_units
pull_images
deploy

step "Waiting for the panel"
wait_for_api 90 ||
  die "the control plane did not answer $KANAME_LOCAL_API/health within 90 seconds.
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"
log "    control plane is answering"
detail "health check passed"

if [ "$MODE" = "all-in-one" ]; then
  # Whether to pair is decided by whether this host is actually
  # enrolled, not by whether .env exists: a run that wrote .env and then
  # failed to pair must still pair on the next run.
  repair_local_agent
  verify_agent
fi

summary
