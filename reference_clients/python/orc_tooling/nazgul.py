from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable
from uuid import uuid4

from tasknode_pftl.app_data import sql_literal, tasknode_database_url

from .orcctl import DEFAULT_RUN_JOURNAL_PATH
from .payload import redact_secrets
from .priority import next_network_triage_item
from .review_state import review_state_summary


DEFAULT_ORC_HANDLE = "orc"
DEFAULT_ORC_TMUX_TARGET = "orc:0.0"
PASTE_CHIP_PATTERN = re.compile(r"\[Pasted Content [^\]]+\]")
WORKING_PATTERN = re.compile(r"Working \(", re.IGNORECASE)
ERROR_PATTERNS = (
    "traceback",
    "unhandled exception",
    "runtimeerror",
    "command failed",
    "process exited with code 1",
)
GATE_PATTERNS = (
    "approval",
    "requires approval",
    "permission denied",
    "blocked",
    "cannot safely",
    "need user input",
    "waiting for user",
    "stop and say",
)

Runner = Callable[..., subprocess.CompletedProcess[str]]
Sleeper = Callable[[float], None]


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> datetime | None:
    text = _safe_text(value, 120)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _age_seconds(value: Any, *, now: datetime | None = None) -> float | None:
    parsed = _parse_time(value)
    if not parsed:
        return None
    current = now or datetime.now(timezone.utc)
    return max(0.0, (current - parsed).total_seconds())


def _tail_lines(text: str, limit: int = 18) -> list[str]:
    lines = [line.rstrip() for line in str(text or "").splitlines() if line.strip()]
    return lines[-max(1, limit):]


def _run_json(database_url: str, sql: str, *, runner: Runner = subprocess.run) -> Any:
    result = runner(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "psql failed").strip())
    lines = [line for line in str(result.stdout or "").splitlines() if line.strip()]
    if not lines:
        return None
    return json.loads("\n".join(lines))


def _table_exists(table: str, *, database_url: str | None = None, runner: Runner = subprocess.run) -> bool:
    db_url = tasknode_database_url(database_url)
    sql = f"SELECT to_jsonb(to_regclass({sql_literal('public.' + table)}) IS NOT NULL);"
    try:
        return bool(_run_json(db_url, sql, runner=runner))
    except Exception:
        return False


def _psql_summary(
    table: str,
    sql: str,
    *,
    database_url: str | None = None,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    if not _table_exists(table, database_url=database_url, runner=runner):
        return {"exists": False}
    try:
        value = _run_json(tasknode_database_url(database_url), sql, runner=runner)
        if isinstance(value, dict):
            value["exists"] = True
            return value
        return {"exists": True, "value": value}
    except Exception as exc:
        return {"exists": True, "error": type(exc).__name__, "message": _safe_text(exc, 500)}


def normalize_orc_record(row: dict[str, Any]) -> dict[str, Any]:
    name = _safe_text(row.get("name") or row.get("handle") or row.get("orc") or row.get("agentId") or row.get("agent_id"), 80)
    if name.startswith("@"):
        name = name[1:]
    if not name:
        name = DEFAULT_ORC_HANDLE
    target = _safe_text(
        row.get("tmuxTarget")
        or row.get("tmux_target")
        or row.get("target")
        or row.get("pane")
        or f"{name}:0.0",
        160,
    )
    return redact_secrets({
        "name": name,
        "handle": _safe_text(row.get("handle") or name, 120).lstrip("@"),
        "agentId": row.get("agentId") or row.get("agent_id") or name,
        "wallet": row.get("wallet") or row.get("walletAddress") or row.get("wallet_address") or "",
        "tmuxTarget": target,
        "status": row.get("status") or "active",
        "metadata": row.get("metadata") or {},
        "secretPrinted": False,
    })


def load_orc_registry(
    *,
    orcs_json: str = "",
    database_url: str | None = None,
    runner: Runner = subprocess.run,
) -> list[dict[str, Any]]:
    source = orcs_json or os.environ.get("NAZGUL_ORCS_JSON") or os.environ.get("NAZGUL_ORCS_FILE") or ""
    if source:
        text = source
        expanded = os.path.expanduser(source)
        if os.path.exists(expanded):
            with open(expanded, "r", encoding="utf-8") as handle:
                text = handle.read()
        parsed = json.loads(text)
        rows = _safe_list(_safe_dict(parsed).get("orcs")) if isinstance(parsed, dict) else _safe_list(parsed)
        return [normalize_orc_record(row) for row in rows if isinstance(row, dict)]

    if _table_exists("orc_agents", database_url=database_url, runner=runner):
        sql = """
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'name', COALESCE(NULLIF(handle, ''), NULLIF(agent_id, ''), id::text),
  'handle', handle,
  'agentId', agent_id,
  'wallet', wallet_address,
  'tmuxTarget', COALESCE(NULLIF(tmux_target, ''), COALESCE(NULLIF(handle, ''), agent_id) || ':0.0'),
  'status', COALESCE(status, 'active')
) ORDER BY COALESCE(NULLIF(handle, ''), NULLIF(agent_id, ''), id::text)), '[]'::jsonb)
FROM orc_agents
WHERE COALESCE(active, true) = true;
"""
        try:
            rows = _run_json(tasknode_database_url(database_url), sql, runner=runner)
            if isinstance(rows, list) and rows:
                return [normalize_orc_record(row) for row in rows if isinstance(row, dict)]
        except Exception:
            pass

    return [
        normalize_orc_record({
            "name": DEFAULT_ORC_HANDLE,
            "handle": DEFAULT_ORC_HANDLE,
            "tmuxTarget": os.environ.get("NAZGUL_ORC_TMUX_TARGET", DEFAULT_ORC_TMUX_TARGET),
        })
    ]


def find_orc(orcs: list[dict[str, Any]], name: str) -> dict[str, Any]:
    wanted = _safe_text(name, 120).lstrip("@").lower()
    for row in orcs:
        aliases = {
            _safe_text(row.get("name"), 120).lower(),
            _safe_text(row.get("handle"), 120).lstrip("@").lower(),
            _safe_text(row.get("agentId"), 120).lower(),
        }
        if wanted in aliases:
            return row
    raise ValueError(f"unknown orc: {name}")


def capture_orc_pane(
    orc: dict[str, Any] | str,
    *,
    lines: int = 60,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    target = _safe_text(_safe_dict(orc).get("tmuxTarget") if isinstance(orc, dict) else orc, 160)
    result = runner(
        ["tmux", "capture-pane", "-t", target, "-p", "-S", f"-{max(1, int(lines))}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {
            "ok": False,
            "target": target,
            "state": "missing",
            "error": _safe_text(result.stderr or result.stdout or "tmux capture failed", 500),
            "tail": [],
            "secretPrinted": False,
        }
    text = result.stdout or ""
    return {
        "ok": True,
        "target": target,
        "text": text,
        "tail": _tail_lines(text),
        "secretPrinted": False,
    }


def classify_pane_text(text: str, *, stable: bool = False) -> str:
    lowered = str(text or "").lower()
    if any(pattern in lowered for pattern in ERROR_PATTERNS):
        return "error"
    if any(pattern in lowered for pattern in GATE_PATTERNS):
        return "gate"
    if WORKING_PATTERN.search(text or ""):
        return "working"
    if stable:
        return "idle"
    return "unknown"


def read_run_journal(
    *,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    path = os.path.expanduser(journal_path or DEFAULT_RUN_JOURNAL_PATH)
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
    return rows[-max(1, int(limit)):]


def _journal_orc(row: dict[str, Any]) -> str:
    metadata = _safe_dict(row.get("metadata"))
    return _safe_text(
        row.get("orc")
        or row.get("orcHandle")
        or row.get("reviewerHandle")
        or metadata.get("orc")
        or metadata.get("orcHandle")
        or metadata.get("agent")
        or "",
        120,
    ).lstrip("@")


def run_journal_summary(
    *,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    orc_name: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    rows = read_run_journal(journal_path=journal_path)
    wanted = _safe_text(orc_name, 120).lstrip("@").lower()
    matching = [
        row for row in rows
        if not wanted or _journal_orc(row).lower() in {wanted, ""}
    ]
    last = matching[-1] if matching else {}
    counts: dict[str, int] = {}
    for row in matching:
        key = _safe_text(row.get("status") or "unknown", 80)
        counts[key] = counts.get(key, 0) + 1
    return redact_secrets({
        "path": os.path.expanduser(journal_path or DEFAULT_RUN_JOURNAL_PATH),
        "count": len(matching),
        "statusCounts": counts,
        "lastActionAt": last.get("createdAt") or last.get("created_at"),
        "lastActionAgeSeconds": _age_seconds(last.get("createdAt") or last.get("created_at"), now=now),
        "lastCommand": last.get("command"),
        "lastStatus": last.get("status"),
        "lastTaskId": last.get("taskId") or last.get("task_id"),
        "secretPrinted": False,
    })


def shared_state_summary(
    *,
    database_url: str | None = None,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    summary: dict[str, Any] = {"ok": True, "secretPrinted": False}
    try:
        summary["reviewQueue"] = _safe_dict(review_state_summary(database_url=database_url)).get("counts", {})
    except Exception as exc:
        summary["reviewQueue"] = {"error": type(exc).__name__, "message": _safe_text(exc, 500)}

    summary["orcRunJournal"] = _psql_summary(
        "orc_run_journal",
        """
SELECT jsonb_build_object(
  'count', count(*)::int,
  'lastActionAt', max(created_at)::text
)
FROM orc_run_journal;
""",
        database_url=database_url,
        runner=runner,
    )
    summary["orcTaskReviews"] = _psql_summary(
        "orc_task_reviews",
        """
SELECT jsonb_build_object(
  'count', count(*)::int
)
FROM orc_task_reviews;
""",
        database_url=database_url,
        runner=runner,
    )
    summary["orcTaskReviewStates"] = _psql_summary(
        "orc_task_review_states",
        """
WITH rows AS (
  SELECT disposition, count(*)::int AS total
  FROM orc_task_review_states
  GROUP BY disposition
)
SELECT jsonb_build_object(
  'count', COALESCE(sum(total), 0)::int,
  'byDisposition', COALESCE(jsonb_object_agg(disposition, total), '{}'::jsonb)
)
FROM rows;
""",
        database_url=database_url,
        runner=runner,
    )
    summary["orcOperatorInteractions"] = _psql_summary(
        "orc_operator_interactions",
        """
SELECT jsonb_build_object(
  'count', count(*)::int,
  'lastInteractionAt', max(created_at)::text
)
FROM orc_operator_interactions;
""",
        database_url=database_url,
        runner=runner,
    )
    return redact_secrets(summary)


def nazgul_status(
    *,
    orcs_json: str = "",
    database_url: str | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    runner: Runner = subprocess.run,
    capture: bool = True,
    shared_reader: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    orcs = load_orc_registry(orcs_json=orcs_json, database_url=database_url, runner=runner)
    shared = shared_reader(database_url=database_url) if shared_reader else shared_state_summary(database_url=database_url, runner=runner)
    rows = []
    for orc in orcs:
        pane = capture_orc_pane(orc, runner=runner) if capture else {"ok": True, "tail": [], "text": ""}
        state = pane.get("state") or classify_pane_text(_safe_text(pane.get("text"), 100000))
        journal = run_journal_summary(journal_path=journal_path, orc_name=orc.get("name") or "")
        rows.append(redact_secrets({
            "orc": orc.get("name"),
            "handle": orc.get("handle"),
            "wallet": orc.get("wallet"),
            "tmuxTarget": orc.get("tmuxTarget"),
            "pane": {
                "ok": pane.get("ok"),
                "state": state,
                "tail": pane.get("tail") or [],
                "error": pane.get("error"),
            },
            "journal": journal,
            "secretPrinted": False,
        }))
    return redact_secrets({
        "ok": True,
        "generatedAt": _utcnow(),
        "orcCount": len(rows),
        "orcs": rows,
        "sharedState": shared,
        "secretPrinted": False,
    })


def wait_for_orc_idle(
    orc: dict[str, Any] | str,
    *,
    stable_samples: int = 3,
    interval_seconds: float = 12,
    timeout_seconds: float = 600,
    runner: Runner = subprocess.run,
    sleeper: Sleeper = time.sleep,
) -> dict[str, Any]:
    stable_needed = max(1, int(stable_samples))
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    previous = None
    stable_count = 0
    captures = 0
    while True:
        pane = capture_orc_pane(orc, runner=runner)
        captures += 1
        text = _safe_text(pane.get("text"), 200000)
        if not pane.get("ok"):
            return redact_secrets({
                "ok": False,
                "state": "missing",
                "captures": captures,
                "pane": pane,
                "secretPrinted": False,
            })
        stable_count = stable_count + 1 if text == previous else 1
        previous = text
        state = classify_pane_text(text, stable=stable_count >= stable_needed)
        if stable_count >= stable_needed and state == "idle":
            return redact_secrets({
                "ok": True,
                "state": "idle",
                "captures": captures,
                "stableSamples": stable_count,
                "target": pane.get("target"),
                "tail": pane.get("tail"),
                "secretPrinted": False,
            })
        if time.monotonic() >= deadline:
            return redact_secrets({
                "ok": False,
                "state": state,
                "error": "watch_timeout",
                "captures": captures,
                "stableSamples": stable_count,
                "target": pane.get("target"),
                "tail": pane.get("tail"),
                "secretPrinted": False,
            })
        sleeper(max(0.0, float(interval_seconds)))


def paste_chip_count(text: str) -> int:
    return len(PASTE_CHIP_PATTERN.findall(text or ""))


def inject_directive(
    orc: dict[str, Any],
    directive: str,
    *,
    runner: Runner = subprocess.run,
    sleeper: Sleeper = time.sleep,
    tmp_dir: str | None = None,
) -> dict[str, Any]:
    target = _safe_text(orc.get("tmuxTarget"), 160)
    clean_directive = _safe_text(directive, 100000)
    if not target:
        raise ValueError("orc tmuxTarget is required")
    if not clean_directive:
        raise ValueError("directive is required")
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=tmp_dir) as handle:
            handle.write(clean_directive)
            temp_path = handle.name
        commands = [
            ["tmux", "load-buffer", temp_path],
            ["tmux", "paste-buffer", "-p", "-t", target],
        ]
        for command in commands:
            result = runner(command, check=False, capture_output=True, text=True)
            if result.returncode != 0:
                return {
                    "ok": False,
                    "target": target,
                    "phase": command[1],
                    "error": _safe_text(result.stderr or result.stdout, 500),
                    "secretPrinted": False,
                }
        sleeper(1)
        chip_capture = capture_orc_pane(target, lines=4, runner=runner)
        chips = paste_chip_count("\n".join(chip_capture.get("tail") or []) or _safe_text(chip_capture.get("text"), 4000))
        if chips != 1:
            return redact_secrets({
                "ok": False,
                "target": target,
                "phase": "verify_paste_chip",
                "chipCount": chips,
                "tail": chip_capture.get("tail"),
                "secretPrinted": False,
            })
        result = runner(["tmux", "send-keys", "-t", target, "Enter"], check=False, capture_output=True, text=True)
        if result.returncode != 0:
            return {
                "ok": False,
                "target": target,
                "phase": "send_enter",
                "chipCount": chips,
                "error": _safe_text(result.stderr or result.stdout, 500),
                "secretPrinted": False,
            }
        return redact_secrets({
            "ok": True,
            "target": target,
            "chipCount": chips,
            "submitted": True,
            "directivePreview": clean_directive[:500],
            "secretPrinted": False,
        })
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def ensure_operator_interaction_schema(
    *,
    database_url: str | None = None,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    sql = """
CREATE TABLE IF NOT EXISTS orc_operator_interactions (
  id text PRIMARY KEY,
  orc_handle text NOT NULL DEFAULT '',
  interaction_type text NOT NULL,
  directive text NOT NULL DEFAULT '',
  issue text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'recorded',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orc_operator_interactions_orc_idx
  ON orc_operator_interactions (orc_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS orc_operator_interactions_type_idx
  ON orc_operator_interactions (interaction_type, created_at DESC);

SELECT jsonb_build_object('ok', true, 'table', 'orc_operator_interactions', 'secretPrinted', false);
"""
    return redact_secrets(_run_json(db_url, sql, runner=runner) or {})


def record_operator_interaction(
    *,
    orc: str,
    interaction_type: str,
    directive: str = "",
    issue: str = "",
    status: str = "recorded",
    metadata: dict[str, Any] | None = None,
    database_url: str | None = None,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    ensure_operator_interaction_schema(database_url=database_url, runner=runner)
    interaction_id = f"orcint_{uuid4()}"
    sql = f"""
WITH inserted AS (
  INSERT INTO orc_operator_interactions (
    id, orc_handle, interaction_type, directive, issue, status, metadata_json
  )
  VALUES (
    {sql_literal(interaction_id)},
    {sql_literal(_safe_text(orc, 120).lstrip('@'))},
    {sql_literal(_safe_text(interaction_type, 80))},
    {sql_literal(_safe_text(directive, 100000))},
    {sql_literal(_safe_text(issue, 100000))},
    {sql_literal(_safe_text(status, 80))},
    {sql_literal(json.dumps(redact_secrets(metadata or {}), sort_keys=True))}::jsonb
  )
  RETURNING id, orc_handle, interaction_type, status, created_at
)
SELECT to_jsonb(inserted) || jsonb_build_object('ok', true, 'secretPrinted', false)
FROM inserted;
"""
    return redact_secrets(_run_json(tasknode_database_url(database_url), sql, runner=runner) or {})


def redirect_orc(
    orc_name: str,
    directive: str,
    *,
    orcs_json: str = "",
    database_url: str | None = None,
    runner: Runner = subprocess.run,
    sleeper: Sleeper = time.sleep,
    recorder: Callable[..., dict[str, Any]] | None = None,
    interaction_type: str = "redirect",
) -> dict[str, Any]:
    orc = find_orc(load_orc_registry(orcs_json=orcs_json, database_url=database_url, runner=runner), orc_name)
    injected = inject_directive(orc, directive, runner=runner, sleeper=sleeper)
    interaction: dict[str, Any] = {}
    if injected.get("ok"):
        record = recorder or record_operator_interaction
        interaction = record(
            orc=orc.get("name") or orc_name,
            interaction_type=interaction_type,
            directive=directive,
            status="submitted",
            metadata={"tmuxTarget": orc.get("tmuxTarget"), "chipCount": injected.get("chipCount")},
            database_url=database_url,
        )
    return redact_secrets({
        "ok": bool(injected.get("ok")),
        "orc": orc.get("name"),
        "action": "redirect",
        "injection": injected,
        "operatorInteraction": interaction,
        "secretPrinted": False,
    })


def next_dispatch_item(*, database_url: str | None = None, limit: int = 25) -> dict[str, Any]:
    return next_network_triage_item(
        source="review_queue",
        candidate_limit=limit,
        disposition="not_reviewed",
        database_url=database_url,
    )


def build_dispatch_directive(item: dict[str, Any]) -> str:
    task_id = _safe_text(item.get("task_id") or item.get("taskId"), 180)
    title = _safe_text(item.get("title"), 300)
    reward = _safe_text(item.get("reward_actual_pft") or item.get("rewardActualPft"), 80)
    next_command = _safe_text(_safe_dict(item.get("triage")).get("nextCommand"), 500)
    header = (
        "Orc directive: review this rewarded Network Task using the shared Orc loop. "
        f"Source task: {task_id}. "
        f"Title: {title}. "
        f"Reward: {reward} PFT. "
    )
    if next_command:
        header += f"Shared triage next command: {next_command}. "
    return header + (
        "Inspect the canonical packet, classify the source task, request a scoped Personal follow-up only if actionable, "
        "execute any follow-up genuinely, close review state, and signal the user when useful. "
        "Report concise evidence, tx/CID pointers, and blockers."
    )


def dispatch_orc(
    orc_name: str,
    *,
    orcs_json: str = "",
    database_url: str | None = None,
    runner: Runner = subprocess.run,
    sleeper: Sleeper = time.sleep,
    recorder: Callable[..., dict[str, Any]] | None = None,
    item_reader: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    item = item_reader(database_url=database_url) if item_reader else next_dispatch_item(database_url=database_url)
    if not item:
        return {
            "ok": True,
            "orc": _safe_text(orc_name, 120).lstrip("@"),
            "action": "dispatch",
            "dispatched": False,
            "message": "No non-blocked work item found.",
            "secretPrinted": False,
        }
    directive = build_dispatch_directive(item)
    result = redirect_orc(
        orc_name,
        directive,
        orcs_json=orcs_json,
        database_url=database_url,
        runner=runner,
        sleeper=sleeper,
        recorder=recorder,
        interaction_type="dispatch",
    )
    result["action"] = "dispatch"
    result["dispatched"] = bool(result.get("ok"))
    result["workItem"] = {
        "taskId": item.get("task_id") or item.get("taskId"),
        "title": item.get("title"),
        "rewardActualPft": item.get("reward_actual_pft") or item.get("rewardActualPft"),
    }
    return redact_secrets(result)


def escalate_orc(
    orc_name: str,
    issue: str,
    *,
    database_url: str | None = None,
    runner: Runner = subprocess.run,
    recorder: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    clean_orc = _safe_text(orc_name, 120).lstrip("@")
    clean_issue = _safe_text(issue, 100000)
    if not clean_issue:
        raise ValueError("issue is required")
    record = recorder or record_operator_interaction
    interaction = record(
        orc=clean_orc,
        interaction_type="escalation",
        issue=clean_issue,
        status="open",
        metadata={"source": "nazgul_cli"},
        database_url=database_url,
    )
    return redact_secrets({
        "ok": bool(interaction.get("ok", True)),
        "orc": clean_orc,
        "action": "escalate",
        "sauronMessage": f"SAURON ESCALATION [{clean_orc}]: {clean_issue}",
        "operatorInteraction": interaction,
        "secretPrinted": False,
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nazgul", description="Nazgul oversight CLI for Codex Orc panes and shared Orc state.")
    parser.add_argument("--database-url", default="", help="Override Task Node Postgres URL.")
    parser.add_argument("--orcs-json", default="", help="JSON string or path containing [{name, tmuxTarget, wallet}].")
    parser.add_argument("--journal-path", default=DEFAULT_RUN_JOURNAL_PATH, help="orc_run_journal JSONL fallback path.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status", help="Show all Orcs at a glance.")
    status_parser.add_argument("--no-capture", action="store_true", help="Skip tmux capture and show shared state only.")

    watch_parser = subparsers.add_parser("watch", help="Block until an Orc pane is idle/stable.")
    watch_parser.add_argument("orc")
    watch_parser.add_argument("--stable-samples", type=int, default=3)
    watch_parser.add_argument("--interval", type=float, default=12)
    watch_parser.add_argument("--timeout", type=float, default=600)

    redirect_parser = subparsers.add_parser("redirect", help="Paste and submit a directive into one Orc pane.")
    redirect_parser.add_argument("orc")
    redirect_parser.add_argument("directive", nargs=argparse.REMAINDER)

    dispatch_parser = subparsers.add_parser("dispatch", help="Pull next non-blocked work item and inject it.")
    dispatch_parser.add_argument("orc")

    escalate_parser = subparsers.add_parser("escalate", help="Record an issue for Sauron.")
    escalate_parser.add_argument("orc")
    escalate_parser.add_argument("issue", nargs=argparse.REMAINDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_url = args.database_url or None
    try:
        if args.command == "status":
            payload = nazgul_status(
                orcs_json=args.orcs_json,
                database_url=database_url,
                journal_path=args.journal_path,
                capture=not args.no_capture,
            )
        elif args.command == "watch":
            orc = find_orc(load_orc_registry(orcs_json=args.orcs_json, database_url=database_url), args.orc)
            payload = wait_for_orc_idle(
                orc,
                stable_samples=args.stable_samples,
                interval_seconds=args.interval,
                timeout_seconds=args.timeout,
            )
        elif args.command == "redirect":
            payload = redirect_orc(
                args.orc,
                " ".join(args.directive).strip(),
                orcs_json=args.orcs_json,
                database_url=database_url,
            )
        elif args.command == "dispatch":
            payload = dispatch_orc(
                args.orc,
                orcs_json=args.orcs_json,
                database_url=database_url,
            )
        elif args.command == "escalate":
            payload = escalate_orc(
                args.orc,
                " ".join(args.issue).strip(),
                database_url=database_url,
            )
        else:  # pragma: no cover - argparse prevents this
            raise RuntimeError(f"Unhandled command: {args.command}")
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": type(exc).__name__, "message": str(exc), "secretPrinted": False},
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(redact_secrets(payload), indent=2, sort_keys=True))
    return 0 if _safe_dict(payload).get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
