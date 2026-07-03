import { useState, useEffect, useRef, useCallback } from "react"
import type { SessionMessage, MsgWindow } from "./types"
import { idbPut, idbGet } from "./idb"
import { hasEarlierMessages } from "./sessionPaneState"
import { charCountMsg } from "./pretty/PrettyMessageBlock"
import { markIDBResult, markRemoteFetch, markChunkLoad } from "./perf"
import { wallClock } from "./utils"
import { debugLog } from "./debug-trace"
import { trackedEventSource } from "./sse-lifecycle"
import { getMessageRange, putMessageChunk } from "./sessionMessageChunks"

export const CHUNK = 60
export const MIN_DOM = 180
export const DEFAULT_DOM = 360
export const MAX_DOM = 480
export const MEMORY_SAMPLE_MS = 5000
export const MAX_LOADED_MULTIPLIER = 2
const INITIAL_TAIL = 20
const IDB_KEY = (projectDir: string, sessionId: string) => `sess/${projectDir}/${sessionId}`

interface BrowserMemoryInfo {
  usedJSHeapSize: number
  jsHeapSizeLimit: number
}

function browserMemory(): BrowserMemoryInfo | null {
  const perf = performance as Performance & { memory?: Partial<BrowserMemoryInfo> }
  const memory = perf.memory
  if (
    typeof memory?.usedJSHeapSize !== "number" ||
    typeof memory?.jsHeapSizeLimit !== "number" ||
    memory.jsHeapSizeLimit <= 0
  ) return null
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  }
}

export function domLimitForMemory(memory: BrowserMemoryInfo | null): number {
  if (!memory) return DEFAULT_DOM
  const usedMb = memory.usedJSHeapSize / 1024 / 1024
  const heapRatio = memory.usedJSHeapSize / memory.jsHeapSizeLimit
  if (usedMb >= 512 || heapRatio >= 0.25) return MIN_DOM
  if (usedMb >= 320 || heapRatio >= 0.16) return 240
  if (usedMb >= 160 || heapRatio >= 0.08) return DEFAULT_DOM
  return MAX_DOM
}

const CHAR_TARGET = 5000
export function adaptivePage(all: SessionMessage[], fromIdx: number): number {
  let chars = 0
  let count = 0
  for (let i = fromIdx - 1; i >= 0 && count < 50; i--, count++) {
    chars += charCountMsg(all[i])
    if (chars >= CHAR_TARGET) return count + 1
  }
  return Math.max(count, 5)
}

export function sessionUrl(projectDir: string, sessionId: string, tail?: number, skip?: number) {
  const base = `/api/session/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}`
  const params = new URLSearchParams()
  if (tail) params.set("tail", String(tail))
  if (skip) params.set("skip", String(skip))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

export function useWindowedMessages(projectDir: string | null, sessionId: string | null, isActive: boolean) {
  const [win, setWin] = useState<MsgWindow | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [initialRemotePending, setInitialRemotePending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chatDir, setChatDir] = useState<string | null>(null)
  const fullRef = useRef<SessionMessage[]>([])
  const latestTotalRef = useRef(0)
  const domLimitRef = useRef(domLimitForMemory(browserMemory()))
  const loadSeqRef = useRef(0)
  const seenUuidsRef = useRef<Set<string>>(new Set())
  const [newMsgUuids, setNewMsgUuids] = useState<ReadonlySet<string>>(new Set())

  const idbKey = projectDir && sessionId ? IDB_KEY(projectDir, sessionId) : null
  const loadTraceRef = useRef(0)

  const traceLabel = useCallback((loadSeq: number) => {
    return `${sessionId?.slice(0, 8) ?? "none"}#${loadSeq}`
  }, [sessionId])

  const maxLoadedMessages = useCallback(() => {
    return Math.max(DEFAULT_DOM, domLimitRef.current * MAX_LOADED_MULTIPLIER)
  }, [])

  const rememberChunk = useCallback((start: number, msgs: SessionMessage[], total: number) => {
    void putMessageChunk(idbKey, start, msgs, total).catch(() => {})
  }, [idbKey])

  useEffect(() => {
    function sampleDomLimit() {
      domLimitRef.current = domLimitForMemory(browserMemory())
    }
    sampleDomLimit()
    const timer = window.setInterval(sampleDomLimit, MEMORY_SAMPLE_MS)
    return () => window.clearInterval(timer)
  }, [])

  const updateChatDir = useCallback((msgs: SessionMessage[]) => {
    const cwd = msgs.find(m => typeof m.cwd === "string" && m.cwd.trim())?.cwd?.trim() ?? null
    setChatDir(cwd)
  }, [])

  const initWindow = useCallback((msgs: SessionMessage[], serverTotal: number) => {
    const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
    fullRef.current = filtered
    updateChatDir(filtered)
    const domLimit = domLimitRef.current
    const startIdx = Math.max(0, filtered.length - domLimit)
    seenUuidsRef.current = new Set(filtered.map(m => m.uuid).filter(Boolean) as string[])
    setNewMsgUuids(new Set())
    const serverFetchedFrom = serverTotal - msgs.length
    const globalOffset = Math.max(0, serverTotal - filtered.length)
    rememberChunk(globalOffset, filtered, serverTotal)
    setWin({ msgs: filtered.slice(startIdx), startIdx, total: serverTotal, filteredTotal: serverTotal, serverFetchedFrom, globalOffset })
  }, [rememberChunk, updateChatDir])

  const fetchRemote = useCallback(async (signal?: AbortSignal) => {
    try {
      if (!projectDir || !sessionId || !idbKey) return
      const loadSeq = loadTraceRef.current
      const trace = traceLabel(loadSeq)
      const url5 = sessionUrl(projectDir, sessionId, INITIAL_TAIL)
      const t0 = performance.now()
      debugLog(`[session-load ${wallClock()}] ${trace} remote-start url=${url5}`)
      const r = await fetch(url5, { credentials: "include", signal })
      if (signal?.aborted) return
      const fetchMs = performance.now() - t0
      debugLog(`[session-load ${wallClock()}] ${trace} remote-headers status=${r.status} ok=${r.ok} fetchMs=${fetchMs.toFixed(1)}`)
      if (!r.ok) {
        setLoadError(r.status === 401 ? "Session requires PIN — refresh and sign in again."
          : r.status === 404 ? "Session not found."
          : `Failed to load session (HTTP ${r.status}).`)
        return
      }
      setLoadError(null)
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || 0
      const jsonT0 = performance.now()
      let msgs: SessionMessage[] = await r.json()
      if (signal?.aborted) return
      const parseMs = performance.now() - jsonT0
      debugLog(`[session-load ${wallClock()}] ${trace} remote-json count=${msgs.length} total=${serverTotal || msgs.length} jsonMs=${parseMs.toFixed(1)}`)
      let total = serverTotal || msgs.length
      if (msgs.every(m => m.type === "file-history-snapshot") && total > msgs.length) {
        const url50 = sessionUrl(projectDir, sessionId, 50)
        debugLog(`[session-load ${wallClock()}] ${trace} remote-fallback start url=${url50}`)
        const r2 = await fetch(url50, { credentials: "include", signal })
        if (r2.ok) {
          const json2T0 = performance.now()
          msgs = await r2.json()
          if (signal?.aborted) return
          total = parseInt(r2.headers.get("X-Message-Total") ?? "0") || total
          debugLog(`[session-load ${wallClock()}] ${trace} remote-fallback ok count=${msgs.length} total=${total} jsonMs=${(performance.now() - json2T0).toFixed(1)}`)
        } else {
          debugLog(`[session-load ${wallClock()}] ${trace} remote-fallback status=${r2.status} ok=${r2.ok}`)
        }
      }
      if (signal?.aborted) return
      markRemoteFetch(sessionId, fetchMs, parseMs, msgs.length, total)
      debugLog(`[session-load ${wallClock()}] ${trace} remote-commit count=${msgs.length} total=${total}`)
      await idbPut(idbKey, { msgs, total })
      if (signal?.aborted) return
      initWindow(msgs, total)
    } catch (err) {
      if (signal?.aborted) return
      debugLog(`[session-load ${wallClock()}] ${traceLabel(loadTraceRef.current)} remote-error`, err)
    } finally {
      if (!signal?.aborted) {
        debugLog(`[session-load ${wallClock()}] ${traceLabel(loadTraceRef.current)} remote-finish`)
        setLoading(false)
        setInitialRemotePending(false)
      }
    }
  }, [projectDir, sessionId, idbKey, initWindow, traceLabel])

  useEffect(() => {
    return () => {
      if (!idbKey || fullRef.current.length === 0) return
      void idbPut(idbKey, { msgs: fullRef.current, total: latestTotalRef.current || fullRef.current.length })
    }
  }, [idbKey])

  useEffect(() => {
    if (!win) return
    latestTotalRef.current = win.filteredTotal || win.total || latestTotalRef.current
  }, [win])

  useEffect(() => {
    if (!projectDir || !sessionId || !idbKey) return
    const controller = new AbortController()
    const loadSeq = ++loadSeqRef.current
    loadTraceRef.current = loadSeq
    const trace = traceLabel(loadSeq)
    debugLog(`[session-load ${wallClock()}] ${trace} effect-start project=${projectDir} key=${idbKey}`)
    setWin(null)
    setLoadError(null)
    setLoading(true)
    setInitialRemotePending(true)
    fullRef.current = []
    ;(async () => {
      if (controller.signal.aborted || loadSeq !== loadSeqRef.current) return
      const idbT0 = performance.now()
      const idbRaw = await idbGet<{ msgs: SessionMessage[]; total: number } | SessionMessage[]>(idbKey)
      if (controller.signal.aborted || loadSeq !== loadSeqRef.current) return
      const idbMs = performance.now() - idbT0
      const cachedMsgs = Array.isArray(idbRaw) ? idbRaw : idbRaw?.msgs
      const cachedTotal = Array.isArray(idbRaw) ? (idbRaw.length) : (idbRaw?.total ?? idbRaw?.msgs?.length ?? 0)
      debugLog(`[session-load ${wallClock()}] ${trace} idb-result hasMsgs=${!!(cachedMsgs && cachedMsgs.length > 0)} count=${cachedMsgs?.length ?? 0} total=${cachedTotal} ms=${idbMs.toFixed(1)}`)
      markIDBResult(sessionId, !!(cachedMsgs && cachedMsgs.length > 0), cachedMsgs?.length ?? 0, idbMs)
      if (cachedMsgs && cachedMsgs.length > 0) {
        debugLog(`[session-load ${wallClock()}] ${trace} idb-commit count=${cachedMsgs.length} total=${cachedTotal}`)
        initWindow(cachedMsgs, cachedTotal)
        if (!controller.signal.aborted && loadSeq === loadSeqRef.current) setLoading(false)
      }
      await fetchRemote(controller.signal)
    })()
    return () => {
      debugLog(`[session-load ${wallClock()}] ${trace} effect-cleanup abort=${controller.signal.aborted}`)
      controller.abort()
    }
  }, [projectDir, sessionId, idbKey, fetchRemote, initWindow, updateChatDir, traceLabel])

  useEffect(() => {
    if (!isActive || !projectDir || !sessionId || !idbKey) return

    function applyTailUpdate(msgs: SessionMessage[], total: number) {
      const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
      const brandNew = filtered.filter(m => m.uuid && !seenUuidsRef.current.has(m.uuid))
      if (brandNew.length > 0) {
        setNewMsgUuids(prev => {
          const next = new Set(prev)
          brandNew.forEach(m => next.add(m.uuid!))
          brandNew.forEach(m => seenUuidsRef.current.add(m.uuid!))
          return next as ReadonlySet<string>
        })
      }
      setWin(prev => {
        const nextTotal = total || filtered.length
        if (!prev) {
          const domLimit = domLimitRef.current
          const startIdx = Math.max(0, filtered.length - domLimit)
          fullRef.current = filtered
          updateChatDir(filtered)
          const globalOffset = Math.max(0, nextTotal - filtered.length)
          return { msgs: filtered.slice(startIdx), startIdx, total: nextTotal, filteredTotal: nextTotal, serverFetchedFrom: globalOffset, globalOffset }
        }
        const domLimit = domLimitRef.current
        const alreadyHeld = fullRef.current.slice(0, Math.max(0, fullRef.current.length - filtered.length))
        const merged = [...alreadyHeld, ...filtered]
        const mergedTotal = total || Math.max(prev.total, merged.length)
        const totalDelta = Math.max(0, mergedTotal - prev.total)
        const serverFetchedFrom = Math.max(0, prev.serverFetchedFrom + totalDelta)
        fullRef.current = merged
        updateChatDir(merged)
        const newStart = prev.startIdx
        const newMsgs = merged.slice(newStart)
        if (newMsgs.length > domLimit) {
          const trimStart = newStart + (newMsgs.length - domLimit)
          return { msgs: merged.slice(trimStart), startIdx: trimStart, total: mergedTotal, filteredTotal: mergedTotal, serverFetchedFrom, globalOffset: prev.globalOffset }
        }
        return { msgs: newMsgs, startIdx: newStart, total: mergedTotal, filteredTotal: mergedTotal, serverFetchedFrom, globalOffset: prev.globalOffset }
      })
    }

    const qs = `?project=${encodeURIComponent(projectDir)}&session=${encodeURIComponent(sessionId)}&tail=${INITIAL_TAIL}`
    const es = trackedEventSource(`/api/session-watch${qs}`)
    let pollFallback: ReturnType<typeof setInterval> | null = null

    es.addEventListener("session_update", (e: MessageEvent) => {
      try {
        const { msgs, total } = JSON.parse(e.data)
        applyTailUpdate(msgs, total)
      } catch { /* ignore malformed */ }
    })

    es.addEventListener("no_watch", () => {
      es.close()
      pollFallback = setInterval(async () => {
        try {
          const r = await fetch(sessionUrl(projectDir, sessionId, INITIAL_TAIL), { credentials: "include" })
          if (!r.ok) return
          const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || 0
          const msgs: SessionMessage[] = await r.json()
          applyTailUpdate(msgs, serverTotal)
        } catch { /* ignore */ }
      }, 4000)
    })

    return () => {
      es.close()
      if (pollFallback) clearInterval(pollFallback)
    }
  }, [isActive, projectDir, sessionId, idbKey, updateChatDir])

  const hasEarlier = hasEarlierMessages(win)
  const hasLater = win
    ? win.startIdx + win.msgs.length < fullRef.current.length ||
      win.globalOffset + fullRef.current.length < win.filteredTotal
    : false

  const loadingEarlierRef = useRef(false)
  const loadingLaterRef = useRef(false)

  async function loadEarlier() {
    if (!win || !projectDir || !sessionId) return
    const full = fullRef.current

    if (win.startIdx > 0) {
      const domLimit = domLimitRef.current
      const newStart = Math.max(0, win.startIdx - adaptivePage(full, win.startIdx))
      const existingEnd = win.startIdx + win.msgs.length
      const newMsgs = full.slice(newStart, existingEnd)
      const trimmed = newMsgs.length > domLimit ? newMsgs.slice(0, domLimit) : newMsgs
      setWin({ ...win, msgs: trimmed, startIdx: newStart })
      return
    }

    if (win.globalOffset <= 0) return
    setLoadingMore(true)
    try {
      const fetchCount = Math.min(CHUNK, win.globalOffset)
      const rangeStart = win.globalOffset - fetchCount
      const cached = await getMessageRange(idbKey, rangeStart, fetchCount)
      let serverTotal = win.total
      let newFiltered = cached
      const t0 = performance.now()
      if (!newFiltered) {
        const skip = win.filteredTotal - win.globalOffset
        const r = await fetch(sessionUrl(projectDir, sessionId, fetchCount, skip), { credentials: "include" })
        if (!r.ok) return
        serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || win.total
        const newMsgs: SessionMessage[] = await r.json()
        markChunkLoad(sessionId, newMsgs.length, skip, performance.now() - t0)
        newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
      }
      rememberChunk(rangeStart, newFiltered, serverTotal)
      const merged = [...newFiltered, ...full]
      const maxLoaded = maxLoadedMessages()
      const kept = merged.length > maxLoaded ? merged.slice(0, maxLoaded) : merged
      const domLimit = domLimitRef.current
      fullRef.current = kept
      const newGlobalOffset = Math.max(0, win.globalOffset - newFiltered.length)
      const newEnd = newFiltered.length + Math.min(win.msgs.length, domLimit - newFiltered.length)
      setWin({
        msgs: kept.slice(0, Math.min(domLimit, newEnd)),
        startIdx: 0,
        total: serverTotal,
        filteredTotal: serverTotal,
        serverFetchedFrom: newGlobalOffset,
        globalOffset: newGlobalOffset,
      })
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }

  async function loadLater() {
    if (!win) return
    const full = fullRef.current
    const currentEnd = win.startIdx + win.msgs.length

    if (currentEnd < full.length) {
      const domLimit = domLimitRef.current
      const newEnd = Math.min(full.length, currentEnd + CHUNK)
      const newMsgs = full.slice(win.startIdx, newEnd)
      if (newMsgs.length > domLimit) {
        const trimStart = win.startIdx + (newMsgs.length - domLimit)
        setWin({ ...win, msgs: full.slice(trimStart, newEnd), startIdx: trimStart })
      } else {
        setWin({ ...win, msgs: newMsgs })
      }
      return
    }

    if (win.globalOffset + full.length < win.filteredTotal && projectDir && sessionId) {
      setLoadingMore(true)
      try {
        const afterStart = win.globalOffset + full.length
        const remaining = win.filteredTotal - afterStart
        const fetchCount = Math.min(CHUNK, remaining)
        const cached = await getMessageRange(idbKey, afterStart, fetchCount)
        let newFiltered = cached
        if (!newFiltered) {
          const skip = remaining - fetchCount
          const r = await fetch(sessionUrl(projectDir, sessionId, fetchCount, skip), { credentials: "include" })
          if (!r.ok) return
          const newMsgs: SessionMessage[] = await r.json()
          newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
          rememberChunk(afterStart, newFiltered, win.filteredTotal)
        }
        const appended = [...full, ...newFiltered]
        const domLimit = domLimitRef.current
        const maxLoaded = maxLoadedMessages()
        const drop = Math.max(0, appended.length - maxLoaded)
        const kept = drop > 0 ? appended.slice(drop) : appended
        const nextGlobalOffset = win.globalOffset + drop
        fullRef.current = kept
        const nextEnd = kept.length
        const nextStart = Math.max(0, nextEnd - domLimit)
        setWin({ ...win, msgs: kept.slice(nextStart, nextEnd), startIdx: nextStart, globalOffset: nextGlobalOffset, serverFetchedFrom: nextGlobalOffset })
      } catch { /* ignore */ }
      finally { setLoadingMore(false) }
    }
  }

  async function loadFirstPage() {
    if (!win || !projectDir || !sessionId) return
    if (!hasEarlier) return
    setLoadingMore(true)
    try {
      const total = win.filteredTotal || win.total
      const domLimit = domLimitRef.current
      const fetchCount = Math.min(domLimit, total)
      const skip = Math.max(0, total - fetchCount)
      const t0 = performance.now()
      const r = await fetch(sessionUrl(projectDir, sessionId, fetchCount, skip), { credentials: "include" })
      if (!r.ok) return
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || total
      const newMsgs: SessionMessage[] = await r.json()
      markChunkLoad(sessionId, newMsgs.length, skip, performance.now() - t0)
      const newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
      rememberChunk(0, newFiltered, serverTotal)
      fullRef.current = newFiltered
      setWin({
        msgs: newFiltered.slice(0, domLimit),
        startIdx: 0,
        total: serverTotal,
        filteredTotal: serverTotal,
        serverFetchedFrom: 0,
        globalOffset: 0,
      })
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }

  const bringMessageIndexIntoView = useCallback((targetFullRefIdx: number) => {
    setWin(prev => {
      if (!prev) return prev
      const full = fullRef.current
      if (targetFullRefIdx < 0 || targetFullRefIdx >= full.length) return prev
      if (targetFullRefIdx >= prev.startIdx && targetFullRefIdx < prev.startIdx + prev.msgs.length) return prev
      const domLimit = domLimitRef.current
      const half = Math.floor(domLimit / 2)
      const newStart = Math.min(Math.max(0, targetFullRefIdx - half), Math.max(0, full.length - domLimit))
      const end = Math.min(full.length, newStart + domLimit)
      return { ...prev, startIdx: newStart, msgs: full.slice(newStart, end) }
    })
  }, [])

  const jumpToUuid = useCallback(async (uuid: string, scrollEl: HTMLElement | null) => {
    if (!projectDir || !sessionId) return
    const localIdx = fullRef.current.findIndex(m => m.uuid === uuid)
    if (localIdx >= 0) {
      bringMessageIndexIntoView(localIdx)
      const curOffset = win?.globalOffset ?? 0
      requestAnimationFrame(() => {
        scrollEl?.querySelector(`[data-msg-index="${curOffset + localIdx}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
      return
    }
    setLoadingMore(true)
    try {
      const r = await fetch(
        `/api/session-near?project=${encodeURIComponent(projectDir)}&session=${encodeURIComponent(sessionId)}&uuid=${encodeURIComponent(uuid)}&context=60`,
        { credentials: "include" }
      )
      if (!r.ok) return
      const filteredTotal = parseInt(r.headers.get("X-Message-Total") ?? "0")
      const windowStart = parseInt(r.headers.get("X-Window-Start") ?? "0")
      const msgs: SessionMessage[] = await r.json()
      fullRef.current = msgs
      const targetIdx = msgs.findIndex(m => m.uuid === uuid)
      const domLimit = domLimitRef.current
      const half = Math.floor(domLimit / 2)
      const newStart = Math.min(Math.max(0, targetIdx - half), Math.max(0, msgs.length - domLimit))
      const newEnd = Math.min(msgs.length, newStart + domLimit)
      setWin(prev => ({
        msgs: msgs.slice(newStart, newEnd),
        startIdx: newStart,
        total: prev?.total ?? filteredTotal,
        filteredTotal,
        serverFetchedFrom: 0,
        globalOffset: windowStart,
      }))
      requestAnimationFrame(() => {
        scrollEl?.querySelector(`[data-msg-index="${windowStart + targetIdx}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }, [projectDir, sessionId, bringMessageIndexIntoView])

  return {
    win,
    loading,
    loadingMore,
    initialRemotePending,
    loadError,
    hasEarlier,
    hasLater,
    loadEarlier,
    loadLater,
    loadFirstPage,
    fullRef,
    loadingEarlierRef,
    loadingLaterRef,
    chatDir,
    bringMessageIndexIntoView,
    jumpToUuid,
    newMsgUuids,
  }
}
