#!/usr/bin/env python3
"""Regression tests for transcript-backed rate-limit detection.

Run with: python3 test/test-rate-limit-detection.py
"""

from __future__ import annotations

import os
import runpy
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
temp_state = tempfile.mkdtemp(prefix="agent-session-viewer-rate-test-")
os.environ["XDG_STATE_HOME"] = temp_state
api = runpy.run_path(str(ROOT / "scripts" / "rate-limit-alarm.py"), run_name="__test__")


def assert_detects(label: str, data: dict, expected: bool) -> None:
    text = api["extract_signal_text"](data)
    actual = bool(text and api["has_explicit_limit_signal"](data, text))
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}; text={text!r}")
    print(f"  ✓  {label}")


gemini_meta_discussion = {
    "id": "cd4f5350-d126-43bc-9857-fe0be192ede2",
    "timestamp": "2026-05-13T20:27:04.741061Z",
    "type": "gemini",
    "model": "gemini-2.5-pro",
    "content": (
        "I've traced the execution flow and found that rate limit events are logged "
        "to a file at `~/.local/state/agent-rate-limit-alarm/events.jsonl`. "
        "However, my access is restricted to the project directory, so I'm unable "
        "to read this file directly."
    ),
}

gemini_model_exhausted = {
    "id": "provider-error",
    "timestamp": "2026-05-13T20:24:33.398Z",
    "type": "gemini",
    "error": "The gemini 3.1 model is exhausted. Please try again later.",
}

claude_limit_with_reset = {
    "type": "assistant",
    "message": "You've hit your limit · resets 5:30pm (Asia/Calcutta)",
}

structured_rate_limit = {
    "error": "rate_limit",
    "content": "premium",
}

assert_detects("Gemini meta-discussion about rate-limit logs is ignored", gemini_meta_discussion, False)
assert_detects("Gemini model exhaustion wording is detected", gemini_model_exhausted, True)
assert_detects("Claude usage-limit reset wording is detected", claude_limit_with_reset, True)
assert_detects("Structured rate_limit errors are detected", structured_rate_limit, True)
