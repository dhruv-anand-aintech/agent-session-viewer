import { useState, useEffect, useRef, useCallback } from "react"
import type { SessionMessage, MsgWindow } from "./types"
import { idbPut, idbGet } from "./idb"
import { hasEarlierMessages } from "./sessionPaneState"
import { charCountMsg } from "./pretty/PrettyMessageBlock"
import { markIDBResult, markRemoteFetch, markChunkLoad } from "./perf"
import { wallClock } from "./utils"

export const CHUNK = 60
export const MAX_DOM = 180
const INITIAL_TAIL = 5
const IDB_KEY = (projectDir: string, sessionId: string) => `sess/${projectDir}/${sessionId}`

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
  const [chatDir, setChatDir] = useState<string | null>(null)
  const fullRef = useRef<SessionMessage[]>([])
  const loadSeqRef = useRef(0)
  const seenUuidsRef = useRef<Set<string>>(new Set())
  const [newMsgUuids, setNewMsgUuids] = useState<ReadonlySet<string>>(new Set())

  const idbKey = projectDir && sessionId ? IDB_KEY(projectDir, sessionId) : null
  const loadTraceRef = useRef(0)

  const traceLabel = useCallback((loadSeq: number) => {
    return `${sessionId?.slice(0, 8) ?? "none"}#${loadSeq}`
  }, [sessionId])

  const updateChatDir = useCallback((msgs: SessionMessage[]) => {
    const cwd = msgs.find(m => typeof m.cwd === "string" && m.cwd.trim())?.cwd?.trim() ?? null
    setChatDir(cwd)
  }, [])

  const initWindow = useCallback((msgs: SessionMessage[], serverTotal: number) => {
    const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
    fullRef.current = filtered
    updateChatDir(filtered)
    const startIdx = Math.max(0, filtered.length - MAX_DOM)
    seenUuidsRef.current = new Set(filtered.map(m => m.uuid).filter(Boolean) as string[])
    setNewMsgUuids(new Set())
    const serverFetchedFrom = serverTotal - msgs.length
    const globalOffset = Math.max(0, serverTotal - filtered.length)
    setWin({ msgs: filtered.slice(startIdx), startIdx, total: serverTotal, filteredTotal: serverTotal, serverFetchedFrom, globalOffset })
  }, [updateChatDir])

  const fetchRemote = useCallback(async (signal?: AbortSignal) => {
    try {
      if (!projectDir || !sessionId || !idbKey) return
      const loadSeq = loadTraceRef.current
      const trace = traceLabel(loadSeq)
      const url5 = sessionUrl(projectDir, sessionId, INITIAL_TAIL)
      const t0 = performance.now()
      console.log(`[session-load ${wallClock()}] ${trace} remote-start url=${url5}`)
      const r = await fetch(url5, { credentials: "include", signal })
      if (signal?.aborted) return
      const fetchMs = performance.now() - t0
      console.log(`[session-load ${wallClock()}] ${trace} remote-headers status=${r.status} ok=${r.ok} fetchMs=${fetchMs.toFixed(1)}`)
      if (!r.ok) return
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || 0
      const jsonT0 = performance.now()
      let msgs: SessionMessage[] = await r.json()
      if (signal?.aborted) return
      const parseMs = performance.now() - jsonT0
      console.log(`[session-load ${wallClock()}] ${trace} remote-json count=${msgs.length} total=${serverTotal || msgs.length} jsonMs=${parseMs.toFixed(1)}`)
      let total = serverTotal || msgs.length
      if (msgs.every(m => m.type === "file-history-snapshot") && total > msgs.length) {
        const url50 = sessionUrl(projectDir, sessionId, 50)
        console.log(`[session-load ${wallClock()}] ${trace} remote-fallback start url=${url50}`)
        const r2 = await fetch(url50, { credentials: "include", signal })
        if (r2.ok) {
          const json2T0 = performance.now()
          msgs = await r2.json()
          if (signal?.aborted) return
          total = parseInt(r2.headers.get("X-Message-Total") ?? "0") || total
          console.log(`[session-load ${wallClock()}] ${trace} remote-fallback ok count=${msgs.length} total=${total} jsonMs=${(performance.now() - json2T0).toFixed(1)}`)
        } else {
          console.log(`[session-load ${wallClock()}] ${trace} remote-fallback status=${r2.status} ok=${r2.ok}`)
        }
      }
      if (signal?.aborted) return
      markRemoteFetch(sessionId, fetchMs, parseMs, msgs.length, total)
      console.log(`[session-load ${wallClock()}] ${trace} remote-commit count=${msgs.length} total=${total}`)
      await idbPut(idbKey, { msgs, total })
      if (signal?.aborted) return
      initWindow(msgs, total)
    } catch (err) {
      if (signal?.aborted) return
      console.log(`[session-load ${wallClock()}] ${traceLabel(loadTraceRef.current)} remote-error`, err)
    } finally {
      if (!signal?.aborted) {
        console.log(`[session-load ${wallClock()}] ${traceLabel(loadTraceRef.current)} remote-finish`)
        setLoading(false)
        setInitialRemotePending(false)
      }
    }
  }, [projectDir, sessionId, idbKey, initWindow, traceLabel])

  useEffect(() => {
    return () => {
      if (!idbKey || fullRef.current.length === 0) return
      void idbPut(idbKey, { msgs: fullRef.current, total: fullRef.current.length })
    }
  }, [idbKey])

  useEffect(() => {
    if (!projectDir || !sessionId || !idbKey) return
    const controller = new AbortController()
    const loadSeq = ++loadSeqRef.current
    loadTraceRef.current = loadSeq
    const trace = traceLabel(loadSeq)
    console.log(`[session-load ${wallClock()}] ${trace} effect-start project=${projectDir} key=${idbKey}`)
    setWin(null)
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
      console.log(`[session-load ${wallClock()}] ${trace} idb-result hasMsgs=${!!(cachedMsgs && cachedMsgs.length > 0)} count=${cachedMsgs?.length ?? 0} total=${cachedTotal} ms=${idbMs.toFixed(1)}`)
      markIDBResult(sessionId, !!(cachedMsgs && cachedMsgs.length > 0), cachedMsgs?.length ?? 0, idbMs)
      if (cachedMsgs && cachedMsgs.length > 0) {
        console.log(`[session-load ${wallClock()}] ${trace} idb-commit count=${cachedMsgs.length} total=${cachedTotal}`)
        initWindow(cachedMsgs, cachedTotal)
        if (!controller.signal.aborted && loadSeq === loadSeqRef.current) setLoading(false)
      }
      await fetchRemote(controller.signal)
    })()
    return () => {
      console.log(`[session-load ${wallClock()}] ${trace} effect-cleanup abort=${controller.signal.aborted}`)
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
        if (!prev) {
          const startIdx = Math.max(0, filtered.length - MAX_DOM)
          fullRef.current = filtered
          updateChatDir(filtered)
          return { msgs: filtered.slice(startIdx), startIdx, total: total || filtered.length, filteredTotal: filtered.length, serverFetchedFrom: (total || filtered.length) - filtered.length, globalOffset: 0 }
        }
        const alreadyHeld = fullRef.current.slice(0, Math.max(0, fullRef.current.length - filtered.length))
        const merged = [...alreadyHeld, ...filtered]
        fullRef.current = merged
        updateChatDir(merged)
        const newStart = prev.startIdx
        const newMsgs = merged.slice(newStart)
        if (newMsgs.length > MAX_DOM) {
          const trimStart = newStart + (newMsgs.length - MAX_DOM)
          return { msgs: merged.slice(trimStart), startIdx: trimStart, total: total || merged.length, filteredTotal: merged.length, serverFetchedFrom: (total || merged.length) - merged.length, globalOffset: 0 }
        }
        return { msgs: newMsgs, startIdx: newStart, total: total || merged.length, filteredTotal: merged.length, serverFetchedFrom: (total || merged.length) - merged.length, globalOffset: 0 }
      })
    }

    const qs = `?project=${encodeURIComponent(projectDir)}&session=${encodeURIComponent(sessionId)}&tail=${INITIAL_TAIL}`
    const es = new EventSource(`/api/session-watch${qs}`)
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
      const newStart = Math.max(0, win.startIdx - adaptivePage(full, win.startIdx))
      const existingEnd = win.startIdx + win.msgs.length
      const newMsgs = full.slice(newStart, existingEnd)
      const trimmed = newMsgs.length > MAX_DOM ? newMsgs.slice(0, MAX_DOM) : newMsgs
      setWin({ ...win, msgs: trimmed, startIdx: newStart })
      return
    }

    if (win.globalOffset > 0 && win.serverFetchedFrom === 0) {
      setLoadingMore(true)
      try {
        const fetchCount = Math.min(CHUNK, win.globalOffset)
        const skip = win.filteredTotal - win.globalOffset
        const r = await fetch(sessionUrl(projectDir, sessionId, fetchCount, skip), { credentials: "include" })
        if (!r.ok) return
        const newMsgs: SessionMessage[] = await r.json()
        const newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
        const merged = [...newFiltered, ...full]
        fullRef.current = merged
        const newEnd = newFiltered.length + Math.min(win.msgs.length, MAX_DOM - newFiltered.length)
        setWin({
          ...win,
          msgs: merged.slice(0, Math.min(MAX_DOM, newEnd)),
          startIdx: 0,
          globalOffset: win.globalOffset - newFiltered.length,
          serverFetchedFrom: 0,
        })
      } catch { /* ignore */ }
      finally { setLoadingMore(false) }
      return
    }

    if (win.serverFetchedFrom <= 0) return
    setLoadingMore(true)
    try {
      const skip = win.total - win.serverFetchedFrom
      const t0 = performance.now()
      const r = await fetch(sessionUrl(projectDir, sessionId, CHUNK, skip), { credentials: "include" })
      if (!r.ok) return
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || win.total
      const newMsgs: SessionMessage[] = await r.json()
      markChunkLoad(sessionId!, newMsgs.length, skip, performance.now() - t0)
      const newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
      const merged = [...newFiltered, ...full]
      fullRef.current = merged
      const newServerFetchedFrom = Math.max(0, win.serverFetchedFrom - newMsgs.length)
      const newEnd = newFiltered.length + Math.min(win.msgs.length, MAX_DOM - newFiltered.length)
      setWin({
        msgs: merged.slice(0, Math.min(MAX_DOM, newEnd)),
        startIdx: 0,
        total: serverTotal,
        filteredTotal: win.filteredTotal,
        serverFetchedFrom: newServerFetchedFrom,
        globalOffset: win.globalOffset - newFiltered.length,
      })
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }

  async function loadLater() {
    if (!win) return
    const full = fullRef.current
    const currentEnd = win.startIdx + win.msgs.length

    if (currentEnd < full.length) {
      const newEnd = Math.min(full.length, currentEnd + CHUNK)
      const newMsgs = full.slice(win.startIdx, newEnd)
      if (newMsgs.length > MAX_DOM) {
        const trimStart = win.startIdx + (newMsgs.length - MAX_DOM)
        setWin({ ...win, msgs: full.slice(trimStart, newEnd), startIdx: trimStart })
      } else {
        setWin({ ...win, msgs: newMsgs })
      }
      return
    }

    if (win.globalOffset + full.length < win.filteredTotal && win.serverFetchedFrom === 0 && projectDir && sessionId) {
      setLoadingMore(true)
      try {
        const afterStart = win.globalOffset + full.length
        const remaining = win.filteredTotal - afterStart
        const fetchCount = Math.min(CHUNK, remaining)
        const skip = remaining - fetchCount
        const r = await fetch(sessionUrl(projectDir, sessionId, fetchCount, skip), { credentials: "include" })
        if (!r.ok) return
        const newMsgs: SessionMessage[] = await r.json()
        const newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
        const appended = [...full, ...newFiltered]
        fullRef.current = appended
        const newEnd = Math.min(appended.length, currentEnd + newFiltered.length)
        const newSlice = appended.slice(win.startIdx, newEnd)
        if (newSlice.length > MAX_DOM) {
          const trimStart = win.startIdx + (newSlice.length - MAX_DOM)
          setWin({ ...win, msgs: appended.slice(trimStart, newEnd), startIdx: trimStart })
        } else {
          setWin({ ...win, msgs: newSlice })
        }
      } catch { /* ignore */ }
      finally { setLoadingMore(false) }
    }
  }

  const bringMessageIndexIntoView = useCallback((targetFullRefIdx: number) => {
    setWin(prev => {
      if (!prev) return prev
      const full = fullRef.current
      if (targetFullRefIdx < 0 || targetFullRefIdx >= full.length) return prev
      if (targetFullRefIdx >= prev.startIdx && targetFullRefIdx < prev.startIdx + prev.msgs.length) return prev
      const half = Math.floor(MAX_DOM / 2)
      const newStart = Math.min(Math.max(0, targetFullRefIdx - half), Math.max(0, full.length - MAX_DOM))
      const end = Math.min(full.length, newStart + MAX_DOM)
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
      const half = Math.floor(MAX_DOM / 2)
      const newStart = Math.min(Math.max(0, targetIdx - half), Math.max(0, msgs.length - MAX_DOM))
      const newEnd = Math.min(msgs.length, newStart + MAX_DOM)
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
    hasEarlier,
    hasLater,
    loadEarlier,
    loadLater,
    fullRef,
    loadingEarlierRef,
    loadingLaterRef,
    chatDir,
    bringMessageIndexIntoView,
    jumpToUuid,
    newMsgUuids,
  }
}
