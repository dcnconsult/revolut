import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  base: '/operator/',
  plugins: [react()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000'
    }
  }
});
