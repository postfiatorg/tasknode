from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
from typing import Any


DEFAULT_SESSION_STORE = str(
    Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    / "tasknode/agent_sessions.json"
)
SESSION_EXPIRY_SKEW_SECONDS = 300


def _parse_iso_datetime(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def session_expires_soon(
    expires_at: str,
    *,
    skew_seconds: int = SESSION_EXPIRY_SKEW_SECONDS,
) -> bool:
    parsed = _parse_iso_datetime(expires_at)
    if not parsed:
        return True
    return (parsed - datetime.now(timezone.utc)).total_seconds() <= skew_seconds


def _secure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def write_json_0600(path: str, payload: dict[str, Any]) -> None:
    _secure_parent_dir(path)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)
    os.chmod(path, 0o600)


def read_json_0600(path: str) -> dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise PermissionError(f"{path} must not be readable by group/other")
    with open(path, "r", encoding="utf-8") as handle:
        try:
            data = json.load(handle)
        except json.JSONDecodeError:
            return {}
    return data if isinstance(data, dict) else {}
