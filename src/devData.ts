/**
 * Local dev data loader — reads Claude JSONL session files via fetch
 * from the Vite dev server proxy, bypassing the Worker KV.
 *
 * In production, the Worker serves /api/projects from KV.
 * In dev, Vite proxies /api/* to the local Express server below.
 */

export {}
