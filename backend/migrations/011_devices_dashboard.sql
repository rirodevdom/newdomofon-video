CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  connection_type text NOT NULL DEFAULT 'RTSP' CHECK (connection_type IN ('RTSP', 'ONVIF', 'HIKVISION')),
  dvr_server_id uuid REFERENCES dvr_servers(id) ON DELETE SET NULL,
  host text,
  port integer CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
  username text,
  password text,
  rtsp_url text,
  comment text,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'error', 'unknown')),
  last_check_at timestamptz,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_dvr_server ON devices(dvr_server_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_cameras_device ON cameras(device_id);

CREATE OR REPLACE FUNCTION bump_dvr_server_config_generation()
RETURNS trigger AS $$
BEGIN
  IF NEW.dvr_server_id IS DISTINCT FROM OLD.dvr_server_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_devices_updated_at') THEN
    CREATE TRIGGER trg_devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
