#!/usr/bin/env bash
set -euo pipefail

echo "===== NODE HOTPATH SNAPSHOT ====="
date -Is
hostname -f 2>/dev/null || hostname

echo
echo "===== DISK ====="
df -hT /
du -h --max-depth=1 /var/lib/newdomofon-video/dvr 2>/dev/null | sort -h | tail -40 || true

echo
echo "===== CPU / FFMPEG ====="
ps -eo pid,ppid,stat,pcpu,pmem,etime,cmd --sort=-pcpu | head -40
pgrep -a ffmpeg || true

echo
echo "===== DVR HEALTH ====="
curl -sS -o /dev/null -w 'dvr_health_http_code=%{http_code} total=%{time_total} connect=%{time_connect} starttransfer=%{time_starttransfer}\n' http://127.0.0.1:3010/health || true
curl -sS http://127.0.0.1:3010/recorders | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log(JSON.stringify({count:j.items?.length, recording:j.items?.filter(i=>i.recording).length, failed:j.items?.filter(i=>!i.recording).map(i=>({stream:i.stream_name,error:i.error})).slice(0,30)},null,2));}catch(e){console.error(e.message);}});" || true

echo
echo "===== RECENT ZERO / PLACEHOLDER SEGMENTS ====="
find /var/lib/newdomofon-video/dvr -type f -name '*.ts' -size 0 -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' 2>/dev/null | sort | tail -50 || true
find /var/lib/newdomofon-video/dvr -type f -name '*.placeholder' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' 2>/dev/null | sort | tail -50 || true

echo
echo "===== LOG HOTSPOTS ====="
journalctl -u newdomofon-video-dvr -n 600 --no-pager | grep -Ei 'archive-placeholder|archive\.m3u8|device-archive|playlist clamped|zero|empty|ffmpeg|failed|error|timeout|killed|exited|onvif|hikvision' | tail -250 || true

