import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';

export const dvrServersRouter = Router();
dvrServersRouter.use(requireAuth);

const schema = z.object({
  name: z.string().min(1),
  base_url: z.string().min(1).optional(),
  public_base_url: z.string().min(1).optional(),
  internal_url: z.string().optional().nullable(),
  status: z.string().optional(),
  is_enabled: z.boolean().optional(),
  capabilities: z.record(z.any()).optional()
});

function createSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

dvrServersRouter.get('/', asyncHandler(async (_req, res) => {
  const result = await query(
    `SELECT id, name, base_url, public_base_url, internal_url, status, last_seen_at,
            version, capabilities, storage, is_enabled, config_generation,
            created_at, updated_at,
            EXISTS(SELECT 1 FROM cameras c WHERE c.dvr_server_id = dvr_servers.id) AS has_cameras,
            (SELECT count(*)::int FROM cameras c WHERE c.dvr_server_id = dvr_servers.id) AS camera_count,
            (SELECT count(*)::int FROM devices d WHERE d.dvr_server_id = dvr_servers.id) AS device_count
       FROM dvr_servers
      ORDER BY created_at DESC`
  );
  res.json({ items: result.rows });
}));

dvrServersRouter.post('/', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = schema.parse(req.body);
  const agentToken = createSecret();
  const mediaSecret = createSecret();
  const publicBaseUrl = body.public_base_url || body.base_url || '';
  const result = await query<{ id: string }>(
    `INSERT INTO dvr_servers(
       name, base_url, public_base_url, internal_url, status,
       agent_token_hash, media_secret, is_enabled, capabilities
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      body.name,
      publicBaseUrl,
      publicBaseUrl,
      body.internal_url ?? null,
      body.status ?? 'unknown',
      sha256(agentToken),
      mediaSecret,
      body.is_enabled ?? true,
      JSON.stringify(body.capabilities || {})
    ]
  );
  await audit(req, 'dvr_server.create', 'dvr_server', result.rows[0].id);
  res.status(201).json({
    id: result.rows[0].id,
    node_id: result.rows[0].id,
    agent_token: agentToken,
    media_secret: mediaSecret
  });
}));

dvrServersRouter.patch('/:id', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = schema.partial().parse(req.body);
  const normalized = {
    ...body,
    base_url: body.public_base_url || body.base_url,
    public_base_url: body.public_base_url || body.base_url
  };
  const fields = Object.entries(normalized).filter(([, v]) => v !== undefined);
  if (fields.length) {
    const sets = fields.map(([key], idx) => `${key} = $${idx + 2}`).join(', ');
    const values = fields.map(([key, v]) => key === 'capabilities' ? JSON.stringify(v) : v);
    await query(`UPDATE dvr_servers SET ${sets}, config_generation = config_generation + 1 WHERE id = $1`, [req.params.id, ...values]);
  }
  await audit(req, 'dvr_server.update', 'dvr_server', req.params.id);
  res.json({ ok: true });
}));

dvrServersRouter.post('/:id/rotate-token', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const agentToken = createSecret();
  const mediaSecret = req.body?.rotate_media_secret === false ? null : createSecret();
  const result = await query(
    `UPDATE dvr_servers
        SET agent_token_hash = $2,
            media_secret = COALESCE($3, media_secret),
            config_generation = config_generation + 1
      WHERE id = $1
      RETURNING id`,
    [req.params.id, sha256(agentToken), mediaSecret]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Node not found' });
  await audit(req, 'dvr_server.rotate_token', 'dvr_server', req.params.id);
  res.json({ node_id: req.params.id, agent_token: agentToken, media_secret: mediaSecret || undefined });
}));

dvrServersRouter.post('/:id/assign-cameras', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const cameraIds = z.array(z.string().uuid()).parse(req.body?.camera_ids || req.body?.cameraIds || []);
  await query('UPDATE cameras SET dvr_server_id = $1 WHERE id = ANY($2::uuid[])', [req.params.id, cameraIds]);
  await query('UPDATE dvr_servers SET config_generation = config_generation + 1 WHERE id = $1', [req.params.id]);
  await query(
    `INSERT INTO node_commands(dvr_server_id, type, payload)
     VALUES ($1, 'reload_cameras', $2)`,
    [req.params.id, JSON.stringify({ camera_ids: cameraIds })]
  );
  await audit(req, 'dvr_server.assign_cameras', 'dvr_server', req.params.id, { camera_ids: cameraIds });
  res.json({ ok: true, assigned: cameraIds.length });
}));

dvrServersRouter.post('/:id/commands', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = z.object({
    type: z.string().min(1),
    payload: z.record(z.any()).optional()
  }).parse(req.body || {});
  const result = await query<{ id: string }>(
    'INSERT INTO node_commands(dvr_server_id, type, payload) VALUES ($1,$2,$3) RETURNING id',
    [req.params.id, body.type, JSON.stringify(body.payload || {})]
  );
  await audit(req, 'node_command.create', 'dvr_server', req.params.id, { command_id: result.rows[0].id, type: body.type });
  res.status(201).json({ id: result.rows[0].id });
}));

dvrServersRouter.delete('/:id', requireRole('super_admin'), asyncHandler(async (req, res) => {
  await query('DELETE FROM dvr_servers WHERE id = $1', [req.params.id]);
  await audit(req, 'dvr_server.delete', 'dvr_server', req.params.id);
  res.json({ ok: true });
}));
