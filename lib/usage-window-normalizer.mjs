export function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function clampPercent(value) {
  const number = toNumber(value)
  if (number == null) return null
  return Math.min(100, Math.max(0, number))
}

export function normalizeResetTime(value, now = Date.now()) {
  if (value == null || value === "") return null
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return normalizeResetTime(numeric, now)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  if (value > 1_000_000_000_000) return new Date(value).toISOString()
  if (value > 1_000_000_000) return new Date(value * 1000).toISOString()
  return new Date(now + value * 1000).toISOString()
}

export function resetDescription(resetsAt) {
  if (!resetsAt) return ""
  const parsed = Date.parse(resetsAt)
  if (!Number.isFinite(parsed)) return String(resetsAt)
  const diffMs = parsed - Date.now()
  if (diffMs <= 0) return "reset due"
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours < 48) return mins ? `resets in ${hours}h ${mins}m` : `resets in ${hours}h`
  return `resets ${new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}

function normalizeWindow(raw, fallbackWindowMinutes = null, options = {}) {
  if (!raw) return null
  const windowSeconds = toNumber(raw.limit_window_seconds ?? raw.window_duration_seconds)
  const windowMinutes = toNumber(raw.windowMinutes ?? raw.window_duration_mins ?? raw.windowDurationMins)
    ?? (windowSeconds != null ? Math.round(windowSeconds / 60) : fallbackWindowMinutes)
  const usedFromRemaining = raw.remaining_percent ?? raw.remainingPercent
  const usedPercent = clampPercent(
    raw.usedPercent ?? raw.used_percent ?? raw.utilization ?? (
      usedFromRemaining != null ? 100 - Number(usedFromRemaining) : null
    ),
  )
  if (usedPercent == null) return null
  const resetsAt = normalizeResetTime(
    raw.resetsAt ?? raw.resets_at ?? raw.resetAt ?? raw.reset_at ?? raw.reset_after_seconds ?? raw.resetAfterSeconds,
    options.now,
  )
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: windowMinutes ?? null,
    resetsAt,
    resetDescription: raw.resetDescription ?? raw.reset_description ?? raw.resets ?? resetDescription(resetsAt),
  }
}

function windowRole(window) {
  if (!window) return "unknown"
  if (window.windowMinutes === 300) return "session"
  if (window.windowMinutes === 10080) return "weekly"
  return "unknown"
}

export function normalizePrimarySecondaryWindows(primaryRaw, secondaryRaw, options = {}) {
  const primary = normalizeWindow(primaryRaw, null, options)
  const secondary = normalizeWindow(secondaryRaw, null, options)
  if (primary && secondary) {
    const first = windowRole(primary)
    const second = windowRole(secondary)
    if (first === "weekly" && (second === "session" || second === "unknown")) {
      return { primary: secondary, secondary: primary }
    }
    return { primary, secondary }
  }
  if (primary) {
    return windowRole(primary) === "weekly"
      ? { primary: null, secondary: primary }
      : { primary, secondary: null }
  }
  if (secondary) {
    return windowRole(secondary) === "weekly"
      ? { primary: null, secondary }
      : { primary: secondary, secondary: null }
  }
  return { primary: null, secondary: null }
}

export function normalizeCodexRateLimit(rateLimit, options = {}) {
  return normalizePrimarySecondaryWindows(
    rateLimit?.primary_window ?? rateLimit?.primary,
    rateLimit?.secondary_window ?? rateLimit?.secondary,
    options,
  )
}

