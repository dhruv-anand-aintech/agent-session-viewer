import { useState } from "react"
import type { SessionMessage, ContentBlock } from "./types"

/** Session platform (e.g. from SessionMeta.source) — drives assistant label in raw mode. */
function assistantLabelForSource(source?: string): string {
  switch (source ?? "claude") {
    case "cursor":
      return "Cursor"
    case "opencode":
      return "OpenCode"
    case "antigravity":
      return "Antigravity"
    case "hermes":
      return "Hermes"
    case "claude":
      return "Claude"
    default:
      return source && source.length > 0
        ? source.charAt(0).toUpperCase() + source.slice(1)
        : "Claude"
  }
}

interface Props {
  msg: SessionMessage
  index: number
  nextMsg?: SessionMessage
  /** Session platform from sidebar; defaults to Claude Code. */
  source?: string
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = text.slice(0, 120).replace(/\n/g, " ")
  return (
    <div className="thinking-block">
      <button className="fold-btn" onClick={() => setOpen(!open)}>
        <span className="fold-icon">{open ? "▼" : "▶"}</span>
        <span className="fold-label">Thinking</span>
        {!open && <span className="fold-preview"> — {preview}{text.length > 120 ? "…" : ""}</span>}
      </button>
      {open && <pre className="block-body thinking-body">{text}</pre>}
    </div>
  )
}

function ToolBlock({ block, isResult }: { block: ContentBlock; isResult?: boolean }) {
  const [open, setOpen] = useState(false)
  const label = isResult
    ? `Tool Result: ${block.tool_use_id?.slice(0, 8) ?? "?"}`
    : `Tool: ${block.name ?? "?"}`
  const body = isResult
    ? (typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2))
    : JSON.stringify(block.input, null, 2)
  const preview = String(body ?? "").slice(0, 100).replace(/\n/g, " ")

  return (
    <div className={`tool-block ${isResult ? "tool-result" : "tool-call"}`}>
      <button className="fold-btn" onClick={() => setOpen(!open)}>
        <span className="fold-icon">{open ? "▼" : "▶"}</span>
        <span className="fold-label">{label}</span>
        {!open && <span className="fold-preview"> — {preview}…</span>}
      </button>
      {open && <pre className="block-body tool-body">{body}</pre>}
    </div>
  )
}

function AssistantContent({ content }: { content: string | ContentBlock[] }) {
  if (typeof content === "string") {
    return <div className="text-body">{content}</div>
  }
  return (
    <div className="content-blocks">
      {content.map((block, i) => {
        if (block.type === "thinking") {
          return <ThinkingBlock key={i} text={block.thinking ?? ""} />
        }
        if (block.type === "tool_use") {
          return <ToolBlock key={i} block={block} />
        }
        if (block.type === "tool_result") {
          return <ToolBlock key={i} block={block} isResult />
        }
        if (block.type === "text" && block.text) {
          return <div key={i} className="text-body">{block.text}</div>
        }
        return null
      })}
    </div>
  )
}

function UserContent({ content }: { content: string | ContentBlock[] }) {
  if (typeof content === "string") return <div className="text-body user-text">{content}</div>
  return (
    <div className="content-blocks">
      {content.map((block, i) => {
        if (block.type === "tool_result") {
          return <ToolBlock key={i} block={block} isResult />
        }
        if (block.type === "text" && block.text) {
          return <div key={i} className="text-body user-text">{block.text}</div>
        }
        return null
      })}
    </div>
  )
}

function ProgressBlock({ msg }: { msg: SessionMessage }) {
  const [open, setOpen] = useState(false)
  const label = msg.data?.hookName ?? msg.data?.type ?? "progress"
  return (
    <div className="progress-block">
      <button className="fold-btn" onClick={() => setOpen(!open)}>
        <span className="fold-icon">{open ? "▼" : "▶"}</span>
        <span className="fold-label progress-label">⚙ {label}</span>
      </button>
      {open && <pre className="block-body progress-body">{JSON.stringify(msg.data, null, 2)}</pre>}
    </div>
  )
}

export default function MessageBlock({ msg, source }: Props) {
  if (msg.type === "file-history-snapshot") return null
  if (msg.type === "progress") return <ProgressBlock msg={msg} />

  const role = msg.message?.role
  if (!role || !msg.message) return null

  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""

  return (
    <div
      className={`message-row ${role}`}
      {...(role === "user" ? { "data-user-turn": "true" } : {})}
      {...(role === "assistant" ? { "data-platform": (source ?? "claude").toLowerCase() } : {})}
    >
      <div className="message-header">
        <span className="role-badge">{role === "user" ? "User" : assistantLabelForSource(source)}</span>
        {ts && <span className="timestamp">{ts}</span>}
      </div>
      <div className="message-content">
        {role === "assistant"
          ? <AssistantContent content={msg.message.content} />
          : <UserContent content={msg.message.content} />}
      </div>
    </div>
  )
}
