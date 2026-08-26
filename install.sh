#!/bin/sh
# ==================================================================
# Kaname installer.
#
#   Control plane + an agent on this same box (the default):
#     curl -fsSL https://get.kaname.dev/install.sh | sudo sh
#
#   Control plane only:
#     curl -fsSL https://get.kaname.dev/install.sh | sudo sh -s -- --control-plane-only
#
#   Add another server to an existing install:
#     curl -fsSL https://get.kaname.dev/install.sh | sudo sh -s -- \
#       --agent-only --token=<pairing-token> --control-plane=https://panel.example.com
#
# This script is meant to be read before it is run. It fetches exactly
# three files, all from KANAME_SOURCE_URL below, and it says so as it
# goes. Nothing is downloaded from a URL that is not printed first.
#
# Re-running it is safe: an existing install is reconfigured and
# repaired, never wiped. --force is the only thing that destroys data,
# and it says what it is about to destroy first.
# ==================================================================
set -eu

# ------------------------------------------------------------------
# The only place a URL is spelled out. Point this somewhere else and
# the whole installer follows.
# ------------------------------------------------------------------
KANAME_SOURCE_URL="${KANAME_SOURCE_URL:-https://raw.githubusercontent.com/FutureForge-Studios/kaname/main}"
KANAME_REGISTRY="${KANAME_REGISTRY:-ghcr.io/futureforge-studios}"
KANAME_DOCKER_INSTALL_URL="https://get.docker.com"

KANAME_DEFAULT_VERSION="0.1.0"
KANAME_MIN_DOCKER_MAJOR=24
KANAME_COMPOSE_PROJECT="kaname"

# The control-plane image runs as this uid, fixed in its Dockerfile so
# the paths it has to write can be owned by it without running as root.
KANAME_UID=10001

# Where the control plane answers on the loopback interface. Caddy
# fronts 80/443; this is bound to 127.0.0.1 only, and is what the
# local agent dials and what this script health-checks.
KANAME_LOCAL_API="http://127.0.0.1:4000"

SUPPORTED_DISTROS="Debian 11+, Ubuntu 20.04+, Rocky/AlmaLinux/RHEL 9+, Fedora 38+"

# ------------------------------------------------------------------
# Options
# ------------------------------------------------------------------
MODE="all-in-one"          # all-in-one | control-plane-only | agent-only
VERSION="$KANAME_DEFAULT_VERSION"
DATA_DIR="/etc/kaname"
STATE_DIR="/var/lib/kaname"
BIN_DIR="/usr/local/bin"
LIB_DIR="/usr/local/lib/kaname"
DOMAIN=""
TOKEN=""
CONTROL_PLANE=""
FORCE=0
START=1
DEBUG=0

usage() {
  cat <<'USAGE'
kaname installer

  --control-plane-only     Install the control plane, do not pair an agent here.
  --agent-only             Install only the agent. Requires --token and --control-plane.
  --token=<token>          Pairing token, printed by the panel when adding a server.
  --control-plane=<url>    Where the agent should dial, e.g. https://panel.example.com
  --domain=<domain>        Public domain for the panel. Caddy gets a certificate for it.
  --version=<version>      Release to install. Defaults to the latest known to this script.
  --data-dir=<path>        Install root. Default /etc/kaname
  --force                  Destroy an existing install first. Never the default.
  --no-start               Write everything, start nothing.
  --debug                  Print every command as it runs.
  --help                   This.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --control-plane-only) MODE="control-plane-only" ;;
    --agent-only) MODE="agent-only" ;;
    --token) TOKEN="$2"; shift ;;
    --token=*) TOKEN="${1#*=}" ;;
    --control-plane) CONTROL_PLANE="$2"; shift ;;
    --control-plane=*) CONTROL_PLANE="${1#*=}" ;;
    # Accepted because the panel's older enrollment command used it.
    --url) CONTROL_PLANE="$2"; shift ;;
    --url=*) CONTROL_PLANE="${1#*=}" ;;
    --domain) DOMAIN="$2"; shift ;;
    --domain=*) DOMAIN="${1#*=}" ;;
    --version) VERSION="$2"; shift ;;
    --version=*) VERSION="${1#*=}" ;;
    --data-dir) DATA_DIR="$2"; shift ;;
    --data-dir=*) DATA_DIR="${1#*=}" ;;
    --state-dir) STATE_DIR="$2"; shift ;;
    --state-dir=*) STATE_DIR="${1#*=}" ;;
    --force) FORCE=1 ;;
    --no-start) START=0 ;;
    --debug) DEBUG=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "kaname: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ "$DEBUG" = "1" ] && set -x

# ------------------------------------------------------------------
# Output
#
# Everything goes to the terminal and to a log under the data root, so
# a failed install can be read afterwards without scrolling back.
# ------------------------------------------------------------------
LOG_FILE=""
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '%s\n' "$*"; [ -n "$LOG_FILE" ] && printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG_FILE"; return 0; }
step() { log ""; log "==> $*"; }
warn() { printf '%s\n' "$*" >&2; [ -n "$LOG_FILE" ] && printf '%s WARN %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG_FILE"; return 0; }

die() {
  printf '\n%s\n' "kaname: $*" >&2
  [ -n "$LOG_FILE" ] && printf 'FAILED %s\n' "$*" >>"$LOG_FILE"
  [ -n "$LOG_FILE" ] && printf '%s\n' "The full log is at $LOG_FILE" >&2
  printf '%s\n' "Nothing was left half-applied. Fix the above and run this installer again." >&2
  exit 1
}

open_log() {
  mkdir -p "$DATA_DIR/logs"
  chmod 0700 "$DATA_DIR" "$DATA_DIR/logs"
  LOG_FILE="$DATA_DIR/logs/install-$STAMP.log"
  : >"$LOG_FILE"
  chmod 0600 "$LOG_FILE"
}

# ------------------------------------------------------------------
# 1. Preflight
#
# Fail here, loudly, rather than part-way through. Everything below
# assumes a systemd host on a supported architecture.
# ------------------------------------------------------------------
preflight() {
  step "checking this host"

  [ "$(id -u)" = "0" ] || die "run this as root (prefix the command with sudo)."

  case "$(uname -s)" in
    Linux) : ;;
    *) die "Kaname manages Linux servers and its agent is a Linux binary. This is $(uname -s).
Supported: $SUPPORTED_DISTROS" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $(uname -m). Kaname publishes amd64 and arm64 builds only." ;;
  esac

  command -v systemctl >/dev/null 2>&1 ||
    die "systemd is required. The agent runs as a systemd unit, and control-plane updates are
applied by a systemd unit on the host.
Supported: $SUPPORTED_DISTROS"

  DISTRO_ID="unknown"; DISTRO_VERSION=""; DISTRO_NAME="this system"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-}"
    DISTRO_NAME="${PRETTY_NAME:-$DISTRO_ID}"
  fi

  case "$DISTRO_ID" in
    debian|ubuntu|raspbian|rocky|almalinux|rhel|centos|fedora) : ;;
    *)
      warn "$DISTRO_NAME is not a distribution Kaname is tested on."
      warn "Tested: $SUPPORTED_DISTROS"
      warn "Continuing, because the requirements below are what actually matter:"
      warn "  systemd, Docker $KANAME_MIN_DOCKER_MAJOR or newer, and the Compose plugin."
      ;;
  esac

  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required and is not installed."
  done

  log "    $DISTRO_NAME ($ARCH), systemd present"
}

# ------------------------------------------------------------------
# 2. Docker
# ------------------------------------------------------------------
ensure_docker() {
  step "checking Docker"

  if ! command -v docker >/dev/null 2>&1; then
    log "    not installed; fetching the official installer from $KANAME_DOCKER_INSTALL_URL"
    curl -fsSL "$KANAME_DOCKER_INSTALL_URL" -o /tmp/get-docker.sh ||
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

# ------------------------------------------------------------------
# 3. Existing install
#
# Re-running is a repair, not a reinstall. Only --force destroys, and
# only after saying exactly what it is about to destroy.
# ------------------------------------------------------------------
REPAIR=0

check_existing() {
  [ -f "$DATA_DIR/.env" ] || return 0

  if [ "$FORCE" = "1" ]; then
    step "--force: removing the existing install"
    log "    this deletes:"
    log "      - the Kaname database, including every server, user and audit record"
    log "      - $DATA_DIR (secrets, rollback snapshots, logs)"
    log "      - the Compose project '$KANAME_COMPOSE_PROJECT' and its volumes"
    log "    the agent on this host and its identity in $STATE_DIR are left alone."
    log ""
    docker compose -p "$KANAME_COMPOSE_PROJECT" -f "$DATA_DIR/docker-compose.yml" down -v >>"$LOG_FILE" 2>&1 || true
    # The log lives under here, so it is moved aside first.
    mv "$LOG_FILE" "/tmp/kaname-install-$STAMP.log" 2>/dev/null || true
    rm -rf "$DATA_DIR"
    open_log
    log "    removed."
    return 0
  fi

  REPAIR=1
  step "found an existing install at $DATA_DIR"
  log "    re-running as a reconfigure and repair: existing secrets and data are kept,"
  log "    the deployment files and units are refreshed, and the services are restarted."
  log "    to wipe and start over instead, re-run with --force."
}

# ------------------------------------------------------------------
# 4. Data root and secrets
#
# Every secret comes from openssl's CSPRNG. There is no default value
# for any of them, and none of them is ever printed except the setup
# token, which is single-purpose and dies when an account is created.
# ------------------------------------------------------------------
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
    return 0
  fi

  log "    generating secrets with openssl rand"
  MASTER_KEY="$(random_b64 32)"
  POSTGRES_PASSWORD="$(random_b64 24 | tr -d '/+=' | cut -c1-32)"
  SETUP_TOKEN="kn_setup_$(random_hex 24)"

  PUBLIC_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$DOMAIN" ] && PUBLIC_URL="https://$DOMAIN"

  umask 077
  cat >"$DATA_DIR/.env" <<ENV
# Written by the Kaname installer on $STAMP. Every value below was
# generated on this machine; none of it came with the software.
#
# Losing KANAME_MASTER_KEY means losing every credential Kaname stores
# for you. Back this file up somewhere the panel cannot reach.

KANAME_ENV=production
KANAME_VERSION=$VERSION
KANAME_DEPLOYMENT=compose
KANAME_COMPOSE_PROJECT=$KANAME_COMPOSE_PROJECT
KANAME_DATA_DIR=$DATA_DIR

KANAME_IMAGE_CONTROL_PLANE=$KANAME_REGISTRY/kaname-control-plane:$VERSION
KANAME_IMAGE_WEB=$KANAME_REGISTRY/kaname-web:$VERSION

KANAME_MASTER_KEY=$MASTER_KEY
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

KANAME_DOMAIN=${DOMAIN:-localhost}
KANAME_PUBLIC_URL=$PUBLIC_URL

# Consumed once, on first boot, to gate onboarding.
KANAME_SETUP_TOKEN=$SETUP_TOKEN
KANAME_ALL_IN_ONE=$([ "$MODE" = "all-in-one" ] && echo true || echo false)
ENV
  chmod 0640 "$DATA_DIR/.env"
  chown "root:$KANAME_UID" "$DATA_DIR/.env"
  log "    wrote $DATA_DIR/.env (0640 root:$KANAME_UID)"
}

# ------------------------------------------------------------------
# 5. Deployment files
# ------------------------------------------------------------------
fetch() {
  # $1 url, $2 destination
  log "    fetching $1"
  curl -fsSL "$1" -o "$2.partial" || die "could not download $1"
  mv "$2.partial" "$2"
}

fetch_deployment() {
  step "fetching the deployment files"
  fetch "$KANAME_SOURCE_URL/infra/docker-compose.yml" "$DATA_DIR/docker-compose.yml"
  fetch "$KANAME_SOURCE_URL/infra/Caddyfile" "$DATA_DIR/Caddyfile"
  fetch "$KANAME_SOURCE_URL/infra/kaname-update.sh" "$LIB_DIR/kaname-update.sh"
  chmod 0755 "$LIB_DIR/kaname-update.sh"
}

# ------------------------------------------------------------------
# 6. The host-side updater
#
# A container cannot restart itself and still be around to check
# whether the new build came up — so it does not try. The control plane
# writes a request into the queue directory and this unit, running on
# the host, does the pull, the restart, the health check and the
# rollback.
# ------------------------------------------------------------------
install_updater() {
  step "installing the update helper"

  cat >/etc/systemd/system/kaname-update.service <<UNIT
[Unit]
Description=Apply a Kaname control-plane update
Documentation=$KANAME_SOURCE_URL/infra/kaname-update.sh
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$LIB_DIR/kaname-update.sh $DATA_DIR
TimeoutStartSec=1800
UNIT

  cat >/etc/systemd/system/kaname-update.path <<UNIT
[Unit]
Description=Watch for a Kaname update request

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

# ------------------------------------------------------------------
# 7. Deploy
# ------------------------------------------------------------------
deploy() {
  step "starting the control plane"

  if [ "$START" = "0" ]; then
    log "    --no-start: everything is written, nothing was started."
    log "    start it with: docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml up -d"
    return 0
  fi

  ( cd "$DATA_DIR" && docker compose -p "$KANAME_COMPOSE_PROJECT" pull ) >>"$LOG_FILE" 2>&1 ||
    die "could not pull the Kaname images. See $LOG_FILE.
If this is an air-gapped host, load the images yourself and re-run with --no-start."

  ( cd "$DATA_DIR" && docker compose -p "$KANAME_COMPOSE_PROJECT" up -d --wait ) >>"$LOG_FILE" 2>&1 ||
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

# ------------------------------------------------------------------
# 8. The agent
# ------------------------------------------------------------------
install_agent() {
  # $1 control plane url, $2 pairing token
  step "installing the agent"

  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"

  tmp="$(mktemp -d)"
  log "    fetching kanamed (linux/$ARCH) from $1"
  curl -fsSL "$1/download/kanamed-linux-$ARCH" -o "$tmp/kanamed" ||
    die "could not download the agent from $1/download/kanamed-linux-$ARCH.
The agent is served by the control plane itself, so this also means the
control plane is not reachable from here."
  chmod 0755 "$tmp/kanamed"

  # Stopped first: replacing a running binary in place is what breaks a
  # re-run halfway through.
  systemctl stop kanamed >/dev/null 2>&1 || true
  install -m 0755 "$tmp/kanamed" "$BIN_DIR/kanamed"
  rm -rf "$tmp"

  log "    enrolling with $1"
  "$BIN_DIR/kanamed" enroll --url "$1" --token "$2" --state-dir "$STATE_DIR" >>"$LOG_FILE" 2>&1 ||
    die "enrollment failed. See $LOG_FILE.
A pairing token is single-use and expires in minutes; generate a fresh one
in the panel under Infrastructure > Servers > Add server."

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
  systemctl enable --now kanamed >>"$LOG_FILE" 2>&1
  log "    kanamed installed and started"
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
    -d "{\"name\":\"$(hostname -s)\",\"hostname\":\"$(hostname -f 2>/dev/null || hostname)\"}" 2>>"$LOG_FILE")" ||
    die "the control plane refused to issue a pairing token. See $LOG_FILE."

  # One field, one grep. Pulling in a JSON parser for this would be a
  # dependency nobody asked for.
  PAIR_TOKEN="$(printf '%s' "$response" | tr ',' '\n' | grep '"token"' | cut -d'"' -f4)"
  [ -n "$PAIR_TOKEN" ] || die "could not read the pairing token out of the control plane's answer."

  install_agent "$KANAME_LOCAL_API" "$PAIR_TOKEN"
}

# ------------------------------------------------------------------
# 9. Verification
#
# "It installed" is not the same as "it works", and printing a success
# banner for a broken install is worse than printing nothing.
# ------------------------------------------------------------------
verify() {
  step "verifying"

  wait_for_api 90 ||
    die "the control plane did not answer $KANAME_LOCAL_API/health within 90 seconds.
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"
  log "    control plane is answering"

  if [ "$MODE" = "all-in-one" ]; then
    i=0
    connected=0
    while [ "$i" -lt 60 ]; do
      if curl -fsS "$KANAME_LOCAL_API/health" 2>/dev/null | grep -q '"agents_connected":[1-9]'; then
        connected=1
        break
      fi
      i=$((i + 1))
      sleep 1
    done
    [ "$connected" = "1" ] ||
      die "the agent on this host did not connect within 60 seconds.
  systemctl status kanamed
  journalctl -u kanamed -n 100"
    log "    agent is connected"
  fi
}

summary() {
  url="$(grep '^KANAME_PUBLIC_URL=' "$DATA_DIR/.env" | cut -d= -f2-)"
  token="$(grep '^KANAME_SETUP_TOKEN=' "$DATA_DIR/.env" | cut -d= -f2-)"

  printf '\n'
  log "Kaname $VERSION is running."
  log ""
  log "  Open           $url"
  log "  Setup token    $token"
  log ""
  log "The token is asked for once, on the first screen, and stops working as"
  log "soon as an account exists. Until then it is the only thing standing"
  log "between this panel and whoever else can reach it."
  log ""
  log "  Secrets        $DATA_DIR/.env  (0600 — back up KANAME_MASTER_KEY)"
  log "  Deployment     $DATA_DIR/docker-compose.yml"
  log "  Install log    $LOG_FILE"
  log ""
  log "  Logs           docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs -f"
  if [ "$MODE" = "all-in-one" ]; then
    log "  Agent          systemctl status kanamed"
  fi
}

# ------------------------------------------------------------------
# Run
# ------------------------------------------------------------------
if [ "$MODE" = "agent-only" ]; then
  [ -n "$TOKEN" ] || die "--agent-only needs --token=<pairing-token>, generated by the panel
under Infrastructure > Servers > Add server. Tokens are single-use and
expire in minutes."
  [ -n "$CONTROL_PLANE" ] || die "--agent-only needs --control-plane=<url>, the address this
agent should dial, e.g. https://panel.example.com"

  DATA_DIR="${DATA_DIR}"
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
mkdir -p "$LIB_DIR"
fetch_deployment
install_updater
deploy

if [ "$START" = "0" ]; then
  log ""
  log "Nothing was started. Everything is in $DATA_DIR."
  exit 0
fi

wait_for_api 90 ||
  die "the control plane did not come up. See $LOG_FILE and:
  docker compose -p $KANAME_COMPOSE_PROJECT -f $DATA_DIR/docker-compose.yml logs control-plane"

if [ "$MODE" = "all-in-one" ] && [ "$REPAIR" = "0" ]; then
  pair_local_agent
elif [ "$MODE" = "all-in-one" ]; then
  log ""
  log "==> this host is already paired; leaving the agent as it is"
  systemctl restart kanamed >/dev/null 2>&1 || true
fi

verify
summary
