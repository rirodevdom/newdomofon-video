#!/usr/bin/env bash
set -euo pipefail

cd /opt/newdomofon-video/backend
set -a
. /etc/newdomofon-video/app.env
set +a

echo "== Before =="
psql "$DATABASE_URL" -P pager=off -f /opt/newdomofon-video/tools/master-db-hotpath-report.sql

echo "== Applying maintenance =="
psql "$DATABASE_URL" -P pager=off -f /opt/newdomofon-video/tools/master-db-hotpath-maintenance.sql

echo "== After =="
psql "$DATABASE_URL" -P pager=off -f /opt/newdomofon-video/tools/master-db-hotpath-report.sql

