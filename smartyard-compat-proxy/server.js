'use strict';

/* BEGIN newdomofon-accept-permanent-camera-token */
const __ndCrypto = require('crypto');

function __ndSafeEqualB64url(a, b) {
  try {
    const ab = Buffer.from(String(a || ''), 'base64url');
    const bb = Buffer.from(String(b || ''), 'base64url');
    return ab.length === bb.length && __ndCrypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function __ndAcceptPermanentCameraToken(token) {
  try {
    const secret = process.env.DVR_NODE_MEDIA_SECRET || process.env.NODE_MEDIA_SECRET || '';
    if (!secret || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

    const [payloadSegment, signatureSegment] = parts;
    const expected = __ndCrypto
      .createHmac('sha256', secret)
      .update(payloadSegment)
      .digest('base64url');

    if (!__ndSafeEqualB64url(signatureSegment, expected)) return false;

    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return false;
    if (!payload.camera_id || !payload.stream_name) return false;
    if (!['camera', 'live', 'archive'].includes(payload.scope)) return false;
    if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return false;

    return true;
  } catch {
    return false;
  }
}
/* END newdomofon-accept-permanent-camera-token */


const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const VERSION = 'v83.2-smartyard-vue-token-preview-fix';
const PORT = Number(process.env.SMARTYARD_COMPAT_PORT || 3082);
const HOST = process.env.SMARTYARD_COMPAT_HOST || '127.0.0.1';
const DVR_ENGINE_URL = String(process.env.DVR_ENGINE_URL || 'http://127.0.0.1:3010').replace(/\/+$/, '');
const PRIMARY_TOKEN = String(process.env.RESTREAM_PUBLIC_TOKEN || process.env.VITE_RESTREAM_PUBLIC_TOKEN || '');
const CAMERA_STREAM_MAP = process.env.CAMERA_STREAM_MAP || '/etc/newdomofon-video/camera-stream-map.json';
const STREAM_ALIASES_FILE = process.env.STREAM_ALIASES_FILE || '/etc/newdomofon-video/stream-aliases.json';
const ACCEPTED_TOKENS_FILE = process.env.ACCEPTED_TOKENS_FILE || '/etc/newdomofon-video/restream-accepted-tokens.json';
const PREVIEW_FALLBACK_MP4 = process.env.PREVIEW_FALLBACK_MP4 || '/var/lib/newdomofon-video/smartyard-preview-v82.mp4';
const PREVIEW_CACHE_DIR = process.env.PREVIEW_CACHE_DIR || '/var/cache/newdomofon-video/smartyard-preview';
const PREVIEW_CACHE_TTL_MS = Number(process.env.PREVIEW_CACHE_TTL_MS || 15000);
const PREVIEW_SEARCH_HOURS = Number(process.env.PREVIEW_SEARCH_HOURS || 72);
const LIVE_PLAYLIST_MAX_AGE_MS = Number(process.env.LIVE_PLAYLIST_MAX_AGE_MS || 30000);

const SEGMENT_SECONDS = Number(process.env.SMARTYARD_SEGMENT_SECONDS || 4);
const RANGE_GAP_SECONDS = Number(process.env.SMARTYARD_RANGE_GAP_SECONDS || 30);
const DVR_ROOTS = String(process.env.DVR_ROOTS || '/var/lib/newdomofon-video/dvr,/var/dvr')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function cameraMap() {
  const value = readJson(CAMERA_STREAM_MAP, {});
  return value && typeof value === 'object' ? value : {};
}

function aliasMap() {
  const value = readJson(STREAM_ALIASES_FILE, {});
  return value && typeof value === 'object' ? value : {};
}

function acceptedTokens() {
  const fromFile = readJson(ACCEPTED_TOKENS_FILE, []);
  const tokens = Array.isArray(fromFile) ? fromFile.map(String).map((s) => s.trim()).filter(Boolean) : [];
  if (PRIMARY_TOKEN && !tokens.includes(PRIMARY_TOKEN)) tokens.unshift(PRIMARY_TOKEN);
  return tokens;
}

function extractToken(req, reqUrl) {
  const queryToken = reqUrl.searchParams.get('token') || '';
  if (queryToken) return queryToken;

  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();

  if (/^Basic\s+/i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch {
      return '';
    }
  }

  return '';
}

function isAcceptedToken(token) {
  if (__ndAcceptPermanentCameraToken(token)) return true;
  return acceptedTokens().includes(String(token || ''));
}

function tokenForPlaylist(actualToken) {
  return actualToken || PRIMARY_TOKEN || acceptedTokens()[0] || '';
}

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'Content-Length,Content-Range,Accept-Ranges,X-Newdomofon-Resolved-Stream,X-Newdomofon-SmartYard-Compat',
    'x-newdomofon-smartyard-compat': VERSION,
    ...extra
  };
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, cors({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra
  }));
  res.end(text);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, cors({
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra
  }));
  res.end(text);
}

function sendNoContent(res, extra = {}) {
  res.writeHead(204, cors({
    'cache-control': 'no-store',
    'content-length': '0',
    ...extra
  }));
  res.end();
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl; charset=utf-8';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.m4s') return 'video/iso.segment';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function sendFile(req, res, filePath, stat, stream, extraHeaders = {}) {
  const total = stat.size;
  const range = req.headers.range;
  const baseHeaders = {
    'content-type': extraHeaders['content-type'] || contentTypeFor(filePath),
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    'x-newdomofon-resolved-stream': stream,
    ...extraHeaders
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        const finalEnd = Math.min(end, total - 1);
        const chunkSize = finalEnd - start + 1;
        res.writeHead(206, cors({
          ...baseHeaders,
          'content-range': `bytes ${start}-${finalEnd}/${total}`,
          'content-length': chunkSize
        }));
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(filePath, { start, end: finalEnd }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, cors({ ...baseHeaders, 'content-length': total }));
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(filePath).pipe(res);
}

function isBadStream(stream) {
  return !stream || stream === 'undefined' || stream === 'null' || stream.includes('..') || stream.includes('/') || stream.includes('\\');
}

function refererCameraId(req) {
  const ref = String(req.headers.referer || req.headers.referrer || '');
  if (!ref) return '';
  try {
    const url = new URL(ref);
    const match = /\/cameras\/([^/?#]+)/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    const match = /\/cameras\/([^/?#]+)/.exec(ref);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function firstQuery(reqUrl, names) {
  for (const name of names) {
    const value = reqUrl.searchParams.get(name);
    if (value) return String(value).trim();
  }
  return '';
}

function resolveStreamName(rawStream, req, reqUrl) {
  const cameras = cameraMap();
  const aliases = aliasMap();
  const raw = String(rawStream || '').trim();
  const candidates = [];

  if (raw && raw !== 'undefined' && raw !== 'null') candidates.push(raw);

  const fromQuery = firstQuery(reqUrl, ['camera_id', 'cameraId', 'camera_uuid', 'cameraUuid', 'id', 'route_id', 'routeId']);
  if (fromQuery) candidates.push(fromQuery);

  const fromReferer = refererCameraId(req);
  if (fromReferer) candidates.push(fromReferer);

  for (const candidate of candidates) {
    if (aliases[candidate]) return String(aliases[candidate]);
    if (cameras[candidate]) return String(cameras[candidate]);
    if (!isBadStream(candidate)) return candidate;
  }

  return raw;
}

function safeRel(p) {
  const clean = String(p || '').split('?')[0];
  if (!clean || clean.startsWith('/') || clean.includes('..') || clean.includes('\\') || clean.includes('\0')) return '';
  return clean.split('/').filter(Boolean).join('/');
}

function streamRoots(stream) {
  return DVR_ROOTS.map((root) => path.resolve(root, stream));
}

function filenameLocalMs(filePath) {
  const base = path.basename(filePath);
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(ts|m4s|mp4)$/i.exec(base);
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
}

async function scanSegments(stream, startMs = 0, endMs = Number.MAX_SAFE_INTEGER) {
  const results = [];

  for (const root of streamRoots(stream)) {
    try {
      const stat = await fsp.stat(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !/\.(ts|m4s|mp4)$/i.test(entry.name)) continue;
        if (entry.name === path.basename(PREVIEW_FALLBACK_MP4)) continue;

        const ms = filenameLocalMs(full);
        if (!Number.isFinite(ms)) continue;
        if (ms < startMs || ms > endMs) continue;

        const relative = path.relative(root, full).split(path.sep).join('/');
        results.push({ filePath: full, relative, ms });
      }
    }
  }

  results.sort((a, b) => a.ms - b.ms || a.relative.localeCompare(b.relative));
  return results;
}

async function findSegmentFile(stream, relPath) {
  const safe = safeRel(relPath);
  if (!safe) return null;

  for (const root of streamRoots(stream)) {
    const rootResolved = path.resolve(root);
    const candidate = path.resolve(rootResolved, safe);
    if (!candidate.startsWith(rootResolved + path.sep)) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return { filePath: candidate, stat };
    } catch {
      // next root
    }
  }

  return null;
}

function addTokenToUri(uri, token) {
  if (!token) return uri;
  if (/([?&])token=/i.test(uri)) return uri;
  const hashIndex = uri.indexOf('#');
  const beforeHash = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : '';
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}token=${encodeURIComponent(token)}${hash}`;
}

function stripQueryHash(value) {
  return String(value || '').split('#')[0].split('?')[0];
}

function streamRelativeFromUri(uri, stream) {
  const original = String(uri || '').trim();
  if (!original || original.startsWith('#')) return original;

  let pathname = stripQueryHash(original);
  try {
    const parsed = new URL(original, 'http://newdomofon.local');
    pathname = decodeURIComponent(parsed.pathname || pathname);
  } catch {
    try { pathname = decodeURIComponent(pathname); } catch { /* keep original */ }
  }

  pathname = pathname.replace(/\\/g, '/');

  const directPrefixes = [
    `/api/media/${stream}/`,
    `/api/dvr-archive/${stream}/`,
    `/dvr-archive/${stream}/`,
    `/files/${stream}/`,
    `/cameras/${stream}/files/`,
    `/${stream}/`
  ];

  for (const prefix of directPrefixes) {
    if (pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length);
      break;
    }
  }

  const needle = `/${stream}/`;
  const idx = pathname.indexOf(needle);
  if (idx >= 0) pathname = pathname.slice(idx + needle.length);

  pathname = pathname.replace(/^\/+/, '');

  if (!pathname || !/\.(ts|m4s|mp4)$/i.test(pathname)) return original;
  const safe = safeRel(pathname);
  return safe || original;
}

function normalizePlaylistUri(uri, stream, token) {
  const relative = streamRelativeFromUri(uri, stream);
  return addTokenToUri(relative, token);
}

function normalizePlaylist(body, token, stream) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-(MAP|KEY):/i.test(trimmed) && /URI="[^"]+"/i.test(line)) {
          return line.replace(/URI="([^"]+)"/i, (_m, uri) => `URI="${normalizePlaylistUri(uri, stream, token)}"`);
        }
        return line;
      }

      return normalizePlaylistUri(trimmed, stream, token);
    })
    .join('\n') + '\n';
}

function appendTokenToPlaylist(body, token, stream = '') {
  if (stream) return normalizePlaylist(body, token, stream);
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return addTokenToUri(trimmed, token);
    })
    .join('\n') + '\n';
}

async function fetchUpstream(pathname, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${DVR_ENGINE_URL}${pathname}`, {
      signal: controller.signal,
      headers: {
        accept: '*/*',
        'user-agent': `newdomofon-smartyard-compat-${VERSION}`
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function findLivePlaylistFile(stream) {
  for (const root of streamRoots(stream)) {
    const candidate = path.join(root, 'live.m3u8');
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile() && stat.size > 0) return { filePath: candidate, stat };
    } catch {
      // try next root
    }
  }
  return null;
}

async function segmentsNear(stream, targetMs = 0) {
  const now = Date.now();
  let startMs;
  let endMs;

  if (targetMs && Number.isFinite(targetMs)) {
    startMs = targetMs - 10 * 60_000;
    endMs = targetMs + 10 * 60_000;
  } else {
    startMs = now - PREVIEW_SEARCH_HOURS * 3600_000;
    endMs = now + 3600_000;
  }

  let segments = await scanSegments(stream, startMs, endMs);
  if (!segments.length && targetMs && Number.isFinite(targetMs)) {
    segments = await scanSegments(stream, targetMs - 3600_000, targetMs + 3600_000);
  }
  if (!segments.length && !targetMs) {
    segments = await scanSegments(stream, 0, now + 3600_000);
  }

  return segments;
}

async function latestOrNearestSegment(stream, targetSec = 0) {
  const targetMs = targetSec > 0 ? targetSec * 1000 : 0;
  const segments = await segmentsNear(stream, targetMs);
  if (!segments.length) return null;

  if (targetMs) {
    return segments
      .slice()
      .sort((a, b) => Math.abs(a.ms - targetMs) - Math.abs(b.ms - targetMs))[0];
  }

  return segments[segments.length - 1];
}

function previewCacheFile(stream, targetSec = 0) {
  const suffix = targetSec > 0 ? `-${targetSec}` : '-live';
  return path.join(PREVIEW_CACHE_DIR, `${safeName(stream)}${suffix}.mp4`);
}

async function validCachedPreview(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    if (Date.now() - stat.mtimeMs > PREVIEW_CACHE_TTL_MS) return null;
    return stat;
  } catch {
    return null;
  }
}

async function runFfmpegPreview(inputFile, outputFile) {
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  const tmp = `${outputFile}.tmp-${process.pid}-${Date.now()}.mp4`;

  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputFile,
      '-t', '1',
      '-an',
      '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmp
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg preview timeout'));
    }, Number(process.env.PREVIEW_FFMPEG_TIMEOUT_MS || 8000));

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg preview exited with code ${code}`));
    });
  });

  await fsp.rename(tmp, outputFile);
  return outputFile;
}

async function ensurePreviewMp4(stream, mediaPath = 'preview.mp4') {
  const match = /^(\d+)-preview\.mp4$/i.exec(mediaPath || '');
  const targetSec = match ? Number(match[1]) : 0;
  const cache = previewCacheFile(stream, targetSec);

  const cached = await validCachedPreview(cache);
  if (cached) return { filePath: cache, stat: cached, generated: false };

  const segment = await latestOrNearestSegment(stream, targetSec);
  if (!segment) return null;

  await runFfmpegPreview(segment.filePath, cache);
  const stat = await fsp.stat(cache);
  return { filePath: cache, stat, generated: true, source: segment.relative };
}

function parseArchiveWindow(mediaPath, reqUrl) {
  const start = reqUrl.searchParams.get('start');
  const end = reqUrl.searchParams.get('end');

  if (start && end) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      return { startMs, endMs, source: 'query-start-end' };
    }
  }

  let match = /^(archive|index|video|mono)-(\d+)-(now|\d+)\.(m3u8|mp4)$/i.exec(mediaPath);
  if (match) {
    const from = Number(match[2]);
    const duration = match[3] === 'now' ? Math.floor(Date.now() / 1000) - from : Number(match[3]);
    if (Number.isFinite(from) && Number.isFinite(duration) && duration > 0) {
      return { startMs: from * 1000, endMs: (from + duration) * 1000, source: `${match[1]}-${match[4]}` };
    }
  }

  match = /^timeshift_abs-(\d+)\.m3u8$/i.exec(mediaPath);
  if (match) return { startMs: Number(match[1]) * 1000, endMs: Date.now(), source: 'timeshift_abs' };

  match = /^timeshift_rel-(\d+)\.m3u8$/i.exec(mediaPath);
  if (match) return { startMs: Date.now() - Number(match[1]) * 1000, endMs: Date.now(), source: 'timeshift_rel' };

  return null;
}

function segmentDuration(current, next) {
  if (!next) return Math.max(1, SEGMENT_SECONDS);
  return Math.max(1, Math.min(30, (next.ms - current.ms) / 1000));
}

function archivePlaylist(segments, token) {
  const target = Math.max(4, ...segments.slice(0, -1).map((s, i) => Math.ceil(segmentDuration(s, segments[i + 1]))));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const duration = segmentDuration(segment, segments[i + 1]);
    const uri = token ? `${segment.relative}?token=${encodeURIComponent(token)}` : segment.relative;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.ms).toISOString()}`);
    lines.push(`#EXTINF:${duration.toFixed(3)},`);
    lines.push(uri);
  }

  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function buildRanges(segments) {
  const ranges = [];
  if (!segments.length) return ranges;

  let start = Math.floor(segments[0].ms / 1000);
  let lastEnd = start + SEGMENT_SECONDS;

  for (let i = 1; i < segments.length; i += 1) {
    const ts = Math.floor(segments[i].ms / 1000);
    const nextEnd = ts + SEGMENT_SECONDS;

    if (ts <= lastEnd + RANGE_GAP_SECONDS) {
      lastEnd = Math.max(lastEnd, nextEnd);
      continue;
    }

    if (lastEnd > start) ranges.push({ from: start, duration: lastEnd - start });
    start = ts;
    lastEnd = nextEnd;
  }

  if (lastEnd > start) ranges.push({ from: start, duration: lastEnd - start });
  return ranges;
}

async function handleRecordingStatus(res, stream, reqUrl) {
  const fromSec = Number(reqUrl.searchParams.get('from') || 0);
  const startMs = Number.isFinite(fromSec) && fromSec > 0 ? fromSec * 1000 : 0;
  const segments = await scanSegments(stream, startMs, Number.MAX_SAFE_INTEGER);
  const ranges = buildRanges(segments);

  sendJson(res, 200, [
    {
      stream,
      ranges
    }
  ], {
    'x-newdomofon-resolved-stream': stream,
    'x-newdomofon-ranges-count': String(ranges.length),
    'x-newdomofon-segments-count': String(segments.length)
  });
}

async function handleMediaInfo(res, stream) {
  sendJson(res, 200, {
    stream,
    name: stream,
    tracks: [
      { content: 'video', codec: 'h264' },
      { content: 'audio', codec: 'aac', optional: true }
    ]
  }, { 'x-newdomofon-resolved-stream': stream });
}

async function handleLive(res, stream, token) {
  const tokenToUse = tokenForPlaylist(token);
  const direct = await findLivePlaylistFile(stream);

  if (direct) {
    const ageMs = Date.now() - direct.stat.mtimeMs;
    const body = await fsp.readFile(direct.filePath, 'utf8');
    sendText(
      res,
      200,
      normalizePlaylist(body, tokenToUse, stream),
      'application/vnd.apple.mpegurl; charset=utf-8',
      {
        'x-newdomofon-resolved-stream': stream,
        'x-newdomofon-live-source': 'filesystem',
        'x-newdomofon-live-age-ms': String(Math.max(0, Math.floor(ageMs))),
        'x-newdomofon-live-stale': ageMs > LIVE_PLAYLIST_MAX_AGE_MS ? '1' : '0'
      }
    );
    return;
  }

  const upstream = await fetchUpstream(`/cameras/${encodeURIComponent(stream)}/live.m3u8`, 5000);
  const body = await upstream.text();
  const contentType = upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl; charset=utf-8';

  sendText(
    res,
    upstream.status,
    upstream.ok ? normalizePlaylist(body, tokenToUse, stream) : body,
    contentType,
    { 'x-newdomofon-resolved-stream': stream, 'x-newdomofon-live-source': 'dvr-engine' }
  );
}

async function handleArchivePlaylist(res, stream, mediaPath, reqUrl, token) {
  let win = parseArchiveWindow(mediaPath, reqUrl);
  if (!win) {
    const now = Date.now();
    win = { startMs: now - 3600_000, endMs: now, source: 'default-last-hour' };
  }

  const segments = await scanSegments(stream, win.startMs, win.endMs);
  if (!segments.length) {
    sendJson(res, 404, {
      error: 'No archive segments in selected range',
      stream_name: stream,
      start: new Date(win.startMs).toISOString(),
      end: new Date(win.endMs).toISOString(),
      source: win.source
    }, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  sendText(res, 200, archivePlaylist(segments, tokenForPlaylist(token)), 'application/vnd.apple.mpegurl; charset=utf-8', {
    'x-newdomofon-resolved-stream': stream,
    'x-newdomofon-archive-window-source': win.source
  });
}

function quoteForConcat(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

async function runFfmpegConcat(files, outFile) {
  const listFile = path.join(path.dirname(outFile), 'concat.txt');
  await fsp.writeFile(listFile, files.map((file) => `file '${quoteForConcat(file)}'`).join('\n') + '\n', 'utf8');

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      outFile
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

function safeName(value) {
  return String(value || 'archive')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'archive';
}

async function handleArchiveMp4(req, res, stream, mediaPath, reqUrl) {
  const win = parseArchiveWindow(mediaPath, reqUrl);
  if (!win) {
    sendJson(res, 400, {
      error: 'Missing archive window',
      supported: ['export.mp4?start=<iso>&end=<iso>', 'archive-<unix>-<duration>.mp4']
    }, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  const segments = await scanSegments(stream, win.startMs, win.endMs);
  if (!segments.length) {
    sendJson(res, 404, {
      error: 'No archive segments in selected range',
      stream_name: stream,
      start: new Date(win.startMs).toISOString(),
      end: new Date(win.endMs).toISOString(),
      source: win.source
    }, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newdomofon-smartyard-export-'));
  const outFile = path.join(tmpDir, `${safeName(stream)}-${Date.now()}.mp4`);

  try {
    await runFfmpegConcat(segments.map((s) => s.filePath), outFile);
    const stat = await fsp.stat(outFile);
    sendFile(req, res, outFile, stat, stream, {
      'content-type': 'video/mp4',
      'content-disposition': `attachment; filename="${safeName(stream)}-${Math.floor(win.startMs / 1000)}-${Math.floor((win.endMs - win.startMs) / 1000)}.mp4"`
    });

    const cleanup = () => fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    res.on('finish', cleanup);
    res.on('close', cleanup);
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, 500, {
      error: 'Export failed',
      message: String((error && error.message) || error),
      stream_name: stream
    }, { 'x-newdomofon-resolved-stream': stream });
  }
}

async function handlePreview(req, res, stream, mediaPath = 'preview.mp4') {
  try {
    const generated = await ensurePreviewMp4(stream, mediaPath);
    if (generated && generated.stat.isFile() && generated.stat.size > 0) {
      sendFile(req, res, generated.filePath, generated.stat, stream, {
        'content-type': 'video/mp4',
        'content-disposition': 'inline; filename="preview.mp4"',
        'x-content-type-options': 'nosniff',
        'x-newdomofon-preview-source': generated.generated ? 'generated' : 'cache',
        ...(generated.source ? { 'x-newdomofon-preview-segment': generated.source } : {})
      });
      return;
    }
  } catch (error) {
    console.warn('[smartyard-compat] preview generation failed', {
      stream,
      mediaPath,
      error: String((error && error.message) || error)
    });
  }

  try {
    const stat = await fsp.stat(PREVIEW_FALLBACK_MP4);
    if (stat.isFile() && stat.size > 0) {
      sendFile(req, res, PREVIEW_FALLBACK_MP4, stat, stream, {
        'content-type': 'video/mp4',
        'content-disposition': 'inline; filename="preview.mp4"',
        'x-content-type-options': 'nosniff',
        'x-newdomofon-preview-source': 'fallback'
      });
      return;
    }
  } catch {
    // fallback below
  }

  sendNoContent(res, { 'x-newdomofon-resolved-stream': stream, 'x-newdomofon-preview-source': 'empty' });
}

function parseRequestPath(reqUrl) {
  const pathname = decodeURIComponent(reqUrl.pathname || '/');
  let rest = '';

  if (pathname.startsWith('/api/media/')) rest = pathname.slice('/api/media/'.length);
  else if (pathname.startsWith('/dvr-archive/')) rest = pathname.slice('/dvr-archive/'.length);
  else if (pathname.startsWith('/api/dvr-archive/')) rest = pathname.slice('/api/dvr-archive/'.length);
  else if (pathname.startsWith('/')) rest = pathname.slice(1);
  else rest = pathname;

  const parts = rest.split('/').filter(Boolean);
  const rawStream = parts.shift() || '';
  const mediaPath = parts.join('/');
  return { rawStream, mediaPath };
}

async function handle(req, res) {
  try {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      sendNoContent(res);
      return;
    }

    if (reqUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'newdomofon-smartyard-compat',
        version: VERSION,
        dvr: DVR_ENGINE_URL,
        dvr_roots: DVR_ROOTS,
        camera_map: CAMERA_STREAM_MAP,
        aliases: aliasMap(),
        accepted_tokens_count: acceptedTokens().length,
        token_configured: acceptedTokens().length > 0,
        flussonic_like: true,
        recording_status_array: true,
        preview_fallback: PREVIEW_FALLBACK_MP4,
        preview_cache_dir: PREVIEW_CACHE_DIR,
        preview_cache_ttl_ms: PREVIEW_CACHE_TTL_MS
      });
      return;
    }

    const { rawStream, mediaPath } = parseRequestPath(reqUrl);
    const stream = resolveStreamName(rawStream, req, reqUrl);

    if (isBadStream(stream)) {
      sendJson(res, 400, {
        error: 'Invalid stream_name',
        stream_name: rawStream,
        resolved_stream_name: stream || '',
        referer_camera_id: refererCameraId(req)
      });
      return;
    }

    const actualToken = extractToken(req, reqUrl);
    if (!isAcceptedToken(actualToken)) {
      sendJson(res, 401, {
        error: 'Invalid playback token',
        accepted_count: acceptedTokens().length,
        actual_prefix: actualToken.slice(0, 8)
      }, { 'x-newdomofon-resolved-stream': stream });
      return;
    }

    if (!mediaPath) {
      sendJson(res, 400, { error: 'Missing media path' }, { 'x-newdomofon-resolved-stream': stream });
      return;
    }

    if (mediaPath === 'recording_status.json') {
      await handleRecordingStatus(res, stream, reqUrl);
      return;
    }

    if (mediaPath === 'media_info.json') {
      await handleMediaInfo(res, stream);
      return;
    }

    if (mediaPath === 'preview.mp4' || /^\d+-preview\.mp4$/i.test(mediaPath)) {
      await handlePreview(req, res, stream, mediaPath);
      return;
    }

    if (mediaPath === 'live.m3u8' || mediaPath === 'index.m3u8' || mediaPath === 'video.m3u8') {
      await handleLive(res, stream, actualToken);
      return;
    }

    const isArchivePlaylist =
      mediaPath === 'archive.m3u8' ||
      /^(archive|index|video|mono)-\d+-(now|\d+)\.m3u8$/i.test(mediaPath) ||
      /^timeshift_(abs|rel)-\d+\.m3u8$/i.test(mediaPath);

    if (isArchivePlaylist) {
      await handleArchivePlaylist(res, stream, mediaPath, reqUrl, actualToken);
      return;
    }

    const isMp4Export =
      mediaPath === 'export.mp4' ||
      /^(archive|index|video|mono)-\d+-(now|\d+)\.mp4$/i.test(mediaPath);

    if (isMp4Export) {
      await handleArchiveMp4(req, res, stream, mediaPath, reqUrl);
      return;
    }

    const found = await findSegmentFile(stream, mediaPath);
    if (found) {
      sendFile(req, res, found.filePath, found.stat, stream);
      return;
    }

    sendJson(res, 404, {
      error: 'Media file not found',
      stream_name: stream,
      path: mediaPath
    }, { 'x-newdomofon-resolved-stream': stream });
  } catch (error) {
    console.error('[smartyard-compat] error', error);
    sendJson(res, 502, {
      error: 'smartyard compat proxy error',
      message: String((error && error.message) || error)
    });
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('[smartyard-compat] listening', {
    host: HOST,
    port: PORT,
    dvr: DVR_ENGINE_URL,
    dvr_roots: DVR_ROOTS,
    camera_map: CAMERA_STREAM_MAP,
    aliases_file: STREAM_ALIASES_FILE,
    accepted_tokens_file: ACCEPTED_TOKENS_FILE,
    accepted_tokens_count: acceptedTokens().length,
    version: VERSION
  });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
