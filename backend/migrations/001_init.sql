CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'operator', 'viewer', 'installer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dvr_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  internal_url text,
  status text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cameras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES camera_groups(id) ON DELETE SET NULL,
  dvr_server_id uuid REFERENCES dvr_servers(id) ON DELETE SET NULL,
  name text NOT NULL,
  stream_name text UNIQUE NOT NULL CHECK (stream_name ~ '^[a-zA-Z0-9_-]+$'),
  source_url text NOT NULL,
  rtmp_push_url text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  direction_deg integer CHECK (direction_deg IS NULL OR (direction_deg >= 0 AND direction_deg <= 360)),
  fov_deg integer CHECK (fov_deg IS NULL OR (fov_deg >= 1 AND fov_deg <= 360)),
  retention_days integer NOT NULL DEFAULT 7 CHECK (retention_days >= 1 AND retention_days <= 365),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cameras_group ON cameras(group_id);
CREATE INDEX IF NOT EXISTS idx_cameras_enabled ON cameras(is_enabled);

CREATE TABLE IF NOT EXISTS user_camera_groups (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES camera_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS user_favorites (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  camera_id uuid REFERENCES cameras(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, camera_id)
);

CREATE TABLE IF NOT EXISTS playback_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  camera_id uuid REFERENCES cameras(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playback_tokens_expires ON playback_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  ip inet,
  user_agent text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
    CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_dvr_servers_updated_at') THEN
    CREATE TRIGGER trg_dvr_servers_updated_at BEFORE UPDATE ON dvr_servers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_camera_groups_updated_at') THEN
    CREATE TRIGGER trg_camera_groups_updated_at BEFORE UPDATE ON camera_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cameras_updated_at') THEN
    CREATE TRIGGER trg_cameras_updated_at BEFORE UPDATE ON cameras FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
