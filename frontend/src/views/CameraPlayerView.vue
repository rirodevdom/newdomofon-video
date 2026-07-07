<template>
  <div class="camera-player-page">
    <div class="camera-player-toolbar">
      <button class="back-btn" type="button" @click="goBack" aria-label="Назад">
        ‹
      </button>

      <div class="camera-title">
        <div class="camera-name">{{ cameraTitle }}</div>
        <div class="camera-subtitle">
          <span>{{ streamName || 'stream_name не найден' }}</span>
          <span v-if="cameraId"> · {{ cameraId }}</span>
          <span> · safe DVR player v52</span>
        </div>
      </div>

      <div class="camera-actions">
        <button class="action-btn" type="button" @click="reloadFrame">
          Обновить
        </button>
        <button class="action-btn" type="button" @click="openEmbedStandalone" :disabled="!iframeSrc">
          Открыть отдельно
        </button>
        <button class="action-btn danger" type="button" @click="goBack">
          К камерам
        </button>
      </div>
    </div>

    <div v-if="error" class="camera-error">
      <strong>Плеер камеры не загружен.</strong>
      <span>{{ error }}</span>
      <button class="action-btn" type="button" @click="loadCamera">Повторить</button>
    </div>

    <div v-else class="camera-frame-wrap">
      <iframe
        v-if="iframeSrc"
        :key="iframeKey"
        class="camera-frame"
        title="NewDomofon DVR Player"
        :src="iframeSrc"
        allowfullscreen
      />

      <div v-else class="camera-loading">
        Загрузка камеры...
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type CameraRow = {
  id?: string
  name?: string
  stream_name?: string
  source_url?: string
  is_enabled?: boolean
  [key: string]: unknown
}

const CAMERA_STREAM_MAP: Record<string, string> = {
  "c64d1003-ed14-459d-a1ba-df784780eea2": "test",
  "507cd414-9937-4817-9d00-0ce9d5da8d04": "cam_10_130_13_16",
  "c41c8342-574f-4b35-a77e-ffd098954134": "cam_10_130_1_135",
  "f0486587-8a79-4cc2-b257-0671f874c08b": "cam_10_130_1_219"
}

const RESTREAM_TOKEN =
  import.meta.env.VITE_RESTREAM_PUBLIC_TOKEN ||
  import.meta.env.VITE_PUBLIC_RESTREAM_TOKEN ||
  ''

const PLAYER_VERSION = 'v52-20260527-150536'

const route = useRoute()
const router = useRouter()

const camera = ref<CameraRow | null>(null)
const streamName = ref('')
const error = ref('')
const loading = ref(false)
const frameNonce = ref(0)
const abortController = ref<AbortController | null>(null)

const cameraId = computed(() => String(route.params.id || route.params.cameraId || route.query.camera_id || ''))

const cameraTitle = computed(() => {
  const name = camera.value?.name
  if (typeof name === 'string' && name.trim()) return name
  if (streamName.value) return 'Камера ' + streamName.value.replace(/^cam_/, '').replaceAll('_', '.')
  return 'Камера'
})

const iframeKey = computed(() => `${cameraId.value}:${streamName.value}:${frameNonce.value}`)

const iframeSrc = computed(() => {
  if (!streamName.value || !RESTREAM_TOKEN) return ''

  const params = new URLSearchParams()
  params.set('token', RESTREAM_TOKEN)
  params.set('autoplay', 'false')
  params.set('dvr', 'true')
  params.set('proto', 'hls')
  params.set('camera_id', cameraId.value)
  params.set('deploy', PLAYER_VERSION)

  return `/${encodeURIComponent(streamName.value)}/embed.html?${params.toString()}`
})

function authHeaders(): HeadersInit {
  const keys = [
    'token',
    'authToken',
    'access_token',
    'accessToken',
    'jwt',
    'adminToken',
    'newdomofon_token',
  ]

  for (const key of keys) {
    const value = localStorage.getItem(key) || sessionStorage.getItem(key)

    if (value) {
      const clean = value.replace(/^Bearer\s+/i, '')
      return { Authorization: `Bearer ${clean}` }
    }
  }

  return {}
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...authHeaders(),
    },
    credentials: 'include',
    cache: 'no-store',
    signal,
  })

  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`)
  }

  return await res.json()
}

function normalizeCameraPayload(payload: unknown): CameraRow | null {
  if (!payload || typeof payload !== 'object') return null

  const obj = payload as Record<string, unknown>

  if (obj.camera && typeof obj.camera === 'object') return obj.camera as CameraRow
  if (obj.item && typeof obj.item === 'object') return obj.item as CameraRow
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) return obj.data as CameraRow

  if (typeof obj.id === 'string' || typeof obj.stream_name === 'string') return obj as CameraRow

  return null
}

function normalizeCameraList(payload: unknown): CameraRow[] {
  if (Array.isArray(payload)) return payload as CameraRow[]

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>

    for (const key of ['items', 'cameras', 'data', 'rows']) {
      const value = obj[key]
      if (Array.isArray(value)) return value as CameraRow[]
    }
  }

  return []
}

async function findCameraByApi(id: string, signal: AbortSignal): Promise<CameraRow | null> {
  const directUrls = [
    `/api/cameras/${encodeURIComponent(id)}`,
    `/api/camera/${encodeURIComponent(id)}`,
  ]

  for (const url of directUrls) {
    try {
      const payload = await fetchJson(url, signal)
      const row = normalizeCameraPayload(payload)
      if (row) return row
    } catch {
      // Fallback to list endpoint.
    }
  }

  const listUrls = ['/api/cameras', '/api/camera']

  for (const url of listUrls) {
    try {
      const payload = await fetchJson(url, signal)
      const rows = normalizeCameraList(payload)
      const row = rows.find((item) => String(item.id || '') === id)
      if (row) return row
    } catch {
      // Continue fallback.
    }
  }

  return null
}

function streamFromFallback(id: string, row: CameraRow | null): string {
  const fromRow = row?.stream_name

  if (typeof fromRow === 'string' && fromRow.trim()) return fromRow.trim()

  const fromMap = CAMERA_STREAM_MAP[id]
  if (typeof fromMap === 'string' && fromMap.trim()) return fromMap.trim()

  // If the route itself is already a stream_name, allow it.
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id
  }

  return ''
}

function stopAnyOldVideos(): void {
  document.querySelectorAll('video').forEach((video) => {
    try {
      video.pause()
      video.removeAttribute('src')
      ;(video as HTMLVideoElement).srcObject = null
      video.load()
    } catch {
      // Best effort only.
    }
  })
}

async function loadCamera(): Promise<void> {
  const id = cameraId.value

  error.value = ''
  camera.value = null
  streamName.value = ''

  if (!id) {
    error.value = 'Не передан id камеры в маршруте.'
    return
  }

  abortController.value?.abort()
  const controller = new AbortController()
  abortController.value = controller

  loading.value = true

  try {
    stopAnyOldVideos()

    const row = await findCameraByApi(id, controller.signal)
    camera.value = row

    const stream = streamFromFallback(id, row)

    if (!stream) {
      error.value = `Для камеры ${id} не найден stream_name. Проверь /etc/newdomofon-video/camera-stream-map.json.`
      return
    }

    streamName.value = stream
    frameNonce.value += 1
  } catch (err) {
    if (controller.signal.aborted) return

    const stream = streamFromFallback(id, null)

    if (stream) {
      streamName.value = stream
      frameNonce.value += 1
      return
    }

    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

function reloadFrame(): void {
  stopAnyOldVideos()
  frameNonce.value += 1
}

function openEmbedStandalone(): void {
  if (!iframeSrc.value) return
  window.open(iframeSrc.value, '_blank', 'noopener,noreferrer')
}

function goBack(): void {
  router.push('/cameras')
}

watch(
  () => cameraId.value,
  () => {
    void loadCamera()
  },
)

onMounted(() => {
  stopAnyOldVideos()
  void loadCamera()
})

onBeforeUnmount(() => {
  abortController.value?.abort()
  stopAnyOldVideos()
})
</script>

<style scoped>
.camera-player-page {
  width: 100%;
  min-height: calc(100vh - 72px);
  height: calc(100vh - 72px);
  display: grid;
  grid-template-rows: 64px minmax(0, 1fr);
  background: #05070b;
  color: #f8fafc;
  overflow: hidden;
}

.camera-player-toolbar {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: #111820;
  border-bottom: 1px solid #2b3847;
}

.back-btn {
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 10px;
  background: #1f2937;
  color: #ffffff;
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
}

.back-btn:hover {
  background: #334155;
}

.camera-title {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.camera-name {
  font-size: 17px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.camera-subtitle {
  font-size: 12px;
  color: #9aa9b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.camera-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  height: 36px;
  border: 0;
  border-radius: 10px;
  padding: 0 12px;
  color: #f8fafc;
  background: #1f2937;
  cursor: pointer;
}

.action-btn:hover:not(:disabled) {
  background: #334155;
}

.action-btn:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.action-btn.danger {
  background: #3f1d1d;
  color: #fee2e2;
}

.camera-frame-wrap {
  min-height: 0;
  background: #000;
}

.camera-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
}

.camera-loading,
.camera-error {
  min-height: 280px;
  height: 100%;
  display: grid;
  place-content: center;
  gap: 12px;
  text-align: center;
  background: #05070b;
  color: #f8fafc;
  padding: 24px;
}

.camera-error {
  border: 1px solid #7f1d1d;
  background: #18080b;
}

.camera-error span {
  color: #fecaca;
  max-width: 760px;
}

@media (max-width: 900px) {
  .camera-player-page {
    height: calc(100vh - 56px);
    min-height: calc(100vh - 56px);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .camera-player-toolbar {
    height: auto;
    min-height: 58px;
    flex-wrap: wrap;
    padding: 10px;
  }

  .camera-actions {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
