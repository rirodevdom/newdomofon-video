import { query } from '../db.js';
import type { AuthUser } from '../types.js';

export async function canAccessCamera(user: AuthUser, cameraId: string): Promise<boolean> {
  if (user.role === 'super_admin' || user.role === 'operator') return true;
  const result = await query(
    `SELECT 1
       FROM cameras c
      WHERE c.id = $1 AND c.is_enabled = true
      LIMIT 1`,
    [cameraId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function canAccessStream(user: AuthUser, streamName: string): Promise<boolean> {
  const camera = await query<{ id: string }>('SELECT id FROM cameras WHERE stream_name = $1 AND is_enabled = true', [streamName]);
  if (!camera.rowCount) return false;
  return canAccessCamera(user, camera.rows[0].id);
}
