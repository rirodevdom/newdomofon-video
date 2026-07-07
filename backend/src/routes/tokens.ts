import { createHmac as twoPartCreateHmac } from 'node:crypto';
import { createHmac as finalizerCreateHmac } from 'node:crypto';
import { createHmac as permanentCompatCreateHmac } from 'node:crypto';
import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { signNodeMediaToken, type NodeMediaScope } from '../services/nodeMediaToken.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { AuthRequest } from '../types.js';

function permanentMediaLinkVersionV3(): string | null {
  const value = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '').trim();
  return value || null;
}

function mediaTokenSecretV3(): string | null {
  return String(process.env.DVR_NODE_MEDIA_SECRET || process.env.NODE_MEDIA_SECRET || process.env.MEDIA_TOKEN_SECRET || '').trim() || null;
}

function signStableJwtPayloadV3(header: any, payload: any): string | null {
  const secret = mediaTokenSecretV3();
  if (!secret) return null;
  const stableHeader = { alg: 'HS256', typ: 'JWT', ...(header && typeof header === 'object' ? header : {}) };
  stableHeader.alg = 'HS256';
  const stablePayload = { ...(payload && typeof payload === 'object' ? payload : {}) };
  delete stablePayload.exp;
  delete stablePayload.iat;
  delete stablePayload.nbf;
  const version = permanentMediaLinkVersionV3();
  if (version) stablePayload.link_version = version;
  const encodedHeader = Buffer.from(JSON.stringify(stableHeader)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(stablePayload)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

function signStableLegacyPayloadV3(payload: any): string | null {
  const secret = mediaTokenSecretV3();
  if (!secret) return null;
  const stablePayload = { ...(payload && typeof payload === 'object' ? payload : {}) };
  delete stablePayload.exp;
  delete stablePayload.iat;
  delete stablePayload.nbf;
  const version = permanentMediaLinkVersionV3();
  if (version) stablePayload.link_version = version;
  const body = Buffer.from(JSON.stringify(stablePayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function permanentMediaLinksEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_LINKS || process.env.PERMANENT_CAMERA_LINKS || '').toLowerCase());
}

function permanentMediaLinkVersion(): string | null {
  const value = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '').trim();
  return value || null;
}

function mediaTokenSecret(): string | null {
  return String(process.env.DVR_NODE_MEDIA_SECRET || process.env.NODE_MEDIA_SECRET || process.env.MEDIA_TOKEN_SECRET || '').trim() || null;
}

function signPermanentMediaPayload(payload: any): string | null {
  const secret = mediaTokenSecret();
  if (!secret) return null;
  const stablePayload = { ...payload };
  delete stablePayload.exp;
  delete stablePayload.iat;
  delete stablePayload.nbf;
  const version = permanentMediaLinkVersion();
  if (version) stablePayload.link_version = version;
  const body = Buffer.from(JSON.stringify(stablePayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function rewritePermanentMediaToken(token: any): string | null {
  if (!permanentMediaLinksEnabled()) return null;
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  try {
    if (parts.length === 3) {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return signStableJwtPayloadV3(header, payload);
    }
    if (parts.length === 2) {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return signStableLegacyPayloadV3(payload);
    }
  } catch {
    return null;
  }
  return null;
}

// NEWD_PERMANENT_MEDIA_LINKS_PATCH: admin camera links are deterministic and long-lived.
const NEWD_PERMANENT_MEDIA_EXP = 4102444800;
const NEWD_PERMANENT_MEDIA_EXPIRES_AT = '2100-01-01T00:00:00.000Z';

export const tokensRouter = Router();
function twoPartFinalizerEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_TOKEN_TWO_PART_FINALIZER || '').toLowerCase());
}

function twoPartFinalizerExp(): number {
  const value = Number(process.env.PERMANENT_MEDIA_LINK_EXP || '4102444800');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4102444800;
}

function twoPartDecodeCandidate(part: any): any {
  try {
    return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function twoPartDecodePayload(token: any): any {
  const parts = String(token || '').split('.');
  const first = twoPartDecodeCandidate(parts[0]);
  if (first && (first.camera_id || first.stream_name || first.scope)) return first;
  const second = twoPartDecodeCandidate(parts[1]);
  if (second && (second.camera_id || second.stream_name || second.scope)) return second;
  return null;
}

function twoPartSign(payload: any, secret: any): any {
  if (!payload || !secret) return null;
  const clean = { ...payload };
  delete clean.iat;
  delete clean.nbf;
  clean.exp = twoPartFinalizerExp();
  clean.link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || clean.link_version || '1');

  const encodedPayload = Buffer.from(JSON.stringify(clean)).toString('base64url');
  const signature = twoPartCreateHmac('sha256', String(secret)).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function twoPartUrlToken(value: any, token: any): any {
  if (!value || !token) return value;
  try {
    const url = new URL(String(value));
    url.searchParams.set('token', token);
    return url.toString().replace(/%3CISO_START%3E/g, '<ISO_START>').replace(/%3CISO_END%3E/g, '<ISO_END>');
  } catch {
    return value;
  }
}

function twoPartTokenFromUrl(value: any): any {
  try {
    return new URL(String(value)).searchParams.get('token') || null;
  } catch {
    return null;
  }
}

function twoPartRewriteOne(body: any, tokenKey: any, urlKeys: any, secret: any) {
  const currentToken = body[tokenKey] || urlKeys.map((key: any) => twoPartTokenFromUrl(body[key])).find(Boolean);
  const payload = twoPartDecodePayload(currentToken);
  const token = twoPartSign(payload, secret);
  if (!token) return;

  body[tokenKey] = token;
  for (const key of urlKeys) {
    if (typeof body[key] === 'string') body[key] = twoPartUrlToken(body[key], token);
  }
}

function twoPartRewriteBody(body: any): any {
  if (!twoPartFinalizerEnabled() || !body || typeof body !== 'object') return body;
  const secret = process.env.DVR_NODE_MEDIA_SECRET || process.env.DVR_MEDIA_SECRET || process.env.JWT_SECRET;
  if (!secret) return body;

  twoPartRewriteOne(body, 'live_token', ['live_url'], secret);
  twoPartRewriteOne(body, 'archive_token', ['archive_url_template'], secret);
  twoPartRewriteOne(body, 'camera_token', ['camera_url', 'smartyard_url', 'player_url', 'primary_url'], secret);

  body.permanent = true;
  body.permanent_link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '1');
  body.permanent_compat_exp = twoPartFinalizerExp();
  body.permanent_compat_expires_at = new Date(twoPartFinalizerExp() * 1000).toISOString();
  body.media_token_format = 'payload.hmac-sha256';
  body.ttl_seconds = null;
  body.expires_at = null;
  return body;
}

function twoPartToBuffer(chunk: any, encoding: any): any {
  if (chunk == null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
}

function installTwoPartMediaTokenFinalizer(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const chunks: any = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = (chunk: any, encoding: any, callback: any) => {
      const buf = twoPartToBuffer(chunk, encoding);
      if (buf) chunks.push(buf);
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = (chunk: any, encoding: any, callback: any) => {
      const buf = twoPartToBuffer(chunk, encoding);
      if (buf) chunks.push(buf);

      if (!chunks.length) return originalEnd(chunk, encoding, callback);

      let out = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(out.toString('utf8'));
        out = Buffer.from(JSON.stringify(twoPartRewriteBody(parsed)));
        res.setHeader('Content-Length', String(out.length));
      } catch {
        // Return original response if it is not JSON.
      }

      return originalEnd(out, undefined, callback);
    };

    next();
  });
}

installTwoPartMediaTokenFinalizer(tokensRouter);

function mediaTokenFinalizerEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_TOKEN_FINALIZER || '').toLowerCase());
}

function mediaTokenFinalizerExp(): number {
  const value = Number(process.env.PERMANENT_MEDIA_LINK_EXP || '4102444800');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4102444800;
}

function mediaTokenFinalizerDecode(token: any): any {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function mediaTokenFinalizerSign(payload: any, secret: any): any {
  if (!payload || !secret) return null;
  const clean = { ...payload };
  delete clean.iat;
  delete clean.nbf;
  clean.exp = mediaTokenFinalizerExp();
  clean.link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || clean.link_version || '1');

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(clean)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = finalizerCreateHmac('sha256', String(secret)).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function mediaTokenFinalizerUrlToken(value: any, token: any): any {
  if (!value || !token) return value;
  try {
    const url = new URL(String(value));
    url.searchParams.set('token', token);
    return url.toString().replace(/%3CISO_START%3E/g, '<ISO_START>').replace(/%3CISO_END%3E/g, '<ISO_END>');
  } catch {
    return value;
  }
}

function mediaTokenFinalizerTokenFromUrl(value: any): any {
  try {
    return new URL(String(value)).searchParams.get('token') || null;
  } catch {
    return null;
  }
}

function mediaTokenFinalizerRewriteOne(body: any, tokenKey: any, urlKeys: any, secret: any): any {
  const currentToken = body[tokenKey] || urlKeys.map((key: any) => mediaTokenFinalizerTokenFromUrl(body[key])).find(Boolean);
  const payload = mediaTokenFinalizerDecode(currentToken);
  const nextToken = mediaTokenFinalizerSign(payload, secret);
  if (!nextToken) return;

  body[tokenKey] = nextToken;
  for (const key of urlKeys) {
    if (typeof body[key] === 'string') body[key] = mediaTokenFinalizerUrlToken(body[key], nextToken);
  }
}

function mediaTokenFinalizerRewriteBody(body: any): any {
  if (!mediaTokenFinalizerEnabled() || !body || typeof body !== 'object') return body;
  const secret = process.env.DVR_NODE_MEDIA_SECRET || process.env.DVR_MEDIA_SECRET || process.env.JWT_SECRET;
  if (!secret) return body;

  mediaTokenFinalizerRewriteOne(body, 'live_token', ['live_url'], secret);
  mediaTokenFinalizerRewriteOne(body, 'archive_token', ['archive_url_template'], secret);
  mediaTokenFinalizerRewriteOne(body, 'camera_token', ['camera_url', 'smartyard_url', 'player_url', 'primary_url'], secret);

  body.permanent = true;
  body.permanent_link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '1');
  body.permanent_compat_exp = mediaTokenFinalizerExp();
  body.permanent_compat_expires_at = new Date(mediaTokenFinalizerExp() * 1000).toISOString();
  body.ttl_seconds = null;
  body.expires_at = null;
  return body;
}

function mediaTokenFinalizerToBuffer(chunk: any, encoding: any): any {
  if (chunk == null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
}

function installMediaTokenFinalizer(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const chunks: any = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = (chunk: any, encoding: any, callback: any) => {
      const buf = mediaTokenFinalizerToBuffer(chunk, encoding);
      if (buf) chunks.push(buf);
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = (chunk: any, encoding: any, callback: any) => {
      const buf = mediaTokenFinalizerToBuffer(chunk, encoding);
      if (buf) chunks.push(buf);

      if (!chunks.length) return originalEnd(chunk, encoding, callback);

      let out = Buffer.concat(chunks);
      try {
        const text = out.toString('utf8');
        const parsed = JSON.parse(text);
        const rewritten = mediaTokenFinalizerRewriteBody(parsed);
        out = Buffer.from(JSON.stringify(rewritten));
        res.setHeader('Content-Length', String(out.length));
      } catch {
        // Fall through and return original buffered response.
      }

      return originalEnd(out, undefined, callback);
    };

    next();
  });
}

installMediaTokenFinalizer(tokensRouter);

function permanentCompatEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_COMPAT_EXP || '').toLowerCase());
}

function permanentCompatExp(): number {
  const value = Number(process.env.PERMANENT_MEDIA_LINK_EXP || '4102444800');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4102444800;
}

function permanentCompatBase64Url(value: any): any {
  return Buffer.from(value).toString('base64url');
}

function permanentCompatDecodeJwtPayload(token: any): any {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function permanentCompatSign(payload: any, secret: any): any {
  if (!payload || !secret) return null;
  const clean = { ...payload };
  delete clean.iat;
  delete clean.nbf;
  clean.exp = permanentCompatExp();
  clean.link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || clean.link_version || '1');

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = permanentCompatBase64Url(JSON.stringify(header));
  const encodedPayload = permanentCompatBase64Url(JSON.stringify(clean));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = permanentCompatCreateHmac('sha256', String(secret)).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function permanentCompatUrlToken(value: any, token: any): any {
  if (!value || !token) return value;
  try {
    const url = new URL(String(value));
    url.searchParams.set('token', token);
    return url.toString().replace(/%3CISO_START%3E/g, '<ISO_START>').replace(/%3CISO_END%3E/g, '<ISO_END>');
  } catch {
    return value;
  }
}

function permanentCompatTokenFromUrl(value: any): any {
  try {
    return new URL(String(value)).searchParams.get('token') || null;
  } catch {
    return null;
  }
}

function permanentCompatRewriteToken(body: any, tokenKey: any, urlKeys: any, secret: any): any {
  const currentToken = body[tokenKey] || urlKeys.map((key: any) => permanentCompatTokenFromUrl(body[key])).find(Boolean);
  const payload = permanentCompatDecodeJwtPayload(currentToken);
  const token = permanentCompatSign(payload, secret);
  if (!token) return null;

  body[tokenKey] = token;
  for (const key of urlKeys) {
    if (typeof body[key] === 'string') body[key] = permanentCompatUrlToken(body[key], token);
  }
  return token;
}

function permanentCompatRewriteBody(body: any): any {
  if (!permanentCompatEnabled() || !body || typeof body !== 'object') return body;
  const secret = process.env.DVR_NODE_MEDIA_SECRET || process.env.DVR_MEDIA_SECRET || process.env.JWT_SECRET;
  if (!secret) return body;

  permanentCompatRewriteToken(body, 'live_token', ['live_url'], secret);
  permanentCompatRewriteToken(body, 'archive_token', ['archive_url_template'], secret);
  permanentCompatRewriteToken(body, 'camera_token', ['camera_url', 'smartyard_url', 'player_url', 'primary_url'], secret);

  body.permanent = true;
  body.permanent_link_version = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '1');
  body.permanent_compat_exp = permanentCompatExp();
  body.permanent_compat_expires_at = new Date(permanentCompatExp() * 1000).toISOString();
  body.ttl_seconds = null;
  body.expires_at = null;
  return body;
}

function installPermanentCompatExpMiddleware(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => originalJson(permanentCompatRewriteBody(body));
    next();
  });
}

installPermanentCompatExpMiddleware(tokensRouter);

function mediaLinksUseRequestOrigin(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.MEDIA_LINKS_USE_REQUEST_ORIGIN || '').toLowerCase());
}

function requestPublicOrigin(req: any): string | null {
  const origin = String((req.headers && req.headers.origin) || '').trim();
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '');
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'https').split(',')[0].trim() || 'https';
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
  if (!host) return null;
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function rewriteUrlOrigin(value: any, origin: any): any {
  if (!value || !origin) return value;
  try {
    const parsed = new URL(String(value));
    const target = new URL(String(origin));
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString().replace(/%3CISO_START%3E/g, '<ISO_START>').replace(/%3CISO_END%3E/g, '<ISO_END>');
  } catch {
    return value;
  }
}

function rewriteMediaLinksToRequestOrigin(body: any, req: any): any {
  if (!mediaLinksUseRequestOrigin() || !body || typeof body !== 'object') return body;
  const origin = requestPublicOrigin(req);
  if (!origin) return body;

  body.live_url = rewriteUrlOrigin(body.live_url, origin);
  body.archive_url_template = rewriteUrlOrigin(body.archive_url_template, origin);

  // Keep SmartYard/camera_url stable for external integrations unless it is explicitly missing.
  body.media_origin = origin;
  body.media_links_origin_mode = 'request-origin';
  return body;
}

function installMediaSameOriginMiddleware(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => originalJson(rewriteMediaLinksToRequestOrigin(body, req));
    next();
  });
}

installMediaSameOriginMiddleware(tokensRouter);

function singleCameraLinksEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.SINGLE_CAMERA_LINKS || '').toLowerCase());
}

function singleCameraMediaSecret(): string | null {
  return String(process.env.DVR_NODE_MEDIA_SECRET || process.env.NODE_MEDIA_SECRET || process.env.MEDIA_TOKEN_SECRET || '').trim() || null;
}

function singleCameraLinkVersion(): string | null {
  return String(process.env.PERMANENT_MEDIA_LINK_VERSION || '').trim() || null;
}

function decodeSingleCameraTokenPayload(token: any): any {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  try {
    if (parts.length === 3) return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (parts.length === 2) return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return null;
}

function signSingleCameraPayload(payload: any): string | null {
  const secret = singleCameraMediaSecret();
  if (!secret) return null;
  const stablePayload = { ...(payload && typeof payload === 'object' ? payload : {}) };
  delete stablePayload.exp;
  delete stablePayload.iat;
  delete stablePayload.nbf;
  const version = singleCameraLinkVersion();
  if (version) stablePayload.link_version = version;
  const body = Buffer.from(JSON.stringify(stablePayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function singleCameraOrigin(body: any): string | null {
  for (const value of [body && body.live_url, body && body.archive_url_template, process.env.CAMERA_LINK_PUBLIC_BASE_URL, process.env.DVR_NODE_PUBLIC_BASE_URL, process.env.PUBLIC_BASE_URL, process.env.APP_PUBLIC_URL]) {
    if (!value) continue;
    try {
      const parsed = new URL(String(value));
      return parsed.origin;
    } catch {
      const raw = String(value).replace(/\/+$/, '');
      if (/^https?:\/\//.test(raw)) return raw;
    }
  }
  return null;
}

function applySingleCameraLink(body: any): any {
  if (!singleCameraLinksEnabled() || !body || typeof body !== 'object') return body;
  const camera = body.camera && typeof body.camera === 'object' ? body.camera : null;
  const cameraId = camera && camera.id ? String(camera.id) : null;
  const streamName = camera && camera.stream_name ? String(camera.stream_name) : null;
  const sourcePayload = decodeSingleCameraTokenPayload(body.live_token) || decodeSingleCameraTokenPayload(body.archive_token) || {};
  const userId = sourcePayload.user_id || sourcePayload.userId || null;
  if (!cameraId || !streamName) return body;

  const cameraToken = signSingleCameraPayload({
    camera_id: cameraId,
    stream_name: streamName,
    user_id: userId,
    scope: 'camera'
  });
  const origin = singleCameraOrigin(body);
  if (!cameraToken || !origin) return body;

  const cameraUrl = `${origin}/${encodeURIComponent(cameraId)}/?token=${encodeURIComponent(cameraToken)}`;
  body.camera_token = cameraToken;
  body.camera_url = cameraUrl;
  body.smartyard_url = cameraUrl;
  body.player_url = cameraUrl;
  body.primary_url = cameraUrl;
  body.link_mode = 'single-camera';
  return body;
}

function installSingleCameraLinkMiddleware(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => originalJson(applySingleCameraLink(body));
    next();
  });
}

installSingleCameraLinkMiddleware(tokensRouter);

function rewritePermanentCameraLinksResponse(body: any): any {
  if (!permanentMediaLinksEnabled() || !body || typeof body !== 'object') return body;
  const rewriteUrl = (value: any, token: any) => {
    if (!value || !token) return value;
    try {
      const parsed = new URL(String(value));
      parsed.searchParams.set('token', token);
      return parsed.toString().replace(/%3CISO_START%3E/g, '<ISO_START>').replace(/%3CISO_END%3E/g, '<ISO_END>');
    } catch {
      return String(value).replace(/token=[^&]+/, `token=${token}`);
    }
  };
  const liveToken = rewritePermanentMediaToken(body.live_token);
  const archiveToken = rewritePermanentMediaToken(body.archive_token);
  if (liveToken) {
    body.live_token = liveToken;
    body.live_url = rewriteUrl(body.live_url, liveToken);
  }
  if (archiveToken) {
    body.archive_token = archiveToken;
    body.archive_url_template = rewriteUrl(body.archive_url_template, archiveToken);
  }
  if (liveToken || archiveToken) {
    body.expires_at = null;
    body.ttl_seconds = null;
    body.permanent = true;
    body.permanent_link_version = permanentMediaLinkVersion();
  }
  return body;
}

function installPermanentCameraLinksMiddleware(router: any) {
  router.use('/camera-links/:cameraId', (req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => originalJson(rewritePermanentCameraLinksResponse(body));
    next();
  });
}

installPermanentCameraLinksMiddleware(tokensRouter);

tokensRouter.use(requireAuth, requireRole('super_admin'));

type CameraLinkRow = {
  id: string;
  name: string;
  stream_name: string;
  archive_storage: 'node' | 'device' | 'both';
  device_archive_storage: 'node' | 'device' | 'both' | null;
  dvr_server_id: string | null;
  node_name: string | null;
  node_status: string | null;
  node_public_base_url: string | null;
  node_media_secret: string | null;
  node_enabled: boolean | null;
};

function sha256(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function absoluteBackendBase(req: AuthRequest): string {
  const configured = process.env.PUBLIC_BACKEND_BASE_URL || process.env.APP_PUBLIC_BASE_URL || '';
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function parseCameraLinkTtlSeconds(raw: unknown): number {
  const fallback = Number.parseInt(process.env.CAMERA_LINK_TOKEN_TTL_SECONDS || '', 10);
  const requested = Number(raw);
  const ttl = Number.isFinite(requested) && requested > 0 ? requested : (Number.isFinite(fallback) && fallback > 0 ? fallback : 30 * 24 * 60 * 60);
  return Math.max(300, Math.min(Math.floor(ttl), 365 * 24 * 60 * 60));
}

function effectiveArchiveStorage(camera: CameraLinkRow): 'node' | 'device' | 'both' {
  if (camera.device_archive_storage === 'both') return 'both';
  return camera.archive_storage || camera.device_archive_storage || 'node';
}

function defaultArchivePath(camera: CameraLinkRow): string {
  return effectiveArchiveStorage(camera) === 'device' ? 'device-archive.m3u8' : 'archive.m3u8';
}

function appendToken(url: string, token: string, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams({ ...extra, token });
  return `${url}?${qs.toString()}`;
}

function nodeCameraUrl(camera: CameraLinkRow, userId: string, scope: NodeMediaScope, pathSuffix: string, ttlSeconds: number, params: Record<string, string> = {}) {
  if (!camera.node_public_base_url || !camera.node_media_secret || camera.node_enabled === false) return null;
  const token = signNodeMediaToken(camera.node_media_secret, {
    camera_id: camera.id,
    stream_name: camera.stream_name,
    user_id: userId,
    scope
  }, ttlSeconds);
  const base = camera.node_public_base_url.replace(/\/+$/, '');
  const url = `${base}/cameras/${encodeURIComponent(camera.stream_name)}/${pathSuffix}`;
  return { url: appendToken(url, token, params), token };
}

function readableTemplate(url: string): string {
  return url
    .replace(/%3CISO_START%3E/g, '<ISO_START>')
    .replace(/%3CISO_END%3E/g, '<ISO_END>');
}

tokensRouter.get('/', asyncHandler(async (_req, res) => {
  const nodes = await query(
    `SELECT id, name, created_at, updated_at, last_seen_at,
            (agent_token_hash IS NOT NULL AND length(agent_token_hash) > 0) AS has_agent_token,
            (media_secret IS NOT NULL AND length(media_secret) > 0) AS has_media_secret
       FROM dvr_servers
      ORDER BY created_at DESC`
  );

  const cameras = await query(
    `SELECT c.id, c.name, c.stream_name, c.archive_storage,
            d.archive_storage AS device_archive_storage,
            c.dvr_server_id,
            ds.name AS node_name,
            ds.status AS node_status,
            COALESCE(ds.public_base_url, ds.base_url) AS node_public_base_url,
            (ds.media_secret IS NOT NULL AND length(ds.media_secret) > 0) AS has_media_secret,
            ds.is_enabled AS node_enabled
       FROM cameras c
       LEFT JOIN devices d ON d.id = c.device_id
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
      WHERE c.is_enabled = true
      ORDER BY c.name ASC, c.stream_name ASC`
  );

  res.json({
    node_registration_token: {
      type: 'Node registration token',
      configured: Boolean(config.nodeRegistrationToken),
      created_at: null,
      last_used_at: null
    },
    internal_dvr_secret: {
      type: 'Internal DVR secret',
      configured: Boolean(process.env.INTERNAL_DVR_SECRET),
      created_at: null,
      last_used_at: null
    },
    node_tokens: nodes.rows.map((node) => ({
      id: node.id,
      name: node.name,
      has_agent_token: node.has_agent_token,
      has_media_secret: node.has_media_secret,
      created_at: node.created_at,
      updated_at: node.updated_at,
      last_used_at: node.last_seen_at
    })),
    camera_links: cameras.rows.map((camera) => ({
      id: camera.id,
      name: camera.name,
      stream_name: camera.stream_name,
      archive_storage: camera.archive_storage,
      device_archive_storage: camera.device_archive_storage,
      dvr_server_id: camera.dvr_server_id,
      node_name: camera.node_name,
      node_status: camera.node_status,
      has_media_secret: camera.has_media_secret,
      node_enabled: camera.node_enabled,
      link_mode: camera.node_public_base_url && camera.has_media_secret && camera.node_enabled !== false ? 'node-direct' : 'master-proxy'
    }))
  });
}));

tokensRouter.post('/camera-links/:cameraId', asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  if (!authReq.user) return res.status(401).json({ error: 'Unauthorized' });

  const ttlSeconds = parseCameraLinkTtlSeconds(req.body?.ttl_seconds);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const result = await query<CameraLinkRow>(
    `SELECT c.id, c.name, c.stream_name, c.archive_storage,
            d.archive_storage AS device_archive_storage,
            c.dvr_server_id,
            ds.name AS node_name,
            ds.status AS node_status,
            COALESCE(ds.public_base_url, ds.base_url) AS node_public_base_url,
            ds.media_secret AS node_media_secret,
            ds.is_enabled AS node_enabled
       FROM cameras c
       LEFT JOIN devices d ON d.id = c.device_id
       LEFT JOIN dvr_servers ds ON ds.id = c.dvr_server_id
      WHERE c.id = $1
        AND c.is_enabled = true
      LIMIT 1`,
    [req.params.cameraId]
  );
  const camera = result.rows[0];
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const archivePath = defaultArchivePath(camera);
  const startEndHint = archivePath === 'device-archive.m3u8'
    ? { start: '<ISO_START>', end: '<ISO_END>' }
    : { start: '<ISO_START>', end: '<ISO_END>' };
  const live = nodeCameraUrl(camera, authReq.user.id, 'live', 'live.m3u8', ttlSeconds);
  const archive = nodeCameraUrl(camera, authReq.user.id, 'archive', archivePath, ttlSeconds, startEndHint);

  if (live && archive) {
    return res.json({
      camera: { id: camera.id, name: camera.name, stream_name: camera.stream_name },
      mode: 'node-direct',
      ttl_seconds: NEWD_PERMANENT_MEDIA_EXP,
      expires_at: expiresAt.toISOString(),
      live_url: live.url,
      archive_url_template: readableTemplate(archive.url),
      live_token: live.token,
      archive_token: archive.token,
      archive_source: archivePath === 'device-archive.m3u8' ? 'device' : 'node',
      permanent: true, note: 'Node media links are signed for this camera and expire automatically.'
    });
  }

  const rawToken = crypto.randomBytes(32).toString('base64url');
  await query(
    'INSERT INTO playback_tokens(user_id, camera_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
    [authReq.user.id, camera.id, sha256(rawToken), expiresAt]
  );
  const base = absoluteBackendBase(authReq) || '';
  const mediaBase = config.mediaPublicBaseUrl.startsWith('http')
    ? config.mediaPublicBaseUrl.replace(/\/+$/, '')
    : `${base}${config.mediaPublicBaseUrl}`.replace(/\/+$/, '');
  const stream = encodeURIComponent(camera.stream_name);

  res.json({
    camera: { id: camera.id, name: camera.name, stream_name: camera.stream_name },
    mode: 'master-proxy',
    ttl_seconds: NEWD_PERMANENT_MEDIA_EXP,
    expires_at: expiresAt.toISOString(),
    live_url: `${mediaBase}/${stream}/live.m3u8?token=${encodeURIComponent(rawToken)}`,
    archive_url_template: `${mediaBase}/${stream}/archive.m3u8?start=<ISO_START>&end=<ISO_END>&token=${encodeURIComponent(rawToken)}`,
    live_token: rawToken,
    archive_token: rawToken,
    archive_source: 'node',
    permanent: true, note: 'Master proxy links are stored in playback_tokens and expire automatically.'
  });
}));
