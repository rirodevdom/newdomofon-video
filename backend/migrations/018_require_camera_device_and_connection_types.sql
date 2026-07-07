DO $$
DECLARE
  orphan record;
  generated_device_id uuid;
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%connection_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.devices DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  UPDATE public.devices
     SET connection_type = 'RTSP'
   WHERE connection_type IN ('HTTP', 'OTHER');

  ALTER TABLE public.devices
    ADD CONSTRAINT devices_connection_type_check
    CHECK (connection_type IN ('RTSP', 'ONVIF', 'HIKVISION'));

  FOR orphan IN
    SELECT c.id, c.name, c.source_url, c.dvr_server_id, c.archive_storage
      FROM public.cameras c
     WHERE c.device_id IS NULL
  LOOP
    INSERT INTO public.devices (
      name, connection_type, archive_storage, dvr_server_id, rtsp_url, comment, status, is_enabled
    )
    VALUES (
      'Legacy device for ' || orphan.name,
      'RTSP',
      COALESCE(orphan.archive_storage, 'node'),
      orphan.dvr_server_id,
      orphan.source_url,
      'Auto-created by migration 018 because cameras must belong to a device.',
      'unknown',
      true
    )
    RETURNING id INTO generated_device_id;

    UPDATE public.cameras
       SET device_id = generated_device_id
     WHERE id = orphan.id;
  END LOOP;

  ALTER TABLE public.cameras
    ALTER COLUMN device_id SET NOT NULL;
END $$;
