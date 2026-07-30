#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one source block, found {count}")
    return text.replace(old, new, 1)


def patch_player_view(path: Path) -> None:
    text = path.read_text(encoding="utf-8")

    text = replace_once(
        text,
        """type PlayerKitInstance = {
  mount(): Promise<void>;
  destroy(): void;
};""",
        """type PlayerKitInstance = {
  mount(): Promise<void>;
  destroy(): void;
  playArchive?(timeMs: number): Promise<void>;
  seekArchiveInCurrentWindow?(timeMs: number): Promise<void>;
};""",
        "player kit archive methods",
    )

    text = replace_once(
        text,
        """const ARCHIVE_SEEK_PREROLL_SECONDS = 12;
const ARCHIVE_LIVE_EDGE_FALLBACK_SECONDS = 180;""",
        """const ARCHIVE_SEEK_PREROLL_SECONDS = 12;
const DEVICE_ARCHIVE_SEEK_STEP_MS = 5_000;
const ARCHIVE_LIVE_EDGE_FALLBACK_SECONDS = 180;""",
        "device archive seek step",
    )

    text = replace_once(
        text,
        """  const currentArchiveStorage = archiveStorage.value;
  const loadArchiveRanges = async (force = false) => {""",
        """  const currentArchiveStorage = archiveStorage.value;
  const selectedArchiveSourceForPlayer = archiveSource.value;
  const forceDeviceArchiveReload = selectedArchiveSourceForPlayer === 'device'
    || (selectedArchiveSourceForPlayer === 'auto' && currentArchiveStorage !== 'node');
  const loadArchiveRanges = async (force = false) => {""",
        "device archive player mode",
    )

    text = replace_once(
        text,
        """                const requestedWindowStartMs = fromEpochSec * 1000;
                const requestedSeekMs = requestedWindowStartMs + durationSec * 500;
                let effectiveStartMs = requestedSeekMs;
                let matchingRange = latestArchiveRanges.find((range) => range.startMs <= requestedSeekMs && range.endMs > requestedSeekMs);
                const selectedArchiveSource = archiveSource.value;
                const useDeviceArchive = selectedArchiveSource === 'device' || (selectedArchiveSource === 'auto' && currentArchiveStorage !== 'node');
                const minPlayMs = (useDeviceArchive ? DEVICE_ARCHIVE_MIN_PLAY_SECONDS : NODE_ARCHIVE_MIN_PLAY_SECONDS) * 1000;""",
        """                const requestedWindowStartMs = fromEpochSec * 1000;
                const selectedArchiveSource = archiveSource.value;
                const useDeviceArchive = selectedArchiveSource === 'device' || (selectedArchiveSource === 'auto' && currentArchiveStorage !== 'node');
                const rawRequestedSeekMs = requestedWindowStartMs + durationSec * 500;
                const requestedSeekMs = useDeviceArchive
                  ? Math.round(rawRequestedSeekMs / DEVICE_ARCHIVE_SEEK_STEP_MS) * DEVICE_ARCHIVE_SEEK_STEP_MS
                  : rawRequestedSeekMs;
                let effectiveStartMs = requestedSeekMs;
                let matchingRange = latestArchiveRanges.find((range) => range.startMs <= requestedSeekMs && range.endMs > requestedSeekMs);
                const minPlayMs = (useDeviceArchive ? DEVICE_ARCHIVE_MIN_PLAY_SECONDS : NODE_ARCHIVE_MIN_PLAY_SECONDS) * 1000;""",
        "snap device archive seek to five seconds",
    )

    text = replace_once(
        text,
        """                if (matchingRange && matchingRange.startMs <= requestedSeekMs && matchingRange.endMs > requestedSeekMs) {
                  effectiveStartMs = Math.max(matchingRange.startMs, requestedSeekMs - ARCHIVE_SEEK_PREROLL_SECONDS * 1000);
                }""",
        """                if (matchingRange && matchingRange.startMs <= requestedSeekMs && matchingRange.endMs > requestedSeekMs) {
                  const seekPrerollSeconds = useDeviceArchive ? 0 : ARCHIVE_SEEK_PREROLL_SECONDS;
                  effectiveStartMs = Math.max(matchingRange.startMs, requestedSeekMs - seekPrerollSeconds * 1000);
                }""",
        "remove device archive preroll",
    )

    text = replace_once(
        text,
        """  player = nextPlayer;
  await nextPlayer.mount();""",
        """  if (forceDeviceArchiveReload && nextPlayer.playArchive) {
    const playArchive = nextPlayer.playArchive.bind(nextPlayer);
    nextPlayer.seekArchiveInCurrentWindow = async (timeMs: number) => {
      const snappedTimeMs = Math.round(timeMs / DEVICE_ARCHIVE_SEEK_STEP_MS) * DEVICE_ARCHIVE_SEEK_STEP_MS;
      await playArchive(snappedTimeMs);
    };
  }

  player = nextPlayer;
  await nextPlayer.mount();""",
        "force exact device archive reload on seek",
    )

    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", default=".")
    args = parser.parse_args()
    root = Path(args.project_dir).resolve()
    patch_player_view(root / "frontend/src/views/PlayerView.vue")
    print("Hikvision archive seek prepared with 5-second precision and zero device preroll")


if __name__ == "__main__":
    main()
