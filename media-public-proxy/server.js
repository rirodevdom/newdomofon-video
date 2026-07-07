const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const PORT = Number(process.env.MEDIA_PROXY_PORT || 3037);
const HOST = process.env.MEDIA_PROXY_HOST || '127.0.0.1';
const DVR_ENGINE_URL = String(process.env.DVR_ENGINE_URL || 'http://127.0.0.1:3010').replace(/\/+$/, '');
const PRIMARY_TOKEN = String(process.env.RESTREAM_PUBLIC_TOKEN || process.env.VITE_RESTREAM_PUBLIC_TOKEN || '');
const CAMERA_STREAM_MAP = process.env.CAMERA_STREAM_MAP || '/etc/newdomofon-video/camera-stream-map.json';
const STREAM_ALIASES_FILE = process.env.STREAM_ALIASES_FILE || '/etc/newdomofon-video/stream-aliases.json';
const ACCEPTED_TOKENS_FILE = process.env.ACCEPTED_TOKENS_FILE || '/etc/newdomofon-video/restream-accepted-tokens.json';
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

function acceptedTokens() {
  const fromFile = readJson(ACCEPTED_TOKENS_FILE, []);
  const tokens = Array.isArray(fromFile) ? fromFile.map(String).filter(Boolean) : [];
  if (PRIMARY_TOKEN && !tokens.includes(PRIMARY_TOKEN)) tokens.unshift(PRIMARY_TOKEN);
  return tokens;
}

function isAcceptedToken(token) {
  return acceptedTokens().includes(String(token || ''));
}

function tokenForPlaylist(actualToken) {
  return actualToken || PRIMARY_TOKEN || acceptedTokens()[0] || '';
}

function cameraMap() {
  return readJson(CAMERA_STREAM_MAP, {});
}

function aliasMap() {
  return readJson(STREAM_ALIASES_FILE, {});
}

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'Content-Length,Content-Range,Accept-Ranges,X-Newdomofon-Resolved-Stream',
    ...extra
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl; charset=utf-8';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.m4s') return 'video/iso.segment';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, corsHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra
  }));
  res.end(text);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, corsHeaders({
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra
  }));
  res.end(text);
}

function sendNoContent(res) {
  res.writeHead(204, corsHeaders({
    'cache-control': 'no-store',
    'content-length': '0'
  }));
  res.end();
}

function isBadResolvedStream(stream) {
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

  const fromQuery = firstQuery(reqUrl, [
    'camera_id',
    'cameraId',
    'camera_uuid',
    'cameraUuid',
    'id',
    'route_id',
    'routeId'
  ]);

  if (fromQuery) candidates.push(fromQuery);

  const fromReferer = refererCameraId(req);
  if (fromReferer) candidates.push(fromReferer);

  for (const candidate of candidates) {
    if (aliases[candidate]) return String(aliases[candidate]);
    if (cameras[candidate]) return String(cameras[candidate]);
    if (!isBadResolvedStream(candidate)) return candidate;
  }

  return raw;
}

function safeSegmentPath(mediaPath) {
  if (!mediaPath || mediaPath.includes('\0')) return '';
  if (mediaPath.startsWith('/') || mediaPath.includes('..') || mediaPath.includes('\\')) return '';
  return mediaPath.split('/').filter(Boolean).join('/');
}

function appendTokenToPlaylist(body, token) {
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

async function fetchUpstream(pathname) {
  return fetch(`${DVR_ENGINE_URL}${pathname}`, {
    headers: {
      accept: '*/*',
      'user-agent': 'newdomofon-media-public-proxy-v44'
    }
  });
}

async function findSegmentFile(stream, mediaPath) {
  const safeMedia = safeSegmentPath(String(mediaPath || '').split('?')[0]);
  if (!safeMedia) return null;

  for (const root of DVR_ROOTS) {
    const streamRoot = path.resolve(root, stream);
    const candidate = path.resolve(streamRoot, safeMedia);

    if (!candidate.startsWith(streamRoot + path.sep)) continue;

    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return { filePath: candidate, stat };
    } catch {
      // next root
    }
  }

  return null;
}

function sendFile(req, res, filePath, stat, stream, extraHeaders = {}) {
  const total = stat.size;
  const type = contentTypeFor(filePath);
  const range = req.headers.range;
  const baseHeaders = {
    'content-type': type,
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

        res.writeHead(206, corsHeaders({
          ...baseHeaders,
          'content-range': `bytes ${start}-${finalEnd}/${total}`,
          'content-length': chunkSize
        }));

        fs.createReadStream(filePath, { start, end: finalEnd }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, corsHeaders({
    ...baseHeaders,
    'content-length': total
  }));

  fs.createReadStream(filePath).pipe(res);
}

async function proxySegment(req, res, stream, mediaPath) {
  const found = await findSegmentFile(stream, mediaPath);

  if (found) {
    sendFile(req, res, found.filePath, found.stat, stream);
    return;
  }

  const encodedMediaPath = safeSegmentPath(mediaPath)
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const upstream = await fetchUpstream(`/cameras/${encodeURIComponent(stream)}/${encodedMediaPath}`);
  const buffer = Buffer.from(await upstream.arrayBuffer());

  res.writeHead(upstream.status, corsHeaders({
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'cache-control': upstream.headers.get('cache-control') || 'no-store',
    'content-length': buffer.length,
    'x-newdomofon-resolved-stream': stream
  }));

  res.end(buffer);
}

function parsePlaylistSegments(playlistText) {
  return playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('?')[0])
    .filter((line) => /\.(ts|m4s|mp4)$/i.test(line));
}

function shellQuoteForConcat(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

async function runFfmpegConcat(inputFiles, outputFile) {
  const tmpDir = path.dirname(outputFile);
  const listFile = path.join(tmpDir, 'concat.txt');

  const listBody = inputFiles
    .map((file) => `file '${shellQuoteForConcat(file)}'`)
    .join('\n') + '\n';

  await fsp.writeFile(listFile, listBody, 'utf8');

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputFile
  ];

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

function safeFilename(value) {
  return String(value || 'archive')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'archive';
}

async function handleExportMp4(req, res, stream, reqUrl) {
  const start = reqUrl.searchParams.get('start') || '';
  const end = reqUrl.searchParams.get('end') || '';

  if (!start || !end) {
    sendJson(res, 400, {
      error: 'Missing start/end query params',
      required: ['start', 'end']
    }, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  const params = new URLSearchParams();
  params.set('start', start);
  params.set('end', end);

  const upstream = await fetchUpstream(`/cameras/${encodeURIComponent(stream)}/archive.m3u8?${params.toString()}`);
  const body = await upstream.text();

  if (!upstream.ok) {
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    sendText(res, upstream.status, body, contentType, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  const segmentLines = parsePlaylistSegments(body);
  const files = [];

  for (const segment of segmentLines) {
    const decoded = decodeURIComponent(segment);
    const found = await findSegmentFile(stream, decoded);
    if (found) files.push(found.filePath);
  }

  if (!files.length) {
    sendJson(res, 404, {
      error: 'No archive segments in selected range',
      stream_name: stream,
      start,
      end
    }, { 'x-newdomofon-resolved-stream': stream });
    return;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newdomofon-export-'));
  const outFile = path.join(tmpDir, `${safeFilename(stream)}-${Date.now()}.mp4`);

  try {
    await runFfmpegConcat(files, outFile);
    const stat = await fsp.stat(outFile);

    sendFile(req, res, outFile, stat, stream, {
      'content-type': 'video/mp4',
      'content-disposition': `attachment; filename="${safeFilename(stream)}-${safeFilename(start)}-${safeFilename(end)}.mp4"`
    });

    res.on('finish', () => {
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    res.on('close', () => {
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, 500, {
      error: 'Export failed',
      message: String((error && error.message) || error),
      stream_name: stream
    }, { 'x-newdomofon-resolved-stream': stream });
  }
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
        service: 'newdomofon-media-public-proxy',
        version: 'v44',
        dvr: DVR_ENGINE_URL,
        dvr_roots: DVR_ROOTS,
        camera_map: CAMERA_STREAM_MAP,
        aliases: aliasMap(),
        accepted_tokens_count: acceptedTokens().length,
        token_configured: acceptedTokens().length > 0,
        export_mp4: true
      });
      return;
    }

    if (!reqUrl.pathname.startsWith('/api/media/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const actualToken = reqUrl.searchParams.get('token') || '';
    if (!isAcceptedToken(actualToken)) {
      sendJson(res, 401, {
        error: 'Invalid playback token',
        accepted_count: acceptedTokens().length,
        actual_prefix: actualToken.slice(0, 8)
      });
      return;
    }

    const rest = decodeURIComponent(reqUrl.pathname.slice('/api/media/'.length));
    const parts = rest.split('/').filter(Boolean);
    const rawStream = parts.shift() || '';
    const mediaPath = parts.join('/');
    const stream = resolveStreamName(rawStream, req, reqUrl);

    if (isBadResolvedStream(stream)) {
      sendJson(res, 400, {
        error: 'Invalid stream_name',
        stream_name: rawStream,
        resolved_stream_name: stream || '',
        referer_camera_id: refererCameraId(req),
        hint: 'Pass camera_id query param or open from /cameras/<camera_uuid>'
      });
      return;
    }

    if (!mediaPath) {
      sendJson(res, 400, { error: 'Missing media path' }, { 'x-newdomofon-resolved-stream': stream });
      return;
    }

    if (mediaPath === 'preview.mp4') {
      sendNoContent(res);
      return;
    }

    if (mediaPath === 'export.mp4') {
      await handleExportMp4(req, res, stream, reqUrl);
      return;
    }

    if (mediaPath === 'live.m3u8' || mediaPath === 'index.m3u8' || mediaPath === 'video.m3u8') {
      const upstream = await fetchUpstream(`/cameras/${encodeURIComponent(stream)}/live.m3u8`);
      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl; charset=utf-8';

      sendText(
        res,
        upstream.status,
        upstream.ok ? appendTokenToPlaylist(body, tokenForPlaylist(actualToken)) : body,
        contentType,
        { 'x-newdomofon-resolved-stream': stream }
      );
      return;
    }

    if (mediaPath === 'archive.m3u8') {
      const params = new URLSearchParams();
      if (reqUrl.searchParams.get('start')) params.set('start', reqUrl.searchParams.get('start'));
      if (reqUrl.searchParams.get('end')) params.set('end', reqUrl.searchParams.get('end'));

      const suffix = params.toString() ? `?${params.toString()}` : '';
      const upstream = await fetchUpstream(`/cameras/${encodeURIComponent(stream)}/archive.m3u8${suffix}`);
      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl; charset=utf-8';

      sendText(
        res,
        upstream.status,
        upstream.ok ? appendTokenToPlaylist(body, tokenForPlaylist(actualToken)) : body,
        contentType,
        { 'x-newdomofon-resolved-stream': stream }
      );
      return;
    }

    await proxySegment(req, res, stream, mediaPath);
  } catch (error) {
    console.error('[media-proxy] error', error);
    sendJson(res, 502, {
      error: 'media proxy error',
      message: String((error && error.message) || error)
    });
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('[media-proxy] listening', {
    host: HOST,
    port: PORT,
    dvr: DVR_ENGINE_URL,
    dvr_roots: DVR_ROOTS,
    camera_map: CAMERA_STREAM_MAP,
    aliases_file: STREAM_ALIASES_FILE,
    accepted_tokens_file: ACCEPTED_TOKENS_FILE,
    accepted_tokens_count: acceptedTokens().length,
    export_mp4: true,
    version: 'v44'
  });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
