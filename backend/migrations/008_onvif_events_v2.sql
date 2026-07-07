CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.cameras ADD COLUMN IF NOT EXISTS onvif_password text;

CREATE TABLE IF NOT EXISTS public.camera_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES public.cameras(id) ON DELETE CASCADE,
  stream_name text NOT NULL,
  event_type text NOT NULL,
  event_state text,
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.camera_events
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS camera_id uuid,
  ADD COLUMN IF NOT EXISTS stream_name text,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS event_state text,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_camera_events_camera_time ON public.camera_events(camera_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_camera_events_stream_time ON public.camera_events(stream_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_camera_events_type_time ON public.camera_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_camera_events_data_gin ON public.camera_events USING gin(data);
