#!/usr/bin/env bash
#
# RackDeck installer and updater.
#
# This script is the host-side deployment owner. It is installed as `homelabmd` and is
# deliberately outside the application container: the product is read-only and never mounts
# the Docker socket or replaces its own container.
#
# Supported commands:
#   install   create or repair a deployment
#   update    move an existing deployment to an exact release
#   rollback  restore the previous compose and environment, or a named version
#   status    report what is deployed
#
# The compose file is the contract. The version lives in HOMELABMD_IMAGE_TAG in the
# environment file, and every mutation is preceded by a backup.

set -euo pipefail

SCRIPT_VERSION="1.0.0"
DEFAULT_REPOSITORY="Kaquely/RackDeck"
DEFAULT_IMAGE_REPOSITORY="ghcr.io/kaquely/rackdeck"
DEFAULT_PREFIX="/opt/homelabmd"
CASAOS_PREFIX="/var/lib/casaos/apps/homelabmd"
LOCK_FILE_NAME=".update.lock"

COMMAND="install"
if [[ $# -gt 0 && "$1" != -* ]]; then
  COMMAND="$1"
  shift
fi

TARGET_VERSION=""
REPOSITORY="$DEFAULT_REPOSITORY"
IMAGE_REPOSITORY="$DEFAULT_IMAGE_REPOSITORY"
IMAGE_REPOSITORY_SET=0
IMAGE_REF=""
PREFIX=""
PREFIX_SET=0
CASAOS=0
ROLE=""
ROLE_SET=0
PUBLISH=""
PEER_ID=""
PEER_TOKEN_FILE=""
MEMORY_LIMIT=""
MEMORY_RESERVATION=""
DRY_RUN=0
JSON=0
FORCE=0
ALLOW_MAJOR=0
CHECK=0
NO_START=0
NO_PULL=0
REPLACE_OWNER=0

TMP_DIR=""
ASSET_DIR=""
COMPOSE_FILE=""
ENV_FILE=""
CLI_PATH=""
BACKUP_DIR=""
FROM_VERSION=""
DIGEST=""
EXPECTED_VERSION=""
LOCK_FD=""

cleanup() {
  if declare -F release_lock >/dev/null 2>&1; then
    release_lock
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

log() {
  printf '[homelabmd] %s\n' "$*" >&2
}

warn() {
  printf '[homelabmd] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[homelabmd] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
RackDeck installer and updater.

Usage:
  install.sh install [options]
  install.sh update [options]
  install.sh rollback [options]
  install.sh status [--json]

Options:
  --version X.Y.Z          Exact release to install (default: latest release)
  --to X.Y.Z               Exact target for update or rollback
  --image REF              Full image reference for local/pre-release testing
  --repository OWNER/NAME  GitHub repository that publishes releases
  --image-repository REF   Container repository (default: ghcr.io/kaquely/rackdeck)
  --prefix PATH            Deployment directory (default: /opt/homelabmd)
  --casaos                 Use the CasaOS app directory as the compose owner
  --role main|peer         Node role (default: preserve, otherwise main)
  --publish PORT           Host port (default: 3000)
  --peer-id ID             Stable peer id (peer role only)
  --peer-token-file FILE   Read the peer token from a file instead of generating one
  --memory-limit SIZE      Container memory limit (default: 300m, or 128m for peer)
  --memory-reservation SIZE Soft reservation (default: 192m, or 64m for peer)
  --check                  With update: report whether a newer release exists
  --dry-run                Print the plan without changing the host
  --json                   Emit machine-readable output
  --yes                    Do not prompt
  --force                  Reinstall or update even when the target is current
  --allow-major            Permit an update across a major version
  --replace-owner          Replace a deployment owned by another compose file
  --no-start               Write the deployment files but do not pull or start
  --no-pull                Do not pull the image (local image testing)
  --help                   Show this help
USAGE
}

abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$option requires a value"
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ $# -ge 2 && "$2" != -* ]]; then
        TARGET_VERSION="$2"
        shift 2
      else
        printf '%s\n' "$SCRIPT_VERSION"
        exit 0
      fi
      ;;
    --to)
      TARGET_VERSION="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --image)
      IMAGE_REF="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --repository)
      REPOSITORY="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --image-repository)
      IMAGE_REPOSITORY="$(require_value "$1" "${2:-}")"
      IMAGE_REPOSITORY_SET=1
      shift 2
      ;;
    --prefix)
      PREFIX="$(require_value "$1" "${2:-}")"
      PREFIX_SET=1
      shift 2
      ;;
    --casaos)
      CASAOS=1
      shift
      ;;
    --role)
      ROLE="$(require_value "$1" "${2:-}")"
      ROLE_SET=1
      shift 2
      ;;
    --publish|--port)
      PUBLISH="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --peer-id)
      PEER_ID="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --peer-token-file)
      PEER_TOKEN_FILE="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --memory-limit)
      MEMORY_LIMIT="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --memory-reservation)
      MEMORY_RESERVATION="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --check)
      CHECK=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --json)
      JSON=1
      shift
      ;;
    --yes|-y)
      # The installer never prompts; accept the flag for non-interactive scripts.
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --allow-major)
      ALLOW_MAJOR=1
      shift
      ;;
    --replace-owner)
      REPLACE_OWNER=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --no-pull)
      NO_PULL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$COMMAND" in
  install|update|rollback|status) ;;
  help) usage; exit 0 ;;
  *) die "unknown command: $COMMAND" ;;
esac

if [[ -n "$IMAGE_REF" && -n "$TARGET_VERSION" ]]; then
  die "--image and --version/--to are mutually exclusive"
fi

if [[ $CASAOS -eq 1 ]]; then
  [[ $PREFIX_SET -eq 1 ]] && die "--casaos and --prefix are mutually exclusive"
  PREFIX="$CASAOS_PREFIX"
  COMPOSE_FILE="$PREFIX/docker-compose.yml"
else
  PREFIX="${PREFIX:-$DEFAULT_PREFIX}"
  COMPOSE_FILE="$PREFIX/compose.yaml"
fi
PREFIX="$(abspath "$PREFIX")"
PREFIX="${PREFIX%/}"
COMPOSE_FILE="$PREFIX/$(basename "$COMPOSE_FILE")"
ENV_FILE="$PREFIX/.env"

if [[ $EUID -eq 0 ]]; then
  CLI_PATH="/usr/local/bin/homelabmd"
else
  CLI_PATH="$PREFIX/homelabmd"
fi

env_value() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]]; then
    sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
  fi
}

current_version() {
  local value
  value="$(env_value HOMELABMD_IMAGE_TAG || true)"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    docker inspect homelabmd --format '{{.Config.Image}}' 2>/dev/null \
      | sed 's/.*://' || true
  fi
}

validate_version() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] \
    || die "invalid version '$value' (expected X.Y.Z)"
}

major_of() {
  printf '%s' "${1%%.*}"
}

version_gt() {
  local left="$1"
  local right="$2"
  [[ "$left" != "$right" ]] || return 1
  local highest
  highest="$(printf '%s\n%s\n' "$left" "$right" | sort -V | tail -n 1)"
  [[ "$highest" == "$left" ]]
}

parse_image_ref() {
  local ref="$1"
  [[ "$ref" == *"@"* ]] && die "digest image references are not supported; use repository:tag"
  local last="${ref##*/}"
  [[ "$last" == *:* ]] || die "image reference '$ref' must include an explicit tag"
  local tag="${last##*:}"
  local repo="${ref%:*}"
  [[ -n "$repo" && -n "$tag" ]] || die "image reference '$ref' is incomplete"
  [[ "$tag" != "latest" ]] || die "'latest' is not an allowed image tag"
  IMAGE_REPOSITORY="$repo"
  IMAGE_REPOSITORY_SET=1
  TARGET_VERSION="$tag"
}

json_string() {
  local file="$1"
  local key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

download() {
  local url="$1"
  local destination="$2"
  local args=(-fsSL)
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  curl "${args[@]}" "$url" -o "$destination"
}

latest_release_version() {
  local api="https://api.github.com/repos/${REPOSITORY}/releases/latest"
  local args=(-fsSL -H "Accept: application/vnd.github+json")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  local tag
  tag="$(curl "${args[@]}" "$api" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1 || true)"
  [[ -n "$tag" ]] || die "could not resolve the latest release for ${REPOSITORY}; pass --version or --image"
  printf '%s' "${tag#v}"
}

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

verify_checksums() {
  local sums="$ASSET_DIR/SHA256SUMS"
  [[ -f "$sums" ]] || die "release is missing SHA256SUMS"
  local name expected actual
  for name in install.sh compose.yaml release.json; do
    expected="$(awk -v file="$name" '$2 == file { print $1; exit }' "$sums")"
    [[ -n "$expected" ]] || die "SHA256SUMS does not list $name"
    actual="$(sha256_of "$ASSET_DIR/$name")"
    [[ "$actual" == "$expected" ]] || die "checksum mismatch for $name"
  done
}

fetch_release_assets() {
  ASSET_DIR="$TMP_DIR/assets"
  mkdir -p "$ASSET_DIR"
  local base="${HOMELABMD_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/download}"
  base="${base%/}"
  base="${base}/v${TARGET_VERSION}"
  local name
  for name in release.json compose.yaml install.sh SHA256SUMS; do
    download "${base}/${name}" "$ASSET_DIR/${name}" \
      || die "could not download ${name} for v${TARGET_VERSION} from ${REPOSITORY}"
  done
  verify_checksums
}

parse_manifest() {
  local manifest="$ASSET_DIR/release.json"
  local manifest_version manifest_repo manifest_tag manifest_image manifest_digest
  manifest_version="$(json_string "$manifest" version)"
  manifest_repo="$(json_string "$manifest" image_repository)"
  manifest_tag="$(json_string "$manifest" image_tag)"
  manifest_image="$(json_string "$manifest" image)"
  manifest_digest="$(json_string "$manifest" digest)"

  [[ -n "$manifest_version" ]] || die "release.json has no version"
  [[ "$manifest_version" == "$TARGET_VERSION" ]] \
    || die "release.json version '${manifest_version}' does not match '${TARGET_VERSION}'"
  [[ -n "$manifest_digest" ]] || die "release.json has no image digest"

  if [[ -z "$manifest_repo" || -z "$manifest_tag" ]]; then
    [[ -n "$manifest_image" ]] || die "release.json has no image reference"
    local image_last="${manifest_image##*/}"
    [[ "$image_last" == *:* ]] || die "release.json image has no tag"
    manifest_tag="${image_last##*:}"
    manifest_repo="${manifest_image%:*}"
  fi

  [[ "$manifest_tag" == "$TARGET_VERSION" ]] \
    || die "release.json image tag '${manifest_tag}' does not match '${TARGET_VERSION}'"
  IMAGE_REPOSITORY="$manifest_repo"
  IMAGE_REPOSITORY_SET=1
  DIGEST="$manifest_digest"
}

resolve_release() {
  if [[ -n "$IMAGE_REF" ]]; then
    parse_image_ref "$IMAGE_REF"
    EXPECTED_VERSION=""
    NO_PULL=1
    log "using local image ${IMAGE_REPOSITORY}:${TARGET_VERSION}"
    return 0
  fi

  if [[ -z "$TARGET_VERSION" ]]; then
    TARGET_VERSION="$(latest_release_version)"
  fi
  TARGET_VERSION="${TARGET_VERSION#v}"
  validate_version "$TARGET_VERSION"
  EXPECTED_VERSION="$TARGET_VERSION"
  if [[ $IMAGE_REPOSITORY_SET -eq 0 ]]; then
    local existing_repo
    existing_repo="$(env_value HOMELABMD_IMAGE_REPOSITORY || true)"
    if [[ -n "$existing_repo" ]]; then
      IMAGE_REPOSITORY="$existing_repo"
    fi
  fi
  fetch_release_assets
  parse_manifest
  log "target release ${TARGET_VERSION} (${IMAGE_REPOSITORY}:${TARGET_VERSION})"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is required but was not found"
  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2 is required ('docker compose version' failed)"
  command -v curl >/dev/null 2>&1 || die "curl is required but was not found"
  command -v flock >/dev/null 2>&1 || die "flock is required but was not found"
}

ensure_directory() {
  if [[ ! -d "$PREFIX" ]]; then
    install -d -m 0755 "$PREFIX" || die "could not create ${PREFIX}"
  fi
}

acquire_lock() {
  local lock_file="${PREFIX}/${LOCK_FILE_NAME}"
  exec {LOCK_FD}>"$lock_file"
  if ! flock -n "$LOCK_FD"; then
    exec {LOCK_FD}>&-
    LOCK_FD=""
    die "another RackDeck operation is already running (lock: ${lock_file})"
  fi
}

release_lock() {
  if [[ -n "$LOCK_FD" ]]; then
    flock -u "$LOCK_FD" 2>/dev/null || true
    exec {LOCK_FD}>&-
    LOCK_FD=""
  fi
}

backup_deployment() {
  [[ -f "$COMPOSE_FILE" || -f "$ENV_FILE" ]] || return 0
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_DIR="$PREFIX/backups/$stamp"
  install -d -m 0700 "$BACKUP_DIR"
  [[ -f "$COMPOSE_FILE" ]] && { cp -p "$COMPOSE_FILE" "$BACKUP_DIR/$(basename "$COMPOSE_FILE")" || die "cannot back up ${COMPOSE_FILE}; check its permissions"; }
  [[ -f "$ENV_FILE" ]] && { cp -p "$ENV_FILE" "$BACKUP_DIR/.env" || die "cannot back up ${ENV_FILE}; check its permissions"; }
  log "backup written to ${BACKUP_DIR}"
}

write_compose() {
  local destination="$1"
  local temporary="${destination}.tmp.$$"
  if [[ -n "$ASSET_DIR" && -f "$ASSET_DIR/compose.yaml" ]]; then
    cp "$ASSET_DIR/compose.yaml" "$temporary"
  else
    cat > "$temporary" <<'YAML'
name: homelabmd

services:
  homelabmd:
    image: ${HOMELABMD_IMAGE_REPOSITORY:-ghcr.io/kaquely/rackdeck}:${HOMELABMD_IMAGE_TAG:?set HOMELABMD_IMAGE_TAG}
    container_name: homelabmd
    restart: unless-stopped
    ports:
      - "${HOMELABMD_PUBLISH:-3000}:3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      HOMELABMD_HOST: "${HOMELABMD_HOST:-0.0.0.0}"
      HOMELABMD_ROLE: "${HOMELABMD_ROLE:-main}"
      HOMELABMD_METRICS_INTERVAL_MS: "${HOMELABMD_METRICS_INTERVAL_MS:-500}"
      HOMELABMD_HISTORY_LENGTH: "${HOMELABMD_HISTORY_LENGTH:-600}"
      HOMELABMD_DATA_DIR: /data
      HOMELABMD_STATIC_DIR: /app/dist/web
      HOMELABMD_JSON_BODY_LIMIT: "${HOMELABMD_JSON_BODY_LIMIT:-256kb}"
      HOMELABMD_LAYOUT_FILE: "${HOMELABMD_LAYOUT_FILE:-layout.json}"
      HOMELABMD_PEERS_FILE: "${HOMELABMD_PEERS_FILE:-peers.json}"
      HOMELABMD_REMOTE_NODE_URLS: "${HOMELABMD_REMOTE_NODE_URLS:-}"
      HOMELABMD_REMOTE_NODE_LABELS: "${HOMELABMD_REMOTE_NODE_LABELS:-}"
      HOMELABMD_REMOTE_NODE_TOKENS: "${HOMELABMD_REMOTE_NODE_TOKENS:-}"
      HOMELABMD_REMOTE_NODE_TIMEOUT_MS: "${HOMELABMD_REMOTE_NODE_TIMEOUT_MS:-5000}"
      HOMELABMD_PEER_ID: "${HOMELABMD_PEER_ID:-}"
      HOMELABMD_PEER_TOKEN: "${HOMELABMD_PEER_TOKEN:-}"
      HOMELABMD_PEER_ALLOWED_IPS: "${HOMELABMD_PEER_ALLOWED_IPS:-}"
      HOMELABMD_PIHOLE_URL: "${HOMELABMD_PIHOLE_URL:-}"
      HOMELABMD_PIHOLE_PASSWORD: "${HOMELABMD_PIHOLE_PASSWORD:-}"
      HOMELABMD_PIHOLE_TIMEOUT_MS: "${HOMELABMD_PIHOLE_TIMEOUT_MS:-5000}"
      HOMELABMD_PIHOLE_TOP_N: "${HOMELABMD_PIHOLE_TOP_N:-10}"
      HOMELABMD_PIHOLE_TABLES_INTERVAL_MS: "${HOMELABMD_PIHOLE_TABLES_INTERVAL_MS:-10000}"
      HOMELABMD_PIHOLE_LABEL: "${HOMELABMD_PIHOLE_LABEL:-Pi-hole}"
      HOMELABMD_UPDATE_CHECK: "${HOMELABMD_UPDATE_CHECK:-github}"
      HOMELABMD_UPDATE_CHANNEL: "${HOMELABMD_UPDATE_CHANNEL:-stable}"
      HOMELABMD_UPDATE_CHECK_INTERVAL_MS: "${HOMELABMD_UPDATE_CHECK_INTERVAL_MS:-21600000}"
      HOMELABMD_UPDATE_REPOSITORY: "${HOMELABMD_UPDATE_REPOSITORY:-Kaquely/RackDeck}"
    volumes:
      - homelabmd-data:/data
    mem_limit: ${HOMELABMD_MEMORY_LIMIT:-300m}
    mem_reservation: ${HOMELABMD_MEMORY_RESERVATION:-192m}
    stop_grace_period: 15s
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  homelabmd-data:
    name: homelabmd-data
    external: true

networks:
  default:
    name: homelabmd_default
YAML
  fi

  if [[ $CASAOS -eq 1 ]]; then
    cat >> "$temporary" <<'YAML'

x-casaos:
  architectures:
    - amd64
    - arm64
  author: Kaquely
  category: Utilities
  description:
    en_us: Read-only, real-time dashboard for a homelab.
  developer: Kaquely
  icon: https://raw.githubusercontent.com/Kaquely/RackDeck/main/deploy/casaos/icon.svg
  main: homelabmd
  port_map: "3000"
  scheme: http
  store_app_id: homelabmd
  tagline:
    en_us: Read-only homelab dashboard.
  title:
    en_us: RackDeck
YAML
  fi

  mv "$temporary" "$destination"
}

peer_slug() {
  local slug
  slug="$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-64)"
  [[ -n "$slug" ]] || slug="peer"
  printf '%s' "$slug"
}

generate_peer_token() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'hlp_%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  else
    printf 'hlp_%s' "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  fi
}

write_env() {
  local temporary="${ENV_FILE}.tmp.$$"
  local preserved="${ENV_FILE}.preserved.$$"
  local existing_role existing_publish existing_memory existing_reservation
  local existing_peer_id existing_peer_token token

  existing_role="$(env_value HOMELABMD_ROLE || true)"
  existing_publish="$(env_value HOMELABMD_PUBLISH || true)"
  existing_memory="$(env_value HOMELABMD_MEMORY_LIMIT || true)"
  existing_reservation="$(env_value HOMELABMD_MEMORY_RESERVATION || true)"
  existing_peer_id="$(env_value HOMELABMD_PEER_ID || true)"
  existing_peer_token="$(env_value HOMELABMD_PEER_TOKEN || true)"

  if [[ $ROLE_SET -eq 0 ]]; then
    ROLE="${existing_role:-main}"
  fi
  [[ "$ROLE" == "main" || "$ROLE" == "peer" ]] || die "invalid role '$ROLE' (expected main or peer)"

  PUBLISH="${PUBLISH:-${existing_publish:-3000}}"
  if ! [[ "$PUBLISH" =~ ^[0-9]+$ ]] || (( PUBLISH < 1 || PUBLISH > 65535 )); then
    die "invalid publish port '$PUBLISH'"
  fi

  if [[ -z "$MEMORY_LIMIT" ]]; then
    MEMORY_LIMIT="${existing_memory:-$([[ "$ROLE" == "peer" ]] && echo 128m || echo 300m)}"
  fi
  if [[ -z "$MEMORY_RESERVATION" ]]; then
    MEMORY_RESERVATION="${existing_reservation:-$([[ "$ROLE" == "peer" ]] && echo 64m || echo 192m)}"
  fi

  if [[ "$ROLE" == "peer" ]]; then
    PEER_ID="${PEER_ID:-${existing_peer_id:-$(peer_slug)}}"
    [[ "$PEER_ID" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] \
      || die "invalid peer id '$PEER_ID' (lowercase letters, digits and hyphens)"

    if [[ -n "$PEER_TOKEN_FILE" ]]; then
      [[ -f "$PEER_TOKEN_FILE" ]] || die "peer token file not found: $PEER_TOKEN_FILE"
      token="$(tr -d '[:space:]' < "$PEER_TOKEN_FILE")"
    else
      token="$existing_peer_token"
    fi
    if [[ -z "$token" ]]; then
      token="$(generate_peer_token)"
      log "generated a peer token; it is stored in ${ENV_FILE} (mode 600) and is not printed"
    fi
    [[ "$token" =~ ^hlp_[A-Za-z0-9_-]{43}$ ]] || die "invalid peer token in $PEER_TOKEN_FILE"
    PEER_TOKEN="$token"
  else
    PEER_ID=""
    PEER_TOKEN=""
  fi

  if [[ -f "$ENV_FILE" ]]; then
    grep -v -E '^(HOMELABMD_IMAGE_REPOSITORY|HOMELABMD_IMAGE_TAG|HOMELABMD_ROLE|HOMELABMD_PUBLISH|HOMELABMD_MEMORY_LIMIT|HOMELABMD_MEMORY_RESERVATION|HOMELABMD_PEER_ID|HOMELABMD_PEER_TOKEN)=' \
      "$ENV_FILE" > "$preserved" || true
  else
    : > "$preserved"
  fi

  {
    echo "# Managed by homelabmd. Do not commit this file; it is deployment state."
    echo "HOMELABMD_IMAGE_REPOSITORY=${IMAGE_REPOSITORY}"
    echo "HOMELABMD_IMAGE_TAG=${TARGET_VERSION}"
    echo "HOMELABMD_ROLE=${ROLE}"
    echo "HOMELABMD_PUBLISH=${PUBLISH}"
    echo "HOMELABMD_MEMORY_LIMIT=${MEMORY_LIMIT}"
    echo "HOMELABMD_MEMORY_RESERVATION=${MEMORY_RESERVATION}"
    if [[ "$ROLE" == "peer" ]]; then
      echo "HOMELABMD_PEER_ID=${PEER_ID}"
      echo "HOMELABMD_PEER_TOKEN=${PEER_TOKEN}"
    fi
    cat "$preserved"
  } > "$temporary"

  rm -f "$preserved"
  mv "$temporary" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

install_cli() {
  local source=""
  if [[ -n "$ASSET_DIR" && -f "$ASSET_DIR/install.sh" ]]; then
    source="$ASSET_DIR/install.sh"
  elif [[ -f "$0" ]]; then
    source="$0"
  fi

  if [[ -z "$source" ]]; then
    warn "could not install the CLI because the script was read from a pipe; keep the downloaded install.sh"
    return 0
  fi

  local destination="$CLI_PATH"
  if [[ "$destination" == "$source" ]]; then
    return 0
  fi
  install -d -m 0755 "$(dirname "$destination")"
  install -m 0755 "$source" "$destination"
  log "CLI installed at ${destination}"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

validate_compose() {
  compose config >/dev/null 2>&1 \
    || die "generated compose is invalid; run 'docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} config'"
}

ensure_volume() {
  if ! docker volume inspect homelabmd-data >/dev/null 2>&1; then
    log "creating the homelabmd-data volume"
    docker volume create homelabmd-data >/dev/null
  fi
}

compose_pull() {
  if [[ $NO_PULL -eq 1 ]]; then
    log "skipping image pull (local image or --no-pull)"
    return 0
  fi
  compose pull
}

compose_up() {
  compose up -d --remove-orphans
}

container_id() {
  compose ps -q 2>/dev/null | head -n 1 || true
}

container_health() {
  local id="$1"
  docker inspect "$id" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true
}

http_health() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PUBLISH}/api/health" 2>/dev/null || true
}

http_version() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PUBLISH}/api/version" 2>/dev/null || true
}

wait_healthy() {
  local id health response
  for _ in $(seq 1 60); do
    id="$(container_id)"
    if [[ -n "$id" ]]; then
      health="$(container_health "$id")"
      if [[ "$health" == "healthy" ]]; then
        return 0
      fi
      if [[ "$health" == "unhealthy" ]]; then
        return 1
      fi
      if [[ -z "$health" ]]; then
        response="$(http_health)"
        if printf '%s' "$response" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
          return 0
        fi
      fi
    fi
    sleep 2
  done
  return 1
}

verify_version() {
  local response
  response="$(http_health)"
  if ! printf '%s' "$response" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    warn "health endpoint did not report status ok: ${response}"
    return 1
  fi

  if [[ -n "$EXPECTED_VERSION" ]]; then
    response="$(http_version)"
    if ! printf '%s' "$response" \
      | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"${EXPECTED_VERSION}\""; then
      warn "version endpoint did not report ${EXPECTED_VERSION}: ${response}"
      return 1
    fi
  fi
  return 0
}

verify_digest() {
  [[ -n "$DIGEST" ]] || return 0
  local pulled
  pulled="$(docker image inspect "${IMAGE_REPOSITORY}:${TARGET_VERSION}" \
    --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//' || true)"
  if [[ -z "$pulled" ]]; then
    warn "image has no local repo digest; checksum and tag verification still apply"
    return 0
  fi
  if [[ "$pulled" != "$DIGEST" ]]; then
    warn "image digest mismatch: expected ${DIGEST}, got ${pulled}"
    return 1
  fi
  return 0
}

owner_conflicts() {
  local ids id name config found=1
  ids="$(docker ps -aq --filter 'label=com.docker.compose.project=homelabmd' 2>/dev/null || true)"
  if [[ -z "$ids" ]]; then
    ids="$(docker ps -aq --filter 'name=^/homelabmd$' 2>/dev/null || true)"
  fi
  [[ -z "$ids" ]] && return 1

  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    name="$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null | sed 's#^/##' || true)"
    config="$(docker inspect "$id" \
      --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
      2>/dev/null || true)"
    if [[ "$config" != "$COMPOSE_FILE" ]]; then
      printf '%s|%s|%s\n' "$id" "$name" "$config"
      found=0
    fi
  done <<< "$ids"
  return $found
}

replace_owner() {
  local conflict id name config ids
  conflict="$(owner_conflicts || true)"

  if [[ $REPLACE_OWNER -eq 1 ]]; then
    log "replacing every container in the homelabmd compose project"
    ids="$(docker ps -aq --filter 'label=com.docker.compose.project=homelabmd' 2>/dev/null || true)"
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      name="$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null | sed 's#^/##' || true)"
      config="$(docker inspect "$id" \
        --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
        2>/dev/null || true)"
      log "removing container ${name:-$id} (compose: ${config:-unknown})"
      docker rm -f "$id" >/dev/null
    done <<< "$ids"

    docker rm -f homelabmd >/dev/null 2>&1 || true
    docker rm -f homelabmd-homelabmd-1 >/dev/null 2>&1 || true
    cleanup_network
    return 0
  fi

  [[ -n "$conflict" ]] || return 0
  printf '%s\n' "$conflict" >&2
  die "another RackDeck deployment owns this host; rerun with --replace-owner to migrate it"
}

cleanup_network() {
  if docker network inspect homelabmd_default >/dev/null 2>&1; then
    local attached
    attached="$(docker network inspect homelabmd_default -f '{{len .Containers}}' 2>/dev/null || echo 1)"
    if [[ "$attached" == "0" ]]; then
      docker network rm homelabmd_default >/dev/null 2>&1 || true
    fi
  fi
}

restore_backup() {
  [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]] || return 1
  log "restoring previous deployment from ${BACKUP_DIR}"
  if [[ -f "$BACKUP_DIR/$(basename "$COMPOSE_FILE")" ]]; then
    cp -p "$BACKUP_DIR/$(basename "$COMPOSE_FILE")" "$COMPOSE_FILE"
  fi
  if [[ -f "$BACKUP_DIR/.env" ]]; then
    cp -p "$BACKUP_DIR/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    local restored_tag restored_repo
    restored_tag="$(sed -n 's/^HOMELABMD_IMAGE_TAG=//p' "$ENV_FILE" | tail -n 1)"
    restored_repo="$(sed -n 's/^HOMELABMD_IMAGE_REPOSITORY=//p' "$ENV_FILE" | tail -n 1)"
    if [[ -n "$restored_tag" ]]; then
      TARGET_VERSION="$restored_tag"
      # A local image tag (for example 1.0.0-local-abc123) is not the application's
      # package version. Only a published release has the tag/version equality contract.
      if [[ "$restored_repo" == */* ]]; then
        EXPECTED_VERSION="$restored_tag"
      else
        EXPECTED_VERSION=""
      fi
      DIGEST=""
    fi
    if [[ -n "$restored_repo" ]]; then
      IMAGE_REPOSITORY="$restored_repo"
    fi
  fi
  if [[ $NO_START -eq 0 ]]; then
    compose up -d || return 1
    wait_healthy || return 1
    verify_version || return 1
  fi
  return 0
}

write_state() {
  local result="$1"
  local state_dir="$PREFIX/state"
  install -d -m 0755 "$state_dir"
  cat > "$state_dir/last-update.json" <<EOF
{
  "result": "${result}",
  "from": "${FROM_VERSION:-unknown}",
  "to": "${TARGET_VERSION}",
  "image": "${IMAGE_REPOSITORY}:${TARGET_VERSION}",
  "digest": "${DIGEST:-unknown}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "compose": "${COMPOSE_FILE}",
  "environment": "${ENV_FILE}"
}
EOF
}

emit_result() {
  local action="$1"
  local health="unknown"
  local id
  id="$(container_id || true)"
  if [[ -n "$id" ]]; then
    health="$(container_health "$id")"
    [[ -n "$health" ]] || health="running"
  fi

  if [[ $JSON -eq 1 ]]; then
    printf '{"ok":true,"action":"%s","version":"%s","image":"%s","health":"%s","url":"http://127.0.0.1:%s","compose":"%s","environment":"%s"}\n' \
      "$action" "$TARGET_VERSION" "${IMAGE_REPOSITORY}:${TARGET_VERSION}" "$health" "$PUBLISH" "$COMPOSE_FILE" "$ENV_FILE"
    return 0
  fi

  printf 'RackDeck %s %s\n' "$action" "$TARGET_VERSION"
  printf '  image:      %s:%s\n' "$IMAGE_REPOSITORY" "$TARGET_VERSION"
  printf '  health:     %s\n' "$health"
  printf '  url:        http://127.0.0.1:%s\n' "$PUBLISH"
  printf '  compose:    %s\n' "$COMPOSE_FILE"
  printf '  env:        %s\n' "$ENV_FILE"
  if [[ "$ROLE" == "peer" ]]; then
    printf '  peer token: stored in %s (mode 600)\n' "$ENV_FILE"
  fi
}

print_dry_run() {
  printf 'Dry run: no files will be written.\n'
  printf '  action:     %s\n' "$COMMAND"
  printf '  version:    %s\n' "$TARGET_VERSION"
  printf '  image:      %s:%s\n' "$IMAGE_REPOSITORY" "$TARGET_VERSION"
  printf '  prefix:     %s\n' "$PREFIX"
  printf '  compose:    %s\n' "$COMPOSE_FILE"
  printf '  env:        %s\n' "$ENV_FILE"
  printf '  role:       %s\n' "${ROLE:-preserve}"
  if [[ $CASAOS -eq 1 ]]; then
    printf '  owner:      CasaOS\n'
  fi
  printf '\n--- compose.yaml ---\n'
  local temporary
  temporary="$(mktemp)"
  write_compose "$temporary"
  cat "$temporary"
  rm -f "$temporary"
  printf '\n--- environment keys ---\n'
  printf 'HOMELABMD_IMAGE_REPOSITORY=%s\n' "$IMAGE_REPOSITORY"
  printf 'HOMELABMD_IMAGE_TAG=%s\n' "$TARGET_VERSION"
  printf 'HOMELABMD_ROLE=%s\n' "${ROLE:-preserve}"
  printf 'HOMELABMD_PUBLISH=%s\n' "${PUBLISH:-3000}"
}

do_install() {
  resolve_release
  ROLE="${ROLE:-main}"
  PUBLISH="${PUBLISH:-3000}"

  if [[ $DRY_RUN -eq 1 ]]; then
    print_dry_run
    return 0
  fi

  if [[ $EUID -ne 0 ]]; then
    if [[ -d "$PREFIX" ]]; then
      [[ -w "$PREFIX" ]] || die "installing to ${PREFIX} requires root or a writable directory"
    else
      local parent
      parent="$(dirname "$PREFIX")"
      [[ -d "$parent" && -w "$parent" ]] \
        || die "installing to ${PREFIX} requires root or a writable parent directory"
    fi
  fi
  require_docker
  ensure_directory
  acquire_lock
  ensure_volume
  replace_owner
  backup_deployment
  write_compose "$COMPOSE_FILE"
  write_env
  install_cli

  if [[ $NO_START -eq 1 ]]; then
    log "deployment files written; --no-start requested"
    emit_result "installed"
    return 0
  fi

  validate_compose
  if ! compose_pull; then
    die "image pull failed; the previous deployment, if any, was not changed"
  fi
  if ! compose_up; then
    die "container failed to start; the previous deployment, if any, was not changed"
  fi
  if ! wait_healthy; then
    die "container did not become healthy; inspect 'docker compose logs' at ${PREFIX}"
  fi
  verify_version || die "deployment started but failed verification"
  verify_digest || die "deployment started but the image digest did not match"
  write_state "success"
  emit_result "installed"
}

do_update() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    die "no deployment found at ${PREFIX}; run the installer first"
  fi
  FROM_VERSION="$(current_version)"
  ROLE="${ROLE:-$(env_value HOMELABMD_ROLE || true)}"
  ROLE="${ROLE:-main}"
  PUBLISH="${PUBLISH:-$(env_value HOMELABMD_PUBLISH || true)}"
  PUBLISH="${PUBLISH:-3000}"

  resolve_release

  if [[ $CHECK -eq 1 ]]; then
    local available="false"
    if [[ -n "$FROM_VERSION" ]] && version_gt "$TARGET_VERSION" "$FROM_VERSION"; then
      available="true"
    fi
    if [[ $JSON -eq 1 ]]; then
      printf '{"current":"%s","available":"%s","update_available":%s,"channel":"stable"}\n' \
        "$FROM_VERSION" "$TARGET_VERSION" "$available"
    else
      if [[ "$available" == "true" ]]; then
        printf 'Update available: %s -> %s\n' "$FROM_VERSION" "$TARGET_VERSION"
      else
        printf 'Current: %s (latest: %s)\n' "$FROM_VERSION" "$TARGET_VERSION"
      fi
    fi
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    print_dry_run
    return 0
  fi

  if [[ -n "$FROM_VERSION" ]] && [[ "$FROM_VERSION" == "$TARGET_VERSION" ]] && [[ $FORCE -eq 0 ]]; then
    log "already at ${TARGET_VERSION}"
    emit_result "current"
    return 0
  fi

  if [[ -n "$FROM_VERSION" ]] && [[ "$(major_of "$TARGET_VERSION")" != "$(major_of "$FROM_VERSION")" ]] \
    && [[ $ALLOW_MAJOR -eq 0 ]] && [[ -z "$IMAGE_REF" ]]; then
    die "refusing a major update from ${FROM_VERSION} to ${TARGET_VERSION}; pass --allow-major"
  fi

  require_docker
  ensure_directory
  acquire_lock
  ensure_volume
  backup_deployment
  write_compose "$COMPOSE_FILE"
  write_env
  validate_compose

  if ! compose_pull; then
    restore_backup || true
    die "image pull failed; restored the previous deployment"
  fi
  if ! compose_up; then
    restore_backup || true
    die "container failed to start; restored the previous deployment"
  fi
  if ! wait_healthy; then
    restore_backup || true
    die "new container did not become healthy; restored the previous deployment"
  fi
  if ! verify_version; then
    restore_backup || true
    die "new container reported the wrong version; restored the previous deployment"
  fi
  if ! verify_digest; then
    restore_backup || true
    die "image digest verification failed; restored the previous deployment"
  fi

  install_cli
  write_state "success"
  emit_result "updated"
}

do_rollback() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    die "no deployment found at ${PREFIX}; run the installer first"
  fi
  ROLE="${ROLE:-$(env_value HOMELABMD_ROLE || true)}"
  ROLE="${ROLE:-main}"
  PUBLISH="${PUBLISH:-$(env_value HOMELABMD_PUBLISH || true)}"
  PUBLISH="${PUBLISH:-3000}"
  FROM_VERSION="$(current_version)"
  local restore_from=""

  if [[ -n "$TARGET_VERSION" ]]; then
    TARGET_VERSION="${TARGET_VERSION#v}"
    validate_version "$TARGET_VERSION"
    local existing_repo
    existing_repo="$(env_value HOMELABMD_IMAGE_REPOSITORY || true)"
    if [[ $IMAGE_REPOSITORY_SET -eq 0 && -n "$existing_repo" ]]; then
      IMAGE_REPOSITORY="$existing_repo"
    fi
  else
    restore_from="$(find "$PREFIX/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
    [[ -n "$restore_from" ]] || die "no backups found under ${PREFIX}/backups"
    [[ -f "$restore_from/.env" ]] || die "latest backup has no .env: ${restore_from}"
    TARGET_VERSION="$(sed -n 's/^HOMELABMD_IMAGE_TAG=//p' "$restore_from/.env" | tail -n 1)"
    IMAGE_REPOSITORY="$(sed -n 's/^HOMELABMD_IMAGE_REPOSITORY=//p' "$restore_from/.env" | tail -n 1)"
    [[ -n "$TARGET_VERSION" && -n "$IMAGE_REPOSITORY" ]] \
      || die "latest backup does not contain an image reference"
  fi

  if [[ "$IMAGE_REPOSITORY" == */* ]]; then
    EXPECTED_VERSION="$TARGET_VERSION"
  else
    EXPECTED_VERSION=""
  fi

  if [[ "$IMAGE_REPOSITORY" != */* ]]; then
    NO_PULL=1
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    print_dry_run
    return 0
  fi

  require_docker
  ensure_directory
  acquire_lock
  ensure_volume
  backup_deployment
  if [[ -n "$restore_from" ]]; then
    log "restoring ${restore_from}"
    cp -p "$restore_from/$(basename "$COMPOSE_FILE")" "$COMPOSE_FILE"
    cp -p "$restore_from/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    write_env
    validate_compose
  fi

  if ! compose_pull; then
    die "could not pull the rollback image; the deployment files were left in place"
  fi
  if ! compose_up; then
    die "rollback container failed to start; inspect ${PREFIX} and the container logs"
  fi
  if ! wait_healthy; then
    die "rollback container did not become healthy; inspect ${PREFIX} and the container logs"
  fi
  verify_version || die "rollback container did not report ${EXPECTED_VERSION}"
  verify_digest || true
  write_state "rolled-back"
  emit_result "rolled back"
}

do_status() {
  local installed="false" id health version role tag repo
  PUBLISH="${PUBLISH:-$(env_value HOMELABMD_PUBLISH || true)}"
  PUBLISH="${PUBLISH:-3000}"
  [[ -f "$COMPOSE_FILE" ]] && installed="true"
  tag="$(env_value HOMELABMD_IMAGE_TAG || true)"
  repo="$(env_value HOMELABMD_IMAGE_REPOSITORY || true)"
  role="$(env_value HOMELABMD_ROLE || true)"
  version=""
  health="unknown"
  id=""

  if [[ "$installed" == "true" ]] && command -v docker >/dev/null 2>&1; then
    id="$(container_id || true)"
    if [[ -n "$id" ]]; then
      health="$(container_health "$id")"
      [[ -n "$health" ]] || health="running"
    fi
  fi
  if [[ -n "$tag" ]]; then
    version="$(http_version || true)"
  fi

  if [[ $JSON -eq 1 ]]; then
    local api_json="null"
    if [[ -n "$version" ]]; then
      api_json="\"$(printf '%s' "$version" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
    fi
    printf '{"installed":%s,"version":"%s","image":"%s:%s","role":"%s","health":"%s","compose":"%s","environment":"%s","api_version":%s}\n' \
      "$installed" "${tag:-unknown}" "${repo:-unknown}" "${tag:-unknown}" "${role:-unknown}" "$health" "$COMPOSE_FILE" "$ENV_FILE" "$api_json"
    return 0
  fi

  printf 'RackDeck status\n'
  printf '  installed:  %s\n' "$installed"
  printf '  version:    %s\n' "${tag:-unknown}"
  printf '  image:      %s:%s\n' "${repo:-unknown}" "${tag:-unknown}"
  printf '  role:       %s\n' "${role:-unknown}"
  printf '  health:     %s\n' "$health"
  printf '  compose:    %s\n' "$COMPOSE_FILE"
  printf '  env:        %s\n' "$ENV_FILE"
  [[ -n "$version" ]] && printf '  api:        %s\n' "$version"
  return 0
}

TMP_DIR="$(mktemp -d)"

case "$COMMAND" in
  install) do_install ;;
  update) do_update ;;
  rollback) do_rollback ;;
  status) do_status ;;
esac
