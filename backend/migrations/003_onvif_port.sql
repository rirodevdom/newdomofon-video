ALTER TABLE cameras ADD COLUMN IF NOT EXISTS onvif_port integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cameras_onvif_port_check'
  ) THEN
    ALTER TABLE cameras
      ADD CONSTRAINT cameras_onvif_port_check
      CHECK (onvif_port IS NULL OR (onvif_port BETWEEN 1 AND 65535));
  END IF;
END $$;
