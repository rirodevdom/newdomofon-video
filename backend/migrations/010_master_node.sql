ALTER TABLE dvr_servers
  ADD COLUMN IF NOT EXISTS agent_token_hash text,
  ADD COLUMN IF NOT EXISTS media_secret text,
  ADD COLUMN IF NOT EXISTS public_base_url text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS version text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS storage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS config_generation bigint NOT NULL DEFAULT 1;

UPDATE dvr_servers
   SET public_base_url = COALESCE(public_base_url, base_url),
       media_secret = COALESCE(media_secret, encode(gen_random_bytes(32), 'base64')),
       agent_token_hash = COALESCE(agent_token_hash, encode(digest(id::text || ':' || name || ':' || created_at::text, 'sha256'), 'hex'))
 WHERE media_secret IS NULL
    OR agent_token_hash IS NULL
    OR public_base_url IS NULL;

CREATE INDEX IF NOT EXISTS idx_dvr_servers_enabled ON dvr_servers(is_enabled);
CREATE INDEX IF NOT EXISTS idx_cameras_dvr_server ON cameras(dvr_server_id);

CREATE TABLE IF NOT EXISTS node_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dvr_server_id uuid NOT NULL REFERENCES dvr_servers(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'picked', 'done', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  picked_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_node_commands_node_status ON node_commands(dvr_server_id, status, created_at);

CREATE OR REPLACE FUNCTION bump_dvr_server_config_generation()
RETURNS trigger AS $$
BEGIN
  IF NEW.dvr_server_id IS DISTINCT FROM OLD.dvr_server_id
     OR NEW.source_url IS DISTINCT FROM OLD.source_url
     OR NEW.stream_name IS DISTINCT FROM OLD.stream_name
     OR NEW.rtmp_push_url IS DISTINCT FROM OLD.rtmp_push_url
     OR NEW.retention_days IS DISTINCT FROM OLD.retention_days
     OR NEW.is_enabled IS DISTINCT FROM OLD.is_enabled
     OR NEW.onvif_xaddr IS DISTINCT FROM OLD.onvif_xaddr
     OR NEW.onvif_port IS DISTINCT FROM OLD.onvif_port
     OR NEW.onvif_username IS DISTINCT FROM OLD.onvif_username
     OR NEW.onvif_password IS DISTINCT FROM OLD.onvif_password
  THEN
    UPDATE dvr_servers
       SET config_generation = config_generation + 1,
           updated_at = now()
     WHERE id IN (OLD.dvr_server_id, NEW.dvr_server_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cameras_bump_dvr_server_config') THEN
    CREATE TRIGGER trg_cameras_bump_dvr_server_config
    AFTER UPDATE ON cameras
    FOR EACH ROW EXECUTE FUNCTION bump_dvr_server_config_generation();
  END IF;
END $$;
