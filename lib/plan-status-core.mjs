function parseInput(input) {
  if (input && typeof input === "object") return input
  if (typeof input !== "string") return {}
  try { return JSON.parse(input) } catch { return {} }
}

function normalizeStatus(value) {
  const status = String(value ?? "pending").toLowerCase().replaceAll("-", "_")
  if (["completed", "complete", "done"].includes(status)) return "complete"
  if (["in_progress", "active", "running", "doing"].includes(status)) return "running"
  if (["failed", "blocked", "cancelled", "canceled"].includes(status)) return "failed"
  return "idle"
}

function planItemsFromTool(name, input) {
  const parsed = parseInput(input)
  if (name === "update_plan") {
    return (Array.isArray(parsed.plan) ? parsed.plan : []).map((item, index) => ({
      id: `plan-${index}`,
      label: String(item?.step ?? item?.content ?? "Untitled plan item"),
      status: normalizeStatus(item?.status),
    }))
  }
  if (["todowrite", "todo_write", "todos"].includes(name)) {
    return (Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed.items) ? parsed.items : []).map((item, index) => ({
      id: `todo-${index}`,
      label: String(item?.content ?? item?.step ?? item?.text ?? "Untitled todo"),
      status: normalizeStatus(item?.status),
    }))
  }
  return []
}

export function extractLatestPlan(messages) {
  for (let messageIndex = (messages?.length ?? 0) - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    const content = message?.message?.content
    if (!Array.isArray(content)) continue
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex]
      if (block?.type !== "tool_use") continue
      const name = String(block.name ?? "").toLowerCase()
      const items = planItemsFromTool(name, block.input)
      if (items.length) {
        return {
          tool: name,
          timestamp: message.timestamp ?? null,
          items,
        }
      }
    }
  }
  return null
}
