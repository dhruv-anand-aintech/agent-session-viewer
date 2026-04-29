import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Local API for dev proxy (`npm run local` sets VITE_API_PROXY_TARGET to the chosen port). */
const fallbackApiPort =
  (typeof process.env.PORT === "string" && process.env.PORT.trim() !== ""
    ? process.env.PORT.trim()
    : "3001")

const apiDevTarget =
  process.env.VITE_API_PROXY_TARGET?.trim() ?? `http://127.0.0.1:${fallbackApiPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // timeout: 0 avoids hanging SSE (/api/stream) behind the dev proxy
      "/api": { target: apiDevTarget, changeOrigin: true, timeout: 0 },
    },
  },
})
