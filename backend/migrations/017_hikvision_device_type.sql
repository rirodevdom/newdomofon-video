DO $$
DECLARE
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
END $$;
