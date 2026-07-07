\set ON_ERROR_STOP on

select now() as checked_at;

select relname, n_live_tup, n_dead_tup, seq_scan, idx_scan,
       autovacuum_count, autoanalyze_count
from pg_stat_user_tables
where relname in (
  'device_archive_segments',
  'camera_events',
  'device_archive_sync_state',
  'cameras',
  'devices',
  'dvr_servers'
)
order by relname;

select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'device_archive_segments',
    'camera_events',
    'cameras',
    'devices',
    'dvr_servers'
  )
order by tablename, indexname;

select count(*) as device_archive_segments,
       min(start_at) as first_segment,
       max(end_at) as last_segment
from public.device_archive_segments;

select event_type, event_state, count(*) as events_24h, max(occurred_at) as last_event
from public.camera_events
where occurred_at > now() - interval '24 hours'
group by event_type, event_state
order by events_24h desc
limit 20;

