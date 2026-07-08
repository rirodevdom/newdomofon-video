import crypto from 'node:crypto';
import { config } from '../config.js';

function permanentMediaLinksEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_LINKS || process.env.PERMANENT_CAMERA_LINKS || '').toLowerCase());
}

function permanentMediaTokenRandomize(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PERMANENT_MEDIA_TOKEN_RANDOMIZE || process.env.STATIC_CAMERA_TOKEN_RANDOMIZE || '').toLowerCase());
}

function permanentMediaLinkVersion(): string | null {
  const value = String(process.env.PERMANENT_MEDIA_LINK_VERSION || '').trim();
  return value || null;
}

export type NodeMediaScope = 'live' | 'archive' | 'export' | 'file' | 'status';

export interface NodeMediaTokenPayload {
  stream_name: string;
  camera_id: string;
  user_id: string;
  scope: NodeMediaScope;
  exp?: number;
  link_version?: string;
  jti?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signPayload(secret: string, payload: object): string {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function signNodeMediaToken(secret: string, payload: Omit<NodeMediaTokenPayload, 'exp'>, ttlSeconds = config.playbackTokenTtlSeconds): string {
  const cleanPayload: NodeMediaTokenPayload = { ...payload };

  if (permanentMediaLinksEnabled()) {
    delete cleanPayload.exp;
    const version = permanentMediaLinkVersion();
    if (version) cleanPayload.link_version = version;
    if (permanentMediaTokenRandomize()) cleanPayload.jti = crypto.randomBytes(16).toString('base64url');
    return signPayload(secret, cleanPayload);
  }

  cleanPayload.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return signPayload(secret, cleanPayload);
}
