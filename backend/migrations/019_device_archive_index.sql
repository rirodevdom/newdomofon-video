CREATE TABLE IF NOT EXISTS public.device_archive_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES public.cameras(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.devices(id) ON DELETE CASCADE,
  dvr_server_id uuid REFERENCES public.dvr_servers(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'hikvision-isapi',
  track_id text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  playback_uri text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_archive_segments_unique
  ON public.device_archive_segments(camera_id, source, (COALESCE(track_id, '')), start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_device_archive_segments_camera_time
  ON public.device_archive_segments(camera_id, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_device_archive_segments_device_time
  ON public.device_archive_segments(device_id, start_at, end_at)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_archive_segments_node_time
  ON public.device_archive_segments(dvr_server_id, start_at, end_at)
  WHERE dvr_server_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.device_archive_sync_state (
  camera_id uuid PRIMARY KEY REFERENCES public.cameras(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.devices(id) ON DELETE CASCADE,
  dvr_server_id uuid REFERENCES public.dvr_servers(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'hikvision-isapi',
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_start_at timestamptz,
  last_end_at timestamptz,
  last_items integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
