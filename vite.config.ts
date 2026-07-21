import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Local API for dev proxy (`npm run local` sets VITE_API_PROXY_TARGET to the chosen port). */
const fallbackApiPort =
  (typeof process.env.PORT === "string" && process.env.PORT.trim() !== ""
    ? process.env.PORT.trim()
    : "3001")

const apiDevTarget =
  process.env.VITE_API_PROXY_TARGET?.trim() ?? `http://127.0.0.1:${fallbackApiPort}`

// Cloudflare Rocket Loader rewrites type="module" → breaks the app.
// Adding data-cfasync="false" to all script tags tells it to skip them.
const disableRocketLoader = {
  name: "disable-cf-rocket-loader",
  transformIndexHtml(html: string) {
    return html.replace(/<script /g, '<script data-cfasync="false" ')
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), disableRocketLoader],
  resolve: {
    // agentic-ai-bar is linked from a sibling package; keep hooks on this app's React instance.
    dedupe: ["react", "react-dom"],
  },
  server: {
    proxy: {
      // timeout: 0 avoids hanging SSE (/api/stream) behind the dev proxy
      "/api": { target: apiDevTarget, changeOrigin: true, timeout: 0 },
    },
  },
})
