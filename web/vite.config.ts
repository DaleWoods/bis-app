import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev only: the API runs separately. In production the API serves the
      // built assets from the same origin, so no proxy is involved.
      '/api': { target: process.env.API_ORIGIN ?? 'http://localhost:4000', changeOrigin: true },
      '/auth': { target: process.env.API_ORIGIN ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
