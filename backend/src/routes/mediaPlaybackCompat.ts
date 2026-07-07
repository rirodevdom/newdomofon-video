import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const mediaPlaybackCompatRouter = Router();

type Attempt = { path: string; status: number; body: string };

type UpstreamTextResult =
  | { ok: true; path: string; status: number; text: string; contentType: string | null; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

type UpstreamBinaryResult =
  | { ok: true; path: string; status: number; data: Buffer; contentType: string | null; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

function dvrBaseUrl() {
  return process.env.DVR_ENGINE_URL || process.env.DVR_URL || 'http://127.0.0.1:3010';
}

function queryValue(value: unknown) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function tokenPreview(token: string) {
  if (!token) return '<empty>';
  if (token.length <= 10) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function validateToken(streamName: string, token: string) {
  if (!token) {
    return { ok: false as const, status: 401, error: 'Missing playback token' };
  }

  const result = await query(
    `SELECT pat.token, pat.expires_at, c.id AS camera_id, c.stream_name
       FROM public.playback_access_tokens pat
       JOIN public.cameras c ON c.id = pat.camera_id
      WHERE pat.token = $1
        AND pat.expires_at > now()
      LIMIT 1`,
    [token]
  );

  if (!result.rowCount) {
    console.warn('[media-token] token not found or expired', { streamName, token: tokenPreview(token) });
    return { ok: false as const, status: 401, error: 'Invalid or expired playback token' };
  }

  const row = result.rows[0];

  if (row.stream_name !== streamName) {
    console.warn('[media-token] stream mismatch', {
      requestedStream: streamName,
      tokenStream: row.stream_name,
      cameraId: row.camera_id,
      token: tokenPreview(token)
    });

    return {
      ok: false as const,
      status: 403,
      error: `Playback token belongs to stream ${row.stream_name}, not ${streamName}`
    };
  }

  return { ok: true as const, row };
}

function encodePath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function protectedSegmentUrl(streamName: string, segmentPath: string, token: string) {
  return `/api/media/${encodeURIComponent(streamName)}/files/${encodePath(segmentPath)}?token=${encodeURIComponent(token)}`;
}

function normalizeSegmentLine(line: string, streamName: string, token: string) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) return line;
  if (/^https?:\/\//i.test(trimmed)) return line;

  let segment = trimmed;

  const absoluteApiPrefix = `/api/media/${streamName}/files/`;
  if (segment.startsWith(absoluteApiPrefix)) {
    segment = segment.slice(absoluteApiPrefix.length).split('?')[0];
  }

  const filesPrefix = `/files/${streamName}/`;
  if (segment.startsWith(filesPrefix)) {
    segment = segment.slice(filesPrefix.length);
  }

  const dvrMarker = `/dvr/${streamName}/`;
  if (segment.includes(dvrMarker)) {
    segment = segment.split(dvrMarker).pop() || segment;
  }

  segment = segment.replace(/^\/+/, '');

  return protectedSegmentUrl(streamName, segment, token);
}

function rewritePlaylist(playlist: string, streamName: string, token: string) {
  return playlist
    .split(/\r?\n/)
    .map((line) => normalizeSegmentLine(line, streamName, token))
    .join('\n');
}

function liveCandidatePaths(streamName: string) {
  const s = encodeURIComponent(streamName);

  return [
    `/cameras/${s}/live.m3u8`,
    `/api/dvr/${s}/live.m3u8`,
    `/dvr/${s}/live.m3u8`,
    `/live/${s}/index.m3u8`,
    `/${s}/live.m3u8`
  ];
}

function archiveCandidatePaths(streamName: string, start: string, end: string) {
  const s = encodeURIComponent(streamName);
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const qs = params.toString() ? `?${params.toString()}` : '';

  return [
    `/cameras/${s}/archive.m3u8${qs}`,
    `/api/dvr/${s}/archive.m3u8${qs}`,
    `/dvr/${s}/archive.m3u8${qs}`,
    `/archive/${s}/index.m3u8${qs}`,
    `/${s}/archive.m3u8${qs}`
  ];
}


function exportCandidatePaths(streamName: string, start: string, end: string) {
  const s = encodeURIComponent(streamName);
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const qs = params.toString() ? `?${params.toString()}` : '';

  return [
    `/cameras/${s}/export.mp4${qs}`,
    `/api/dvr/${s}/export.mp4${qs}`,
    `/dvr/${s}/export.mp4${qs}`,
    `/export/${s}.mp4${qs}`
  ];
}

async function fetchExportWithTimezoneFallback(streamName: string, start: string, end: string) {
  const original = await fetchBinaryFromAny(exportCandidatePaths(streamName, start, end));

  if (original.ok) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  if (!attemptsContainNoSegments(original.attempts)) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  const live = await fetchTextFromAny(liveCandidatePaths(streamName));

  if (!live.ok) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: live.attempts
    };
  }

  const offsetMs = inferOffsetMsFromLivePlaylist(live.text);

  if (offsetMs === null || offsetMs === 0) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  const shiftedStart = shiftIso(start, offsetMs);
  const shiftedEnd = shiftIso(end, offsetMs);

  console.log('[media-proxy] retry export with shifted range', {
    streamName,
    start,
    end,
    shiftedStart,
    shiftedEnd,
    offset_minutes: offsetMs / 60000
  });

  const shifted = await fetchBinaryFromAny(exportCandidatePaths(streamName, shiftedStart, shiftedEnd));

  return {
    upstream: shifted,
    used_shift: shifted.ok,
    shifted_start: shiftedStart,
    shifted_end: shiftedEnd,
    offset_minutes: offsetMs / 60000,
    original_attempts: original.attempts,
    shifted_attempts: shifted.attempts
  };
}

function fileCandidatePaths(streamName: string, segmentPath: string) {
  const s = encodeURIComponent(streamName);
  const p = encodePath(segmentPath);

  return [
    `/files/${s}/${p}`,
    `/dvr/${s}/${p}`,
    `/cameras/${s}/files/${p}`,
    `/${s}/${p}`
  ];
}

async function fetchTextFromAny(paths: string[]): Promise<UpstreamTextResult> {
  const attempts: Attempt[] = [];
  const base = dvrBaseUrl().replace(/\/+$/, '');

  for (const path of paths) {
    try {
      const response = await fetch(`${base}${path}`);
      const text = await response.text().catch(() => '');
      const contentType = response.headers.get('content-type');

      if (response.ok) {
        console.log('[media-proxy] upstream OK', { path, status: response.status });
        return { ok: true, path, status: response.status, text, contentType, attempts };
      }

      attempts.push({ path, status: response.status, body: text.slice(0, 500) });
      console.warn('[media-proxy] upstream not OK', { path, status: response.status, body: text.slice(0, 160) });
    } catch (error: any) {
      attempts.push({ path, status: 0, body: error?.message || String(error) });
      console.warn('[media-proxy] upstream fetch failed', { path, error: error?.message || String(error) });
    }
  }

  return { ok: false, attempts };
}

async function fetchBinaryFromAny(paths: string[]): Promise<UpstreamBinaryResult> {
  const attempts: Attempt[] = [];
  const base = dvrBaseUrl().replace(/\/+$/, '');

  for (const path of paths) {
    try {
      const response = await fetch(`${base}${path}`);
      const contentType = response.headers.get('content-type');

      if (response.ok) {
        const data = Buffer.from(await response.arrayBuffer());
        console.log('[media-proxy] upstream file OK', { path, status: response.status, bytes: data.length });
        return { ok: true, path, status: response.status, data, contentType, attempts };
      }

      const text = await response.text().catch(() => '');
      attempts.push({ path, status: response.status, body: text.slice(0, 500) });
      console.warn('[media-proxy] upstream file not OK', { path, status: response.status, body: text.slice(0, 160) });
    } catch (error: any) {
      attempts.push({ path, status: 0, body: error?.message || String(error) });
      console.warn('[media-proxy] upstream file fetch failed', { path, error: error?.message || String(error) });
    }
  }

  return { ok: false, attempts };
}

function parseProgramDateTime(line: string): number | null {
  const raw = line.replace('#EXT-X-PROGRAM-DATE-TIME:', '').trim();
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function parseSegmentWallTimeAsUtc(segmentLine: string): number | null {
  const match = segmentLine.match(/(\d{8})_(\d{6})\.(?:ts|m4s|mp4)(?:\?.*)?$/);
  if (!match) return null;

  const d = match[1];
  const t = match[2];

  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const hour = Number(t.slice(0, 2));
  const minute = Number(t.slice(2, 4));
  const second = Number(t.slice(4, 6));

  if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) return null;

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function inferOffsetMsFromLivePlaylist(playlist: string): number | null {
  const lines = playlist.split(/\r?\n/);
  let pendingProgramDateTime: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingProgramDateTime = parseProgramDateTime(trimmed);
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) continue;

    if (pendingProgramDateTime !== null) {
      const segmentWallMs = parseSegmentWallTimeAsUtc(trimmed);
      if (segmentWallMs !== null) {
        const rawOffset = segmentWallMs - pendingProgramDateTime;
        const roundedToMinute = Math.round(rawOffset / 60000) * 60000;

        console.log('[media-proxy] inferred archive time offset', {
          segment: trimmed,
          offset_minutes: roundedToMinute / 60000,
          raw_offset_ms: rawOffset
        });

        return roundedToMinute;
      }
    }
  }

  return null;
}

function shiftIso(value: string, offsetMs: number) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms + offsetMs).toISOString();
}

function attemptsContainNoSegments(attempts: Attempt[]) {
  return attempts.some((attempt) => /No archive segments in selected range/i.test(attempt.body));
}

async function fetchArchiveWithTimezoneFallback(streamName: string, start: string, end: string) {
  const original = await fetchTextFromAny(archiveCandidatePaths(streamName, start, end));

  if (original.ok) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  if (!attemptsContainNoSegments(original.attempts)) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  const live = await fetchTextFromAny(liveCandidatePaths(streamName));

  if (!live.ok) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: live.attempts
    };
  }

  const offsetMs = inferOffsetMsFromLivePlaylist(live.text);

  if (offsetMs === null || offsetMs === 0) {
    return {
      upstream: original,
      used_shift: false,
      shifted_start: null,
      shifted_end: null,
      offset_minutes: 0,
      original_attempts: original.attempts,
      shifted_attempts: []
    };
  }

  const shiftedStart = shiftIso(start, offsetMs);
  const shiftedEnd = shiftIso(end, offsetMs);

  console.log('[media-proxy] retry archive with shifted range', {
    streamName,
    start,
    end,
    shiftedStart,
    shiftedEnd,
    offset_minutes: offsetMs / 60000
  });

  const shifted = await fetchTextFromAny(archiveCandidatePaths(streamName, shiftedStart, shiftedEnd));

  return {
    upstream: shifted,
    used_shift: shifted.ok,
    shifted_start: shiftedStart,
    shifted_end: shiftedEnd,
    offset_minutes: offsetMs / 60000,
    original_attempts: original.attempts,
    shifted_attempts: shifted.ok ? shifted.attempts : shifted.attempts
  };
}

mediaPlaybackCompatRouter.get('/:streamName/live.m3u8', asyncHandler(async (req, res) => {
  const streamName = req.params.streamName;
  const token = queryValue(req.query.token);
  const valid = await validateToken(streamName, token);

  if (!valid.ok) {
    return res.status(valid.status).json({ error: valid.error });
  }

  const upstream = await fetchTextFromAny(liveCandidatePaths(streamName));

  if (!upstream.ok) {
    return res.status(502).json({
      error: 'DVR live playlist not available',
      stream_name: streamName,
      dvr_base_url: dvrBaseUrl(),
      attempts: upstream.attempts
    });
  }

  res.setHeader('cache-control', 'no-store');
  res.type('application/vnd.apple.mpegurl');
  res.send(rewritePlaylist(upstream.text, streamName, token));
}));

mediaPlaybackCompatRouter.get('/:streamName/archive.m3u8', asyncHandler(async (req, res) => {
  const streamName = req.params.streamName;
  const token = queryValue(req.query.token);
  const valid = await validateToken(streamName, token);

  if (!valid.ok) {
    return res.status(valid.status).json({ error: valid.error });
  }

  const start = queryValue(req.query.start);
  const end = queryValue(req.query.end);

  const result = await fetchArchiveWithTimezoneFallback(streamName, start, end);

  if (!result.upstream.ok) {
    const status = attemptsContainNoSegments(result.original_attempts) ? 404 : 502;

    return res.status(status).json({
      error: attemptsContainNoSegments(result.original_attempts)
        ? 'No archive segments in selected range'
        : 'DVR archive playlist not available',
      stream_name: streamName,
      requested_start: start,
      requested_end: end,
      shifted_start: result.shifted_start,
      shifted_end: result.shifted_end,
      offset_minutes: result.offset_minutes,
      dvr_base_url: dvrBaseUrl(),
      original_attempts: result.original_attempts,
      shifted_attempts: result.shifted_attempts
    });
  }

  if (result.used_shift) {
    res.setHeader('x-archive-time-shift-minutes', String(result.offset_minutes));
    if (result.shifted_start) res.setHeader('x-archive-shifted-start', result.shifted_start);
    if (result.shifted_end) res.setHeader('x-archive-shifted-end', result.shifted_end);
  }

  res.setHeader('cache-control', 'no-store');
  res.type('application/vnd.apple.mpegurl');
  res.send(rewritePlaylist(result.upstream.text, streamName, token));
}));


mediaPlaybackCompatRouter.get('/:streamName/export.mp4', asyncHandler(async (req, res) => {
  const streamName = req.params.streamName;
  const token = queryValue(req.query.token);
  const valid = await validateToken(streamName, token);

  if (!valid.ok) {
    return res.status(valid.status).json({ error: valid.error });
  }

  const start = queryValue(req.query.start);
  const end = queryValue(req.query.end);

  const result = await fetchExportWithTimezoneFallback(streamName, start, end);

  if (!result.upstream.ok) {
    const status = attemptsContainNoSegments(result.original_attempts) ? 404 : 502;

    return res.status(status).json({
      error: attemptsContainNoSegments(result.original_attempts)
        ? 'No archive segments in selected range'
        : 'DVR export not available',
      stream_name: streamName,
      requested_start: start,
      requested_end: end,
      shifted_start: result.shifted_start,
      shifted_end: result.shifted_end,
      offset_minutes: result.offset_minutes,
      dvr_base_url: dvrBaseUrl(),
      original_attempts: result.original_attempts,
      shifted_attempts: result.shifted_attempts
    });
  }

  const fileName = `${streamName}_${start || 'start'}_${end || 'end'}.mp4`.replace(/[^a-zA-Z0-9_.-]/g, '_');

  if (result.used_shift) {
    res.setHeader('x-archive-time-shift-minutes', String(result.offset_minutes));
    if (result.shifted_start) res.setHeader('x-archive-shifted-start', result.shifted_start);
    if (result.shifted_end) res.setHeader('x-archive-shifted-end', result.shifted_end);
  }

  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
  res.type('video/mp4');
  res.send(result.upstream.data);
}));

mediaPlaybackCompatRouter.get('/:streamName/files/*', asyncHandler(async (req, res) => {
  const streamName = req.params.streamName;
  const token = queryValue(req.query.token);
  const valid = await validateToken(streamName, token);

  if (!valid.ok) {
    return res.status(valid.status).json({ error: valid.error });
  }

  const segmentPath = (req.params as Record<string, string>)['0'] || '';

  if (!segmentPath || segmentPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid segment path' });
  }

  const upstream = await fetchBinaryFromAny(fileCandidatePaths(streamName, segmentPath));

  if (!upstream.ok) {
    return res.status(502).json({
      error: 'DVR media segment not available',
      stream_name: streamName,
      segment_path: segmentPath,
      dvr_base_url: dvrBaseUrl(),
      attempts: upstream.attempts
    });
  }

  res.setHeader('cache-control', 'public, max-age=30');

  if (segmentPath.endsWith('.m3u8')) res.type('application/vnd.apple.mpegurl');
  else if (segmentPath.endsWith('.m4s')) res.type('video/iso.segment');
  else if (segmentPath.endsWith('.mp4')) res.type('video/mp4');
  else if (segmentPath.endsWith('.ts')) res.type('video/mp2t');
  else res.type(upstream.contentType || 'application/octet-stream');

  res.send(upstream.data);
}));
