CREATE TABLE IF NOT EXISTS camera_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  stream_name text NOT NULL,
  event_type text NOT NULL DEFAULT 'unknown',
  event_state text,
  topic text,
  source_name text,
  event_hash text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_camera_events_hash
  ON camera_events(camera_id, event_hash);

CREATE INDEX IF NOT EXISTS idx_camera_events_camera_time
  ON camera_events(camera_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_camera_events_stream_time
  ON camera_events(stream_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_camera_events_type_time
  ON camera_events(event_type, occurred_at DESC);
