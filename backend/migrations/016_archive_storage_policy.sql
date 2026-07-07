ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS archive_storage text NOT NULL DEFAULT 'node';

ALTER TABLE public.cameras
  ADD COLUMN IF NOT EXISTS archive_storage text NOT NULL DEFAULT 'node';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_archive_storage_check'
       AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_archive_storage_check
      CHECK (archive_storage IN ('node', 'device', 'both'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cameras_archive_storage_check'
       AND conrelid = 'public.cameras'::regclass
  ) THEN
    ALTER TABLE public.cameras
      ADD CONSTRAINT cameras_archive_storage_check
      CHECK (archive_storage IN ('node', 'device', 'both'));
  END IF;
END $$;
