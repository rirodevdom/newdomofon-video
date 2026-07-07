\set ON_ERROR_STOP on

-- Hot-path indexes for timeline, events and node assignment queries.
-- Run with psql, not inside an explicit transaction: CREATE INDEX CONCURRENTLY
-- needs its own transaction boundary.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_archive_segments_camera_time_idx
  ON public.device_archive_segments (camera_id, start_at, end_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_archive_segments_node_time_idx
  ON public.device_archive_segments (dvr_server_id, start_at, end_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_archive_segments_seen_idx
  ON public.device_archive_segments (last_seen_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS camera_events_camera_time_idx
  ON public.camera_events (camera_id, occurred_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS camera_events_stream_time_idx
  ON public.camera_events (stream_name, occurred_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cameras_dvr_enabled_idx
  ON public.cameras (dvr_server_id)
  WHERE is_enabled = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS cameras_device_enabled_idx
  ON public.cameras (device_id)
  WHERE is_enabled = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_dvr_enabled_idx
  ON public.devices (dvr_server_id)
  WHERE is_enabled = true;

-- Keep statistics fresher on write-heavy tables without waiting for defaults
-- based on large scale factors.
ALTER TABLE public.device_archive_segments SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE public.camera_events SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE public.device_archive_sync_state SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

VACUUM (ANALYZE) public.device_archive_segments;
VACUUM (ANALYZE) public.camera_events;
VACUUM (ANALYZE) public.device_archive_sync_state;
VACUUM (ANALYZE) public.cameras;
VACUUM (ANALYZE) public.devices;
VACUUM (ANALYZE) public.dvr_servers;

