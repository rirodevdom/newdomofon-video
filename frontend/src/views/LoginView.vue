<template>
  <v-container class="fill-height" max-width="460">
    <v-card class="pa-6 w-100" rounded="xl" elevation="6">
      <v-card-title class="text-h5">Вход в видеопортал</v-card-title>
      <v-card-subtitle>NewDomofon Video</v-card-subtitle>
      <v-card-text>
        <v-form @submit.prevent="submit">
          <v-text-field v-model="login" label="Логин" prepend-inner-icon="mdi-account" />
          <v-text-field v-model="password" label="Пароль" type="password" prepend-inner-icon="mdi-lock" />
          <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
          <v-btn type="submit" color="primary" block :loading="loading">Войти</v-btn>
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const login = ref('admin');
const password = ref('change-me-now');
const error = ref('');
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();

async function submit() {
  loading.value = true;
  error.value = '';
  try {
    await auth.login(login.value, password.value);
    await router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message || 'Ошибка входа';
  } finally {
    loading.value = false;
  }
}
</script>
