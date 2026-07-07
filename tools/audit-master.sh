#!/usr/bin/env bash
set -uo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
HOST="$(hostname -f 2>/dev/null || hostname)"
OUT="/root/newdomofon-video-master-audit-${HOST}-${TS}.txt"

section() {
  printf '\n\n===== %s =====\n' "$1" | tee -a "$OUT"
}

run() {
  printf '\n$ %s\n' "$*" | tee -a "$OUT"
  bash -lc "$*" >>"$OUT" 2>&1 || true
}

redact_file() {
  local file="$1"
  if [ -f "$file" ]; then
    sed -E \
      -e 's#(postgres://[^:]+:)[^@]+#\1***#g' \
      -e 's#(PASSWORD|TOKEN|SECRET|KEY)=.*#\1=***#Ig' \
      "$file" >>"$OUT" 2>&1 || true
  fi
}

: >"$OUT"

section "AUDIT INFO"
run "date -Is"
run "hostname -f || hostname"
run "uname -a"
run "uptime"
run "whoami"

section "SYSTEM RESOURCES"
run "free -h"
run "df -hT"
run "df -ih"
run "ss -s"
run "ps -eo pid,ppid,stat,pcpu,pmem,etime,cmd --sort=-pcpu | head -40"

section "VERSIONS"
run "node -v"
run "npm -v"
run "psql --version"
run "nginx -v"

section "ENV REDACTED"
redact_file /etc/newdomofon-video/app.env

section "SYSTEMD"
run "systemctl status newdomofon-video-backend --no-pager -l"
run "systemctl status newdomofon-video-dvr --no-pager -l"
run "systemctl is-enabled newdomofon-video-dvr"

section "HTTP HEALTH"
run "curl -sS -i http://127.0.0.1:3000/api/health | head -40"
run "curl -sS -o /dev/null -w 'backend_health_http_code=%{http_code} total=%{time_total} connect=%{time_connect} starttransfer=%{time_starttransfer}\\n' http://127.0.0.1:3000/api/health"

section "NGINX"
run "nginx -t"
run "nginx -T 2>/dev/null | grep -nE 'server_name|listen|location /api|location /cameras|location /device-archive|proxy_pass|client_max_body_size|proxy_read_timeout|sendfile|gzip|stub_status' | head -300"

section "RECENT BACKEND LOGS"
run "journalctl -u newdomofon-video-backend -n 500 --no-pager"
run "journalctl -u newdomofon-video-backend -n 1000 --no-pager | grep -Ei ' 5[0-9][0-9] | 4[0-9][0-9] |error|failed|timeout|slow|archive|player|onvif|hikvision' | tail -250"

section "DATABASE"
if [ -f /etc/newdomofon-video/app.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/newdomofon-video/app.env
  set +a
fi

if [ -n "${DATABASE_URL:-}" ]; then
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select current_database() as db, current_user as db_user, now() as now, version();\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select extname, extversion from pg_extension order by extname;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select relname, n_live_tup, n_dead_tup, seq_scan, idx_scan, vacuum_count, autovacuum_count, analyze_count, autoanalyze_count from pg_stat_user_tables order by n_live_tup desc;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select relname as table, pg_size_pretty(pg_total_relation_size(relid)) as total, pg_size_pretty(pg_relation_size(relid)) as heap, pg_size_pretty(pg_indexes_size(relid)) as indexes from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 30;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select schemaname, tablename, indexname, pg_size_pretty(pg_relation_size(indexrelid)) as size, idx_scan from pg_stat_user_indexes order by pg_relation_size(indexrelid) desc limit 40;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, temp_files, temp_bytes, deadlocks from pg_stat_database where datname = current_database();\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select pid, state, wait_event_type, wait_event, now() - query_start as age, left(query, 240) as query from pg_stat_activity where datname = current_database() order by query_start nulls last limit 40;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select id, name, status, last_seen_at, now() - last_seen_at as heartbeat_age from dvr_servers order by last_seen_at desc nulls last;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select connection_type, archive_storage, status, count(*) from devices group by connection_type, archive_storage, status order by connection_type, archive_storage, status;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select archive_storage, is_enabled, count(*) from cameras group by archive_storage, is_enabled order by archive_storage, is_enabled;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select d.name as node, count(c.*) as cameras from cameras c left join dvr_servers d on d.id = coalesce(c.dvr_server_id, (select d2.dvr_server_id from devices d2 where d2.id=c.device_id)) group by d.name order by cameras desc nulls last;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select event_type, event_state, count(*) as events_24h, max(occurred_at) as last_event from camera_events where occurred_at > now() - interval '24 hours' group by event_type, event_state order by events_24h desc limit 30;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select count(*) as device_archive_segments, min(start_at) as first_segment, max(end_at) as last_segment from device_archive_segments;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select camera_id, count(*) as segments, min(start_at), max(end_at), max(updated_at) from device_archive_segments group by camera_id order by segments desc limit 30;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select camera_id, last_finished_at, last_items, last_error from device_archive_sync_state order by updated_at desc limit 30;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select to_regclass('public.pg_stat_statements') as pg_stat_statements_view;\""
  run "psql \"\$DATABASE_URL\" -P pager=off -c \"select calls, round(total_exec_time::numeric,2) as total_ms, round(mean_exec_time::numeric,2) as mean_ms, rows, left(query, 220) as query from pg_stat_statements order by total_exec_time desc limit 20;\""
else
  echo "DATABASE_URL is not set" >>"$OUT"
fi

section "DONE"
echo "$OUT"
