from __future__ import annotations

import os
import time
from typing import Any

import requests

from tasknode_pftl.agent_client import (
    DEFAULT_SESSION_STORE,
    SignedFlowResult,
    TaskNodeAgentClient,
)


DEFAULT_ORC_AGENT = os.environ.get("TASKNODE_ORC_AGENT") or "orc"
DEFAULT_EXPECTED_WALLET_ADDRESS = os.environ.get("TASKNODE_AGENT_WALLET_ADDRESS") or ""
DEFAULT_TASKNODE_BASE_URL = os.environ.get("TASKNODE_BASE_URL") or "https://tasknode.postfiat.org"


def build_client(
    *,
    agent: str = DEFAULT_ORC_AGENT,
    expected_wallet_address: str = DEFAULT_EXPECTED_WALLET_ADDRESS,
    base_url: str = DEFAULT_TASKNODE_BASE_URL,
    session_store_path: str = DEFAULT_SESSION_STORE,
    timeout: float = 45,
    http: requests.Session | None = None,
    sleep_fn=time.sleep,
    seed: str | None = None,
) -> TaskNodeAgentClient:
    """Build one TaskNodeAgentClient for the assigned orc identity.

    Seed material comes only from ``seed=`` or ``TASKNODE_AGENT_WALLET_SEED`` in
    the underlying reference client. ``expected_wallet_address`` is an optional
    assertion, not a secret-selection mechanism.
    """

    client = TaskNodeAgentClient(
        base_url=base_url,
        seed=seed,
        session_store_path=session_store_path,
        timeout=timeout,
        http=http,
        sleep_fn=sleep_fn,
    )
    expected = str(expected_wallet_address or "").strip()
    if expected and client.address != expected:
        raise ValueError("loaded wallet address did not match requested operator wallet")
    setattr(client, "agent", str(agent or DEFAULT_ORC_AGENT).strip() or DEFAULT_ORC_AGENT)
    return client


def summarize_signed_flow(
    result: SignedFlowResult,
    *,
    address: str,
    login: dict[str, Any] | None = None,
    request_text: str = "",
    requested_task_kind: str = "",
    tasks: dict[str, Any] | None = None,
) -> dict[str, Any]:
    submitted = result.submitted or {}
    task_view = tasks or {}
    network_view = task_view.get("networkTasks") or task_view.get("networkTaskEligibility") or {}
    return {
        "ok": True,
        "address": address,
        "loginCached": bool((login or {}).get("cached")),
        "requestText": request_text,
        "requestedTaskKind": requested_task_kind,
        "requestId": result.config.get("requestId") or result.payload.get("request_id"),
        "bundleId": result.config.get("bundleId"),
        "bundleCid": submitted.get("bundleCid") or result.payload.get("request_bundle", {}).get("cid"),
        "eventCid": submitted.get("cid") or submitted.get("eventCid") or result.prepared.get("cid"),
        "txHash": submitted.get("txHash") or submitted.get("tx_hash") or result.signed.tx_hash,
        "engineResult": submitted.get("engineResult") or submitted.get("engine_result"),
        "accepted": submitted.get("accepted"),
        "submitted": result.submitted is not None,
        "networkStatus": network_view.get("status") or task_view.get("networkStatus"),
        "secretPrinted": False,
    }


def request_personal_task(
    text: str,
    *,
    submit: bool = False,
    client: TaskNodeAgentClient | None = None,
    agent: str = DEFAULT_ORC_AGENT,
    expected_wallet_address: str = DEFAULT_EXPECTED_WALLET_ADDRESS,
    base_url: str = DEFAULT_TASKNODE_BASE_URL,
    session_store_path: str = DEFAULT_SESSION_STORE,
    timeout: float = 45,
    seed: str | None = None,
    conversation_id: str = "",
    requested_task_kind: str = "personal",
    refresh_tasks: bool = True,
) -> dict[str, Any]:
    """Request a personal task with one client/session.

    Pass ``submit=True`` only when the on-ledger request pointer should be
    published. With the default ``submit=False``, this performs the same signed
    preview flow as the underlying reference client.
    """

    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("task request text is required")
    active_client = client or build_client(
        agent=agent,
        expected_wallet_address=expected_wallet_address,
        base_url=base_url,
        session_store_path=session_store_path,
        timeout=timeout,
        seed=seed,
    )
    login = active_client.login()
    result = active_client.request_task(
        user_detail_text=clean_text,
        requested_task_kind=requested_task_kind,
        conversation_id=conversation_id,
        submit=submit,
    )
    tasks = active_client.tasks() if refresh_tasks else None
    return summarize_signed_flow(
        result,
        address=active_client.address,
        login=login,
        request_text=clean_text,
        requested_task_kind=requested_task_kind,
        tasks=tasks,
    )
