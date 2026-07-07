import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, requireRole, isAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';
import { canAccessCamera } from '../services/cameraAccess.js';
import type { AuthRequest } from '../types.js';

export const camerasRouter = Router();
camerasRouter.use(requireAuth);

const nullableString = z.string().nullable().optional();

const cameraSchema = z.object({
  name: z.string().min(1),
  stream_name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  source_url: z.string().min(1),
  archive_storage: z.enum(['node', 'device', 'both']).default('node'),
  group_id: z.string().uuid().nullable().optional(),
  dvr_server_id: z.string().uuid().nullable().optional(),
  device_id: z.string().uuid(),
  rtmp_push_url: nullableString,
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  direction_deg: z.number().int().nullable().optional(),
  fov_deg: z.number().int().nullable().optional(),
  retention_days: z.number().int().min(1).max(365).default(7),
  is_enabled: z.boolean().default(true),
  onvif_xaddr: nullableString,
  onvif_port: z.number().int().min(1).max(65535).nullable().optional(),
  onvif_username: nullableString,
  onvif_password: nullableString,
  onvif_profile_token: nullableString,
  onvif_device_info: z.record(z.any()).nullable().optional(),
  onvif_last_sync_at: z.string().datetime().nullable().optional(),
  _onvif_requery: z.boolean().optional()
});

const cameraUpdateSchema = cameraSchema.partial();

function normalizeBody(body: z.infer<typeof cameraUpdateSchema>) {
  const normalized: Record<string, unknown> = { ...body };
  for (const key of ['group_id', 'dvr_server_id', 'device_id', 'onvif_xaddr', 'onvif_port', 'onvif_username', 'onvif_password', 'onvif_profile_token', 'onvif_device_info', 'onvif_last_sync_at']) {
    if (key in body) normalized[key] = (body as Record<string, unknown>)[key] ?? null;
  }
  if ('rtmp_push_url' in body) normalized.rtmp_push_url = null;
  if ('latitude' in body) normalized.latitude = null;
  if ('longitude' in body) normalized.longitude = null;
  if ('direction_deg' in body) normalized.direction_deg = null;
  if ('fov_deg' in body) normalized.fov_deg = null;
  return normalized as z.infer<typeof cameraUpdateSchema>;
}

function publicFields(input: Record<string, unknown>) {
  const clone: Record<string, unknown> = { ...input };
  delete clone._onvif_requery;
  return clone;
}

const cameraSelect = `
  c.id, c.group_id, c.dvr_server_id, c.device_id, c.name, c.stream_name, c.source_url,
  c.archive_storage, c.rtmp_push_url, c.latitude, c.longitude, c.direction_deg, c.fov_deg, c.retention_days,
  c.is_enabled, c.created_at, c.updated_at, c.onvif_xaddr, c.onvif_port, c.onvif_username,
  c.onvif_profile_token, c.onvif_device_info, c.onvif_last_sync_at,
  (c.onvif_xaddr IS NOT NULL) AS is_onvif
`;

camerasRouter.get('/', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  if (isAdmin(authReq)) {
    const result = await query(
      `SELECT ${cameraSelect}, cg.name AS group_name, ds.name AS dvr_server_name,
              d.name AS device_name, d.connection_type AS device_connection_type, d.archive_storage AS device_archive_storage,
              EXISTS(SELECT 1 FROM user_favorites f WHERE f.camera_id = c.id AND f.user_id = $1) AS favorite
         FROM cameras c
         LEFT JOIN camera_groups cg ON cg.id = c.group_id
         LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
         LEFT JOIN devices d ON d.id = c.device_id
        ORDER BY c.name ASC`,
      [authReq.user!.id]
    );
    return res.json({ items: result.rows });
  }

  const result = await query(
    `SELECT ${cameraSelect}, cg.name AS group_name, ds.name AS dvr_server_name,
            d.name AS device_name, d.connection_type AS device_connection_type, d.archive_storage AS device_archive_storage,
            EXISTS(SELECT 1 FROM user_favorites f WHERE f.camera_id = c.id AND f.user_id = $1) AS favorite
       FROM cameras c
       LEFT JOIN camera_groups cg ON cg.id = c.group_id
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
       LEFT JOIN devices d ON d.id = c.device_id
      WHERE c.is_enabled = true
      ORDER BY c.name ASC`,
    [authReq.user!.id]
  );
  res.json({ items: result.rows });
}));

camerasRouter.get('/:id', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  if (!await canAccessCamera(authReq.user!, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
  const result = await query(
    `SELECT ${cameraSelect},
            d.name AS device_name, d.connection_type AS device_connection_type,
            d.archive_storage AS device_archive_storage, ds.name AS dvr_server_name
       FROM cameras c
       LEFT JOIN devices d ON d.id = c.device_id
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
      WHERE c.id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Camera not found' });
  res.json({ item: result.rows[0] });
}));

camerasRouter.post('/', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = normalizeBody(cameraSchema.parse(req.body));
  const device = await query<{ id: string }>('SELECT id FROM devices WHERE id = $1', [body.device_id]);
  if (!device.rowCount) return res.status(400).json({ error: 'Device is required for camera' });

  const result = await query<{ id: string }>(
    `INSERT INTO cameras(
       name, stream_name, source_url, group_id, dvr_server_id, device_id, rtmp_push_url,
       latitude, longitude, direction_deg, fov_deg, archive_storage, retention_days, is_enabled,
       onvif_xaddr, onvif_port, onvif_username, onvif_password, onvif_profile_token, onvif_device_info, onvif_last_sync_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      body.name, body.stream_name, body.source_url, body.group_id ?? null, body.dvr_server_id ?? null, body.device_id,
      body.archive_storage, body.retention_days, body.is_enabled,
      body.onvif_xaddr, body.onvif_port, body.onvif_username, body.onvif_password, body.onvif_profile_token, body.onvif_device_info, body.onvif_last_sync_at
    ]
  );

  await audit(req, 'camera.create', 'camera', result.rows[0].id, {
    stream_name: body.stream_name,
    type: body.onvif_xaddr ? 'onvif' : 'rtsp'
  });
  res.status(201).json({ id: result.rows[0].id });
}));

async function updateCamera(req: AuthRequest, res: any) {
  const raw = cameraUpdateSchema.parse(req.body);
  const body = normalizeBody(raw);
  if ('device_id' in body && !body.device_id) {
    return res.status(400).json({ error: 'Device is required for camera' });
  }
  if (body.device_id) {
    const device = await query<{ id: string }>('SELECT id FROM devices WHERE id = $1', [body.device_id]);
    if (!device.rowCount) return res.status(400).json({ error: 'Device not found' });
  }

  const existingResult = await query(
    `SELECT id, source_url, onvif_xaddr, onvif_port, onvif_username, onvif_password
       FROM cameras
      WHERE id = $1`,
    [req.params.id]
  );

  if (!existingResult.rowCount) return res.status(404).json({ error: 'Camera not found' });

  if (body.onvif_xaddr && body.source_url !== undefined && raw._onvif_requery !== true) {
    return res.status(409).json({
      error: 'ONVIF camera source_url can be changed only after ONVIF stream lookup.'
    });
  }

  const allowed = publicFields(body);
  const fields = Object.entries(allowed).filter(([, v]) => v !== undefined);

  if (!fields.length) return res.json({ ok: true });

  const sets = fields.map(([key], idx) => `${key} = $${idx + 2}`).join(', ');
  await query(`UPDATE cameras SET ${sets} WHERE id = $1`, [req.params.id, ...fields.map(([, v]) => v)]);
  await audit(req, 'camera.update', 'camera', req.params.id, { fields: fields.map(([key]) => key) });
  res.json({ ok: true });
}

camerasRouter.patch('/:id', requireRole('super_admin', 'operator'), asyncHandler(updateCamera));
camerasRouter.put('/:id', requireRole('super_admin', 'operator'), asyncHandler(updateCamera));

camerasRouter.delete('/:id', requireRole('super_admin'), asyncHandler(async (req, res) => {
  await query('DELETE FROM cameras WHERE id = $1', [req.params.id]);
  await audit(req, 'camera.delete', 'camera', req.params.id);
  res.json({ ok: true });
}));
