#!/usr/bin/env bash
set -Eeuo pipefail

OLD_ROOT="${OLD_ROOT:-/opt/newdomofon-video}"
NEW_ROOT="${NEW_ROOT:-/opt/newdomofon-video-master}"
REPO_URL="${REPO_URL:-https://github.com/rirodevdom/newdomofon-video-master.git}"
ENV_FILE="${ENV_FILE:-/etc/newdomofon-video/app.env}"
WEB_ROOT="${WEB_ROOT:-/var/www/newdomofon-video}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/newdomofon-video-migration-backups/master-$STAMP}"
BACKEND_SERVICE="${BACKEND_SERVICE:-newdomofon-video-backend.service}"
SWITCHED=0

log() { printf '\n===== %s =====\n' "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

rollback() {
  local rc=$?
  trap - ERR
  set +e
  echo
  echo "MIGRATION FAILED (exit=$rc). Starting master rollback..." >&2

  if [[ "$SWITCHED" == "1" ]]; then
    if [[ -d "$BACKUP_ROOT/units/etc/systemd/system" ]]; then
      cp -a "$BACKUP_ROOT/units/etc/systemd/system/." /etc/systemd/system/
    fi
    if [[ -d "$BACKUP_ROOT/www-newdomofon-video" ]]; then
      install -d "$WEB_ROOT"
      rsync -a --delete "$BACKUP_ROOT/www-newdomofon-video/" "$WEB_ROOT/"
    fi
    systemctl daemon-reload
    if [[ -s "$BACKUP_ROOT/restart-units.txt" ]]; then
      while IFS= read -r unit; do
        [[ -n "$unit" ]] && systemctl restart "$unit" || true
      done < "$BACKUP_ROOT/restart-units.txt"
    else
      systemctl restart "$BACKEND_SERVICE" || true
    fi
    nginx -t && systemctl reload nginx || true
  fi

  echo "Rollback data: $BACKUP_ROOT" >&2
  echo "The PostgreSQL dump was NOT restored automatically." >&2
  exit "$rc"
}
trap rollback ERR

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ -d "$OLD_ROOT" ]] || fail "old project directory not found: $OLD_ROOT"
[[ -f "$ENV_FILE" ]] || fail "environment file not found: $ENV_FILE"

for cmd in git node npm systemctl curl cp sed grep rsync pg_dump nginx; do need "$cmd"; done

NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=12) ? 0 : 1)' \
  || fail "Node.js 22.12+ is required; installed: $NODE_VERSION"

install -d -m 0700 "$BACKUP_ROOT" "$BACKUP_ROOT/units"

log "Saving current master state"
{
  echo "date=$(date -Is)"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  echo "old_root=$OLD_ROOT"
  echo "new_root=$NEW_ROOT"
  echo "repo=$REPO_URL"
  echo "node_version=$NODE_VERSION"
  git -C "$OLD_ROOT" rev-parse HEAD 2>/dev/null | sed 's/^/old_commit=/' || true
} > "$BACKUP_ROOT/metadata.txt"

git -C "$OLD_ROOT" status --short > "$BACKUP_ROOT/old-git-status.txt" 2>&1 || true
git -C "$OLD_ROOT" diff > "$BACKUP_ROOT/old-working-tree.patch" 2>&1 || true
cp -a "$ENV_FILE" "$BACKUP_ROOT/app.env"
chmod 0600 "$BACKUP_ROOT/app.env"

if [[ -d /etc/newdomofon-video ]]; then
  cp -a /etc/newdomofon-video "$BACKUP_ROOT/etc-newdomofon-video"
fi
if [[ -d "$WEB_ROOT" ]]; then
  cp -a "$WEB_ROOT" "$BACKUP_ROOT/www-newdomofon-video"
fi
cp -a /etc/nginx/sites-available "$BACKUP_ROOT/nginx-sites-available" 2>/dev/null || true
cp -a /etc/nginx/sites-enabled "$BACKUP_ROOT/nginx-sites-enabled" 2>/dev/null || true
systemctl status "$BACKEND_SERVICE" --no-pager -l > "$BACKUP_ROOT/backend-status-before.txt" 2>&1 || true
curl -fsS --max-time 10 http://127.0.0.1:3000/api/health > "$BACKUP_ROOT/health-before.json" 2>&1 || true

log "Loading production environment and creating PostgreSQL dump"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is missing in $ENV_FILE"
pg_dump --format=custom --file="$BACKUP_ROOT/postgresql-before.dump" "$DATABASE_URL"
chmod 0600 "$BACKUP_ROOT/postgresql-before.dump"

log "Cloning separated master repository"
if [[ -e "$NEW_ROOT" ]]; then
  mv "$NEW_ROOT" "$BACKUP_ROOT/preexisting-new-root"
fi
git clone --branch main --single-branch "$REPO_URL" "$NEW_ROOT"
git -C "$NEW_ROOT" rev-parse HEAD | tee "$BACKUP_ROOT/new-commit.txt"

log "Building backend and applying idempotent migrations"
cd "$NEW_ROOT/backend"
npm ci --include=dev
npm run build
npm run migrate
npm run seed
npm prune --omit=dev

test -f "$NEW_ROOT/backend/dist/index.js" || fail "backend build output is missing"

log "Building frontend"
cd "$NEW_ROOT/frontend"
npm ci --include=dev
npm run build
test -f "$NEW_ROOT/frontend/dist/index.html" || fail "frontend build output is missing"

if [[ -d "$NEW_ROOT/public-events-proxy" && -f "$NEW_ROOT/public-events-proxy/package.json" ]]; then
  log "Installing public-events proxy dependencies"
  cd "$NEW_ROOT/public-events-proxy"
  if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
fi

patch_unit_file() {
  local file="$1"
  local rel unit parent
  [[ -f "$file" ]] || return 0
  grep -qF "$OLD_ROOT" "$file" || return 0

  rel="${file#/etc/systemd/system/}"
  parent="${rel%%/*}"
  if [[ "$parent" == *.d ]]; then unit="${parent%.d}"; else unit="$parent"; fi

  cp --parents -a "$file" "$BACKUP_ROOT/units"
  sed -i "s#${OLD_ROOT}#${NEW_ROOT}#g" "$file"
  printf '%s\n' "$unit" >> "$BACKUP_ROOT/restart-units.txt"
  echo "Patched: $file"
}

log "Switching master services to the separated checkout"
: > "$BACKUP_ROOT/restart-units.txt"

for unit in \
  newdomofon-video-backend.service \
  newdomofon-public-events-proxy.service \
  newdomofon-public-events.service \
  newdomofon-smartyard-compat.service
 do
  fragment="$(systemctl show -p FragmentPath --value "$unit" 2>/dev/null || true)"
  if [[ -n "$fragment" && -f "$fragment" ]]; then
    if [[ "$fragment" == /etc/systemd/system/* ]]; then
      patch_unit_file "$fragment"
    elif grep -qF "$OLD_ROOT" "$fragment"; then
      target="/etc/systemd/system/$unit"
      cp -a "$fragment" "$target"
      patch_unit_file "$target"
    fi
  fi

  dropins="$(systemctl show -p DropInPaths --value "$unit" 2>/dev/null || true)"
  for dropin in $dropins; do
    [[ "$dropin" == /etc/systemd/system/* ]] && patch_unit_file "$dropin"
  done
 done

sort -u -o "$BACKUP_ROOT/restart-units.txt" "$BACKUP_ROOT/restart-units.txt"
grep -qF "$NEW_ROOT" /etc/systemd/system/newdomofon-video-backend.service \
  || fail "$BACKEND_SERVICE was not switched to $NEW_ROOT"

SWITCHED=1
install -d -o newdomofon -g newdomofon -m 0755 "$WEB_ROOT"
rsync -a --delete "$NEW_ROOT/frontend/dist/" "$WEB_ROOT/"
chown -R newdomofon:newdomofon "$WEB_ROOT"

systemctl daemon-reload
while IFS= read -r unit; do
  [[ -n "$unit" ]] || continue
  if systemctl is-active --quiet "$unit" || [[ "$unit" == "$BACKEND_SERVICE" ]]; then
    systemctl restart "$unit"
  fi
done < "$BACKUP_ROOT/restart-units.txt"

nginx -t
systemctl reload nginx

log "Master health checks"
systemctl is-active --quiet "$BACKEND_SERVICE"
for attempt in {1..20}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/api/health > "$BACKUP_ROOT/health-after.json"; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:3000/api/health | tee /tmp/newdomofon-master-health.json

grep -qF "$NEW_ROOT/backend" <(systemctl show "$BACKEND_SERVICE" -p WorkingDirectory -p ExecStart) \
  || fail "$BACKEND_SERVICE is not running from the new checkout"

journalctl -u "$BACKEND_SERVICE" --since "5 minutes ago" --no-pager -n 200 > "$BACKUP_ROOT/backend-journal-after.txt" || true

log "Remaining references to the old monorepository"
grep -RIlF "$OLD_ROOT" /etc/systemd/system --include='*.service' --include='*.conf' 2>/dev/null \
  | tee "$BACKUP_ROOT/remaining-old-path-units.txt" || true

trap - ERR
cat <<REPORT

MASTER MIGRATION COMPLETED
New checkout: $NEW_ROOT
Backup/rollback data: $BACKUP_ROOT
Old checkout preserved: $OLD_ROOT
Frontend remains served from: $WEB_ROOT
PostgreSQL dump: $BACKUP_ROOT/postgresql-before.dump

Do not delete the old checkout yet. Verify login, cameras, live, archive, events and node heartbeat first.
REPORT
