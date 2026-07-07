import crypto from 'node:crypto';
import { config } from '../config.js';

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
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8'));
    return signPermanentMediaPayload(payload);
  } catch {
    return null;
  }
}

export type NodeMediaScope = 'live' | 'archive' | 'export' | 'file' | 'status';

export interface NodeMediaTokenPayload {
  stream_name: string;
  camera_id: string;
  user_id: string;
  scope: NodeMediaScope;
  exp?: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signNodeMediaToken(secret: string, payload: Omit<NodeMediaTokenPayload, 'exp'>, ttlSeconds = config.playbackTokenTtlSeconds): string {
  if (permanentMediaLinksEnabled()) {
    const permanentToken = signPermanentMediaPayload(payload);
    if (permanentToken) return permanentToken;
  }
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
