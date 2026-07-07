import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const mediaRouter = Router();

function sha256(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function verifyPlaybackToken(token: string, streamName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
       FROM playback_tokens pt
       JOIN cameras c ON c.id = pt.camera_id
      WHERE pt.token_hash = $1
        AND pt.expires_at > now()
        AND c.stream_name = $2
        AND c.is_enabled = true
      LIMIT 1`,
    [sha256(token), streamName]
  );
  return (result.rowCount ?? 0) > 0;
}

async function dvrFetch(url: string, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function signedFileUrl(streamName: string, token: string, filePath: string): string {
  const safe = filePath.split('/').map(encodeURIComponent).join('/');
  return `${config.mediaPublicBaseUrl}/${streamName}/file/${safe}?token=${encodeURIComponent(token)}`;
}

function rewritePlaylist(streamName: string, token: string, playlist: string): string {
  return playlist.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return line;
    return signedFileUrl(streamName, token, trimmed.replace(/^\/+/, ''));
  }).join('\n');
}

async function proxyText(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const upstream = await dvrFetch(url);
  return {
    status: upstream.status,
    body: await upstream.text(),
    contentType: upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl'
  };
}

function setNoStore(res: import('express').Response): void {
  res.setHeader('cache-control', 'no-store');
}

mediaRouter.get('/:streamName/live.m3u8', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const streamName = req.params.streamName;
  if (!token || !(await verifyPlaybackToken(token, streamName))) return res.status(403).json({ error: 'Invalid playback token' });
  const upstreamUrl = `${config.dvrEngineUrl}/cameras/${encodeURIComponent(streamName)}/live.m3u8`;
  const upstream = await proxyText(upstreamUrl);
  setNoStore(res);
  res.status(upstream.status).type('application/vnd.apple.mpegurl').send(rewritePlaylist(streamName, token, upstream.body));
}));

mediaRouter.get('/:streamName/archive.m3u8', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const streamName = req.params.streamName;
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!token || !(await verifyPlaybackToken(token, streamName))) return res.status(403).json({ error: 'Invalid playback token' });
  const qs = new URLSearchParams({ start, end });
  const upstreamUrl = `${config.dvrEngineUrl}/cameras/${encodeURIComponent(streamName)}/archive.m3u8?${qs.toString()}`;
  const upstream = await proxyText(upstreamUrl);
  setNoStore(res);
  res.status(upstream.status).type('application/vnd.apple.mpegurl').send(rewritePlaylist(streamName, token, upstream.body));
}));

mediaRouter.get('/:streamName/export.mp4', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const streamName = req.params.streamName;
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!token || !(await verifyPlaybackToken(token, streamName))) return res.status(403).json({ error: 'Invalid playback token' });
  const qs = new URLSearchParams({ start, end });
  const upstream = await dvrFetch(`${config.dvrEngineUrl}/cameras/${encodeURIComponent(streamName)}/export.mp4?${qs.toString()}`, 3_700_000);
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'video/mp4');
  setNoStore(res);
  const filename = `${streamName}-${start}-${end}.mp4`.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  if (upstream.ok) res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}));

mediaRouter.get('/:streamName/file/*', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const streamName = req.params.streamName;
  const filePath = req.params[0];
  if (!token || !(await verifyPlaybackToken(token, streamName))) return res.status(403).json({ error: 'Invalid playback token' });
  const upstream = await dvrFetch(`${config.dvrEngineUrl}/files/${encodeURIComponent(streamName)}/${filePath.split('/').map(encodeURIComponent).join('/')}`);
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'video/mp2t');
  setNoStore(res);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}));
