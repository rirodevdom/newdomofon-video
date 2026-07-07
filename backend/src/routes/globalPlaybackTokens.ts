import { Router } from 'express';

export const globalPlaybackTokensRouter = Router();

function sharedToken() {
  return process.env.RESTREAM_PUBLIC_TOKEN || process.env.VITE_RESTREAM_PUBLIC_TOKEN || '';
}

globalPlaybackTokensRouter.post('/', (req, res) => {
  const token = sharedToken();

  if (!token) {
    return res.status(500).json({ error: 'RESTREAM_PUBLIC_TOKEN is not configured' });
  }

  const ttlSeconds = Number((req.body && (req.body.ttl_seconds || req.body.ttlSeconds)) || 0);
  const expiresAt = ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;

  return res.status(200).json({
    token,
    access_token: token,
    token_type: 'global-restream-token',
    scope: 'all-cameras',
    expires_at: expiresAt
  });
});
