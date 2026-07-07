import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canAccessCamera } from '../services/cameraAccess.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { AuthRequest } from '../types.js';

export const playbackTokensRouter = Router();

playbackTokensRouter.use(requireAuth);

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseTtl(value: unknown) {
  const ttl = Number(value || 3600);
  if (!Number.isFinite(ttl)) return 3600;
  return Math.min(Math.max(Math.floor(ttl), 30), 86400);
}

function requestedCameraId(body: any) {
  return body?.camera_id || body?.cameraId || body?.id || body?.camera;
}

function requestedStreamName(body: any) {
  return body?.stream_name || body?.streamName || body?.stream;
}

async function findCamera(body: any) {
  const cameraId = requestedCameraId(body);
  const streamName = requestedStreamName(body);

  if (cameraId) {
    const result = await query(
      `SELECT id, stream_name
         FROM public.cameras
        WHERE id = $1
        LIMIT 1`,
      [cameraId]
    );

    return result.rowCount ? result.rows[0] : null;
  }

  if (streamName) {
    const result = await query(
      `SELECT id, stream_name
         FROM public.cameras
        WHERE stream_name = $1
        LIMIT 1`,
      [streamName]
    );

    return result.rowCount ? result.rows[0] : null;
  }

  return null;
}

playbackTokensRouter.post('/', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const body = req.body || {};
  const camera = await findCamera(body);

  if (!camera) {
    return res.status(404).json({
      error: 'Camera not found',
      accepted_fields: ['camera_id', 'cameraId', 'id', 'stream_name', 'streamName']
    });
  }
  if (!await canAccessCamera(authReq.user!, camera.id)) return res.status(403).json({ error: 'Forbidden' });

  const token = createToken();
  const expiresAt = new Date(Date.now() + parseTtl(body.ttl_seconds || body.ttlSeconds) * 1000);

await query(
    `INSERT INTO public.playback_tokens(token_hash, camera_id, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [crypto.createHash('sha256').update(token).digest('hex'), camera.id, authReq.user!.id, expiresAt]
  );

  res.status(201).json({
    token,
    expires_at: expiresAt.toISOString(),
    camera_id: camera.id,
    stream_name: camera.stream_name,
    live_url: `/api/media/${encodeURIComponent(camera.stream_name)}/live.m3u8?token=${encodeURIComponent(token)}`,
    archive_url: `/api/media/${encodeURIComponent(camera.stream_name)}/archive.m3u8?token=${encodeURIComponent(token)}`
  });
}));
