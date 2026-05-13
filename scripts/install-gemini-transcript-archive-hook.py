#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


SETTINGS_PATH = Path(os.environ.get("GEMINI_SETTINGS_PATH", str(Path.home() / ".gemini" / "settings.json")))
HOOK_COMMAND = os.environ.get(
    "GEMINI_TRANSCRIPT_ARCHIVE_HOOK_COMMAND",
    f"python3 {Path.home() / '.config' / 'agent-session-viewer' / 'rate-limit' / 'gemini-transcript-archive-hook.py'}",
)
HOOK_NAME = "agent-session-viewer-archive-before-clear"
HOOK_DESCRIPTION = "Archive the current Gemini transcript before /clear or /new starts a fresh session."


def load_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        backup = path.with_suffix(path.suffix + ".invalid")
        path.replace(backup)
        return {}
    return data if isinstance(data, dict) else {}


def ensure_archive_hook(settings: dict[str, Any]) -> bool:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks

    session_end = hooks.setdefault("SessionEnd", [])
    if not isinstance(session_end, list):
        session_end = []
        hooks["SessionEnd"] = session_end

    target_group = None
    for group in session_end:
        if isinstance(group, dict) and group.get("matcher") == "clear":
            target_group = group
            break
    if target_group is None:
        target_group = {"matcher": "clear", "sequential": True, "hooks": []}
        session_end.append(target_group)

    group_hooks = target_group.setdefault("hooks", [])
    if not isinstance(group_hooks, list):
        group_hooks = []
        target_group["hooks"] = group_hooks

    desired = {
        "name": HOOK_NAME,
        "type": "command",
        "command": HOOK_COMMAND,
        "timeout": 5000,
        "description": HOOK_DESCRIPTION,
    }

    changed = False
    for index, hook in enumerate(group_hooks):
        if not isinstance(hook, dict):
            continue
        if hook.get("name") == HOOK_NAME or hook.get("command") == HOOK_COMMAND:
            if hook != desired:
                group_hooks[index] = desired
                changed = True
            return changed

    group_hooks.append(desired)
    return True


def main() -> int:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    settings = load_settings(SETTINGS_PATH)
    changed = ensure_archive_hook(settings)
    if changed or not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(settings, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"Gemini transcript archive hook: {'updated' if changed else 'already installed'}")
    print(f"Settings: {SETTINGS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
