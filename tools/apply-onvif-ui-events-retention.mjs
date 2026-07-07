#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const projectDir = process.argv[2] || '/opt/newdomofon-video';
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const backupDir = path.join(projectDir, 'backups', `onvif-ui-events-retention-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.writeFileSync(file, text);
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const rel = path.relative(projectDir, file).replaceAll('/', '__');
  fs.copyFileSync(file, path.join(backupDir, rel));
}

function replaceOne(text, search, replace, label) {
  if (!text.includes(search)) {
    if (text.includes(replace)) {
      console.log(`present   ${label}`);
      return text;
    }
    throw new Error(`target not found for ${label}`);
  }
  console.log(`updated   ${label}`);
  return text.replace(search, replace);
}

function replaceRegex(text, regex, replace, label) {
  if (!regex.test(text)) {
    if (typeof replace === 'string' && text.includes(replace.trim().slice(0, 80))) {
      console.log(`present   ${label}`);
      return text;
    }
    throw new Error(`target not found for ${label}`);
  }
  console.log(`updated   ${label}`);
  return text.replace(regex, replace);
}

function patchDevicesView() {
  const file = path.join(projectDir, 'frontend/src/views/DevicesView.vue');
  backup(file);
  let text = read(file);

  const oldRtsp = `            <v-col cols="12"><v-text-field v-model="form.rtsp_url" :label="form.connection_type === 'HIKVISION' ? 'RTSP URL / базовый поток канала' : 'RTSP URL'" /></v-col>`;
  const newRtsp = `            <v-col v-if="form.connection_type !== 'ONVIF'" cols="12"><v-text-field v-model="form.rtsp_url" :label="form.connection_type === 'HIKVISION' ? 'RTSP URL / базовый поток канала' : 'RTSP URL'" /></v-col>`;
  text = replaceOne(text, oldRtsp, newRtsp, 'DevicesView hide RTSP URL for ONVIF device');

  const oldInfo = `                Для Hikvision укажите Host/IP, ISAPI port, login/password. Каналы привязываются камерами через RTSP URL вида /Streaming/channels/101 или /Streaming/tracks/101.`;
  const newInfo = `                Для Hikvision укажите Host/IP, ISAPI port, login/password. Каналы привязываются камерами автоматически или через RTSP URL вида /Streaming/channels/101.`;
  text = text.replace(oldInfo, newInfo);

  write(file, text);
}

function patchCamerasView() {
  const file = path.join(projectDir, 'frontend/src/views/CamerasView.vue');
  backup(file);
  let text = read(file);

  const oldInfo = `            Камера является каналом выбранного устройства. RTSP пишется напрямую через URL, ONVIF сначала получает RTSP stream URI через ONVIF Device Service.`;
  const newInfo = `            Камера является каналом выбранного устройства. Для ONVIF укажите только доступ к устройству: RTSP URI, profile token и XAddr будут получены автоматически при сохранении.`;
  text = text.replace(oldInfo, newInfo);

  const oldPortAndButton = `              <v-col cols="12" md="3"><v-text-field v-model.number="form.onvif_port" label="ONVIF Port" type="number" /></v-col>
              <v-col cols="12" md="3" class="d-flex align-center">
                <v-btn block color="primary" variant="tonal" :loading="resolvingOnvif" @click="() => resolveOnvifStream()">Получить поток</v-btn>
              </v-col>`;
  const newPort = `              <v-col cols="12" md="6"><v-text-field v-model.number="form.onvif_port" label="ONVIF Port" type="number" /></v-col>`;
  text = replaceOne(text, oldPortAndButton, newPort, 'CamerasView remove manual ONVIF stream button');

  text = replaceRegex(
    text,
    /\n\s*<v-col cols="12" md="6"><v-text-field v-model="form\.onvif_profile_token" label="Profile token" readonly \/><\/v-col>\s*\n\s*<v-col cols="12" md="6"><v-text-field v-model="form\.onvif_xaddr" label="ONVIF XAddr" readonly \/><\/v-col>\s*\n\s*<v-col cols="12">\s*\n\s*<v-text-field v-model="form\.source_url" label="RTSP stream URI, полученный через ONVIF" readonly \/>\s*\n\s*<\/v-col>/,
    '',
    'CamerasView hide ONVIF technical fields'
  );

  const oldAlert = `                  ONVIF не является видеопотоком. При сохранении камера автоматически получает RTSP stream URI через ONVIF Device Service.`;
  const newAlert = `                  При сохранении камера автоматически получит Profile token, ONVIF XAddr и RTSP stream URI через ONVIF Device Service.`;
  text = text.replace(oldAlert, newAlert);

  const oldSave = `    if (form.protocol === 'ONVIF' && !form.source_url) {
      const resolved = await resolveOnvifStream({ silent: true });
      if (!resolved) return;
    }`;
  const newSave = `    if (form.protocol === 'ONVIF' && (!editingId.value || !form.source_url || !form.onvif_xaddr || !form.onvif_profile_token)) {
      const resolved = await resolveOnvifStream({ silent: true });
      if (!resolved) return;
    }`;
  text = replaceOne(text, oldSave, newSave, 'CamerasView auto resolve ONVIF on create/save');

  write(file, text);
}

function writeEventsRetentionScript() {
  const file = path.join(projectDir, 'scripts/events-retention-cleanup.sh');
  backup(file);
  const text = `#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="\${PROJECT_DIR:-/opt/newdomofon-video}"
EVENTS_RETENTION_FALLBACK_DAYS="\${EVENTS_RETENTION_FALLBACK_DAYS:-7}"
EVENTS_RETENTION_BATCH="\${EVENTS_RETENTION_BATCH:-50000}"

set +u
for envf in /etc/newdomofon-video/app.env "\$PROJECT_DIR/backend/.env" "\$PROJECT_DIR/.env"; do
  [ -f "\$envf" ] && set -a && . "\$envf" && set +a
done
set -u

if [ -z "\${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

case "\$EVENTS_RETENTION_FALLBACK_DAYS" in
  ''|*[!0-9]*) echo "EVENTS_RETENTION_FALLBACK_DAYS must be integer" >&2; exit 1 ;;
esac
case "\$EVENTS_RETENTION_BATCH" in
  ''|*[!0-9]*) echo "EVENTS_RETENTION_BATCH must be integer" >&2; exit 1 ;;
esac

psql "\$DATABASE_URL" -v ON_ERROR_STOP=1 \\
  -v fallback_days="\$EVENTS_RETENTION_FALLBACK_DAYS" \\
  -v batch="\$EVENTS_RETENTION_BATCH" <<'SQL'
\\echo 'events-retention: before'
SELECT
  count(*) AS total_events,
  min(occurred_at) AS first_event,
  max(occurred_at) AS last_event
FROM public.camera_events;

WITH event_scope AS (
  SELECT
    e.id,
    e.stream_name,
    e.occurred_at,
    GREATEST(1, COALESCE(c_by_id.retention_days, c_by_stream.retention_days, :'fallback_days'::int)) AS keep_days
  FROM public.camera_events e
  LEFT JOIN public.cameras c_by_id ON c_by_id.id = e.camera_id
  LEFT JOIN public.cameras c_by_stream
    ON c_by_id.id IS NULL
   AND c_by_stream.stream_name = e.stream_name
),
doomed AS (
  SELECT id
  FROM event_scope
  WHERE occurred_at < now() - make_interval(days => keep_days)
  ORDER BY occurred_at
  LIMIT :'batch'::int
),
deleted AS (
  DELETE FROM public.camera_events e
  USING doomed d
  WHERE e.id = d.id
  RETURNING e.stream_name
)
SELECT stream_name, count(*) AS deleted
FROM deleted
GROUP BY stream_name
ORDER BY stream_name;

VACUUM (ANALYZE) public.camera_events;

\\echo 'events-retention: old events still exceeding per-camera retention'
WITH event_scope AS (
  SELECT
    e.stream_name,
    e.occurred_at,
    GREATEST(1, COALESCE(c_by_id.retention_days, c_by_stream.retention_days, :'fallback_days'::int)) AS keep_days
  FROM public.camera_events e
  LEFT JOIN public.cameras c_by_id ON c_by_id.id = e.camera_id
  LEFT JOIN public.cameras c_by_stream
    ON c_by_id.id IS NULL
   AND c_by_stream.stream_name = e.stream_name
)
SELECT stream_name, keep_days, count(*) AS old_events, min(occurred_at) AS oldest_event
FROM event_scope
WHERE occurred_at < now() - make_interval(days => keep_days)
GROUP BY stream_name, keep_days
ORDER BY old_events DESC, stream_name
LIMIT 30;
SQL
`;
  write(file, text);
  fs.chmodSync(file, 0o755);
  console.log(`updated   ${path.relative(projectDir, file)}`);
}

patchDevicesView();
patchCamerasView();
writeEventsRetentionScript();
console.log(`backup    ${backupDir}`);
console.log('complete  ONVIF UI + per-camera events retention patch installed');
