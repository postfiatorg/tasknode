from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Callable

from tasknode_pftl.app_data import tasknode_database_url

from .hive_followup import DEFAULT_TASKNODE_REPO


def build_hive_signal_command(
    *,
    task_id: str,
    message: str,
    execute: bool = False,
    tasknode_repo: str = DEFAULT_TASKNODE_REPO,
    account_id: str = "",
    conversation_id: str = "",
    reviewer_handle: str = "",
    reviewer_wallet: str = "",
    reason: str = "",
    metadata: dict[str, Any] | None = None,
) -> list[str]:
    clean_task_id = str(task_id or "").strip()
    clean_message = str(message or "").strip()
    if not clean_task_id:
        raise ValueError("task_id is required")
    if not clean_message:
        raise ValueError("message is required")
    script = os.path.join(tasknode_repo, "scripts", "orc-hive-signal.mjs")
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
    if reviewer_handle:
        command.extend(["--reviewer-handle", str(reviewer_handle).strip()])
    if reviewer_wallet:
        command.extend(["--reviewer-wallet", str(reviewer_wallet).strip()])
    if reason:
        command.extend(["--reason", str(reason).strip()])
    if metadata:
        command.extend(["--metadata-json", json.dumps(metadata, sort_keys=True)])
    if execute:
        command.append("--execute")
    return command


def run_hive_signal(
    *,
    task_id: str,
    message: str,
    execute: bool = False,
    tasknode_repo: str = DEFAULT_TASKNODE_REPO,
    account_id: str = "",
    conversation_id: str = "",
    reviewer_handle: str = "",
    reviewer_wallet: str = "",
    reason: str = "",
    metadata: dict[str, Any] | None = None,
    database_url: str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    command = build_hive_signal_command(
        task_id=task_id,
        message=message,
        execute=execute,
        tasknode_repo=tasknode_repo,
        account_id=account_id,
        conversation_id=conversation_id,
        reviewer_handle=reviewer_handle,
        reviewer_wallet=reviewer_wallet,
        reason=reason,
        metadata=metadata,
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
            "error": "orc_hive_signal_failed",
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
            "error": "orc_hive_signal_invalid_json",
            "returnCode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "secretPrinted": False,
        }
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "orc_hive_signal_invalid_json_shape",
            "returnCode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "secretPrinted": False,
        }
    payload.setdefault("secretPrinted", False)
    payload.setdefault("command", " ".join(command))
    return payload
