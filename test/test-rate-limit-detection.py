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

claude_web_search_tool_result = {
    "type": "user",
    "message": {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "content": (
                    "Web search results for query: "
                    '"site:github.com claude.ai usage limits API endpoint session token '
                    '\\"5-hour\\" OR \\"rate_limit\\" scrape 2026"\n\n'
                    "Links: [{\"title\":\"[BUG] Critical: Widespread abnormal usage "
                    "limit drain across all paid tiers since March 23, 2026\"}]\n\n"
                    "Since March 23, 2026, users across all paid tiers have experienced "
                    "abnormal usage limit drain, with single prompts consuming 3-7% of "
                    "session quota and five-hour sessions depleting in as little as 19 minutes."
                ),
            }
        ],
    },
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
assert_detects("Claude web-search tool_result snippets are ignored", claude_web_search_tool_result, False)
assert_detects("Claude usage-limit reset wording is detected", claude_limit_with_reset, True)
assert_detects("Structured rate_limit errors are detected", structured_rate_limit, True)

codex_rollout_id = "rollout-2026-05-14T02-08-45-019e2310-36dc-77c0-9fdb-6e974c7b77f3"
codex_resume_command = api["platform_resume_command"]("Codex", codex_rollout_id, "/tmp")
expected_codex_resume_command = [
    "codex",
    "resume",
    "019e2310-36dc-77c0-9fdb-6e974c7b77f3",
]
if codex_resume_command != expected_codex_resume_command:
    raise AssertionError(
        f"Codex rollout resume command: expected {expected_codex_resume_command}, got {codex_resume_command}"
    )
print("  ✓  Codex rollout filenames resume by UUID")

expected_resume_commands = {
    "Claude": ["claude", "--resume", "claude-session-id"],
    "Gemini": ["gemini", "--resume", "latest"],
    "Cursor": ["cursor", "--chat"],
    "OpenCode": ["opencode", "--session", "ses_abc123"],
    "Hermes": ["hermes", "--resume", "session_20260331_173400_3f66ab"],
    "OpenClaw": ["openclaw", "tui", "--local", "--session", "f258d40f-ba89-433c-b810-3d8718f72602"],
}
resume_inputs = {
    "Claude": "claude-session-id",
    "Gemini": "ignored",
    "Cursor": "ignored",
    "OpenCode": "ses_abc123",
    "Hermes": "session_20260331_173400_3f66ab",
    "OpenClaw": "f258d40f-ba89-433c-b810-3d8718f72602.trajectory",
}
for agent, expected in expected_resume_commands.items():
    actual = api["platform_resume_command"](agent, resume_inputs[agent], "/tmp/project")
    if actual != expected:
        raise AssertionError(f"{agent} resume command: expected {expected}, got {actual}")
print("  ✓  Platform resume commands are documented command forms")
