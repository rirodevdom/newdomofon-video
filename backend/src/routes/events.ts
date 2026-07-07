import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAuth, isAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { AuthRequest } from '../types.js';
import { canAccessCamera } from '../services/cameraAccess.js';

export const eventsRouter = Router();
export const internalEventsRouter = Router();

function requireInternal(req: any, res: any, next: any) {
  const expected = process.env.INTERNAL_DVR_SECRET;
  const got = req.header('x-internal-secret');

  if (!expected) return res.status(500).json({ error: 'INTERNAL_DVR_SECRET is not configured' });
  if (!got || got !== expected) return res.status(403).json({ error: 'Forbidden' });

  return next();
}

const eventSchema = z.object({
  camera_id: z.string().uuid(),
  stream_name: z.string().min(1),
  event_type: z.string().min(1).default('unknown'),
  event_state: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  source_name: z.string().nullable().optional(),
  occurred_at: z.string().datetime(),
  data: z.record(z.any()).default({})
});

const ingestSchema = z.object({
  events: z.array(eventSchema).max(500)
});

function eventHash(event: z.infer<typeof eventSchema>) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      camera_id: event.camera_id,
      occurred_at: event.occurred_at,
      topic: event.topic || '',
      event_type: event.event_type || '',
      event_state: event.event_state || '',
      source_name: event.source_name || '',
      data: event.data || {}
    }))
    .digest('hex');
}

internalEventsRouter.use(requireInternal);

internalEventsRouter.get('/cameras/onvif', asyncHandler(async (_req, res) => {
  const result = await query(
    `SELECT id, name, stream_name, source_url, onvif_xaddr, onvif_port, onvif_username
       FROM cameras
      WHERE is_enabled = true
        AND onvif_xaddr IS NOT NULL
      ORDER BY name`
  );

  res.json({ items: result.rows });
}));

internalEventsRouter.post('/events/onvif', asyncHandler(async (req, res) => {
  const body = ingestSchema.parse(req.body || {});
  let inserted = 0;

  for (const event of body.events) {
    const hash = eventHash(event);

    const result = await query(
      `INSERT INTO camera_events(
         camera_id, stream_name, event_type, event_state, topic, source_name,
         event_hash, data, occurred_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (camera_id, event_hash) DO NOTHING
       RETURNING id`,
      [
        event.camera_id,
        event.stream_name,
        event.event_type || 'unknown',
        event.event_state ?? null,
        event.topic ?? null,
        event.source_name ?? null,
        hash,
        event.data || {},
        event.occurred_at
      ]
    );

    inserted += result.rowCount || 0;
  }

  res.json({ ok: true, inserted });
}));

eventsRouter.use(requireAuth);

eventsRouter.get('/cameras/:cameraId/events', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = z.object({
    cameraId: z.string().uuid()
  }).parse(req.params);

  const q = z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
    type: z.string().optional()
  }).parse(req.query);

  if (!isAdmin(authReq)) {
    if (!await canAccessCamera(authReq.user!, params.cameraId)) return res.status(403).json({ error: 'No access to camera' });
  }

  const values: any[] = [params.cameraId, q.start, q.end];
  let typeFilter = '';

  if (q.type) {
    values.push(q.type);
    typeFilter = ` AND event_type = $${values.length}`;
  }

  const result = await query(
    `SELECT id, camera_id, stream_name, event_type, event_state, topic, source_name, data, occurred_at, created_at
       FROM camera_events
      WHERE camera_id = $1
        AND occurred_at >= $2
        AND occurred_at <= $3
        ${typeFilter}
      ORDER BY occurred_at ASC
      LIMIT 5000`,
    values
  );

  res.json({ items: result.rows });
}));

eventsRouter.get('/cameras/:cameraId/events/summary', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const params = z.object({
    cameraId: z.string().uuid()
  }).parse(req.params);

  const q = z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }).parse(req.query);

  if (!isAdmin(authReq)) {
    if (!await canAccessCamera(authReq.user!, params.cameraId)) return res.status(403).json({ error: 'No access to camera' });
  }

  const result = await query(
    `SELECT date_trunc('minute', occurred_at) AS bucket,
            count(*)::int AS count,
            jsonb_agg(DISTINCT event_type) AS types
       FROM camera_events
      WHERE camera_id = $1
        AND occurred_at >= $2
        AND occurred_at <= $3
      GROUP BY 1
      ORDER BY 1 ASC`,
    [params.cameraId, q.start, q.end]
  );

  res.json({ items: result.rows });
}));
