\set ON_ERROR_STOP on

-- Phase 1 cleanup: these indexes duplicate already existing indexes from
-- migrations under different names. Keeping duplicates increases write cost
-- on hot tables without improving query plans.
--
-- Kept intentionally:
--   device_archive_segments_seen_idx on (last_seen_at)
-- because there was no equivalent index in the audit output.

DROP INDEX CONCURRENTLY IF EXISTS public.camera_events_camera_time_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.camera_events_stream_time_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.device_archive_segments_camera_time_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.device_archive_segments_node_time_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.cameras_dvr_enabled_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.cameras_device_enabled_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.devices_dvr_enabled_idx;

VACUUM (ANALYZE) public.device_archive_segments;
VACUUM (ANALYZE) public.camera_events;
VACUUM (ANALYZE) public.cameras;
VACUUM (ANALYZE) public.devices;

