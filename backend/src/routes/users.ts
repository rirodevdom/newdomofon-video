import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('super_admin'));

const createSchema = z.object({
  login: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(['super_admin', 'operator', 'viewer', 'installer']),
  is_active: z.boolean().default(true),
  group_ids: z.array(z.string().uuid()).default([])
});

const updateSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(['super_admin', 'operator', 'viewer', 'installer']).optional(),
  is_active: z.boolean().optional(),
  group_ids: z.array(z.string().uuid()).optional()
});

usersRouter.get('/', asyncHandler(async (_req, res) => {
  const result = await query(
    `SELECT u.id, u.login, u.role, u.is_active, u.created_at,
            COALESCE(json_agg(ug.group_id) FILTER (WHERE ug.group_id IS NOT NULL), '[]') AS group_ids
       FROM users u
       LEFT JOIN user_camera_groups ug ON ug.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC`
  );
  res.json({ items: result.rows });
}));

usersRouter.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const hash = await bcrypt.hash(body.password, 12);
  const created = await query<{ id: string }>(
    'INSERT INTO users(login, password_hash, role, is_active) VALUES ($1,$2,$3,$4) RETURNING id',
    [body.login, hash, body.role, body.is_active]
  );
  for (const groupId of body.group_ids) {
    await query('INSERT INTO user_camera_groups(user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [created.rows[0].id, groupId]);
  }
  await audit(req, 'user.create', 'user', created.rows[0].id);
  res.status(201).json({ id: created.rows[0].id });
}));

usersRouter.patch('/:id', asyncHandler(async (req, res) => {
  const body = updateSchema.parse(req.body);
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 12);
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.params.id, hash]);
  }
  if (body.role !== undefined) await query('UPDATE users SET role = $2 WHERE id = $1', [req.params.id, body.role]);
  if (body.is_active !== undefined) await query('UPDATE users SET is_active = $2 WHERE id = $1', [req.params.id, body.is_active]);
  if (body.group_ids) {
    await query('DELETE FROM user_camera_groups WHERE user_id = $1', [req.params.id]);
    for (const groupId of body.group_ids) {
      await query('INSERT INTO user_camera_groups(user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, groupId]);
    }
  }
  await audit(req, 'user.update', 'user', req.params.id);
  res.json({ ok: true });
}));

usersRouter.delete('/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
  await audit(req, 'user.delete', 'user', req.params.id);
  res.json({ ok: true });
}));
