import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Панель доступна только с этой машины: через неё вводится приватный ключ.
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
