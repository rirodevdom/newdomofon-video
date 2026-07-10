#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/newdomofon-video-master}"
WEB_ROOT="${WEB_ROOT:-/var/www/newdomofon-video}"
SERVICE="${SERVICE:-newdomofon-video-backend.service}"
SOURCE_REF="${SOURCE_REF:-main}"
SOURCE_BASE="${SOURCE_BASE:-https://raw.githubusercontent.com/rirodevdom/newdomofon-video/${SOURCE_REF}}"
BUNDLE_B64_SHA256="5d52d8ffa04fd3768c175d72ef6f974b27a4fc6e3262d88389e5c4170260a32e"
BUNDLE_SHA256="c423c3903508b00d78bc396b52541823021c3f99d82543d6ec9d230cf1272a70"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/newdomofon-video-migration-backups/onvif-v200-master-${STAMP}"
TMP="$(mktemp -d /tmp/newdomofon-v200-master.XXXXXX)"
SWITCHED=0

cleanup() { rm -rf "$TMP"; }
rollback() {
  rc=$?
  trap - ERR
  set +e
  echo "ERROR: master v200 deployment failed (exit=$rc), rolling back" >&2
  [[ ! -f "$BACKUP/project/backend/src/routes/nodeAgent.ts" ]] || cp -a "$BACKUP/project/backend/src/routes/nodeAgent.ts" "$PROJECT_DIR/backend/src/routes/nodeAgent.ts"
  if [[ -f "$BACKUP/smartyardLinks.existed" ]]; then
    cp -a "$BACKUP/project/backend/src/routes/smartyardLinks.ts" "$PROJECT_DIR/backend/src/routes/smartyardLinks.ts"
  else
    rm -f "$PROJECT_DIR/backend/src/routes/smartyardLinks.ts"
  fi
  [[ ! -f "$BACKUP/project/backend/src/index.ts" ]] || cp -a "$BACKUP/project/backend/src/index.ts" "$PROJECT_DIR/backend/src/index.ts"
  [[ ! -f "$BACKUP/project/frontend/src/views/AdminView.vue" ]] || cp -a "$BACKUP/project/frontend/src/views/AdminView.vue" "$PROJECT_DIR/frontend/src/views/AdminView.vue"
  [[ ! -d "$BACKUP/project/backend/dist" ]] || rsync -a --delete "$BACKUP/project/backend/dist/" "$PROJECT_DIR/backend/dist/"
  [[ ! -d "$BACKUP/project/frontend/dist" ]] || rsync -a --delete "$BACKUP/project/frontend/dist/" "$PROJECT_DIR/frontend/dist/"
  if [[ -d "$BACKUP/web" ]]; then
    rsync -a --delete "$BACKUP/web/" "$WEB_ROOT/"
  fi
  if [[ "$SWITCHED" == 1 ]]; then
    systemctl restart "$SERVICE" || true
    nginx -t && systemctl reload nginx || true
  fi
  cleanup
  echo "Rollback data: $BACKUP" >&2
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

[[ $(id -u) -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
for cmd in curl sha256sum base64 tar rsync npm systemctl nginx; do command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }; done
[[ -d "$PROJECT_DIR/backend" && -d "$PROJECT_DIR/frontend" ]] || { echo "Invalid master project: $PROJECT_DIR" >&2; exit 1; }

install -d -m 0700 "$BACKUP/project/backend/src/routes" "$BACKUP/project/backend/src" "$BACKUP/project/frontend/src/views" "$BACKUP/web"
cp -a "$PROJECT_DIR/backend/src/routes/nodeAgent.ts" "$BACKUP/project/backend/src/routes/"
if [[ -f "$PROJECT_DIR/backend/src/routes/smartyardLinks.ts" ]]; then
  touch "$BACKUP/smartyardLinks.existed"
  cp -a "$PROJECT_DIR/backend/src/routes/smartyardLinks.ts" "$BACKUP/project/backend/src/routes/"
fi
cp -a "$PROJECT_DIR/backend/src/index.ts" "$BACKUP/project/backend/src/"
cp -a "$PROJECT_DIR/frontend/src/views/AdminView.vue" "$BACKUP/project/frontend/src/views/"
[[ ! -d "$PROJECT_DIR/backend/dist" ]] || cp -a "$PROJECT_DIR/backend/dist" "$BACKUP/project/backend/"
[[ ! -d "$PROJECT_DIR/frontend/dist" ]] || cp -a "$PROJECT_DIR/frontend/dist" "$BACKUP/project/frontend/"
[[ ! -d "$WEB_ROOT" ]] || rsync -a "$WEB_ROOT/" "$BACKUP/web/"

curl -fsSL "$SOURCE_BASE/patches/onvif-v200/onvif-v200-bundle.tar.gz.b64" -o "$TMP/bundle.b64"
echo "$BUNDLE_B64_SHA256  $TMP/bundle.b64" | sha256sum -c -
base64 -d "$TMP/bundle.b64" > "$TMP/bundle.tar.gz"
echo "$BUNDLE_SHA256  $TMP/bundle.tar.gz" | sha256sum -c -
tar -xzf "$TMP/bundle.tar.gz" -C "$TMP"

install -m 0644 "$TMP/master/backend/src/routes/nodeAgent.ts" "$PROJECT_DIR/backend/src/routes/nodeAgent.ts"
install -m 0644 "$TMP/master/backend/src/routes/smartyardLinks.ts" "$PROJECT_DIR/backend/src/routes/smartyardLinks.ts"
install -m 0644 "$TMP/master/backend/src/index.ts" "$PROJECT_DIR/backend/src/index.ts"
install -m 0644 "$TMP/master/frontend/src/views/AdminView.vue" "$PROJECT_DIR/frontend/src/views/AdminView.vue"

cd "$PROJECT_DIR/backend"
npm ci --include=dev
npm run build
npm prune --omit=dev

cd "$PROJECT_DIR/frontend"
npm ci --include=dev
npm run build

SWITCHED=1
rsync -a --delete "$PROJECT_DIR/frontend/dist/" "$WEB_ROOT/"
chown -R newdomofon:newdomofon "$WEB_ROOT"
systemctl restart "$SERVICE"

for i in {1..30}; do
  curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3000/api/health
nginx -t
systemctl reload nginx
systemctl is-active --quiet "$SERVICE"

trap - ERR
trap cleanup EXIT
cat <<EOF
MASTER V200 DEPLOYED
Project: $PROJECT_DIR
Backup: $BACKUP
SmartYard route: POST /api/tokens/smartyard-links/:cameraId
EOF
