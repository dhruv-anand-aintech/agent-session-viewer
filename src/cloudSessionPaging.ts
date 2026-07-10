export const CLOUD_SESSION_PAGE_SIZE = 30

export interface LoadMoreSessionsRequest {
  offset: number
  limit?: number
}

export async function requestMoreCloudSessions(
  { offset, limit = CLOUD_SESSION_PAGE_SIZE }: LoadMoreSessionsRequest,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher("/api/sessions/load-more", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ offset, limit }),
  })

  // The local viewer already has every transcript and does not expose the cloud
  // command endpoint. Let the caller widen its SSE query without treating that
  // expected 404 as a failed cloud backfill.
  if (response.status === 404) return { local: true }

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    const detail = typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`
    throw new Error(detail)
  }

  return response.json().catch(() => ({}))
}
