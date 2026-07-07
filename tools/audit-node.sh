#!/usr/bin/env bash
set -uo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
HOST="$(hostname -f 2>/dev/null || hostname)"
OUT="/root/newdomofon-video-node-audit-${HOST}-${TS}.txt"
DVR_ROOT="${DVR_ROOT:-/var/lib/newdomofon-video/dvr}"

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

section "SYSTEM RESOURCES"
run "free -h"
run "df -hT"
run "df -ih"
run "ss -s"
run "ps -eo pid,ppid,stat,pcpu,pmem,etime,cmd --sort=-pcpu | head -80"
run "pgrep -a ffmpeg || true"

section "VERSIONS"
run "node -v"
run "npm -v"
run "ffmpeg -version | head -5"
run "ffprobe -version | head -5"
run "nginx -v"

section "ENV REDACTED"
redact_file /etc/newdomofon-video/app.env

section "SYSTEMD"
run "systemctl status newdomofon-video-dvr --no-pager -l"
run "systemctl status newdomofon-video-backend --no-pager -l"

section "HTTP HEALTH"
run "curl -sS -i http://127.0.0.1:3010/health | head -60"
run "curl -sS -o /dev/null -w 'dvr_health_http_code=%{http_code} total=%{time_total} connect=%{time_connect} starttransfer=%{time_starttransfer}\\n' http://127.0.0.1:3010/health"
run "curl -sS http://127.0.0.1:3010/recorders | node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify({count:j.items?.length, recording:j.items?.filter(i=>i.recording).length, failed:j.items?.filter(i=>!i.recording).map(i=>({stream:i.stream_name,error:i.error})).slice(0,30)},null,2));})\""

section "NGINX NODE"
run "nginx -t"
run "nginx -T 2>/dev/null | grep -nE 'location /health|location /cameras|location /files|location /device-archive|proxy_pass|proxy_read_timeout|sendfile|aio|directio|gzip|stub_status' | head -300"

section "DVR ENGINE LOGS"
run "journalctl -u newdomofon-video-dvr -n 700 --no-pager"
run "journalctl -u newdomofon-video-dvr -n 1500 --no-pager | grep -Ei 'archive-placeholder|archive\\.m3u8|device-archive|playlist clamped|zero|empty|ffmpeg|failed|error|timeout|killed|exited|onvif|hikvision' | tail -400"

section "DVR ROOT"
run "du -h --max-depth=2 \"$DVR_ROOT\" 2>/dev/null | sort -h | tail -80"
run "find \"$DVR_ROOT\" -type f -name '*.ts' -size 0 -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\\n' 2>/dev/null | sort | tail -100"
run "find \"$DVR_ROOT\" -type f -name '*.placeholder' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\\n' 2>/dev/null | sort | tail -100"
run "find \"$DVR_ROOT\" -type f -name 'live.m3u8' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\\n' 2>/dev/null | sort | tail -100"

section "STREAM RECENT SEGMENT SHAPE"
run "for d in \"$DVR_ROOT\"/*; do [ -d \"\$d\" ] || continue; s=\$(basename \"\$d\"); c=\$(find \"\$d\" -type f -name '*.ts' 2>/dev/null | wc -l); last=\$(find \"\$d\" -type f -name '*.ts' -printf '%T@ %TY-%Tm-%Td %TH:%TM:%TS %s %p\\n' 2>/dev/null | sort -n | tail -1); printf '%s segments=%s last=%s\\n' \"\$s\" \"\$c\" \"\$last\"; done | sort"
run "for d in \"$DVR_ROOT\"/*; do [ -d \"\$d\" ] || continue; s=\$(basename \"\$d\"); echo \"--- \$s\"; find \"\$d\" -type f -name '*.ts' -printf '%T@ %TY-%Tm-%Td %TH:%TM:%TS size=%s %p\\n' 2>/dev/null | sort -n | tail -20; done"

section "CODE MARKERS"
run "grep -Rsn \"nodeArchiveTailHoldMs\\|clampNodeArchiveRangeToStableTail\\|archive-placeholder\\|clampSegmentsToContinuousRun\\|playlist clamped\" /opt/newdomofon-video/dvr-engine/src /opt/newdomofon-video/dvr-engine/dist 2>/dev/null | head -200"

section "DONE"
echo "$OUT"
