import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const nodeAgentRouter = Router();

interface NodeAgentRequest extends Request {
  node?: {
    id: string;
    name: string;
    media_secret: string;
    config_generation: string;
  };
}

function createSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function tokenFromRequest(req: Request): string {
  const bearer = String(req.get('authorization') || '');
  if (bearer.startsWith('Bearer ')) return bearer.slice(7).trim();
  return String(req.get('x-node-token') || req.body?.agent_token || req.query.token || '').trim();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function requireNode(req: NodeAgentRequest, res: Response, next: NextFunction) {
  const nodeId = String(req.get('x-node-id') || req.body?.node_id || req.query.node_id || '').trim();
  const token = tokenFromRequest(req);

  if (!nodeId || !token) return res.status(401).json({ error: 'Missing node credentials' });

  const result = await query<{
    id: string;
    name: string;
    agent_token_hash: string;
    media_secret: string;
    config_generation: string;
    is_enabled: boolean;
  }>(
    `SELECT id, name, agent_token_hash, media_secret, config_generation::text, is_enabled
       FROM dvr_servers
      WHERE id = $1
      LIMIT 1`,
    [nodeId]
  );

  const node = result.rows[0];
  if (!node || !node.is_enabled || !node.agent_token_hash || !safeEqual(node.agent_token_hash, sha256(token))) {
    return res.status(401).json({ error: 'Invalid node credentials' });
  }

  req.node = {
    id: node.id,
    name: node.name,
    media_secret: node.media_secret,
    config_generation: node.config_generation
  };
  return next();
}

const registerSchema = z.object({
  registration_token: z.string().optional(),
  name: z.string().min(1),
  public_base_url: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
  internal_url: z.string().optional().nullable(),
  version: z.string().optional(),
  capabilities: z.record(z.any()).optional()
});

nodeAgentRouter.post('/register', asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body || {});
  const registrationToken = body.registration_token || String(req.get('x-node-registration-token') || '');

  if (!config.nodeRegistrationToken) {
    return res.status(403).json({ error: 'NODE_REGISTRATION_TOKEN is not configured on master' });
  }
  if (!registrationToken || !safeEqual(sha256(registrationToken), sha256(config.nodeRegistrationToken))) {
    return res.status(403).json({ error: 'Invalid node registration token' });
  }

  const agentToken = createSecret();
  const mediaSecret = createSecret();
  const publicBaseUrl = body.public_base_url || body.base_url || '';

  const result = await query<{ id: string }>(
    `INSERT INTO dvr_servers(
       name, base_url, public_base_url, internal_url, status,
       agent_token_hash, media_secret, version, capabilities, last_seen_at
     )
     VALUES ($1,$2,$3,$4,'online',$5,$6,$7,$8,now())
     RETURNING id`,
    [
      body.name,
      publicBaseUrl,
      publicBaseUrl,
      body.internal_url ?? null,
      sha256(agentToken),
      mediaSecret,
      body.version ?? null,
      JSON.stringify(body.capabilities || {})
    ]
  );

  res.status(201).json({
    node_id: result.rows[0].id,
    agent_token: agentToken,
    media_secret: mediaSecret,
    public_base_url: publicBaseUrl
  });
}));

nodeAgentRouter.post('/heartbeat', requireNode, asyncHandler(async (req: NodeAgentRequest, res) => {
  const body = req.body || {};
  await query(
    `UPDATE dvr_servers
        SET status = 'online',
            last_seen_at = now(),
            public_base_url = COALESCE($2, public_base_url),
            base_url = COALESCE($2, base_url),
            internal_url = COALESCE($3, internal_url),
            version = COALESCE($4, version),
            capabilities = COALESCE($5::jsonb, capabilities),
            storage = COALESCE($6::jsonb, storage)
      WHERE id = $1`,
    [
      req.node!.id,
      body.public_base_url || body.base_url || null,
      body.internal_url || null,
      body.version || null,
      body.capabilities ? JSON.stringify(body.capabilities) : null,
      body.storage ? JSON.stringify(body.storage) : null
    ]
  );

  res.json({
    ok: true,
    node_id: req.node!.id,
    config_generation: req.node!.config_generation
  });
}));

nodeAgentRouter.get('/config', requireNode, asyncHandler(async (req: NodeAgentRequest, res) => {
  const cameras = await query(
    `SELECT c.id, c.name, c.stream_name, c.source_url, c.archive_storage, c.rtmp_push_url, c.retention_days, c.is_enabled,
            c.device_id,
            d.connection_type AS device_connection_type,
            d.archive_storage AS device_archive_storage,
            d.host AS device_host,
            d.port AS device_port,
            d.username AS device_username,
            d.password AS device_password,
            d.rtsp_url AS device_rtsp_url,
            c.onvif_xaddr, c.onvif_port, c.onvif_username, c.onvif_password, c.onvif_profile_token
       FROM cameras c
       LEFT JOIN devices d ON d.id = c.device_id
      WHERE c.dvr_server_id = $1
        AND c.is_enabled = true
      ORDER BY c.stream_name ASC`,
    [req.node!.id]
  );

  res.json({
    node_id: req.node!.id,
    node_name: req.node!.name,
    media_secret: req.node!.media_secret,
    config_generation: req.node!.config_generation,
    cameras: cameras.rows
  });
}));

nodeAgentRouter.get('/commands', requireNode, asyncHandler(async (req: NodeAgentRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || config.nodeCommandPollLimit), 1), 100);
  const result = await query(
    `UPDATE node_commands
        SET status = 'picked',
            picked_at = now()
      WHERE id IN (
        SELECT id
          FROM node_commands
         WHERE dvr_server_id = $1
           AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, created_at, picked_at`,
    [req.node!.id, limit]
  );

  res.json({ items: result.rows });
}));

nodeAgentRouter.post('/commands/:id/result', requireNode, asyncHandler(async (req: NodeAgentRequest, res) => {
  const status = req.body?.status === 'failed' ? 'failed' : 'done';
  const result = req.body?.result || {};
  const updated = await query(
    `UPDATE node_commands
        SET status = $3,
            result = $4,
            finished_at = now()
      WHERE id = $1
        AND dvr_server_id = $2
      RETURNING id`,
    [req.params.id, req.node!.id, status, JSON.stringify(result)]
  );
  if (!updated.rowCount) return res.status(404).json({ error: 'Command not found' });
  res.json({ ok: true });
}));
