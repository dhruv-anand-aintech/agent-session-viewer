---
name: "Agent Session Viewer"
description: "Dark transcript console for inspecting and sharing multi-agent coding sessions."
colors:
  canvas: "#1e1d1a"
  surface: "#262622"
  surface-raised: "#2f2f2a"
  surface-deep: "#151512"
  text: "#f7f1e6"
  text-muted: "#bdb4a4"
  text-faint: "#8f8678"
  border: "#3a3933"
  accent: "#d97757"
  accent-soft: "#3a241d"
  claude: "#d97757"
  cursor: "#5c9fdd"
  opencode: "#4db96f"
  antigravity: "#a68af9"
  hermes: "#d8a64d"
  danger: "#f17878"
  success: "#85c957"
typography:
  title:
    fontFamily: "Anthropic Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Anthropic Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "Anthropic Mono, ui-monospace, Cascadia Code, JetBrains Mono, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-quiet:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  search-field:
    backgroundColor: "{colors.surface-deep}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
  platform-chip:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.mono}"
    rounded: "{rounded.lg}"
    padding: "2px 8px"
---

# Design System: Agent Session Viewer

## 1. Overview

**Creative North Star: "The Transcript Reading Room"**

Agent Session Viewer is a dense product workspace for reading long coding-agent transcripts. The scene is a developer jumping between projects and sessions, often debugging stale links or reconstructing prior work. Dark mode is justified by sustained reading, not by terminal theatrics.

The visual system is Claude-adjacent: warm charcoal surfaces, parchment-tinted text, subtle borders, compact controls, and restrained platform color. The UI should disappear behind reading, search, and navigation.

**Key Characteristics:**
- Three-pane productivity structure with resizable sidebar and focused message pane.
- Warm dark neutrals instead of blue-black dashboard defaults.
- Platform hues appear in dots, pills, and filters only.
- Search, settings, and PIN gate use compact overlays with strong boundaries.

## 2. Colors

The palette is warm dark with one clay accent plus platform identity colors.

### Primary
- **Clay Accent** (`accent`): Active controls, Claude identity, focus emphasis, selected session affordances.

### Secondary
- **Platform Hues** (`claude`, `cursor`, `opencode`, `antigravity`, `hermes`): Provenance markers in filters and session rows.
- **Success / Danger** (`success`, `danger`): Load, auth, error, and rate-limit state.

### Neutral
- **Canvas** (`canvas`): Application background.
- **Surface** (`surface`): Sidebar and topbar.
- **Raised Surface** (`surface-raised`): Buttons, selected rows, modal panels.
- **Deep Surface** (`surface-deep`): Search fields and recessed areas.
- **Text Stack** (`text`, `text-muted`, `text-faint`): Reading, metadata, and secondary hints.

### Named Rules
**The Reading First Rule.** Never let platform colors compete with transcript text.

## 3. Typography

**Display Font:** Anthropic Sans with system fallbacks.
**Body Font:** Anthropic Sans with system fallbacks.
**Label/Mono Font:** Anthropic Mono with system monospace fallbacks.

**Character:** Compact, low-drama, and text-first. Long messages should feel closer to an editor than a chat feed.

### Hierarchy
- **Title** (600, 14px): topbar, sidebar titles, active session labels.
- **Body** (400, 14px): transcript prose and standard controls.
- **Mono** (500, 12px): session IDs, code, counters, keyboard hints, and timestamps.

### Named Rules
**The Transcript Rhythm Rule.** Do not enlarge message text for drama. Preserve steady reading rhythm.

## 4. Elevation

Elevation is mostly tonal. Use borders and background shifts first; reserve heavy shadows for global search, settings, and PIN gate overlays.

### Shadow Vocabulary
- **Overlay Shadow** (`0 24px 80px rgba(0, 0, 0, 0.6)`): global search and modal panels.
- **Floating Toggle Shadow** (`0 8px 24px rgba(0, 0, 0, 0.32)`): collapsed pane toggles.

### Named Rules
**The Flat Navigation Rule.** Sidebar rows are selected by tone and border, not card lift.

## 5. Components

### Buttons
- **Shape:** Compact 6px radius.
- **Primary:** Clay accent only for high-confidence actions.
- **Hover / Focus:** Gentle tone shift, visible focus ring, no movement.
- **Quiet Buttons:** Dark raised surface with muted text for settings, search, and row controls.

### Chips
- **Style:** Platform chips use low-alpha backgrounds with platform-colored text and border.
- **State:** Active filters must be obvious by both color and label.

### Cards / Containers
- **Corner Style:** 8px to 12px only for overlays and PIN cards.
- **Background:** Warm charcoal surfaces.
- **Border:** Fine low-contrast borders define panes.

### Inputs / Fields
- **Style:** Recessed dark field, 8px radius, compact padding.
- **Focus:** Border shifts to muted text or accent, never removes outline.

### Navigation
- **Style:** Left sidebar with search, platform filters, project/session rows, and load-more state.
- **Mobile:** Sidebar becomes a controlled drawer; transcript remains primary.

### Transcript Pane
Messages, markdown, code, and tool blocks must keep stable widths and calm spacing. Avoid chat bubbles unless they add real parsing value.

## 6. Do's and Don'ts

### Do:
- **Do** optimize for reading and session recovery.
- **Do** keep platform colors small and provenance-specific.
- **Do** show loading, truncation, and stale-link state explicitly.
- **Do** keep search and share controls predictable and keyboard reachable.

### Don't:
- **Don't** turn the viewer into a generic analytics dashboard.
- **Don't** use neon terminal styling or decorative glow.
- **Don't** make transcript rows look like a social chat app.
- **Don't** imply a deep link is canonical unless project and session metadata agree.
