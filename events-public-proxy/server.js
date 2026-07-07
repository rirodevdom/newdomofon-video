'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const VERSION = 'v69-public-events-timeline-hardfix';
const PORT = Number(process.env.EVENTS_PUBLIC_PORT || 3058);
const HOST = process.env.EVENTS_PUBLIC_HOST || '127.0.0.1';
const PROJECT_DIR = process.env.PROJECT_DIR || '/opt/newdomofon-video';

const CAMERA_STREAM_MAP = process.env.CAMERA_STREAM_MAP || '/etc/newdomofon-video/camera-stream-map.json';
const STREAM_ALIASES_FILE = process.env.STREAM_ALIASES_FILE || '/etc/newdomofon-video/stream-aliases.json';
const ACCEPTED_TOKENS_FILE = process.env.ACCEPTED_TOKENS_FILE || '/etc/newdomofon-video/restream-accepted-tokens.json';
const PRIMARY_TOKEN = String(process.env.RESTREAM_PUBLIC_TOKEN || process.env.VITE_RESTREAM_PUBLIC_TOKEN || '');
const MAX_EVENTS = Number(process.env.EVENTS_PUBLIC_LIMIT || 20000);

function log(...args) {
  console.log('[events-public-proxy]', ...args);
}

function warn(...args) {
  console.warn('[events-public-proxy]', ...args);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {}
  return out;
}


const ARCHIVE_START_OVERRIDES_FILE = process.env.ARCHIVE_START_OVERRIDES_FILE || '/etc/newdomofon-video/archive-start-overrides.json';
let __ndArchiveStartCache = null;
let __ndArchiveStartCacheAt = 0;
function ndReadArchiveStartOverrides() {
  const now = Date.now();
  if (__ndArchiveStartCache && now - __ndArchiveStartCacheAt < 30000) return __ndArchiveStartCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(ARCHIVE_START_OVERRIDES_FILE, 'utf8'));
    __ndArchiveStartCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    __ndArchiveStartCache = {};
  }
  __ndArchiveStartCacheAt = now;
  return __ndArchiveStartCache;
}
function ndArchiveStartForTarget(target) {
  const map = ndReadArchiveStartOverrides();
  const keys = [
    target && target.stream_name,
    target && target.camera_id,
    target && target.raw,
  ].map(String).filter(Boolean);
  for (const key of keys) {
    const value = map[key];
    if (!value) continue;
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  return null;
}
function ndClampStartToArchive(target, start) {
  const archiveStart = ndArchiveStartForTarget(target);
  if (archiveStart && start instanceof Date && Number.isFinite(start.getTime()) && start < archiveStart) return archiveStart;
  return start;
}

function acceptedTokens() {
  const fromFile = readJson(ACCEPTED_TOKENS_FILE, []);
  const tokens = Array.isArray(fromFile) ? fromFile.map(String).filter(Boolean) : [];
  if (PRIMARY_TOKEN && !tokens.includes(PRIMARY_TOKEN)) tokens.unshift(PRIMARY_TOKEN);
  return tokens;
}

function extractToken(req, url) {
  const queryToken = url.searchParams.get('token') || '';
  if (queryToken) return queryToken;

  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function tokenAllowed(req, url) {
  const token = extractToken(req, url);
  const tokens = acceptedTokens();
  return Boolean(token && tokens.includes(token));
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'X-Upstream-Access-Control-Allow-Origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'X-Newdomofon-Events-Source,X-Newdomofon-Events-Count',
    ...extraHeaders,
  });
  res.end(body);
}

function qid(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function getColName(col) {
  return String((col && (col.column_name || col.name)) || '');
}

function getColType(col) {
  return String((col && (col.data_type || col.type)) || '').toLowerCase();
}

function cameraMap() {
  return readJson(CAMERA_STREAM_MAP, {});
}

function aliasMap() {
  return readJson(STREAM_ALIASES_FILE, {});
}

function resolveTarget(input, queryStream) {
  const raw = decodeURIComponent(String(input || '')).trim();
  const map = cameraMap();
  const aliases = aliasMap();
  const inverse = Object.fromEntries(Object.entries(map).map(([cameraId, streamName]) => [String(streamName), String(cameraId)]));

  const byCameraId = map[raw] || '';
  const aliased = aliases[raw] || raw;
  const stream = byCameraId || aliased || queryStream || raw;
  const cameraId = map[raw] ? raw : (inverse[stream] || inverse[raw] || '');

  return {
    raw,
    camera_id: cameraId,
    stream_name: stream,
    targets: Array.from(new Set([raw, cameraId, stream, queryStream].map(String).filter(Boolean))),
  };
}

function requirePg() {
  const candidates = [
    'pg',
    path.join(PROJECT_DIR, 'backend/node_modules/pg'),
    '/opt/newdomofon-video/backend/node_modules/pg',
    path.join(PROJECT_DIR, 'node_modules/pg'),
  ];

  let lastError = null;
  for (const item of candidates) {
    try {
      return require(item);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('pg module not found');
}

function dbConfig() {
  const appEnv = readEnvFile('/etc/newdomofon-video/app.env');
  const backendEnv = readEnvFile(path.join(PROJECT_DIR, 'backend/.env'));
  const merged = { ...appEnv, ...backendEnv, ...process.env };

  if (merged.DATABASE_URL) {
    return { connectionString: merged.DATABASE_URL };
  }

  return {
    host: merged.PGHOST || merged.POSTGRES_HOST || merged.DB_HOST || '127.0.0.1',
    port: Number(merged.PGPORT || merged.POSTGRES_PORT || merged.DB_PORT || 5432),
    database: merged.PGDATABASE || merged.POSTGRES_DB || merged.DB_NAME || merged.DB_DATABASE || 'newdomofon_video',
    user: merged.PGUSER || merged.POSTGRES_USER || merged.DB_USER || 'postgres',
    password: merged.PGPASSWORD || merged.POSTGRES_PASSWORD || merged.DB_PASSWORD || undefined,
  };
}

let pool = null;
let PoolCtor = null;
let cachedCandidates = null;
let lastDiscoveryAt = 0;

function getPool() {
  if (pool) return pool;

  if (!PoolCtor) {
    const pg = requirePg();
    PoolCtor = pg.Pool;
  }

  pool = new PoolCtor({
    ...dbConfig(),
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (error) => warn('pool error', error.message || error));
  return pool;
}

function pickColumn(cols, names) {
  const lower = new Map(cols.map((c) => [getColName(c).toLowerCase(), c]));
  for (const name of names) {
    const found = lower.get(name.toLowerCase());
    if (found) return found;
  }
  return null;
}

function timeExpression(col) {
  const name = getColName(col);
  if (!name) throw new Error('timeExpression got empty column name');
  const q = qid(name);
  const type = getColType(col);

  if (/(integer|bigint|numeric|double|real)/.test(type)) {
    return `(CASE WHEN ${q} > 1000000000000 THEN to_timestamp(${q} / 1000.0) ELSE to_timestamp(${q}) END)`;
  }

  if (/(character|text|json)/.test(type)) {
    return `(NULLIF(${q}::text, '')::timestamptz)`;
  }

  return `(${q}::timestamptz)`;
}

function scoreCandidate(table, cols) {
  const tableName = `${table.table_schema}.${table.table_name}`.toLowerCase();
  const colNames = cols.map((c) => getColName(c).toLowerCase());

  const cameraCols = colNames.filter((c) => [
    'camera_id',
    'camera_uuid',
    'cameraid',
    'camera',
    'stream_name',
    'stream',
    'channel',
    'channel_name',
  ].includes(c));

  const timeCol = pickColumn(cols, [
    'occurred_at',
    'event_time',
    'time',
    'ts',
    'timestamp',
    'created_at',
    'started_at',
    'date_time',
    'datetime',
  ]);

  const typeCol = pickColumn(cols, ['event_type', 'type', 'kind', 'topic', 'name', 'code']);
  const stateCol = pickColumn(cols, ['event_state', 'state', 'status', 'value']);

  let score = 0;
  if (tableName.includes('event')) score += 50;
  if (tableName.includes('camera')) score += 8;
  if (cameraCols.length) score += 25;
  if (timeCol) score += 25;
  if (typeCol) score += 6;
  if (stateCol) score += 4;

  // Avoid treating regular cameras/tokens/favorites tables as event sources.
  if (!tableName.includes('event') && !(typeCol && stateCol)) score -= 40;
  if (!cameraCols.length || !timeCol) score -= 100;

  return {
    ...table,
    score,
    camera_cols: cameraCols,
    time_col: timeCol ? getColName(timeCol) : '',
    time_type: timeCol ? getColType(timeCol) : '',
    type_col: typeCol ? getColName(typeCol) : '',
    state_col: stateCol ? getColName(stateCol) : '',
    columns: cols.map((c) => ({ name: getColName(c), type: getColType(c) })),
  };
}

async function discoverCandidates() {
  const now = Date.now();
  if (cachedCandidates && now - lastDiscoveryAt < 60_000) return cachedCandidates;

  const client = await getPool().connect();
  try {
    const { rows } = await client.query(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `);

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!groups.has(key)) {
        groups.set(key, { table_schema: row.table_schema, table_name: row.table_name, cols: [] });
      }
      groups.get(key).cols.push(row);
    }

    cachedCandidates = Array.from(groups.values())
      .map((g) => scoreCandidate({ table_schema: g.table_schema, table_name: g.table_name }, g.cols))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    lastDiscoveryAt = now;
    return cachedCandidates;
  } finally {
    client.release();
  }
}

function valueForColumn(col, target) {
  const c = String(col || '').toLowerCase();

  if (['stream_name', 'stream', 'channel', 'channel_name'].includes(c)) {
    return [target.stream_name, target.raw].filter(Boolean);
  }

  return [target.camera_id, target.raw, target.stream_name].filter(Boolean);
}

function normalizeRow(row, cand) {
  const timeValue = row.__newdomofon_event_ts || row[cand.time_col] || row.occurred_at || row.time || row.created_at || row.ts;
  let occurredAt = '';
  try {
    occurredAt = timeValue instanceof Date ? timeValue.toISOString() : new Date(timeValue).toISOString();
  } catch {
    occurredAt = String(timeValue || '');
  }

  const type = cand.type_col && row[cand.type_col] != null
    ? row[cand.type_col]
    : (row.event_type || row.type || row.kind || row.topic || 'event');

  const eventState = cand.state_col && row[cand.state_col] != null
    ? row[cand.state_col]
    : (row.event_state || row.state || row.status || row.value || '');

  return {
    id: row.id || row.uuid || `${cand.table_schema}.${cand.table_name}:${occurredAt}:${type}`,
    camera_id: row.camera_id || row.camera_uuid || '',
    stream_name: row.stream_name || row.stream || '',
    occurred_at: occurredAt,
    event_type: String(type || 'event'),
    event_state: String(eventState || ''),
    source_table: `${cand.table_schema}.${cand.table_name}`,
    raw: row,
  };
}

async function queryCandidate(client, cand, target, start, end) {
  const schema = qid(cand.table_schema);
  const table = qid(cand.table_name);
  const timeCol = cand.columns.find((c) => c.name === cand.time_col);
  const tsExpr = timeExpression(timeCol);

  const whereParts = [];
  const values = [];

  for (const col of cand.camera_cols) {
    const vals = valueForColumn(col, target);
    if (!vals.length) continue;
    values.push(vals);
    whereParts.push(`${qid(col)}::text = ANY($${values.length}::text[])`);
  }

  if (!whereParts.length) return [];

  values.push(start);
  const startParam = values.length;
  values.push(end);
  const endParam = values.length;
  values.push(MAX_EVENTS);
  const limitParam = values.length;

  const sql = `
    SELECT *, ${tsExpr} AS __newdomofon_event_ts
    FROM ${schema}.${table}
    WHERE (${whereParts.join(' OR ')})
      AND ${tsExpr} >= $${startParam}::timestamptz
      AND ${tsExpr} <= $${endParam}::timestamptz
    ORDER BY __newdomofon_event_ts ASC
    LIMIT $${limitParam}
  `;

  const { rows } = await client.query(sql, values);
  return rows.map((row) => normalizeRow(row, cand));
}

async function getEvents(target, startIso, endIso) {
  let start = new Date(startIso);
  let end = new Date(endIso);
  start = ndClampStartToArchive(target, start);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return { items: [], source: 'invalid-range', candidates: [], errors: [] };
  }

  const candidates = await discoverCandidates();
  const client = await getPool().connect();
  const errors = [];

  try {
    for (const cand of candidates) {
      try {
        const items = await queryCandidate(client, cand, target, start.toISOString(), end.toISOString());
        if (items.length) {
          return {
            items,
            source: `${cand.table_schema}.${cand.table_name}`,
            candidates: candidates.slice(0, 8).map(compactCandidate),
            errors,
          };
        }
      } catch (error) {
        errors.push({ table: `${cand.table_schema}.${cand.table_name}`, message: error.message });
      }
    }

    return {
      items: [],
      source: 'no-events-found',
      candidates: candidates.slice(0, 8).map(compactCandidate),
      errors: errors.slice(0, 8),
    };
  } finally {
    client.release();
  }
}

function compactCandidate(c) {
  return {
    table: `${c.table_schema}.${c.table_name}`,
    score: c.score,
    camera_cols: c.camera_cols,
    time_col: c.time_col,
    type_col: c.type_col,
    state_col: c.state_col,
    columns: c.columns,
  };
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  if (url.pathname === '/health' || url.pathname === '/nd-events/health') {
    let dbOk = false;
    let dbError = '';
    let candidates = [];

    try {
      const client = await getPool().connect();
      try {
        await client.query('SELECT 1');
        dbOk = true;
      } finally {
        client.release();
      }

      candidates = (await discoverCandidates()).slice(0, 8).map(compactCandidate);
    } catch (error) {
      dbError = error.message || String(error);
    }

    return sendJson(res, 200, {
      ok: true,
      service: 'newdomofon-events-public-proxy',
      version: VERSION,
      db_ok: dbOk,
      db_error: dbError,
      token_count: acceptedTokens().length,
      candidates,
    });
  }

  const match = url.pathname.match(/^\/(?:nd-events\/)?([^/]+)\/events$/);
  if (!match) return sendJson(res, 404, { error: 'Not found', path: url.pathname });

  if (!tokenAllowed(req, url)) return sendJson(res, 401, { error: 'Unauthorized' });

  const input = match[1];
  const target = resolveTarget(input, url.searchParams.get('stream') || '');
  const start = url.searchParams.get('start') || url.searchParams.get('from') || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const end = url.searchParams.get('end') || url.searchParams.get('to') || new Date().toISOString();

  try {
    const result = await getEvents(target, start, end);
    return sendJson(
      res,
      200,
      {
        ok: true,
        items: result.items,
        events: result.items,
        count: result.items.length,
        source: result.source,
        target,
        range: { start, end },
        candidates: result.candidates,
        errors: result.errors || [],
      },
      {
        'X-Newdomofon-Events-Source': result.source,
        'X-Newdomofon-Events-Count': String(result.items.length),
      },
    );
  } catch (error) {
    warn('events failed', url.pathname, error.message || error);
    return sendJson(res, 500, {
      error: 'Events query failed',
      message: error.message || String(error),
      target,
      range: { start, end },
    });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    warn('fatal request error', error);
    sendJson(res, 500, { error: 'Internal server error', message: error.message || String(error) });
  });
});

server.listen(PORT, HOST, () => {
  log('listening', {
    host: HOST,
    port: PORT,
    version: VERSION,
    camera_map: CAMERA_STREAM_MAP,
    aliases_file: STREAM_ALIASES_FILE,
    accepted_tokens_file: ACCEPTED_TOKENS_FILE,
    project_dir: PROJECT_DIR,
  });
});
