/**
 * Exports nomic-ai/CodeRankEmbed from safetensors → ONNX using Python + optimum.
 * Deterministic: same model weights produce identical ONNX graphs every time.
 * Stored at ~/.config/agent-session-viewer/models/CodeRankEmbed/ and reused on reinstall.
 */
import { execFile } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = join(homedir(), ".config", "agent-session-viewer")
export const MODEL_DIR = join(CONFIG_DIR, "models", "CodeRankEmbed")
export const ONNX_FILE = join(MODEL_DIR, "onnx", "model.onnx")

export function isModelExported() {
  return existsSync(ONNX_FILE)
}

/**
 * Export the model. Requires Python 3 with `optimum[exporters]` and
 * `sentence-transformers` installed.
 *
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
export async function exportModel(log = console.log) {
  if (isModelExported()) {
    log("[model-exporter] ONNX model already exported at", MODEL_DIR)
    return { ok: true, path: MODEL_DIR }
  }

  mkdirSync(MODEL_DIR, { recursive: true })

  // Use the safe escaped path for the Python string literal
  const escaped = MODEL_DIR.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

  const script = `
import sys
try:
    from optimum.exporters.onnx import main_export
except ImportError:
    print("ERR:IMPORT:optimum not installed. Run: pip install 'optimum[exporters]' sentence-transformers transformers")
    sys.exit(1)
try:
    main_export(
        "nomic-ai/CodeRankEmbed",
        output='${escaped}',
        task="feature-extraction",
        trust_remote_code=True,
        monolith=True,
    )
    print("OK")
except Exception as e:
    print("ERR:" + str(e))
    sys.exit(1)
`

  return new Promise(resolve => {
    const proc = execFile("python3", ["-c", script], { timeout: 600_000 }, (err, stdout, stderr) => {
      const out = (stdout ?? "").trim()
      if (out === "OK") {
        log("[model-exporter] Export complete:", MODEL_DIR)
        resolve({ ok: true, path: MODEL_DIR })
      } else if (out.startsWith("ERR:IMPORT:")) {
        resolve({ ok: false, error: out.slice("ERR:IMPORT:".length) })
      } else if (out.startsWith("ERR:")) {
        resolve({ ok: false, error: out.slice(4) })
      } else if (err) {
        resolve({ ok: false, error: err.message + (stderr ? `\n${stderr}` : "") })
      } else {
        resolve({ ok: false, error: stderr || "Unknown export error" })
      }
    })
    // Stream progress output live
    proc.stdout?.on("data", d => process.stdout.write(d))
    proc.stderr?.on("data", d => process.stderr.write(d))
  })
}
