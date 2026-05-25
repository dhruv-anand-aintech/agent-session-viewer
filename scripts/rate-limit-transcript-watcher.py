#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import queue
import re
import runpy
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable

try:
    from watchdog.events import FileSystemEvent, FileSystemEventHandler
    from watchdog.observers import Observer
except Exception:
    FileSystemEvent = None
    FileSystemEventHandler = object
    Observer = None


STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "agent-session-viewer-rate-limit"
WATCH_STATE = STATE_DIR / "watch-state.json"
WATCH_STATE_DB = STATE_DIR / "watch-state.sqlite"
APP_CONFIG_FILE = Path.home() / ".config" / "agent-session-viewer" / "config.json"
DEFAULT_ALARM_SCRIPT = Path(__file__).resolve().parent / "rate-limit-alarm.py"
ALARM_SCRIPT = Path(os.environ.get("AGENT_SESSION_VIEWER_RATE_LIMIT_ALARM_SCRIPT", os.fspath(DEFAULT_ALARM_SCRIPT)))
POLL_INTERVAL = 1.5
FULL_RESCAN_INTERVAL = 5 * 60
STARTUP_LOOKBACK_SECONDS = 30 * 60
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_JSONL_READ_BYTES = 8 * 1024 * 1024
EXCLUDED_DIR_NAMES = {".git", ".hg", ".svn", "__pycache__", "cache", "caches", "node_modules", "tmp", "temp"}
EXCLUDED_PATH_PARTS = {"logs", "cache", "caches", "shell_snapshots"}
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.I,
)

WATCH_SPECS = [
    {
        "agent": "Claude",
        "paths": [Path.home() / ".claude" / "projects"],
        "kinds": {"jsonl"},
        "path_contains": (),
    },
    {
        "agent": "Codex",
        "paths": [Path.home() / ".codex" / "sessions"],
        "kinds": {"jsonl"},
        "path_contains": (),
    },
    {
        "agent": "Cursor",
        "paths": [Path.home() / ".cursor" / "projects"],
        "kinds": {"jsonl"},
        "path_contains": ("agent-transcripts",),
    },
    {
        "agent": "Gemini",
        "paths": [Path.home() / ".gemini" / "tmp"],
        "kinds": {"jsonl"},
        "path_contains": ("chats",),
    },
    {
        "agent": "OpenClaw",
        "paths": [Path.home() / ".openclaw" / "agents"],
        "kinds": {"jsonl"},
        "path_contains": (),
    },
    {
        "agent": "Hermes",
        "paths": [Path.home() / ".hermes" / "sessions"],
        "kinds": {"json"},
        "path_contains": (),
    },
    {
        "agent": "OpenCode",
        "paths": [
            Path.home() / ".local" / "share" / "opencode" / "storage" / "session",
            Path.home() / ".local" / "share" / "opencode" / "storage" / "message",
            Path.home() / ".local" / "share" / "opencode" / "storage" / "part",
            Path.home() / ".local" / "share" / "opencode" / "storage" / "project",
            Path.home() / ".local" / "share" / "opencode" / "storage" / "session_diff",
        ],
        "kinds": {"json"},
        "path_contains": (),
    },
]


def load_alarm_api() -> dict[str, Any]:
    return runpy.run_path(os.fspath(ALARM_SCRIPT), run_name="__watch__")


def rate_limit_alerts_enabled() -> bool:
    env_value = os.environ.get("AGENT_SESSION_VIEWER_RATE_LIMIT_ALERTS")
    if env_value is not None:
        return env_value.strip().lower() not in {"0", "false", "no", "off"}
    try:
        config = json.loads(APP_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return True
    settings = config.get("settings") if isinstance(config, dict) else None
    if isinstance(settings, dict) and "rateLimitAlertsEnabled" in settings:
        return bool(settings["rateLimitAlertsEnabled"])
    if isinstance(config, dict) and "rateLimitAlertsEnabled" in config:
        return bool(config["rateLimitAlertsEnabled"])
    return True


class StateStore:
    def __init__(self, path: Path) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(os.fspath(path))
        self.conn.execute("PRAGMA journal_mode=TRUNCATE")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS file_state (
                key TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                path TEXT NOT NULL,
                offset INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                backfilled INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self.conn.commit()
        self._migrate_json_state()
        self._in_transaction = False

    def _migrate_json_state(self) -> None:
        if not WATCH_STATE.exists():
            return
        try:
            if self.conn.execute("SELECT 1 FROM file_state LIMIT 1").fetchone():
                return
            data = json.loads(WATCH_STATE.read_text(encoding="utf-8"))
        except Exception:
            return
        files = data.get("files")
        if not isinstance(files, dict):
            return
        rows = []
        for key, value in files.items():
            if not isinstance(value, dict):
                continue
            agent, _, path = str(key).partition("::")
            rows.append((str(key), agent or "Unknown", path, int(value.get("offset", 0)), int(value.get("mtime_ns", 0)), int(value.get("backfilled", 0))))
        self.conn.executemany(
            "INSERT OR REPLACE INTO file_state (key, agent, path, offset, mtime_ns, backfilled) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        self.conn.commit()

    def get(self, key: str) -> dict[str, int] | None:
        row = self.conn.execute("SELECT offset, mtime_ns, backfilled FROM file_state WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return {"offset": int(row[0]), "mtime_ns": int(row[1]), "backfilled": int(row[2])}

    def begin(self) -> None:
        if not self._in_transaction:
            self.conn.execute("BEGIN")
            self._in_transaction = True

    def commit(self) -> None:
        if self._in_transaction:
            self.conn.commit()
            self._in_transaction = False

    def set(self, key: str, agent: str, path: Path, offset: int, mtime_ns: int, backfilled: int = 0) -> bool:
        prev = self.get(key)
        if prev and prev["offset"] == offset and prev["mtime_ns"] == mtime_ns and prev.get("backfilled", 0) == backfilled:
            return False
        self.conn.execute(
            "INSERT OR REPLACE INTO file_state (key, agent, path, offset, mtime_ns, backfilled) VALUES (?, ?, ?, ?, ?, ?)",
            (key, agent, os.fspath(path), offset, mtime_ns, backfilled),
        )
        if not self._in_transaction:
            self.conn.commit()
        return True


def collect_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for item in value.values():
            yield from collect_strings(item)
        return
    if isinstance(value, list):
        for item in value:
            yield from collect_strings(item)


def normalize_text(data: Any) -> str:
    text = "\n".join(s.strip() for s in collect_strings(data) if s and s.strip())
    return " ".join(text.split())


def infer_session_id(entry: Any, path: Path) -> str:
    if isinstance(entry, dict):
        for key in ("session_id", "sessionId", "id", "traceId", "chatId"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        payload = entry.get("payload")
        if isinstance(payload, dict):
            for key in ("session_id", "sessionId", "id", "traceId", "chatId"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        session = entry.get("session")
        if isinstance(session, dict):
            for key in ("id", "sessionId", "session_id"):
                value = session.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    match = UUID_RE.search(path.stem)
    if match:
        return match.group(0)
    return path.stem


def infer_cwd(entry: Any, path: Path) -> str:
    if isinstance(entry, dict):
        for key in ("cwd", "workspacePath", "directory", "projectPath"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        session = entry.get("session")
        if isinstance(session, dict):
            value = session.get("cwd") or session.get("directory")
            if isinstance(value, str) and value.strip():
                return value.strip()
    return str(path.parent)


def entry_text(api: dict[str, Any], entry: Any) -> str:
    return api["extract_signal_text"](entry)


def entry_has_rate_limit(api: dict[str, Any], entry: Any) -> bool:
    text = entry_text(api, entry)
    if not text:
        return False
    if api["has_explicit_limit_signal"](entry, text):
        return True
    return False


def file_kind(path: Path) -> str | None:
    if path.name.endswith(".jsonl"):
        return "jsonl"
    if path.name.endswith(".json"):
        return "json"
    return None


def should_scan(path: Path, spec: dict[str, Any]) -> bool:
    lowered_parts = {part.lower() for part in path.parts}
    if lowered_parts & EXCLUDED_PATH_PARTS:
        return False
    kind = file_kind(path)
    if kind not in spec["kinds"]:
        return False
    for needle in spec["path_contains"]:
        if needle.lower() not in lowered_parts and needle.lower() not in str(path).lower():
            return False
    return True


def process_hit(api: dict[str, Any], agent: str, path: Path, entry: Any) -> None:
    text = entry_text(api, entry)
    if not text or not entry_has_rate_limit(api, entry):
        return
    session_id = infer_session_id(entry, path)
    cwd = infer_cwd(entry, path)
    location = f"{agent} transcript @ {cwd} (session {session_id})"
    targets = api["extract_targets"](entry, None, os.fspath(path))
    terminal_app = api["emit_hit_alert"](agent, location, text, targets, session_id, cwd)
    if not targets:
        return
    for fire_at, summary in targets:
        api["schedule_alarm"](agent, fire_at, summary, session_id, cwd, terminal_app)


def state_key(agent: str, path: Path) -> str:
    return f"{agent}::{path}"


def scan_jsonl_file(api: dict[str, Any], agent: str, path: Path, state: StateStore, initial: bool = False) -> bool:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return False

    key = state_key(agent, path)
    prev = state.get(key) or {"offset": 0, "mtime_ns": 0}
    offset = prev["offset"]
    if initial or stat.st_size < offset:
        offset = 0
    if not initial and stat.st_size == offset and stat.st_mtime_ns == prev["mtime_ns"]:
        return False
    if stat.st_size - offset > MAX_JSONL_READ_BYTES:
        offset = max(0, stat.st_size - MAX_JSONL_READ_BYTES)

    try:
        with path.open("r", encoding="utf-8") as fh:
            fh.seek(offset)
            if offset:
                fh.readline()
            while True:
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                process_hit(api, agent, path, entry)
            return state.set(key, agent, path, fh.tell(), stat.st_mtime_ns)
    except OSError:
        return False


def scan_json_file(api: dict[str, Any], agent: str, path: Path, state: StateStore, initial: bool = False) -> bool:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return False
    if stat.st_size > MAX_JSON_BYTES:
        return False

    key = state_key(agent, path)
    prev = state.get(key) or {"offset": 0, "mtime_ns": 0}
    if not initial and stat.st_size == prev["offset"] and stat.st_mtime_ns == prev["mtime_ns"]:
        return False

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return False
    try:
        entry = json.loads(raw)
    except json.JSONDecodeError:
        return False
    process_hit(api, agent, path, entry)
    return state.set(key, agent, path, stat.st_size, stat.st_mtime_ns)


def scan_path(api: dict[str, Any], spec: dict[str, Any], path: Path, state: StateStore, initial: bool = False) -> bool:
    kind = file_kind(path)
    if kind == "jsonl":
        return scan_jsonl_file(api, spec["agent"], path, state, initial=initial)
    elif kind == "json":
        return scan_json_file(api, spec["agent"], path, state, initial=initial)
    return False


def file_age_seconds(stat: os.stat_result) -> float:
    return max(0.0, time.time() - stat.st_mtime)


def iter_watch_files(root: Path, spec: dict[str, Any]) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name.lower() not in EXCLUDED_DIR_NAMES]
        for filename in filenames:
            path = Path(dirpath) / filename
            if should_scan(path, spec):
                yield path


def matching_spec(path: Path) -> dict[str, Any] | None:
    for spec in WATCH_SPECS:
        for root in spec["paths"]:
            try:
                path.relative_to(root)
            except ValueError:
                continue
            if path.is_file() and should_scan(path, spec):
                return spec
            if path.is_dir():
                return spec
    return None


def reconcile_startup_state(state: StateStore) -> None:
    state.begin()
    for spec in WATCH_SPECS:
        for root in spec["paths"]:
            if not root.exists():
                continue
            for path in iter_watch_files(root, spec):
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                key = state_key(spec["agent"], path)
                recent = file_age_seconds(stat) <= STARTUP_LOOKBACK_SECONDS
                if not recent:
                    continue
                prev = state.get(key)
                if prev is None:
                    state.set(key, spec["agent"], path, 0 if recent else stat.st_size, stat.st_mtime_ns, 1 if recent else 0)
    state.commit()


def scan_once(api: dict[str, Any], state: StateStore, initial: bool = False) -> bool:
    did_work = False
    for spec in WATCH_SPECS:
        for root in spec["paths"]:
            if not root.exists():
                continue
            for path in iter_watch_files(root, spec):
                did_work = scan_path(api, spec, path, state, initial=initial) or did_work
    return did_work


def scan_changed_path(api: dict[str, Any], state: StateStore, path: Path) -> bool:
    spec = matching_spec(path)
    if spec is None:
        return False
    if path.is_file():
        return scan_path(api, spec, path, state)
    did_work = False
    if path.is_dir():
        for candidate in iter_watch_files(path, spec):
            did_work = scan_path(api, spec, candidate, state) or did_work
    return did_work


class TranscriptEventHandler(FileSystemEventHandler):  # type: ignore[misc, valid-type]
    def __init__(self, changed_paths: "queue.Queue[Path]") -> None:
        super().__init__()
        self.changed_paths = changed_paths

    def _queue_path(self, path: str) -> None:
        self.changed_paths.put(Path(path))

    def on_created(self, event: Any) -> None:
        self._queue_path(str(event.src_path))

    def on_modified(self, event: Any) -> None:
        if not event.is_directory:
            self._queue_path(str(event.src_path))

    def on_moved(self, event: Any) -> None:
        self._queue_path(str(event.dest_path))

    def on_closed(self, event: Any) -> None:
        if not event.is_directory:
            self._queue_path(str(event.src_path))


class WatchdogWatcher:
    def __init__(self) -> None:
        if Observer is None:
            raise RuntimeError("watchdog is not available")
        self.changed_paths: queue.Queue[Path] = queue.Queue()
        self.observer = Observer()
        self.handler = TranscriptEventHandler(self.changed_paths)
        for spec in WATCH_SPECS:
            for root in spec["paths"]:
                if root.exists():
                    self.observer.schedule(self.handler, os.fspath(root), recursive=True)
        self.observer.start()

    def changed_paths_now(self, timeout_seconds: float) -> list[Path]:
        paths: list[Path] = []
        try:
            paths.append(self.changed_paths.get(timeout=timeout_seconds))
        except queue.Empty:
            return paths
        while True:
            try:
                paths.append(self.changed_paths.get_nowait())
            except queue.Empty:
                return paths


def load_alarm_api_with_mtime() -> tuple[dict[str, Any], int]:
    api = load_alarm_api()
    try:
        mtime_ns = ALARM_SCRIPT.stat().st_mtime_ns
    except FileNotFoundError:
        mtime_ns = 0
    return api, mtime_ns


def main() -> int:
    api, alarm_mtime_ns = load_alarm_api_with_mtime()
    state = StateStore(WATCH_STATE_DB)
    watcher: WatchdogWatcher | None = None
    try:
        watcher = WatchdogWatcher()
    except Exception:
        watcher = None
    next_full_rescan = time.monotonic() + FULL_RESCAN_INTERVAL
    while True:
        if not rate_limit_alerts_enabled():
            time.sleep(POLL_INTERVAL)
            continue
        try:
            current_mtime_ns = ALARM_SCRIPT.stat().st_mtime_ns
        except FileNotFoundError:
            current_mtime_ns = 0
        if current_mtime_ns != alarm_mtime_ns:
            api, alarm_mtime_ns = load_alarm_api_with_mtime()
        if watcher is None:
            scan_once(api, state)
            time.sleep(POLL_INTERVAL)
            continue
        timeout = max(0.0, min(POLL_INTERVAL, next_full_rescan - time.monotonic()))
        changed_paths = watcher.changed_paths_now(timeout)
        did_work = False
        for path in set(changed_paths):
            did_work = scan_changed_path(api, state, path) or did_work
        if time.monotonic() >= next_full_rescan:
            did_work = scan_once(api, state) or did_work
            next_full_rescan = time.monotonic() + FULL_RESCAN_INTERVAL


if __name__ == "__main__":
    raise SystemExit(main())
