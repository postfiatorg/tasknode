from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import sys
from typing import Any
from uuid import uuid4

from .client import DEFAULT_EXPECTED_WALLET_ADDRESS, DEFAULT_ORC_AGENT, DEFAULT_TASKNODE_BASE_URL, build_client, request_personal_task
from .hive_signal import run_hive_signal
from .payload import redact_secrets
from .payload import task_payload
from .priority import DEFAULT_PRIORITY_MODEL, next_network_triage_item, triage_network_work
from .review import build_rewarded_network_task_review_packet
from .review_integrity_policy import apply_reward_clawback_integrity_policy
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


def task_accept(
    task_id: str,
    *,
    reason: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
    run_id: str = "",
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


def run_personal_task(
    task_id: str,
    *,
    evidence_text: str = "",
    response_text: str = "",
    accept_reason: str = "",
    notes: str = "",
    client: Any | None = None,
    journal_path: str = DEFAULT_RUN_JOURNAL_PATH,
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

    request_parser = subparsers.add_parser("request-followup", help="Request a Personal follow-up task for this Orc.")
    request_parser.add_argument("task_id")
    request_parser.add_argument("--extra", default="")
    request_parser.add_argument("--submit", action="store_true")

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
        elif args.command == "request-followup":
            payload = request_followup_task(
                args.task_id,
                submit=args.submit,
                extra=args.extra,
                client=_client_from_args(args),
                database_url=database_url,
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
            payload = run_hive_signal(
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
        elif args.command == "task" and args.task_command == "accept":
            payload = task_accept(args.task_id, reason=args.reason, client=_client_from_args(args), journal_path=args.journal_path)
        elif args.command == "task" and args.task_command == "submit":
            payload = task_submit(
                args.task_id,
                evidence_text=_read_text_arg(text=args.evidence, path=args.evidence_file),
                notes=args.notes,
                client=_client_from_args(args),
                journal_path=args.journal_path,
            )
        elif args.command == "task" and args.task_command == "respond":
            payload = task_respond(
                args.task_id,
                response_text=_read_text_arg(text=args.response, path=args.response_file),
                notes=args.notes,
                client=_client_from_args(args),
                journal_path=args.journal_path,
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
