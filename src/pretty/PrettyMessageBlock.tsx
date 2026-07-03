import { useState, useMemo, useEffect, useRef, memo } from "react"
import type { ReactNode } from "react"
import { marked } from "marked"
import type { SessionMessage, ContentBlock } from "../types"
import { stripXml, linkifyPaths, classifyTool, TOOL_META, charCount } from "./utils"
import "./pretty.css"

// Configure marked for inline-friendly rendering
marked.setOptions({ breaks: true, gfm: true })

// ── Primitives ────────────────────────────────────────────────────────────────

function LazyRender({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (ready) return
    const el = ref.current
    if (!el || !("IntersectionObserver" in window)) {
      setReady(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setReady(true)
        observer.disconnect()
      },
      { rootMargin: "900px 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ready])

  return <div ref={ref}>{ready ? children : fallback}</div>
}

function openPath(path: string) {
  fetch(`/api/open?path=${encodeURIComponent(path)}`, { method: "POST", credentials: "include" }).catch(() => {})
}

function PathSpan({ text }: { text: string }) {
  const parts = linkifyPaths(text)
  return (
    <>
      {parts.map((p, i) =>
        p.type === "path"
          ? <span key={i} className="pp-path-chip pp-path-chip--link" title={p.value} onClick={() => openPath(p.value)}>{p.value.split("/").pop()}</span>
          : <span key={i}>{p.value}</span>
      )}
    </>
  )
}

function TextContent({ text }: { text: string }) {
  return (
    <p className="pp-text">
      <PathSpan text={text} />
    </p>
  )
}

function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text])
  return (
    <LazyRender fallback={<div className="pp-markdown pp-markdown-placeholder">{text.slice(0, 360)}</div>}>
      <div className="pp-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </LazyRender>
  )
}

function LazyPre({ className, children }: { className: string; children: string | string[] }) {
  const text = Array.isArray(children) ? children.join("") : children
  return (
    <LazyRender fallback={<pre className={`${className} pp-pre-placeholder`}>{text.slice(0, 240)}</pre>}>
      <pre className={className}>{text}</pre>
    </LazyRender>
  )
}

// ── Thinking block ────────────────────────────────────────────────────────────

function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button className={`pp-thinking-pill ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
      <span className="pp-thinking-icon">🧠</span>
      <span className="pp-thinking-label">Thinking</span>
      {open
        ? <span className="pp-thinking-body">{text}</span>
        : <span className="pp-thinking-preview">{text.slice(0, 80).replace(/\n/g, " ")}…</span>}
    </button>
  )
}

// ── Tool cards ────────────────────────────────────────────────────────────────

function BashCard({ input, result }: { input: Record<string, unknown>; result?: string }) {
  const [open, setOpen] = useState(false)
  const cmd = String(input.command ?? input.cmd ?? "")
  const desc = String(input.description ?? input.justification ?? "")
  return (
    <div className="pp-tool-card pp-bash">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">›_</span>
        <code className="pp-bash-cmd">{cmd.slice(0, 80)}{cmd.length > 80 ? "…" : ""}</code>
        {desc && <span className="pp-tool-desc">{desc}</span>}
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="pp-bash-body">
          <LazyPre className="pp-bash-full-cmd">{cmd}</LazyPre>
          {result && <LazyPre className="pp-bash-result">{result.slice(0, 3000)}{result.length > 3000 ? "\n…[truncated]" : ""}</LazyPre>}
        </div>
      )}
    </div>
  )
}

function FileReadCard({ input, result }: { input: Record<string, unknown>; result?: string }) {
  const [open, setOpen] = useState(false)
  const path = String(input.file_path ?? input.path ?? "")
  const filename = path.split("/").pop() ?? path
  return (
    <div className="pp-tool-card pp-file-read">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">📄</span>
        <span className="pp-file-name">{filename}</span>
        <span className="pp-file-path-muted">{path.replace(filename, "")}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && result && <LazyPre className="pp-file-body">{result.slice(0, 4000)}{result.length > 4000 ? "\n…[truncated]" : ""}</LazyPre>}
    </div>
  )
}

function tryFormatMaybeJson(s: string): string {
  const t = s.trim()
  if (!t || (t[0] !== "{" && t[0] !== "[")) return s
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return s
  }
}

function FileWriteCard({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const pathsArr = Array.isArray(input.paths)
    ? (input.paths as unknown[]).filter((p): p is string => typeof p === "string")
    : []
  const primaryPath = String(input.file_path ?? input.path ?? pathsArr[0] ?? "").trim() || "(no path)"
  const filename = primaryPath.includes("/") ? primaryPath.split("/").pop() ?? primaryPath : primaryPath
  const dirPart =
    primaryPath.length > filename.length
      ? primaryPath.slice(0, Math.max(0, primaryPath.length - filename.length))
      : ""
  const extraPathCount = pathsArr.length > 1 ? pathsArr.length - 1 : 0
  const rawContent = String(input.contents ?? input.content ?? "")
  const displayContent = tryFormatMaybeJson(rawContent)
  return (
    <div className="pp-tool-card pp-file-write">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">✍️</span>
        <span className="pp-file-name">{filename}</span>
        {extraPathCount > 0 && (
          <span className="pp-write-more-paths" title={pathsArr.join("\n")}>
            +{extraPathCount} file{extraPathCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="pp-file-path-muted">{dirPart}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && <LazyPre className="pp-file-body">{displayContent.slice(0, 4000)}{displayContent.length > 4000 ? "\n…[truncated]" : ""}</LazyPre>}
    </div>
  )
}

function FileEditCard({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const path = String(input.file_path ?? input.path ?? "")
  const filename = path.split("/").pop() ?? path
  const oldStr = String(input.old_string ?? "")
  const newStr = String(input.new_string ?? "")
  return (
    <div className="pp-tool-card pp-file-edit">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">✏️</span>
        <span className="pp-file-name">{filename}</span>
        <span className="pp-file-path-muted">{path.replace(filename, "")}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="pp-diff-body">
          {oldStr && <pre className="pp-diff-del">- {oldStr.slice(0, 2000)}</pre>}
          {newStr && <pre className="pp-diff-add">+ {newStr.slice(0, 2000)}</pre>}
        </div>
      )}
    </div>
  )
}

function SearchCard({ name, input, result }: { name: string; input: Record<string, unknown>; result?: string }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[classifyTool(name)]
  const query = String(input.pattern ?? input.query ?? input.glob ?? input.target_directory ?? "")
  return (
    <div className="pp-tool-card pp-search" style={{ "--tool-color": meta.color } as React.CSSProperties}>
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">{meta.icon}</span>
        <span className="pp-tool-label">{meta.label}</span>
        <code className="pp-search-query">{query.slice(0, 60)}</code>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && result && <LazyPre className="pp-file-body">{result.slice(0, 3000)}</LazyPre>}
    </div>
  )
}

function WebCard({ name, input, result }: { name: string; input: Record<string, unknown>; result?: string }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[classifyTool(name)]
  const url = String(input.url ?? input.query ?? "")
  return (
    <div className="pp-tool-card pp-web" style={{ "--tool-color": meta.color } as React.CSSProperties}>
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">{meta.icon}</span>
        <span className="pp-tool-label">{meta.label}</span>
        <span className="pp-web-url">{url.slice(0, 60)}{url.length > 60 ? "…" : ""}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && result && <LazyPre className="pp-file-body">{result.slice(0, 4000)}</LazyPre>}
    </div>
  )
}

function parseSpawnAgentResult(result?: string): { agentId?: string; nickname?: string; error?: string } | null {
  if (!result?.trim()) return null
  try {
    const parsed = JSON.parse(result) as { agent_id?: string; nickname?: string }
    if (parsed.agent_id) return { agentId: parsed.agent_id, nickname: parsed.nickname }
  } catch { /* plain-text error */ }
  if (/failed|error/i.test(result)) return { error: result.trim() }
  return null
}

function AgentCard({
  name,
  input,
  result,
  projectPath,
}: {
  name: string
  input: Record<string, unknown>
  result?: string
  projectPath?: string
}) {
  const [open, setOpen] = useState(false)
  const isSpawn = name === "spawn_agent"
  const desc = String(input.description ?? input.message ?? input.prompt ?? "")
  const prompt = String(input.prompt ?? input.message ?? "")
  const spawn = isSpawn ? parseSpawnAgentResult(result) : null
  const sessionHref = spawn?.agentId && projectPath
    ? `/sessions?s=${encodeURIComponent(`${projectPath}/${spawn.agentId}`)}`
    : null
  const headerLabel = isSpawn ? "Spawn sub-agent" : "Agent"
  const headerDesc = spawn?.nickname
    ? spawn.nickname
    : spawn?.error
      ? spawn.error.slice(0, 60)
      : desc.slice(0, 60) + (desc.length > 60 ? "…" : "")
  return (
    <div className="pp-tool-card pp-agent">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">🤖</span>
        <span className="pp-tool-label">{headerLabel}</span>
        <span className="pp-tool-desc">{headerDesc}</span>
        {sessionHref && (
          <a
            className="pp-agent-link"
            href={sessionHref}
            onClick={e => e.stopPropagation()}
            title="Open sub-agent session"
          >
            ⤷
          </a>
        )}
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="pp-bash-body">
          {prompt && <LazyPre className="pp-file-body">{prompt.slice(0, 2000)}</LazyPre>}
          {spawn?.agentId && (
            <div className="pp-agent-spawn-meta">
              {spawn.nickname && <span>{spawn.nickname}</span>}
              <code>{spawn.agentId}</code>
              {sessionHref && <a href={sessionHref}>Open session →</a>}
            </div>
          )}
          {spawn?.error && <LazyPre className="pp-bash-result">{spawn.error}</LazyPre>}
          {!isSpawn && result && <LazyPre className="pp-bash-result">{result.slice(0, 3000)}</LazyPre>}
        </div>
      )}
    </div>
  )
}

function GenericMcpCard({ name, input, result }: { name: string; input: Record<string, unknown>; result?: string }) {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[classifyTool(name)]
  const shortName = name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")
  return (
    <div className="pp-tool-card pp-mcp" style={{ "--tool-color": meta.color } as React.CSSProperties}>
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">{meta.icon}</span>
        <span className="pp-tool-label">{meta.label}</span>
        <span className="pp-tool-desc">{shortName}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="pp-bash-body">
          <LazyPre className="pp-bash-full-cmd">{JSON.stringify(input, null, 2)}</LazyPre>
          {result && <LazyPre className="pp-bash-result">{result.slice(0, 3000)}</LazyPre>}
        </div>
      )}
    </div>
  )
}

// ── Tool card dispatcher ──────────────────────────────────────────────────────

function ToolCard({
  block,
  resultMap,
  projectPath,
}: {
  block: ContentBlock
  resultMap: Map<string, string>
  projectPath?: string
}) {
  const name = block.name ?? ""
  const input = (block.input ?? {}) as Record<string, unknown>
  const result = block.id ? resultMap.get(block.id) : undefined
  const cat = classifyTool(name)

  if (cat === "bash") return <BashCard input={input} result={result} />
  if (cat === "read") return <FileReadCard input={input} result={result} />
  if (cat === "write") return <FileWriteCard input={input} />
  if (cat === "edit") return <FileEditCard input={input} />
  if (cat === "glob" || cat === "grep") return <SearchCard name={name} input={input} result={result} />
  if (cat === "web-search" || cat === "web-fetch") return <WebCard name={name} input={input} result={result} />
  if (cat === "agent") return <AgentCard name={name} input={input} result={result} projectPath={projectPath} />
  return <GenericMcpCard name={name} input={input} result={result} />
}

// ── Collapsible message wrapper ───────────────────────────────────────────────

const COLLAPSE_THRESHOLD = 1200 // chars above which we offer a collapse button

function CollapsibleMessage({ charLen, children }: { charLen: number; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(charLen > COLLAPSE_THRESHOLD)
  if (charLen <= COLLAPSE_THRESHOLD) return <>{children}</>
  return (
    <div className={`pp-collapsible${collapsed ? " pp-collapsed" : ""}`}>
      <div className="pp-collapsible-body">{children}</div>
      <button className="pp-collapse-btn" onClick={() => setCollapsed(c => !c)}>
        {collapsed ? `▼ show full message (${Math.round(charLen / 1000)}k chars)` : "▲ collapse"}
      </button>
    </div>
  )
}

// ── Message blocks ────────────────────────────────────────────────────────────

function buildResultMap(content: ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const b of content) {
    if (b.type === "tool_result" && b.tool_use_id) {
      const val = typeof b.content === "string" ? b.content : JSON.stringify(b.content)
      map.set(b.tool_use_id, val)
    }
  }
  return map
}

function AssistantMessage({
  content,
  nextMsg,
  timestamp,
  projectPath,
}: {
  content: string | ContentBlock[]
  nextMsg?: SessionMessage
  timestamp?: string
  projectPath?: string
}) {
  // Tool results live in the NEXT user message — merge both sources
  const nextContent = Array.isArray(nextMsg?.message?.content) ? nextMsg.message.content as ContentBlock[] : []

  if (typeof content === "string") {
    const len = charCount(content)
    return (
      <div className="pp-assistant-row" title={timestamp || undefined}>
        {timestamp && <span className="pp-timestamp">{timestamp}</span>}
        <CollapsibleMessage charLen={len}>
          <div className="pp-assistant-text"><MarkdownContent text={content} /></div>
        </CollapsibleMessage>
      </div>
    )
  }

  // Build result map from both same-message tool_results (rare) and next-message tool_results
  const resultMap = new Map([...buildResultMap(content), ...buildResultMap(nextContent)])
  const blocks = content.filter(b => b.type !== "tool_result")
  const totalLen = blocks.reduce((s, b) => s + (b.type === "text" ? (b.text?.length ?? 0) : 0), 0)

  return (
    <div className="pp-assistant-row" title={timestamp || undefined}>
      {timestamp && <span className="pp-timestamp">{timestamp}</span>}
      <CollapsibleMessage charLen={totalLen}>
        <div className="pp-assistant-bubble">
          {blocks.map((b, i) => {
            if (b.type === "thinking") return <ThinkingCard key={i} text={b.thinking ?? ""} />
            if (b.type === "tool_use") return <ToolCard key={i} block={b} resultMap={resultMap} projectPath={projectPath} />
            if (b.type === "text" && b.text) return <div key={i} className="pp-assistant-text"><MarkdownContent text={b.text} /></div>
            return null
          })}
        </div>
      </CollapsibleMessage>
    </div>
  )
}

// Parse "**SenderName**: message" pattern used by nanoclaw
function parseSender(text: string): { sender: string | null; body: string } {
  const m = text.match(/^\*\*([^*]+)\*\*:\s*([\s\S]*)$/)
  return m ? { sender: m[1], body: m[2] } : { sender: null, body: text }
}

function UserMessage({ content, timestamp }: { content: string | ContentBlock[]; timestamp?: string }) {
  const texts: string[] = []

  if (typeof content === "string") {
    texts.push(stripXml(content))
  } else {
    for (const b of content) {
      if (b.type === "text" && b.text) texts.push(stripXml(b.text))
    }
  }

  const combined = texts.join("\n").trim()
  if (!combined) return null

  const { sender, body } = parseSender(combined)

  return (
    <div className="pp-user-row" data-user-turn="true" title={timestamp || undefined}>
      {timestamp && <span className="pp-timestamp">{timestamp}</span>}
      <CollapsibleMessage charLen={combined.length}>
        <div className="pp-user-bubble">
          {sender && <span className="pp-sender-chip">{sender}</span>}
          <TextContent text={body} />
        </div>
      </CollapsibleMessage>
    </div>
  )
}

// ── System / meta message rows ────────────────────────────────────────────────

function getRawText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content.filter(b => b.type === "text").map(b => (b as { text?: string }).text ?? "").join("")
}

function SystemRow({ label, summary, timestamp }: { label: string; summary: string; timestamp?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pp-system-row" title={timestamp || undefined} onClick={() => setOpen(o => !o)}>
      {timestamp && <span className="pp-timestamp">{timestamp}</span>}
      <span className="pp-system-icon">⚙</span>
      <span className="pp-system-label">{label}</span>
      {open
        ? <span className="pp-system-body">{summary}</span>
        : <span className="pp-system-preview">{summary.slice(0, 80).replace(/\n/g, " ")}{summary.length > 80 ? "…" : ""}</span>}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export default memo(function PrettyMessageBlock({
  msg,
  index,
  nextMsg,
  projectPath,
}: {
  msg: SessionMessage
  index?: number
  nextMsg?: SessionMessage
  source?: string
  projectPath?: string
}) {
  if (msg.type === "file-history-snapshot") return null
  if (msg.type === "progress") return null  // hide progress events in pretty mode
  const role = msg.message?.role
  if (!role || !msg.message) return null

  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""
  const tsTitle = [ts, index != null ? `#${index + 1}` : null].filter(Boolean).join(" · ")

  // Detect task-notification and system-reminder injections in user messages
  if (role === "user") {
    const raw = getRawText(msg.message.content)
    const taskMatch = raw.match(/<task-notification[\s\S]*?<summary>([\s\S]*?)<\/summary>/)
    if (taskMatch) return <SystemRow label="task notification" summary={taskMatch[1].trim()} timestamp={tsTitle} />
    const reminderMatch = raw.match(/<system-reminder>([\s\S]*?)<\/system-reminder>/)
    if (reminderMatch) return <SystemRow label="system reminder" summary={reminderMatch[1].trim()} timestamp={tsTitle} />
  }

  if (msg.isSidechain) {
    return (
      <div className="pp-subagent-row" title={tsTitle || undefined}>
        {ts && <span className="pp-timestamp">{tsTitle}</span>}
        <div className="pp-subagent-label">⤷ sub-agent</div>
        <div className="pp-subagent-body">
          {role === "user"
            ? <UserMessage content={msg.message.content} />
            : <AssistantMessage content={msg.message.content} nextMsg={nextMsg} projectPath={projectPath} />}
        </div>
      </div>
    )
  }

  if (role === "user") return <UserMessage content={msg.message.content} timestamp={tsTitle} />
  return <AssistantMessage content={msg.message.content} nextMsg={nextMsg} timestamp={tsTitle} projectPath={projectPath} />
})

export function charCountMsg(msg: SessionMessage): number {
  return charCount(msg.message?.content ?? "")
}
