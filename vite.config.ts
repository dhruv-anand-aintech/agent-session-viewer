import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // timeout: 0 avoids hanging SSE (/api/stream) behind the dev proxy
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true, timeout: 0 },
    },
  },
})
