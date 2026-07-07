<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <h1 class="text-h4">Устройства</h1>
      <v-spacer />
      <v-text-field v-model="search" density="compact" label="Поиск" hide-details style="max-width: 280px" />
      <v-select v-model="statusFilter" :items="statusFilters" density="compact" label="Статус" hide-details style="max-width: 180px" />
      <v-btn v-if="auth.isAdmin" color="primary" prepend-icon="mdi-plus" @click="openCreate">Добавить</v-btn>
    </div>

    <v-alert v-if="message" :type="messageType" variant="tonal" class="mb-4" closable @click:close="message = ''">{{ message }}</v-alert>

    <v-card>
      <v-table>
        <thead>
          <tr>
            <th>Название</th>
            <th>Тип</th>
            <th>Архив</th>
            <th>Статус</th>
            <th>Node</th>
            <th>Камер/каналов</th>
            <th>Настройка</th>
            <th>Последняя проверка</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="device in filteredDevices" :key="device.id" :class="{ 'bg-red-lighten-5': !device.is_configured }">
            <td>{{ device.name || '—' }}</td>
            <td>{{ device.connection_type }}</td>
            <td>{{ archiveStorageTitle(device.archive_storage) }}</td>
            <td><v-chip size="small" :color="deviceStatusColor(device.status)">{{ device.status }}</v-chip></td>
            <td>{{ device.node_name || '—' }}</td>
            <td>{{ device.camera_count }}</td>
            <td>
              <v-chip size="small" :color="device.is_configured ? 'success' : 'error'">
                {{ device.is_configured ? 'Настроено' : 'Не донастроено' }}
              </v-chip>
            </td>
            <td>{{ formatDate(device.last_check_at) }}</td>
            <td class="text-right">
              <v-btn size="small" variant="tonal" @click="openView(device)">Смотреть</v-btn>
              <v-btn v-if="auth.isAdmin" size="small" variant="tonal" class="ml-2" @click="openEdit(device)">Редактировать</v-btn>
              <v-btn v-if="auth.user?.role === 'super_admin'" size="small" color="error" variant="tonal" class="ml-2" @click="remove(device)">Удалить</v-btn>
            </td>
          </tr>
          <tr v-if="!filteredDevices.length">
            <td colspan="9" class="text-center text-medium-emphasis py-6">Устройства не найдены</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="formDialog" max-width="860">
      <v-card>
        <v-card-title>{{ editingId ? 'Редактирование устройства' : 'Новое устройство' }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="6"><v-text-field v-model="form.name" label="Название устройства" /></v-col>
            <v-col cols="12" md="3"><v-select v-model="form.connection_type" :items="connectionTypes" label="Тип подключения" /></v-col>
            <v-col cols="12" md="3"><v-select v-model="form.dvr_server_id" :items="nodes" item-title="name" item-value="id" label="Node" clearable /></v-col>
            <v-col cols="12" md="6"><v-select v-model="form.archive_storage" :items="archiveStorageItems" label="Где хранится архив" /></v-col>
            <v-col cols="12" md="6">
              <v-alert type="info" variant="tonal" density="compact">
                Node — архив пишется на video node. Устройство — архив берётся с Hikvision/NVR. Оба — оставляем запись на node и доступ к архиву устройства.
              </v-alert>
            </v-col>
            <v-col v-if="form.connection_type === 'HIKVISION'" cols="12">
              <v-alert type="warning" variant="tonal" density="compact">
                Для Hikvision укажите Host/IP, ISAPI port, login/password. Каналы привязываются камерами автоматически или через RTSP URL вида /Streaming/channels/101.
              </v-alert>
            </v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.host" :label="form.connection_type === 'HIKVISION' ? 'Hikvision Host/IP' : 'Host/IP'" /></v-col>
            <v-col cols="12" md="2"><v-text-field v-model.number="form.port" label="Port" type="number" /></v-col>
            <v-col cols="12" md="4"><v-select v-model="form.status" :items="deviceStatuses" label="Статус" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.username" label="Login" autocomplete="off" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.password" label="Password" type="password" autocomplete="new-password" /></v-col>
            <v-col v-if="form.connection_type !== 'ONVIF'" cols="12"><v-text-field v-model="form.rtsp_url" :label="form.connection_type === 'HIKVISION' ? 'RTSP URL / базовый поток канала' : 'RTSP URL'" /></v-col>
            <v-col cols="12"><v-textarea v-model="form.comment" label="Комментарий" rows="2" /></v-col>
          </v-row>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="tonal" @click="formDialog = false">Отмена</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">Сохранить</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="viewDialog" max-width="920">
      <v-card>
        <v-card-title>Камеры устройства: {{ selectedDevice?.name }}</v-card-title>
        <v-card-text>
          <div class="d-flex justify-end mb-3 flex-wrap ga-2">
            <template v-if="selectedDevice?.connection_type === 'HIKVISION'">
              <v-btn color="deep-orange" variant="tonal" prepend-icon="mdi-magnify" :loading="discoveringChannels" @click="discoverHikvisionChannels('auto')">
                Авто-поиск каналов
              </v-btn>
              <v-text-field v-model.number="manualFirstChannel" density="compact" label="С" type="number" hide-details style="max-width: 90px" />
              <v-text-field v-model.number="manualLastChannel" density="compact" label="По" type="number" hide-details style="max-width: 90px" />
              <v-btn variant="tonal" prepend-icon="mdi-playlist-plus" :loading="discoveringChannels" @click="discoverHikvisionChannels('manual')">
                Найти диапазон
              </v-btn>
            </template>
            <v-btn v-if="auth.isAdmin" color="primary" prepend-icon="mdi-plus" :to="`/cameras?device_id=${selectedDevice?.id}&create=1`">
              Добавить камеру
            </v-btn>
          </div>
          <v-table>
            <thead><tr><th>Название камеры</th><th>Поток</th><th>Статус</th><th>Архив</th><th>Архив, дней</th><th>Node</th><th></th></tr></thead>
            <tbody>
              <tr v-for="camera in deviceCameras" :key="camera.id">
                <td>{{ camera.name }}</td>
                <td>{{ camera.stream_name }}</td>
                <td><v-chip size="small" :color="camera.is_enabled ? 'success' : 'error'">{{ camera.is_enabled ? 'enabled' : 'disabled' }}</v-chip></td>
                <td>{{ archiveStorageTitle(camera.archive_storage) }}</td>
                <td>{{ camera.retention_days }}</td>
                <td>{{ camera.node_name || '—' }}</td>
                <td><v-btn size="small" :to="`/cameras/${camera.id}`">Открыть</v-btn></td>
              </tr>
              <tr v-if="!deviceCameras.length">
                <td colspan="7" class="text-center text-medium-emphasis py-6">Камеры к устройству не привязаны</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn variant="tonal" @click="viewDialog = false">Закрыть</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="channelsDialog" max-width="980">
      <v-card>
        <v-card-title>Найденные каналы: {{ selectedDevice?.name }}</v-card-title>
        <v-card-text>
          <v-alert v-if="!discoveredChannels.length" type="warning" variant="tonal" class="mb-3">
            Каналы не найдены. Проверьте права пользователя Hikvision на ISAPI или используйте ручной диапазон.
          </v-alert>
          <v-table v-else>
            <thead>
              <tr>
                <th>Канал</th>
                <th>Track ID</th>
                <th>Название</th>
                <th>Online</th>
                <th>Источник</th>
                <th>Статус</th>
                <th>RTSP</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="channel in discoveredChannels" :key="channel.track_id">
                <td>{{ channel.channel }}</td>
                <td><code>{{ channel.track_id }}</code></td>
                <td>{{ channel.name }}</td>
                <td>
                  <v-chip size="small" :color="channel.online === true ? 'success' : channel.online === false ? 'error' : 'default'">
                    {{ channel.online === true ? 'online' : channel.online === false ? 'offline' : 'unknown' }}
                  </v-chip>
                </td>
                <td>{{ channel.discovered_by }}</td>
                <td>
                  <v-chip size="small" :color="channel.exists ? 'info' : 'primary'">
                    {{ channel.exists ? 'уже есть' : 'будет создан' }}
                  </v-chip>
                </td>
                <td><code>{{ channel.source_url }}</code></td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="tonal" @click="channelsDialog = false">Закрыть</v-btn>
          <v-btn color="primary" :disabled="!discoveredChannels.some((channel) => !channel.exists)" :loading="syncingChannels" @click="syncHikvisionChannels">
            Создать отсутствующие
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const devices = ref<any[]>([]);
const nodes = ref<any[]>([]);
const deviceCameras = ref<any[]>([]);
const selectedDevice = ref<any | null>(null);
const search = ref('');
const statusFilter = ref('all');
const message = ref('');
const messageType = ref<'success' | 'error'>('success');
const formDialog = ref(false);
const viewDialog = ref(false);
const channelsDialog = ref(false);
const saving = ref(false);
const discoveringChannels = ref(false);
const syncingChannels = ref(false);
const editingId = ref<string | null>(null);
const discoveredChannels = ref<any[]>([]);
const manualFirstChannel = ref(1);
const manualLastChannel = ref(16);
const connectionTypes = ['RTSP', 'ONVIF', 'HIKVISION'];
const deviceStatuses = ['unknown', 'online', 'offline', 'error'];
const statusFilters = ['all', 'online', 'offline', 'error', 'unknown', 'unconfigured'];
const archiveStorageItems = [
  { title: 'На video node', value: 'node' },
  { title: 'На устройстве Hikvision/NVR', value: 'device' },
  { title: 'Node + устройство', value: 'both' }
];

const form = reactive<any>({
  name: '',
  connection_type: 'RTSP',
  archive_storage: 'node',
  dvr_server_id: null,
  host: '',
  port: null,
  username: '',
  password: '',
  rtsp_url: '',
  comment: '',
  status: 'unknown',
  is_enabled: true
});

const filteredDevices = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return devices.value.filter((device) => {
    const statusOk = statusFilter.value === 'all' || (statusFilter.value === 'unconfigured' ? !device.is_configured : device.status === statusFilter.value);
    const textOk = !needle || [device.name, device.connection_type, device.node_name, device.host, device.rtsp_url].some((value) => String(value || '').toLowerCase().includes(needle));
    return statusOk && textOk;
  });
});

function resetForm() {
  Object.assign(form, { name: '', connection_type: 'RTSP', archive_storage: 'node', dvr_server_id: null, host: '', port: null, username: '', password: '', rtsp_url: '', comment: '', status: 'unknown', is_enabled: true });
}

function notify(text: string, type: 'success' | 'error' = 'success') {
  message.value = text;
  messageType.value = type;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function deviceStatusColor(status: string) {
  if (status === 'online') return 'success';
  if (status === 'error') return 'error';
  if (status === 'offline') return 'warning';
  return 'default';
}

function archiveStorageTitle(value: string) {
  if (value === 'device') return 'Устройство';
  if (value === 'both') return 'Node + устройство';
  return 'Node';
}

async function load() {
  devices.value = (await api.get('/devices')).data.items;
  nodes.value = (await api.get('/dvr-servers')).data.items;
}

function openCreate() {
  editingId.value = null;
  resetForm();
  formDialog.value = true;
}

function openEdit(device: any) {
  editingId.value = device.id;
  Object.assign(form, { ...device, password: '' });
  formDialog.value = true;
}

async function openView(device: any) {
  selectedDevice.value = device;
  const { data } = await api.get(`/devices/${device.id}`);
  selectedDevice.value = data.item;
  deviceCameras.value = data.cameras;
  viewDialog.value = true;
}

async function discoverHikvisionChannels(mode: 'auto' | 'manual') {
  if (!selectedDevice.value) return;
  discoveringChannels.value = true;
  try {
    const { data } = await api.post(`/devices/${selectedDevice.value.id}/hikvision/channels/discover`, {
      mode,
      first_channel: manualFirstChannel.value,
      last_channel: manualLastChannel.value
    });
    discoveredChannels.value = data.items || [];
    channelsDialog.value = true;
    notify(discoveredChannels.value.length ? `Найдено каналов: ${discoveredChannels.value.length}` : 'Каналы не найдены', discoveredChannels.value.length ? 'success' : 'error');
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Не удалось найти каналы Hikvision', 'error');
  } finally {
    discoveringChannels.value = false;
  }
}

async function syncHikvisionChannels() {
  if (!selectedDevice.value) return;
  syncingChannels.value = true;
  try {
    const { data } = await api.post(`/devices/${selectedDevice.value.id}/hikvision/channels/sync`, {
      channels: discoveredChannels.value.filter((channel) => !channel.exists)
    });
    notify(`Создано камер: ${data.created?.length || 0}`);
    channelsDialog.value = false;
    await openView(selectedDevice.value);
    await load();
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Не удалось создать камеры по каналам', 'error');
  } finally {
    syncingChannels.value = false;
  }
}

async function save() {
  saving.value = true;
  const payload = { ...form };
  if (!payload.password) delete payload.password;
  try {
    if (editingId.value) await api.patch(`/devices/${editingId.value}`, payload);
    else await api.post('/devices', payload);
    formDialog.value = false;
    notify('Устройство сохранено');
    await load();
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Ошибка сохранения', 'error');
  } finally {
    saving.value = false;
  }
}

async function remove(device: any) {
  if (!confirm(`Удалить устройство "${device.name}"?`)) return;
  await api.delete(`/devices/${device.id}`);
  notify('Устройство удалено');
  await load();
}

onMounted(load);
</script>
