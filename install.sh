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
# two files, both from KANAME_SOURCE_URL below, and prints each URL
# before it fetches it. Re-running it is a repair, never a wipe: --force
# is the only thing that destroys data, and it says what first.
# ==================================================================
set -eu

# The only place a URL is spelled out. Point these somewhere else and
# the whole installer follows.
KANAME_SOURCE_URL="${KANAME_SOURCE_URL:-https://raw.githubusercontent.com/FutureForge-Studios/kaname/main}"
KANAME_REGISTRY="${KANAME_REGISTRY:-ghcr.io/futureforge-studios}"
KANAME_DOCKER_INSTALL_URL="https://get.docker.com"

KANAME_DEFAULT_VERSION="0.1.0"
KANAME_MIN_DOCKER_MAJOR=24
KANAME_COMPOSE_PROJECT="kaname"

DATA_DIR="/etc/kaname"
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
kaname installer

  --control-plane-only     Install the control plane, do not pair an agent here.
  --agent-only             Install only the agent. Requires --token and --control-plane.
  --token=<token>          Pairing token, printed by the panel when adding a server.
  --control-plane=<url>    Where the agent should dial, e.g. http://203.0.113.10
  --version=<version>      Release to install. Defaults to the one this script ships with.
  --public-url=<url>       Address the panel is reached at, e.g. http://203.0.113.10 — for hosts
                           whose own interface carries a private address (cloud NAT).
                           KANAME_PUBLIC_URL in the environment does the same.
  --force                  Destroy an existing install first. Never the default.
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

# Everything said below goes to the terminal and to a log under the data
# root, so a failed install can be read afterwards without scrolling back.
LOG_FILE=""
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '%s\n' "$*"; [ -n "$LOG_FILE" ] && printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG_FILE"; return 0; }
step() { log ""; log "==> $*"; }
warn() { log "    !! $*"; }

die() {
  printf '\n%s\n' "kaname: $*" >&2
  [ -n "$LOG_FILE" ] && printf 'FAILED %s\n' "$*" >>"$LOG_FILE"
  [ -n "$LOG_FILE" ] && printf '%s\n' "The full log is at $LOG_FILE" >&2
  exit 1
}

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
  step "checking this host"

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

  log "    Linux/$ARCH${OS_ID:+ ($OS_ID)}, systemd present"
}

# Every download retries a few times and never hangs: a blip on the way
# to GitHub or to the panel is not a reason to leave an install half-done.
CURL="curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15"

# 2. Docker
ensure_docker() {
  step "checking Docker"

  if ! command -v docker >/dev/null 2>&1; then
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
}

# 3. Existing install. Re-running is a repair; only --force destroys, and
#    only after saying exactly what it is about to destroy.
check_existing() {
  [ -f "$DATA_DIR/.env" ] || return 0

  if [ "$FORCE" = "1" ]; then
    step "--force: removing the existing install"
    log "    this deletes:"
    log "      - the Kaname database, including every server, user and audit record"
    log "      - $DATA_DIR (secrets, rollback snapshots, logs)"
    log "      - the Compose project '$KANAME_COMPOSE_PROJECT' and its volumes"
    log "      - $STATE_DIR, this host's agent identity, which the new database would not know"
    log ""
    compose down -v >>"$LOG_FILE" 2>&1 || true
    systemctl stop kanamed >/dev/null 2>&1 || true
    # The log lives under here, so it is moved aside first.
    mv "$LOG_FILE" "/tmp/kaname-install-$STAMP.log" 2>/dev/null || true
    rm -rf "$DATA_DIR" "$STATE_DIR"
    open_log
    log "    removed."
    return 0
  fi

  step "found an existing install at $DATA_DIR"
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
  step "preparing $DATA_DIR"

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

fetch_deployment() {
  step "fetching the deployment files"
  mkdir -p "$LIB_DIR"
  fetch "$KANAME_SOURCE_URL/infra/docker-compose.yml" "$DATA_DIR/docker-compose.yml"
  fetch "$KANAME_SOURCE_URL/infra/kaname-host.sh" "$LIB_DIR/kaname-host.sh"
  chmod 0755 "$LIB_DIR/kaname-host.sh"

  # The Caddyfile is generated from .env rather than downloaded, so it
  # can never disagree with the configuration it is supposed to serve.
  "$LIB_DIR/kaname-host.sh" caddyfile "$DATA_DIR" >>"$LOG_FILE" 2>&1 ||
    die "could not generate $DATA_DIR/Caddyfile. See $LOG_FILE."
  log "    generated $DATA_DIR/Caddyfile"
}

# 6. The host-side helper. A container cannot restart itself and still be
#    around to check whether the new build came up, so it does not try:
#    the control plane queues a request and this unit, on the host, does
#    the pull, the restart, the health check and the rollback.
install_host_units() {
  step "installing the host helper units"

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
}

# 7. Deploy
deploy() {
  step "starting the control plane"

  compose pull >>"$LOG_FILE" 2>&1 ||
    die "could not pull the Kaname images. See $LOG_FILE."

  compose up -d --wait >>"$LOG_FILE" 2>&1 ||
    die "the containers did not become healthy. See $LOG_FILE, and:
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml ps
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"

  log "    containers are up"
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
  $CURL "$1/download/kanamed-linux-$ARCH.sha256" -o "$tmp/kanamed.sha256" ||
    die "could not download the agent's checksum from $1/download/kanamed-linux-$ARCH.sha256."
  expected="$(cut -d' ' -f1 "$tmp/kanamed.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/kanamed" | cut -d' ' -f1)"
  else
    actual="$(openssl dgst -sha256 -r "$tmp/kanamed" | cut -d' ' -f1)"
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    die "the downloaded agent does not match the checksum the control plane published
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
  step "installing the agent"
  fetch_agent_binary "$1"
  enroll_agent "$1" "$2"
  write_agent_unit
  start_agent
}

# The all-in-one repair. Which of the three steps are missing is read off
# the disk, not off .env: a run that failed after the download, or a host
# whose unit or identity was lost, is fixed by running this again.
repair_local_agent() {
  step "checking the agent on this host"
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
}

# Public by necessity: the panel asks the same question before anyone
# can be signed in.
setup_has_owner() {
  curl -fsS "$KANAME_LOCAL_API/api/v1/setup/state" 2>/dev/null | grep -q '"has_owner":true'
}

pair_local_agent() {
  step "pairing this host as the first managed server"

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
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS "$KANAME_LOCAL_API/health" 2>/dev/null | grep -q '"agents_connected":[1-9]'; then
      log "    agent is connected"
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

  printf '\n'
  log "Kaname $installed is running."
  log ""
  log "  Open           $url"
  log "  Setup token    $token"
  log ""
  log "The token is asked for once, on the first screen, and stops working as"
  log "soon as an account exists."
  log ""
  log "  Secrets        $DATA_DIR/.env  (back up KANAME_MASTER_KEY)"
  log "  Install log    $LOG_FILE"
  log ""
  log "A domain and HTTPS can be set later from Administration in the panel."
  log "$url keeps working after that."
}

# Run
if [ "$MODE" = "agent-only" ]; then
  [ -n "$TOKEN" ] || die "--agent-only needs --token=<pairing-token>, generated by the panel
under Infrastructure > Servers > Add server. Tokens are single-use and
expire in minutes."
  [ -n "$CONTROL_PLANE" ] || die "--agent-only needs --control-plane=<url>, the address this
agent should dial, e.g. http://203.0.113.10"

  open_log
  preflight
  install_agent "$CONTROL_PLANE" "$TOKEN"

  printf '\n'
  log "kanamed is installed and dialling $CONTROL_PLANE."
  log "It should appear in the panel within a few seconds."
  log ""
  log "  Status   systemctl status kanamed"
  log "  Logs     journalctl -u kanamed -f"
  log "  Log      $LOG_FILE"
  exit 0
fi

open_log
log "Kaname installer — $STAMP"
log "Source: $KANAME_SOURCE_URL"

preflight
ensure_docker
check_existing
prepare_data_dir
fetch_deployment
install_host_units
deploy

step "verifying"
wait_for_api 90 ||
  die "the control plane did not answer $KANAME_LOCAL_API/health within 90 seconds.
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"
log "    control plane is answering"

if [ "$MODE" = "all-in-one" ]; then
  # Whether to pair is decided by whether this host is actually
  # enrolled, not by whether .env exists: a run that wrote .env and then
  # failed to pair must still pair on the next run.
  repair_local_agent
  verify_agent
fi

summary
