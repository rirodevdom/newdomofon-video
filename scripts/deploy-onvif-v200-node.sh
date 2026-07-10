#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/newdomofon-video-node}"
SERVICE="${SERVICE:-newdomofon-video-dvr.service}"
SOURCE_REF="${SOURCE_REF:-main}"
SOURCE_BASE="${SOURCE_BASE:-https://raw.githubusercontent.com/rirodevdom/newdomofon-video/${SOURCE_REF}}"
BUNDLE_B64_SHA256="5d52d8ffa04fd3768c175d72ef6f974b27a4fc6e3262d88389e5c4170260a32e"
BUNDLE_SHA256="c423c3903508b00d78bc396b52541823021c3f99d82543d6ec9d230cf1272a70"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/newdomofon-video-migration-backups/onvif-v200-node-${STAMP}"
TMP="$(mktemp -d /tmp/newdomofon-v200-node.XXXXXX)"
SWITCHED=0

cleanup() { rm -rf "$TMP"; }
rollback() {
  rc=$?
  trap - ERR
  set +e
  echo "ERROR: node v200 deployment failed (exit=$rc), rolling back" >&2
  if [[ -d "$BACKUP/project" ]]; then
    rsync -a --delete "$BACKUP/project/" "$PROJECT_DIR/"
  fi
  if [[ "$SWITCHED" == 1 ]]; then systemctl restart "$SERVICE" || true; fi
  cleanup
  echo "Rollback data: $BACKUP" >&2
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

[[ $(id -u) -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
for cmd in curl sha256sum base64 tar rsync npm systemctl; do command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }; done
[[ -d "$PROJECT_DIR/dvr-engine/src" ]] || { echo "Invalid node project: $PROJECT_DIR" >&2; exit 1; }

install -d -m 0700 "$BACKUP/project/dvr-engine/src"
for file in onvifEventsV2.ts onvifEventsLegacyFallback.ts nodeClient.ts; do
  cp -a "$PROJECT_DIR/dvr-engine/src/$file" "$BACKUP/project/dvr-engine/src/"
done
[[ ! -d "$PROJECT_DIR/dvr-engine/dist" ]] || cp -a "$PROJECT_DIR/dvr-engine/dist" "$BACKUP/project/dvr-engine/"

curl -fsSL "$SOURCE_BASE/patches/onvif-v200/onvif-v200-bundle.tar.gz.b64" -o "$TMP/bundle.b64"
echo "$BUNDLE_B64_SHA256  $TMP/bundle.b64" | sha256sum -c -
base64 -d "$TMP/bundle.b64" > "$TMP/bundle.tar.gz"
echo "$BUNDLE_SHA256  $TMP/bundle.tar.gz" | sha256sum -c -
tar -xzf "$TMP/bundle.tar.gz" -C "$TMP"

install -m 0644 "$TMP/node/dvr-engine/src/onvifEventsV2.ts" "$PROJECT_DIR/dvr-engine/src/onvifEventsV2.ts"
install -m 0644 "$TMP/node/dvr-engine/src/onvifEventsLegacyFallback.ts" "$PROJECT_DIR/dvr-engine/src/onvifEventsLegacyFallback.ts"
install -m 0644 "$TMP/node/dvr-engine/src/nodeClient.ts" "$PROJECT_DIR/dvr-engine/src/nodeClient.ts"

cd "$PROJECT_DIR/dvr-engine"
npm ci --include=dev
npm run build
npm prune --omit=dev

SWITCHED=1
systemctl restart "$SERVICE"
for i in {1..30}; do
  curl -fsS --max-time 3 http://127.0.0.1:3010/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3010/health
systemctl is-active --quiet "$SERVICE"

sleep 3
journalctl -u "$SERVICE" --since '2 minutes ago' --no-pager | grep -E '\[onvif-events:v3\]|\[onvif-events:legacy-fallback\]' | tail -100 || true

trap - ERR
trap cleanup EXIT
cat <<EOF
NODE V200 DEPLOYED
Project: $PROJECT_DIR
Backup: $BACKUP
Collector: v200-agent-pullpoint
EOF
