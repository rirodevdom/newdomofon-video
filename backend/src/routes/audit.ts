import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('super_admin', 'operator'));

auditRouter.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const result = await query(
    `SELECT a.*, u.login
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json({ items: result.rows });
}));
