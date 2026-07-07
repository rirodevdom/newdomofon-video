import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { canAccessCamera } from '../services/cameraAccess.js';
import type { AuthRequest } from '../types.js';

export const favoritesRouter = Router();
favoritesRouter.use(requireAuth);

favoritesRouter.get('/', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const result = await query(
    `SELECT c.* FROM user_favorites f JOIN cameras c ON c.id = f.camera_id WHERE f.user_id = $1 ORDER BY c.name`,
    [authReq.user!.id]
  );
  res.json({ items: result.rows });
}));

favoritesRouter.post('/:cameraId', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  await query('INSERT INTO user_favorites(user_id, camera_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [authReq.user!.id, req.params.cameraId]);
  res.json({ ok: true });
}));

favoritesRouter.delete('/:cameraId', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  await query('DELETE FROM user_favorites WHERE user_id = $1 AND camera_id = $2', [authReq.user!.id, req.params.cameraId]);
  res.json({ ok: true });
}));
