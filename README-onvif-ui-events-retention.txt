Patch: ONVIF UI simplification + per-camera event retention.

Apply on master:
  cd /opt/newdomofon-video
  node tools/apply-onvif-ui-events-retention.mjs /opt/newdomofon-video

Then rebuild frontend and reload nginx.
Then run scripts/events-retention-cleanup.sh once manually and check output.
