import type { Request } from 'express';
import { query } from '../db.js';
import type { AuthRequest } from '../types.js';

export async function audit(req: Request, action: string, entityType?: string, entityId?: string, meta: Record<string, unknown> = {}) {
  const authReq = req as AuthRequest;
  await query(
    'INSERT INTO audit_log(user_id, action, entity_type, entity_id, ip, user_agent, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [authReq.user?.id ?? null, action, entityType ?? null, entityId ?? null, req.ip, req.get('user-agent') ?? null, meta]
  );
}
