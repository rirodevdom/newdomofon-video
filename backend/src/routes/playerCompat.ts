import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { AuthRequest } from '../types.js';

export const playerCompatRouter = Router();

playerCompatRouter.use(requireAuth);

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function issuePlaybackToken(cameraId: string, userId: string, ttlSeconds = 3600) {
  const cameraResult = await query(
    `SELECT id, name, stream_name
       FROM public.cameras
      WHERE id = $1
      LIMIT 1`,
    [cameraId]
  );

  if (!cameraResult.rowCount) {
    return null;
  }

  const camera = cameraResult.rows[0];
  const token = createToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await query(
    `INSERT INTO public.playback_access_tokens(token, camera_id, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, camera.id, userId, expiresAt]
  );

  return {
    token,
    expires_at: expiresAt.toISOString(),
    camera_id: camera.id,
    camera_name: camera.name,
    stream_name: camera.stream_name,
    live_url: `/api/media/${encodeURIComponent(camera.stream_name)}/live.m3u8?token=${encodeURIComponent(token)}`,
    archive_url: `/api/media/${encodeURIComponent(camera.stream_name)}/archive.m3u8?token=${encodeURIComponent(token)}`
  };
}

playerCompatRouter.get('/:cameraId/live', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const issued = await issuePlaybackToken(req.params.cameraId, authReq.user!.id);

  if (!issued) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  res.json({
    ...issued,
    url: issued.live_url,
    hls_url: issued.live_url,
    playback_url: issued.live_url
  });
}));

playerCompatRouter.get('/:cameraId/archive', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const issued = await issuePlaybackToken(req.params.cameraId, authReq.user!.id);

  if (!issued) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  const params = new URLSearchParams();
  if (req.query.start) params.set('start', String(req.query.start));
  if (req.query.end) params.set('end', String(req.query.end));
  params.set('token', issued.token);

  const archiveUrl = `/api/media/${encodeURIComponent(issued.stream_name)}/archive.m3u8?${params.toString()}`;

  res.json({
    ...issued,
    archive_url: archiveUrl,
    url: archiveUrl,
    hls_url: archiveUrl,
    playback_url: archiveUrl
  });
}));
