import { Router } from 'express';

export const mediaGlobalPublicTokenRouter = Router();

const DVR_ENGINE_URL = (process.env.DVR_ENGINE_URL || process.env.DVR_URL || 'http://127.0.0.1:3010').replace(/\/+$/, '');

function sharedToken() {
  return process.env.RESTREAM_PUBLIC_TOKEN || process.env.VITE_RESTREAM_PUBLIC_TOKEN || '';
}

function q(value: unknown) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function isBadStreamName(value: string) {
  return !value || value === 'undefined' || value === 'null' || value.includes('..') || value.includes('/');
}

function requireGlobalToken(req: any, res: any, next: any) {
  const expected = sharedToken();
  const actual = q(req.query.token);

  if (!expected) {
    return res.status(500).json({ error: 'RESTREAM_PUBLIC_TOKEN is not configured' });
  }

  if (actual !== expected) {
    return res.status(401).json({
      error: 'Invalid playback token'
    });
  }

  return next();
}

function appendTokenToPlaylist(body: string, token: string) {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) return line;
      if (trimmed.includes('token=')) return line;

      const sep = trimmed.includes('?') ? '&' : '?';
      return `${trimmed}${sep}token=${encodeURIComponent(token)}`;
    })
    .join('\n');
}

async function proxyPlaylist(req: any, res: any, upstreamUrl: string) {
  const token = q(req.query.token);
  const upstream = await fetch(upstreamUrl, {
    headers: { accept: '*/*', 'user-agent': 'newdomofon-global-media-proxy-v33' }
  });

  const body = await upstream.text();

  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('cache-control', upstream.headers.get('cache-control') || 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  return res.status(upstream.status).send(upstream.ok ? appendTokenToPlaylist(body, token) : body);
}

mediaGlobalPublicTokenRouter.get('/:streamName/live.m3u8', requireGlobalToken, async (req: any, res: any) => {
  const streamRaw = String(req.params.streamName || '').trim();

  if (isBadStreamName(streamRaw)) {
    return res.status(400).json({ error: 'Invalid stream_name', stream_name: streamRaw });
  }

  const stream = encodeURIComponent(streamRaw);
  return proxyPlaylist(req, res, `${DVR_ENGINE_URL}/cameras/${stream}/live.m3u8`);
});

mediaGlobalPublicTokenRouter.get('/:streamName/archive.m3u8', requireGlobalToken, async (req: any, res: any) => {
  const streamRaw = String(req.params.streamName || '').trim();

  if (isBadStreamName(streamRaw)) {
    return res.status(400).json({ error: 'Invalid stream_name', stream_name: streamRaw });
  }

  const stream = encodeURIComponent(streamRaw);
  const params = new URLSearchParams();

  if (req.query.start) params.set('start', q(req.query.start));
  if (req.query.end) params.set('end', q(req.query.end));

  const suffix = params.toString() ? `?${params.toString()}` : '';
  return proxyPlaylist(req, res, `${DVR_ENGINE_URL}/cameras/${stream}/archive.m3u8${suffix}`);
});

mediaGlobalPublicTokenRouter.get('/:streamName/*', requireGlobalToken, async (req: any, res: any) => {
  const streamRaw = String(req.params.streamName || '').trim();

  if (isBadStreamName(streamRaw)) {
    return res.status(400).json({ error: 'Invalid stream_name', stream_name: streamRaw });
  }

  const restRaw = String(req.params[0] || '');

  if (!restRaw || restRaw.includes('..')) {
    return res.status(400).json({ error: 'Invalid media path' });
  }

  const stream = encodeURIComponent(streamRaw);
  const rest = restRaw
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  const upstream = await fetch(`${DVR_ENGINE_URL}/cameras/${stream}/${rest}`, {
    headers: { accept: '*/*', 'user-agent': 'newdomofon-global-media-proxy-v33' }
  });

  const buffer = Buffer.from(await upstream.arrayBuffer());

  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('cache-control', upstream.headers.get('cache-control') || 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  return res.status(upstream.status).send(buffer);
});
