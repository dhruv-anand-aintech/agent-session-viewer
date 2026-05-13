#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import runpy
import time
from pathlib import Path
from typing import Any, Iterable


STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "agent-session-viewer-rate-limit"
WATCH_STATE = STATE_DIR / "watch-state.json"
APP_CONFIG_FILE = Path.home() / ".config" / "agent-session-viewer" / "config.json"
DEFAULT_ALARM_SCRIPT = Path(__file__).resolve().parent / "rate-limit-alarm.py"
ALARM_SCRIPT = Path(os.environ.get("AGENT_SESSION_VIEWER_RATE_LIMIT_ALARM_SCRIPT", os.fspath(DEFAULT_ALARM_SCRIPT)))
POLL_INTERVAL = 1.5
STARTUP_LOOKBACK_SECONDS = 30 * 60

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


def load_state() -> dict[str, dict[str, int]]:
    if not WATCH_STATE.exists():
        return {}
    try:
        data = json.loads(WATCH_STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    files = data.get("files")
    if not isinstance(files, dict):
        return {}
    state: dict[str, dict[str, int]] = {}
    for key, value in files.items():
        if isinstance(value, dict):
            state[str(key)] = {
                "offset": int(value.get("offset", 0)),
                "mtime_ns": int(value.get("mtime_ns", 0)),
            }
    return state


def save_state(state: dict[str, dict[str, int]]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    WATCH_STATE.write_text(json.dumps({"files": state}, indent=2, sort_keys=True), encoding="utf-8")


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
        session = entry.get("session")
        if isinstance(session, dict):
            for key in ("id", "sessionId", "session_id"):
                value = session.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
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
    kind = file_kind(path)
    if kind not in spec["kinds"]:
        return False
    parts = {part.lower() for part in path.parts}
    for needle in spec["path_contains"]:
        if needle.lower() not in parts and needle.lower() not in str(path).lower():
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


def scan_jsonl_file(api: dict[str, Any], agent: str, path: Path, state: dict[str, dict[str, int]], initial: bool = False) -> None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return

    key = state_key(agent, path)
    prev = state.get(key, {"offset": 0, "mtime_ns": 0})
    offset = prev["offset"]
    if initial or stat.st_size < offset:
        offset = 0
    if not initial and stat.st_size == offset and stat.st_mtime_ns == prev["mtime_ns"]:
        return

    try:
        with path.open("r", encoding="utf-8") as fh:
            fh.seek(offset)
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
            state[key] = {"offset": fh.tell(), "mtime_ns": stat.st_mtime_ns}
    except OSError:
        return


def scan_json_file(api: dict[str, Any], agent: str, path: Path, state: dict[str, dict[str, int]], initial: bool = False) -> None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return

    key = state_key(agent, path)
    prev = state.get(key, {"offset": 0, "mtime_ns": 0})
    if not initial and stat.st_size == prev["offset"] and stat.st_mtime_ns == prev["mtime_ns"]:
        return

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    try:
        entry = json.loads(raw)
    except json.JSONDecodeError:
        return
    process_hit(api, agent, path, entry)
    state[key] = {"offset": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def scan_path(api: dict[str, Any], spec: dict[str, Any], path: Path, state: dict[str, dict[str, int]], initial: bool = False) -> None:
    kind = file_kind(path)
    if kind == "jsonl":
        scan_jsonl_file(api, spec["agent"], path, state, initial=initial)
    elif kind == "json":
        scan_json_file(api, spec["agent"], path, state, initial=initial)


def file_age_seconds(stat: os.stat_result) -> float:
    return max(0.0, time.time() - stat.st_mtime)


def reconcile_startup_state(state: dict[str, dict[str, int]]) -> None:
    for spec in WATCH_SPECS:
        for root in spec["paths"]:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                if not should_scan(path, spec):
                    continue
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                key = state_key(spec["agent"], path)
                prev = state.get(key)
                recent = file_age_seconds(stat) <= STARTUP_LOOKBACK_SECONDS
                if prev is None:
                    state[key] = {
                        "offset": 0 if recent else stat.st_size,
                        "mtime_ns": stat.st_mtime_ns,
                        "backfilled": 1 if recent else 0,
                    }
                    continue


def scan_once(api: dict[str, Any], state: dict[str, dict[str, int]], initial: bool = False) -> None:
    for spec in WATCH_SPECS:
        for root in spec["paths"]:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                if not should_scan(path, spec):
                    continue
                scan_path(api, spec, path, state, initial=initial)


def load_alarm_api_with_mtime() -> tuple[dict[str, Any], int]:
    api = load_alarm_api()
    try:
        mtime_ns = ALARM_SCRIPT.stat().st_mtime_ns
    except FileNotFoundError:
        mtime_ns = 0
    return api, mtime_ns


def main() -> int:
    api, alarm_mtime_ns = load_alarm_api_with_mtime()
    state = load_state()
    reconcile_startup_state(state)
    save_state(state)
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
        scan_once(api, state)
        save_state(state)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    raise SystemExit(main())
