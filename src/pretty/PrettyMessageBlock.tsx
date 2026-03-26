import { useState, useMemo } from "react"
import { marked } from "marked"
import type { SessionMessage, ContentBlock } from "../types"
import { stripXml, linkifyPaths, classifyTool, TOOL_META, charCount } from "./utils"
import "./pretty.css"

// Configure marked for inline-friendly rendering
marked.setOptions({ breaks: true, gfm: true })

// ── Primitives ────────────────────────────────────────────────────────────────

function PathSpan({ text }: { text: string }) {
  const parts = linkifyPaths(text)
  return (
    <>
      {parts.map((p, i) =>
        p.type === "path"
          ? <span key={i} className="pp-path-chip" title={p.value}>{p.value.split("/").pop()}</span>
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
  return <div className="pp-markdown" dangerouslySetInnerHTML={{ __html: html }} />
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
  const cmd = String(input.command ?? "")
  const desc = String(input.description ?? "")
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
          <pre className="pp-bash-full-cmd">{cmd}</pre>
          {result && <pre className="pp-bash-result">{result.slice(0, 3000)}{result.length > 3000 ? "\n…[truncated]" : ""}</pre>}
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
      {open && result && <pre className="pp-file-body">{result.slice(0, 4000)}{result.length > 4000 ? "\n…[truncated]" : ""}</pre>}
    </div>
  )
}

function FileWriteCard({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const path = String(input.file_path ?? input.path ?? "")
  const filename = path.split("/").pop() ?? path
  const content = String(input.content ?? "")
  return (
    <div className="pp-tool-card pp-file-write">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">✍️</span>
        <span className="pp-file-name">{filename}</span>
        <span className="pp-file-path-muted">{path.replace(filename, "")}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && <pre className="pp-file-body">{content.slice(0, 4000)}{content.length > 4000 ? "\n…[truncated]" : ""}</pre>}
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
  const query = String(input.pattern ?? input.query ?? input.glob ?? "")
  return (
    <div className="pp-tool-card pp-search" style={{ "--tool-color": meta.color } as React.CSSProperties}>
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">{meta.icon}</span>
        <span className="pp-tool-label">{meta.label}</span>
        <code className="pp-search-query">{query.slice(0, 60)}</code>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && result && <pre className="pp-file-body">{result.slice(0, 3000)}</pre>}
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
      {open && result && <pre className="pp-file-body">{result.slice(0, 4000)}</pre>}
    </div>
  )
}

function AgentCard({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const desc = String(input.description ?? "")
  const prompt = String(input.prompt ?? "")
  return (
    <div className="pp-tool-card pp-agent">
      <div className="pp-tool-header" onClick={() => setOpen(!open)}>
        <span className="pp-tool-icon">🤖</span>
        <span className="pp-tool-label">Agent</span>
        <span className="pp-tool-desc">{desc.slice(0, 60)}{desc.length > 60 ? "…" : ""}</span>
        <span className="pp-fold-arrow">{open ? "▾" : "▸"}</span>
      </div>
      {open && <pre className="pp-file-body">{prompt.slice(0, 2000)}</pre>}
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
          <pre className="pp-bash-full-cmd">{JSON.stringify(input, null, 2)}</pre>
          {result && <pre className="pp-bash-result">{result.slice(0, 3000)}</pre>}
        </div>
      )}
    </div>
  )
}

// ── Tool card dispatcher ──────────────────────────────────────────────────────

function ToolCard({ block, resultMap }: { block: ContentBlock; resultMap: Map<string, string> }) {
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
  if (cat === "agent") return <AgentCard input={input} />
  return <GenericMcpCard name={name} input={input} result={result} />
}

// ── Collapsible message wrapper ───────────────────────────────────────────────

const COLLAPSE_THRESHOLD = 1200 // chars above which we offer a collapse button

function CollapsibleMessage({ charLen, children }: { charLen: number; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(charLen > COLLAPSE_THRESHOLD)
  if (charLen <= COLLAPSE_THRESHOLD) return <>{children}</>
  return (
    <div className={`pp-collapsible${collapsed ? " pp-collapsed" : ""}`}>
      {children}
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

function AssistantMessage({ content, nextMsg, timestamp }: { content: string | ContentBlock[]; nextMsg?: SessionMessage; timestamp?: string }) {
  // Tool results live in the NEXT user message — merge both sources
  const nextContent = Array.isArray(nextMsg?.message?.content) ? nextMsg.message.content as ContentBlock[] : []

  if (typeof content === "string") {
    const len = charCount(content)
    return (
      <div className="pp-assistant-row" style={{ position: "relative" }}>
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
    <div className="pp-assistant-row" style={{ position: "relative" }}>
      {timestamp && <span className="pp-timestamp">{timestamp}</span>}
      <CollapsibleMessage charLen={totalLen}>
        <div className="pp-assistant-bubble">
          {blocks.map((b, i) => {
            if (b.type === "thinking") return <ThinkingCard key={i} text={b.thinking ?? ""} />
            if (b.type === "tool_use") return <ToolCard key={i} block={b} resultMap={resultMap} />
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
    <div className="pp-user-row" data-user-turn="true" style={{ position: "relative" }}>
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

// ── Main export ───────────────────────────────────────────────────────────────

export default function PrettyMessageBlock({ msg, nextMsg }: { msg: SessionMessage; nextMsg?: SessionMessage }) {
  if (msg.type === "file-history-snapshot") return null
  if (msg.type === "progress") return null  // hide progress events in pretty mode
  const role = msg.message?.role
  if (!role || !msg.message) return null

  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""

  if (msg.isSidechain) {
    return (
      <div className="pp-subagent-row" style={{ position: "relative" }}>
        {ts && <span className="pp-timestamp">{ts}</span>}
        <div className="pp-subagent-label">⤷ sub-agent</div>
        <div className="pp-subagent-body">
          {role === "user"
            ? <UserMessage content={msg.message.content} />
            : <AssistantMessage content={msg.message.content} nextMsg={nextMsg} />}
        </div>
      </div>
    )
  }

  if (role === "user") return <UserMessage content={msg.message.content} timestamp={ts} />
  return <AssistantMessage content={msg.message.content} nextMsg={nextMsg} timestamp={ts} />
}

export function charCountMsg(msg: SessionMessage): number {
  return charCount(msg.message?.content ?? "")
}
