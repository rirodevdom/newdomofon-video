<template>
  <v-container fluid class="pa-6 player-page">
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <div>
        <h1 class="text-h4">{{ camera?.name || 'Камера' }}</h1>
        <div class="text-medium-emphasis">
          {{ camera?.stream_name || 'stream_name не загружен' }}
          <span v-if="camera?.dvr_server_name"> · {{ camera.dvr_server_name }}</span>
        </div>
      </div>
      <v-spacer />
      <v-btn prepend-icon="mdi-refresh" :loading="loading" @click="reloadPlayer">Обновить</v-btn>
      <v-btn variant="tonal" to="/cameras">К камерам</v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-row>
      <v-col cols="12" lg="9">
        <v-card class="player-card">
          <div ref="playerRoot" class="player-kit-host">
            <div v-if="loading" class="player-loading">Загрузка плеера...</div>
          </div>
          <div v-if="archivePreparing" class="archive-preparing">
            <v-progress-circular indeterminate color="primary" />
            <span>Готовим архивный фрагмент...</span>
          </div>
        </v-card>
      </v-col>

      <v-col cols="12" lg="3">
        <v-card class="mb-4">
          <v-card-title>Статус</v-card-title>
          <v-card-text>
            <v-chip :color="status?.recording ? 'success' : 'error'">
              {{ status?.recording ? 'recording' : 'offline' }}
            </v-chip>
            <pre class="mt-4 status-json">{{ status }}</pre>
          </v-card-text>
        </v-card>

        <v-card v-if="archiveSourceItems.length > 1" class="mb-4">
          <v-card-title>Источник архива</v-card-title>
          <v-card-text>
            <v-select
              v-model="archiveSource"
              :items="archiveSourceItems"
              item-title="title"
              item-value="value"
              label="Смотреть архив"
              density="compact"
              variant="outlined"
              :disabled="loading || archivePreparing"
              hide-details
            />
          </v-card-text>
        </v-card>

        <v-card>
          <v-card-title>Технические данные</v-card-title>
          <v-card-text>
            <div class="mb-2"><strong>Stream:</strong> {{ camera?.stream_name || '—' }}</div>
            <div class="mb-2"><strong>Node:</strong> {{ camera?.dvr_server_name || '—' }}</div>
            <div class="mb-2"><strong>Архив:</strong> {{ camera?.retention_days || '—' }} дней</div>
            <div class="mb-2"><strong>Хранение:</strong> {{ archiveStorageLabel }}</div>
            <div class="mb-2"><strong>Источник:</strong> {{ archiveSourceLabel }}</div>
            <div class="mb-2"><strong>Live:</strong> <code>{{ tokenlessLiveUrl }}</code></div>
            <div><strong>Archive:</strong> <code>{{ tokenlessArchiveUrl }}</code></div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

type PlayerKitInstance = {
  mount(): Promise<void>;
  destroy(): void;
};

type PlayerKitWindow = Window & {
  NewDomofonPlayer?: {
    create(config: Record<string, unknown>): PlayerKitInstance;
    createNewDomofonPlayer?: (config: Record<string, unknown>) => PlayerKitInstance;
  };
};

const PLAYER_KIT_SCRIPT = '/player-kit/newdomofon-player.iife.js';
const PLAYER_KIT_SHIM = '/player-kit/newdomofon-player-global-shim.js';
const PLAYER_KIT_CSS = '/player-kit/newdomofon-player.css';

const route = useRoute();
const camera = ref<any>(null);
const status = ref<any>(null);
const error = ref('');
const loading = ref(false);
const archivePreparing = ref(false);
const playerRoot = ref<HTMLElement | null>(null);
let player: PlayerKitInstance | null = null;
let latestArchiveRanges: Array<{ startMs: number; endMs: number }> = [];
let latestArchiveRangesLoadedAt = 0;
let latestArchiveRangesKey = '';
let assetsPromise: Promise<void> | null = null;
let archiveBuildLock: Promise<string> | null = null;
const DEVICE_ARCHIVE_MIN_PLAY_SECONDS = 30;
const NODE_ARCHIVE_MIN_PLAY_SECONDS = 60;
const NODE_ARCHIVE_MAX_PLAY_SECONDS = 10 * 60;
const ARCHIVE_SEEK_PREROLL_SECONDS = 12;
const ARCHIVE_LIVE_EDGE_FALLBACK_SECONDS = 180;

type ArchiveStorage = 'node' | 'device' | 'both';
type ArchiveSource = 'auto' | 'node' | 'device';

const cameraId = computed(() => String(route.params.id || ''));
const tokenlessLiveUrl = computed(() => camera.value?.stream_name ? `/cameras/${camera.value.stream_name}/live.m3u8` : '—');
const tokenlessArchiveUrl = computed(() => camera.value?.stream_name ? `/cameras/${camera.value.stream_name}/archive.m3u8` : '—');
const archiveSource = ref<ArchiveSource>('auto');
const archiveStorage = computed<ArchiveStorage>(() => {
  const deviceStorage = normalizeArchiveStorage(camera.value?.device_archive_storage);
  if (deviceStorage === 'both') return 'both';
  return normalizeArchiveStorage(camera.value?.archive_storage || camera.value?.device_archive_storage);
});
const archiveSourceItems = computed(() => {
  if (archiveStorage.value === 'both') {
    return [
      { title: 'Авто (сначала Node)', value: 'auto' },
      { title: 'Node', value: 'node' },
      { title: 'Устройство', value: 'device' }
    ];
  }
  if (archiveStorage.value === 'device') return [{ title: 'Устройство', value: 'device' }];
  return [{ title: 'Node', value: 'node' }];
});
const archiveStorageLabel = computed(() => {
  if (archiveStorage.value === 'both') return 'Node + устройство';
  if (archiveStorage.value === 'device') return 'Устройство';
  return 'Node';
});
const archiveSourceLabel = computed(() => archiveSourceItems.value.find((item) => item.value === archiveSource.value)?.title || archiveSource.value);

function normalizeArchiveStorage(raw: unknown): ArchiveStorage {
  return raw === 'device' || raw === 'both' ? raw : 'node';
}

function defaultArchiveSourceForStorage(storage: ArchiveStorage): ArchiveSource {
  if (storage === 'both') return 'auto';
  return storage;
}

function isArchiveSourceAllowed(storage: ArchiveStorage, source: ArchiveSource) {
  if (storage === 'both') return true;
  return source === storage;
}

function syncArchiveSourceWithCamera() {
  const storage = archiveStorage.value;
  if (!isArchiveSourceAllowed(storage, archiveSource.value)) {
    archiveSource.value = defaultArchiveSourceForStorage(storage);
  }
}

function normalizeTimelineEventState(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }

  const value = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'active', 'motion', 'detected', 'start', 'started'].includes(value)) return true;
  if (['false', '0', 'no', 'off', 'inactive', 'clear', 'idle', 'none', 'end', 'ended'].includes(value)) return false;
  return null;
}

function normalizePlayerKitSdk(candidate: any) {
  if (!candidate) return null;
  if (typeof candidate.create === 'function') return candidate;
  if (typeof candidate.createNewDomofonPlayer === 'function') {
    return {
      ...candidate,
      create: candidate.createNewDomofonPlayer
    };
  }
  return null;
}

function currentPlayerKitSdk() {
  const win = window as PlayerKitWindow & Record<string, any>;
  const sdk = normalizePlayerKitSdk(win.NewDomofonPlayer) || normalizePlayerKitSdk((globalThis as Record<string, any>).NewDomofonPlayer);
  if (sdk) win.NewDomofonPlayer = sdk;
  return sdk;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing?.dataset.loaded === 'true') return resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не удалось загрузить ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(script);
  });
}

async function waitForPlayerKitSdk(timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const sdk = currentPlayerKitSdk();
    if (sdk?.create) return sdk;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return currentPlayerKitSdk();
}

async function ensurePlayerKitAssets(): Promise<void> {
  if (currentPlayerKitSdk()?.create) return;
  if (assetsPromise) return assetsPromise;

  assetsPromise = (async () => {
    if (!document.querySelector(`link[href="${PLAYER_KIT_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = PLAYER_KIT_CSS;
      document.head.appendChild(link);
    }

    await loadScript(PLAYER_KIT_SCRIPT);
    await loadScript(PLAYER_KIT_SHIM);

    const sdk = await waitForPlayerKitSdk();
    if (!sdk?.create) {
      throw new Error('Player kit загружен, но глобальный SDK не найден. Проверьте /player-kit/newdomofon-player.iife.js и browser console на SyntaxError.');
    }
  })();

  return assetsPromise;
}

function destroyPlayer() {
  archivePreparing.value = false;
  archiveBuildLock = null;
  player?.destroy();
  player = null;
  if (playerRoot.value) playerRoot.value.innerHTML = '';
}

async function loadCamera() {
  const { data } = await api.get(`/cameras/${encodeURIComponent(cameraId.value)}`);
  camera.value = data.item;
  syncArchiveSourceWithCamera();
}

async function loadStatus() {
  try {
    const { data } = await api.get(`/player/${encodeURIComponent(cameraId.value)}/status`);
    status.value = data;
  } catch (err: any) {
    status.value = { recording: false, error: err.response?.data?.error || err.message };
  }
}

async function createPlayer() {
  if (!playerRoot.value || !camera.value?.stream_name) return;
  await ensurePlayerKitAssets();

  const sdk = currentPlayerKitSdk();
  if (!sdk?.create) throw new Error('Player kit не зарегистрировался в window.NewDomofonPlayer');

  const id = cameraId.value;
  const streamName = camera.value.stream_name;
  const title = camera.value.name || streamName;
  const currentArchiveStorage = archiveStorage.value;
  const loadArchiveRanges = async (force = false) => {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - Math.max(1, Number(camera.value?.retention_days || 1)) * 24 * 3600 * 1000).toISOString();
    const rangesKey = `${archiveSource.value}|${start.slice(0, 13)}|${end.slice(0, 13)}`;
    if (!force && latestArchiveRanges.length && latestArchiveRangesKey === rangesKey && Date.now() - latestArchiveRangesLoadedAt < 15_000) {
      return latestArchiveRanges;
    }
    const ranges = await api.get(`/player/${encodeURIComponent(id)}/archive/ranges`, { params: { start, end, source: archiveSource.value } });
    latestArchiveRanges = (ranges.data.items || []).map((item: any) => ({
      startMs: new Date(item.start).getTime(),
      endMs: new Date(item.end).getTime()
    })).filter((item: any) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs);
    latestArchiveRangesLoadedAt = Date.now();
    latestArchiveRangesKey = rangesKey;
    return latestArchiveRanges;
  };

  const initialRanges = await loadArchiveRanges(true).catch(() => []);
  destroyPlayer();

  const nextPlayer = sdk.create({
    container: playerRoot.value,
    adapter: 'external',
    theme: 'auto',
    nativeControls: 'auto',
    maxDownloadDurationSec: 3600,
    onError: (err: unknown, context?: string) => {
      error.value = `${context ? `${context}: ` : ''}${err instanceof Error ? err.message : String(err)}`;
    },
    external: {
      bootstrap: async () => {
        const live = await api.get(`/player/${encodeURIComponent(id)}/live`);

        return {
          streamName,
          title,
          live: {
            hlsUrl: live.data.liveHls || live.data.hls_url || live.data.playback_url
          },
          archive: {
            buildUrl: async (fromEpochSec: number, durationSec: number) => {
              if (archiveBuildLock) await archiveBuildLock.catch(() => undefined);

              archivePreparing.value = true;
              const buildPromise = (async () => {
                const requestedWindowStartMs = fromEpochSec * 1000;
                const requestedSeekMs = requestedWindowStartMs + durationSec * 500;
                let effectiveStartMs = requestedSeekMs;
                let matchingRange = latestArchiveRanges.find((range) => range.startMs <= requestedSeekMs && range.endMs > requestedSeekMs);
                const selectedArchiveSource = archiveSource.value;
                const useDeviceArchive = selectedArchiveSource === 'device' || (selectedArchiveSource === 'auto' && currentArchiveStorage !== 'node');
                const minPlayMs = (useDeviceArchive ? DEVICE_ARCHIVE_MIN_PLAY_SECONDS : NODE_ARCHIVE_MIN_PLAY_SECONDS) * 1000;

                if (requestedSeekMs > Date.now() + 60_000) {
                  throw new Error('Выбранное время ещё не записано в архив');
                }

                if (latestArchiveRanges.length && !matchingRange) {
                  const nextRange = latestArchiveRanges.find((range) => range.startMs > requestedSeekMs);
                  const latestRange = latestArchiveRanges[latestArchiveRanges.length - 1];
                  const isLiveEdgeRequest = requestedSeekMs >= Date.now() - ARCHIVE_LIVE_EDGE_FALLBACK_SECONDS * 1000;
                  if (!nextRange && isLiveEdgeRequest && latestRange) {
                    matchingRange = latestRange;
                    effectiveStartMs = Math.max(matchingRange.startMs, matchingRange.endMs - minPlayMs);
                    error.value = '';
                  } else if (!nextRange) {
                    throw new Error('В выбранной точке архива нет');
                  } else {
                    matchingRange = nextRange;
                    effectiveStartMs = matchingRange.startMs;
                    error.value = 'В выбранной точке архива нет, открыт ближайший доступный фрагмент';
                  }
                }
                if (matchingRange && matchingRange.startMs <= requestedSeekMs && matchingRange.endMs > requestedSeekMs) {
                  effectiveStartMs = Math.max(matchingRange.startMs, requestedSeekMs - ARCHIVE_SEEK_PREROLL_SECONDS * 1000);
                }
                if (useDeviceArchive && matchingRange && matchingRange.endMs - effectiveStartMs < minPlayMs && matchingRange.endMs - matchingRange.startMs >= minPlayMs) {
                  effectiveStartMs = Math.max(matchingRange.startMs, matchingRange.endMs - minPlayMs);
                }

                const start = new Date(effectiveStartMs).toISOString();
                const maxAvailableDuration = matchingRange
                  ? Math.max(1, Math.floor((matchingRange.endMs - effectiveStartMs) / 1000))
                  : durationSec;
                const minRequestedDuration = useDeviceArchive ? DEVICE_ARCHIVE_MIN_PLAY_SECONDS : NODE_ARCHIVE_MIN_PLAY_SECONDS;
                const maxRequestedDuration = useDeviceArchive ? 300 : NODE_ARCHIVE_MAX_PLAY_SECONDS;
                const requestedDuration = Math.max(1, Math.min(Math.max(durationSec, minRequestedDuration), maxAvailableDuration, maxRequestedDuration));
                const end = new Date(effectiveStartMs + requestedDuration * 1000).toISOString();
                const archive = await api.get(`/player/${encodeURIComponent(id)}/archive`, {
                  params: { start, end, source: selectedArchiveSource }
                });
                return archive.data.archiveHls || archive.data.hls_url || archive.data.playback_url;
              })();
              archiveBuildLock = buildPromise;

              try {
                return await buildPromise;
              } finally {
                archiveBuildLock = null;
                archivePreparing.value = false;
              }
            },
            ranges: initialRanges,
            loadRanges: async (_signal?: AbortSignal) => {
              return loadArchiveRanges();
            }
          },
          events: {
            load: async (fromMs: number, toMs: number, _signal?: AbortSignal) => {
              const events = await api.get(`/cameras/${encodeURIComponent(id)}/events`, {
                params: { start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() }
              });
              return (events.data.items || []).map((event: any) => {
                const occurredAtMs = new Date(event.occurred_at || event.occurredAt || event.time || event.timestamp).getTime();
                const state = normalizeTimelineEventState(event.IsMotion ?? event.is_motion ?? event.state ?? event.event_state ?? event.motion_state);
                return {
                  id: event.id,
                  occurredAtMs,
                  timeMs: occurredAtMs,
                  type: event.event_type || event.type || event.topic || 'event',
                  title: event.title || event.event_type || event.type || 'Событие',
                  state,
                  data: event.data || event.raw || event,
                  raw: event
                };
              }).filter((event: any) => Number.isFinite(event.occurredAtMs));
            }
          },
          download: {
            start: async (fromMs: number, toMs: number) => {
              const start = new Date(fromMs).toISOString();
              const end = new Date(toMs).toISOString();
              const result = await api.get(`/player/${encodeURIComponent(id)}/export`, { params: { start, end, source: archiveSource.value } });
              const url = result.data.exportMp4 || result.data.url;
              if (url) window.open(url, '_blank', 'noopener,noreferrer');
            }
          },
          capabilities: {
            live: true,
            archive: true,
            events: true,
            archiveGaps: true,
            snapshot: false,
            download: true,
            audio: true,
            speedControl: true,
            dateRangePicker: true
          }
        };
      }
    }
  });

  player = nextPlayer;
  await nextPlayer.mount();
}

async function reloadPlayer() {
  if (!cameraId.value) return;
  loading.value = true;
  error.value = '';
  latestArchiveRanges = [];
  latestArchiveRangesLoadedAt = 0;
  latestArchiveRangesKey = '';

  try {
    destroyPlayer();
    await loadCamera();
    await nextTick();
    await createPlayer();
    await loadStatus();
  } catch (err: any) {
    error.value = err.response?.data?.error || err.message || 'Не удалось запустить плеер';
  } finally {
    loading.value = false;
  }
}

watch(cameraId, () => {
  void reloadPlayer();
});

watch(archiveSource, () => {
  if (!camera.value || loading.value) return;
  void reloadPlayer();
});

onMounted(() => {
  void reloadPlayer();
});

onBeforeUnmount(() => {
  destroyPlayer();
});
</script>

<style scoped>
.player-page {
  min-height: calc(100vh - 64px);
}

.player-card {
  position: relative;
  min-height: 660px;
  background: #05070b;
}

.player-kit-host {
  min-height: 660px;
  height: calc(100vh - 180px);
  background: #05070b;
}

.player-loading {
  min-height: 420px;
  display: grid;
  place-items: center;
  color: #f8fafc;
}

.archive-preparing {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: grid;
  place-content: center;
  gap: 12px;
  color: #f8fafc;
  background: rgba(5, 7, 11, 0.54);
  text-align: center;
  pointer-events: all;
}

.status-json {
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
}

code {
  word-break: break-all;
}
</style>
