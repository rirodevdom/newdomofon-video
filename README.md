# NewDomofon Video Optimization Phase 1 Index Cleanup

The first phase can create duplicate indexes on databases that already have the
same hot-path indexes under migration names. This cleanup drops only those
duplicates and keeps `device_archive_segments_seen_idx`.

```bash
cd /root
tar -xzf newdomofon-video-optimization-phase1-index-cleanup-20260702-003.tar.gz -C /opt/newdomofon-video

bash /opt/newdomofon-video/tools/run-master-db-drop-duplicate-phase1-indexes.sh \
  | tee /root/newdomofon-video-master-db-index-cleanup-$(date +%Y%m%d-%H%M%S).txt
```

