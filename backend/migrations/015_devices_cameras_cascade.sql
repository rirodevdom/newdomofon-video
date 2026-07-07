DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.cameras'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (device_id)%'
  LOOP
    EXECUTE format('ALTER TABLE public.cameras DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.cameras
    ADD CONSTRAINT cameras_device_id_fkey
    FOREIGN KEY (device_id)
    REFERENCES public.devices(id)
    ON DELETE CASCADE;
END $$;
