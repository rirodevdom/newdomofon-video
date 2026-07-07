import { defineStore } from 'pinia';
import { api } from '../api';

interface User {
  id: string;
  login: string;
  role: 'super_admin' | 'operator' | 'viewer' | 'installer';
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    user: JSON.parse(localStorage.getItem('user') || 'null') as User | null
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    isAdmin: (state) => state.user?.role === 'super_admin' || state.user?.role === 'operator'
  },
  actions: {
    async login(login: string, password: string) {
      const { data } = await api.post('/auth/login', { login, password });
      this.token = data.token;
      this.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    },
    logout() {
      this.token = '';
      this.user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
  }
});
