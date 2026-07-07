import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { audit } from '../utils/audit.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest, Role } from '../types.js';

export const authRouter = Router();

const loginSchema = z.object({ login: z.string().min(1), password: z.string().min(1) });

authRouter.post('/login', asyncHandler(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const result = await query<{ id: string; login: string; password_hash: string; role: Role; is_active: boolean }>(
    'SELECT id, login, password_hash, role, is_active FROM users WHERE login = $1',
    [body.login]
  );
  const user = result.rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(body.password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const payload = { id: user.id, login: user.login, role: user.role };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' });
  await audit(req, 'auth.login', 'user', user.id);
  res.json({ token, user: payload });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: (req as AuthRequest).user });
}));
