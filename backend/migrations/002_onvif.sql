ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS onvif_xaddr text,
  ADD COLUMN IF NOT EXISTS onvif_username text,
  ADD COLUMN IF NOT EXISTS onvif_profile_token text,
  ADD COLUMN IF NOT EXISTS onvif_device_info jsonb,
  ADD COLUMN IF NOT EXISTS onvif_last_sync_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cameras_onvif_xaddr
  ON cameras(onvif_xaddr)
  WHERE onvif_xaddr IS NOT NULL;
