from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import subprocess
import sys
import time
from typing import Any
from uuid import uuid4

from tasknode_pftl.app_data import sql_literal, tasknode_database_url

from .client import DEFAULT_EXPECTED_WALLET_ADDRESS, DEFAULT_ORC_AGENT, DEFAULT_TASKNODE_BASE_URL, build_client, request_personal_task
from .hive_signal import run_hive_signal
from .payload import redact_secrets
from .payload import task_payload
from .priority import DEFAULT_PRIORITY_MODEL, next_network_triage_item, triage_network_work
from .review import build_rewarded_network_task_review_packet
from .review_integrity_policy import apply_reward_clawback_integrity_policy
from .review_integrity_policy import EXECUTABLE_REWARD_CLAWBACK_SIGNAL, NO_SIGNING_NO_FUND_MOVEMENT_MARKER
from .review_state import (
    ACTION_REQUIRED_DISPOSITIONS,
    FOLLOWUP_CLOSEABLE_TASK_STATUSES,
    REVIEW_DISPOSITIONS,
    append_orc_work_journal,
    get_review_state,
    normalize_review_state_record,
    review_queue_item,
    review_state_summary,
    stale_followup_closures,
    upsert_review_state,
)


NETWORK_CAPACITY_NOTE = (
    "networkStatus=at_capacity blocks Network routing only; Personal task requests are still allowed."
)
DEFAULT_RUN_JOURNAL_PATH = "~/.cache/tasknode/orc_run_journal.jsonl"
FOLLOWUP_DISPOSITIONS = {"reviewed_follow_up", "reviewed_integrity_follow_up"}
TERMINAL_TASK_STATUSES = {
    *FOLLOWUP_CLOSEABLE_TASK_STATUSES,
}
SELF_CYCLE_SOURCES = {"auto", "review-queue", "operator-outstanding", "directory-rewarded-tasks"}
WEAK_ACTION_PHRASES = {
    "write a memo",
    "draft a memo",
    "make a memo",
    "write documentation",
    "document this issue",
    "investigate stuff",
    "look into it",
}
CONCRETE_ACTION_TERMS = {
    "add",
    "build",
    "fix",
    "implement",
    "repair",
    "reconcile",
    "verify",
    "test",
    "regression",
    "smoke",
    "query",
    "script",
    "tool",
    "signal",
    "message",
    "detect",
    "mitigate",
}
FIXTURE_TASK_PREFIXES = (
    "task_cancel_",
    "directory_polish_",
)
FIXTURE_TITLE_TERMS = (
    "cancel smoke",
    "directory polish",
    "network task ",
)
FIXTURE_ACCOUNT_TERMS = (
    "acct_dirqa_",
    "acct_aid_",
)


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _review_metadata(review_record: dict[str, Any]) -> dict[str, Any]:
    return dict(_safe_dict(review_record.get("metadata_json") or review_record.get("metadata")))


def _review_labels(review_record: dict[str, Any], snake_key: str, camel_key: str) -> list[str]:
    values = review_record.get(snake_key)
    if values is None:
        values = review_record.get(camel_key)
    if isinstance(values, str):
        return [values]
    return [str(value) for value in _safe_list(values) if str(value or "")]


def _review_text(review_record: dict[str, Any], snake_key: str, camel_key: str = "", limit: int = 4000) -> str:
    return _safe_text(review_record.get(snake_key) if review_record.get(snake_key) is not None else review_record.get(camel_key), limit)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def append_run_journal(
    *,
    command: str,
    phase: str,
    status: str,
    run_id: str,
    task_id: str = "",
    followup_task_id: str = "",
    cid: str = "",
    tx_hash: str = "",
    error: str = "",
    metadata: dict[str, Any] | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
) -> dict[str, Any]:
    path = os.path.expanduser(journal_path or DEFAULT_RUN_JOURNAL_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    row = redact_secrets({
        "runId": run_id,
        "command": command,
        "phase": phase,
        "status": status,
        "taskId": task_id,
        "followupTaskId": followup_task_id,
        "cid": cid,
        "txHash": tx_hash,
        "error": _safe_text(error, 2000),
        "metadata": metadata or {},
        "createdAt": _utcnow(),
        "secretPrinted": False,
    })
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
    return row


def _jsonb_literal(value: dict[str, Any] | None) -> str:
    return sql_literal(json.dumps(value if value is not None else {}, sort_keys=True)) + "::jsonb"


def _run_psql(database_url: str, sql: str, *, runner: Any = subprocess.run) -> str:
    result = runner(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    return str(result.stdout or "").strip()


def _run_json(database_url: str, sql: str, *, runner: Any = subprocess.run) -> Any:
    output = _run_psql(database_url, sql, runner=runner)
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    return json.loads(lines[-1])


def _normalize_orc_handle(value: str) -> str:
    handle = _safe_text(value, 80).lstrip("@").lower()
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789_-")
    normalized = "".join(char for char in handle if char in allowed)
    return normalized.strip("_-")


def _read_required_text_arg(*, text: str = "", path: str = "", label: str = "text") -> str:
    value = _read_text_arg(text=text, path=path).strip()
    if not value:
        raise ValueError(f"{label} is required")
    return value


def _agent_id_from_handle(handle: str) -> str:
    return f"orc_agent_{handle.replace('-', '_')}"


def orc_agent_onboard_sql(record: dict[str, Any]) -> str:
    metadata = _safe_dict(record.get("metadata"))
    return f"""
WITH upserted AS (
  INSERT INTO orc_agents (
    id,
    handle,
    agent_id,
    account_id,
    wallet_address,
    role,
    status,
    active,
    runtime_kind,
    tmux_target,
    capacity_limit,
    metadata_json,
    updated_at
  )
  VALUES (
    {sql_literal(record["id"])},
    {sql_literal(record["handle"])},
    {sql_literal(record["agentId"])},
    {sql_literal(record["accountId"])},
    {sql_literal(record["walletAddress"])},
    {sql_literal(record["role"])},
    {sql_literal(record["status"])},
    {str(bool(record["active"])).lower()},
    {sql_literal(record["runtimeKind"])},
    {sql_literal(record["tmuxTarget"])},
    {int(record["capacityLimit"])},
    { _jsonb_literal(metadata) },
    now()
  )
  ON CONFLICT (id) DO UPDATE
    SET handle = EXCLUDED.handle,
        agent_id = EXCLUDED.agent_id,
        account_id = EXCLUDED.account_id,
        wallet_address = EXCLUDED.wallet_address,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        active = EXCLUDED.active,
        runtime_kind = EXCLUDED.runtime_kind,
        tmux_target = EXCLUDED.tmux_target,
        capacity_limit = EXCLUDED.capacity_limit,
        metadata_json = COALESCE(orc_agents.metadata_json, '{{}}'::jsonb) || EXCLUDED.metadata_json,
        updated_at = now()
  RETURNING
    id,
    handle,
    agent_id,
    account_id,
    wallet_address,
    role,
    status,
    active,
    runtime_kind,
    tmux_target,
    capacity_limit,
    metadata_json,
    created_at,
    updated_at
)
SELECT to_jsonb(upserted) || jsonb_build_object(
  'ok', true,
  'allowlistEnvKey', {sql_literal(record["allowlistEnvKey"])},
  'allowlistEntry', upserted.wallet_address,
  'flyCommandHint',
    'fly secrets set ' || {sql_literal(record["allowlistEnvKey"])}
      || '=\"<existing_allowlist>,' || upserted.wallet_address || '\" -a tasknodeofficial-dev',
  'secretPrinted', false
)
FROM upserted;
"""


def onboard_orc_agent(
    *,
    handle: str,
    wallet_address: str,
    charter: str,
    account_id: str = "",
    agent_id: str = "",
    role: str = "operator",
    status: str = "active",
    active: bool = True,
    runtime_kind: str = "codex",
    tmux_target: str = "",
    capacity_limit: int = 1,
    metadata: dict[str, Any] | None = None,
    allowlist_env_key: str = "TASKNODE_AGENT_WALLET_ALLOWLIST",
    database_url: str | None = None,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    normalized_handle = _normalize_orc_handle(handle)
    if not normalized_handle:
        raise ValueError("agent handle is required")
    normalized_wallet = _safe_text(wallet_address, 160)
    if not normalized_wallet:
        raise ValueError("wallet address is required")
    normalized_charter = _safe_text(charter, 12000)
    if not normalized_charter:
        raise ValueError("charter is required")

    clean_capacity = max(1, min(24, int(capacity_limit or 1)))
    clean_agent_id = _safe_text(agent_id, 120) or normalized_handle
    clean_metadata = {
        **_safe_dict(metadata),
        "schema": "pf.orc.agent_onboard.v1",
        "charter": normalized_charter,
        "charterUpdatedAt": _utcnow(),
        "onboardedBy": "orcctl.agent.onboard",
        "allowlist": {
            "envKey": _safe_text(allowlist_env_key, 120) or "TASKNODE_AGENT_WALLET_ALLOWLIST",
            "walletAddress": normalized_wallet,
            "operatorAddsSecret": True,
        },
    }
    record = {
        "id": _agent_id_from_handle(normalized_handle),
        "handle": normalized_handle,
        "agentId": clean_agent_id,
        "accountId": _safe_text(account_id, 180),
        "walletAddress": normalized_wallet,
        "role": _safe_text(role, 80) or "operator",
        "status": _safe_text(status, 80) or "active",
        "active": bool(active),
        "runtimeKind": _safe_text(runtime_kind, 80) or "codex",
        "tmuxTarget": _safe_text(tmux_target, 120) or f"{normalized_handle}:0.0",
        "capacityLimit": clean_capacity,
        "metadata": clean_metadata,
        "allowlistEnvKey": _safe_text(allowlist_env_key, 120) or "TASKNODE_AGENT_WALLET_ALLOWLIST",
    }
    row = _safe_dict(_run_json(tasknode_database_url(database_url), orc_agent_onboard_sql(record), runner=runner))
    return redact_secrets({
        **row,
        "ok": bool(row.get("ok", True)),
        "agent": {
            "id": row.get("id") or record["id"],
            "handle": row.get("handle") or record["handle"],
            "agentId": row.get("agent_id") or record["agentId"],
            "accountId": row.get("account_id") or record["accountId"],
            "walletAddress": row.get("wallet_address") or record["walletAddress"],
            "role": row.get("role") or record["role"],
            "status": row.get("status") or record["status"],
            "active": row.get("active", record["active"]),
            "runtimeKind": row.get("runtime_kind") or record["runtimeKind"],
            "tmuxTarget": row.get("tmux_target") or record["tmuxTarget"],
            "capacityLimit": row.get("capacity_limit") or record["capacityLimit"],
        },
        "charterAssigned": True,
        "allowlist": {
            "envKey": row.get("allowlistEnvKey") or record["allowlistEnvKey"],
            "entry": row.get("allowlistEntry") or record["walletAddress"],
            "entryToAppend": row.get("allowlistEntry") or record["walletAddress"],
            "flyCommandHint": row.get("flyCommandHint")
            or f"fly secrets set {record['allowlistEnvKey']}=\"<existing_allowlist>,{record['walletAddress']}\" -a tasknodeofficial-dev",
            "operatorMustApply": True,
        },
        "secretPrinted": False,
    })


def _task_kind(task: dict[str, Any]) -> str:
    return _safe_text(task.get("kind") or task.get("taskKind") or task.get("task_kind"), 80)


def _task_status(task: dict[str, Any]) -> str:
    return _safe_text(task.get("status") or task.get("statusKey"), 80)


def _task_id(task: dict[str, Any]) -> str:
    return _safe_text(task.get("taskId") or task.get("task_id") or task.get("id"), 180)


def _task_reward(task: dict[str, Any]) -> Any:
    return task.get("rewardPft") or task.get("pft") or task.get("pftReward") or task.get("rewardActualPft")


def _compact_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": _task_id(task),
        "kind": _task_kind(task),
        "status": _task_status(task),
        "title": _safe_text(task.get("title"), 240),
        "rewardPft": _task_reward(task),
        "updatedAt": task.get("updatedAt") or task.get("lastEventAt"),
    }


def is_probable_fixture_review_row(row: dict[str, Any]) -> bool:
    task_id = _safe_text(row.get("task_id") or row.get("taskId"), 240).lower()
    title = _safe_text(row.get("title"), 400).lower()
    account_id = _safe_text(row.get("account_id") or row.get("accountId"), 240).lower()
    has_pointer = bool(_safe_text(row.get("last_event_cid") or row.get("lastEventCid") or row.get("lastEventTxHash")))
    if any(task_id.startswith(prefix) for prefix in FIXTURE_TASK_PREFIXES):
        return True
    if any(account_id.startswith(prefix) for prefix in FIXTURE_ACCOUNT_TERMS):
        return True
    if title.startswith("boscovich network task "):
        return True
    if any(term in title for term in FIXTURE_TITLE_TERMS) and not has_pointer:
        return True
    return False


def _group_summary(tasks: dict[str, Any], group: str) -> dict[str, Any]:
    rows = [row for row in _safe_list(tasks.get(group)) if isinstance(row, dict)]
    personal = [row for row in rows if _task_kind(row).lower() == "personal"]
    network = [row for row in rows if _task_kind(row).lower() == "network" or row.get("isNetworkTask")]
    return {
        "count": len(rows),
        "personal": len(personal),
        "network": len(network),
        "items": [_compact_task(row) for row in rows],
    }


def operator_status(
    *,
    client: Any | None = None,
    database_url: str | None = None,
    close_stale: bool = False,
) -> dict[str, Any]:
    active_client = client or build_client()
    login = active_client.login()
    tasks = active_client.tasks(refreshProjection="1")
    network = _safe_dict(tasks.get("networkTasks") or tasks.get("networkTaskEligibility"))
    review_summary = review_state_summary(database_url=database_url)
    stale_followups = stale_followup_closures(database_url=database_url)
    stale_rows = [_safe_dict(row) for row in _safe_list(_safe_dict(stale_followups).get("rows"))]
    closed_stale: list[dict[str, Any]] = []
    if close_stale:
        for row in stale_rows:
            source_task_id = _safe_text(row.get("sourceTaskId"), 180)
            followup_task_id = _safe_text(row.get("followupTaskId"), 180)
            if not source_task_id or not followup_task_id:
                continue
            closed_stale.append(close_followup(
                source_task_id,
                followup_task_id=followup_task_id,
                payment_tx=_safe_text(row.get("followupRewardTx"), 180),
                client=active_client,
                database_url=database_url,
            ))
    context_summary: dict[str, Any] = {}
    try:
        context = active_client.context_document()
        document = _safe_dict(context.get("document")) or context
        history = _safe_dict(context.get("history"))
        latest_pointer = _safe_dict(
            context.get("latestContextPointer")
            or document.get("latestContextPointer")
            or history.get("latestContextPointer")
        )
        context_summary = {
            "title": document.get("title"),
            "revision": document.get("revision"),
            "pointerCount": context.get("pointerCount") or document.get("pointerCount") or history.get("pointerCount"),
            "latestContextPointer": {
                "cid": latest_pointer.get("cid"),
                "txHash": latest_pointer.get("txHash") or latest_pointer.get("tx_hash"),
            } if latest_pointer else None,
        }
    except Exception as exc:  # pragma: no cover - live API best effort
        context_summary = {"error": type(exc).__name__, "message": _safe_text(exc, 300)}

    return redact_secrets({
        "ok": True,
        "agent": getattr(active_client, "agent", DEFAULT_ORC_AGENT),
        "address": getattr(active_client, "address", DEFAULT_EXPECTED_WALLET_ADDRESS),
        "accountId": getattr(active_client, "account_id", None),
        "loginCached": bool(_safe_dict(login).get("cached")),
        "networkStatus": network.get("status") or tasks.get("networkStatus"),
        "capacityNote": NETWORK_CAPACITY_NOTE,
        "groups": {
            group: _group_summary(tasks, group)
            for group in ("outstanding", "verification", "refused", "rewarded")
        },
        "requests": {
            "summary": _safe_dict(tasks.get("requests")).get("summary"),
            "count": len(
                _safe_list(_safe_dict(tasks.get("requests")).get("requests"))
                or _safe_list(_safe_dict(tasks.get("requests")).get("items"))
            ),
        },
        "reviewQueue": _safe_dict(review_summary).get("counts", {}),
        "reviewIntegrityControls": _safe_dict(review_summary).get("integrityControls", {}),
        "staleFollowups": {
            "count": len(stale_rows),
            "closeable": stale_rows,
            "closedCount": len(closed_stale),
            "closed": closed_stale,
            "closeStaleExecuted": bool(close_stale),
        },
        "context": context_summary,
        "secretPrinted": False,
    })


def _first_artifact_text(items: list[dict[str, Any]]) -> str:
    for item in items:
        for artifact in _safe_list(item.get("artifacts")):
            text = _safe_text(_safe_dict(artifact).get("value") or _safe_dict(artifact).get("notes"), 600)
            if text:
                return text
    return ""


def compact_review_task(task: dict[str, Any], *, include_raw: bool = False) -> dict[str, Any]:
    execution = _safe_dict(task.get("executionPayload"))
    network_allocation = _safe_dict(task.get("networkAllocation"))
    source_pointers = _safe_dict(task.get("sourcePointers"))
    reward_events = _safe_list(task.get("rewardEvents"))
    reward = _safe_dict(_safe_dict(reward_events[-1]).get("score")) if reward_events else {}
    packet = {
        "taskId": task.get("taskId"),
        "title": task.get("title") or execution.get("title"),
        "accountId": task.get("accountId"),
        "walletAddress": task.get("walletAddress"),
        "status": task.get("status"),
        "rewardOfferPft": task.get("rewardOfferPft"),
        "rewardActualPft": task.get("rewardActualPft"),
        "projectId": network_allocation.get("projectId") or _safe_dict(execution.get("networkTask")).get("project_id"),
        "allocationId": network_allocation.get("allocationId"),
        "objective": _safe_text(execution.get("description"), 800),
        "steps": [_safe_text(step, 300) for step in _safe_list(execution.get("steps"))[:5]],
        "submissionRequirement": _safe_dict(execution.get("submissionRequirement")),
        "evidenceSummary": _first_artifact_text(_safe_list(task.get("submissions"))),
        "verificationResponseSummary": _first_artifact_text(_safe_list(task.get("verificationResponses"))),
        "rewardReason": _safe_text(reward.get("reason"), 800),
        "sourceCids": [
            value for value in [
                source_pointers.get("requestBundleCid"),
                source_pointers.get("contextCid"),
                source_pointers.get("lastEventCid"),
            ] if value
        ],
        "sourceTxHashes": [source_pointers.get("lastEventTxHash")] if source_pointers.get("lastEventTxHash") else [],
    }
    if include_raw:
        packet["rawReviewTask"] = task
    return redact_secrets(packet)


def _review_task_integrity_policy(
    review_item: dict[str, Any],
    *,
    categories: list[str] | None = None,
    integrity_signals: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    applied = apply_reward_clawback_integrity_policy(
        categories=categories or [],
        integrity_signals=integrity_signals or [],
        metadata=metadata or {},
        review_item=review_item,
    )
    return _safe_dict(applied.get("metadata")).get("integrityControl") or {}


def review_next(
    *,
    task_id: str = "",
    disposition: str = "not_reviewed",
    include_raw: bool = False,
    include_raw_events: bool = False,
    include_fixtures: bool = False,
    text_limit: int = 1200,
    database_url: str | None = None,
) -> dict[str, Any]:
    selected_task_id = _safe_text(task_id, 180)
    queue_row: dict[str, Any] = {}
    if not selected_task_id:
        queue_row = next_network_triage_item(
            source="review_queue",
            candidate_limit=500,
            disposition=disposition,
            include_fixtures=include_fixtures,
            database_url=database_url,
        )
        if not queue_row:
            return {
                "ok": True,
                "count": 0,
                "message": "No matching review tasks.",
                "disposition": disposition,
                "includeFixtures": include_fixtures,
                "secretPrinted": False,
            }
        selected_task_id = _safe_text(queue_row.get("task_id") or queue_row.get("taskId"), 180)
    else:
        queue_row = review_queue_item(selected_task_id, database_url=database_url)
    if selected_task_id and not queue_row.get("source_mode"):
        queue_row = review_queue_item(selected_task_id, database_url=database_url) or queue_row

    packet = build_rewarded_network_task_review_packet(
        task_id=selected_task_id,
        limit=1,
        text_limit=text_limit,
        include_raw_events=include_raw_events,
        database_url=database_url,
    )
    tasks = _safe_list(_safe_dict(packet).get("tasks"))
    if not tasks:
        if _safe_text(queue_row.get("source_mode"), 80) not in {"directory_public", "hive_public_detail", "network_status_packet"}:
            return {
                "ok": False,
                "error": "task_review_packet_missing",
                "taskId": selected_task_id,
                "secretPrinted": False,
            }
        tasks = [{
            "taskId": selected_task_id,
            "title": queue_row.get("title"),
            "accountId": queue_row.get("account_id"),
            "walletAddress": queue_row.get("wallet_address"),
            "status": queue_row.get("task_status") or "rewarded",
            "rewardOfferPft": queue_row.get("reward_offer_pft"),
            "rewardActualPft": queue_row.get("reward_actual_pft"),
            "executionPayload": {
                "description": _safe_text(_safe_dict(queue_row.get("item_metadata_json")).get("publicSummary") or queue_row.get("description"), text_limit),
                "steps": [],
                "submissionRequirement": {
                    "type": "public_directory_packet",
                    "criteria": "Review the public Directory rewarded-task packet and public Hive detail URL if present.",
                },
                "verificationPolicy": {},
                "networkTask": {
                    "project_id": _safe_dict(_safe_dict(queue_row.get("item_metadata_json")).get("project")).get("id") or "",
                },
            },
            "networkAllocation": {},
            "submissions": [{
                "artifacts": [{
                    "value": _safe_text(queue_row.get("description"), text_limit),
                    "url": queue_row.get("public_hive_task_detail_url") or "",
                }],
            }],
            "verificationResponses": [],
            "rewardEvents": [{
                "score": {
                    "decision": "rewarded",
                    "reason": "Public Directory rewarded-task packet.",
                },
            }],
            "sourcePointers": {
                "requestBundleCid": queue_row.get("request_bundle_cid"),
                "lastEventCid": queue_row.get("last_event_cid"),
                "lastEventTxHash": queue_row.get("last_event_tx_hash"),
            },
            "publicHiveTaskDetailUrl": queue_row.get("public_hive_task_detail_url"),
            "queueItemSourceMode": queue_row.get("source_mode"),
            "statusPacket": _safe_dict(queue_row.get("status_packet_json") or _safe_dict(queue_row.get("item_metadata_json")).get("statusPacket")),
        }]
    review_state = get_review_state(selected_task_id, database_url=database_url)
    compact = compact_review_task(_safe_dict(tasks[0]), include_raw=include_raw)
    if queue_row.get("public_hive_task_detail_url"):
        compact["publicHiveTaskDetailUrl"] = queue_row["public_hive_task_detail_url"]
    if queue_row.get("source_mode"):
        compact["queueItemSourceMode"] = queue_row["source_mode"]
    status_packet = _safe_dict(queue_row.get("status_packet_json") or _safe_dict(queue_row.get("item_metadata_json")).get("statusPacket"))
    if status_packet:
        compact["statusPacket"] = status_packet
    review_categories = review_state.get("categories") or queue_row.get("categories") or []
    if isinstance(review_categories, str):
        review_categories = [review_categories]
    review_integrity = review_state.get("integrity_signals") or queue_row.get("integrity_signals") or []
    if isinstance(review_integrity, str):
        review_integrity = [review_integrity]
    review_metadata = _safe_dict(review_state.get("metadata_json") or review_state.get("metadata") or {})
    integrity_policy = _review_task_integrity_policy(
        _safe_dict(tasks[0]),
        categories=list(review_categories),
        integrity_signals=list(review_integrity),
        metadata=review_metadata,
    )
    if integrity_policy:
        compact["integrityPolicy"] = integrity_policy
    compact["reviewState"] = {
        "disposition": review_state.get("disposition") or queue_row.get("review_disposition") or "not_reviewed",
        "actionRequired": review_state.get("action_required") or queue_row.get("action_required") or False,
        "summary": review_state.get("summary") or queue_row.get("review_summary") or "",
        "recommendedAction": review_state.get("recommended_action") or queue_row.get("recommended_action") or "",
        "categories": list(review_categories),
        "integritySignals": list(review_integrity),
        "integrityControl": _safe_dict(review_metadata.get("integrityControl")) or integrity_policy,
    }
    if queue_row.get("triage"):
        compact["triage"] = queue_row["triage"]
    compact["classificationOptions"] = sorted(REVIEW_DISPOSITIONS)
    return redact_secrets({
        "ok": True,
        "count": 1,
        "task": compact,
        "secretPrinted": False,
    })


def validate_followup_action(disposition: str, action: str) -> None:
    if disposition not in FOLLOWUP_DISPOSITIONS:
        return
    clean = _safe_text(action, 12000)
    lowered = clean.lower()
    if len(clean) < 40:
        raise ValueError("follow-up dispositions require a concrete recommended action")
    if any(phrase in lowered for phrase in WEAK_ACTION_PHRASES):
        raise ValueError("follow-up action is too passive; request implementation, verification, reconciliation, or tooling work")
    if not any(term in lowered for term in CONCRETE_ACTION_TERMS):
        raise ValueError("follow-up action must name concrete work such as verify, fix, reconcile, test, build, or signal")


def classify_review(
    task_id: str,
    *,
    disposition: str,
    summary: str,
    recommended_action: str = "",
    categories: list[str] | None = None,
    integrity_signals: list[str] | None = None,
    action_required: bool | None = None,
    action_owner: str = "",
    confidence: str = "medium",
    reviewer_handle: str = DEFAULT_ORC_AGENT,
    reviewer_wallet: str = DEFAULT_EXPECTED_WALLET_ADDRESS,
    source_task_ids: list[str] | None = None,
    source_cids: list[str] | None = None,
    source_tx_hashes: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
    database_url: str | None = None,
) -> dict[str, Any]:
    validate_followup_action(disposition, recommended_action)
    review_item: dict[str, Any] = {}
    try:
        packet = build_rewarded_network_task_review_packet(
            task_id=task_id,
            limit=1,
            text_limit=2500,
            include_raw_events=False,
            database_url=database_url,
        )
        review_item = _safe_dict(_safe_list(_safe_dict(packet).get("tasks"))[0]) if _safe_list(_safe_dict(packet).get("tasks")) else {}
    except Exception:
        review_item = {}
    policy = apply_reward_clawback_integrity_policy(
        categories=categories or [],
        integrity_signals=integrity_signals or [],
        metadata=metadata or {},
        review_item=review_item,
    )
    record = normalize_review_state_record(
        task_id=task_id,
        disposition=disposition,
        action_required=action_required,
        action_owner=action_owner,
        confidence=confidence,
        categories=policy["categories"],
        integrity_signals=policy["integritySignals"],
        summary=summary,
        recommended_action=recommended_action,
        reviewer_handle=reviewer_handle,
        reviewer_wallet=reviewer_wallet,
        source_task_ids=source_task_ids or [],
        source_cids=source_cids or [],
        source_tx_hashes=source_tx_hashes or [],
        metadata=policy["metadata"],
    )
    return upsert_review_state(record, database_url=database_url)


def build_followup_request_text(review_record: dict[str, Any], *, extra: str = "") -> str:
    task_id = _safe_text(review_record.get("task_id") or review_record.get("taskId"), 180)
    summary = _safe_text(review_record.get("summary") or review_record.get("review_summary"), 2000)
    action = _safe_text(review_record.get("recommended_action") or review_record.get("recommendedAction"), 4000)
    categories = review_record.get("categories") or []
    if isinstance(categories, str):
        categories_text = categories
    else:
        categories_text = ", ".join(str(value) for value in categories if str(value or ""))
    validate_followup_action("reviewed_follow_up", action)
    return "\n".join(
        part for part in [
            f"Orc follow-up for reviewed Network Task {task_id}.",
            f"Review summary: {summary}" if summary else "",
            f"Categories: {categories_text}" if categories_text else "",
            f"Required action: {action}",
            _safe_text(extra, 2000),
            (
                "Deliver concrete evidence: changed files, commands run, query results, CIDs/tx hashes, "
                "or proof that no code/data change was required. Do not produce a passive memo unless the "
                "actual defect is missing documentation."
            ),
        ] if part
    )


def _review_state_update_from_existing(
    existing: dict[str, Any],
    *,
    disposition: str | None = None,
    action_required: bool | None = None,
    summary: str = "",
    recommended_action: str = "",
    metadata: dict[str, Any] | None = None,
    source_task_ids: list[str] | None = None,
    source_cids: list[str] | None = None,
    source_tx_hashes: list[str] | None = None,
    reviewer_handle: str = "",
    reviewer_wallet: str = "",
) -> dict[str, Any]:
    task_id = _review_text(existing, "task_id", "taskId", 180)
    if not task_id:
        raise ValueError("source review task id is required")
    existing_metadata = _review_metadata(existing)
    if metadata:
        existing_metadata.update(metadata)
    existing_source_tasks = _review_labels(existing, "source_task_ids", "sourceTaskIds")
    for source_task_id in source_task_ids or []:
        clean = _safe_text(source_task_id, 180)
        if clean and clean not in existing_source_tasks:
            existing_source_tasks.append(clean)
    existing_source_cids = _review_labels(existing, "source_cids", "sourceCids")
    for cid in source_cids or []:
        clean = _safe_text(cid, 180)
        if clean and clean not in existing_source_cids:
            existing_source_cids.append(clean)
    existing_source_txs = _review_labels(existing, "source_tx_hashes", "sourceTxHashes")
    for tx_hash in source_tx_hashes or []:
        clean = _safe_text(tx_hash, 180)
        if clean and clean not in existing_source_txs:
            existing_source_txs.append(clean)
    return normalize_review_state_record(
        task_id=task_id,
        disposition=disposition or _review_text(existing, "disposition", "reviewDisposition", 120) or "not_reviewed",
        action_required=action_required if action_required is not None else bool(existing.get("action_required") or existing.get("actionRequired")),
        action_owner=_review_text(existing, "action_owner", "actionOwner", 160),
        confidence=_review_text(existing, "confidence", "confidence", 40) or "medium",
        categories=_review_labels(existing, "categories", "categories"),
        integrity_signals=_review_labels(existing, "integrity_signals", "integritySignals"),
        summary=summary or _review_text(existing, "summary", "review_summary", 12000),
        recommended_action=recommended_action or _review_text(existing, "recommended_action", "recommendedAction", 12000),
        reviewer_handle=reviewer_handle or _review_text(existing, "reviewer_handle", "reviewerHandle", 160) or DEFAULT_ORC_AGENT,
        reviewer_wallet=reviewer_wallet or _review_text(existing, "reviewer_wallet", "reviewerWallet", 160) or DEFAULT_EXPECTED_WALLET_ADDRESS,
        source_task_ids=existing_source_tasks,
        source_cids=existing_source_cids,
        source_tx_hashes=existing_source_txs,
        metadata=existing_metadata,
    )


def _extract_followup_task_id(result: dict[str, Any]) -> str:
    return _safe_text(
        result.get("generatedTaskId")
        or result.get("generated_task_id")
        or result.get("followupTaskId")
        or result.get("taskId"),
        180,
    )


def _metadata_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _safe_text(value, 40).lower() in {"1", "true", "yes", "submitted"}


def _active_followup_from_review(review_record: dict[str, Any]) -> dict[str, Any]:
    metadata = _review_metadata(review_record)
    if _safe_text(metadata.get("followup_closed_at") or metadata.get("followupClosedAt"), 120):
        return {}
    request_id = _safe_text(
        metadata.get("followup_request_id")
        or metadata.get("followupRequestId"),
        180,
    )
    followup_task_id = _safe_text(
        metadata.get("followup_task_id")
        or metadata.get("followupTaskId"),
        180,
    )
    request_tx = _safe_text(
        metadata.get("followup_request_tx")
        or metadata.get("followupRequestTx"),
        180,
    )
    status = _safe_text(
        metadata.get("followup_status")
        or metadata.get("followupStatus"),
        120,
    ).lower()
    submitted = _metadata_truthy(metadata.get("followup_request_submitted")) or _metadata_truthy(
        metadata.get("followupRequestSubmitted")
    )
    if not (followup_task_id or request_tx or submitted or (request_id and status not in {"", "previewed", "preview"})):
        return {}
    return {
        "ok": True,
        "idempotent": True,
        "reason": "active_followup_exists",
        "requestId": request_id,
        "followupTaskId": followup_task_id,
        "requestStatus": status,
        "submitted": submitted,
        "txHash": request_tx,
        "reviewState": {
            "taskId": _review_text(review_record, "task_id", "taskId", 180),
            "followupRequestId": request_id,
            "followupTaskId": followup_task_id,
            "metadata": metadata,
            "updated": False,
        },
        "secretPrinted": False,
    }


def _append_followup_request_work_journal(
    review_record: dict[str, Any],
    *,
    task_id: str,
    linkage: dict[str, Any],
    idempotent: bool = False,
    database_url: str | None = None,
) -> dict[str, Any]:
    metadata = _review_metadata(review_record)
    followup_request_id = _safe_text(linkage.get("followup_request_id"), 180)
    followup_task_id = _safe_text(linkage.get("followup_task_id"), 180)
    request_cid = _safe_text(linkage.get("followup_request_cid"), 180)
    bundle_cid = _safe_text(linkage.get("followup_bundle_cid"), 180)
    request_tx = _safe_text(linkage.get("followup_request_tx"), 180)
    request_status = _safe_text(linkage.get("followup_status"), 120)
    submitted = bool(linkage.get("followup_request_submitted"))
    return append_orc_work_journal(
        {
            "interactionId": _safe_text(metadata.get("operator_interaction_id"), 180)
            or _safe_text(metadata.get("interactionId"), 180)
            or followup_request_id,
            "sourceTaskId": task_id,
            "reviewDisposition": _review_text(review_record, "disposition", "reviewDisposition", 120),
            "followupRequestId": followup_request_id,
            "followupTaskId": followup_task_id,
            "taskAction": "request_followup",
            "eventCid": request_cid or bundle_cid,
            "txHash": request_tx,
            "operatorHandle": _review_text(review_record, "reviewer_handle", "reviewerHandle", 160)
            or DEFAULT_ORC_AGENT,
            "status": "submitted" if submitted else "previewed",
            "outcomeStatus": request_status,
            "terminal": False,
            "metadata": {
                "source": "orcctl.request_followup",
                "followupRequestId": followup_request_id,
                "followupTaskId": followup_task_id,
                "submitted": submitted,
                "bundleCid": bundle_cid,
                "requestCid": request_cid,
                "requestTx": request_tx,
                "requestStatus": request_status,
                "idempotent": bool(idempotent),
            },
        },
        database_url=database_url,
    )


def request_followup_task(
    task_id: str,
    *,
    submit: bool = False,
    extra: str = "",
    client: Any | None = None,
    database_url: str | None = None,
) -> dict[str, Any]:
    review_record = get_review_state(task_id, database_url=database_url)
    disposition = _safe_text(review_record.get("disposition"), 120)
    if disposition not in ACTION_REQUIRED_DISPOSITIONS:
        raise ValueError(f"review state {disposition or 'not_reviewed'} does not require follow-up")
    existing_followup = _active_followup_from_review(review_record)
    if existing_followup:
        metadata = _review_metadata(review_record)
        existing_followup["workJournal"] = _append_followup_request_work_journal(
            review_record,
            task_id=task_id,
            linkage={
                "followup_request_id": existing_followup.get("requestId"),
                "followup_request_submitted": existing_followup.get("submitted"),
                "followup_status": existing_followup.get("requestStatus"),
                "followup_bundle_cid": metadata.get("followup_bundle_cid"),
                "followup_request_cid": metadata.get("followup_request_cid"),
                "followup_request_tx": existing_followup.get("txHash"),
                "followup_task_id": existing_followup.get("followupTaskId"),
            },
            idempotent=True,
            database_url=database_url,
        )
        return redact_secrets(existing_followup)
    request_text = build_followup_request_text(review_record, extra=extra)
    result = request_personal_task(request_text, submit=submit, client=client, requested_task_kind="personal")
    request_id = _safe_text(result.get("requestId"), 180)
    followup_task_id = _extract_followup_task_id(result)
    linkage = {
        "followup_request_id": request_id,
        "followup_request_submitted": bool(result.get("submitted")),
        "followup_requested_at": _utcnow(),
        "followup_status": _safe_text(result.get("requestStatus"), 120) or ("requested" if result.get("submitted") else "previewed"),
        "followup_bundle_cid": _safe_text(result.get("bundleCid"), 180),
        "followup_request_cid": _safe_text(result.get("eventCid"), 180),
        "followup_request_tx": _safe_text(result.get("txHash"), 180) if result.get("submitted") else "",
        "user_signal_status": _safe_text(_review_metadata(review_record).get("user_signal_status"), 120) or "not_sent",
    }
    if followup_task_id:
        linkage["followup_task_id"] = followup_task_id
    record = _review_state_update_from_existing(
        review_record,
        metadata=linkage,
        source_task_ids=[task_id, followup_task_id],
        source_cids=[linkage["followup_bundle_cid"], linkage["followup_request_cid"]],
        source_tx_hashes=[linkage["followup_request_tx"]],
    )
    updated = upsert_review_state(record, database_url=database_url)
    result["reviewState"] = {
        "taskId": task_id,
        "followupRequestId": request_id,
        "followupTaskId": followup_task_id,
        "metadata": linkage,
        "updated": bool(updated),
    }
    result["workJournal"] = _append_followup_request_work_journal(
        review_record,
        task_id=task_id,
        linkage=linkage,
        database_url=database_url,
    )
    return result


def signal_user(
    task_id: str,
    *,
    message: str,
    execute: bool = False,
    tasknode_repo: str = "/home/pfrpc/repos/tasknodeofficial",
    account_id: str = "",
    conversation_id: str = "",
    reviewer_handle: str = "",
    reviewer_wallet: str = "",
    reason: str = "",
    metadata: dict[str, Any] | None = None,
    database_url: str | None = None,
) -> dict[str, Any]:
    result = run_hive_signal(
        task_id=task_id,
        message=message,
        execute=execute,
        tasknode_repo=tasknode_repo,
        account_id=account_id,
        conversation_id=conversation_id,
        reviewer_handle=reviewer_handle,
        reviewer_wallet=reviewer_wallet,
        reason=reason,
        metadata=metadata or {},
        database_url=database_url,
    )
    chat_message_id = _safe_text(result.get("chatMessageId") or result.get("chat_message_id"), 240)
    visible = bool(result.get("visibleInHiveChat") or result.get("visible_in_hive_chat"))
    if not (result.get("ok") and result.get("executed") and visible and chat_message_id):
        return result

    existing = get_review_state(task_id, database_url=database_url) or {"task_id": task_id}
    signal_metadata = {
        "user_signal_status": "sent",
        "user_signal_message_id": chat_message_id,
        "user_signal_conversation_id": _safe_text(result.get("conversationId") or result.get("conversation_id"), 240),
        "user_signal_sent_at": _utcnow(),
        "user_signal_reason": _safe_text(reason, 1000),
        "user_signal_idempotent": bool(result.get("idempotent")),
        "user_signal_visible_in_hive_chat": True,
        # Backward-compatible alias for local Orc tooling and older close-followup output.
        "signalMessageId": chat_message_id,
    }
    if metadata:
        signal_metadata["user_signal_metadata"] = metadata
    record = _review_state_update_from_existing(
        existing,
        metadata=signal_metadata,
        source_task_ids=[task_id],
        reviewer_handle=reviewer_handle,
        reviewer_wallet=reviewer_wallet,
    )
    updated = upsert_review_state(record, database_url=database_url)
    work_journal = append_orc_work_journal(
        {
            "interactionId": signal_metadata["user_signal_conversation_id"],
            "sourceTaskId": task_id,
            "reviewDisposition": record["disposition"],
            "taskAction": "signal_user",
            "eventCid": chat_message_id,
            "operatorHandle": reviewer_handle
            or _review_text(existing, "reviewer_handle", "reviewerHandle", 160)
            or DEFAULT_ORC_AGENT,
            "status": "sent",
            "outcomeStatus": "visible",
            "terminal": False,
            "metadata": {
                "source": "orcctl.signal_user",
                "chatMessageId": chat_message_id,
                "conversationId": signal_metadata["user_signal_conversation_id"],
                "reason": signal_metadata["user_signal_reason"],
                "idempotent": signal_metadata["user_signal_idempotent"],
                "visibleInHiveChat": True,
            },
        },
        database_url=database_url,
    )
    result["reviewState"] = {
        "taskId": task_id,
        "updated": bool(updated),
        "userSignalStatus": "sent",
        "userSignalMessageId": chat_message_id,
        "conversationId": signal_metadata["user_signal_conversation_id"],
        "metadata": signal_metadata,
    }
    result["workJournal"] = work_journal
    return result


def _detail_task(detail: dict[str, Any]) -> dict[str, Any]:
    return _safe_dict(detail.get("task") or detail)


def close_followup(
    source_task_id: str,
    *,
    followup_task_id: str = "",
    payment_tx: str = "",
    signal_message_id: str = "",
    no_code_needed_proof: str = "",
    client: Any | None = None,
    database_url: str | None = None,
) -> dict[str, Any]:
    clean_followup = _safe_text(followup_task_id, 180)
    clean_proof = _safe_text(no_code_needed_proof, 4000)
    if not clean_followup and not clean_proof:
        raise ValueError("followup_task_id or no_code_needed_proof is required")
    active_client = client or build_client()
    detail: dict[str, Any] = {}
    task: dict[str, Any] = {}
    reward_outcome: dict[str, Any] = {}
    status = "no_code_needed" if clean_proof and not clean_followup else ""
    if clean_followup:
        active_client.login()
        detail = active_client.task_detail(clean_followup)
        task = _detail_task(detail)
        status = _task_status(task).lower()
        if status not in TERMINAL_TASK_STATUSES:
            raise ValueError(f"follow-up task is not terminal: {status or 'unknown'}")
        reward_outcome = _safe_dict(detail.get("rewardOutcome") or detail.get("reward") or {})
    existing = get_review_state(source_task_id, database_url=database_url)
    reward_tx = (
        _safe_text(payment_tx, 180)
        or _safe_text(reward_outcome.get("txHash") or reward_outcome.get("tx_hash"), 180)
        or _safe_text(task.get("lastEventTxHash") or task.get("txHash"), 180)
    )
    reward_cid = (
        _safe_text(reward_outcome.get("cid") or reward_outcome.get("eventCid") or reward_outcome.get("sourceCid"), 180)
        or _safe_text(task.get("lastEventCid") or task.get("cid"), 180)
    )
    metadata = {
        "followup_status": status,
        "followup_closed_at": _utcnow(),
        "followup_reward_tx": reward_tx,
        "followup_reward_cid": reward_cid,
        "followup_no_code_needed_proof": clean_proof,
        "user_signal_status": "sent" if _safe_text(signal_message_id, 240) else _safe_text(_review_metadata(existing).get("user_signal_status"), 120) or "not_sent",
        "user_signal_message_id": _safe_text(signal_message_id, 240),
        # Backward-compatible aliases for older local Orc tooling.
        "followupStatus": status,
        "paymentTx": reward_tx,
        "signalMessageId": _safe_text(signal_message_id, 240),
    }
    if clean_followup:
        metadata["followup_task_id"] = clean_followup
        metadata["followupTaskId"] = clean_followup
    summary = (
        _review_text(existing, "summary", "review_summary", 4000)
        or (
            f"Follow-up completed by {clean_followup}."
            if clean_followup
            else "Follow-up closed with explicit no-code-needed proof."
        )
    )
    record = _review_state_update_from_existing(
        existing,
        disposition="reviewed_follow_up_completed",
        action_required=False,
        summary=summary,
        recommended_action=(
            "No current action remains; explicit no-code-needed proof was recorded."
            if clean_proof and not clean_followup
            else "No current action remains; follow-up task reached terminal status."
        ),
        metadata=metadata,
        source_task_ids=[source_task_id, clean_followup],
        source_cids=[reward_cid],
        source_tx_hashes=[reward_tx],
    )
    updated = upsert_review_state(record, database_url=database_url)
    updated["workJournal"] = append_orc_work_journal(
        {
            "interactionId": _safe_text(_review_metadata(existing).get("operator_interaction_id"), 180)
            or _safe_text(_review_metadata(existing).get("interactionId"), 180),
            "sourceTaskId": source_task_id,
            "reviewDisposition": "reviewed_follow_up_completed",
            "followupRequestId": _safe_text(_review_metadata(existing).get("followup_request_id"), 180)
            or _safe_text(_review_metadata(existing).get("followupRequestId"), 180),
            "followupTaskId": clean_followup,
            "taskAction": "close_followup",
            "eventCid": reward_cid,
            "txHash": reward_tx,
            "operatorHandle": _safe_text(existing.get("reviewer_handle") or existing.get("reviewerHandle"), 160)
            or DEFAULT_ORC_AGENT,
            "status": "closed",
            "outcomeStatus": status,
            "terminal": True,
            "metadata": {
                "source": "orcctl.close_followup",
                "signalMessageId": _safe_text(signal_message_id, 240),
                "noCodeNeeded": bool(clean_proof and not clean_followup),
            },
        },
        database_url=database_url,
    )
    return updated


def _signed_flow_summary(result: Any, *, task_id: str, action: str) -> dict[str, Any]:
    submitted = _safe_dict(getattr(result, "submitted", None))
    prepared = _safe_dict(getattr(result, "prepared", None))
    signed = getattr(result, "signed", None)
    payload = _safe_dict(getattr(result, "payload", None))
    return redact_secrets({
        "ok": True,
        "taskId": task_id,
        "action": action,
        "submitted": getattr(result, "submitted", None) is not None,
        "cid": submitted.get("cid") or submitted.get("eventCid") or prepared.get("cid"),
        "txHash": submitted.get("txHash") or submitted.get("tx_hash") or getattr(signed, "tx_hash", None),
        "engineResult": submitted.get("engineResult") or submitted.get("engine_result"),
        "schema": payload.get("schema"),
        "secretPrinted": False,
    })


def _append_task_action_work_journal(
    summary: dict[str, Any],
    *,
    task_id: str,
    action: str,
    active_client: Any,
    run_id: str,
    database_url: str | None = None,
) -> dict[str, Any]:
    task_action = f"task_{_safe_text(action, 80)}"
    try:
        return append_orc_work_journal(
            {
                "sourceTaskId": task_id,
                "taskAction": task_action,
                "eventCid": _safe_text(summary.get("cid"), 180),
                "txHash": _safe_text(summary.get("txHash"), 180),
                "operatorHandle": _safe_text(getattr(active_client, "agent", ""), 160) or DEFAULT_ORC_AGENT,
                "status": "submitted" if summary.get("submitted") else "prepared",
                "outcomeStatus": _safe_text(summary.get("engineResult"), 120),
                "terminal": False,
                "metadata": {
                    "source": f"orcctl.{task_action}",
                    "runId": run_id,
                    "schema": _safe_text(summary.get("schema"), 180),
                    "submitted": bool(summary.get("submitted")),
                    "cid": _safe_text(summary.get("cid"), 180),
                    "txHash": _safe_text(summary.get("txHash"), 180),
                    "engineResult": _safe_text(summary.get("engineResult"), 120),
                },
            },
            database_url=database_url,
        )
    except Exception as exc:
        return redact_secrets({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "taskAction": task_action,
            "sourceTaskId": task_id,
            "secretPrinted": False,
        })


def task_accept(
    task_id: str,
    *,
    reason: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    run_id: str = "",
    database_url: str | None = None,
) -> dict[str, Any]:
    current_run_id = run_id or f"orcrun_{uuid4()}"
    append_run_journal(
        command="task.accept",
        phase="accept",
        status="started",
        run_id=current_run_id,
        task_id=task_id,
        journal_path=journal_path,
    )
    active_client = client or build_client()
    try:
        active_client.login()
        result = active_client.accept_task(task_id, reason=reason or "Accepted by Orc operator tooling.", submit=True)
        summary = _signed_flow_summary(result, task_id=task_id, action="accept")
        append_run_journal(
            command="task.accept",
            phase="accept",
            status="completed",
            run_id=current_run_id,
            task_id=task_id,
            cid=summary.get("cid") or "",
            tx_hash=summary.get("txHash") or "",
            metadata={"engineResult": summary.get("engineResult")},
            journal_path=journal_path,
        )
        summary["runId"] = current_run_id
        summary["workJournal"] = _append_task_action_work_journal(
            summary,
            task_id=task_id,
            action="accept",
            active_client=active_client,
            run_id=current_run_id,
            database_url=database_url,
        )
        return summary
    except Exception as exc:
        append_run_journal(
            command="task.accept",
            phase="accept",
            status="failed",
            run_id=current_run_id,
            task_id=task_id,
            error=f"{type(exc).__name__}: {exc}",
            journal_path=journal_path,
        )
        raise


def task_submit(
    task_id: str,
    *,
    evidence_text: str,
    notes: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    run_id: str = "",
    database_url: str | None = None,
) -> dict[str, Any]:
    if not _safe_text(evidence_text, 1_000_000):
        raise ValueError("evidence text is required")
    current_run_id = run_id or f"orcrun_{uuid4()}"
    append_run_journal(
        command="task.submit",
        phase="submit",
        status="started",
        run_id=current_run_id,
        task_id=task_id,
        journal_path=journal_path,
    )
    active_client = client or build_client()
    try:
        active_client.login()
        result = active_client.submit_evidence(task_id, evidence_text=evidence_text, notes=notes, submit=True)
        summary = _signed_flow_summary(result, task_id=task_id, action="submit")
        append_run_journal(
            command="task.submit",
            phase="submit",
            status="completed",
            run_id=current_run_id,
            task_id=task_id,
            cid=summary.get("cid") or "",
            tx_hash=summary.get("txHash") or "",
            metadata={"engineResult": summary.get("engineResult")},
            journal_path=journal_path,
        )
        summary["runId"] = current_run_id
        summary["workJournal"] = _append_task_action_work_journal(
            summary,
            task_id=task_id,
            action="submit",
            active_client=active_client,
            run_id=current_run_id,
            database_url=database_url,
        )
        return summary
    except Exception as exc:
        append_run_journal(
            command="task.submit",
            phase="submit",
            status="failed",
            run_id=current_run_id,
            task_id=task_id,
            error=f"{type(exc).__name__}: {exc}",
            journal_path=journal_path,
        )
        raise


def task_respond(
    task_id: str,
    *,
    response_text: str,
    notes: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    run_id: str = "",
    database_url: str | None = None,
) -> dict[str, Any]:
    if not _safe_text(response_text, 1_000_000):
        raise ValueError("verification response text is required")
    current_run_id = run_id or f"orcrun_{uuid4()}"
    append_run_journal(
        command="task.respond",
        phase="respond",
        status="started",
        run_id=current_run_id,
        task_id=task_id,
        journal_path=journal_path,
    )
    active_client = client or build_client()
    try:
        active_client.login()
        result = active_client.respond_verification(task_id, response_text=response_text, notes=notes, submit=True)
        summary = _signed_flow_summary(result, task_id=task_id, action="respond")
        append_run_journal(
            command="task.respond",
            phase="respond",
            status="completed",
            run_id=current_run_id,
            task_id=task_id,
            cid=summary.get("cid") or "",
            tx_hash=summary.get("txHash") or "",
            metadata={"engineResult": summary.get("engineResult")},
            journal_path=journal_path,
        )
        summary["runId"] = current_run_id
        summary["workJournal"] = _append_task_action_work_journal(
            summary,
            task_id=task_id,
            action="respond",
            active_client=active_client,
            run_id=current_run_id,
            database_url=database_url,
        )
        return summary
    except Exception as exc:
        append_run_journal(
            command="task.respond",
            phase="respond",
            status="failed",
            run_id=current_run_id,
            task_id=task_id,
            error=f"{type(exc).__name__}: {exc}",
            journal_path=journal_path,
        )
        raise


def task_observe(task_id: str, *, client: Any | None = None) -> dict[str, Any]:
    return task_payload(task_id, client=client)


GENERIC_VERIFICATION_MARKERS = (
    "submit mixed",
    "submit the script file",
    "submit the public artifact url",
    "submit the public artifact",
    "submit the code bundle",
    "submit the changed file paths",
)


def _verification_text_from_authenticated(detail: dict[str, Any]) -> str:
    task = _safe_dict(detail.get("task")) or detail
    verification = _safe_dict(task.get("verification"))
    return _safe_text(
        verification.get("request")
        or verification.get("body")
        or verification.get("title")
        or task.get("verificationRequest")
        or task.get("verificationPrompt"),
        6000,
    )


def _verification_text_from_hive(detail: dict[str, Any]) -> str:
    review = _safe_dict(detail.get("review"))
    verification = _safe_dict(review.get("verification"))
    return _safe_text(verification.get("request") or verification.get("body") or verification.get("title"), 6000)


def _is_generic_verification_text(text: str) -> bool:
    normalized = _safe_text(text, 6000).lower()
    return bool(normalized) and any(marker in normalized for marker in GENERIC_VERIFICATION_MARKERS)


def _hive_outcome(detail: dict[str, Any]) -> dict[str, Any]:
    review = _safe_dict(detail.get("review"))
    outcome = _safe_dict(review.get("outcome"))
    task = _safe_dict(detail.get("task"))
    return {
        "decision": _safe_text(outcome.get("decision"), 120),
        "rewardPft": outcome.get("rewardPft") or task.get("pft"),
        "reason": _safe_text(outcome.get("reason"), 6000),
    }


def inspect_verification_request(task_id: str, *, client: Any | None = None) -> dict[str, Any]:
    active_client = client or build_client()
    active_client.login()
    authenticated_detail = active_client.task_detail(task_id)
    hive_detail: dict[str, Any] = {}
    hive_error = ""
    try:
        hive_detail = active_client.hive_task_detail(task_id)
    except Exception as exc:  # pragma: no cover - live API fallback
        hive_error = f"{type(exc).__name__}: {exc}"

    authenticated_task = _safe_dict(authenticated_detail.get("task")) or authenticated_detail
    hive_task = _safe_dict(hive_detail.get("task"))
    authenticated_request = _verification_text_from_authenticated(authenticated_detail)
    hive_request = _verification_text_from_hive(hive_detail)
    authenticated_generic = _is_generic_verification_text(authenticated_request)
    hive_specific = bool(hive_request) and hive_request != authenticated_request and not _is_generic_verification_text(hive_request)
    warnings: list[str] = []
    if authenticated_generic and hive_specific:
        warnings.append("authenticated_detail_generic_public_hive_specific")
    if authenticated_request and hive_request and authenticated_request != hive_request:
        warnings.append("verification_request_sources_differ")
    if hive_error:
        warnings.append("public_hive_detail_unavailable")

    selected_source = "public_hive" if hive_specific else "authenticated"
    selected_request = hive_request if selected_source == "public_hive" else authenticated_request
    review = _safe_dict(hive_detail.get("review"))
    hive_verification = _safe_dict(review.get("verification"))
    return redact_secrets({
        "ok": True,
        "taskId": task_id,
        "selectedSource": selected_source,
        "selectedVerificationRequest": selected_request,
        "warnings": warnings,
        "authenticated": {
            "status": authenticated_task.get("status") or authenticated_task.get("statusKey"),
            "verificationRequest": authenticated_request,
            "isGenericVerificationRequest": authenticated_generic,
        },
        "publicHive": {
            "available": bool(hive_detail),
            "error": hive_error,
            "state": hive_task.get("state") or hive_task.get("status"),
            "verificationRequest": hive_request,
            "verificationResponse": _safe_text(hive_verification.get("response"), 6000),
            "outcome": _hive_outcome(hive_detail),
        },
        "operatorGuidance": (
            "Use selectedVerificationRequest for the response. If warnings include "
            "authenticated_detail_generic_public_hive_specific, do not answer the generic "
            "authenticated prompt; answer the specific public Hive follow-up."
        ),
        "secretPrinted": False,
    })


def _inventory_summary(inventory: dict[str, Any]) -> dict[str, Any]:
    groups = _safe_dict(inventory.get("groups"))
    return {
        "networkStatus": inventory.get("networkStatus"),
        "outstanding": _safe_dict(groups.get("outstanding")).get("count", 0),
        "verification": _safe_dict(groups.get("verification")).get("count", 0),
        "staleFollowups": _safe_dict(inventory.get("staleFollowups")).get("count", 0),
        "reviewQueue": _safe_dict(inventory.get("reviewQueue")),
    }


def _first_closeable_followup(inventory: dict[str, Any]) -> dict[str, Any]:
    rows = _safe_list(_safe_dict(inventory.get("staleFollowups")).get("closeable"))
    return _safe_dict(rows[0]) if rows else {}


def _source_for_triage(source: str, index: int) -> str:
    normalized = _safe_text(source, 80) or "auto"
    if normalized not in SELF_CYCLE_SOURCES:
        raise ValueError("source must be auto, review-queue, operator-outstanding, or directory-rewarded-tasks")
    if normalized != "auto":
        return normalized
    return "operator-outstanding" if index == 0 else "review-queue"


def _review_categories_from_priority(item: dict[str, Any]) -> list[str]:
    text = " ".join(
        [
            _safe_text(item.get("title"), 400),
            _safe_text(item.get("taskProposalDescription"), 1200),
            " ".join(_safe_text(value, 300) for value in _safe_list(item.get("reasons"))),
            " ".join(_safe_text(value, 300) for value in _safe_list(item.get("redFlags"))),
        ]
    ).lower()
    categories: list[str] = []
    checks = [
        ("reward_accounting", ("reward", "pft", "payout", "payment", "clawback")),
        ("security", ("sybil", "abuse", "security", "exploit", "blocklist")),
        ("task_generation", ("generation", "generated", "taskgen", "board manager")),
        ("task_routing", ("routing", "allocation", "directory", "hive")),
        ("verification_policy", ("verification", "evidence", "review", "submission")),
        ("agent_tooling", ("orc", "agent", "tooling", "script", "cli")),
        ("operator_workflow", ("workflow", "operator", "friction")),
        ("docs", ("doc", "wiki", "documentation")),
    ]
    for category, terms in checks:
        if any(term in text for term in terms) and category not in categories:
            categories.append(category)
    if not categories:
        categories.append("product_feedback")
    return categories[:4]


def _review_integrity_signals_from_priority(item: dict[str, Any]) -> list[str]:
    text = " ".join(
        [
            _safe_text(item.get("title"), 400),
            _safe_text(item.get("taskProposalDescription"), 1200),
            " ".join(_safe_text(value, 300) for value in _safe_list(item.get("redFlags"))),
            " ".join(_safe_text(value, 300) for value in _safe_list(item.get("reasons"))),
        ]
    ).lower()
    signals: list[str] = []
    if "duplicate" in text:
        signals.append("duplicate_submission")
    if "sybil" in text:
        signals.append("suspected_sybil_cluster")
    if "reward abuse" in text or "farming" in text:
        signals.append("reward_abuse_pattern")
    if "generic" in text or "low-value" in text or "low value" in text:
        signals.append("generic_ai_response")
    if _safe_dict(item.get("integrityPolicy")).get("controlMarker") == NO_SIGNING_NO_FUND_MOVEMENT_MARKER:
        signals.append(EXECUTABLE_REWARD_CLAWBACK_SIGNAL)
    return sorted(set(signals))


def _self_cycle_recommended_action(item: dict[str, Any], review: dict[str, Any]) -> str:
    task = _safe_dict(review.get("task"))
    title = _safe_text(item.get("title") or task.get("title"), 240)
    first_slice = _safe_text(item.get("firstWorkSlice"), 1200)
    if not first_slice:
        first_slice = "inspect the public evidence packet, verify the current code/data state, and produce the smallest concrete fix or proof packet"
    return _safe_text(
        "Verify this rewarded Network task and execute the smallest concrete follow-up. "
        f"Task: {title or _safe_text(item.get('taskId'), 180)}. "
        f"First work slice: {first_slice}. "
        "Deliver concrete evidence: changed files, query results, smoke output, CIDs/tx hashes, "
        "or a user signal plus proof that no code/data change was required.",
        4000,
    )


def _self_cycle_review_record(
    item: dict[str, Any],
    review: dict[str, Any],
    *,
    agent: str,
    reviewer_wallet: str,
    min_followup_priority: float,
) -> dict[str, Any]:
    triage = _safe_dict(item.get("triage"))
    task_id = _safe_text(item.get("taskId") or triage.get("taskId"), 180)
    priority = float(item.get("priorityScore") or 0)
    rank_bucket = _safe_text(item.get("rankBucket"), 80)
    integrity_signals = _review_integrity_signals_from_priority(item)
    categories = _review_categories_from_priority(item)
    if integrity_signals:
        disposition = "reviewed_integrity_follow_up"
        action_required = True
    elif rank_bucket == "refuse_or_escalate":
        disposition = "reviewed_unclear"
        action_required = True
    elif priority >= min_followup_priority or rank_bucket in {"do_first", "do_next"}:
        disposition = "reviewed_follow_up"
        action_required = True
    else:
        disposition = "reviewed_unclear"
        action_required = True
    reasons = [_safe_text(value, 320) for value in _safe_list(item.get("reasons")) if _safe_text(value, 320)]
    red_flags = [_safe_text(value, 320) for value in _safe_list(item.get("redFlags")) if _safe_text(value, 320)]
    summary_parts = [
        f"Orc self-cycle selected this rewarded Network task with priority {priority:g} ({rank_bucket or 'unbucketed'}).",
        f"Reasons: {'; '.join(reasons[:3])}." if reasons else "",
        f"Red flags: {'; '.join(red_flags[:3])}." if red_flags else "",
    ]
    task = _safe_dict(review.get("task"))
    return {
        "taskId": task_id,
        "disposition": disposition,
        "summary": " ".join(part for part in summary_parts if part),
        "recommendedAction": _self_cycle_recommended_action(item, review),
        "categories": categories,
        "integritySignals": integrity_signals,
        "actionRequired": action_required,
        "confidence": _safe_text(item.get("confidence"), 40) or "medium",
        "reviewerHandle": agent,
        "reviewerWallet": reviewer_wallet,
        "sourceTaskIds": [task_id],
        "sourceCids": [
            cid for cid in _safe_list(task.get("sourceCids"))
            if _safe_text(cid, 180)
        ],
        "sourceTxHashes": [
            tx for tx in _safe_list(task.get("sourceTxHashes"))
            if _safe_text(tx, 180)
        ],
        "metadata": {
            "source": "orcctl.self_cycle",
            "triage": triage,
            "priority": {
                "priorityScore": priority,
                "rankBucket": rank_bucket,
                "sourceMode": item.get("sourceMode"),
                "scoredBy": item.get("scoredBy"),
                "firstWorkSlice": item.get("firstWorkSlice"),
                "acceptanceRationale": item.get("acceptanceRationale"),
            },
        },
    }


def _self_cycle_execute_review(
    item: dict[str, Any],
    *,
    active_client: Any,
    agent: str,
    reviewer_wallet: str,
    database_url: str | None,
    execute: bool,
    request_followup: bool,
    submit_followup: bool,
    followup_extra: str,
    min_followup_priority: float,
) -> dict[str, Any]:
    task_id = _safe_text(item.get("taskId"), 180)
    review = review_next(task_id=task_id, database_url=database_url)
    record = _self_cycle_review_record(
        item,
        review,
        agent=agent,
        reviewer_wallet=reviewer_wallet,
        min_followup_priority=min_followup_priority,
    )
    actions: list[dict[str, Any]] = [{
        "action": "review_next",
        "taskId": task_id,
        "executed": True,
        "result": review,
    }]
    if not execute:
        actions.append({
            "action": "classify_review",
            "taskId": task_id,
            "executed": False,
            "plannedRecord": record,
        })
        return {"outcome": "planned_review", "taskId": task_id, "actions": actions}

    classified = classify_review(
        task_id,
        disposition=record["disposition"],
        summary=record["summary"],
        recommended_action=record["recommendedAction"],
        categories=record["categories"],
        integrity_signals=record["integritySignals"],
        action_required=record["actionRequired"],
        confidence=record["confidence"],
        reviewer_handle=record["reviewerHandle"],
        reviewer_wallet=record["reviewerWallet"],
        source_task_ids=record["sourceTaskIds"],
        source_cids=record["sourceCids"],
        source_tx_hashes=record["sourceTxHashes"],
        metadata=record["metadata"],
        database_url=database_url,
    )
    actions.append({
        "action": "classify_review",
        "taskId": task_id,
        "executed": True,
        "result": classified,
    })
    if request_followup and record["disposition"] in FOLLOWUP_DISPOSITIONS:
        followup = request_followup_task(
            task_id,
            submit=submit_followup,
            extra=followup_extra,
            client=active_client,
            database_url=database_url,
        )
        actions.append({
            "action": "request_followup",
            "taskId": task_id,
            "executed": True,
            "submitted": bool(followup.get("submitted")),
            "result": followup,
        })
    return {"outcome": "review_executed", "taskId": task_id, "actions": actions}


def _self_cycle_execute_required_followup(
    item: dict[str, Any],
    *,
    active_client: Any,
    execute: bool,
    submit_followup: bool,
    followup_extra: str,
    database_url: str | None,
) -> dict[str, Any]:
    task_id = _safe_text(item.get("taskId"), 180)
    if not execute:
        return {
            "outcome": "planned_followup_request",
            "taskId": task_id,
            "actions": [{
                "action": "request_followup",
                "taskId": task_id,
                "executed": False,
                "submit": bool(submit_followup),
            }],
        }
    followup = request_followup_task(
        task_id,
        submit=submit_followup,
        extra=followup_extra,
        client=active_client,
        database_url=database_url,
    )
    return {
        "outcome": "followup_requested",
        "taskId": task_id,
        "actions": [{
            "action": "request_followup",
            "taskId": task_id,
            "executed": True,
            "submitted": bool(followup.get("submitted")),
            "result": followup,
        }],
    }


def _self_cycle_execute_assigned_task(
    item: dict[str, Any],
    *,
    active_client: Any,
    execute: bool,
    accept_assigned: bool,
    evidence_text: str,
    response_text: str,
    notes: str,
    journal_path: str,
    database_url: str | None,
) -> dict[str, Any]:
    task_id = _safe_text(item.get("taskId"), 180)
    detail = task_observe(task_id, client=active_client)
    task = _detail_task(detail)
    status = _task_status(task).lower()
    actions: list[dict[str, Any]] = [{
        "action": "task_detail",
        "taskId": task_id,
        "executed": True,
        "result": detail,
    }]
    if not execute:
        return {"outcome": "planned_assigned_task", "taskId": task_id, "actions": actions}
    if status == "proposed":
        if not accept_assigned:
            actions.append({
                "action": "task_accept",
                "taskId": task_id,
                "executed": False,
                "blocker": "accept_assigned_required",
            })
            return {"outcome": "blocked_assigned_accept", "taskId": task_id, "actions": actions}
        actions.append({
            "action": "task_accept",
            "taskId": task_id,
            "executed": True,
            "result": task_accept(
                task_id,
                reason="Accepted by Orc self-cycle after inventory triage.",
                client=active_client,
                journal_path=journal_path,
                database_url=database_url,
            ),
        })
        status = "accepted"
    if evidence_text and status in {"accepted", "proposed"}:
        actions.append({
            "action": "task_submit",
            "taskId": task_id,
            "executed": True,
            "result": task_submit(
                task_id,
                evidence_text=evidence_text,
                notes=notes,
                client=active_client,
                journal_path=journal_path,
                database_url=database_url,
            ),
        })
    if response_text:
        actions.append({
            "action": "task_respond",
            "taskId": task_id,
            "executed": True,
            "result": task_respond(
                task_id,
                response_text=response_text,
                notes=notes,
                client=active_client,
                journal_path=journal_path,
                database_url=database_url,
            ),
        })
    return {"outcome": "assigned_task_executed", "taskId": task_id, "actions": actions}


def self_cycle(
    *,
    client: Any | None = None,
    agent: str = DEFAULT_ORC_AGENT,
    reviewer_wallet: str = "",
    database_url: str | None = None,
    source: str = "auto",
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = False,
    max_tasks: int = 20,
    candidate_limit: int = 25,
    model_limit: int = 10,
    task_kind: str = "network",
    include_fixtures: bool = False,
    execute: bool = False,
    close_stale: bool = True,
    request_followup: bool = True,
    submit_followup: bool = False,
    followup_extra: str = "",
    accept_assigned: bool = False,
    evidence_text: str = "",
    response_text: str = "",
    notes: str = "",
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    min_followup_priority: float = 55,
) -> dict[str, Any]:
    run_id = f"orcrun_{uuid4()}"
    active_client = client or build_client(agent=agent)
    append_run_journal(
        command="self-cycle",
        phase="start",
        status="started",
        run_id=run_id,
        metadata={"source": source, "execute": execute},
        journal_path=journal_path,
    )
    try:
        inventory = operator_status(client=active_client, database_url=database_url, close_stale=False)
        selected: dict[str, Any] = {}
        triage_payload: dict[str, Any] = {}
        actions: list[dict[str, Any]] = []
        closeable = _first_closeable_followup(inventory) if close_stale else {}
        if closeable:
            task_id = _safe_text(closeable.get("sourceTaskId"), 180)
            followup_task_id = _safe_text(closeable.get("followupTaskId"), 180)
            if execute:
                closed = close_followup(
                    task_id,
                    followup_task_id=followup_task_id,
                    payment_tx=_safe_text(closeable.get("followupRewardTx"), 180),
                    client=active_client,
                    database_url=database_url,
                )
                actions.append({
                    "action": "close_followup",
                    "taskId": task_id,
                    "followupTaskId": followup_task_id,
                    "executed": True,
                    "result": closed,
                })
                outcome = "stale_followup_closed"
            else:
                actions.append({
                    "action": "close_followup",
                    "taskId": task_id,
                    "followupTaskId": followup_task_id,
                    "executed": False,
                })
                outcome = "planned_stale_followup_close"
            payload = {
                "ok": True,
                "runId": run_id,
                "agent": agent,
                "mode": "execute" if execute else "dry_run",
                "inventory": _inventory_summary(inventory),
                "selected": closeable,
                "outcome": outcome,
                "actions": actions,
                "secretPrinted": False,
            }
            append_run_journal(
                command="self-cycle",
                phase="finish",
                status="completed",
                run_id=run_id,
                task_id=task_id,
                followup_task_id=followup_task_id,
                metadata={"outcome": outcome},
                journal_path=journal_path,
            )
            return redact_secrets(payload)

        for source_index in range(2 if source == "auto" else 1):
            triage_source = _source_for_triage(source, source_index)
            triage_payload = triage_network_work(
                source=triage_source,
                client=active_client,
                model=model,
                max_tasks=max_tasks,
                candidate_limit=candidate_limit,
                model_limit=model_limit,
                disposition="not_reviewed",
                task_kind=task_kind,
                use_openrouter=use_openrouter,
                include_fixtures=include_fixtures,
                database_url=database_url,
            )
            selected = _safe_dict(triage_payload.get("nextItem"))
            if selected:
                break
        if not selected:
            payload = {
                "ok": True,
                "runId": run_id,
                "agent": agent,
                "mode": "execute" if execute else "dry_run",
                "inventory": _inventory_summary(inventory),
                "triage": triage_payload,
                "selected": {},
                "outcome": "idle_no_work",
                "actions": [],
                "secretPrinted": False,
            }
            append_run_journal(
                command="self-cycle",
                phase="finish",
                status="idle",
                run_id=run_id,
                metadata={"outcome": "idle_no_work"},
                journal_path=journal_path,
            )
            return redact_secrets(payload)

        triage = _safe_dict(selected.get("triage"))
        decision = _safe_text(triage.get("decision"), 120)
        wallet = reviewer_wallet or _safe_text(getattr(active_client, "address", ""), 180)
        if decision == "continue_required_followup":
            result = _self_cycle_execute_required_followup(
                selected,
                active_client=active_client,
                execute=execute,
                submit_followup=submit_followup,
                followup_extra=followup_extra,
                database_url=database_url,
            )
        elif decision == "work_assigned_network_task":
            result = _self_cycle_execute_assigned_task(
                selected,
                active_client=active_client,
                execute=execute,
                accept_assigned=accept_assigned,
                evidence_text=evidence_text,
                response_text=response_text,
                notes=notes,
                journal_path=journal_path,
                database_url=database_url,
            )
        else:
            result = _self_cycle_execute_review(
                selected,
                active_client=active_client,
                agent=agent,
                reviewer_wallet=wallet,
                database_url=database_url,
                execute=execute,
                request_followup=request_followup,
                submit_followup=submit_followup,
                followup_extra=followup_extra,
                min_followup_priority=min_followup_priority,
            )

        payload = {
            "ok": True,
            "runId": run_id,
            "agent": agent,
            "mode": "execute" if execute else "dry_run",
            "inventory": _inventory_summary(inventory),
            "triage": triage_payload,
            "selected": selected,
            **result,
            "secretPrinted": False,
        }
        append_run_journal(
            command="self-cycle",
            phase="finish",
            status="completed",
            run_id=run_id,
            task_id=_safe_text(selected.get("taskId"), 180),
            metadata={"outcome": payload.get("outcome"), "decision": decision},
            journal_path=journal_path,
        )
        return redact_secrets(payload)
    except Exception as exc:
        append_run_journal(
            command="self-cycle",
            phase="finish",
            status="failed",
            run_id=run_id,
            error=f"{type(exc).__name__}: {exc}",
            journal_path=journal_path,
        )
        raise


def self_loop(
    *,
    iterations: int = 1,
    sleep_seconds: float = 30,
    stop_on_idle: bool = True,
    sleep_fn: Any = time.sleep,
    **cycle_kwargs: Any,
) -> dict[str, Any]:
    max_iterations = max(1, min(1000, int(iterations or 1)))
    delay = max(0.0, float(sleep_seconds or 0))
    results: list[dict[str, Any]] = []
    for index in range(max_iterations):
        result = self_cycle(**cycle_kwargs)
        result["iteration"] = index + 1
        results.append(result)
        outcome = _safe_text(result.get("outcome"), 120)
        if stop_on_idle and outcome in {"idle_no_work", "blocked_assigned_accept"}:
            break
        if index + 1 < max_iterations and delay > 0:
            sleep_fn(delay)
    return redact_secrets({
        "ok": True,
        "iterationsRequested": max_iterations,
        "iterationsRun": len(results),
        "stoppedOnIdle": bool(stop_on_idle and results and _safe_text(results[-1].get("outcome"), 120) in {"idle_no_work", "blocked_assigned_accept"}),
        "results": results,
        "secretPrinted": False,
    })


def run_personal_task(
    task_id: str,
    *,
    evidence_text: str = "",
    response_text: str = "",
    accept_reason: str = "",
    notes: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    database_url: str | None = None,
) -> dict[str, Any]:
    run_id = f"orcrun_{uuid4()}"
    active_client = client or build_client()
    active_client.login()
    append_run_journal(
        command="run-personal-task",
        phase="start",
        status="started",
        run_id=run_id,
        task_id=task_id,
        journal_path=journal_path,
    )
    results: list[dict[str, Any]] = []
    detail = task_observe(task_id, client=active_client)
    status = _safe_text(_safe_dict(detail.get("task")).get("status"), 80).lower()
    kind = _safe_text(_safe_dict(detail.get("task")).get("kind"), 80).lower()
    if kind and kind != "personal":
        raise ValueError(f"run-personal-task only operates Personal tasks, got {kind}")
    if status == "proposed":
        results.append(task_accept(
            task_id,
            reason=accept_reason,
            client=active_client,
            journal_path=journal_path,
            run_id=run_id,
            database_url=database_url,
        ))
        detail = task_observe(task_id, client=active_client)
        status = _safe_text(_safe_dict(detail.get("task")).get("status"), 80).lower()
    if evidence_text and status in {"accepted", "proposed"}:
        results.append(task_submit(
            task_id,
            evidence_text=evidence_text,
            notes=notes,
            client=active_client,
            journal_path=journal_path,
            run_id=run_id,
            database_url=database_url,
        ))
        detail = task_observe(task_id, client=active_client)
    if response_text:
        results.append(task_respond(
            task_id,
            response_text=response_text,
            notes=notes,
            client=active_client,
            journal_path=journal_path,
            run_id=run_id,
            database_url=database_url,
        ))
        detail = task_observe(task_id, client=active_client)
    append_run_journal(
        command="run-personal-task",
        phase="finish",
        status="completed",
        run_id=run_id,
        task_id=task_id,
        metadata={"resultCount": len(results), "finalStatus": _safe_dict(detail.get("task")).get("status")},
        journal_path=journal_path,
    )
    return redact_secrets({
        "ok": True,
        "runId": run_id,
        "taskId": task_id,
        "results": results,
        "finalStatus": _safe_dict(detail.get("task")).get("status"),
        "rewardOutcome": detail.get("rewardOutcome"),
        "secretPrinted": False,
    })


def _read_text_arg(*, text: str = "", path: str = "") -> str:
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    return text


def _load_json_object(value: str) -> dict[str, Any]:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("value must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="orcctl", description="Compact Orc operator console for Task Node workflows.")
    parser.add_argument("--agent", default=DEFAULT_ORC_AGENT, help="Assigned Orc agent handle for reviewer identity.")
    parser.add_argument("--wallet-address", default=DEFAULT_EXPECTED_WALLET_ADDRESS, help="Optional expected signer wallet address assertion.")
    parser.add_argument("--base-url", default=DEFAULT_TASKNODE_BASE_URL, help="Task Node API base URL.")
    parser.add_argument("--session-store", default="", help="0600 session cache JSON path.")
    parser.add_argument("--database-url", default="", help="Override database URL. Defaults to Task Node env/local config.")
    parser.add_argument("--journal-path", default=DEFAULT_RUN_JOURNAL_PATH, help="JSONL run journal for mutating task actions.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status", help="Show compact Orc operating state.")
    status_parser.add_argument("--close-stale", action="store_true", help="Close stale follow-up reviews that already have terminal task evidence.")

    review_parser = subparsers.add_parser("review", help="Review rewarded Network Task packets.")
    review_sub = review_parser.add_subparsers(dest="review_command", required=True)
    next_parser = review_sub.add_parser("next", help="Show the next compact review packet.")
    next_parser.add_argument("--task-id", default="")
    next_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), default="not_reviewed")
    next_parser.add_argument("--raw", action="store_true", help="Include the compact raw review task.")
    next_parser.add_argument("--raw-events", action="store_true", help="Include redacted raw task events in the raw task.")
    next_parser.add_argument("--include-fixtures", action="store_true", help="Allow local smoke/QA fixture rows.")
    next_parser.add_argument("--text-limit", type=int, default=1200)

    classify_parser = review_sub.add_parser("classify", help="Classify a reviewed source task.")
    classify_parser.add_argument("task_id")
    classify_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), required=True)
    classify_parser.add_argument("--summary", required=True)
    classify_parser.add_argument("--action", "--recommended-action", dest="recommended_action", default="")
    classify_parser.add_argument("--category", action="append", default=[])
    classify_parser.add_argument("--integrity-signal", action="append", default=[])
    classify_parser.add_argument("--confidence", choices=["low", "medium", "high"], default="medium")
    classify_parser.add_argument("--action-owner", default="")
    classify_parser.add_argument("--reviewer-handle", default="")
    classify_parser.add_argument("--reviewer-wallet", default="")
    classify_parser.add_argument("--source-task-id", action="append", default=[])
    classify_parser.add_argument("--source-cid", action="append", default=[])
    classify_parser.add_argument("--source-tx-hash", action="append", default=[])
    classify_parser.add_argument("--metadata-json", type=_load_json_object, default={})
    classify_parser.add_argument("--action-required", action=argparse.BooleanOptionalAction, default=None)

    chat_parser = subparsers.add_parser("chat", help="Send a labeled agent message to Task Node chat.")
    chat_parser.add_argument("message", nargs=argparse.REMAINDER, help="Message text to send.")
    chat_parser.add_argument("--mode", default="Help", help="Task Node chat mode label.")
    chat_parser.add_argument("--conversation-id", default="agent-chat")
    chat_parser.add_argument("--metadata-json", type=_load_json_object, default={})
    chat_parser.add_argument("--dry-run", action="store_true")

    hive_chat_parser = subparsers.add_parser("hive-chat", help="Send a labeled agent message to Hive chat.")
    hive_chat_parser.add_argument("message", nargs=argparse.REMAINDER, help="Message text to send.")
    hive_chat_parser.add_argument("--conversation-id", default="")
    hive_chat_parser.add_argument("--conversation-title", default="Hive")
    hive_chat_parser.add_argument("--metadata-json", type=_load_json_object, default={})

    request_parser = subparsers.add_parser("request-followup", help="Request a Personal follow-up task for this Orc.")
    request_parser.add_argument("task_id")
    request_parser.add_argument("--extra", default="")
    request_parser.add_argument("--submit", action="store_true")

    self_cycle_parser = subparsers.add_parser("self-cycle", help="Scan inventory, choose one Orc work item, and optionally execute it.")
    self_cycle_parser.add_argument("--source", choices=sorted(SELF_CYCLE_SOURCES), default="auto")
    self_cycle_parser.add_argument("--model", default=DEFAULT_PRIORITY_MODEL)
    self_cycle_parser.add_argument("--max-tasks", type=int, default=20)
    self_cycle_parser.add_argument("--candidate-limit", type=int, default=25)
    self_cycle_parser.add_argument("--model-limit", type=int, default=10)
    self_cycle_parser.add_argument("--task-kind", choices=["network", "personal", "all"], default="network")
    self_cycle_parser.add_argument("--include-fixtures", action="store_true")
    self_cycle_parser.add_argument("--heuristic-only", action="store_true", help="Skip OpenRouter and use deterministic local scoring.")
    self_cycle_parser.add_argument("--execute", action="store_true", help="Persist/submit the selected bounded work unit.")
    self_cycle_parser.add_argument("--no-close-stale", action="store_true", help="Skip stale follow-up closure candidates.")
    self_cycle_parser.add_argument("--no-request-followup", action="store_true", help="Do not request a follow-up after classifying a review.")
    self_cycle_parser.add_argument("--submit-followup", action="store_true", help="Publish the follow-up request pointer instead of previewing it.")
    self_cycle_parser.add_argument("--followup-extra", default="")
    self_cycle_parser.add_argument("--accept-assigned", action="store_true", help="Allow accepting a proposed assigned task.")
    self_cycle_parser.add_argument("--evidence", default="")
    self_cycle_parser.add_argument("--evidence-file", default="")
    self_cycle_parser.add_argument("--response", default="")
    self_cycle_parser.add_argument("--response-file", default="")
    self_cycle_parser.add_argument("--notes", default="")
    self_cycle_parser.add_argument("--min-followup-priority", type=float, default=55)

    self_loop_parser = subparsers.add_parser("self-loop", help="Run self-cycle repeatedly with sleep and max-iteration guardrails.")
    self_loop_parser.add_argument("--iterations", type=int, default=3)
    self_loop_parser.add_argument("--sleep-seconds", type=float, default=30)
    self_loop_parser.add_argument("--no-stop-on-idle", action="store_true")
    self_loop_parser.add_argument("--source", choices=sorted(SELF_CYCLE_SOURCES), default="auto")
    self_loop_parser.add_argument("--model", default=DEFAULT_PRIORITY_MODEL)
    self_loop_parser.add_argument("--max-tasks", type=int, default=20)
    self_loop_parser.add_argument("--candidate-limit", type=int, default=25)
    self_loop_parser.add_argument("--model-limit", type=int, default=10)
    self_loop_parser.add_argument("--task-kind", choices=["network", "personal", "all"], default="network")
    self_loop_parser.add_argument("--include-fixtures", action="store_true")
    self_loop_parser.add_argument("--heuristic-only", action="store_true", help="Skip OpenRouter and use deterministic local scoring.")
    self_loop_parser.add_argument("--execute", action="store_true", help="Persist/submit selected bounded work units.")
    self_loop_parser.add_argument("--no-close-stale", action="store_true", help="Skip stale follow-up closure candidates.")
    self_loop_parser.add_argument("--no-request-followup", action="store_true", help="Do not request follow-ups after classifying reviews.")
    self_loop_parser.add_argument("--submit-followup", action="store_true", help="Publish follow-up request pointers instead of previewing them.")
    self_loop_parser.add_argument("--followup-extra", default="")
    self_loop_parser.add_argument("--accept-assigned", action="store_true", help="Allow accepting proposed assigned tasks.")
    self_loop_parser.add_argument("--evidence", default="")
    self_loop_parser.add_argument("--evidence-file", default="")
    self_loop_parser.add_argument("--response", default="")
    self_loop_parser.add_argument("--response-file", default="")
    self_loop_parser.add_argument("--notes", default="")
    self_loop_parser.add_argument("--min-followup-priority", type=float, default=55)

    priority_parser = subparsers.add_parser("prioritize-network", help="Rank unhandled Network task work by operational importance.")
    priority_parser.add_argument("--model", default=DEFAULT_PRIORITY_MODEL)
    priority_parser.add_argument(
        "--source",
        choices=["directory-rewarded-tasks", "review-queue", "operator-outstanding"],
        default="review-queue",
        help="review-queue ranks the unified Orc review queue; directory-rewarded-tasks ranks the live Directory API directly; operator-outstanding ranks this Orc's current offers.",
    )
    priority_parser.add_argument("--max-tasks", type=int, default=20, help="Maximum Orc outstanding offers when --source operator-outstanding.")
    priority_parser.add_argument("--candidate-limit", type=int, default=25, help="Maximum shared review-queue rows to inspect.")
    priority_parser.add_argument("--model-limit", type=int, default=10, help="Maximum queue candidates to send to OpenRouter after heuristic pre-ranking.")
    priority_parser.add_argument("--task-kind", choices=["network", "personal", "all"], default="network", help="Task kind for --source directory-rewarded-tasks.")
    priority_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), default="not_reviewed")
    priority_parser.add_argument("--include-fixtures", action="store_true", help="Allow local smoke/QA fixture review rows.")
    priority_parser.add_argument("--heuristic-only", action="store_true", help="Skip OpenRouter and use deterministic local scoring.")
    priority_parser.add_argument("--include-prompt", action="store_true", help="Include the scoring prompt in the JSON output.")

    signal_parser = subparsers.add_parser("signal-user", help="Send direct Orc Hive signal for a reviewed task.")
    signal_parser.add_argument("task_id")
    signal_parser.add_argument("--message", required=True)
    signal_parser.add_argument("--account-id", default="")
    signal_parser.add_argument("--conversation-id", default="")
    signal_parser.add_argument("--reviewer-handle", default="")
    signal_parser.add_argument("--reviewer-wallet", default="")
    signal_parser.add_argument("--reason", default="")
    signal_parser.add_argument("--metadata-json", type=_load_json_object, default={})
    signal_parser.add_argument("--execute", action="store_true")
    signal_parser.add_argument("--tasknode-repo", default="/home/pfrpc/repos/tasknodeofficial")

    agent_parser = subparsers.add_parser("agent", help="Manage Orc agent registry records.")
    agent_sub = agent_parser.add_subparsers(dest="agent_command", required=True)
    onboard_parser = agent_sub.add_parser("onboard", help="Register or update an Orc agent and assign its charter.")
    onboard_parser.add_argument("--handle", required=True, help="Orc handle, for example grashnuk.")
    onboard_parser.add_argument("--wallet-address", required=True, help="Public classic address for wallet-login allowlisting.")
    onboard_parser.add_argument("--account-id", default="", help="Optional Task Node account id once known.")
    onboard_parser.add_argument("--agent-id", default="", help="Optional stable machine agent id; defaults to the handle.")
    onboard_parser.add_argument("--role", default="operator")
    onboard_parser.add_argument("--status", default="active")
    onboard_parser.add_argument("--inactive", action="store_true", help="Register the agent but mark active=false.")
    onboard_parser.add_argument("--runtime-kind", default="codex")
    onboard_parser.add_argument("--tmux-target", default="", help="Optional pane target; defaults to <handle>:0.0.")
    onboard_parser.add_argument("--capacity-limit", type=int, default=1)
    onboard_charter = onboard_parser.add_mutually_exclusive_group(required=True)
    onboard_charter.add_argument("--charter", default="")
    onboard_charter.add_argument("--charter-file", default="")
    onboard_parser.add_argument("--metadata-json", type=_load_json_object, default={})
    onboard_parser.add_argument("--allowlist-env-key", default="TASKNODE_AGENT_WALLET_ALLOWLIST")

    close_parser = subparsers.add_parser("close-followup", help="Close a source review after terminal follow-up proof.")
    close_parser.add_argument("source_task_id")
    close_parser.add_argument("--followup-task-id", default="")
    close_parser.add_argument("--payment-tx", default="")
    close_parser.add_argument("--signal-message-id", default="")
    close_parser.add_argument("--no-code-needed-proof", default="")

    task_parser = subparsers.add_parser("task", help="Operate Orc task lifecycle actions.")
    task_sub = task_parser.add_subparsers(dest="task_command", required=True)
    task_detail_parser = task_sub.add_parser("detail", help="Read task detail through the agent client.")
    task_detail_parser.add_argument("task_id")
    task_verification_parser = task_sub.add_parser(
        "verification-request",
        help="Compare authenticated and public Hive verification follow-up text.",
    )
    task_verification_parser.add_argument("task_id")
    task_accept_parser = task_sub.add_parser("accept", help="Accept a proposed task with submit=true.")
    task_accept_parser.add_argument("task_id")
    task_accept_parser.add_argument("--reason", default="")
    task_submit_parser = task_sub.add_parser("submit", help="Submit initial evidence with submit=true.")
    task_submit_parser.add_argument("task_id")
    task_submit_parser.add_argument("--evidence", default="")
    task_submit_parser.add_argument("--evidence-file", default="")
    task_submit_parser.add_argument("--notes", default="")
    task_respond_parser = task_sub.add_parser("respond", help="Submit verification response with submit=true.")
    task_respond_parser.add_argument("task_id")
    task_respond_parser.add_argument("--response", default="")
    task_respond_parser.add_argument("--response-file", default="")
    task_respond_parser.add_argument("--notes", default="")

    run_parser = subparsers.add_parser("run-personal-task", help="Run accept/submit/respond for a Personal task in one client process.")
    run_parser.add_argument("task_id")
    run_parser.add_argument("--accept-reason", default="")
    run_parser.add_argument("--evidence", default="")
    run_parser.add_argument("--evidence-file", default="")
    run_parser.add_argument("--response", default="")
    run_parser.add_argument("--response-file", default="")
    run_parser.add_argument("--notes", default="")
    return parser


def _client_from_args(args: argparse.Namespace) -> Any:
    return build_client(
        agent=args.agent,
        expected_wallet_address=args.wallet_address,
        base_url=args.base_url,
        session_store_path=args.session_store or None,
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_url = args.database_url or None
    try:
        if args.command == "status":
            payload = operator_status(
                client=_client_from_args(args),
                database_url=database_url,
                close_stale=args.close_stale,
            )
        elif args.command == "review" and args.review_command == "next":
            payload = review_next(
                task_id=args.task_id,
                disposition=args.disposition,
                include_raw=args.raw,
                include_raw_events=args.raw_events,
                include_fixtures=args.include_fixtures,
                text_limit=args.text_limit,
                database_url=database_url,
            )
        elif args.command == "review" and args.review_command == "classify":
            payload = classify_review(
                args.task_id,
                disposition=args.disposition,
                summary=args.summary,
                recommended_action=args.recommended_action,
                categories=args.category,
                integrity_signals=args.integrity_signal,
                action_required=args.action_required,
                action_owner=args.action_owner,
                confidence=args.confidence,
                reviewer_handle=args.reviewer_handle or args.agent,
                reviewer_wallet=args.reviewer_wallet or args.wallet_address,
                source_task_ids=args.source_task_id,
                source_cids=args.source_cid,
                source_tx_hashes=args.source_tx_hash,
                metadata=args.metadata_json,
                database_url=database_url,
            )
        elif args.command == "chat":
            message = " ".join(args.message).strip()
            if not message:
                raise ValueError("chat message is required")
            payload = _client_from_args(args).chat(
                message,
                mode=args.mode,
                conversation_id=args.conversation_id,
                metadata=args.metadata_json,
                agent_handle=args.agent,
                dry_run=args.dry_run,
            )
        elif args.command == "hive-chat":
            message = " ".join(args.message).strip()
            if not message:
                raise ValueError("hive chat message is required")
            payload = _client_from_args(args).hive_chat(
                message,
                conversation_id=args.conversation_id,
                conversation_title=args.conversation_title,
                metadata=args.metadata_json,
                agent_handle=args.agent,
            )
        elif args.command == "request-followup":
            payload = request_followup_task(
                args.task_id,
                submit=args.submit,
                extra=args.extra,
                client=_client_from_args(args),
                database_url=database_url,
            )
        elif args.command == "self-cycle":
            payload = self_cycle(
                client=_client_from_args(args),
                agent=args.agent,
                reviewer_wallet=args.wallet_address,
                database_url=database_url,
                source=args.source,
                model=args.model,
                use_openrouter=not args.heuristic_only,
                max_tasks=args.max_tasks,
                candidate_limit=args.candidate_limit,
                model_limit=args.model_limit,
                task_kind=args.task_kind,
                include_fixtures=args.include_fixtures,
                execute=args.execute,
                close_stale=not args.no_close_stale,
                request_followup=not args.no_request_followup,
                submit_followup=args.submit_followup,
                followup_extra=args.followup_extra,
                accept_assigned=args.accept_assigned,
                evidence_text=_read_text_arg(text=args.evidence, path=args.evidence_file),
                response_text=_read_text_arg(text=args.response, path=args.response_file),
                notes=args.notes,
                journal_path=args.journal_path,
                min_followup_priority=args.min_followup_priority,
            )
        elif args.command == "self-loop":
            payload = self_loop(
                iterations=args.iterations,
                sleep_seconds=args.sleep_seconds,
                stop_on_idle=not args.no_stop_on_idle,
                client=_client_from_args(args),
                agent=args.agent,
                reviewer_wallet=args.wallet_address,
                database_url=database_url,
                source=args.source,
                model=args.model,
                use_openrouter=not args.heuristic_only,
                max_tasks=args.max_tasks,
                candidate_limit=args.candidate_limit,
                model_limit=args.model_limit,
                task_kind=args.task_kind,
                include_fixtures=args.include_fixtures,
                execute=args.execute,
                close_stale=not args.no_close_stale,
                request_followup=not args.no_request_followup,
                submit_followup=args.submit_followup,
                followup_extra=args.followup_extra,
                accept_assigned=args.accept_assigned,
                evidence_text=_read_text_arg(text=args.evidence, path=args.evidence_file),
                response_text=_read_text_arg(text=args.response, path=args.response_file),
                notes=args.notes,
                journal_path=args.journal_path,
                min_followup_priority=args.min_followup_priority,
            )
        elif args.command == "prioritize-network":
            payload = triage_network_work(
                source=args.source,
                client=_client_from_args(args),
                model=args.model,
                max_tasks=args.max_tasks,
                candidate_limit=args.candidate_limit,
                model_limit=args.model_limit,
                disposition=args.disposition,
                task_kind=args.task_kind,
                use_openrouter=not args.heuristic_only,
                include_prompt=args.include_prompt,
                include_fixtures=args.include_fixtures,
                database_url=database_url,
            )
        elif args.command == "signal-user":
            payload = signal_user(
                task_id=args.task_id,
                message=args.message,
                execute=args.execute,
                tasknode_repo=args.tasknode_repo,
                account_id=args.account_id,
                conversation_id=args.conversation_id,
                reviewer_handle=args.reviewer_handle or args.agent,
                reviewer_wallet=args.reviewer_wallet or args.wallet_address,
                reason=args.reason,
                metadata=args.metadata_json,
                database_url=database_url,
            )
        elif args.command == "agent" and args.agent_command == "onboard":
            payload = onboard_orc_agent(
                handle=args.handle,
                wallet_address=args.wallet_address,
                account_id=args.account_id,
                agent_id=args.agent_id,
                charter=_read_required_text_arg(text=args.charter, path=args.charter_file, label="charter"),
                role=args.role,
                status=args.status,
                active=not args.inactive,
                runtime_kind=args.runtime_kind,
                tmux_target=args.tmux_target,
                capacity_limit=args.capacity_limit,
                metadata=args.metadata_json,
                allowlist_env_key=args.allowlist_env_key,
                database_url=database_url,
            )
        elif args.command == "close-followup":
            payload = close_followup(
                args.source_task_id,
                followup_task_id=args.followup_task_id,
                payment_tx=args.payment_tx,
                signal_message_id=args.signal_message_id,
                no_code_needed_proof=args.no_code_needed_proof,
                client=_client_from_args(args),
                database_url=database_url,
            )
        elif args.command == "task" and args.task_command == "detail":
            payload = task_observe(args.task_id, client=_client_from_args(args))
        elif args.command == "task" and args.task_command == "verification-request":
            payload = inspect_verification_request(args.task_id, client=_client_from_args(args))
        elif args.command == "task" and args.task_command == "accept":
            payload = task_accept(
                args.task_id,
                reason=args.reason,
                client=_client_from_args(args),
                journal_path=args.journal_path,
                database_url=database_url,
            )
        elif args.command == "task" and args.task_command == "submit":
            payload = task_submit(
                args.task_id,
                evidence_text=_read_text_arg(text=args.evidence, path=args.evidence_file),
                notes=args.notes,
                client=_client_from_args(args),
                journal_path=args.journal_path,
                database_url=database_url,
            )
        elif args.command == "task" and args.task_command == "respond":
            payload = task_respond(
                args.task_id,
                response_text=_read_text_arg(text=args.response, path=args.response_file),
                notes=args.notes,
                client=_client_from_args(args),
                journal_path=args.journal_path,
                database_url=database_url,
            )
        elif args.command == "run-personal-task":
            payload = run_personal_task(
                args.task_id,
                accept_reason=args.accept_reason,
                evidence_text=_read_text_arg(text=args.evidence, path=args.evidence_file),
                response_text=_read_text_arg(text=args.response, path=args.response_file),
                notes=args.notes,
                client=_client_from_args(args),
                journal_path=args.journal_path,
                database_url=database_url,
            )
        else:  # pragma: no cover - argparse prevents this
            raise RuntimeError(f"Unhandled command: {args.command}")
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": str(exc),
                    "secretPrinted": False,
                },
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
