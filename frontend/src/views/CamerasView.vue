<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <h1 class="text-h4">Камеры</h1>
      <v-spacer />
      <v-text-field v-model="search" density="compact" label="Поиск" hide-details style="max-width: 280px" />
      <v-select v-model="statusFilter" :items="statusFilters" density="compact" label="Статус" hide-details style="max-width: 180px" />
      <v-btn v-if="auth.isAdmin" color="primary" prepend-icon="mdi-devices" to="/devices">Добавить через устройство</v-btn>
    </div>

    <v-alert v-if="message" :type="messageType" variant="tonal" class="mb-4" closable @click:close="message = ''">{{ message }}</v-alert>

    <v-card>
      <v-table>
        <thead>
          <tr>
            <th>Название</th>
            <th>Поток</th>
            <th>Протокол</th>
            <th>Устройство</th>
            <th>Node</th>
            <th>Архив</th>
            <th>Архив, дней</th>
            <th>Статус записи</th>
            <th>Live URL</th>
            <th>Archive URL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="camera in filteredCameras" :key="camera.id">
            <td>{{ camera.name }}</td>
            <td><code>{{ camera.stream_name }}</code></td>
            <td><v-chip size="small" :color="cameraProtocolColor(camera)">{{ cameraProtocolTitle(camera) }}</v-chip></td>
            <td>{{ camera.device_name || '—' }}</td>
            <td>{{ camera.dvr_server_name || '—' }}</td>
            <td>{{ archiveStorageTitle(camera.archive_storage) }}</td>
            <td>{{ camera.retention_days }}</td>
            <td><v-chip size="small" :color="cameraStatusColor(camera)">{{ cameraStatus(camera) }}</v-chip></td>
            <td><code>{{ liveUrl(camera) }}</code></td>
            <td><code>{{ archiveUrl(camera) }}</code></td>
            <td class="text-right">
              <v-btn size="small" color="primary" variant="tonal" :to="`/cameras/${camera.id}`">Просмотр</v-btn>
              <v-btn v-if="auth.isAdmin" size="small" variant="tonal" class="ml-2" @click="openEdit(camera)">Редактировать</v-btn>
            </td>
          </tr>
          <tr v-if="!filteredCameras.length">
            <td colspan="11" class="text-center text-medium-emphasis py-6">Камеры не найдены</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="dialog" max-width="880">
      <v-card>
        <v-card-title>{{ editingId ? 'Редактирование камеры' : 'Новая камера' }}</v-card-title>
        <v-card-text>
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">
            Камера является каналом выбранного устройства. Для ONVIF укажите только доступ к устройству: RTSP URI, profile token и XAddr будут получены автоматически при сохранении.
          </v-alert>
          <v-row>
            <v-col cols="12" md="6"><v-text-field v-model="form.name" label="Название" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.stream_name" label="Stream name" /></v-col>
            <v-col cols="12" md="6">
              <v-select v-model="form.protocol" :items="protocolItems" label="Протокол подключения" />
            </v-col>
            <v-col cols="12" md="6">
              <v-select
                v-model="form.device_id"
                :items="devices"
                item-title="name"
                item-value="id"
                label="Устройство"
                :readonly="Boolean(route.query.device_id && !editingId)"
                @update:model-value="applyDeviceDefaults"
              />
            </v-col>
            <v-col cols="12" md="6"><v-select v-model="form.dvr_server_id" :items="nodes" item-title="name" item-value="id" label="Node" clearable /></v-col>
            <v-col cols="12" md="6"><v-select v-model="form.archive_storage" :items="archiveStorageItems" label="Где хранится архив" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model.number="form.retention_days" label="Архив, дней" type="number" /></v-col>
            <v-col cols="12" md="6"><v-switch v-model="form.is_enabled" color="primary" label="Включена" /></v-col>
            <template v-if="form.protocol === 'RTSP'">
              <v-col cols="12">
                <v-text-field v-model="form.source_url" label="RTSP URL" placeholder="rtsp://user:password@host:554/path" />
              </v-col>
            </template>
            <template v-else>
              <v-col cols="12" md="6"><v-text-field v-model="form.onvif_host" label="ONVIF Host/IP" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model.number="form.onvif_port" label="ONVIF Port" type="number" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="form.onvif_username" label="ONVIF Login" autocomplete="off" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="form.onvif_password" label="ONVIF Password" type="password" autocomplete="new-password" /></v-col>
              <v-col cols="12">
                <v-alert type="warning" variant="tonal" density="compact">
                  При сохранении камера автоматически получит Profile token, ONVIF XAddr и RTSP stream URI через ONVIF Device Service.
                </v-alert>
              </v-col>
            </template>
            <v-col cols="12" md="6">
              <v-text-field :model-value="previewLiveUrl" label="Live URL без token" readonly />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field :model-value="previewArchiveUrl" label="Archive URL без token" readonly />
            </v-col>
          </v-row>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="tonal" @click="dialog = false">Отмена</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">Сохранить</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const cameras = ref<any[]>([]);
const devices = ref<any[]>([]);
const nodes = ref<any[]>([]);
const search = ref('');
const statusFilter = ref('all');
const statusFilters = ['all', 'recording', 'offline', 'disabled', 'unassigned'];
const message = ref('');
const messageType = ref<'success' | 'error'>('success');
const dialog = ref(false);
const saving = ref(false);
const resolvingOnvif = ref(false);
const editingId = ref<string | null>(null);
const queryCreateHandled = ref(false);
const protocolItems = [
  { title: 'RTSP URL', value: 'RTSP' },
  { title: 'ONVIF', value: 'ONVIF' }
];
const archiveStorageItems = [
  { title: 'На video node', value: 'node' },
  { title: 'На устройстве Hikvision/NVR', value: 'device' },
  { title: 'Node + устройство', value: 'both' }
];

const form = reactive<any>({
  name: '',
  stream_name: '',
  protocol: 'RTSP',
  device_id: null,
  dvr_server_id: null,
  group_id: null,
  source_url: '',
  archive_storage: 'node',
  onvif_host: '',
  onvif_xaddr: '',
  onvif_port: 80,
  onvif_username: '',
  onvif_password: '',
  onvif_profile_token: '',
  onvif_device_info: null,
  onvif_last_sync_at: null,
  retention_days: 7,
  is_enabled: true
});

const previewLiveUrl = computed(() => form.stream_name ? `/cameras/${form.stream_name}/live.m3u8` : '');
const previewArchiveUrl = computed(() => form.stream_name ? `/cameras/${form.stream_name}/archive.m3u8` : '');

const filteredCameras = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return cameras.value.filter((camera) => {
    const status = cameraStatus(camera);
    const statusOk = statusFilter.value === 'all' || status === statusFilter.value;
    const textOk = !needle || [camera.name, camera.stream_name, camera.device_name, camera.dvr_server_name].some((value) => String(value || '').toLowerCase().includes(needle));
    return statusOk && textOk;
  });
});

function liveUrl(camera: any) {
  return `/cameras/${camera.stream_name}/live.m3u8`;
}

function archiveUrl(camera: any) {
  return `/cameras/${camera.stream_name}/archive.m3u8`;
}

function cameraStatus(camera: any) {
  if (!camera.is_enabled) return 'disabled';
  if (!camera.dvr_server_id) return 'unassigned';
  return 'recording';
}

function cameraStatusColor(camera: any) {
  const status = cameraStatus(camera);
  if (status === 'recording') return 'success';
  if (status === 'unassigned') return 'warning';
  return 'error';
}

function cameraProtocolTitle(camera: any) {
  if (camera.device_connection_type === 'HIKVISION') return 'HIKVISION';
  return camera.is_onvif ? 'ONVIF' : 'RTSP';
}

function cameraProtocolColor(camera: any) {
  if (camera.device_connection_type === 'HIKVISION') return 'deep-orange';
  return camera.is_onvif ? 'indigo' : 'blue';
}

function archiveStorageTitle(value: string) {
  if (value === 'device') return 'Устройство';
  if (value === 'both') return 'Node + устройство';
  return 'Node';
}

function notify(text: string, type: 'success' | 'error' = 'success') {
  message.value = text;
  messageType.value = type;
}

function resetForm() {
  Object.assign(form, {
    name: '',
    stream_name: '',
    protocol: 'RTSP',
    device_id: null,
    dvr_server_id: null,
    group_id: null,
    source_url: '',
    archive_storage: 'node',
    onvif_host: '',
    onvif_xaddr: '',
    onvif_port: 80,
    onvif_username: '',
    onvif_password: '',
    onvif_profile_token: '',
    onvif_device_info: null,
    onvif_last_sync_at: null,
    retention_days: 7,
    is_enabled: true
  });
}

function applyDeviceDefaults() {
  const device = devices.value.find((item) => item.id === form.device_id);
  if (!device) return;
  if (!form.dvr_server_id) form.dvr_server_id = device.dvr_server_id;
  form.archive_storage = device.archive_storage || 'node';
  form.protocol = device.connection_type === 'ONVIF' ? 'ONVIF' : 'RTSP';
  if (form.protocol === 'RTSP' && !form.source_url && device.rtsp_url) form.source_url = device.rtsp_url;
  if (form.protocol === 'ONVIF') {
    form.onvif_host = device.host || '';
    form.onvif_port = device.port || 80;
    form.onvif_username = device.username || '';
    if (!form.source_url && device.rtsp_url) form.source_url = device.rtsp_url;
  }
}

function cleanHostFromXaddr(value: string) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/onvif\/device_service.*$/i, '')
    .replace(/:\d+$/i, '')
    .replace(/\/+$/g, '');
}

async function resolveOnvifStream(options: { silent?: boolean } = {}) {
  if (!form.onvif_host) {
    if (!options.silent) notify('Укажите ONVIF Host/IP', 'error');
    return false;
  }

  resolvingOnvif.value = true;
  try {
    const storedHost = cleanHostFromXaddr(form.onvif_xaddr || '');
    const canUseStoredCredentials = editingId.value && !form.onvif_password && storedHost && storedHost === form.onvif_host;
    const requestBody = canUseStoredCredentials
      ? { camera_id: editingId.value }
      : {
          ip: form.onvif_host,
          port: form.onvif_port || 80,
          username: form.onvif_username || undefined,
          password: form.onvif_password || undefined,
          dvr_server_id: form.dvr_server_id || undefined
        };
    const { data } = await api.post('/onvif/stream-uri', requestBody);
    form.source_url = data.streamUri || '';
    form.onvif_xaddr = data.xaddr || '';
    form.onvif_profile_token = data.selectedProfileToken || '';
    form.onvif_device_info = data.information || null;
    form.onvif_last_sync_at = new Date().toISOString();
    if (!options.silent) notify('ONVIF stream URI получен');
    return Boolean(form.source_url);
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'ONVIF подключение не удалось', 'error');
    return false;
  } finally {
    resolvingOnvif.value = false;
  }
}

async function load() {
  const [camerasRes, devicesRes, nodesRes] = await Promise.all([
    api.get('/cameras'),
    api.get('/devices'),
    api.get('/dvr-servers')
  ]);
  cameras.value = camerasRes.data.items;
  devices.value = devicesRes.data.items;
  nodes.value = nodesRes.data.items;
  if (!queryCreateHandled.value && route.query.create === '1' && typeof route.query.device_id === 'string' && !dialog.value && !editingId.value) {
    queryCreateHandled.value = true;
    openCreate();
  }
}

function openCreate() {
  editingId.value = null;
  resetForm();
  const queryDeviceId = typeof route.query.device_id === 'string' ? route.query.device_id : '';
  if (queryDeviceId) {
    form.device_id = queryDeviceId;
    applyDeviceDefaults();
  }
  dialog.value = true;
}

function openEdit(camera: any) {
  editingId.value = camera.id;
  Object.assign(form, {
    name: camera.name,
    stream_name: camera.stream_name,
    protocol: camera.is_onvif ? 'ONVIF' : 'RTSP',
    device_id: camera.device_id,
    dvr_server_id: camera.dvr_server_id,
    group_id: camera.group_id,
    source_url: camera.source_url,
    archive_storage: camera.archive_storage || 'node',
    onvif_host: cleanHostFromXaddr(camera.onvif_xaddr || ''),
    onvif_xaddr: camera.onvif_xaddr || '',
    onvif_port: camera.onvif_port || 80,
    onvif_username: camera.onvif_username || '',
    onvif_password: '',
    onvif_profile_token: camera.onvif_profile_token || '',
    onvif_device_info: camera.onvif_device_info || null,
    onvif_last_sync_at: camera.onvif_last_sync_at || null,
    retention_days: camera.retention_days,
    is_enabled: camera.is_enabled
  });
  dialog.value = true;
}

function buildOnvifXaddr() {
  if (form.onvif_xaddr) return form.onvif_xaddr;
  const host = String(form.onvif_host || '').trim();
  if (!host) return '';
  if (/^https?:\/\//i.test(host)) return host;
  return `http://${host}:${Number(form.onvif_port || 80)}/onvif/device_service`;
}

async function save() {
  saving.value = true;
  try {
    if (!form.device_id) {
      notify('Выберите устройство: камера должна быть каналом устройства', 'error');
      return;
    }
    if (form.protocol === 'ONVIF' && (!editingId.value || !form.source_url || !form.onvif_xaddr || !form.onvif_profile_token)) {
      const resolved = await resolveOnvifStream({ silent: true });
      if (!resolved) return;
    }

    const payload = { ...form };
    delete payload.protocol;
    delete payload.onvif_host;

    if (!payload.group_id) payload.group_id = null;
    if (!payload.dvr_server_id) payload.dvr_server_id = null;
    if (form.protocol === 'RTSP') {
      payload.onvif_xaddr = null;
      payload.onvif_port = null;
      payload.onvif_username = null;
      payload.onvif_password = null;
      payload.onvif_profile_token = null;
      payload.onvif_device_info = null;
      payload.onvif_last_sync_at = null;
    } else {
      payload.onvif_xaddr = buildOnvifXaddr();
      payload.onvif_port = Number(form.onvif_port || 80);
      payload.onvif_username = form.onvif_username || null;
      payload.onvif_profile_token = form.onvif_profile_token || null;
      payload.onvif_device_info = form.onvif_device_info || null;
      payload.onvif_last_sync_at = form.onvif_last_sync_at || null;
      payload._onvif_requery = true;
      if (!payload.source_url) {
        notify('Не удалось автоматически получить RTSP stream URI через ONVIF', 'error');
        return;
      }
      if (!payload.onvif_password) delete payload.onvif_password;
    }
    if (editingId.value) await api.patch(`/cameras/${editingId.value}`, payload);
    else await api.post('/cameras', payload);
    dialog.value = false;
    notify('Камера сохранена');
    await load();
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Ошибка сохранения', 'error');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
