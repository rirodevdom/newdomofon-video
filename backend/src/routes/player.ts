import { Router, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canAccessCamera } from '../services/cameraAccess.js';
import { signNodeMediaToken, type NodeMediaScope } from '../services/nodeMediaToken.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { AuthRequest } from '../types.js';

export const playerPublicArchiveRouter = Router();
export const playerRouter = Router();

async function dvrJson(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const archiveSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  source: z.enum(['auto', 'node', 'device']).optional()
});

function sha256(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createPlaybackToken(userId: string, cameraId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.playbackTokenTtlSeconds * 1000);
  await query('INSERT INTO playback_tokens(user_id, camera_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)', [userId, cameraId, sha256(raw), expires]);
  return raw;
}

type CameraWithNode = {
  id: string;
  stream_name: string;
  archive_storage: 'node' | 'device' | 'both';
  device_archive_storage: 'node' | 'device' | 'both' | null;
  dvr_server_id: string | null;
  node_public_base_url: string | null;
  node_internal_url: string | null;
  node_media_secret: string | null;
  node_status: string | null;
  node_enabled: boolean | null;
};

async function getCameraWithNode(cameraId: string) {
  const result = await query<CameraWithNode>(
    `SELECT c.id, c.stream_name, c.archive_storage,
            d.archive_storage AS device_archive_storage,
            c.dvr_server_id,
            COALESCE(ds.public_base_url, ds.base_url) AS node_public_base_url,
            ds.internal_url AS node_internal_url,
            ds.media_secret AS node_media_secret,
            ds.status AS node_status,
            ds.is_enabled AS node_enabled
       FROM cameras c
       LEFT JOIN devices d ON d.id = c.device_id
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
      WHERE c.id = $1
      LIMIT 1`,
    [cameraId]
  );
  return result.rows[0] || null;
}

function effectiveArchiveStorage(camera: CameraWithNode): 'node' | 'device' | 'both' {
  if (camera.device_archive_storage === 'both') return 'both';
  return camera.archive_storage || camera.device_archive_storage || 'node';
}

type ArchiveStorage = 'node' | 'device' | 'both';
type ArchiveSource = 'node' | 'device';

function availableArchiveSources(storage: ArchiveStorage): ArchiveSource[] {
  if (storage === 'both') return ['node', 'device'];
  return [storage];
}

function defaultArchiveSource(storage: ArchiveStorage): ArchiveSource {
  return storage === 'device' ? 'device' : 'node';
}

function resolveArchiveSource(storage: ArchiveStorage, requested?: 'auto' | ArchiveSource): ArchiveSource {
  const sources = availableArchiveSources(storage);
  if (requested && requested !== 'auto' && sources.includes(requested)) return requested;
  return defaultArchiveSource(storage);
}

function normalizeNodeBaseUrl(raw: string | null | undefined) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function uniqueNodeBases(...bases: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of bases) {
    const normalized = normalizeNodeBaseUrl(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function nodeMediaUrl(camera: CameraWithNode, userId: string, scope: NodeMediaScope, pathSuffix: string, params: Record<string, string> = {}) {
  if (!camera.node_public_base_url || !camera.node_media_secret || camera.node_enabled === false) return null;
  return nodeMediaUrlWithBase(camera.node_public_base_url, camera, userId, scope, pathSuffix, params);
}

function nodeInternalMediaUrl(camera: CameraWithNode, userId: string, scope: NodeMediaScope, pathSuffix: string, params: Record<string, string> = {}) {
  if (!camera.node_media_secret || camera.node_enabled === false) return null;
  return nodeMediaUrlWithBase(camera.node_internal_url || camera.node_public_base_url, camera, userId, scope, pathSuffix, params);
}

function nodeMediaUrlWithBase(baseUrl: string | null, camera: CameraWithNode, userId: string, scope: NodeMediaScope, pathSuffix: string, params: Record<string, string> = {}) {
  const base = normalizeNodeBaseUrl(baseUrl);
  if (!base || !camera.node_media_secret) return null;
  const token = signNodeMediaToken(camera.node_media_secret, {
    camera_id: camera.id,
    stream_name: camera.stream_name,
    user_id: userId,
    scope
  });
  const qs = new URLSearchParams({ ...params, token });
  return `${base}/cameras/${encodeURIComponent(camera.stream_name)}/${pathSuffix}?${qs.toString()}`;
}


type ProxyArchiveAccess = {
  ok: true;
  userId: string;
} | {
  ok: false;
  status: number;
  error: string;
};

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyDeviceArchiveProxyToken(camera: CameraWithNode, rawToken: unknown): ProxyArchiveAccess {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, status: 401, error: 'Missing archive proxy token' };
  if (!camera.node_media_secret) return { ok: false, status: 503, error: 'Node media secret is not configured' };

  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, status: 401, error: 'Invalid archive proxy token' };

  const expected = crypto.createHmac('sha256', camera.node_media_secret).update(body).digest('base64url');
  if (!safeEqualString(sig, expected)) return { ok: false, status: 401, error: 'Invalid archive proxy token' };

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, status: 401, error: 'Invalid archive proxy token payload' };
  }

  if (payload.camera_id !== camera.id || payload.stream_name !== camera.stream_name || payload.scope !== 'archive') {
    return { ok: false, status: 403, error: 'Archive proxy token does not match camera' };
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    return { ok: false, status: 401, error: 'Archive proxy token expired' };
  }
  if (typeof payload.user_id !== 'string' || !payload.user_id) {
    return { ok: false, status: 401, error: 'Archive proxy token is missing user id' };
  }

  return { ok: true, userId: payload.user_id };
}

function createDeviceArchiveProxyToken(camera: CameraWithNode, userId: string) {
  if (!camera.node_media_secret) return '';
  return signNodeMediaToken(camera.node_media_secret, {
    camera_id: camera.id,
    stream_name: camera.stream_name,
    user_id: userId,
    scope: 'archive'
  });
}

function nodeDeviceArchiveFileUrlWithBase(baseUrl: string | null, camera: CameraWithNode, userId: string, sessionId: string, filename: string) {
  const base = normalizeNodeBaseUrl(baseUrl);
  if (!base || !camera.node_media_secret) return null;
  const token = signNodeMediaToken(camera.node_media_secret, {
    camera_id: camera.id,
    stream_name: camera.stream_name,
    user_id: userId,
    scope: 'archive'
  });
  const qs = new URLSearchParams({ token });
  return `${base}/device-archive/${encodeURIComponent(camera.stream_name)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}?${qs.toString()}`;
}

function sameOriginDeviceArchiveManifestUrl(camera: CameraWithNode, userId: string, start: string, end: string, requestedSource: string) {
  const token = createDeviceArchiveProxyToken(camera, userId);
  const qs = new URLSearchParams({ start, end, source: requestedSource });
  if (token) qs.set('token', token);
  return `/api/player/${encodeURIComponent(camera.id)}/archive/proxy.m3u8?${qs.toString()}`;
}

function sameOriginDeviceArchiveSegmentUrl(cameraId: string, sessionId: string, filename: string, token: string) {
  const qs = new URLSearchParams();
  if (token) qs.set('token', token);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return `/api/player/${encodeURIComponent(cameraId)}/archive/device-segment/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}${suffix}`;
}

function rewriteDeviceArchivePlaylistForProxy(body: string, cameraId: string, token: string) {
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      out.push(rawLine);
      continue;
    }

    let pathname = line;
    try {
      pathname = new URL(line, 'http://node.local').pathname;
    } catch {
      pathname = line.split('?')[0];
    }

    const parts = pathname.split('/').filter(Boolean);
    const archiveIndex = parts.findIndex((part) => part === 'device-archive');
    if (archiveIndex >= 0 && parts.length >= archiveIndex + 4) {
      const sessionId = parts[archiveIndex + 2];
      const filename = parts[archiveIndex + 3];
      out.push(sameOriginDeviceArchiveSegmentUrl(cameraId, sessionId, filename, token));
    } else {
      out.push(rawLine);
    }
  }
  return `${out.join('\n')}\n`;
}

async function fetchFirstOk(urls: string[], timeoutMs: number): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (const url of urls) {
    try {
      const response = await dvrJson(url, timeoutMs);
      if (response.ok) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Node fetch failed'));
}

function nodeDeviceArchiveManifestUrls(camera: CameraWithNode, userId: string, start: string, end: string) {
  return uniqueNodeBases(camera.node_internal_url, camera.node_public_base_url)
    .map((base) => nodeMediaUrlWithBase(base, camera, userId, 'archive', 'device-archive.m3u8', { start, end }))
    .filter((url): url is string => Boolean(url));
}

function nodeDeviceArchiveSegmentUrls(camera: CameraWithNode, userId: string, sessionId: string, filename: string) {
  return uniqueNodeBases(camera.node_internal_url, camera.node_public_base_url)
    .map((base) => nodeDeviceArchiveFileUrlWithBase(base, camera, userId, sessionId, filename))
    .filter((url): url is string => Boolean(url));
}

type DeviceArchivePrepareResult = {
  session_id?: string;
  status?: string;
  ready?: boolean;
  start?: string;
  end?: string;
  playlist_url?: string;
  error?: string;
  error_status_code?: number;
  last_error?: string;
  attempted_urls?: string[];
  http_status?: number;
};

async function prepareDeviceArchiveOnNode(camera: CameraWithNode, userId: string, start: string, end: string): Promise<DeviceArchivePrepareResult | null> {
  const rawWaitMs = Number(process.env.DEVICE_ARCHIVE_PREPARE_WAIT_MS || 25_000);
  const waitMsNumber = Number.isFinite(rawWaitMs) ? Math.max(1_000, Math.min(60_000, rawWaitMs)) : 25_000;
  const waitMs = String(waitMsNumber);
  if (!camera.node_media_secret || camera.node_enabled === false) {
    return { ready: false, status: 'error', error: 'Node media secret is missing or node is disabled', error_status_code: 503 };
  }

  const urls = uniqueNodeBases(camera.node_internal_url, camera.node_public_base_url)
    .map((base) => nodeMediaUrlWithBase(base, camera, userId, 'archive', 'device-archive/session', { start, end, wait_ms: waitMs }))
    .filter((url): url is string => Boolean(url));

  if (!urls.length) {
    return { ready: false, status: 'error', error: 'Node URL is not configured for device archive prepare', error_status_code: 503 };
  }

  let lastPayload: DeviceArchivePrepareResult | null = null;
  let lastError = '';
  const attemptedUrls: string[] = [];

  for (const prepareUrl of urls) {
    attemptedUrls.push(prepareUrl.replace(/([?&]token=)[^&]+/g, '$1***'));
    try {
      const response = await dvrJson(prepareUrl, waitMsNumber + 10_000);
      const text = await response.text();
      let payload: DeviceArchivePrepareResult = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
      payload.http_status = response.status;
      payload.attempted_urls = attemptedUrls;
      if (response.ok || response.status === 202) return payload;
      lastPayload = payload;
      lastError = payload.error || `Device archive prepare HTTP ${response.status}`;
      if (response.status >= 500) continue;
      return { ...payload, ready: false, status: 'error', error: lastError, error_status_code: response.status, attempted_urls: attemptedUrls };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...(lastPayload || {}),
    ready: false,
    status: 'error',
    error: lastError || 'Device archive prepare failed before reaching node',
    error_status_code: Number(lastPayload?.error_status_code || lastPayload?.http_status || 503),
    attempted_urls: attemptedUrls
  };
}

async function nodeArchiveHasSegments(camera: CameraWithNode, userId: string, start: string, end: string): Promise<boolean> {
  const nodeUrl = nodeMediaUrl(camera, userId, 'archive', 'archive/ranges', { start, end });
  if (!nodeUrl) return false;
  try {
    const response = await dvrJson(nodeUrl);
    if (!response.ok) return false;
    const data = await response.json() as { items?: Array<{ start: string; end: string; segments?: number }> };
    return (data.items || []).some((item) => Number(item.segments || 0) > 0 || (item.start && item.end));
  } catch {
    return false;
  }
}

// Public HLS proxy endpoints. They must not depend on the SPA Bearer token, because
// HLS clients load .m3u8 and .ts files as plain HTTP resources. Authentication here is
// done by the signed archive token in the query string.
async function handleDeviceArchiveProxyManifest(req: ExpressRequest, res: ExpressResponse) {
  const params = archiveSchema.parse(req.query);
  const camera = await getCameraWithNode(String(req.params.cameraId || ''));
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const access = verifyDeviceArchiveProxyToken(camera, req.query.token);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const urls = nodeDeviceArchiveManifestUrls(camera, access.userId, params.start, params.end);
  if (!urls.length) return res.status(503).json({ error: 'Node URL is not configured for device archive proxy' });

  const response = await fetchFirstOk(urls, Number(process.env.DEVICE_ARCHIVE_PROXY_TIMEOUT_MS || 30_000));
  const body = await response.text();
  if (!response.ok) {
    return res.status(response.status).json({
      error: body || `Device archive manifest HTTP ${response.status}`
    });
  }

  res.setHeader('cache-control', 'no-store');
  res.type('application/vnd.apple.mpegurl');
  return res.send(rewriteDeviceArchivePlaylistForProxy(body, camera.id, String(req.query.token || '')));
}

async function handleDeviceArchiveProxySegment(req: ExpressRequest, res: ExpressResponse) {
  const camera = await getCameraWithNode(String(req.params.cameraId || ''));
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const access = verifyDeviceArchiveProxyToken(camera, req.query.token);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const sessionId = String(req.params.sessionId || '');
  const filename = String(req.params.filename || '');
  if (!/^[a-f0-9]{24}$/.test(sessionId) || !/^seg_\d+\.ts$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid device archive segment path' });
  }

  const urls = nodeDeviceArchiveSegmentUrls(camera, access.userId, sessionId, filename);
  if (!urls.length) return res.status(503).json({ error: 'Node URL is not configured for device archive segment proxy' });

  const response = await fetchFirstOk(urls, Number(process.env.DEVICE_ARCHIVE_PROXY_TIMEOUT_MS || 30_000));
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return res.status(response.status).json({ error: text || `Device archive segment HTTP ${response.status}` });
  }

  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');
  if (contentType) res.setHeader('content-type', contentType);
  else res.type('video/mp2t');
  if (contentLength) res.setHeader('content-length', contentLength);
  res.setHeader('cache-control', 'no-store');
  const buffer = Buffer.from(await response.arrayBuffer());
  return res.send(buffer);
}

playerPublicArchiveRouter.get('/:cameraId/archive/proxy.m3u8', asyncHandler(handleDeviceArchiveProxyManifest));
playerPublicArchiveRouter.get('/:cameraId/archive/device-segment/:sessionId/:filename', asyncHandler(handleDeviceArchiveProxySegment));

// Keep the same routes on playerRouter as a compatibility fallback, but the public router
// is mounted in index.ts before the normal authenticated player router.
playerRouter.get('/:cameraId/archive/proxy.m3u8', asyncHandler(handleDeviceArchiveProxyManifest));
playerRouter.get('/:cameraId/archive/device-segment/:sessionId/:filename', asyncHandler(handleDeviceArchiveProxySegment));


playerRouter.use(requireAuth);

type ArchiveRangeItem = { start: string; end: string; segments?: number; source?: string; track_id?: string | null };

function mergeArchiveRanges(items: ArchiveRangeItem[], maxGapMs = 15_000): ArchiveRangeItem[] {
  const sorted = items
    .map((item) => ({
      ...item,
      startMs: new Date(item.start).getTime(),
      endMs: new Date(item.end).getTime()
    }))
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Array<ArchiveRangeItem & { startMs: number; endMs: number }> = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (!last || item.startMs > last.endMs + maxGapMs) {
      merged.push({ ...item });
      continue;
    }

    last.endMs = Math.max(last.endMs, item.endMs);
    last.end = new Date(last.endMs).toISOString();
    last.segments = Number(last.segments || 0) + Number(item.segments || 0) || undefined;
    last.track_id = last.track_id === item.track_id ? last.track_id : null;
    if (last.source !== item.source) {
      last.source = last.source === 'node' || item.source === 'node' ? 'node' : (last.source || item.source);
    }
  }

  return merged.map(({ startMs: _startMs, endMs: _endMs, ...item }) => item);
}

async function cachedDeviceArchiveRanges(cameraId: string, start: string, end: string): Promise<ArchiveRangeItem[]> {
  const result = await query<{
    start: Date;
    end: Date;
    track_id: string | null;
    source: string;
  }>(
    `SELECT start_at AS start, end_at AS end, track_id, source
       FROM public.device_archive_segments
      WHERE camera_id = $1
        AND end_at >= $2
        AND start_at <= $3
      ORDER BY start_at ASC
      LIMIT 10000`,
    [cameraId, start, end]
  );

  return mergeArchiveRanges(result.rows.map((item) => ({
    start: item.start.toISOString(),
    end: item.end.toISOString(),
    track_id: item.track_id,
    source: item.source || 'device-index'
  })));
}

playerRouter.get('/:cameraId/live', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const nodeUrl = nodeMediaUrl(camera, authReq.user!.id, 'live', 'live.m3u8');
  if (nodeUrl) {
    return res.json({
      liveHls: nodeUrl,
      hls_url: nodeUrl,
      playback_url: nodeUrl,
      node_id: camera.dvr_server_id,
      stream_name: camera.stream_name,
      expiresIn: config.playbackTokenTtlSeconds
    });
  }

  const token = await createPlaybackToken(authReq.user!.id, camera.id);
  res.json({
    liveHls: `${config.mediaPublicBaseUrl}/${camera.stream_name}/live.m3u8?token=${token}`,
    webrtcUrl: `/webrtc/live/${camera.stream_name}`,
    expiresIn: config.playbackTokenTtlSeconds
  });
}));

playerRouter.get('/:cameraId/archive', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = archiveSchema.parse(req.query);
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const storage = effectiveArchiveStorage(camera);
  const availableSources = availableArchiveSources(storage);
  const requestedSource = params.source || 'auto';
  let selectedSource = resolveArchiveSource(storage, params.source);
  if (requestedSource === 'auto' && storage === 'both') {
    selectedSource = await nodeArchiveHasSegments(camera, authReq.user!.id, params.start, params.end) ? 'node' : 'device';
  }
  const archivePath = selectedSource === 'device' ? 'device-archive.m3u8' : 'archive.m3u8';
  if (selectedSource === 'device') {
    const proxyUrl = sameOriginDeviceArchiveManifestUrl(camera, authReq.user!.id, params.start, params.end, requestedSource);
    return res.json({
      archiveHls: proxyUrl,
      hls_url: proxyUrl,
      playback_url: proxyUrl,
      node_id: camera.dvr_server_id,
      stream_name: camera.stream_name,
      source: selectedSource,
      requested_source: requestedSource,
      archive_storage: storage,
      available_sources: availableSources,
      expiresIn: config.playbackTokenTtlSeconds
    });
  }

  const nodeUrl = nodeMediaUrl(camera, authReq.user!.id, 'archive', archivePath, { start: params.start, end: params.end });
  if (nodeUrl) {
    return res.json({
      archiveHls: nodeUrl,
      hls_url: nodeUrl,
      playback_url: nodeUrl,
      node_id: camera.dvr_server_id,
      stream_name: camera.stream_name,
      source: selectedSource,
      requested_source: requestedSource,
      archive_storage: storage,
      available_sources: availableSources,
      expiresIn: config.playbackTokenTtlSeconds
    });
  }

  const token = await createPlaybackToken(authReq.user!.id, camera.id);
  const q = new URLSearchParams({ start: params.start, end: params.end, token });
  res.json({ archiveHls: `${config.mediaPublicBaseUrl}/${camera.stream_name}/archive.m3u8?${q.toString()}`, expiresIn: config.playbackTokenTtlSeconds });
}));

playerRouter.get('/:cameraId/archive/prepare', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = archiveSchema.parse(req.query);
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const storage = effectiveArchiveStorage(camera);
  const availableSources = availableArchiveSources(storage);
  const requestedSource = params.source || 'auto';
  let selectedSource = resolveArchiveSource(storage, params.source);
  if (requestedSource === 'auto' && storage === 'both') {
    selectedSource = await nodeArchiveHasSegments(camera, authReq.user!.id, params.start, params.end) ? 'node' : 'device';
  }

  const archivePath = selectedSource === 'device' ? 'device-archive.m3u8' : 'archive.m3u8';
  if (selectedSource === 'device') {
    const prepare = await prepareDeviceArchiveOnNode(camera, authReq.user!.id, params.start, params.end);
    const playlistStart = typeof prepare?.start === 'string' ? prepare.start : params.start;
    const playlistEnd = typeof prepare?.end === 'string' ? prepare.end : params.end;
    const proxyUrl = sameOriginDeviceArchiveManifestUrl(camera, authReq.user!.id, playlistStart, playlistEnd, requestedSource);
    const prepareStatus = prepare?.ready ? 200 : 202;
    return res.status(prepareStatus).json({
      archiveHls: proxyUrl,
      hls_url: proxyUrl,
      playback_url: proxyUrl,
      node_id: camera.dvr_server_id,
      stream_name: camera.stream_name,
      source: selectedSource,
      requested_source: requestedSource,
      archive_storage: storage,
      available_sources: availableSources,
      session: prepare,
      ready: Boolean(prepare?.ready),
      expiresIn: config.playbackTokenTtlSeconds
    });
  }

  const nodeUrl = nodeMediaUrl(camera, authReq.user!.id, 'archive', archivePath, { start: params.start, end: params.end });
  if (nodeUrl) {
    return res.json({
      archiveHls: nodeUrl,
      hls_url: nodeUrl,
      playback_url: nodeUrl,
      node_id: camera.dvr_server_id,
      stream_name: camera.stream_name,
      source: selectedSource,
      requested_source: requestedSource,
      archive_storage: storage,
      available_sources: availableSources,
      ready: true,
      expiresIn: config.playbackTokenTtlSeconds
    });
  }

  return res.status(404).json({ error: 'Archive source is not available for this camera' });
}));

playerRouter.get('/:cameraId/archive/ranges', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = archiveSchema.parse(req.query);
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const storage = effectiveArchiveStorage(camera);
  const availableSources = availableArchiveSources(storage);
  const requestedSource = params.source || 'auto';
  const selectedSource = resolveArchiveSource(storage, params.source);
  const shouldAskNode = availableSources.includes('node') && (selectedSource === 'node' || requestedSource === 'auto');
  const nodeUrl = shouldAskNode ? nodeMediaUrl(camera, authReq.user!.id, 'archive', 'archive/ranges', { start: params.start, end: params.end }) : null;
  let items: ArchiveRangeItem[] = [];

  if (nodeUrl) {
    try {
      const response = await dvrJson(nodeUrl, 60_000);
      if (response.ok) {
        const data = await response.json() as { items?: Array<{ start: string; end: string; segments?: number }> };
        items = (data.items || []).map((item) => ({ ...item, source: 'node' }));
      }
    } catch {
      items = [];
    }
  }

  if (!items.length && (selectedSource === 'device' || (requestedSource === 'auto' && availableSources.includes('device')))) {
    const cachedItems = await cachedDeviceArchiveRanges(camera.id, params.start, params.end);
    if (cachedItems.length) items = cachedItems.map((item) => ({ ...item, source: 'device-index' }));
  }

  if (!items.length && (selectedSource === 'device' || (requestedSource === 'auto' && availableSources.includes('device')))) {
    const deviceRangesUrl = nodeMediaUrl(camera, authReq.user!.id, 'archive', 'device-archive/ranges', { start: params.start, end: params.end });
    if (deviceRangesUrl) {
      try {
        const response = await dvrJson(deviceRangesUrl, 60_000);
        if (response.ok) {
          const data = await response.json() as { items?: Array<{ start: string; end: string; segments?: number; source?: string }> };
          items = (data.items || []).map((item) => ({ ...item, source: item.source || 'device' }));
        }
      } catch {
        items = [];
      }
    }
  }

  const mergedItems = mergeArchiveRanges(items);
  res.setHeader('cache-control', 'no-store');
  res.json({
    items: mergedItems,
    source: mergedItems.some((item) => item.source === 'node') ? 'node' : selectedSource,
    requested_source: requestedSource,
    archive_storage: storage,
    available_sources: availableSources
  });
}));


playerRouter.get('/:cameraId/export', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = archiveSchema.parse(req.query);
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const nodeUrl = nodeMediaUrl(camera, authReq.user!.id, 'export', 'export.mp4', { start: params.start, end: params.end });
  if (nodeUrl) return res.json({ exportMp4: nodeUrl, node_id: camera.dvr_server_id, expiresIn: config.playbackTokenTtlSeconds });

  const token = await createPlaybackToken(authReq.user!.id, camera.id);
  const q = new URLSearchParams({ start: params.start, end: params.end, token });
  res.json({ exportMp4: `${config.mediaPublicBaseUrl}/${camera.stream_name}/export.mp4?${q.toString()}`, expiresIn: config.playbackTokenTtlSeconds });
}));

playerRouter.get('/:cameraId/status', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const allowed = await canAccessCamera(authReq.user!, req.params.cameraId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const camera = await getCameraWithNode(req.params.cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  const base = (camera.node_internal_url || camera.node_public_base_url || config.dvrEngineUrl).replace(/\/+$/, '');
  try {
    const response = await dvrJson(`${base}/cameras/${encodeURIComponent(camera.stream_name)}/status`);
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) {
      return res.json({
        recording: false,
        stream_name: camera.stream_name,
        node_id: camera.dvr_server_id,
        archive_storage: effectiveArchiveStorage(camera),
        available_archive_sources: availableArchiveSources(effectiveArchiveStorage(camera)),
        default_archive_source: defaultArchiveSource(effectiveArchiveStorage(camera)),
        error: payload.error || `DVR status HTTP ${response.status}`
      });
    }
    const storage = effectiveArchiveStorage(camera);
    res.json({
      ...payload,
      archive_storage: storage,
      available_archive_sources: availableArchiveSources(storage),
      default_archive_source: defaultArchiveSource(storage)
    });
  } catch (error) {
    const storage = effectiveArchiveStorage(camera);
    res.json({
      recording: false,
      stream_name: camera.stream_name,
      node_id: camera.dvr_server_id,
      archive_storage: storage,
      available_archive_sources: availableArchiveSources(storage),
      default_archive_source: defaultArchiveSource(storage),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}));
