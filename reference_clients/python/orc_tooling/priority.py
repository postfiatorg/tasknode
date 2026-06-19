from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
import re
from typing import Any

import requests

from tasknode_pftl.config import PftlConfig

from .client import build_client
from .payload import extract_task_payload, redact_secrets
from .review import build_rewarded_network_task_review_packet
from .review_state import REVIEW_DISPOSITIONS, review_queue


DEFAULT_PRIORITY_MODEL = "z-ai/glm-5.2"
PRIORITY_PROMPT_VERSION = "orc_network_task_priority_v1"
NETWORK_TRIAGE_CAPABILITY_VERSION = "orc_network_task_triage_v1"

PRIORITY_SYSTEM_PROMPT = """You are a Task Node Orc Network Task prioritization scorer.

You receive one Task Node Network Task packet at a time. It may be an outstanding Network task offered to an assigned Orc, or another contributor's rewarded Network task submission that has not been reviewed by Orcs yet.

Decide how important it is for the assigned Orc to work this item before other pending Orc work. For outstanding offers, "work" means accept and execute the task. For review-queue items, "work" means inspect the rewarded submission, classify it, and request executable follow-up only if the submission exposes actionable product/protocol/integrity work.

Judge importance by operational value, not by reward alone. Prefer work that protects the network, unblocks operators, prevents reward leakage, improves routing/review throughput, or closes a live integrity gap. Give extra credit when the work is concrete, source-grounded, and executable by a Codex Orc with Task Node tooling.

Scoring rubric:
- urgency_score: 0-10. Deadline, proposed/accepted state pressure, current capacity pressure, and whether delay creates loss.
- strategic_value_score: 0-10. Core protocol, reward integrity, task engine, Board/Hive routing, operator tooling, user trust, or security/integrity impact.
- reward_signal_score: 0-10. Use reward as a signal of expected effort/value, but never as the sole reason.
- orc_fit_score: 0-10. Match to Codex Orc strengths: task lifecycle analysis, protocol/API behavior analysis, reward/accounting checks, workflow/tooling repair, and concise evidence. Penalize tasks that require unavailable private context or broad product taste with no concrete evidence path.
- risk_of_delay_score: 0-10. Harm if this waits: duplicate payouts, bad routing, sybil leakage, blocked tasks, confusing operator state, or production-visible breakage.
- unblocking_score: 0-10. Whether completing it enables other work or removes a bottleneck.

Return exactly one JSON object. Do not include markdown, prose, or hidden reasoning.

Required JSON shape:
{
  "taskId": "task_...",
  "priorityScore": 0,
  "rankBucket": "do_first|do_next|defer|refuse_or_escalate",
  "urgencyScore": 0,
  "strategicValueScore": 0,
  "rewardSignalScore": 0,
  "orcFitScore": 0,
  "riskOfDelayScore": 0,
  "unblockingScore": 0,
  "effortEstimateHours": 0,
  "expectedValuePerHour": 0,
  "confidence": "low|medium|high",
  "reasons": ["one concrete reason", "another concrete reason"],
  "redFlags": [],
  "firstWorkSlice": "The first concrete step the assigned Orc should take.",
  "acceptanceRationale": "Why the assigned Orc should accept now, defer, or escalate."
}

Rules:
- Base every claim on the packet. If data is missing, say so in redFlags.
- If the task asks for passive documentation but the packet implies a real bug/data issue, mark the real action pressure.
- If the task appears impossible, too broad, duplicate, or unsafe, use rankBucket "refuse_or_escalate" and explain the missing prerequisite.
- If the packet is a rewarded contributor submission, prioritize it by likely review value: unresolved integrity signal, reward leakage, protocol breakage, duplicated/superseded work, or high-value feedback that should become a concrete Orc follow-up task.
- priorityScore is 0-100. Compute it from the rubric; do not return all tasks as urgent.
"""

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
    return str(value or "").replace("\n", " ").strip()[:limit]


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _number(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: Any, lower: float, upper: float, default: float = 0.0) -> float:
    number = _number(value, default)
    if math.isnan(number) or math.isinf(number):
        return default
    return min(upper, max(lower, number))


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def priority_prompt() -> str:
    return PRIORITY_SYSTEM_PROMPT


def _parse_deadline(value: Any) -> datetime | None:
    text = _safe_text(value, 120)
    if not text or text.lower() in {"none", "no deadline"}:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _deadline_hours(deadline: Any) -> float | None:
    parsed = _parse_deadline(deadline)
    if not parsed:
        return None
    return (parsed - datetime.now(timezone.utc)).total_seconds() / 3600


def _keyword_hits(text: str, keywords: set[str]) -> int:
    lowered = text.lower()
    return sum(1 for keyword in keywords if keyword in lowered)


def _packet_text(packet: dict[str, Any]) -> str:
    return json.dumps(packet, sort_keys=True).lower()


def build_task_reward_packet(payload: dict[str, Any]) -> dict[str, Any]:
    task = _safe_dict(payload.get("task"))
    execution = _safe_dict(payload.get("executionBrief"))
    generated = _safe_dict(payload.get("generatedTaskPayload"))
    network = _safe_dict(payload.get("networkTaskPayload"))
    context = _safe_dict(payload.get("networkContext"))
    requirement = _safe_dict(execution.get("submissionRequirement"))
    verification = _safe_dict(execution.get("verificationPolicy"))
    reward_offer = _safe_dict(generated.get("reward_offer"))
    deadline = execution.get("deadline") or _safe_dict(generated.get("deadline"))
    return redact_secrets({
        "schema": "pf.orc.network_task_priority_packet.v1",
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "sourceMode": "operator_outstanding",
        "generatedAt": _utcnow(),
        "currentDateUtc": datetime.now(timezone.utc).date().isoformat(),
        "taskId": task.get("taskId") or execution.get("taskId"),
        "title": execution.get("title") or task.get("title"),
        "kind": execution.get("kind") or task.get("kind"),
        "status": execution.get("status") or task.get("status"),
        "rewardPft": execution.get("rewardPft") or task.get("rewardPft") or task.get("pft"),
        "rewardOffer": reward_offer,
        "deadline": deadline,
        "objective": _safe_text(execution.get("objective"), 5000),
        "steps": [_safe_text(step, 1200) for step in _safe_list(execution.get("steps"))[:12]],
        "submissionRequirement": {
            "type": _safe_text(requirement.get("type"), 120),
            "criteria": _safe_text(requirement.get("criteria") or requirement, 3000),
        },
        "verificationPolicy": verification,
        "networkContext": {
            "projectId": context.get("projectId") or network.get("project_id"),
            "projectTitle": context.get("projectTitle") or network.get("project_title"),
            "projectType": context.get("projectType") or network.get("project_type"),
            "allocationId": context.get("allocationId") or network.get("allocation_id"),
            "routingReason": _safe_text(context.get("routingReason") or network.get("routing_reason"), 1600),
            "projectNeedSummary": _safe_text(context.get("projectNeedSummary") or network.get("project_need_summary"), 1600),
            "rewardBandPft": context.get("rewardBandPft") or network.get("reward_band_pft"),
            "sourcePayloadDigest": context.get("sourcePayloadDigest") or network.get("source_payload_digest"),
        },
        "actions": _safe_dict(payload.get("actions")),
        "sourcePointers": _safe_dict(payload.get("sourcePointers")),
        "currentVerificationRequest": payload.get("currentVerificationRequest"),
        "rewardOutcome": payload.get("rewardOutcome"),
        "secretPrinted": False,
    })


def _first_artifact_text(items: list[dict[str, Any]], limit: int = 1600) -> str:
    for item in items:
        for artifact in _safe_list(_safe_dict(item).get("artifacts")):
            artifact = _safe_dict(artifact)
            text = _safe_text(artifact.get("value") or artifact.get("notes"), limit)
            if text:
                return text
    return ""


def _review_task_reward_score(task: dict[str, Any]) -> dict[str, Any]:
    reward_events = _safe_list(task.get("rewardEvents"))
    if not reward_events:
        return {}
    return _safe_dict(_safe_dict(reward_events[-1]).get("score"))


def is_probable_fixture_priority_row(row: dict[str, Any]) -> bool:
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


def build_review_queue_reward_packet(
    review_task: dict[str, Any],
    *,
    review_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    execution = _safe_dict(review_task.get("executionPayload"))
    network_allocation = _safe_dict(review_task.get("networkAllocation"))
    source_pointers = _safe_dict(review_task.get("sourcePointers"))
    source_payload = _safe_dict(review_task.get("sourcePayload"))
    network_task = _safe_dict(execution.get("networkTask"))
    generation_job = _safe_dict(review_task.get("generationJob"))
    reward = _review_task_reward_score(review_task)
    review = _safe_dict(review_state)
    verification_requests = _safe_list(review_task.get("verificationRequests"))
    return redact_secrets({
        "schema": "pf.orc.network_task_priority_packet.v1",
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "sourceMode": "review_queue",
        "generatedAt": _utcnow(),
        "currentDateUtc": datetime.now(timezone.utc).date().isoformat(),
        "taskId": review_task.get("taskId"),
        "title": review_task.get("title") or execution.get("title"),
        "kind": "Network",
        "status": review_task.get("status") or "rewarded",
        "rewardPft": review_task.get("rewardActualPft") or reward.get("rewardPft") or review_task.get("rewardOfferPft"),
        "rewardOffer": {
            "offerPft": review_task.get("rewardOfferPft"),
            "actualPft": review_task.get("rewardActualPft"),
        },
        "objective": _safe_text(execution.get("description"), 5000),
        "steps": [_safe_text(step, 1200) for step in _safe_list(execution.get("steps"))[:12]],
        "submissionRequirement": _safe_dict(execution.get("submissionRequirement")),
        "verificationPolicy": _safe_dict(execution.get("verificationPolicy")),
        "networkContext": {
            "projectId": network_allocation.get("projectId") or network_task.get("project_id"),
            "projectTitle": network_task.get("project_title") or source_payload.get("project_title"),
            "projectType": network_task.get("project_type") or source_payload.get("project_type"),
            "allocationId": network_allocation.get("allocationId"),
            "routingReason": _safe_text(network_task.get("routing_reason") or source_payload.get("routing_reason"), 1600),
            "projectNeedSummary": _safe_text(network_allocation.get("projectNeedSummary") or network_task.get("project_need_summary"), 1600),
            "sourcePayloadDigest": generation_job.get("sourcePayloadDigest"),
        },
        "reviewQueue": {
            "disposition": review.get("review_disposition") or review.get("disposition") or "not_reviewed",
            "actionRequired": bool(review.get("action_required") or review.get("actionRequired") or False),
            "summary": _safe_text(review.get("review_summary") or review.get("summary"), 1200),
            "recommendedAction": _safe_text(review.get("recommended_action") or review.get("recommendedAction"), 1200),
            "taskUpdatedAt": review.get("task_updated_at") or review_task.get("updatedAt"),
        },
        "sourceContributor": {
            "accountId": review_task.get("accountId"),
            "walletAddress": review_task.get("walletAddress"),
        },
        "sourceEvidence": {
            "submissionSummary": _first_artifact_text(_safe_list(review_task.get("submissions"))),
            "verificationResponseSummary": _first_artifact_text(_safe_list(review_task.get("verificationResponses"))),
            "verificationAsk": _safe_text(_safe_dict(verification_requests[-1]).get("ask") if verification_requests else "", 1200),
            "rewardDecision": reward.get("decision"),
            "rewardReason": _safe_text(reward.get("reason"), 1600),
            "rewardUserFeedback": _safe_text(reward.get("userFeedback"), 1200),
        },
        "sourcePointers": {
            "requestBundleCid": source_pointers.get("requestBundleCid"),
            "contextCid": source_pointers.get("contextCid"),
            "lastEventCid": source_pointers.get("lastEventCid"),
            "lastEventTxHash": source_pointers.get("lastEventTxHash"),
        },
        "secretPrinted": False,
    })


def build_directory_rewarded_task_packet(row: dict[str, Any]) -> dict[str, Any]:
    return redact_secrets({
        "schema": "pf.orc.network_task_priority_packet.v1",
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "sourceMode": "directory_rewarded_tasks",
        "generatedAt": _utcnow(),
        "currentDateUtc": datetime.now(timezone.utc).date().isoformat(),
        "taskId": row.get("taskId") or row.get("task_id"),
        "title": row.get("title"),
        "kind": row.get("taskKind") or row.get("task_kind") or "Network",
        "status": "rewarded",
        "rewardPft": row.get("rewardPft") or row.get("reward_pft"),
        "rewardOffer": {
            "offerPft": row.get("rewardOfferPft") or row.get("reward_offer_pft"),
            "actualPft": row.get("rewardPft") or row.get("reward_pft"),
        },
        "objective": _safe_text(row.get("description"), 5000),
        "steps": [],
        "submissionRequirement": {
            "type": "",
            "criteria": _safe_text(row.get("submissionRequirement") or row.get("submission_requirement"), 3000),
        },
        "reviewQueue": {
            "disposition": row.get("reviewDisposition") or "not_reviewed",
            "taskUpdatedAt": row.get("updatedAt") or row.get("updated_at"),
        },
        "sourceContributor": {
            "accountId": row.get("accountId") or row.get("account_id"),
            "walletAddress": row.get("wallet") or row.get("walletAddress") or row.get("wallet_address"),
            "handle": row.get("handle"),
            "displayName": row.get("displayName"),
        },
        "sourceEvidence": {
            "submissionSummary": "",
            "verificationResponseSummary": "",
            "rewardDecision": "rewarded",
            "rewardReason": "",
            "rewardUserFeedback": "",
        },
        "sourcePointers": {
            "requestBundleCid": row.get("requestBundleCid") or row.get("request_bundle_cid"),
            "contextCid": row.get("contextCid") or row.get("context_cid"),
            "lastEventCid": row.get("lastEventCid") or row.get("last_event_cid"),
            "lastEventTxHash": row.get("lastEventTxHash") or row.get("last_event_tx_hash"),
        },
        "secretPrinted": False,
    })


def heuristic_priority_score(packet: dict[str, Any]) -> dict[str, Any]:
    text = _packet_text(packet)
    reward = _number(packet.get("rewardPft"), 0)
    status = _safe_text(packet.get("status"), 120).lower()
    source_mode = _safe_text(packet.get("sourceMode"), 80)
    review_queue_state = _safe_dict(packet.get("reviewQueue"))
    deadline_hours = _deadline_hours(packet.get("deadline"))

    integrity_hits = _keyword_hits(text, {
        "sybil",
        "blocklist",
        "abuse",
        "integrity",
        "leakage",
        "duplicate",
        "reward leakage",
        "nonresponsive",
        "generic",
        "fabricated",
    })
    protocol_hits = _keyword_hits(text, {
        "reward",
        "routing",
        "task engine",
        "pftl",
        "board manager",
        "hive",
        "projection",
        "idempotency",
        "regression",
    })
    tooling_hits = _keyword_hits(text, {
        "script",
        "test",
        "suite",
        "query",
        "operator",
        "workflow",
        "verification",
        "evidence",
    })
    broad_hits = _keyword_hits(text, {
        "strategy",
        "brainstorm",
        "marketing",
        "memo",
        "plan only",
    })

    urgency = 4.0
    if status == "proposed":
        urgency += 2.0
    if status == "accepted":
        urgency += 3.0
    if source_mode == "review_queue" and _safe_text(review_queue_state.get("disposition"), 80) == "not_reviewed":
        urgency += 1.0
    if deadline_hours is not None:
        if deadline_hours <= 0:
            urgency = 10.0
        elif deadline_hours <= 6:
            urgency += 4.0
        elif deadline_hours <= 24:
            urgency += 3.0
        elif deadline_hours <= 72:
            urgency += 1.5

    reward_signal = min(10.0, max(1.0, reward / 3000.0 if reward else 2.0))
    strategic = min(10.0, 4.0 + integrity_hits * 2.5 + protocol_hits * 1.2 + tooling_hits * 0.4)
    fit = min(10.0, 5.0 + tooling_hits * 0.9 + protocol_hits * 0.7 + integrity_hits * 0.5 - broad_hits * 0.8)
    risk = min(10.0, 3.0 + integrity_hits * 2.5 + protocol_hits * 0.8)
    unblocking = min(10.0, 3.0 + tooling_hits * 1.0 + protocol_hits * 0.6 + integrity_hits * 0.8)

    effort = 3.0
    if "suite" in text or "audit" in text:
        effort += 2.0
    if "historical" in text or "reconcile" in text:
        effort += 2.0
    if "memo" in text or "report" in text:
        effort -= 0.8
    effort = _clamp(effort, 0.5, 12.0, 3.0)

    score = (
        urgency * 1.8
        + strategic * 2.4
        + reward_signal * 0.9
        + fit * 1.5
        + risk * 1.8
        + unblocking * 1.6
    )
    score = _clamp(score, 0, 100, 0)
    if score >= 78:
        bucket = "do_first"
    elif score >= 58:
        bucket = "do_next"
    elif score >= 35:
        bucket = "defer"
    else:
        bucket = "refuse_or_escalate"

    red_flags = []
    if not _safe_text(packet.get("objective"), 80):
        red_flags.append("objective_missing_or_empty")
    if not _safe_list(packet.get("steps")):
        red_flags.append("steps_missing_or_empty")
    if broad_hits and not (integrity_hits or protocol_hits or tooling_hits):
        red_flags.append("broad_or_passive_scope")
    if source_mode == "review_queue" and not _safe_text(_safe_dict(packet.get("sourceEvidence")).get("submissionSummary"), 80):
        red_flags.append("source_submission_summary_missing")

    reasons = []
    if source_mode == "review_queue":
        reasons.append("Item is an unreviewed rewarded Network submission in the shared Orc review queue.")
    if integrity_hits:
        reasons.append("Integrity/reward-abuse language makes delay risk higher.")
    if protocol_hits:
        reasons.append("Packet touches core task, reward, routing, Hive, or protocol behavior.")
    if tooling_hits:
        reasons.append("Work shape matches Codex Orc tooling, verification, and evidence strengths.")
    if reward:
        reasons.append(f"Reward signal is {reward:g} PFT.")
    if not reasons:
        reasons.append("Heuristic found limited core network pressure in the packet.")

    return {
        "taskId": packet.get("taskId"),
        "priorityScore": round(score, 1),
        "rankBucket": bucket,
        "urgencyScore": round(_clamp(urgency, 0, 10, 0), 1),
        "strategicValueScore": round(_clamp(strategic, 0, 10, 0), 1),
        "rewardSignalScore": round(_clamp(reward_signal, 0, 10, 0), 1),
        "orcFitScore": round(_clamp(fit, 0, 10, 0), 1),
        "riskOfDelayScore": round(_clamp(risk, 0, 10, 0), 1),
        "unblockingScore": round(_clamp(unblocking, 0, 10, 0), 1),
        "effortEstimateHours": round(effort, 1),
        "expectedValuePerHour": round(score / max(0.5, effort), 1),
        "confidence": "medium",
        "reasons": reasons[:4],
        "redFlags": red_flags,
        "firstWorkSlice": "Open the task detail, inspect the generated packet, and identify the smallest proof-producing command or source change.",
        "acceptanceRationale": "Heuristic ranking based on reward, urgency, network integrity, operator fit, and unblocking value.",
        "scoredBy": "heuristic",
        "secretPrinted": False,
    }


def _parse_json_text(text: str) -> dict[str, Any]:
    clean = _safe_text(text, 200000)
    if not clean:
        raise ValueError("priority_model_empty_response")
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError:
        fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", clean, re.IGNORECASE)
        if fenced:
            parsed = json.loads(fenced.group(1))
        else:
            start = clean.find("{")
            end = clean.rfind("}")
            if start < 0 or end <= start:
                raise
            parsed = json.loads(clean[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("priority_model_json_must_be_object")
    return parsed


def normalize_priority_result(raw: dict[str, Any], packet: dict[str, Any], *, scored_by: str) -> dict[str, Any]:
    task_id = _safe_text(packet.get("taskId"), 180)
    result_task_id = _safe_text(raw.get("taskId"), 180) or task_id
    source_contributor = _safe_dict(packet.get("sourceContributor"))
    review_queue = _safe_dict(packet.get("reviewQueue"))
    proposal = _safe_text(
        raw.get("taskProposalDescription")
        or packet.get("taskProposalDescription")
        or packet.get("objective")
        or packet.get("title"),
        1200,
    )
    priority_score = round(_clamp(raw.get("priorityScore"), 0, 100, 0), 1)
    effort_hours = round(_clamp(raw.get("effortEstimateHours"), 0.1, 80, 3), 1)
    expected_value_per_hour = round(priority_score / max(0.5, effort_hours), 1)
    bucket = _safe_text(raw.get("rankBucket"), 80)
    if bucket not in {"do_first", "do_next", "defer", "refuse_or_escalate"}:
        if priority_score >= 78:
            bucket = "do_first"
        elif priority_score >= 58:
            bucket = "do_next"
        elif priority_score >= 35:
            bucket = "defer"
        else:
            bucket = "refuse_or_escalate"
    confidence = _safe_text(raw.get("confidence"), 40).lower()
    if confidence not in {"low", "medium", "high"}:
        confidence = "medium"
    return redact_secrets({
        "taskId": result_task_id,
        "title": packet.get("title"),
        "walletAddress": source_contributor.get("walletAddress") or packet.get("walletAddress"),
        "accountId": source_contributor.get("accountId") or packet.get("accountId"),
        "taskProposalDescription": proposal,
        "rewardPft": packet.get("rewardPft"),
        "reviewDisposition": review_queue.get("disposition"),
        "priorityScore": priority_score,
        "rankBucket": bucket,
        "urgencyScore": round(_clamp(raw.get("urgencyScore"), 0, 10, 0), 1),
        "strategicValueScore": round(_clamp(raw.get("strategicValueScore"), 0, 10, 0), 1),
        "rewardSignalScore": round(_clamp(raw.get("rewardSignalScore"), 0, 10, 0), 1),
        "orcFitScore": round(_clamp(raw.get("orcFitScore"), 0, 10, 0), 1),
        "riskOfDelayScore": round(_clamp(raw.get("riskOfDelayScore"), 0, 10, 0), 1),
        "unblockingScore": round(_clamp(raw.get("unblockingScore"), 0, 10, 0), 1),
        "effortEstimateHours": effort_hours,
        "expectedValuePerHour": expected_value_per_hour,
        "confidence": confidence,
        "reasons": [_safe_text(item, 500) for item in _safe_list(raw.get("reasons"))[:5] if _safe_text(item, 500)],
        "redFlags": [_safe_text(item, 400) for item in _safe_list(raw.get("redFlags"))[:8] if _safe_text(item, 400)],
        "firstWorkSlice": _safe_text(raw.get("firstWorkSlice"), 1000),
        "acceptanceRationale": _safe_text(raw.get("acceptanceRationale"), 1200),
        "scoredBy": scored_by,
        "secretPrinted": False,
    })


def sanity_check_priority(model_score: dict[str, Any], heuristic_score: dict[str, Any], packet: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if _safe_text(model_score.get("taskId"), 180) != _safe_text(packet.get("taskId"), 180):
        warnings.append("model_returned_different_task_id")
    delta = abs(_number(model_score.get("priorityScore")) - _number(heuristic_score.get("priorityScore")))
    if delta >= 30:
        warnings.append(f"model_heuristic_priority_delta_{round(delta, 1)}")
    if model_score.get("rankBucket") == "do_first" and _number(model_score.get("effortEstimateHours")) > 20:
        warnings.append("do_first_with_large_effort_estimate")
    if model_score.get("rankBucket") == "refuse_or_escalate" and _number(model_score.get("priorityScore")) >= 60:
        warnings.append("high_score_with_refuse_bucket")
    if not _safe_list(model_score.get("reasons")):
        warnings.append("model_returned_no_reasons")
    if not _safe_text(model_score.get("firstWorkSlice"), 80):
        warnings.append("model_returned_no_first_work_slice")
    return warnings


def openrouter_priority_score(
    packet: dict[str, Any],
    *,
    model: str = DEFAULT_PRIORITY_MODEL,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: float = 90,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    config = PftlConfig.from_env()
    key = api_key or config.openrouter_api_key
    if not key:
        raise RuntimeError("openrouter_api_key_missing")
    endpoint = (base_url or config.openrouter_base_url or "https://openrouter.ai/api/v1").rstrip("/") + "/chat/completions"
    http = session or requests.Session()
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": PRIORITY_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "TASK REWARD PACKET",
                    "```json",
                    json.dumps(packet, indent=2, sort_keys=True),
                    "```",
                ]),
            },
        ],
        "response_format": {"type": "json_object"},
        "provider": {
            "data_collection": "deny",
            "require_parameters": True,
        },
        "temperature": 0,
        "max_tokens": 1400,
        "usage": {"include": True},
        "metadata": {
            "app": "tasknode-orc-tooling",
            "worker": "orc_priority",
            "prompt_version": PRIORITY_PROMPT_VERSION,
            "task_id": _safe_text(packet.get("taskId"), 180),
        },
    }
    headers = {
        "authorization": f"Bearer {key}",
        "content-type": "application/json",
        "http-referer": os.environ.get("OPENROUTER_REFERER") or os.environ.get("TASKNODE_PUBLIC_URL") or "https://tasknode.postfiat.org",
        "x-title": os.environ.get("OPENROUTER_TITLE") or "Task Node Orc Priority",
        "x-openrouter-title": os.environ.get("OPENROUTER_TITLE") or "Task Node Orc Priority",
    }
    response = http.post(endpoint, headers=headers, json=body, timeout=timeout)
    response_text = response.text
    try:
        response_body = response.json() if response_text else {}
    except ValueError:
        response_body = {}
    if response.status_code >= 400:
        message = _safe_text(_safe_dict(response_body.get("error")).get("message") or response_text, 1000)
        raise RuntimeError(f"openrouter_priority_http_{response.status_code}: {message}")
    choices = _safe_list(response_body.get("choices"))
    content = ""
    if choices:
        content = _safe_text(_safe_dict(_safe_dict(choices[0]).get("message")).get("content"), 200000)
    parsed = _parse_json_text(content)
    normalized = normalize_priority_result(parsed, packet, scored_by="openrouter")
    usage = _safe_dict(response_body.get("usage"))
    normalized.update({
        "model": _safe_text(response_body.get("model") or model, 160),
        "provider": "openrouter",
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "responseId": _safe_text(response_body.get("id"), 220),
        "usage": {
            "inputTokens": int(_number(usage.get("prompt_tokens") or usage.get("input_tokens"), 0)),
            "outputTokens": int(_number(usage.get("completion_tokens") or usage.get("output_tokens"), 0)),
            "totalTokens": int(_number(usage.get("total_tokens"), 0)),
            "costUsd": _number(usage.get("cost"), 0),
        },
    })
    return redact_secrets(normalized)


def prioritize_network_tasks(
    *,
    client: Any | None = None,
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = True,
    max_tasks: int = 20,
    include_prompt: bool = False,
) -> dict[str, Any]:
    active_client = client or build_client()
    login = active_client.login()
    tasks = active_client.tasks()
    outstanding = [
        task for task in _safe_list(tasks.get("outstanding"))
        if isinstance(task, dict)
        and (_safe_text(task.get("kind"), 80).lower() == "network" or bool(task.get("isNetworkTask")))
    ][:max(1, max_tasks)]
    task_ids = [
        _safe_text(task.get("taskId") or task.get("task_id") or task.get("id"), 180)
        for task in outstanding
        if _safe_text(task.get("taskId") or task.get("task_id") or task.get("id"), 180)
    ]
    network = _safe_dict(tasks.get("networkTasks") or tasks.get("networkTaskEligibility"))
    results: list[dict[str, Any]] = []
    for task_id in task_ids:
        detail = active_client.task_detail(task_id)
        payload = extract_task_payload(detail)
        packet = build_task_reward_packet(payload)
        heuristic_raw = heuristic_priority_score(packet)
        heuristic = normalize_priority_result(heuristic_raw, packet, scored_by="heuristic")
        provider_error = ""
        if use_openrouter:
            try:
                model_score = openrouter_priority_score(packet, model=model)
            except Exception as exc:  # pragma: no cover - live provider failure path
                provider_error = f"{type(exc).__name__}: {_safe_text(exc, 1000)}"
                model_score = dict(heuristic)
                model_score["scoredBy"] = "heuristic_fallback"
        else:
            model_score = dict(heuristic)
        warnings = sanity_check_priority(model_score, heuristic, packet)
        if provider_error:
            warnings.append("openrouter_provider_error")
        model_score.update({
            "rank": 0,
            "sourceMode": packet.get("sourceMode"),
            "heuristicScore": heuristic,
            "sanityWarnings": warnings,
            "providerError": provider_error,
        })
        results.append(redact_secrets(with_network_triage(model_score)))

    results.sort(key=lambda item: (
        -_number(item.get("priorityScore"), 0),
        -_number(_safe_dict(item.get("heuristicScore")).get("priorityScore"), 0),
        _safe_text(item.get("taskId"), 180),
    ))
    for index, item in enumerate(results, start=1):
        item["rank"] = index
        if isinstance(item.get("triage"), dict):
            item["triage"]["rank"] = index

    payload = {
        "ok": True,
        "generatedAt": _utcnow(),
        "address": getattr(active_client, "address", ""),
        "loginCached": bool(_safe_dict(login).get("cached")),
        "networkStatus": network.get("status") or tasks.get("networkStatus"),
        "model": model,
        "openrouterAttempted": bool(use_openrouter),
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "count": len(results),
        "taskIds": task_ids,
        "priorities": results,
        "secretPrinted": False,
    }
    if include_prompt:
        payload["prompt"] = PRIORITY_SYSTEM_PROMPT
    return redact_secrets(payload)


def _score_priority_packet(
    packet: dict[str, Any],
    *,
    model: str,
    use_openrouter: bool,
    openrouter_allowed: bool = True,
) -> dict[str, Any]:
    heuristic_raw = heuristic_priority_score(packet)
    heuristic = normalize_priority_result(heuristic_raw, packet, scored_by="heuristic")
    provider_error = ""
    openrouter_skipped = False
    if use_openrouter and openrouter_allowed:
        try:
            model_score = openrouter_priority_score(packet, model=model)
        except Exception as exc:  # pragma: no cover - live provider failure path
            provider_error = f"{type(exc).__name__}: {_safe_text(exc, 1000)}"
            model_score = dict(heuristic)
            model_score["scoredBy"] = "heuristic_fallback"
    else:
        openrouter_skipped = bool(use_openrouter and not openrouter_allowed)
        model_score = dict(heuristic)
    warnings = sanity_check_priority(model_score, heuristic, packet)
    if provider_error:
        warnings.append("openrouter_provider_error")
    if openrouter_skipped:
        warnings.append("openrouter_not_called_for_this_rank")
    model_score.update({
        "rank": 0,
        "sourceMode": packet.get("sourceMode"),
        "heuristicScore": heuristic,
        "sanityWarnings": warnings,
        "providerError": provider_error,
        "openrouterSkipped": openrouter_skipped,
    })
    return redact_secrets(with_network_triage(model_score))


def _review_command(task_id: str) -> str:
    return f"uv run orcctl review next --task-id {task_id}"


def _classify_command(task_id: str) -> str:
    return (
        f"uv run orcctl review classify {task_id} "
        "--disposition <reviewed_no_action|reviewed_follow_up|reviewed_integrity_follow_up|reviewed_unclear> "
        '--summary "<source-backed summary>"'
    )


def network_triage_decision(priority: dict[str, Any]) -> dict[str, Any]:
    task_id = _safe_text(priority.get("taskId"), 180)
    source_mode = _safe_text(priority.get("sourceMode") or priority.get("source"), 80)
    rank_bucket = _safe_text(priority.get("rankBucket"), 80)
    disposition = _safe_text(priority.get("reviewDisposition"), 120) or "not_reviewed"
    if source_mode == "operator_outstanding":
        decision = "work_assigned_network_task"
        next_command = f"uv run orcctl task detail {task_id}"
        commands = [
            next_command,
            f"uv run orcctl task accept {task_id}",
            f"uv run orcctl task submit {task_id} --evidence-file <path>",
        ]
    elif rank_bucket == "refuse_or_escalate":
        decision = "escalate_or_refuse"
        next_command = _review_command(task_id)
        commands = [next_command, _classify_command(task_id)]
    elif disposition in {"reviewed_follow_up", "reviewed_integrity_follow_up", "reviewed_unclear"}:
        decision = "continue_required_followup"
        next_command = f"uv run orcctl request-followup {task_id}"
        commands = [
            _review_command(task_id),
            next_command,
            f"uv run orcctl close-followup {task_id} --followup-task-id <task_id>",
        ]
    else:
        decision = "review_rewarded_network_task"
        next_command = _review_command(task_id)
        commands = [
            next_command,
            _classify_command(task_id),
            f"uv run orcctl signal-user {task_id} --message <message>",
        ]
    return redact_secrets({
        "capability": NETWORK_TRIAGE_CAPABILITY_VERSION,
        "taskId": task_id,
        "sourceMode": source_mode,
        "rank": priority.get("rank") or 0,
        "priorityScore": priority.get("priorityScore"),
        "rankBucket": rank_bucket,
        "reviewDisposition": disposition,
        "decision": decision,
        "nextCommand": next_command,
        "commands": commands,
        "requiresAction": decision in {
            "continue_required_followup",
            "review_rewarded_network_task",
            "work_assigned_network_task",
        },
        "secretPrinted": False,
    })


def with_network_triage(priority: dict[str, Any]) -> dict[str, Any]:
    priority["triage"] = network_triage_decision(priority)
    priority["nextCommand"] = priority["triage"]["nextCommand"]
    return priority


def first_network_triage_item(priorities: list[dict[str, Any]]) -> dict[str, Any]:
    for item in priorities:
        if not isinstance(item, dict):
            continue
        triage = _safe_dict(item.get("triage"))
        if triage.get("requiresAction", True):
            return redact_secrets({
                "taskId": item.get("taskId"),
                "task_id": item.get("taskId"),
                "title": item.get("title"),
                "walletAddress": item.get("walletAddress"),
                "wallet_address": item.get("walletAddress"),
                "accountId": item.get("accountId"),
                "account_id": item.get("accountId"),
                "rewardActualPft": item.get("rewardPft"),
                "reward_actual_pft": item.get("rewardPft"),
                "reviewDisposition": item.get("reviewDisposition"),
                "review_disposition": item.get("reviewDisposition"),
                "priorityScore": item.get("priorityScore"),
                "rankBucket": item.get("rankBucket"),
                "sourceMode": item.get("sourceMode"),
                "triage": triage,
            })
    return {}


def _ranked_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results.sort(key=lambda item: (
        -_number(item.get("priorityScore"), 0),
        -_number(_safe_dict(item.get("heuristicScore")).get("priorityScore"), 0),
        _safe_text(item.get("taskId"), 180),
    ))
    for index, item in enumerate(results, start=1):
        item["rank"] = index
        if isinstance(item.get("triage"), dict):
            item["triage"]["rank"] = index
    return results


def prioritize_review_queue(
    *,
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = True,
    disposition: str = "not_reviewed",
    candidate_limit: int = 25,
    model_limit: int = 10,
    include_prompt: bool = False,
    include_fixtures: bool = False,
    text_limit: int = 1200,
    database_url: str | None = None,
) -> dict[str, Any]:
    if disposition and disposition not in REVIEW_DISPOSITIONS:
        raise ValueError(f"Unknown review disposition: {disposition}")
    scan_limit = max(1, candidate_limit)
    if not include_fixtures:
        scan_limit = max(scan_limit, 500)
    queue = review_queue(disposition=disposition, limit=scan_limit, database_url=database_url)
    rows = [
        row for row in _safe_list(_safe_dict(queue).get("rows"))
        if isinstance(row, dict)
    ]
    if not include_fixtures:
        rows = [row for row in rows if not is_probable_fixture_priority_row(row)]

    scored_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    packet_errors: list[dict[str, Any]] = []
    rows = rows[:max(1, candidate_limit)]
    for row in rows:
        task_id = _safe_text(row.get("task_id") or row.get("taskId"), 180)
        if not task_id:
            continue
        try:
            review_packet = build_rewarded_network_task_review_packet(
                task_id=task_id,
                limit=1,
                text_limit=text_limit,
                include_raw_events=False,
                database_url=database_url,
            )
            tasks = _safe_list(_safe_dict(review_packet).get("tasks"))
            if not tasks:
                packet_errors.append({"taskId": task_id, "error": "review_packet_missing"})
                continue
            packet = build_review_queue_reward_packet(_safe_dict(tasks[0]), review_state=row)
            heuristic = normalize_priority_result(heuristic_priority_score(packet), packet, scored_by="heuristic")
            scored_candidates.append((packet, heuristic))
        except Exception as exc:
            packet_errors.append({
                "taskId": task_id,
                "error": type(exc).__name__,
                "message": _safe_text(exc, 500),
            })

    scored_candidates.sort(key=lambda pair: (
        -_number(pair[1].get("priorityScore"), 0),
        _safe_text(pair[0].get("taskId"), 180),
    ))
    model_budget = max(0, model_limit)
    results = [
        _score_priority_packet(
            packet,
            model=model,
            use_openrouter=use_openrouter,
            openrouter_allowed=index < model_budget,
        )
        for index, (packet, _heuristic) in enumerate(scored_candidates)
    ]
    results = _ranked_results(results)
    payload = {
        "ok": True,
        "generatedAt": _utcnow(),
        "source": "review_queue",
        "disposition": disposition,
        "candidateLimit": candidate_limit,
        "scanLimit": scan_limit,
        "modelLimit": model_limit,
        "openrouterAttempted": bool(use_openrouter),
        "model": model,
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "count": len(results),
        "packetErrorCount": len(packet_errors),
        "packetErrors": packet_errors[:10],
        "taskIds": [item.get("taskId") for item in results],
        "priorities": results,
        "secretPrinted": False,
    }
    if include_prompt:
        payload["prompt"] = PRIORITY_SYSTEM_PROMPT
    return redact_secrets(payload)


def prioritize_directory_rewarded_tasks(
    *,
    client: Any | None = None,
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = True,
    task_kind: str = "network",
    candidate_limit: int = 200,
    model_limit: int = 20,
    include_prompt: bool = False,
) -> dict[str, Any]:
    active_client = client or build_client()
    login = active_client.login()
    response = active_client.request(
        "GET",
        "/api/directory/rewarded-tasks",
        params={
            "taskKind": _safe_text(task_kind, 80) or "network",
            "limit": max(1, int(candidate_limit or 200)),
        },
    )
    document = _safe_dict(_safe_dict(response).get("document"))
    rows = [
        row for row in _safe_list(document.get("tasks"))
        if isinstance(row, dict) and not is_probable_fixture_priority_row(row)
    ]
    scored_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for row in rows:
        packet = build_directory_rewarded_task_packet(row)
        heuristic = normalize_priority_result(heuristic_priority_score(packet), packet, scored_by="heuristic")
        scored_candidates.append((packet, heuristic))

    scored_candidates.sort(key=lambda pair: (
        -_number(pair[1].get("priorityScore"), 0),
        -_number(pair[0].get("rewardPft"), 0),
        _safe_text(pair[0].get("taskId"), 180),
    ))
    model_budget = max(0, int(model_limit or 0))
    results = [
        _score_priority_packet(
            packet,
            model=model,
            use_openrouter=use_openrouter,
            openrouter_allowed=index < model_budget,
        )
        for index, (packet, _heuristic) in enumerate(scored_candidates)
    ]
    results = _ranked_results(results)
    payload = {
        "ok": True,
        "generatedAt": _utcnow(),
        "source": "directory_rewarded_tasks",
        "address": getattr(active_client, "address", ""),
        "loginCached": bool(_safe_dict(login).get("cached")),
        "candidateLimit": candidate_limit,
        "modelLimit": model_limit,
        "openrouterAttempted": bool(use_openrouter),
        "model": model,
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "directoryTotals": document.get("totals") or {},
        "count": len(results),
        "taskIds": [item.get("taskId") for item in results],
        "priorities": results,
        "secretPrinted": False,
    }
    if include_prompt:
        payload["prompt"] = PRIORITY_SYSTEM_PROMPT
    return redact_secrets(payload)


def prioritize_network_work(
    *,
    source: str = "directory_rewarded_tasks",
    client: Any | None = None,
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = True,
    max_tasks: int = 20,
    candidate_limit: int = 25,
    model_limit: int = 10,
    disposition: str = "not_reviewed",
    task_kind: str = "network",
    include_prompt: bool = False,
    include_fixtures: bool = False,
    database_url: str | None = None,
) -> dict[str, Any]:
    normalized_source = _safe_text(source, 80).replace("-", "_")
    if normalized_source in {"operator", "operator_outstanding"}:
        payload = prioritize_network_tasks(
            client=client,
            model=model,
            use_openrouter=use_openrouter,
            max_tasks=max_tasks,
            include_prompt=include_prompt,
        )
        payload["source"] = "operator_outstanding"
        return payload
    if normalized_source in {"review_queue", "queue", "everyone", "all_unreviewed"}:
        return prioritize_review_queue(
            model=model,
            use_openrouter=use_openrouter,
            disposition=disposition,
            candidate_limit=candidate_limit,
            model_limit=model_limit,
            include_prompt=include_prompt,
            include_fixtures=include_fixtures,
            database_url=database_url,
        )
    if normalized_source in {"directory", "directory_rewarded_tasks", "leaderboard", "live_directory"}:
        return prioritize_directory_rewarded_tasks(
            client=client,
            model=model,
            use_openrouter=use_openrouter,
            task_kind=task_kind,
            candidate_limit=candidate_limit,
            model_limit=model_limit,
            include_prompt=include_prompt,
        )
    raise ValueError("source must be directory-rewarded-tasks, review-queue, or operator-outstanding")


def triage_network_work(
    *,
    source: str = "review_queue",
    client: Any | None = None,
    model: str = DEFAULT_PRIORITY_MODEL,
    use_openrouter: bool = False,
    max_tasks: int = 20,
    candidate_limit: int = 25,
    model_limit: int = 10,
    disposition: str = "not_reviewed",
    task_kind: str = "network",
    include_prompt: bool = False,
    include_fixtures: bool = False,
    database_url: str | None = None,
) -> dict[str, Any]:
    priority = prioritize_network_work(
        source=source,
        client=client,
        model=model,
        use_openrouter=use_openrouter,
        max_tasks=max_tasks,
        candidate_limit=candidate_limit,
        model_limit=model_limit,
        disposition=disposition,
        task_kind=task_kind,
        include_prompt=include_prompt,
        include_fixtures=include_fixtures,
        database_url=database_url,
    )
    priorities = [
        with_network_triage(item)
        for item in _safe_list(_safe_dict(priority).get("priorities"))
        if isinstance(item, dict)
    ]
    return redact_secrets({
        "ok": bool(_safe_dict(priority).get("ok", True)),
        "capability": NETWORK_TRIAGE_CAPABILITY_VERSION,
        "generatedAt": priority.get("generatedAt") or _utcnow(),
        "source": priority.get("source") or source,
        "promptVersion": PRIORITY_PROMPT_VERSION,
        "priorityModel": priority.get("model") or model,
        "openrouterAttempted": bool(priority.get("openrouterAttempted")),
        "count": len(priorities),
        "nextItem": first_network_triage_item(priorities),
        "priorities": priorities,
        "packetErrors": priority.get("packetErrors") or [],
        "secretPrinted": False,
    })


def next_network_triage_item(
    *,
    source: str = "review_queue",
    client: Any | None = None,
    candidate_limit: int = 25,
    disposition: str = "not_reviewed",
    include_fixtures: bool = False,
    database_url: str | None = None,
) -> dict[str, Any]:
    triage = triage_network_work(
        source=source,
        client=client,
        use_openrouter=False,
        candidate_limit=candidate_limit,
        model_limit=0,
        disposition=disposition,
        include_fixtures=include_fixtures,
        database_url=database_url,
    )
    return _safe_dict(triage.get("nextItem"))
