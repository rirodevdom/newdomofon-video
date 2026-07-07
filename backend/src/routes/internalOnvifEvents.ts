import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const internalOnvifEventsRouter = Router();

function requireInternalSecret(req: any, res: any, next: any) {
  const expected = process.env.INTERNAL_DVR_SECRET || '';
  const actual = String(req.header('x-internal-secret') || req.header('x-dvr-secret') || '');

  if (!expected || actual !== expected) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }

  next();
}

function parseRtspCredentials(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return { username: null, password: null };

  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'rtsp:') return { username: null, password: null };

    return {
      username: url.username ? decodeURIComponent(url.username) : null,
      password: url.password ? decodeURIComponent(url.password) : null
    };
  } catch {
    return { username: null, password: null };
  }
}

function onvifXaddrFromDevice(host: string | null | undefined, port: number | null | undefined) {
  const raw = String(host || '').trim();
  if (!raw) return '';

  const scheme = raw.toLowerCase().startsWith('https://') ? 'https' : 'http';
  const withoutScheme = raw.replace(/^https?:\/\//i, '');
  const hostname = withoutScheme.split('/')[0].replace(/:\d+$/, '').trim();
  if (!hostname) return '';

  return `${scheme}://${hostname}:${Number(port || 80)}/onvif/device_service`;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function eventHash(input: {
  camera_id: string;
  stream_name: string;
  event_type: string;
  event_state: string | null;
  occurred_at: Date;
  data: unknown;
}) {
  return crypto
    .createHash('sha256')
    .update([
      input.camera_id,
      input.stream_name,
      input.event_type,
      input.event_state ?? '',
      input.occurred_at.toISOString(),
      stableJson(input.data)
    ].join('|'))
    .digest('hex');
}

const archiveSegmentSchema = z.object({
  camera_id: z.string().uuid(),
  stream_name: z.string().min(1).optional(),
  device_id: z.string().uuid().nullable().optional(),
  source: z.string().min(1).max(64).default('hikvision-isapi'),
  track_id: z.string().nullable().optional(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  playback_uri: z.string().nullable().optional(),
  raw: z.record(z.any()).optional()
});

const archiveIndexSchema = z.object({
  started_at: z.string().datetime().optional(),
  finished_at: z.string().datetime().optional(),
  sync_start: z.string().datetime(),
  sync_end: z.string().datetime(),
  item_count: z.number().int().min(0).optional(),
  cameras: z.array(z.object({
    camera_id: z.string().uuid(),
    device_id: z.string().uuid().nullable().optional()
  })).max(1000).optional(),
  items: z.array(archiveSegmentSchema).max(10000),
  errors: z.array(z.string()).max(1000).optional()
});

internalOnvifEventsRouter.get('/cameras/onvif', requireInternalSecret, asyncHandler(async (req, res) => {
  const nodeId = String(req.header('x-node-id') || '').trim();
  const params: string[] = [];
  let nodeFilter = '';
  if (nodeId) {
    params.push(nodeId);
    nodeFilter = `AND c.dvr_server_id = $${params.length}`;
  }
  const result = await query(
    `SELECT c.id, c.name, c.stream_name, c.source_url,
            c.onvif_xaddr, c.onvif_port, c.onvif_username, c.onvif_password,
            d.connection_type AS device_connection_type,
            d.host AS device_host,
            d.port AS device_port,
            d.username AS device_username,
            d.password AS device_password
       FROM public.cameras c
       LEFT JOIN public.devices d ON d.id = c.device_id
      WHERE c.is_enabled = true
        AND (
          c.onvif_xaddr IS NOT NULL
          OR (d.connection_type = 'ONVIF' AND d.host IS NOT NULL)
        )
        ${nodeFilter}
      ORDER BY c.name ASC`,
    params
  );

  const items = result.rows.map((camera: any) => {
    const rtspCreds = parseRtspCredentials(camera.source_url);
    const deviceXaddr = camera.device_connection_type === 'ONVIF'
      ? onvifXaddrFromDevice(camera.device_host, camera.device_port)
      : '';
    const onvifXaddr = camera.onvif_xaddr || deviceXaddr;

    return {
      id: camera.id,
      name: camera.name,
      stream_name: camera.stream_name,
      source_url: camera.source_url,
      onvif_xaddr: onvifXaddr,
      onvif_port: camera.onvif_port || camera.device_port || 80,
      onvif_username: camera.onvif_username || camera.device_username || rtspCreds.username || '',
      onvif_password: camera.onvif_password || camera.device_password || rtspCreds.password || ''
    };
  }).filter((camera: any) => camera.onvif_xaddr);

  res.json({ items });
}));

internalOnvifEventsRouter.get('/devices/hikvision', requireInternalSecret, asyncHandler(async (req, res) => {
  const nodeId = String(req.header('x-node-id') || '').trim();
  const params: string[] = [];
  let nodeFilter = '';
  if (nodeId) {
    params.push(nodeId);
    nodeFilter = `AND d.dvr_server_id = $${params.length}`;
  }

  const result = await query(
    `SELECT d.id AS device_id, d.name AS device_name, d.host, d.port, d.username, d.password,
            c.id AS camera_id, c.name AS camera_name, c.stream_name, c.source_url
       FROM public.devices d
       JOIN public.cameras c ON c.device_id = d.id
      WHERE d.is_enabled = true
        AND c.is_enabled = true
        AND d.connection_type = 'HIKVISION'
        AND d.host IS NOT NULL
        ${nodeFilter}
      ORDER BY d.name ASC, c.name ASC`,
    params
  );

  const devices = new Map<string, any>();
  for (const row of result.rows as any[]) {
    let device = devices.get(row.device_id);
    if (!device) {
      device = {
        id: row.device_id,
        name: row.device_name,
        host: row.host,
        port: row.port || 80,
        username: row.username || '',
        password: row.password || '',
        cameras: []
      };
      devices.set(row.device_id, device);
    }
    device.cameras.push({
      id: row.camera_id,
      name: row.camera_name,
      stream_name: row.stream_name,
      source_url: row.source_url
    });
  }

  res.json({ items: Array.from(devices.values()) });
}));

internalOnvifEventsRouter.post('/events/onvif', requireInternalSecret, asyncHandler(async (req, res) => {
  const body = req.body || {};

  if (!body.camera_id || !body.stream_name) {
    return res.status(400).json({ error: 'camera_id and stream_name are required' });
  }

  const eventType = String(body.event_type || body.topic || 'onvif.event');
  const eventState = body.event_state === undefined || body.event_state === null
    ? null
    : String(body.event_state);

  const receivedAt = new Date();
  const suppliedOccurredAt = body.occurred_at ? new Date(body.occurred_at) : receivedAt;
  const maxClockSkewMs = Math.max(
    60_000,
    Number(process.env.ONVIF_EVENT_MAX_CLOCK_SKEW_MS || 5 * 60 * 1000)
  );
  const suppliedTime = suppliedOccurredAt.getTime();
  const invalidTime = !Number.isFinite(suppliedTime);
  const clockSkewMs = invalidTime ? Number.POSITIVE_INFINITY : suppliedTime - receivedAt.getTime();
  const normalizeTime = invalidTime || Math.abs(clockSkewMs) > maxClockSkewMs;
  const occurredAt = normalizeTime ? receivedAt : suppliedOccurredAt;
  let data = body.data && typeof body.data === 'object' ? body.data : {};

  if (normalizeTime) {
    data = {
      ...data,
      _newdomofon_time_normalized: true,
      _newdomofon_original_occurred_at: body.occurred_at ?? null,
      _newdomofon_received_at: receivedAt.toISOString(),
      _newdomofon_clock_skew_ms: Number.isFinite(clockSkewMs) ? clockSkewMs : null
    };
    console.warn('[onvif-events] camera timestamp normalized', {
      stream_name: body.stream_name,
      original: body.occurred_at ?? null,
      received_at: receivedAt.toISOString(),
      clock_skew_ms: Number.isFinite(clockSkewMs) ? clockSkewMs : null
    });
  }
  const hash = eventHash({
    camera_id: String(body.camera_id),
    stream_name: String(body.stream_name),
    event_type: eventType,
    event_state: eventState,
    occurred_at: occurredAt,
    data
  });

  const result = await query(
    `INSERT INTO public.camera_events(
       camera_id, stream_name, event_type, event_state, occurred_at, data, event_hash
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      body.camera_id,
      body.stream_name,
      eventType,
      eventState,
      occurredAt,
      JSON.stringify(data),
      hash
    ]
  );

  if (result.rowCount) {
    console.log('[onvif-events] stored', {
      stream_name: body.stream_name,
      event_type: eventType,
      event_state: eventState,
      occurred_at: occurredAt.toISOString(),
      event_hash: hash.slice(0, 12)
    });
  } else {
    console.log('[onvif-events] duplicate skipped', {
      stream_name: body.stream_name,
      event_type: eventType,
      event_state: eventState,
      occurred_at: occurredAt.toISOString(),
      event_hash: hash.slice(0, 12)
    });
  }

  res.status(result.rowCount ? 201 : 200).json({ ok: true, inserted: Boolean(result.rowCount) });
}));

internalOnvifEventsRouter.post('/device-archive/ranges', requireInternalSecret, asyncHandler(async (req, res) => {
  const nodeId = String(req.header('x-node-id') || '').trim();
  if (!nodeId) return res.status(400).json({ error: 'x-node-id is required' });

  const body = archiveIndexSchema.parse(req.body || {});
  const cameraIds = Array.from(new Set([
    ...body.items.map((item) => item.camera_id),
    ...(body.cameras || []).map((item) => item.camera_id)
  ]));
  const cameraRows = cameraIds.length
    ? await query<{ id: string; device_id: string | null; dvr_server_id: string | null }>(
      `SELECT id, device_id, dvr_server_id
         FROM public.cameras
        WHERE id = ANY($1::uuid[])
          AND dvr_server_id = $2`,
      [cameraIds, nodeId]
    )
    : { rows: [] as Array<{ id: string; device_id: string | null; dvr_server_id: string | null }> };

  const allowed = new Map(cameraRows.rows.map((row) => [row.id, row]));
  let upserted = 0;
  let skipped = 0;

  for (const item of body.items) {
    const camera = allowed.get(item.camera_id);
    if (!camera) {
      skipped += 1;
      continue;
    }

    const start = new Date(item.start);
    const end = new Date(item.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      skipped += 1;
      continue;
    }

    const result = await query(
      `INSERT INTO public.device_archive_segments(
         camera_id, device_id, dvr_server_id, source, track_id,
         start_at, end_at, playback_uri, raw, last_seen_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())
       ON CONFLICT (camera_id, source, (COALESCE(track_id, '')), start_at, end_at)
       DO UPDATE SET
         device_id = EXCLUDED.device_id,
         dvr_server_id = EXCLUDED.dvr_server_id,
         playback_uri = COALESCE(EXCLUDED.playback_uri, public.device_archive_segments.playback_uri),
         raw = CASE
           WHEN EXCLUDED.raw = '{}'::jsonb THEN public.device_archive_segments.raw
           ELSE EXCLUDED.raw
         END,
         last_seen_at = now()
       RETURNING id`,
      [
        item.camera_id,
        item.device_id || camera.device_id,
        nodeId,
        item.source,
        item.track_id ?? null,
        start,
        end,
        item.playback_uri ?? null,
        JSON.stringify(item.raw || {})
      ]
    );
    upserted += result.rowCount || 0;
  }

  const states = new Map<string, { device_id: string | null; items: number; error: string | null }>();
  for (const row of cameraRows.rows) states.set(row.id, { device_id: row.device_id, items: 0, error: null });
  for (const item of body.items) {
    const state = states.get(item.camera_id);
    if (state) state.items += 1;
  }
  if (body.item_count !== undefined) {
    for (const state of states.values()) state.items = body.item_count;
  }

  const errorText = body.errors?.length ? body.errors.slice(0, 20).join(' | ').slice(0, 2000) : null;
  for (const [cameraId, state] of states) {
    await query(
      `INSERT INTO public.device_archive_sync_state(
         camera_id, device_id, dvr_server_id, source,
         last_started_at, last_finished_at, last_start_at, last_end_at,
         last_items, last_error, updated_at
       )
       VALUES ($1,$2,$3,'hikvision-isapi',$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (camera_id)
       DO UPDATE SET
         device_id = EXCLUDED.device_id,
         dvr_server_id = EXCLUDED.dvr_server_id,
         source = EXCLUDED.source,
         last_started_at = EXCLUDED.last_started_at,
         last_finished_at = EXCLUDED.last_finished_at,
         last_start_at = EXCLUDED.last_start_at,
         last_end_at = EXCLUDED.last_end_at,
         last_items = EXCLUDED.last_items,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        cameraId,
        state.device_id,
        nodeId,
        body.started_at ? new Date(body.started_at) : new Date(),
        body.finished_at ? new Date(body.finished_at) : new Date(),
        new Date(body.sync_start),
        new Date(body.sync_end),
        state.items,
        errorText
      ]
    );
  }

  res.json({ ok: true, upserted, skipped, cameras: states.size });
}));
