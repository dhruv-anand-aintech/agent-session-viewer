#!/usr/bin/env python3
"""Regression tests for Gemini /clear and /new transcript archiving.

Run with: python3 test/test-gemini-transcript-archive-hook.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import tempfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HOOK_PATH = ROOT / "scripts" / "gemini-transcript-archive-hook.py"
INSTALLER_PATH = ROOT / "scripts" / "install-gemini-transcript-archive-hook.py"


def run_hook(payload: dict) -> dict:
    module = runpy.run_path(str(HOOK_PATH), run_name="__test_hook__")
    stdout = io.StringIO()
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(stdout):
        result = module["main"]()
    assert result == 0
    return json.loads(stdout.getvalue())


with tempfile.TemporaryDirectory(prefix="agent-session-viewer-gemini-archive-") as temp_dir:
    temp = Path(temp_dir)
    transcript = temp / "session-abc.jsonl"
    transcript.write_text('{"type":"user","content":[{"text":"hello"}]}\n', encoding="utf-8")

    output = run_hook(
        {
            "hook_event_name": "SessionEnd",
            "reason": "clear",
            "transcript_path": str(transcript),
            "session_id": "abc",
            "cwd": str(temp),
        }
    )
    first_archive = temp / "session-abc.archive-1.jsonl"
    assert first_archive.read_text(encoding="utf-8") == transcript.read_text(encoding="utf-8")
    assert output["suppressOutput"] is True
    assert str(first_archive) in output["systemMessage"]
    print("  ✓  SessionEnd clear archives the current transcript")

    transcript.write_text('{"type":"user","content":[{"text":"after /new"}]}\n', encoding="utf-8")
    run_hook(
        {
            "hook_event_name": "SessionEnd",
            "reason": "clear",
            "transcript_path": str(transcript),
            "session_id": "abc",
            "cwd": str(temp),
        }
    )
    second_archive = temp / "session-abc.archive-2.jsonl"
    assert second_archive.read_text(encoding="utf-8") == transcript.read_text(encoding="utf-8")
    print("  ✓  repeated clear/new events use incrementing archive names")

    before = sorted(path.name for path in temp.glob("*.jsonl"))
    run_hook(
        {
            "hook_event_name": "SessionEnd",
            "reason": "exit",
            "transcript_path": str(transcript),
            "session_id": "abc",
            "cwd": str(temp),
        }
    )
    after = sorted(path.name for path in temp.glob("*.jsonl"))
    assert before == after
    print("  ✓  non-clear session ends do not archive")

    settings = temp / "settings.json"
    os.environ["GEMINI_SETTINGS_PATH"] = str(settings)
    os.environ["GEMINI_TRANSCRIPT_ARCHIVE_HOOK_COMMAND"] = f"python3 {HOOK_PATH}"
    installer = runpy.run_path(str(INSTALLER_PATH), run_name="__test_installer__")
    with contextlib.redirect_stdout(io.StringIO()):
        assert installer["main"]() == 0
        assert installer["main"]() == 0

    installed = json.loads(settings.read_text(encoding="utf-8"))
    hooks = installed["hooks"]["SessionEnd"]
    matching = [
        hook
        for group in hooks
        if group.get("matcher") == "clear"
        for hook in group.get("hooks", [])
        if hook.get("name") == "agent-session-viewer-archive-before-clear"
    ]
    assert len(matching) == 1
    assert matching[0]["command"] == f"python3 {HOOK_PATH}"
    print("  ✓  installer registers one global Gemini SessionEnd clear hook")
