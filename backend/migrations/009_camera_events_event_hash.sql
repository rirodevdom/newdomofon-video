CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.camera_events
  ADD COLUMN IF NOT EXISTS event_hash text;

UPDATE public.camera_events
   SET event_hash = encode(
     digest(
       coalesce(camera_id::text, '') || '|' ||
       coalesce(stream_name, '') || '|' ||
       coalesce(event_type, '') || '|' ||
       coalesce(event_state, '') || '|' ||
       coalesce(occurred_at::text, '') || '|' ||
       coalesce(data::text, ''),
       'sha256'
     ),
     'hex'
   )
 WHERE event_hash IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'camera_events'
       AND indexname = 'ux_camera_events_event_hash'
  ) THEN
    CREATE UNIQUE INDEX ux_camera_events_event_hash
      ON public.camera_events(event_hash)
      WHERE event_hash IS NOT NULL;
  END IF;
END $$;

ALTER TABLE public.camera_events
  ALTER COLUMN event_hash SET NOT NULL;
