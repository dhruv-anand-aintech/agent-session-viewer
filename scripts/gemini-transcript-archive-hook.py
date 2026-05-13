#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any


def load_input() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def archive_path_for(transcript_path: Path) -> Path:
    index = 1
    while True:
        candidate = transcript_path.with_name(f"{transcript_path.stem}.archive-{index}{transcript_path.suffix}")
        if not candidate.exists():
            return candidate
        index += 1


def main() -> int:
    data = load_input()
    if data.get("hook_event_name") != "SessionEnd" or data.get("reason") != "clear":
        print(json.dumps({"suppressOutput": True}))
        return 0

    raw_path = str(data.get("transcript_path") or "").strip()
    if not raw_path:
        print(json.dumps({"suppressOutput": True}))
        return 0

    transcript_path = Path(raw_path).expanduser()
    if not transcript_path.is_file() or transcript_path.name.endswith(".archive.jsonl"):
        print(json.dumps({"suppressOutput": True}))
        return 0

    try:
        if transcript_path.stat().st_size <= 0:
            print(json.dumps({"suppressOutput": True}))
            return 0
        archive_path = archive_path_for(transcript_path)
        shutil.copy2(transcript_path, archive_path)
    except OSError:
        print(json.dumps({"suppressOutput": True}))
        return 0

    print(
        json.dumps(
            {
                "suppressOutput": True,
                "systemMessage": f"Archived Gemini transcript to {archive_path}",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
