/**
 * Regression test for OpenCode sqlite parent sessions.
 *
 * Run with: node test/test-opencode-subagents.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-viewer-opencode-"))
const dbPath = path.join(tempDir, "opencode.db")

const sql = `
CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  agent text
);
CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  data text NOT NULL,
  time_created integer NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  message_id text NOT NULL,
  data text NOT NULL,
  time_created integer NOT NULL
);
INSERT INTO session
  (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, agent)
VALUES
  ('ses_child', 'proj_1', 'ses_parent', 'child', '${process.cwd().replaceAll("'", "''")}', 'Explore thing', '1.0.0', 1770796500000, 1770796501000, 'explore');
INSERT INTO message
  (id, session_id, data, time_created)
VALUES
  ('msg_1', 'ses_child', '{"id":"msg_1","role":"user","time":{"created":1770796500000}}', 1770796500000);
INSERT INTO part
  (id, session_id, message_id, data, time_created)
VALUES
  ('part_1', 'ses_child', 'msg_1', '{"type":"text","text":"find retry storage"}', 1770796500000);
`

execFileSync("sqlite3", [dbPath], { input: sql })

function expect(label, got, want) {
  if (got === want) {
    console.log(`  ✓  ${label}`)
    return
  }
  console.error(`  ✗  ${label}`)
  console.error(`       got : ${got}`)
  console.error(`       want: ${want}`)
  process.exitCode = 1
}

try {
  const mod = await import(pathToFileURL(path.join(process.cwd(), "platform-readers.mjs")).href + `?v=${Date.now()}`)
  const result = mod.readOpenCodeSessionFromSqlite(dbPath, "ses_child", null, null)

  expect("meta parentSessionId", result?.meta.parentSessionId, "ses_parent")
  expect("meta isSidechain", result?.meta.isSidechain, true)
  expect("meta agentType", result?.meta.agentType, "explore")
  expect("message isSidechain", result?.msgs[0]?.isSidechain, true)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
