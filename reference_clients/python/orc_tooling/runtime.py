from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from typing import Any, Callable, Iterator
from uuid import uuid4

from .payload import redact_secrets


DEFAULT_ORC_RUNTIME_DIR = "~/.cache/tasknode/orc_runtime"
DEFAULT_ORC_RUNTIME_EVENTS_FILE = "orc_runtime_events.jsonl"
RUNTIME_EVENT_ENQUEUED = "directive_enqueued"
RUNTIME_EVENT_CLAIMED = "directive_claimed"
RUNTIME_EVENT_COMPLETED = "directive_completed"
TERMINAL_DIRECTIVE_STATUSES = {"completed", "failed", "cancelled", "claimed_only"}


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _runtime_dir(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.expanduser(runtime_dir or DEFAULT_ORC_RUNTIME_DIR)


def runtime_events_path(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.join(_runtime_dir(runtime_dir), DEFAULT_ORC_RUNTIME_EVENTS_FILE)


def runtime_lock_path(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.join(_runtime_dir(runtime_dir), ".orc_runtime.lock")


@contextmanager
def _runtime_lock(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> Iterator[str]:
    directory = _runtime_dir(runtime_dir)
    os.makedirs(directory, exist_ok=True)
    lock_path = runtime_lock_path(directory)
    with open(lock_path, "a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield runtime_events_path(directory)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _read_events_unlocked(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rows.append(redact_secrets(parsed))
    return rows


def _append_event_unlocked(path: str, event: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clean_event = redact_secrets(event)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(clean_event, sort_keys=True) + "\n")
    return clean_event


def read_runtime_events(*, runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> list[dict[str, Any]]:
    with _runtime_lock(runtime_dir) as path:
        return _read_events_unlocked(path)


def _state_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    directives: dict[str, dict[str, Any]] = {}
    for event in events:
        event_type = _safe_text(event.get("eventType"), 80)
        directive_id = _safe_text(event.get("directiveId"), 160)
        if not directive_id:
            continue
        if event_type == RUNTIME_EVENT_ENQUEUED:
            directives[directive_id] = {
                "directiveId": directive_id,
                "orc": _safe_text(event.get("orc"), 120),
                "directive": _safe_text(event.get("directive"), 100000),
                "taskId": _safe_text(event.get("taskId"), 180),
                "source": _safe_text(event.get("source"), 160),
                "metadata": _safe_dict(event.get("metadata")),
                "status": "queued",
                "createdAt": event.get("createdAt"),
                "updatedAt": event.get("createdAt"),
                "secretPrinted": False,
            }
            continue
        directive = directives.get(directive_id)
        if not directive:
            continue
        if event_type == RUNTIME_EVENT_CLAIMED:
            directive.update({
                "status": "claimed",
                "workerId": _safe_text(event.get("workerId"), 180),
                "claimedAt": event.get("claimedAt"),
                "updatedAt": event.get("claimedAt"),
            })
        elif event_type == RUNTIME_EVENT_COMPLETED:
            directive.update({
                "status": _safe_text(event.get("status"), 80) or "completed",
                "workerId": _safe_text(event.get("workerId"), 180) or directive.get("workerId", ""),
                "completedAt": event.get("completedAt"),
                "updatedAt": event.get("completedAt"),
                "result": _safe_dict(event.get("result")),
            })
    return sorted(directives.values(), key=lambda row: (row.get("createdAt") or "", row.get("directiveId") or ""))


def runtime_directives(*, runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR, orc: str = "") -> list[dict[str, Any]]:
    wanted = _safe_text(orc, 120).lstrip("@").lower()
    rows = _state_from_events(read_runtime_events(runtime_dir=runtime_dir))
    if wanted:
        rows = [row for row in rows if _safe_text(row.get("orc"), 120).lstrip("@").lower() == wanted]
    return [redact_secrets(row) for row in rows]


def runtime_status(*, runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR, orc: str = "") -> dict[str, Any]:
    rows = runtime_directives(runtime_dir=runtime_dir, orc=orc)
    counts: dict[str, int] = {}
    for row in rows:
        status = _safe_text(row.get("status"), 80) or "unknown"
        counts[status] = counts.get(status, 0) + 1
    return redact_secrets({
        "ok": True,
        "runtimeDir": _runtime_dir(runtime_dir),
        "eventsPath": runtime_events_path(runtime_dir),
        "orc": _safe_text(orc, 120).lstrip("@"),
        "count": len(rows),
        "statusCounts": counts,
        "directives": rows,
        "secretPrinted": False,
    })


def enqueue_runtime_directive(
    *,
    orc: str,
    directive: str,
    task_id: str = "",
    source: str = "nazgul",
    metadata: dict[str, Any] | None = None,
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
) -> dict[str, Any]:
    clean_orc = _safe_text(orc, 120).lstrip("@")
    clean_directive = _safe_text(directive, 100000)
    if not clean_orc:
        raise ValueError("orc is required")
    if not clean_directive:
        raise ValueError("directive is required")
    event = {
        "eventType": RUNTIME_EVENT_ENQUEUED,
        "directiveId": f"orcdirective_{uuid4()}",
        "orc": clean_orc,
        "directive": clean_directive,
        "taskId": _safe_text(task_id, 180),
        "source": _safe_text(source, 160),
        "metadata": metadata or {},
        "createdAt": _utcnow(),
        "secretPrinted": False,
    }
    with _runtime_lock(runtime_dir) as path:
        stored = _append_event_unlocked(path, event)
    return redact_secrets({
        "ok": True,
        "queued": True,
        "directiveId": stored["directiveId"],
        "orc": clean_orc,
        "taskId": stored.get("taskId", ""),
        "source": stored.get("source", ""),
        "eventsPath": runtime_events_path(runtime_dir),
        "directivePreview": clean_directive[:500],
        "secretPrinted": False,
    })


def claim_next_runtime_directive(
    *,
    orc: str,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
) -> dict[str, Any]:
    clean_orc = _safe_text(orc, 120).lstrip("@")
    if not clean_orc:
        raise ValueError("orc is required")
    normalized_orc = clean_orc.lower()
    clean_worker = _safe_text(worker_id, 180) or f"orcworker_{uuid4()}"
    with _runtime_lock(runtime_dir) as path:
        rows = _state_from_events(_read_events_unlocked(path))
        selected = next(
            (
                row for row in rows
                if row.get("status") == "queued"
                and _safe_text(row.get("orc"), 120).lstrip("@").lower() == normalized_orc
            ),
            None,
        )
        if not selected:
            return {
                "ok": True,
                "claimed": False,
                "orc": clean_orc,
                "workerId": clean_worker,
                "secretPrinted": False,
            }
        event = {
            "eventType": RUNTIME_EVENT_CLAIMED,
            "directiveId": selected["directiveId"],
            "orc": clean_orc,
            "workerId": clean_worker,
            "claimedAt": _utcnow(),
            "secretPrinted": False,
        }
        _append_event_unlocked(path, event)
        selected.update({
            "status": "claimed",
            "workerId": clean_worker,
            "claimedAt": event["claimedAt"],
            "updatedAt": event["claimedAt"],
        })
    return redact_secrets({
        "ok": True,
        "claimed": True,
        "directive": selected,
        "secretPrinted": False,
    })


def complete_runtime_directive(
    *,
    directive_id: str,
    status: str = "completed",
    result: dict[str, Any] | None = None,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
) -> dict[str, Any]:
    clean_directive_id = _safe_text(directive_id, 180)
    clean_status = _safe_text(status, 80) or "completed"
    if not clean_directive_id:
        raise ValueError("directive_id is required")
    with _runtime_lock(runtime_dir) as path:
        rows = _state_from_events(_read_events_unlocked(path))
        selected = next((row for row in rows if row.get("directiveId") == clean_directive_id), None)
        if not selected:
            raise ValueError(f"unknown directive: {clean_directive_id}")
        if _safe_text(selected.get("status"), 80) in TERMINAL_DIRECTIVE_STATUSES:
            return redact_secrets({
                "ok": True,
                "completed": False,
                "alreadyTerminal": True,
                "directive": selected,
                "secretPrinted": False,
            })
        event = {
            "eventType": RUNTIME_EVENT_COMPLETED,
            "directiveId": clean_directive_id,
            "orc": selected.get("orc", ""),
            "workerId": _safe_text(worker_id, 180) or _safe_text(selected.get("workerId"), 180),
            "status": clean_status,
            "result": result or {},
            "completedAt": _utcnow(),
            "secretPrinted": False,
        }
        _append_event_unlocked(path, event)
        selected.update({
            "status": clean_status,
            "result": result or {},
            "completedAt": event["completedAt"],
            "updatedAt": event["completedAt"],
        })
    return redact_secrets({
        "ok": True,
        "completed": True,
        "directive": selected,
        "secretPrinted": False,
    })


def run_runtime_once(
    *,
    orc: str,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    executor: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    claimed = claim_next_runtime_directive(orc=orc, worker_id=worker_id, runtime_dir=runtime_dir)
    if not claimed.get("claimed"):
        return claimed
    directive = _safe_dict(claimed.get("directive"))
    if executor:
        result = executor(directive)
        status = _safe_text(result.get("status"), 80) or "completed"
    else:
        result = {
            "mode": "prototype_no_executor",
            "nextStep": "A production Orc runtime would hand this directive to a supervised Codex worker process.",
            "directivePreview": _safe_text(directive.get("directive"), 500),
            "secretPrinted": False,
        }
        status = "claimed_only"
    completed = complete_runtime_directive(
        directive_id=directive["directiveId"],
        status=status,
        result=result,
        worker_id=_safe_text(worker_id, 180) or _safe_text(directive.get("workerId"), 180),
        runtime_dir=runtime_dir,
    )
    return redact_secrets({
        "ok": True,
        "claimed": True,
        "completed": completed.get("completed", False),
        "directive": completed.get("directive"),
        "secretPrinted": False,
    })
