export type MessageRole = "user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "system" | "progress"

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image"
  text?: string
  thinking?: string
  name?: string        // tool name
  input?: unknown      // tool input
  content?: unknown    // tool result content
  tool_use_id?: string
  id?: string
}

export interface SessionMessage {
  uuid: string
  parentUuid: string | null
  type: "human" | "assistant" | "progress" | "file-history-snapshot" | string
  sessionId: string
  cwd?: string
  version?: string
  timestamp?: string
  message?: {
    role: "user" | "assistant"
    content: string | ContentBlock[]
  }
  data?: {
    type: string
    hookEvent?: string
    hookName?: string
    [key: string]: unknown
  }
  toolUseResult?: unknown
  isSidechain?: boolean
  gitBranch?: string
}

export interface Session {
  id: string
  projectPath: string
  messages: SessionMessage[]
  lastActivity: string
  version?: string
  gitBranch?: string
  isActive: boolean
}

export interface Project {
  path: string
  displayName: string
  sessions: Session[]
}
