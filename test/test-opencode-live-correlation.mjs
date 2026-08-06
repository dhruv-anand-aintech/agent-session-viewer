import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-viewer-opencode-live-"))
const dbPath = path.join(tempDir, "opencode.db")
const correlationPath = path.join(tempDir, "opencode-correlations.json")
const parentId = "019fd0d0-81ea-7fb2-a467-c8ad4929fe43"
const childId = "ses_child"

const sql = `
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, version text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, agent text, metadata text
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
INSERT INTO session VALUES
  ('ses_initial', 'proj_1', NULL, 'initial', '/tmp/live', 'Initial', '1.0.0', 1770796500000, 1770796501000, 'build', '{"model":"initial"}');
INSERT INTO message VALUES
  ('msg_initial', 'ses_initial', 1770796500000, 1770796500000, '{"role":"user","time":{"created":1770796500000}}');
INSERT INTO part VALUES
  ('part_initial', 'msg_initial', 'ses_initial', 1770796500000, 1770796500000, '{"type":"text","text":"initial prompt"}');
`
execFileSync("sqlite3", [dbPath], { input: sql })

function writeCorrelation(sessions) {
  fs.writeFileSync(correlationPath, JSON.stringify({ sessions }, null, 2))
}

function expect(label, got, want) {
  if (got === want) console.log(`  ✓  ${label}`)
  else {
    console.error(`  ✗  ${label}\n       got : ${got}\n       want: ${want}`)
    process.exitCode = 1
  }
}

try {
  process.env.ASV_OPENCODE_DIR = tempDir
  process.env.ASV_OPENCODE_DB = dbPath
  process.env.ASV_OPENCODE_STORAGE = path.join(tempDir, "storage")
  process.env.ASV_OPENCODE_CORRELATION_FILE = correlationPath
  const mod = await import(pathToFileURL(path.join(process.cwd(), "platform-readers.mjs")).href + `?v=${Date.now()}`)

  const firstCache = new Map()
  const initial = [...mod.iterOpenCodeSessions(firstCache.get.bind(firstCache), firstCache.set.bind(firstCache))]
  expect("initial session is discovered", initial.length, 1)
  expect("initial session is flat without provenance", initial[0]?.result.meta.isSidechain, false)

  execFileSync("sqlite3", [dbPath], { input: `
    UPDATE session SET time_updated=1770796502000 WHERE id='ses_initial';
    INSERT INTO message VALUES ('msg_initial_2','ses_initial',1770796502000,1770796502000,'{"role":"assistant","time":{"created":1770796502000}}');
    INSERT INTO part VALUES ('part_initial_2','msg_initial_2','ses_initial',1770796502000,1770796502000,'{"type":"text","text":"updated"}');
    INSERT INTO session VALUES ('${childId}','proj_1',NULL,'child','/tmp/live','Child','1.0.0',1770796503000,1770796503000,'build','{}');
    INSERT INTO message VALUES ('msg_child','${childId}',1770796503000,1770796503000,'{"role":"user","time":{"created":1770796503000}}');
    INSERT INTO part VALUES ('part_child','msg_child','${childId}',1770796503000,1770796503000,'{"type":"text","text":"child"}');
  ` })

  const changed = [...mod.iterOpenCodeSessions(firstCache.get.bind(firstCache), firstCache.set.bind(firstCache))]
  expect("new session is discovered on the next read", changed.length, 2)
  expect("existing session update is surfaced", changed.some(x => x.result.meta.id === "ses_initial" && x.result.meta.messageCount === 2), true)

  writeCorrelation({ [childId]: { parentSessionId: parentId, parentSource: "codex", evidence: "explicit test ledger" } })
  const linked = mod.readOpenCodeSessionFromSqlite(dbPath, childId, null, null)
  expect("explicit ledger links OpenCode child to Codex", linked?.meta.parentSessionId, parentId)
  expect("linked child is marked sidechain", linked?.meta.isSidechain, true)

  writeCorrelation({})
  const unlinked = mod.readOpenCodeSessionFromSqlite(dbPath, childId, null, null)
  expect("unlinked session remains flat", unlinked?.meta.isSidechain, false)
  expect("unlinked session has no fabricated parent", unlinked?.meta.parentSessionId, undefined)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
