from __future__ import annotations

from typing import Any

from .client import build_client


def _clean_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").replace("\n", " ").strip()[:limit]


def extract_task_brief(task: dict[str, Any]) -> dict[str, Any]:
    """Extract the operator-facing task brief from an API task projection."""

    submission_requirement = task.get("submissionRequirement") or task.get("submission_requirement") or {}
    verification_policy = task.get("verificationPolicy") or task.get("verification_policy") or task.get("verification") or {}
    steps = task.get("steps") or []
    if not isinstance(steps, list):
        steps = [str(steps)]
    return {
        "taskId": task.get("taskId") or task.get("task_id") or task.get("id"),
        "requestId": task.get("requestId") or task.get("request_id") or task.get("requestFullId"),
        "kind": task.get("kind") or task.get("taskKind") or task.get("task_kind"),
        "status": task.get("status") or task.get("statusKey"),
        "title": _clean_text(task.get("title") or task.get("name") or task.get("summary")),
        "rewardPft": task.get("pft") or task.get("rewardPft") or task.get("pftReward"),
        "deadline": task.get("fullDue") or task.get("due") or task.get("deadlineAt") or task.get("dueAt"),
        "objective": _clean_text(task.get("description") or task.get("objective"), 12000),
        "steps": [_clean_text(step, 2000) for step in steps],
        "submissionRequirement": {
            "type": submission_requirement.get("type") if isinstance(submission_requirement, dict) else "",
            "criteria": _clean_text(
                submission_requirement.get("criteria") if isinstance(submission_requirement, dict) else submission_requirement,
                12000,
            ),
        },
        "verificationPolicy": verification_policy if isinstance(verification_policy, dict) else {},
        "updatedAt": task.get("updatedAt") or task.get("lastEventAt"),
    }


def outstanding_task_briefs(*, client: Any | None = None) -> dict[str, Any]:
    """Read /api/tasks and return full briefs for outstanding tasks."""

    active_client = client or build_client()
    login = active_client.login()
    tasks = active_client.tasks()
    network = tasks.get("networkTasks") or tasks.get("networkTaskEligibility") or {}
    outstanding = tasks.get("outstanding") or []
    return {
        "ok": True,
        "address": active_client.address,
        "loginCached": bool(login.get("cached")),
        "networkStatus": network.get("status") or tasks.get("networkStatus"),
        "gateCount": len(network.get("gates") or network.get("gateView") or []),
        "count": len(outstanding),
        "tasks": [extract_task_brief(task) for task in outstanding if isinstance(task, dict)],
    }
