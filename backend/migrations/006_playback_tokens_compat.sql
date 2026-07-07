CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS playback_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text,
  camera_id uuid,
  user_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE playback_tokens
  ADD COLUMN IF NOT EXISTS id uuid,
  ADD COLUMN IF NOT EXISTS token text,
  ADD COLUMN IF NOT EXISTS camera_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE playback_tokens SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE playback_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS ux_playback_tokens_token
  ON playback_tokens(token)
  WHERE token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playback_tokens_camera_expires
  ON playback_tokens(camera_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_playback_tokens_expires
  ON playback_tokens(expires_at);
