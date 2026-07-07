<template>
  <v-app>
    <v-navigation-drawer v-if="auth.isAuthenticated" v-model="drawer">
      <v-list nav>
        <v-list-item title="NewDomofon Video" subtitle="master / node VMS" />
        <v-divider class="my-2" />
        <v-list-item prepend-icon="mdi-view-dashboard" title="Дашборд" to="/" />
        <v-list-item prepend-icon="mdi-devices" title="Устройства" to="/devices" />
        <v-list-item prepend-icon="mdi-cctv" title="Камеры" to="/cameras" />
        <v-list-item prepend-icon="mdi-server-network" title="Ноды" to="/nodes" />
        <v-list-item v-if="auth.user?.role === 'super_admin'" prepend-icon="mdi-shield-account" title="Администрирование" to="/admin" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar v-if="auth.isAuthenticated" flat border>
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>Видеопортал</v-app-bar-title>
      <v-spacer />
      <span class="mr-4">{{ auth.user?.login }} / {{ auth.user?.role }}</span>
      <v-btn variant="tonal" @click="logout">Выйти</v-btn>
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const drawer = ref(true);
const auth = useAuthStore();
const router = useRouter();

function logout() {
  auth.logout();
  router.push('/login');
}
</script>
