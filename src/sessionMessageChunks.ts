import { idbGet, idbPut } from "./idb"
import type { SessionMessage } from "./types"

interface ChunkMeta {
  start: number
  count: number
  key: string
}

interface ChunkRecord {
  start: number
  msgs: SessionMessage[]
}

interface ChunkIndex {
  total: number
  chunks: ChunkMeta[]
}

const INDEX_KEY = (baseKey: string) => `${baseKey}/chunks/index`
const CHUNK_KEY = (baseKey: string, start: number, count: number) => `${baseKey}/chunks/${start}-${count}`

export async function putMessageChunk(
  baseKey: string | null,
  start: number,
  msgs: SessionMessage[],
  total: number,
): Promise<void> {
  if (!baseKey || msgs.length === 0 || start < 0) return
  const key = CHUNK_KEY(baseKey, start, msgs.length)
  const record: ChunkRecord = { start, msgs }
  const existing = await idbGet<ChunkIndex>(INDEX_KEY(baseKey))
  const chunks = (existing?.chunks ?? [])
    .filter(c => !(c.start === start && c.count === msgs.length))
    .concat({ start, count: msgs.length, key })
    .sort((a, b) => a.start - b.start)
    .slice(-80)
  await idbPut(key, record)
  await idbPut(INDEX_KEY(baseKey), { total, chunks })
}

export async function getMessageRange(
  baseKey: string | null,
  start: number,
  count: number,
): Promise<SessionMessage[] | null> {
  if (!baseKey || count <= 0 || start < 0) return null
  const index = await idbGet<ChunkIndex>(INDEX_KEY(baseKey))
  if (!index?.chunks?.length) return null

  const end = start + count
  const chunks = index.chunks
    .filter(c => c.start < end && c.start + c.count > start)
    .sort((a, b) => a.start - b.start)

  const out: SessionMessage[] = []
  let cursor = start
  for (const chunk of chunks) {
    if (chunk.start > cursor) break
    const record = await idbGet<ChunkRecord>(chunk.key)
    if (!record?.msgs?.length) continue
    const from = Math.max(0, cursor - record.start)
    const until = Math.min(record.msgs.length, end - record.start)
    if (until > from) {
      out.push(...record.msgs.slice(from, until))
      cursor += until - from
    }
    if (cursor >= end) return out
  }

  return null
}
