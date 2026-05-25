#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shlex
import re
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "agent-rate-limit-alarm"
EVENT_LOG = STATE_DIR / "events.jsonl"
SEEN_KEYS = STATE_DIR / "seen.jsonl"
LOCK_FILE = STATE_DIR / ".lock"
APPLET_DIR = STATE_DIR / "applets"
NOTIFICATION_SOUND = "Glass"
TERMINAL_NOTIFIER = Path("/opt/homebrew/bin/terminal-notifier")

KEYWORDS = (
    "rate limit",
    "usage limit",
    "limit reached",
    "weekly limit",
    "5h limit",
    "reset",
    "resets",
    "available again",
    "try again",
)

LIMIT_SIGNAL_RE = re.compile(
    r"\b(?:"
    r"you(?:['’]?ve| have) hit your(?: usage)? limit|"
    r"limit reached|"
    r"(?:rate[_ -]?limit|usage limit|weekly limit|5h limit|quota|model) (?:exceeded|reached|hit|exhausted)|"
    r"(?:exceeded|reached|hit) (?:the )?(?:rate[_ -]?limit|usage limit|weekly limit|5h limit|quota)|"
    r"resource exhausted|"
    r"quota exceeded|"
    r"model(?: [\w.-]+){0,4} exhausted|"
    r"429(?: too many requests)?"
    r")\b",
    re.I,
)
TERMINAL_APPS = ("iTerm", "Terminal")

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

WEEKDAYS = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "wed": 2,
    "wednesday": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}

ISO_RE = re.compile(
    r"\b(?P<iso>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)\b"
)
CLOCK_TIME_RE = re.compile(r"\b(?P<hour>\d{1,2}):(?P<minute>\d{2})(?:\s*(?P<ampm>am|pm))?\b", re.I)
TIME_RE = CLOCK_TIME_RE
HOUR_AMPM_RE = re.compile(r"\b(?P<hour>\d{1,2})\s*(?P<ampm>am|pm)\b", re.I)
MONTH_DAY_RE = re.compile(
    r"\b(?P<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+"
    r"(?P<day>\d{1,2})(?:st|nd|rd|th)?(?:,\s*(?P<year>\d{4}))?\b",
    re.I,
)
DAY_MONTH_RE = re.compile(
    r"\b(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(?P<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
    r"(?:,\s*(?P<year>\d{4}))?\b",
    re.I,
)
WEEKDAY_RE = re.compile(
    r"\b(?P<weekday>mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|"
    r"fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b",
    re.I,
)
TIMEZONE_RE = re.compile(r"\((?P<tz>[A-Za-z_]+/[A-Za-z0-9_+./-]+)\)")
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.I,
)


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


def load_input() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}


def now_local() -> datetime:
    return datetime.now().astimezone()


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def append_event(kind: str, payload: dict[str, Any]) -> None:
    ensure_state_dir()
    record = {
        "kind": kind,
        "ts": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    with EVENT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")


def normalize_text(data: Any) -> str:
    text = "\n".join(s.strip() for s in collect_strings(data) if s and s.strip())
    return re.sub(r"[ \t]+", " ", text)


def extract_signal_text(data: Any) -> str:
    if not isinstance(data, dict):
        return ""

    parts: list[str] = []

    def add(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
        elif isinstance(value, list):
            for item in value:
                add(item)
        elif isinstance(value, dict):
            # Skip tool_result blocks — they contain arbitrary third-party API
            # responses and are a common source of false positives.
            if value.get("type") == "tool_result":
                return
            for key in ("content", "text", "message", "summary", "body", "error", "reason", "output"):
                if key in value:
                    add(value[key])

    for key in ("error", "reason", "summary", "body", "content", "text", "output", "message"):
        if key in data:
            add(data[key])

    rate_limits = _find_rate_limits(data)
    if isinstance(rate_limits, dict):
        if rate_limits.get("primary") is None and rate_limits.get("secondary") is None:
            credits = rate_limits.get("credits")
            if isinstance(credits, dict) and not credits.get("has_credits", True):
                parts.append("rate limit")
        for key in ("rate_limit_reached_type", "limit_name", "limit_id"):
            add(rate_limits.get(key))

    return normalize_text(parts)


def _find_rate_limits(data: dict[str, Any]) -> Any:
    rl = data.get("rate_limits")
    if isinstance(rl, dict):
        return rl
    payload = data.get("payload")
    if isinstance(payload, dict):
        rl = payload.get("rate_limits")
        if isinstance(rl, dict):
            return rl
    return None


def transcript_path_from_context(data: Any) -> Path | None:
    if not isinstance(data, dict):
        return None
    session_id = str(data.get("session_id") or data.get("sessionId") or "").strip()
    cwd = str(data.get("cwd") or "").strip()
    if not session_id or not cwd.startswith("/"):
        return None
    transcript_dir = Path.home() / ".claude" / "projects" / ("-" + cwd.lstrip("/").replace("/", "-"))
    return transcript_dir / f"{session_id}.jsonl"


def transcript_rate_limit_text(data: Any) -> str:
    transcript_path = transcript_path_from_context(data)
    if not transcript_path or not transcript_path.exists():
        return ""

    recent_lines: deque[str] = deque(maxlen=300)
    try:
        with transcript_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                recent_lines.append(line.rstrip("\n"))
    except OSError:
        return ""

    for line in reversed(recent_lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("error") != "rate_limit":
            payload = entry.get("payload")
            if not isinstance(payload, dict):
                continue
            message = payload.get("message")
            if not isinstance(message, dict) or message.get("error") != "rate_limit":
                continue
        text = extract_signal_text(entry)
        if text and has_explicit_limit_signal(entry, text):
            return text
    return ""


def platform_resume_command(agent: str, session_id: str, cwd: str) -> list[str] | None:
    session_uuid = UUID_RE.search(session_id).group(0) if UUID_RE.search(session_id) else session_id
    if agent == "Claude" and session_id:
        return ["claude", "--resume", session_id]
    if agent == "Codex" and session_id:
        return ["codex", "resume", session_uuid]
    if agent == "Gemini":
        return ["gemini", "--resume", "latest"]
    if agent == "Cursor":
        return ["cursor", "--chat"]
    if agent == "OpenCode" and session_id:
        return ["opencode", "--session", session_id]
    if agent == "Hermes" and session_id:
        return ["hermes", "--resume", session_id]
    if agent == "OpenClaw" and session_id:
        return ["openclaw", "tui", "--local", "--session", session_uuid]
    return None


def detect_terminal_app() -> str | None:
    for app in TERMINAL_APPS:
        probe = subprocess.run(
            ["/usr/bin/open", "-Ra", app],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if probe.returncode == 0:
            return app
    return None


def launch_resume_terminal(agent: str, session_id: str, cwd: str, terminal_app: str) -> None:
    command = platform_resume_command(agent, session_id, cwd)
    if not command:
        return
    shell_command = shlex.join(command)
    if cwd:
        shell_command = f"cd {shlex.quote(cwd)} && {shell_command}"
    if terminal_app == "Terminal":
        script = (
            'tell application "Terminal"\n'
            '    activate\n'
            f'    do script "{apple_quote(shell_command)}"\n'
            'end tell'
        )
    else:
        script = (
            'tell application "iTerm"\n'
            '    activate\n'
            '    if (count of windows) = 0 then\n'
            '        create window with default profile\n'
            '    else\n'
            '        tell current window to create tab with default profile\n'
            '    end if\n'
            f'    tell current session of current tab of current window to write text "{apple_quote(shell_command)}"\n'
            'end tell'
        )
    subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def prompt_launch_at_reset(agent: str, terminal_app: str, summary: str) -> bool:
    title = f"{agent} rate limit hit"
    body = (
        f"Reset is scheduled for:\n{summary}\n\n"
        f"Open the resumed session in {terminal_app} when it resets?"
    )
    open_button = f"Open in {terminal_app}"
    return prompt_applet_choice(title, body, [open_button, "Skip"], open_button, "Skip") == open_button


def prompt_hit_with_reset_choice(agent: str, terminal_app: str, body: str, summary: str) -> bool:
    title = f"{agent} rate limit hit"
    prompt_body = f"{body}\n\nOpen the resumed session in {terminal_app} when it resets?"
    open_button = f"Open in {terminal_app}"
    return prompt_applet_choice(title, prompt_body, [open_button, "Skip"], open_button, "Skip") == open_button


def looks_like_rate_limit(text: str) -> bool:
    lowered = text.lower()
    return bool(LIMIT_SIGNAL_RE.search(lowered)) or any(keyword in lowered for keyword in KEYWORDS)


def has_structural_limit_signal(data: Any) -> bool:
    """Return True only when structured fields (not body text) indicate a rate limit."""
    if not isinstance(data, dict):
        return False
    if data.get("error") == "rate_limit":
        return True
    message = data.get("message")
    if isinstance(message, str) and LIMIT_SIGNAL_RE.search(message.lower()):
        return True
    rate_limits = _find_rate_limits(data)
    if isinstance(rate_limits, dict):
        if rate_limits.get("rate_limit_reached_type"):
            return True
        if rate_limits.get("primary") is None and rate_limits.get("secondary") is None:
            credits = rate_limits.get("credits")
            if isinstance(credits, dict) and not credits.get("has_credits", True):
                return True
    for key in ("error", "type", "subtype", "reason", "code"):
        value = data.get(key)
        if not isinstance(value, str):
            continue
        lowered = value.strip().lower()
        if lowered == "rate_limit":
            return True
        if key in {"error", "reason", "code"} and LIMIT_SIGNAL_RE.search(lowered):
            return True
    return False


def has_explicit_limit_signal(data: Any, text: str) -> bool:
    if has_structural_limit_signal(data):
        return True
    # Text matching alone is not sufficient — it fires on discussions about rate
    # limits (e.g. link titles). Only fall back to regex when no data dict is
    # provided (transcript path passes a synthetic {"error":"rate_limit"} dict).
    if not isinstance(data, dict):
        return bool(LIMIT_SIGNAL_RE.search(text.lower()))
    return False


def parse_duration(text: str) -> timedelta | None:
    lowered = text.lower()
    if not re.search(r"\b(?:in|after)\b", lowered):
        return None
    total = timedelta()
    matched = False
    for pattern, unit in (
        (r"(\d+)\s*d(?:ays?)?\b", "days"),
        (r"(\d+)\s*h(?:ours?|rs?)?\b", "hours"),
        (r"(\d+)\s*m(?:in(?:utes?)?)?\b", "minutes"),
        (r"(\d+)\s*s(?:ec(?:onds?)?)?\b", "seconds"),
    ):
        m = re.search(pattern, lowered)
        if m:
            matched = True
            value = int(m.group(1))
            total += timedelta(**{unit: value})
    if matched and total.total_seconds() > 0:
        return total
    return None


def parse_iso(text: str) -> datetime | None:
    m = ISO_RE.search(text)
    if not m:
        return None
    raw = m.group("iso").replace("Z", "+00:00").replace(" ", "T")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=now_local().tzinfo)
    return dt.astimezone()


def parse_clock_time(text: str) -> tuple[int, int] | None:
    match = CLOCK_TIME_RE.search(text)
    if match:
        hour = int(match.group("hour"))
        ampm = match.group("ampm")
        if ampm:
            if hour == 12:
                hour = 0
            if ampm.lower() == "pm":
                hour += 12
        return hour, int(match.group("minute"))
    match = HOUR_AMPM_RE.search(text)
    if match:
        hour = int(match.group("hour"))
        ampm = match.group("ampm").lower()
        if hour == 12:
            hour = 0
        if ampm == "pm":
            hour += 12
        return hour, 0
    return None


def timezone_from_text(text: str, fallback: datetime) -> timezone:
    match = TIMEZONE_RE.search(text)
    if not match:
        return fallback.tzinfo or now_local().tzinfo
    try:
        return ZoneInfo(match.group("tz"))
    except ZoneInfoNotFoundError:
        return fallback.tzinfo or now_local().tzinfo


def parse_month_day_time(text: str, now: datetime) -> datetime | None:
    m = MONTH_DAY_RE.search(text) or DAY_MONTH_RE.search(text)
    if not m:
        return None
    tz = timezone_from_text(text, now)
    basis = now.astimezone(tz)
    month = MONTHS[m.group("month").lower()[:3]]
    day = int(m.group("day"))
    year = int(m.group("year")) if m.group("year") else basis.year
    time_parts = parse_clock_time(text[m.end():]) or parse_clock_time(text)
    hour = 9
    minute = 0
    if time_parts:
        hour, minute = time_parts
    try:
        candidate = datetime(year, month, day, hour, minute, tzinfo=tz)
    except ValueError:
        return None
    if not m.group("year") and candidate <= basis:
        candidate = candidate.replace(year=year + 1)
    return candidate.astimezone()


def parse_time_only(text: str, now: datetime) -> datetime | None:
    if not re.search(r"\breset(?:s|ting)?\b", text, re.I):
        return None
    time_parts = parse_clock_time(text)
    if not time_parts:
        return None
    tz = timezone_from_text(text, now)
    basis = now.astimezone(tz)
    hour, minute = time_parts
    candidate = basis.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= basis:
        candidate += timedelta(days=1)
    return candidate.astimezone()


def parse_weekday_time(text: str, now: datetime) -> datetime | None:
    m = WEEKDAY_RE.search(text)
    if not m:
        return None
    weekday = WEEKDAYS[m.group("weekday").lower()[:3]]
    tz = timezone_from_text(text, now)
    basis = now.astimezone(tz)
    time_parts = parse_clock_time(text[m.end():]) or parse_clock_time(text)
    hour = 9
    minute = 0
    if time_parts:
        hour, minute = time_parts
    delta_days = (weekday - basis.weekday()) % 7
    if delta_days == 0:
        candidate = basis.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= basis:
            delta_days = 7
    candidate = (basis + timedelta(days=delta_days)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    return candidate.astimezone()


def parse_reset_target(text: str, now: datetime) -> datetime | None:
    duration = parse_duration(text)
    if duration:
        return now + duration
    absolute = parse_iso(text)
    if absolute:
        return absolute
    absolute = parse_month_day_time(text, now)
    if absolute:
        return absolute
    absolute = parse_time_only(text, now)
    if absolute:
        return absolute
    absolute = parse_weekday_time(text, now)
    if absolute:
        return absolute
    return None


def split_candidates(text: str) -> list[str]:
    pieces = []
    for chunk in re.split(r"[\n\r]+", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        pieces.extend(part.strip() for part in re.split(r"\s+\|\s+|[•·]", chunk) if part.strip())
    return pieces or [text]


def _read_resets_from_file(file_path: str) -> datetime | None:
    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            for line in reversed(list(fh)):
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                rl = _find_rate_limits(entry)
                if not isinstance(rl, dict):
                    continue
                primary = rl.get("primary")
                if isinstance(primary, dict):
                    ts = primary.get("resets_at")
                    if ts:
                        dt = datetime.fromtimestamp(ts, tz=now_local().tzinfo)
                        return dt.astimezone()
    except OSError:
        return None
    return None


def extract_targets(data: Any, text_override: str | None = None, file_path: str | None = None) -> list[tuple[datetime, str]]:
    text = text_override if text_override is not None else extract_signal_text(data)
    if not text:
        return []
    now = now_local()
    seen: set[tuple[int, str]] = set()
    targets: list[tuple[datetime, str]] = []
    for candidate in split_candidates(text):
        lowered = candidate.lower()
        if not looks_like_rate_limit(lowered):
            continue
        reset_at = parse_reset_target(candidate, now)
        if not reset_at:
            continue
        if reset_at.tzinfo is None:
            reset_at = reset_at.replace(tzinfo=now.tzinfo)
        if reset_at <= now:
            if TIME_RE.search(candidate) and not MONTH_DAY_RE.search(candidate) and not ISO_RE.search(candidate):
                reset_at = reset_at + timedelta(days=1)
        key = (int(reset_at.timestamp()), candidate)
        if key in seen:
            continue
        seen.add(key)
        targets.append((reset_at, candidate))

    if not targets and file_path:
        fallback = _read_resets_from_file(file_path)
        if fallback and fallback > now:
            targets.append((fallback, fallback.strftime("resets %b %d at %I:%M%p (local)")))

    return targets


def read_seen_keys() -> set[str]:
    ensure_state_dir()
    if not SEEN_KEYS.exists():
        return set()
    with SEEN_KEYS.open("r", encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


def remember_key(key: str) -> bool:
    ensure_state_dir()
    LOCK_FILE.touch(exist_ok=True)
    with LOCK_FILE.open("r+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        seen = read_seen_keys()
        if key in seen:
            return False
        with SEEN_KEYS.open("a", encoding="utf-8") as fh:
            fh.write(key + "\n")
        return True


def remember_structured_key(*parts: Any) -> bool:
    key = hashlib.sha256("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()
    return remember_key(key)


def schedule_alarm(
    agent: str,
    fire_at: datetime,
    summary: str,
    session_id: str,
    cwd: str,
    terminal_app: str = "",
) -> None:
    payload = {
        "agent": agent,
        "fire_at": fire_at.isoformat(),
        "summary": summary,
        "session_id": session_id,
        "cwd": cwd,
        "terminal_app": terminal_app,
    }
    key_source = f"{agent}|{session_id}|{cwd}|{int(fire_at.timestamp())}"
    key = hashlib.sha256(key_source.encode("utf-8")).hexdigest()
    if not remember_key(key):
        return

    child_args = [
        sys.executable,
        os.fspath(Path(__file__).resolve()),
        "--alarm",
        "--agent",
        agent,
        "--fire-at",
        str(fire_at.timestamp()),
        "--summary",
        summary,
        "--session-id",
        session_id,
        "--cwd",
        cwd,
        "--terminal-app",
        terminal_app,
    ]
    subprocess.Popen(
        child_args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    append_event("scheduled", payload)


def apple_quote(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\r\n", "\n").replace("\r", "\n")


def launch_alert_applet(title: str, body: str) -> None:
    ensure_state_dir()
    APPLET_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(f"{title}\0{body}".encode("utf-8")).hexdigest()[:16]
    app_path = APPLET_DIR / f"agent-rate-limit-alert-{digest}.app"
    script = "\n".join(
        [
            f'display dialog "{apple_quote(body)}" with title "{apple_quote(title)}" buttons {{"OK"}} default button "OK"',
            "quit",
        ]
    )
    try:
        subprocess.run(
            ["/usr/bin/osacompile", "-o", os.fspath(app_path), "-e", script],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        return
    if app_path.exists():
        subprocess.Popen(
            ["/usr/bin/open", os.fspath(app_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )


def shell_quote_for_applescript(text: str) -> str:
    return "quoted form of " + json.dumps(text)


def prompt_applet_choice(title: str, body: str, buttons: list[str], default_button: str, cancel_button: str) -> str:
    ensure_state_dir()
    APPLET_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(
        f"{title}\0{body}\0{'|'.join(buttons)}".encode("utf-8")
    ).hexdigest()[:16]
    app_path = APPLET_DIR / f"agent-rate-limit-choice-{digest}.app"
    choice_path = APPLET_DIR / f"agent-rate-limit-choice-{digest}.txt"
    try:
        choice_path.unlink()
    except FileNotFoundError:
        pass

    buttons_literal = "{" + ", ".join(json.dumps(button) for button in buttons) + "}"
    script = "\n".join(
        [
            "try",
            f'  set resultChoice to display dialog "{apple_quote(body)}" with title "{apple_quote(title)}" buttons {buttons_literal} default button "{apple_quote(default_button)}" cancel button "{apple_quote(cancel_button)}"',
            "  set choiceText to button returned of resultChoice",
            "on error",
            f'  set choiceText to "{apple_quote(cancel_button)}"',
            "end try",
            f"do shell script \"printf %s \" & quoted form of choiceText & \" > \" & {shell_quote_for_applescript(choice_path.as_posix())}",
            "quit",
        ]
    )
    try:
        compiled = subprocess.run(
            ["/usr/bin/osacompile", "-o", os.fspath(app_path), "-e", script],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        return cancel_button
    if compiled.returncode != 0 or not app_path.exists():
        return cancel_button
    try:
        subprocess.Popen(
            ["/usr/bin/open", os.fspath(app_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
        return cancel_button
    deadline = time.time() + 300
    while time.time() < deadline:
        if choice_path.exists():
            try:
                return choice_path.read_text(encoding="utf-8").strip() or cancel_button
            except OSError:
                return cancel_button
        time.sleep(0.25)
    return cancel_button


def show_alert(agent: str, title_suffix: str, body: str) -> None:
    title = f"{agent} rate limit {title_suffix}"
    launch_alert_applet(title, body)


def show_reset_alert(agent: str, body: str) -> None:
    title = f"{agent} rate limit reset"
    launch_alert_applet(title, body)


def emit_hit_alert(
    agent: str,
    location: str,
    text: str,
    targets: list[tuple[datetime, str]],
    session_id: str = "",
    cwd: str = "",
) -> str:
    reset_summaries = [summary for _, summary in targets]
    details = [f"Agent: {agent}"]
    if cwd:
        details.append(f"Directory: {cwd}")
    if session_id:
        details.append(f"Session: {session_id}")
    if not cwd or not session_id:
        details.append(f"Location: {location}")
    if reset_summaries:
        details.append(f"Reset(s): {'; '.join(reset_summaries[:3])}")
    else:
        details.append("Reset(s): No reset time parsed.")
    body = "Hit limit.\n\n" + "\n".join(details)
    reset_ts = int(targets[0][0].timestamp()) if targets else ""
    if not remember_structured_key(agent, "hit", session_id or location, cwd, reset_ts):
        return ""
    terminal_app = detect_terminal_app()
    launch_on_reset = False
    if terminal_app and reset_summaries:
        launch_on_reset = prompt_hit_with_reset_choice(agent, terminal_app, body, reset_summaries[0])
    else:
        show_alert(agent, "hit", body)
    append_event(
        "alerted",
        {
            "agent": agent,
            "location": location,
            "summary": body,
            "target_count": len(targets),
            "context": text[:350],
            "terminal_app": terminal_app or "",
            "launch_on_reset": launch_on_reset,
        },
    )
    return terminal_app if launch_on_reset else ""


def notify(agent: str, summary: str, session_id: str, cwd: str, terminal_app: str) -> None:
    body = f"Reset time: {summary}"
    if terminal_app:
        launch_resume_terminal(agent, session_id, cwd, terminal_app)
        body = f"{body}\n\nOpened in {terminal_app}."
    show_reset_alert(agent, body)


def run_alarm_mode(
    agent: str,
    fire_at_ts: float,
    summary: str,
    session_id: str,
    cwd: str,
    terminal_app: str = "",
) -> int:
    fire_at = datetime.fromtimestamp(fire_at_ts, tz=now_local().tzinfo)
    delay = max(0.0, (fire_at - now_local()).total_seconds())
    if delay:
        time.sleep(delay)
    notify(agent, summary, session_id, cwd, terminal_app)
    append_event(
        "fired",
        {
            "agent": agent,
            "fire_at": fire_at.isoformat(),
            "summary": summary,
            "session_id": session_id,
            "cwd": cwd,
            "terminal_app": terminal_app,
        },
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--alarm", action="store_true")
    parser.add_argument("--agent", default="Coding agent")
    parser.add_argument("--fire-at", type=float, default=0.0)
    parser.add_argument("--summary", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--terminal-app", default="")
    args, _ = parser.parse_known_args()

    if args.alarm:
        return run_alarm_mode(
            args.agent,
            args.fire_at,
            args.summary,
            args.session_id,
            args.cwd,
            args.terminal_app,
        )

    data = load_input()
    hook_event = data.get("hook_event_name", "unknown") if isinstance(data, dict) else "unknown"
    cwd = str(data.get("cwd") or "").strip() if isinstance(data, dict) else ""
    session_id = str(data.get("session_id") or data.get("sessionId") or "").strip() if isinstance(data, dict) else ""
    location = data.get("location") if isinstance(data, dict) and data.get("location") else f"{hook_event} @ {cwd} ({str(session_id)[:8]})"
    if hook_event not in {"Notification", "Stop", "SessionEnd", "Transcript"}:
        if hook_event != "UserPromptSubmit":
            return 0

    if hook_event == "UserPromptSubmit":
        text = transcript_rate_limit_text(data)
        if not text:
            return 0
        if not has_explicit_limit_signal({"error": "rate_limit"}, text):
            return 0
    else:
        text = extract_signal_text(data)
        if not text or not has_explicit_limit_signal(data, text):
            return 0

    targets = extract_targets(data, text if hook_event == "UserPromptSubmit" else None)
    terminal_app = emit_hit_alert(args.agent, location, text, targets, session_id, cwd)
    if not targets:
        return 0

    for fire_at, summary in targets:
        schedule_alarm(args.agent, fire_at, summary, session_id, cwd, terminal_app)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
