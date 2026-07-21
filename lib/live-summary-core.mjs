const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60_000

function messageRole(message) {
  const role = message?.message?.role ?? message?.role ?? message?.type
  if (role === "human") return "user"
  return role === "user" || role === "assistant" ? role : null
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(block => {
    if (typeof block === "string") return block
    if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") return block.text ?? ""
    return ""
  }).filter(Boolean).join("\n")
}

export function stripTranscriptText(message) {
  const raw = contentText(message?.message?.content ?? message?.content ?? message?.text)
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function isActivelyUpdating(entry, now = Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS) {
  const timestamp = Date.parse(entry?.lastActivity ?? entry?.mtime ?? "")
  return Number.isFinite(timestamp) && now - timestamp <= activeWindowMs
}

export function buildLiveSessionPreview(entry, messages, options = {}) {
  const conversational = (Array.isArray(messages) ? messages : [])
    .map(message => ({ role: messageRole(message), text: stripTranscriptText(message), timestamp: message?.timestamp ?? null }))
    .filter(message => message.role && message.text)
  const latestUser = conversational.findLast(message => message.role === "user")
  const latestAssistant = conversational.findLast(message => message.role === "assistant")
  const maxPreviewChars = options.maxPreviewChars ?? 1200
  const clipUser = (text) => text.length > maxPreviewChars ? `${text.slice(0, maxPreviewChars)}…` : text
  const clipAssistant = (text) => text.length > maxPreviewChars
    ? `${text.slice(0, Math.floor(maxPreviewChars * .7))} … ${text.slice(-Math.floor(maxPreviewChars * .3))}`
    : text
  return {
    sessionId: entry.id,
    projectPath: entry.projectPath,
    source: entry.source ?? "claude",
    title: entry.customName || entry.firstName || entry.id.slice(0, 8),
    lastActivity: entry.lastActivity ?? entry.mtime ?? null,
    latestUser: latestUser ? clipUser(latestUser.text) : "No recent user message",
    assistantTail: latestAssistant ? clipAssistant(latestAssistant.text) : "No assistant response yet",
    messages: conversational.slice(-(options.maxMessages ?? 14)),
  }
}

export function compressLiveSummaryContext(sessions, maxChars = 32_000) {
  const sections = (Array.isArray(sessions) ? sessions : []).map(session => {
    const header = [
      `SESSION ${session.title}`,
      `source=${session.source}`,
      `project=${session.projectPath}`,
      `id=${session.sessionId}`,
      session.lastActivity ? `last_activity=${session.lastActivity}` : null,
    ].filter(Boolean).join(" | ")
    const transcript = (session.messages ?? []).map(message => `${message.role.toUpperCase()}: ${message.text}`).join("\n")
    return `${header}\n${transcript}`
  })
  let context = sections.join("\n\n---\n\n")
  if (context.length > maxChars) context = `[older compressed context omitted]\n${context.slice(-maxChars)}`
  return context
}

export function openAILiveSummaryBody(context, model = "gpt-5.6-luna") {
  return {
    model,
    instructions: [
      "Summarize current coding-agent work using only the supplied transcript evidence.",
      "Return exactly two Markdown headings: Completed and Remaining.",
      "Under each heading use terse, concrete bullet points.",
      "Attempted, proposed, failed, interrupted, or unverified work belongs under Remaining.",
      "Treat each session's final ASSISTANT turn as high-priority evidence: preserve its concrete completed items and explicitly surface any stated current or next action.",
      "Do not add an introduction or conclusion.",
    ].join(" "),
    input: context,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
    max_output_tokens: 650,
    stream: true,
    store: false,
  }
}

export function openAIStreamDelta(eventName, payload) {
  if (eventName === "response.output_text.delta" && typeof payload?.delta === "string") return payload.delta
  return ""
}
