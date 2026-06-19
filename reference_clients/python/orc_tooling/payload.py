from __future__ import annotations

import re
from typing import Any

from .client import build_client
from .tasks import extract_task_brief


VISIBLE_TASK_GROUPS = ("outstanding", "verification", "refused", "rewarded")
SECRET_KEY_PATTERN = re.compile(r"(seed|mnemonic|private|secret|password|token)", re.IGNORECASE)
SEED_PATTERN = re.compile(r"^s[1-9A-HJ-NP-Za-km-z]{20,60}$")
SAFE_TOKEN_COUNT_KEYS = {
    "inputtokens",
    "outputtokens",
    "totaltokens",
    "reasoningtokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
}


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): redact_secrets(item)
            if str(key).lower() in SAFE_TOKEN_COUNT_KEYS
            else (
                "[REDACTED]"
                if str(key) != "secretPrinted" and SECRET_KEY_PATTERN.search(str(key))
                else redact_secrets(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str) and SEED_PATTERN.match(value):
        return "[REDACTED]"
    return value


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _generated_task(detail: dict[str, Any]) -> tuple[dict[str, Any], str]:
    submission = _as_dict(detail.get("submission"))
    generated = _as_dict(submission.get("generatedTask"))
    if generated:
        return generated, "$.submission.generatedTask"

    task = _as_dict(detail.get("task"))
    metadata = _as_dict(task.get("metadata"))
    worker_result = _as_dict(metadata.get("workerResult"))
    generated = _as_dict(worker_result.get("generatedTask"))
    if generated:
        return generated, "$.task.metadata.workerResult.generatedTask"

    forensics = _as_dict(detail.get("forensics"))
    for collection_key in ("timeline", "pointerEvents", "reducerEvents"):
        collection = forensics.get(collection_key)
        if not isinstance(collection, list):
            continue
        for index, event in enumerate(collection):
            raw_payload = _as_dict(_as_dict(event).get("rawPayload"))
            if raw_payload.get("title") or raw_payload.get("steps") or raw_payload.get("submission_requirement"):
                return raw_payload, f"$.forensics.{collection_key}[{index}].rawPayload"

    return {}, ""


def extract_task_payload(detail: dict[str, Any]) -> dict[str, Any]:
    """Extract the executable task payload visible to this operator."""

    task = _as_dict(detail.get("task"))
    generated, generated_path = _generated_task(detail)
    network_payload = _as_dict(generated.get("network_task"))
    submission_requirement = generated.get("submission_requirement") or task.get("submissionRequirement")
    verification_policy = generated.get("verification_policy") or task.get("verificationPolicy")
    reward_offer = generated.get("reward_offer") or {}
    deadline = generated.get("deadline") or {}
    if not isinstance(submission_requirement, dict):
        submission_requirement = {"type": "", "criteria": str(submission_requirement or "")}
    if not isinstance(verification_policy, dict):
        verification_policy = {}
    if not isinstance(reward_offer, dict):
        reward_offer = {}
    if not isinstance(deadline, dict):
        deadline = {}

    brief = extract_task_brief(task)
    execution_brief = {
        "taskId": brief.get("taskId"),
        "title": generated.get("title") or brief.get("title"),
        "kind": brief.get("kind") or generated.get("task_kind"),
        "status": brief.get("status"),
        "rewardPft": brief.get("rewardPft") or reward_offer.get("amount_estimate_pft"),
        "deadline": brief.get("deadline"),
        "objective": generated.get("description") or brief.get("objective"),
        "steps": generated.get("steps") or brief.get("steps") or [],
        "submissionRequirement": submission_requirement,
        "verificationPolicy": verification_policy,
    }

    payload = {
        "task": brief,
        "actions": _as_dict(detail.get("actions")),
        "executionBrief": execution_brief,
        "generatedTaskPayload": generated,
        "networkTaskPayload": network_payload,
        "networkContext": {
            "projectId": generated.get("network_project_id") or network_payload.get("project_id"),
            "projectTitle": network_payload.get("project_title"),
            "projectType": generated.get("network_project_type") or network_payload.get("project_type"),
            "allocationId": generated.get("network_allocation_id") or network_payload.get("allocation_id"),
            "generationJobId": network_payload.get("generation_job_id"),
            "routingReason": network_payload.get("routing_reason"),
            "routingProfileDigest": generated.get("routing_profile_digest") or network_payload.get("routing_profile_digest"),
            "sourcePayloadDigest": network_payload.get("source_payload_digest"),
            "projectNeedSummary": network_payload.get("project_need_summary"),
            "rewardBandPft": network_payload.get("reward_band_pft"),
        },
        "sourcePointers": {
            "contextCid": task.get("contextCid"),
            "requestBundleCid": task.get("requestBundleCid"),
            "txHash": task.get("txHash"),
        },
        "payloadLocations": {
            "generatedTaskPayload": generated_path,
            "networkTaskPayload": f"{generated_path}.network_task" if generated_path and network_payload else "",
        },
        "currentVerificationRequest": detail.get("currentVerificationRequest"),
        "rewardOutcome": detail.get("rewardOutcome"),
        "secretPrinted": False,
    }
    return redact_secrets(payload)


def task_payload(
    task_id: str,
    *,
    client: Any | None = None,
    include_raw_detail: bool = False,
) -> dict[str, Any]:
    active_client = client or build_client()
    login = active_client.login()
    detail = active_client.task_detail(task_id)
    payload = extract_task_payload(detail)
    payload.update({
        "ok": True,
        "address": active_client.address,
        "loginCached": bool(login.get("cached")),
    })
    if include_raw_detail:
        payload["rawDetail"] = redact_secrets(detail)
    return payload


def visible_task_payloads(
    *,
    client: Any | None = None,
    groups: tuple[str, ...] = VISIBLE_TASK_GROUPS,
    network_only: bool = False,
    include_raw_detail: bool = False,
) -> dict[str, Any]:
    active_client = client or build_client()
    login = active_client.login()
    tasks = active_client.tasks()
    task_ids: list[str] = []
    for group in groups:
        for task in tasks.get(group) or []:
            if not isinstance(task, dict):
                continue
            if network_only and not (task.get("isNetworkTask") or str(task.get("kind") or "").lower() == "network"):
                continue
            task_id = task.get("taskId") or task.get("task_id") or task.get("id")
            if task_id and task_id not in task_ids:
                task_ids.append(str(task_id))

    payloads = []
    for task_id in task_ids:
        detail = active_client.task_detail(task_id)
        payload = extract_task_payload(detail)
        if include_raw_detail:
            payload["rawDetail"] = redact_secrets(detail)
        payloads.append(payload)

    network = tasks.get("networkTasks") or tasks.get("networkTaskEligibility") or {}
    return {
        "ok": True,
        "address": active_client.address,
        "loginCached": bool(login.get("cached")),
        "networkStatus": network.get("status") or tasks.get("networkStatus"),
        "count": len(payloads),
        "taskIds": task_ids,
        "payloads": payloads,
        "secretPrinted": False,
    }
