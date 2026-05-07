/**
 * This Worker is no longer used for remote access.
 *
 * Remote access is now handled directly by the npx CLI via ngrok:
 *   npx agent-session-viewer --remote
 *
 * No Cloudflare account, KV namespace, or daemon required.
 * See bin/agent-session-viewer.mjs for the tunnel implementation.
 */

export default {
  async fetch(): Promise<Response> {
    return new Response(
      "This deployment is deprecated. Run `npx agent-session-viewer --remote` instead.",
      { status: 410, headers: { "Content-Type": "text/plain" } }
    )
  },
}
