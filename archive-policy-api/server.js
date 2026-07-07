'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const VERSION = 'v77-archive-policy-api';
const HOST = process.env.ARCHIVE_POLICY_API_HOST || '127.0.0.1';
const PORT = Number(process.env.ARCHIVE_POLICY_API_PORT || 3062);
const PROJECT_DIR = process.env.PROJECT_DIR || '/opt/newdomofon-video';
const ALLOW_WITHOUT_VERIFIED_JWT = String(process.env.ALLOW_ARCHIVE_POLICY_WITHOUT_JWT || 'true') === 'true';

function log(...args) { console.log('[archive-policy-api]', ...args); }
function warn(...args) { console.warn('[archive-policy-api]', ...args); }

function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[t.slice(0, i).trim()] = v;
    }
  } catch {}
  return out;
}

function mergedEnv() {
  return { ...readEnvFile('/etc/newdomofon-video/app.env'), ...readEnvFile(path.join(PROJECT_DIR, 'backend/.env')), ...process.env };
}

function requirePg() {
  const candidates = ['pg', path.join(PROJECT_DIR, 'backend/node_modules/pg'), path.join(PROJECT_DIR, 'node_modules/pg')];
  let last = null;
  for (const p of candidates) { try { return require(p); } catch (e) { last = e; } }
  throw last || new Error('pg not found');
}

function requireJwt() {
  const candidates = ['jsonwebtoken', path.join(PROJECT_DIR, 'backend/node_modules/jsonwebtoken'), path.join(PROJECT_DIR, 'node_modules/jsonwebtoken')];
  for (const p of candidates) { try { return require(p); } catch {} }
  return null;
}

function dbConfig() {
  const e = mergedEnv();
  if (e.DATABASE_URL) return { connectionString: e.DATABASE_URL };
  return {
    host: e.PGHOST || e.POSTGRES_HOST || e.DB_HOST || '127.0.0.1',
    port: Number(e.PGPORT || e.POSTGRES_PORT || e.DB_PORT || 5432),
    database: e.PGDATABASE || e.POSTGRES_DB || e.DB_NAME || e.DB_DATABASE || 'newdomofon_video',
    user: e.PGUSER || e.POSTGRES_USER || e.DB_USER || 'postgres',
    password: e.PGPASSWORD || e.POSTGRES_PASSWORD || e.DB_PASSWORD || undefined,
  };
}

let pool = null;
function getPool() {
  if (pool) return pool;
  const { Pool } = requirePg();
  pool = new Pool({ ...dbConfig(), max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on('error', (e) => warn('pool error', e.message || e));
  return pool;
}

function jwtSecrets() {
  const e = mergedEnv();
  return [e.JWT_SECRET, e.ADMIN_JWT_SECRET, e.ACCESS_TOKEN_SECRET, e.JWT_ACCESS_SECRET, e.AUTH_JWT_SECRET, e.SECRET_KEY].filter(Boolean);
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function isAllowed(req) {
  const token = bearer(req);
  if (!token) return false;
  const jwt = requireJwt();
  const secrets = jwtSecrets();
  if (jwt && secrets.length) {
    for (const secret of secrets) {
      try { jwt.verify(token, secret); return true; } catch {}
    }
    return false;
  }
  return ALLOW_WITHOUT_VERIFIED_JWT;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PATCH,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  res.end(body);
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  return JSON.parse(text);
}

function boolFrom(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(s);
}

async function listPolicies() {
  const { rows } = await getPool().query(`
    SELECT id, name, stream_name, is_enabled, retention_days, archive_enabled
    FROM public.cameras
    ORDER BY stream_name NULLS LAST, name
  `);
  return rows;
}

async function updateById(id, enabled) {
  const { rows } = await getPool().query(`
    UPDATE public.cameras
    SET archive_enabled = $2, updated_at = now()
    WHERE id::text = $1
    RETURNING id, name, stream_name, is_enabled, retention_days, archive_enabled
  `, [String(id), enabled]);
  return rows[0] || null;
}

async function updateByStream(stream, enabled) {
  const { rows } = await getPool().query(`
    UPDATE public.cameras
    SET archive_enabled = $2, updated_at = now()
    WHERE stream_name = $1
    RETURNING id, name, stream_name, is_enabled, retention_days, archive_enabled
  `, [String(stream), enabled]);
  return rows[0] || null;
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  if (url.pathname === '/health' || url.pathname === '/api/archive-policy/health') {
    return send(res, 200, { ok: true, service: 'newdomofon-archive-policy-api', version: VERSION, jwt_secrets: jwtSecrets().length, allow_without_verified_jwt: ALLOW_WITHOUT_VERIFIED_JWT });
  }
  if (!url.pathname.startsWith('/api/archive-policy')) return send(res, 404, { error: 'Not found' });
  if (!isAllowed(req)) return send(res, 401, { error: 'Unauthorized' });

  if (req.method === 'GET' && url.pathname === '/api/archive-policy') {
    const rows = await listPolicies();
    return send(res, 200, { ok: true, items: rows, map: Object.fromEntries(rows.map((r) => [String(r.id), r])) });
  }

  const byStream = url.pathname.match(/^\/api\/archive-policy\/by-stream\/(.+)$/);
  if ((req.method === 'PATCH' || req.method === 'POST') && byStream) {
    const body = await readBody(req);
    const row = await updateByStream(decodeURIComponent(byStream[1]), boolFrom(body.archive_enabled));
    return row ? send(res, 200, { ok: true, item: row }) : send(res, 404, { error: 'Camera stream not found' });
  }

  const byId = url.pathname.match(/^\/api\/archive-policy\/([^/]+)$/);
  if ((req.method === 'PATCH' || req.method === 'POST') && byId) {
    const body = await readBody(req);
    const row = await updateById(decodeURIComponent(byId[1]), boolFrom(body.archive_enabled));
    return row ? send(res, 200, { ok: true, item: row }) : send(res, 404, { error: 'Camera id not found' });
  }

  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    warn('request failed', e);
    send(res, 500, { error: 'Internal error', message: e.message || String(e) });
  });
}).listen(PORT, HOST, () => {
  log('listening', { host: HOST, port: PORT, version: VERSION, allow_without_verified_jwt: ALLOW_WITHOUT_VERIFIED_JWT, jwt_secrets: jwtSecrets().length });
});
