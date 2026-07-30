#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROJECT_DIR="${PROJECT_DIR:-/opt/newdomofon-video}"
ENV_FILE="${ENV_FILE:-/etc/newdomofon-video/app.env}"
WEB_ROOT="${WEB_ROOT:-/var/www/newdomofon-video}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/newdomofon-video-backups}"
SERVICE_NAME="newdomofon-video-backend.service"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/update-$STAMP"
SERVICE_STOPPED=0
WEB_REPLACED=0

fail() { echo "ERROR: $*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

recover_on_failure() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo >&2
    echo "Update failed; attempting recovery" >&2
    if (( WEB_REPLACED == 1 )) && [[ -d "$BACKUP_DIR/web" ]]; then
      install -d -m 0755 "$WEB_ROOT"
      rsync -a --delete "$BACKUP_DIR/web/" "$WEB_ROOT/" || true
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if (( SERVICE_STOPPED == 1 )) && ! systemctl is-active --quiet "$SERVICE_NAME"; then
      systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null || true
  fi
  exit "$status"
}
trap recover_on_failure EXIT

[[ "$(id -u)" -eq 0 ]] || fail "Run as root"
[[ -f "$SOURCE_DIR/frontend/package.json" ]] || fail "Archive source not found: $SOURCE_DIR"
[[ -f "$SOURCE_DIR/backend/package.json" ]] || fail "Backend source not found: $SOURCE_DIR/backend"
[[ -d "$PROJECT_DIR" ]] || fail "Installed project not found: $PROJECT_DIR"
[[ -f "$ENV_FILE" ]] || fail "Environment file not found: $ENV_FILE"

install -d -m 0750 "$BACKUP_DIR"
cp -a "$ENV_FILE" "$BACKUP_DIR/app.env"
if [[ -d "$WEB_ROOT" ]]; then
  install -d -m 0750 "$BACKUP_DIR/web"
  rsync -a "$WEB_ROOT/" "$BACKUP_DIR/web/"
fi

log "Stopping backend service"
systemctl stop "$SERVICE_NAME"
SERVICE_STOPPED=1

log "Updating installed project from extracted archive"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'backend/node_modules/' \
  --exclude 'backend/dist/' \
  --exclude 'frontend/node_modules/' \
  --exclude 'frontend/dist/' \
  "$SOURCE_DIR/" "$PROJECT_DIR/"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

log "Building backend"
cd "$PROJECT_DIR/backend"
npm ci --include=dev
npm run build
node dist/migrate.js
npm prune --omit=dev

log "Building frontend with repository prebuild patches"
cd "$PROJECT_DIR/frontend"
npm ci --include=dev
npm run build

log "Publishing frontend"
install -d -m 0755 "$WEB_ROOT"
rsync -a --delete "$PROJECT_DIR/frontend/dist/" "$WEB_ROOT/"
WEB_REPLACED=1
npm prune --omit=dev

log "Installing service definition and permissions"
install -m 0644 "$PROJECT_DIR/deploy/systemd/newdomofon-video-backend.service" "/etc/systemd/system/$SERVICE_NAME"
chown -R root:root "$PROJECT_DIR"
chown -R root:root "$WEB_ROOT"
find "$WEB_ROOT" -type d -exec chmod 0755 {} +
find "$WEB_ROOT" -type f -exec chmod 0644 {} +
systemctl daemon-reload
systemctl restart "$SERVICE_NAME"

BACKEND_PORT="${PORT:-3000}"
LAST_HEALTH=''
for _ in $(seq 1 60); do
  LAST_HEALTH="$(curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null || true)"
  if [[ -n "$LAST_HEALTH" ]]; then
    printf '%s\n' "$LAST_HEALTH"
    SERVICE_STOPPED=0
    log "Update completed; backup: $BACKUP_DIR"
    exit 0
  fi
  sleep 1
done

printf 'Last health response: %s\n' "${LAST_HEALTH:-<none>}" >&2
journalctl -u "$SERVICE_NAME" -n 200 --no-pager
fail "Updated backend did not become healthy"
