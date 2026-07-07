#!/usr/bin/env bash
set -euo pipefail

cd /opt/newdomofon-video/backend
set -a
. /etc/newdomofon-video/app.env
set +a

echo "== Dropping duplicate phase1 indexes =="
psql "$DATABASE_URL" -P pager=off -f /opt/newdomofon-video/tools/master-db-drop-duplicate-phase1-indexes.sql

echo "== Remaining hot indexes =="
psql "$DATABASE_URL" -P pager=off -c "
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('device_archive_segments', 'camera_events', 'cameras', 'devices')
order by tablename, indexname;
"

