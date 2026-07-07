<template>
  <v-container fluid class="pa-6">
    <h1 class="text-h4 mb-4">Администрирование</h1>

    <v-tabs v-model="tab">
      <v-tab value="users">Пользователи</v-tab>
      <v-tab value="tokens">Токены</v-tab>
    </v-tabs>

    <v-alert v-if="message" :type="messageType" variant="tonal" class="my-4" closable @click:close="message = ''">{{ message }}</v-alert>

    <v-window v-model="tab" class="mt-4">
      <v-window-item value="users">
        <v-card class="pa-4 mb-4">
          <v-card-title>Создать пользователя</v-card-title>
          <v-row>
            <v-col cols="12" md="3"><v-text-field v-model="userForm.login" label="Логин" /></v-col>
            <v-col cols="12" md="3"><v-text-field v-model="userForm.password" label="Пароль" type="password" /></v-col>
            <v-col cols="12" md="3"><v-select v-model="userForm.role" :items="roles" label="Роль" /></v-col>
            <v-col cols="12" md="3"><v-switch v-model="userForm.is_active" color="primary" label="Активен" /></v-col>
          </v-row>
          <v-btn color="primary" :loading="savingUser" @click="createUser">Создать</v-btn>
        </v-card>

        <v-card>
          <v-table>
            <thead><tr><th>Логин</th><th>Роль</th><th>Активен</th><th>Создан</th><th></th></tr></thead>
            <tbody>
              <tr v-for="user in users" :key="user.id">
                <td>{{ user.login }}</td>
                <td>
                  <v-select v-model="user.role" :items="roles" density="compact" hide-details style="max-width: 180px" @update:model-value="patchUser(user, { role: user.role })" />
                </td>
                <td>
                  <v-switch v-model="user.is_active" color="primary" density="compact" hide-details @update:model-value="patchUser(user, { is_active: user.is_active })" />
                </td>
                <td>{{ formatDate(user.created_at) }}</td>
                <td class="text-right">
                  <v-btn size="small" variant="tonal" @click="openPasswordReset(user)">Сброс пароля</v-btn>
                  <v-btn size="small" color="error" variant="tonal" class="ml-2" @click="removeUser(user)">Удалить</v-btn>
                </td>
              </tr>
              <tr v-if="!users.length">
                <td colspan="5" class="text-center text-medium-emphasis py-6">Пользователи не найдены</td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </v-window-item>

      <v-window-item value="tokens">
        <v-row>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-title>Системные токены</v-card-title>
              <v-table>
                <thead><tr><th>Тип</th><th>Статус</th><th>Последнее использование</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Node registration token</td>
                    <td><v-chip size="small" :color="tokens.node_registration_token?.configured ? 'success' : 'error'">{{ tokens.node_registration_token?.configured ? 'configured' : 'missing' }}</v-chip></td>
                    <td>{{ formatDate(tokens.node_registration_token?.last_used_at) }}</td>
                  </tr>
                  <tr>
                    <td>Internal DVR secret</td>
                    <td><v-chip size="small" :color="tokens.internal_dvr_secret?.configured ? 'success' : 'error'">{{ tokens.internal_dvr_secret?.configured ? 'configured' : 'missing' }}</v-chip></td>
                    <td>{{ formatDate(tokens.internal_dvr_secret?.last_used_at) }}</td>
                  </tr>
                </tbody>
              </v-table>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-alert type="info" variant="tonal">
              Секреты и пароли не показываются после создания. Для node agent token и media secret доступна ротация.
            </v-alert>
          </v-col>
        </v-row>

        <v-card class="mt-4">
          <v-card-title>Node agent/media tokens</v-card-title>
          <v-table>
            <thead><tr><th>Node</th><th>Agent token</th><th>Media secret</th><th>Создан</th><th>Последнее использование</th><th></th></tr></thead>
            <tbody>
              <tr v-for="node in tokens.node_tokens || []" :key="node.id">
                <td>{{ node.name }}</td>
                <td><v-chip size="small" :color="node.has_agent_token ? 'success' : 'error'">{{ node.has_agent_token ? 'configured' : 'missing' }}</v-chip></td>
                <td><v-chip size="small" :color="node.has_media_secret ? 'success' : 'error'">{{ node.has_media_secret ? 'configured' : 'missing' }}</v-chip></td>
                <td>{{ formatDate(node.created_at) }}</td>
                <td>{{ formatDate(node.last_used_at) }}</td>
                <td class="text-right"><v-btn size="small" variant="tonal" @click="rotateNodeToken(node)">Ротировать</v-btn></td>
              </tr>
            </tbody>
          </v-table>
        </v-card>

        <v-card class="mt-4">
          <v-card-title class="d-flex align-center justify-space-between">
            <span>Ссылки камер</span>
            <div class="d-flex align-center" style="gap: 12px">
              <v-text-field
                v-model.number="cameraLinkDays"
                type="number"
                min="1"
                max="365"
                density="compact"
                hide-details
                label="Дней"
                style="width: 110px"
              />
            </div>
          </v-card-title>
          <v-table>
            <thead>
              <tr>
                <th>Камера</th>
                <th>Stream</th>
                <th>Node</th>
                <th>Режим</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="camera in tokens.camera_links || []" :key="camera.id">
                <tr>
                  <td>{{ camera.name }}</td>
                  <td><code>{{ camera.stream_name }}</code></td>
                  <td>{{ camera.node_name || 'master' }}</td>
                  <td>
                    <v-chip size="small" :color="camera.link_mode === 'node-direct' ? 'success' : 'info'">
                      {{ camera.link_mode }}
                    </v-chip>
                  </td>
                  <td class="text-right">
                    <v-btn size="small" variant="tonal" :loading="generatingCameraLink === camera.id" @click="generateCameraLinks(camera)">
                      Сгенерировать
                    </v-btn>
                  </td>
                </tr>
                <tr v-if="generatedCameraLinks[camera.id]">
                  <td colspan="5" class="pb-4">
                    <v-alert type="warning" variant="tonal" density="compact" class="mb-2">
                      Ссылки и токены показаны один раз. Истекают: {{ formatDate(generatedCameraLinks[camera.id].expires_at) }}
                    </v-alert>
                    <v-textarea :model-value="generatedCameraLinks[camera.id].live_url" label="Live HLS URL" rows="2" readonly density="compact" />
                    <v-textarea :model-value="generatedCameraLinks[camera.id].archive_url_template" label="Archive HLS URL template" rows="2" readonly density="compact" />
                    <div class="d-flex flex-wrap" style="gap: 8px">
                      <v-btn size="small" variant="tonal" @click="copyText(generatedCameraLinks[camera.id].live_url)">Копировать live</v-btn>
                      <v-btn size="small" variant="tonal" @click="copyText(generatedCameraLinks[camera.id].archive_url_template)">Копировать archive</v-btn>
                      <v-btn size="small" variant="tonal" @click="copyText(generatedCameraLinks[camera.id].live_token)">Копировать live token</v-btn>
                      <v-btn size="small" variant="tonal" @click="copyText(generatedCameraLinks[camera.id].archive_token)">Копировать archive token</v-btn>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!(tokens.camera_links || []).length">
                <td colspan="5" class="text-center text-medium-emphasis py-6">Камеры не найдены</td>
              </tr>
            </tbody>
          </v-table>
        </v-card>

        <v-alert v-if="rotatedToken" type="warning" variant="tonal" class="mt-4">
          <div class="font-weight-bold mb-2">Новые значения показаны один раз.</div>
          <pre>{{ rotatedTokenText }}</pre>
        </v-alert>
      </v-window-item>
    </v-window>

    <v-dialog v-model="passwordDialog" max-width="520">
      <v-card>
        <v-card-title>Сброс пароля: {{ selectedUser?.login }}</v-card-title>
        <v-card-text><v-text-field v-model="newPassword" label="Новый пароль" type="password" /></v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="tonal" @click="passwordDialog = false">Отмена</v-btn>
          <v-btn color="primary" @click="resetPassword">Сохранить</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';

const tab = ref('users');
const roles = ['super_admin', 'operator', 'viewer', 'installer'];
const users = ref<any[]>([]);
const tokens = ref<any>({});
const message = ref('');
const messageType = ref<'success' | 'error'>('success');
const savingUser = ref(false);
const passwordDialog = ref(false);
const selectedUser = ref<any | null>(null);
const newPassword = ref('');
const rotatedToken = ref<any | null>(null);
const generatedCameraLinks = ref<Record<string, any>>({});
const generatingCameraLink = ref<string | null>(null);
const cameraLinkDays = ref(30);

const userForm = reactive({
  login: '',
  password: '',
  role: 'viewer',
  is_active: true,
  group_ids: []
});

const rotatedTokenText = computed(() => {
  if (!rotatedToken.value) return '';
  return [
    `DVR_NODE_ID=${rotatedToken.value.node_id || rotatedToken.value.id}`,
    `DVR_NODE_TOKEN=${rotatedToken.value.agent_token || ''}`,
    rotatedToken.value.media_secret ? `DVR_NODE_MEDIA_SECRET=${rotatedToken.value.media_secret}` : ''
  ].filter(Boolean).join('\n');
});

function notify(text: string, type: 'success' | 'error' = 'success') {
  message.value = text;
  messageType.value = type;
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

async function loadUsers() {
  users.value = (await api.get('/users')).data.items;
}

async function loadTokens() {
  tokens.value = (await api.get('/tokens')).data;
}

async function load() {
  await Promise.all([loadUsers(), loadTokens()]);
}

async function createUser() {
  savingUser.value = true;
  try {
    await api.post('/users', userForm);
    Object.assign(userForm, { login: '', password: '', role: 'viewer', is_active: true, group_ids: [] });
    notify('Пользователь создан');
    await loadUsers();
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Ошибка создания пользователя', 'error');
  } finally {
    savingUser.value = false;
  }
}

async function patchUser(user: any, patch: Record<string, unknown>) {
  await api.patch(`/users/${user.id}`, patch);
  notify('Пользователь обновлен');
}

function openPasswordReset(user: any) {
  selectedUser.value = user;
  newPassword.value = '';
  passwordDialog.value = true;
}

async function resetPassword() {
  if (!selectedUser.value) return;
  await api.patch(`/users/${selectedUser.value.id}`, { password: newPassword.value });
  passwordDialog.value = false;
  notify('Пароль обновлен');
}

async function removeUser(user: any) {
  if (!confirm(`Удалить пользователя "${user.login}"?`)) return;
  await api.delete(`/users/${user.id}`);
  notify('Пользователь удален');
  await loadUsers();
}


async function copyText(value: string | null | undefined) {
  if (!value) return;
  await navigator.clipboard?.writeText(value);
  notify('Скопировано');
}

async function generateCameraLinks(camera: any) {
  generatingCameraLink.value = camera.id;
  try {
    const ttlSeconds = Math.max(1, Number(cameraLinkDays.value || 30)) * 24 * 60 * 60;
    const response = await api.post(`/tokens/camera-links/${camera.id}`, { ttl_seconds: ttlSeconds });
    generatedCameraLinks.value = {
      ...generatedCameraLinks.value,
      [camera.id]: response.data
    };
    notify('Ссылки камеры сгенерированы');
  } catch (err: any) {
    notify(err.response?.data?.error || err.message || 'Ошибка генерации ссылок камеры', 'error');
  } finally {
    generatingCameraLink.value = null;
  }
}

async function rotateNodeToken(node: any) {
  rotatedToken.value = (await api.post(`/dvr-servers/${node.id}/rotate-token`, {})).data;
  notify('Node token ротирован');
  await loadTokens();
}

onMounted(load);
</script>
