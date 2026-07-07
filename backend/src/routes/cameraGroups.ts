import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';

export const cameraGroupsRouter = Router();
cameraGroupsRouter.use(requireAuth);

const schema = z.object({ name: z.string().min(1) });

cameraGroupsRouter.get('/', asyncHandler(async (_req, res) => {
  const result = await query('SELECT * FROM camera_groups ORDER BY name ASC');
  res.json({ items: result.rows });
}));

cameraGroupsRouter.post('/', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = schema.parse(req.body);
  const result = await query<{ id: string }>('INSERT INTO camera_groups(name) VALUES ($1) RETURNING id', [body.name]);
  await audit(req, 'camera_group.create', 'camera_group', result.rows[0].id);
  res.status(201).json({ id: result.rows[0].id });
}));

cameraGroupsRouter.patch('/:id', requireRole('super_admin', 'operator'), asyncHandler(async (req, res) => {
  const body = schema.partial().parse(req.body);
  if (body.name) await query('UPDATE camera_groups SET name = $2 WHERE id = $1', [req.params.id, body.name]);
  await audit(req, 'camera_group.update', 'camera_group', req.params.id);
  res.json({ ok: true });
}));

cameraGroupsRouter.delete('/:id', requireRole('super_admin'), asyncHandler(async (req, res) => {
  await query('DELETE FROM camera_groups WHERE id = $1', [req.params.id]);
  await audit(req, 'camera_group.delete', 'camera_group', req.params.id);
  res.json({ ok: true });
}));
