#!/usr/bin/env bash
set -Eeuo pipefail

OLD_ROOT="${OLD_ROOT:-/opt/newdomofon-video}"
NEW_ROOT="${NEW_ROOT:-/opt/newdomofon-video-node}"
REPO_URL="${REPO_URL:-https://github.com/rirodevdom/newdomofon-video-node.git}"
ENV_FILE="${ENV_FILE:-/etc/newdomofon-video/app.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/newdomofon-video-migration-backups/node-$STAMP}"
DVR_SERVICE="${DVR_SERVICE:-newdomofon-video-dvr.service}"
SWITCHED=0

log() { printf '\n===== %s =====\n' "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

rollback() {
  local rc=$?
  trap - ERR
  set +e
  echo
  echo "MIGRATION FAILED (exit=$rc). Starting node rollback..." >&2

  if [[ "$SWITCHED" == "1" ]]; then
    if [[ -d "$BACKUP_ROOT/units/etc/systemd/system" ]]; then
      cp -a "$BACKUP_ROOT/units/etc/systemd/system/." /etc/systemd/system/
    fi
    systemctl daemon-reload
    if [[ -s "$BACKUP_ROOT/restart-units.txt" ]]; then
      while IFS= read -r unit; do
        [[ -n "$unit" ]] && systemctl restart "$unit" || true
      done < "$BACKUP_ROOT/restart-units.txt"
    else
      systemctl restart "$DVR_SERVICE" || true
    fi
  fi

  echo "Rollback data: $BACKUP_ROOT" >&2
  exit "$rc"
}
trap rollback ERR

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ -d "$OLD_ROOT" ]] || fail "old project directory not found: $OLD_ROOT"
[[ -f "$ENV_FILE" ]] || fail "environment file not found: $ENV_FILE"

for cmd in git node npm systemctl curl cp sed awk grep find du; do need "$cmd"; done

NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=12) ? 0 : 1)' \
  || fail "Node.js 22.12+ is required; installed: $NODE_VERSION"

install -d -m 0700 "$BACKUP_ROOT" "$BACKUP_ROOT/units"

log "Saving current node state"
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

du -sh /var/lib/newdomofon-video/dvr > "$BACKUP_ROOT/archive-size-before.txt" 2>&1 || true
find /var/lib/newdomofon-video/dvr -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort > "$BACKUP_ROOT/archive-streams-before.txt" || true
systemctl cat "$DVR_SERVICE" > "$BACKUP_ROOT/dvr-service-before.txt" 2>&1 || true
systemctl status "$DVR_SERVICE" --no-pager -l > "$BACKUP_ROOT/dvr-status-before.txt" 2>&1 || true
curl -fsS --max-time 10 http://127.0.0.1:3010/health > "$BACKUP_ROOT/health-before.json" 2>&1 || true

log "Cloning separated node repository"
if [[ -e "$NEW_ROOT" ]]; then
  mv "$NEW_ROOT" "$BACKUP_ROOT/preexisting-new-root"
fi
git clone --branch main --single-branch "$REPO_URL" "$NEW_ROOT"
git -C "$NEW_ROOT" rev-parse HEAD | tee "$BACKUP_ROOT/new-commit.txt"

log "Building DVR engine"
cd "$NEW_ROOT/dvr-engine"
npm ci --include=dev
npm run build
npm prune --omit=dev

test -f "$NEW_ROOT/dvr-engine/dist/index.js" || fail "DVR build output is missing"
install -d -o newdomofon -g newdomofon -m 0755 /var/lib/newdomofon-video/dvr /var/log/newdomofon-video

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

  awk '
    /^(After|Requires)=/ {
      gsub(/(^|[[:space:]])postgresql\.service([[:space:]]|$)/, " ")
      gsub(/[[:space:]]+/, " ")
      sub(/[[:space:]]+$/, "")
      if ($0 ~ /^(After|Requires)=$/) next
    }
    { print }
  ' "$file" > "$file.tmp"
  cat "$file.tmp" > "$file"
  rm -f "$file.tmp"

  printf '%s\n' "$unit" >> "$BACKUP_ROOT/restart-units.txt"
  echo "Patched: $file"
}

log "Switching node services to the separated checkout"
: > "$BACKUP_ROOT/restart-units.txt"

for unit in \
  newdomofon-video-dvr.service \
  newdomofon-smartyard-compat.service \
  newdomofon-public-events-proxy.service \
  newdomofon-public-events.service
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
grep -qF "$NEW_ROOT" /etc/systemd/system/newdomofon-video-dvr.service \
  || fail "$DVR_SERVICE was not switched to $NEW_ROOT"

SWITCHED=1
systemctl daemon-reload
while IFS= read -r unit; do
  [[ -n "$unit" ]] || continue
  if systemctl is-active --quiet "$unit" || [[ "$unit" == "$DVR_SERVICE" ]]; then
    systemctl restart "$unit"
  fi
done < "$BACKUP_ROOT/restart-units.txt"

log "Node health checks"
systemctl is-active --quiet "$DVR_SERVICE"
for attempt in {1..20}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3010/health > "$BACKUP_ROOT/health-after.json"; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:3010/health | tee /tmp/newdomofon-node-health.json

grep -qF "$NEW_ROOT/dvr-engine" <(systemctl show "$DVR_SERVICE" -p WorkingDirectory -p ExecStart) \
  || fail "$DVR_SERVICE is not running from the new checkout"

journalctl -u "$DVR_SERVICE" --since "5 minutes ago" --no-pager -n 200 > "$BACKUP_ROOT/dvr-journal-after.txt" || true
du -sh /var/lib/newdomofon-video/dvr > "$BACKUP_ROOT/archive-size-after.txt" 2>&1 || true

log "Remaining references to the old monorepository"
grep -RIlF "$OLD_ROOT" /etc/systemd/system --include='*.service' --include='*.conf' 2>/dev/null \
  | tee "$BACKUP_ROOT/remaining-old-path-units.txt" || true

trap - ERR
cat <<REPORT

NODE MIGRATION COMPLETED
New checkout: $NEW_ROOT
Backup/rollback data: $BACKUP_ROOT
Old checkout preserved: $OLD_ROOT
Archive preserved: /var/lib/newdomofon-video/dvr

Do not delete the old checkout yet. Verify live, archive, events and heartbeat first.
REPORT
