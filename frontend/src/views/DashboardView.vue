<template>
  <v-container fluid class="pa-6">
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <h1 class="text-h4">Дашборд</h1>
      <v-spacer />
      <v-btn prepend-icon="mdi-refresh" :loading="loading" @click="load">Обновить</v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-row>
      <v-col cols="12" md="3">
        <v-card>
          <v-card-title class="d-flex align-center ga-2"><v-icon icon="mdi-cctv" />Камеры</v-card-title>
          <v-card-text>
            <div class="text-h4">{{ summary.cameras.online }} / {{ summary.cameras.offline }}</div>
            <div class="text-caption text-medium-emphasis">онлайн / офлайн</div>
            <div class="text-caption text-medium-emphasis mt-1">всего: {{ summary.cameras.total }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="3">
        <v-card>
          <v-card-title class="d-flex align-center ga-2"><v-icon icon="mdi-devices" />Устройства</v-card-title>
          <v-card-text>
            <div class="text-h4">{{ summary.devices.online }} / {{ summary.devices.offline }}</div>
            <div class="text-caption text-medium-emphasis">онлайн / офлайн</div>
            <div v-if="summary.devices.unconfigured" class="text-caption text-error mt-1">не донастроено: {{ summary.devices.unconfigured }}</div>
            <div class="text-caption text-medium-emphasis mt-1">всего: {{ summary.devices.total }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="3">
        <v-card>
          <v-card-title class="d-flex align-center ga-2"><v-icon icon="mdi-server-network" />Ноды</v-card-title>
          <v-card-text>
            <div class="text-h4">{{ summary.nodes.online }} / {{ summary.nodes.offline }}</div>
            <div class="text-caption text-medium-emphasis">онлайн / офлайн</div>
            <div v-if="summary.nodes.warning" class="text-caption text-warning mt-1">warning: {{ summary.nodes.warning }}</div>
            <div class="text-caption text-medium-emphasis mt-1">всего: {{ summary.nodes.total }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="3">
        <v-card>
          <v-card-title class="d-flex align-center ga-2">
            <v-icon icon="mdi-harddisk" />
            Архив / хранилище
          </v-card-title>
          <v-card-text>
            <div class="text-h5">{{ formatBytes(summary.storage.used_bytes) }} / {{ formatBytes(summary.storage.total_bytes) }}</div>
            <div class="text-caption text-medium-emphasis">занято / всего</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-card class="mt-6">
      <v-card-title class="d-flex align-center">
        Video nodes
        <v-spacer />
        <v-text-field v-model="search" density="compact" label="Поиск node" hide-details style="max-width: 280px" />
      </v-card-title>
      <v-table>
        <thead>
          <tr>
            <th>Название</th>
            <th>Статус</th>
            <th>Камеры</th>
            <th>Устройства</th>
            <th>Диск</th>
            <th>Last seen</th>
            <th>Public URL</th>
            <th>Internal URL</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in filteredNodes" :key="node.id">
            <td>{{ node.name }}</td>
            <td><v-chip size="small" :color="statusColor(node.health)">{{ node.health }}</v-chip></td>
            <td>{{ node.camera_count }}</td>
            <td>{{ node.device_count }}</td>
            <td>{{ formatBytes(node.storage_used_bytes) }} / {{ formatBytes(node.storage_total_bytes) }}</td>
            <td>{{ formatDate(node.last_seen_at) }}</td>
            <td class="text-truncate" style="max-width: 260px">{{ node.public_base_url || node.base_url || '—' }}</td>
            <td class="text-truncate" style="max-width: 260px">{{ node.internal_url || '—' }}</td>
          </tr>
          <tr v-if="!filteredNodes.length">
            <td colspan="8" class="text-center text-medium-emphasis py-6">Node пока не добавлены</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

const loading = ref(false);
const error = ref('');
const search = ref('');
const summary = ref<any>({
  cameras: { online: 0, offline: 0, total: 0 },
  devices: { online: 0, offline: 0, total: 0, unconfigured: 0 },
  nodes: { online: 0, warning: 0, offline: 0, total: 0 },
  storage: { used_bytes: 0, total_bytes: 0 },
  node_items: []
});

const filteredNodes = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return summary.value.node_items;
  return summary.value.node_items.filter((node: any) => [node.name, node.public_base_url, node.internal_url, node.health].some((value) => String(value || '').toLowerCase().includes(needle)));
});

function formatBytes(value: number) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function statusColor(status: string) {
  if (status === 'online') return 'success';
  if (status === 'warning') return 'warning';
  return 'error';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    summary.value = (await api.get('/dashboard/summary')).data;
  } catch (err: any) {
    error.value = err.response?.data?.error || err.message || 'Не удалось загрузить дашборд';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
