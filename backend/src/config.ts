import 'dotenv/config';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer env ${name}`);
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-now';

if (nodeEnv === 'production') {
  if (!process.env.JWT_SECRET || jwtSecret.length < 32 || jwtSecret.startsWith('change-this') || jwtSecret === 'replace-this-with-a-long-random-secret') {
    throw new Error('JWT_SECRET must be set to a unique value with at least 32 characters in production');
  }
  if (!process.env.ADMIN_PASSWORD || adminPassword === 'change-me-now' || adminPassword.startsWith('change-this') || adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be changed and be at least 12 characters in production');
  }
}

export const config = {
  nodeEnv,
  port: intEnv('BACKEND_PORT', 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://newdomofon:newdomofon_password@127.0.0.1:5432/newdomofon_video',
  jwtSecret,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  dvrEngineUrl: process.env.DVR_ENGINE_URL || 'http://localhost:3010',
  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || '/api/media',
  playbackTokenTtlSeconds: intEnv('PLAYBACK_TOKEN_TTL_SECONDS', 900),
  nodeRegistrationToken: process.env.NODE_REGISTRATION_TOKEN || '',
  nodeCommandPollLimit: intEnv('NODE_COMMAND_POLL_LIMIT', 20),
  adminLogin: process.env.ADMIN_LOGIN || 'admin',
  adminPassword,
  trustProxy: boolEnv('TRUST_PROXY', false)
};
