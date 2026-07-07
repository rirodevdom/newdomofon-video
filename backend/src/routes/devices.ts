import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';
import {
  discoverHikvisionChannels,
  generateHikvisionChannels,
  hikvisionRtspUrl,
  type HikvisionChannel,
  type HikvisionDevice
} from '../services/hikvisionChannels.js';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const nullableString = z.string().nullable().optional();

const deviceSchema = z.object({
  name: z.string().min(1),
  connection_type: z.enum(['RTSP', 'ONVIF', 'HIKVISION']).default('RTSP'),
  archive_storage: z.enum(['node', 'device', 'both']).default('node'),
  dvr_server_id: z.string().uuid().nullable().optional(),
  host: nullableString,
  port: z.number().int().min(1).max(65535).nullable().optional(),
  username: nullableString,
  password: nullableString,
  rtsp_url: nullableString,
  comment: nullableString,
  status: z.enum(['online', 'offline', 'error', 'unknown']).default('unknown'),
  is_enabled: z.boolean().default(true)
});

const deviceUpdateSchema = deviceSchema.partial();

const hikvisionChannelDiscoverySchema = z.object({
  mode: z.enum(['auto', 'manual']).default('auto'),
  first_channel: z.coerce.number().int().min(1).max(256).default(1),
  last_channel: z.coerce.number().int().min(1).max(256).default(16)
});

const hikvisionChannelSchema = z.object({
  channel: z.coerce.number().int().min(1).max(256),
  track_id: z.string().regex(/^\d{3,4}$/),
  name: z.string().min(1).optional(),
  source_url: z.string().min(1).optional()
});

const hikvisionChannelSyncSchema = hikvisionChannelDiscoverySchema.extend({
  channels: z.array(hikvisionChannelSchema).optional()
});

type DeviceRow = {
  id: string;
  name: string;
  connection_type: string;
  archive_storage: string;
  dvr_server_id: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  rtsp_url: string | null;
  comment: string | null;
  status: string;
  last_check_at: string | null;
  is_enabled: boolean;
  has_password?: boolean;
  created_at: string;
  updated_at: string;
  node_name?: string | null;
  camera_count?: number;
};

function isConfigured(row: Pick<DeviceRow, 'name' | 'connection_type' | 'dvr_server_id' | 'host' | 'port' | 'username' | 'rtsp_url' | 'has_password'>): boolean {
  if (!row.name || !row.connection_type || !row.dvr_server_id) return false;
  if (row.connection_type === 'RTSP') return Boolean(row.rtsp_url || row.host);
  if (row.connection_type === 'ONVIF') return Boolean(row.host && row.port);
  if (row.connection_type === 'HIKVISION') return Boolean(row.host && row.port && row.username && row.has_password);
  return false;
}

function publicDevice(row: DeviceRow) {
  const { has_password, ...safeRow } = row;
  return {
    ...safeRow,
    camera_count: Number(row.camera_count || 0),
    is_configured: isConfigured(row)
  };
}

async function loadHikvisionDevice(id: string): Promise<HikvisionDevice & { dvr_server_id: string | null; archive_storage: string }> {
  const result = await query<HikvisionDevice & { connection_type: string; dvr_server_id: string | null; archive_storage: string }>(
    `SELECT id, name, connection_type, archive_storage, dvr_server_id, host, port, username, password, rtsp_url
       FROM devices
      WHERE id = $1`,
    [id]
  );
  if (!result.rowCount) throw new Error('Device not found');
  const device = result.rows[0];
  if (device.connection_type !== 'HIKVISION') throw new Error('Device is not HIKVISION');
  if (!device.host || !device.port || !device.username || !device.password) {
    throw new Error('Hikvision Host/IP, port, login and password are required');
  }
  return device;
}

function trackIdFromSource(sourceUrl: string | null | undefined): string | null {
  const match = String(sourceUrl || '').match(/\/Streaming\/(?:channels|tracks)\/(\d{3,4})/i);
  return match ? match[1] : null;
}

async function annotateExistingChannels(deviceId: string, channels: HikvisionChannel[]) {
  const existing = await query<{ id: string; name: string; stream_name: string; source_url: string }>(
    `SELECT id, name, stream_name, source_url
       FROM cameras
      WHERE device_id = $1`,
    [deviceId]
  );
  const byTrack = new Map<string, typeof existing.rows[number]>();
  for (const camera of existing.rows) {
    const track = trackIdFromSource(camera.source_url);
    if (track) byTrack.set(track, camera);
  }
  return channels.map((channel) => {
    const camera = byTrack.get(channel.track_id) || null;
    return {
      ...channel,
      exists: Boolean(camera),
      camera_id: camera?.id || null,
      stream_name: camera?.stream_name || null
    };
  });
}

async function uniqueStreamName(base: string): Promise<string> {
  let candidate = base.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'camera';
  for (let index = 0; index < 100; index += 1) {
    const value = index ? `${candidate}_${index}` : candidate;
    const exists = await query<{ id: string }>('SELECT id FROM cameras WHERE stream_name = $1', [value]);
    if (!exists.rowCount) return value;
  }
  return `${candidate}_${Date.now()}`;
}

async function bumpNodeConfig(dvrServerId: string | null) {
  if (!dvrServerId) return;
  await query(
    `UPDATE dvr_servers
        SET config_generation = config_generation + 1,
            updated_at = now()
      WHERE id = $1`,
    [dvrServerId]
  );
}

devicesRouter.get('/', asyncHandler(async (_req, res) => {
  const result = await query<DeviceRow>(
    `SELECT d.id, d.name, d.connection_type, d.archive_storage, d.dvr_server_id, d.host, d.port,
            d.username, d.rtsp_url, d.comment, d.status, d.last_check_at,
            d.is_enabled, d.created_at, d.updated_at,
            (d.password IS NOT NULL AND d.password <> '') AS has_password,
            ds.name AS node_name,
            (SELECT count(*)::int FROM cameras c WHERE c.device_id = d.id) AS camera_count
       FROM devices d
       LEFT JOIN dvr_servers ds ON ds.id = d.dvr_server_id
      ORDER BY d.created_at DESC`
  );
  res.json({ items: result.rows.map(publicDevice) });
}));

devicesRouter.get('/:id', asyncHandler(async (req, res) => {
  const result = await query<DeviceRow>(
    `SELECT d.id, d.name, d.connection_type, d.archive_storage, d.dvr_server_id, d.host, d.port,
            d.username, d.rtsp_url, d.comment, d.status, d.last_check_at,
            d.is_enabled, d.created_at, d.updated_at,
            (d.password IS NOT NULL AND d.password <> '') AS has_password,
            ds.name AS node_name,
            (SELECT count(*)::int FROM cameras c WHERE c.device_id = d.id) AS camera_count
       FROM devices d
       LEFT JOIN dvr_servers ds ON ds.id = d.dvr_server_id
      WHERE d.id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Device not found' });

  const cameras = await query(
    `SELECT c.id, c.name, c.stream_name, c.retention_days, c.archive_storage, c.is_enabled,
            c.dvr_server_id, ds.name AS node_name
       FROM cameras c
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
      WHERE c.device_id = $1
      ORDER BY c.name ASC`,
    [req.params.id]
  );

  res.json({ item: publicDevice(result.rows[0]), cameras: cameras.rows });
}));

devicesRouter.post('/:id/hikvision/channels/discover', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = hikvisionChannelDiscoverySchema.parse(req.body || {});
  const device = await loadHikvisionDevice(req.params.id);
  const channels = body.mode === 'manual'
    ? generateHikvisionChannels(device, body.first_channel, body.last_channel)
    : await discoverHikvisionChannels(device);

  await query('UPDATE devices SET status = $2, last_check_at = now() WHERE id = $1', [req.params.id, 'online']);
  res.json({ items: await annotateExistingChannels(req.params.id, channels), mode: body.mode });
}));

devicesRouter.post('/:id/hikvision/channels/sync', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = hikvisionChannelSyncSchema.parse(req.body || {});
  const device = await loadHikvisionDevice(req.params.id);
  const requestedChannels = body.channels?.length
    ? body.channels.map((channel): HikvisionChannel => ({
        channel: channel.channel,
        track_id: channel.track_id,
        name: channel.name || `${device.name} channel ${channel.channel}`,
        online: null,
        enabled: true,
        source_url: channel.source_url || hikvisionRtspUrl(device, channel.track_id),
        discovered_by: body.mode === 'manual' ? 'manual' : 'input_proxy_status'
      }))
    : body.mode === 'manual'
      ? generateHikvisionChannels(device, body.first_channel, body.last_channel)
      : await discoverHikvisionChannels(device);

  const channels = await annotateExistingChannels(req.params.id, requestedChannels);
  const created: Array<{ id: string; track_id: string; stream_name: string }> = [];
  const skipped = channels.filter((channel) => channel.exists).map((channel) => ({
    track_id: channel.track_id,
    camera_id: channel.camera_id,
    stream_name: channel.stream_name
  }));

  for (const channel of channels) {
    if (channel.exists) continue;
    const streamName = await uniqueStreamName(`hik_${device.id.slice(0, 8)}_ch${channel.channel}`);
    const result = await query<{ id: string }>(
      `INSERT INTO cameras(
         name, stream_name, source_url, dvr_server_id, device_id, archive_storage, retention_days, is_enabled
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       RETURNING id`,
      [
        channel.name || `${device.name} channel ${channel.channel}`,
        streamName,
        channel.source_url || hikvisionRtspUrl(device, channel.track_id),
        device.dvr_server_id,
        device.id,
        device.archive_storage || 'node',
        7
      ]
    );
    created.push({ id: result.rows[0].id, track_id: channel.track_id, stream_name: streamName });
  }

  if (created.length) await bumpNodeConfig(device.dvr_server_id);
  await audit(req, 'device.hikvision_channels_sync', 'device', req.params.id, { created: created.length, skipped: skipped.length });
  res.json({ ok: true, created, skipped });
}));

devicesRouter.post('/', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = deviceSchema.parse(req.body);
  const result = await query<{ id: string }>(
    `INSERT INTO devices(
       name, connection_type, archive_storage, dvr_server_id, host, port, username,
       password, rtsp_url, comment, status, is_enabled
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      body.name,
      body.connection_type,
      body.archive_storage,
      body.dvr_server_id ?? null,
      body.host ?? null,
      body.port ?? null,
      body.username ?? null,
      body.password ?? null,
      body.rtsp_url ?? null,
      body.comment ?? null,
      body.status,
      body.is_enabled
    ]
  );
  await audit(req, 'device.create', 'device', result.rows[0].id, { connection_type: body.connection_type });
  res.status(201).json({ id: result.rows[0].id });
}));

devicesRouter.patch('/:id', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = deviceUpdateSchema.parse(req.body);
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  if (!entries.length) return res.json({ ok: true });

  const affectedBefore = await query<{ dvr_server_id: string }>(
    `SELECT DISTINCT dvr_server_id
       FROM cameras
      WHERE device_id = $1
        AND dvr_server_id IS NOT NULL`,
    [req.params.id]
  );

  const sets = entries.map(([key], idx) => `${key} = $${idx + 2}`).join(', ');
  const values = entries.map(([, value]) => value);
  const result = await query(`UPDATE devices SET ${sets} WHERE id = $1`, [req.params.id, ...values]);
  if (!result.rowCount) return res.status(404).json({ error: 'Device not found' });

  const cameraUpdates: Array<[string, unknown]> = [];
  if (body.archive_storage !== undefined) cameraUpdates.push(['archive_storage', body.archive_storage]);
  if (body.dvr_server_id !== undefined) cameraUpdates.push(['dvr_server_id', body.dvr_server_id ?? null]);
  if (cameraUpdates.length) {
    const cameraSets = cameraUpdates.map(([key], idx) => `${key} = $${idx + 2}`).join(', ');
    await query(`UPDATE cameras SET ${cameraSets} WHERE device_id = $1`, [req.params.id, ...cameraUpdates.map(([, value]) => value)]);

    const affectedAfter = await query<{ dvr_server_id: string }>(
      `SELECT DISTINCT dvr_server_id
         FROM cameras
        WHERE device_id = $1
          AND dvr_server_id IS NOT NULL`,
      [req.params.id]
    );
    const affectedNodeIds = Array.from(new Set([...affectedBefore.rows, ...affectedAfter.rows].map((row) => row.dvr_server_id)));
    if (affectedNodeIds.length) {
      await query(
        `UPDATE dvr_servers
            SET config_generation = config_generation + 1,
                updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [affectedNodeIds]
      );
    }
  }

  await audit(req, 'device.update', 'device', req.params.id, { fields: entries.map(([key]) => key) });
  res.json({ ok: true });
}));

devicesRouter.delete('/:id', requireRole('super_admin'), asyncHandler(async (req, res) => {
  await query('DELETE FROM camera_events e USING cameras c WHERE e.camera_id = c.id AND c.device_id = $1', [req.params.id]);
  await query('DELETE FROM playback_access_tokens t USING cameras c WHERE t.camera_id = c.id AND c.device_id = $1', [req.params.id]);
  await query(
    `UPDATE dvr_servers
        SET config_generation = config_generation + 1,
            updated_at = now()
      WHERE id IN (
        SELECT DISTINCT dvr_server_id
          FROM cameras
         WHERE device_id = $1
           AND dvr_server_id IS NOT NULL
      )`,
    [req.params.id]
  );
  await query('DELETE FROM cameras WHERE device_id = $1', [req.params.id]);
  const result = await query('DELETE FROM devices WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Device not found' });
  await audit(req, 'device.delete', 'device', req.params.id);
  res.json({ ok: true });
}));
