from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Callable

from tasknode_pftl.app_data import tasknode_database_url


DEFAULT_TASKNODE_REPO = "/home/pfrpc/repos/tasknodeofficial"
DEFAULT_DUPLICATE_REWARD_TASK_ID = "task_d2527276782f04a30ce1bbe19bc5c188"


def duplicate_reward_followup_message(
    *,
    task_id: str = DEFAULT_DUPLICATE_REWARD_TASK_ID,
    task_title: str = "Trace Distribution V3 Reward Routing Consistency",
    duplicate_task_count: int = 10,
    duplicate_amount_pft: str = "153,002.50",
) -> str:
    return (
        f"Following up on your rewarded Network Task `{task_title}` (`{task_id}`). "
        "Orc review confirmed the reward-routing issue and duplicate "
        f"`pf.reward.v1` payment pattern was real: {duplicate_task_count} historical tasks had duplicate "
        f"payment rows, with {duplicate_amount_pft} PFT beyond the first payment still needing historical "
        "reconciliation. The current reward path now has duplicate-payment guards and idempotency checks; "
        "the remaining historical reconciliation has been routed to the reward-accounting/core protocol backlog. "
        "No action is needed from you."
    )


def build_hive_followup_command(
    *,
    task_id: str,
    message: str,
    execute: bool = False,
    tasknode_repo: str = DEFAULT_TASKNODE_REPO,
    account_id: str = "",
    conversation_id: str = "",
    followup_required: bool = False,
) -> list[str]:
    clean_task_id = str(task_id or "").strip()
    clean_message = str(message or "").strip()
    if not clean_task_id:
        raise ValueError("task_id is required")
    if not clean_message:
        raise ValueError("message is required")
    script = os.path.join(tasknode_repo, "scripts", "orc-hive-followup.mjs")
    command = [
        "node",
        script,
        "--task-id",
        clean_task_id,
        "--message",
        clean_message,
        "--json",
    ]
    if account_id:
        command.extend(["--account-id", str(account_id).strip()])
    if conversation_id:
        command.extend(["--conversation-id", str(conversation_id).strip()])
    if followup_required:
        command.append("--followup-required")
    if execute:
        command.append("--execute")
    return command


def run_hive_followup(
    *,
    task_id: str,
    message: str,
    execute: bool = False,
    tasknode_repo: str = DEFAULT_TASKNODE_REPO,
    account_id: str = "",
    conversation_id: str = "",
    followup_required: bool = False,
    database_url: str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    command = build_hive_followup_command(
        task_id=task_id,
        message=message,
        execute=execute,
        tasknode_repo=tasknode_repo,
        account_id=account_id,
        conversation_id=conversation_id,
        followup_required=followup_required,
    )
    env = os.environ.copy()
    env.setdefault("DATABASE_URL", tasknode_database_url(database_url))
    env.setdefault("TASKNODE_DATABASE_ENABLED", "true")
    result = runner(
        command,
        cwd=tasknode_repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = str(result.stdout or "").strip()
    stderr = str(result.stderr or "").strip()
    if result.returncode != 0:
        return {
            "ok": False,
            "error": "orc_hive_followup_failed",
            "returnCode": result.returncode,
            "stderr": stderr,
            "stdout": stdout,
            "secretPrinted": False,
        }
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "error": "orc_hive_followup_invalid_json",
            "returnCode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "secretPrinted": False,
        }
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "orc_hive_followup_invalid_json_shape",
            "returnCode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "secretPrinted": False,
        }
    payload.setdefault("secretPrinted", False)
    payload.setdefault("command", " ".join(command))
    return payload


def run_duplicate_reward_followup(
    *,
    task_id: str = DEFAULT_DUPLICATE_REWARD_TASK_ID,
    execute: bool = False,
    message: str = "",
    tasknode_repo: str = DEFAULT_TASKNODE_REPO,
    database_url: str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    return run_hive_followup(
        task_id=task_id,
        message=message or duplicate_reward_followup_message(task_id=task_id),
        execute=execute,
        tasknode_repo=tasknode_repo,
        followup_required=False,
        database_url=database_url,
        runner=runner,
    )
