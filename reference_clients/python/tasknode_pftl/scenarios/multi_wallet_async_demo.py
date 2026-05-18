from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
import json
import math
from pathlib import Path
import threading
import time
from typing import Any

from tasknode_pftl.codec import now_iso, sha256_hex, short
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.encryption import (
    X25519Identity,
    generate_identity,
    tasknode_identity_from_seed,
    x25519_public_key_b64_from_message_key,
)
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, drops_to_pft, pft_to_drops
from tasknode_pftl.pointers import Pointer
from tasknode_pftl.reducer import hydrate_and_reduce
from tasknode_pftl.scenarios.app_request_lifecycle import publish_message_keys_safely
from tasknode_pftl.scenarios.full_lifecycle import (
    RUNS_DIR,
    encrypted_upload,
    event_id,
    make_task_id,
    private_wallets,
    public_wallets,
    queue_entries_public,
    submit_pointer_payment,
    write_json,
)
from tasknode_pftl.taskgen import build_request_bundle, build_verification_request, generate_task, project_taskgen_input
from tasknode_pftl.tx_queue import WalletTxQueue
from tasknode_pftl.wallets import ProtocolWallet, create_protocol_wallet, fund_wallets


DEFAULT_WALLET_COUNT = 10
DEFAULT_AUTHORITY_COUNT = 2
DEFAULT_ALLOCATION_SHARD_SIZE = 5
DEFAULT_REWARD_PFT = 0.75


def allocation_count_for(wallet_count: int, allocation_count: int | None, shard_size: int) -> int:
    if allocation_count is not None and allocation_count > 0:
        return allocation_count
    return max(1, math.ceil(max(1, wallet_count) / max(1, shard_size)))


def assignment_for_index(index: int, *, authority_count: int, allocation_count: int, allocation_shard_size: int) -> dict[str, int]:
    if index < 0:
        raise ValueError("index must be non-negative")
    if authority_count <= 0:
        raise ValueError("authority_count must be positive")
    if allocation_count <= 0:
        raise ValueError("allocation_count must be positive")
    if allocation_shard_size <= 0:
        raise ValueError("allocation_shard_size must be positive")
    return {
        "authority_index": index % authority_count,
        "allocation_index": min(index // allocation_shard_size, allocation_count - 1),
    }


def apply_demo_reward_policy(taskgen_output: dict[str, Any], reward_pft: float) -> dict[str, Any]:
    output = deepcopy(taskgen_output)
    reward = output.setdefault("reward_offer", {})
    reward["amount_estimate_pft"] = f"{float(reward_pft):.2f}"
    return output


def resolved_encryption_keys(client: PftlClient, wallets: list[ProtocolWallet]) -> dict[str, str]:
    keys = {}
    for wallet in wallets:
        message_key = client.account_message_key(wallet.address) or ""
        keys[wallet.role] = x25519_public_key_b64_from_message_key(message_key)
        if keys[wallet.role] != wallet.encryption.public_key_b64:
            raise RuntimeError(f"Resolved MessageKey does not match local encryption identity for {wallet.role}")
    return keys


class WalletQueueEngine:
    def __init__(self, config: PftlConfig):
        self.config = config
        self._queues: dict[str, WalletTxQueue] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._registry_lock = threading.Lock()

    def queue_for(self, address: str) -> WalletTxQueue:
        with self._registry_lock:
            if address not in self._queues:
                self._queues[address] = WalletTxQueue(address)
            return self._queues[address]

    def lock_for(self, address: str) -> threading.Lock:
        with self._registry_lock:
            if address not in self._locks:
                self._locks[address] = threading.Lock()
            return self._locks[address]

    def submit_pointer(
        self,
        *,
        wallet: ProtocolWallet,
        destination: str,
        pointer: Pointer,
        idem: str,
        amount_drops: str = "1",
    ) -> dict[str, Any]:
        lock = self.lock_for(wallet.address)
        queue = self.queue_for(wallet.address)
        with lock:
            return submit_pointer_payment(
                client=PftlClient(self.config.rpc_url),
                queue=queue,
                wallet=wallet.wallet,
                destination=destination,
                pointer=pointer,
                amount_drops=amount_drops,
                idem=idem,
            )

    def queue_state(self, wallets: list[ProtocolWallet]) -> dict[str, list[dict[str, Any]]]:
        return {
            f"{wallet.role}:{wallet.address}": queue_entries_public(self.queue_for(wallet.address))
            for wallet in wallets
        }


def demo_context_doc(run_id: str, user_wallet: ProtocolWallet, index: int) -> dict[str, Any]:
    return {
        "schema": "pf.context.doc.v1",
        "context_id": f"ctx_{sha256_hex(run_id + user_wallet.address)[:24]}",
        "created_at": now_iso(),
        "subject_wallet": user_wallet.address,
        "content": (
            f"Demo user {index + 1} is testing the Task Node async architecture. "
            "The goal is to prove wallet-scoped request, offer, verification, reward, "
            "and replay behavior across many independent user wallets."
        ),
    }


def demo_request_bundle(
    *,
    run_id: str,
    index: int,
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
) -> dict[str, Any]:
    created_at = now_iso()
    bundle = build_request_bundle(
        subject_wallet=user_wallet.address,
        allocation_wallet=allocation_wallet.address,
        client_name="python-multi-wallet-async-demo",
    )
    bundle["client"]["session_id"] = f"{run_id}_user_{index + 1:02d}"
    bundle["request"]["request_text"] = (
        "Issue a compact task that validates one wallet shard in the multi-wallet Task Node async demo."
    )
    bundle["request"]["user_detail_text"] = (
        f"Demo wallet {index + 1} should receive a task, accept it, submit evidence, answer verification, "
        "and receive a real PFT reward from its allocation wallet."
    )
    bundle["request"]["requested_task_kind"] = "system"
    bundle["request"]["source"] = "python_multi_wallet_demo"
    bundle["recent_chat"] = {
        "messages": [
            {
                "id": f"{run_id}_u{index + 1:02d}_msg_1",
                "role": "user",
                "content": "Request a task that proves the wallet-native async pipeline works under sharded load.",
                "created_at": created_at,
                "digest": "sha256:" + sha256_hex(f"{run_id}-{index}-request"),
            },
            {
                "id": f"{run_id}_u{index + 1:02d}_msg_2",
                "role": "assistant",
                "content": "The system should issue a verifiable task and reward it from an allocation wallet.",
                "created_at": created_at,
                "digest": "sha256:" + sha256_hex(f"{run_id}-{index}-assistant"),
            },
        ],
        "summary": (
            f"Wallet {index + 1} is exercising the request, offer, verification, reward, and replay path."
        ),
        "window": {
            "started_at": created_at,
            "ended_at": created_at,
        },
    }
    bundle["memory"] = {
        "deep_memory": [
            {
                "memory": "The user is validating Task Node's wallet-first async task architecture before production.",
                "created_at": created_at,
            }
        ],
        "recent_memory": [
            {
                "memory": "Task state must be replayable from PFTL pointers and encrypted IPFS payloads.",
                "created_at": created_at,
            }
        ],
    }
    bundle["wallet"]["authority_hint"] = authority_wallet.address
    bundle["wallet"]["allocation_wallet"] = allocation_wallet.address
    bundle["policy"]["authority_policy_version"] = "multi-wallet-demo-authority-v1"
    bundle["policy"]["allocation_policy_version"] = "multi-wallet-demo-allocation-shard-v1"
    return bundle


def task_recipients(
    *,
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
    tasknode_identity: X25519Identity,
    verification_identity: X25519Identity,
    tasknode_pubkey_override: str | None,
) -> list[X25519Identity | str]:
    recipients: list[X25519Identity | str] = [
        user_wallet.encryption,
        authority_wallet.encryption,
        allocation_wallet.encryption,
        tasknode_identity,
        verification_identity,
    ]
    if tasknode_pubkey_override and tasknode_pubkey_override != tasknode_identity.public_key_b64:
        recipients.append(tasknode_pubkey_override)
    return recipients


def run_one_wallet_lifecycle(
    *,
    index: int,
    run_id: str,
    config: PftlConfig,
    ipfs: IpfsClient,
    queue_engine: WalletQueueEngine,
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
    tasknode_identity: X25519Identity,
    verification_identity: X25519Identity,
    reward_pft: float,
    allow_taskgen_fallback: bool,
    benchmark_high_reasoning: bool,
    taskgen_lock: threading.Semaphore,
) -> dict[str, Any]:
    recipients = task_recipients(
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
        tasknode_identity=tasknode_identity,
        verification_identity=verification_identity,
        tasknode_pubkey_override=config.tasknode_encryption_pubkey,
    )
    context_doc = demo_context_doc(run_id, user_wallet, index)
    context_upload = encrypted_upload(
        ipfs=ipfs,
        payload=context_doc,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-context-doc",
        content_kind="CONTEXT",
    )

    request_bundle = demo_request_bundle(
        run_id=run_id,
        index=index,
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
    )
    request_bundle["context"]["primary_context_doc"]["cid"] = context_upload["cid"]
    request_bundle["context"]["primary_context_doc"]["digest"] = "sha256:" + context_upload["payload_digest"]
    request_upload = encrypted_upload(
        ipfs=ipfs,
        payload=request_bundle,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-request-bundle",
        content_kind="TASK",
    )

    request_event = {
        "schema": "pf.task.request.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "request_id": request_bundle["request"]["request_id"],
        "event_id": event_id("evt", request_bundle),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "request_bundle": {
            "bundle_id": request_bundle["bundle_id"],
            "cid": request_upload["cid"],
            "digest": "sha256:" + request_upload["payload_digest"],
            "summary": request_bundle["recent_chat"]["summary"],
        },
        "request_text": request_bundle["request"]["request_text"],
        "user_detail_text": request_bundle["request"]["user_detail_text"],
        "requested_task_kind": request_bundle["request"]["requested_task_kind"],
        "client": request_bundle["client"],
    }
    request_event_upload = encrypted_upload(
        ipfs=ipfs,
        payload=request_event,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-task-request-event",
        content_kind="TASK",
    )
    request_tx = queue_engine.submit_pointer(
        wallet=user_wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=request_event_upload["cid"], kind="TASK", schema=1),
        idem=sha256_hex(request_event),
    )

    task_input = project_taskgen_input(
        request_bundle,
        bundle_cid=request_upload["cid"],
        bundle_digest="sha256:" + request_upload["payload_digest"],
    )
    with taskgen_lock:
        taskgen = generate_task(
            config,
            task_input,
            benchmark_high_reasoning=benchmark_high_reasoning,
            allow_fallback=allow_taskgen_fallback,
        )
    taskgen_output = apply_demo_reward_policy(taskgen.output, reward_pft)

    offer_core = {
        "request_id": request_bundle["request"]["request_id"],
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "taskgen_output": taskgen_output,
    }
    task_id = make_task_id(config, authority_wallet.address, request_upload["cid"], offer_core)
    task_offer = {
        "schema": "pf.task.offer.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "event_id": event_id("evt", {**offer_core, "task_id": task_id}),
        "request_id": request_bundle["request"]["request_id"],
        "actor_wallet": authority_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "status": "proposed",
        "title": taskgen_output["title"],
        "description": taskgen_output["description"],
        "task_kind": taskgen_output["task_kind"],
        "submission_requirement": taskgen_output["submission_requirement"],
        "verification_policy": taskgen_output["verification_policy"],
        "reward_offer": taskgen_output["reward_offer"],
        "proposed_at": now_iso(),
        "accept_by": taskgen_output["deadline"]["accept_by"],
        "deadline_at": taskgen_output["deadline"].get("deadline_at"),
        "context_refs": [{
            "context_id": context_doc["context_id"],
            "cid": context_upload["cid"],
            "digest": "sha256:" + context_upload["payload_digest"],
        }],
        "generation": {
            **taskgen.metadata,
            "reward_policy_override_pft": f"{reward_pft:.2f}",
            "request_bundle_cid": request_upload["cid"],
            "request_bundle_digest": "sha256:" + request_upload["payload_digest"],
        },
    }
    offer_upload = encrypted_upload(
        ipfs=ipfs,
        payload=task_offer,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-task-offer",
        content_kind="TASK",
        task_id=task_id,
    )
    offer_tx = queue_engine.submit_pointer(
        wallet=authority_wallet,
        destination=user_wallet.address,
        pointer=Pointer(cid=offer_upload["cid"], kind="TASK", schema=1, task_id=task_id),
        idem=sha256_hex(task_offer),
    )

    accepted_event = {
        "schema": "pf.task.update.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "event_id": event_id("evt", {"task_id": task_id, "transition": "accepted"}),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "transition": "accepted",
        "status_after": "accepted",
        "accepted_at": now_iso(),
    }
    accepted_upload = encrypted_upload(
        ipfs=ipfs,
        payload=accepted_event,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-task-accepted",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    accepted_tx = queue_engine.submit_pointer(
        wallet=user_wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=accepted_upload["cid"], kind="TASK_UPDATE", schema=1, task_id=task_id),
        idem=sha256_hex(accepted_event),
    )

    initial_evidence = {
        "schema": "pf.task.evidence.v1",
        "task_id": task_id,
        "phase": "initial_submission",
        "artifact_type": "text",
        "response": (
            f"Initial evidence from demo wallet {index + 1}. The user wallet requested, accepted, "
            "and submitted this task as part of the 10-wallet async architecture demo."
        ),
        "created_at": now_iso(),
    }
    initial_evidence_upload = encrypted_upload(
        ipfs=ipfs,
        payload=initial_evidence,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-initial-evidence",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    submission_id = f"sub_{sha256_hex(initial_evidence)[:24]}"
    initial_submission = {
        "schema": "pf.task.submission.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", initial_evidence),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "phase": "initial_submission",
        "artifact_cid": initial_evidence_upload["cid"],
        "artifact_type": "text",
        "artifact_digest": "sha256:" + initial_evidence_upload["payload_digest"],
        "summary": f"Demo wallet {index + 1} initial evidence submitted.",
        "submitted_at": now_iso(),
    }
    initial_submission_upload = encrypted_upload(
        ipfs=ipfs,
        payload=initial_submission,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-initial-submission",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    submission_tx = queue_engine.submit_pointer(
        wallet=user_wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=initial_submission_upload["cid"], kind="TASK_SUBMISSION", schema=1, task_id=task_id),
        idem=sha256_hex(initial_submission),
    )

    verification_request = build_verification_request(task_offer, initial_submission)
    verification_event = {
        "schema": "pf.task.update.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "event_id": event_id("evt", verification_request),
        "actor_wallet": authority_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "transition": "verification_requested",
        "status_after": "verification_requested",
        "verification_request": verification_request,
    }
    verification_request_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_event,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-verification-request",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    verification_request_tx = queue_engine.submit_pointer(
        wallet=authority_wallet,
        destination=user_wallet.address,
        pointer=Pointer(cid=verification_request_upload["cid"], kind="TASK_UPDATE", schema=1, task_id=task_id),
        idem=sha256_hex(verification_event),
    )

    verification_evidence = {
        "schema": "pf.task.evidence.v1",
        "task_id": task_id,
        "submission_id": submission_id,
        "phase": "verification_response",
        "artifact_type": "text",
        "response": (
            f"Verification evidence from demo wallet {index + 1}. The task was issued by "
            f"{authority_wallet.address} and rewarded by {allocation_wallet.address}."
        ),
        "created_at": now_iso(),
    }
    verification_evidence_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_evidence,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-verification-evidence",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    verification_response = {
        "schema": "pf.task.verification_response.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", verification_evidence),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "phase": "verification_response",
        "verification_response_cid": verification_evidence_upload["cid"],
        "verification_response_digest": "sha256:" + verification_evidence_upload["payload_digest"],
        "response_text": f"Confirmed demo wallet {index + 1} completed the requested workflow.",
        "artifact_type": "text",
        "responded_at": now_iso(),
    }
    verification_response_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_response,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-verification-response",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    verification_response_tx = queue_engine.submit_pointer(
        wallet=user_wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=verification_response_upload["cid"], kind="TASK_SUBMISSION", schema=1, task_id=task_id),
        idem=sha256_hex(verification_response),
    )

    reward_payload = {
        "schema": "pf.reward.v1",
        "reward_history_schema": 1,
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", {"task_id": task_id, "reward": reward_pft}),
        "actor_wallet": allocation_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "recipient_wallet_address": user_wallet.address,
        "reward_pft": f"{reward_pft:.2f}",
        "reward_tier": "multi_wallet_async_demo",
        "reward_score": 1.0,
        "reward_summary": f"Demo wallet {index + 1} completed request, verification, and replay.",
        "task_history": {
            "task": task_offer,
            "submission": initial_submission,
            "verification_request": verification_event,
            "verification_response": verification_response,
            "tx_hashes": {
                "request": request_tx["tx_hash"],
                "offer": offer_tx["tx_hash"],
                "accepted": accepted_tx["tx_hash"],
                "submission": submission_tx["tx_hash"],
                "verification_request": verification_request_tx["tx_hash"],
                "verification_response": verification_response_tx["tx_hash"],
            },
        },
    }
    reward_upload = encrypted_upload(
        ipfs=ipfs,
        payload=reward_payload,
        recipients=recipients,
        name=f"{run_id}-user-{index + 1:02d}-reward",
        content_kind="REWARD",
        task_id=task_id,
    )
    reward_tx = queue_engine.submit_pointer(
        wallet=allocation_wallet,
        destination=user_wallet.address,
        pointer=Pointer(cid=reward_upload["cid"], kind="REWARD", schema=1, task_id=task_id),
        amount_drops=pft_to_drops(reward_pft),
        idem=sha256_hex(reward_payload),
    )

    cids = {
        "context_doc": context_upload["cid"],
        "request_bundle": request_upload["cid"],
        "request_event": request_event_upload["cid"],
        "offer": offer_upload["cid"],
        "accepted": accepted_upload["cid"],
        "initial_evidence": initial_evidence_upload["cid"],
        "initial_submission": initial_submission_upload["cid"],
        "verification_request": verification_request_upload["cid"],
        "verification_evidence": verification_evidence_upload["cid"],
        "verification_response": verification_response_upload["cid"],
        "reward": reward_upload["cid"],
    }
    txs = {
        "request": request_tx,
        "offer": offer_tx,
        "accepted": accepted_tx,
        "submission": submission_tx,
        "verification_request": verification_request_tx,
        "verification_response": verification_response_tx,
        "reward": reward_tx,
    }
    return {
        "index": index,
        "task_id": task_id,
        "request_id": request_bundle["request"]["request_id"],
        "bundle_id": request_bundle["bundle_id"],
        "user_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "cids": cids,
        "txs": txs,
        "taskgen": taskgen.metadata,
        "generated_task": taskgen_output,
        "submission_summaries": [
            {
                "phase": "initial_submission",
                "response": initial_evidence["response"],
                "artifact_cid": initial_evidence_upload["cid"],
                "pointer_cid": initial_submission_upload["cid"],
                "tx_hash": submission_tx["tx_hash"],
            },
            {
                "phase": "verification_response",
                "response": verification_evidence["response"],
                "artifact_cid": verification_evidence_upload["cid"],
                "pointer_cid": verification_response_upload["cid"],
                "tx_hash": verification_response_tx["tx_hash"],
            },
        ],
    }


def hydrate_and_reduce_with_retry(
    *,
    events: list[dict[str, Any]],
    ipfs: IpfsClient,
    identity: X25519Identity,
    task_ids: set[str],
    attempts: int = 4,
    sleep_seconds: float = 3.0,
) -> tuple[list[Any], dict[str, Any]]:
    last_hydrated = []
    last_projections = {}
    for attempt in range(1, attempts + 1):
        hydrated, projections = hydrate_and_reduce(events, ipfs, identity)
        last_hydrated = hydrated
        last_projections = projections
        if all(projections.get(task_id) and projections[task_id].status == "rewarded" for task_id in task_ids):
            return hydrated, projections
        if attempt < attempts:
            time.sleep(sleep_seconds)
    return last_hydrated, last_projections


def write_markdown_receipt(path: Path, receipt: dict[str, Any]) -> None:
    lines = [
        "# Multi-Wallet Async Task Demo",
        "",
        f"- Run id: `{receipt['run_id']}`",
        f"- Wallet count: `{receipt['wallet_count']}`",
        f"- Authority wallets: `{receipt['authority_count']}`",
        f"- Allocation wallets: `{receipt['allocation_count']}`",
        f"- Reward per task: `{receipt['reward_pft']}` PFT",
        f"- Final rewarded tasks: `{receipt['rewarded_count']}` / `{receipt['wallet_count']}`",
        f"- Pointer events found: `{receipt['pointer_events_found']}`",
        "",
        "## Architecture Exercised",
        "",
        "- Ten independent user wallets request tasks.",
        "- Authority wallets are sharded and serialize their own task-offer and verification-request transactions.",
        "- Allocation reward wallets are sharded and serialize their own reward transactions.",
        "- Every signing wallet has a local queue and lock in the demo.",
        "- The final status is replayed from PFTL pointer events and encrypted IPFS payloads.",
        "",
        "## Wallet Assignments",
        "",
        "| User | User wallet | Authority wallet | Allocation wallet | Task id | Status | Reward tx |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    projections = receipt.get("projection") or {}
    for result in receipt.get("tasks") or []:
        projection = projections.get(result["task_id"], {})
        reward_tx = (result.get("txs") or {}).get("reward", {}).get("tx_hash", "")
        lines.append(
            "| {user} | `{uw}` | `{aw}` | `{rw}` | `{task}` | `{status}` | `{tx}` |".format(
                user=result["index"] + 1,
                uw=result["user_wallet"],
                aw=result["authority_wallet"],
                rw=result["allocation_wallet"],
                task=result["task_id"],
                status=projection.get("status", "missing"),
                tx=reward_tx,
            )
        )
    lines.extend([
        "",
        "## Queue Summary",
        "",
    ])
    for queue_name, entries in sorted((receipt.get("queue_state") or {}).items()):
        lines.append(f"- `{queue_name}`: {len(entries)} transaction(s)")
    lines.extend(["", "## Task CIDs And Transactions", ""])
    for result in receipt.get("tasks") or []:
        lines.extend([
            f"### User {result['index'] + 1}",
            "",
            f"- Task id: `{result['task_id']}`",
            f"- Request id: `{result['request_id']}`",
            f"- Bundle id: `{result['bundle_id']}`",
        ])
        for key, tx in (result.get("txs") or {}).items():
            lines.append(f"- {key} tx: `{tx.get('tx_hash')}`")
        for key, cid in (result.get("cids") or {}).items():
            lines.append(f"- {key} cid: `{cid}`")
        lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_multi_wallet_async_demo(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_live()
    if not config.openai_api_key and not args.allow_taskgen_fallback:
        raise RuntimeError("OPENAI_API_KEY is required unless --allow-taskgen-fallback is explicit.")

    wallet_count = max(1, int(args.wallet_count))
    authority_count = max(1, int(args.authority_count))
    allocation_count = allocation_count_for(wallet_count, args.allocation_count, args.allocation_shard_size)
    run_id = args.run_id or f"multi_wallet_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print(f"Run id: {run_id}")
    print(f"User wallets: {wallet_count}")
    print(f"Authority wallets: {authority_count}")
    print(f"Allocation wallets: {allocation_count}")

    pftl = PftlClient(config.rpc_url)
    ipfs = IpfsClient(config)
    queue_engine = WalletQueueEngine(config)

    user_wallets = [create_protocol_wallet(f"user_wallet_{index + 1:02d}") for index in range(wallet_count)]
    authority_wallets = [create_protocol_wallet(f"task_authority_{index + 1:02d}") for index in range(authority_count)]
    allocation_wallets = [create_protocol_wallet(f"allocation_reward_{index + 1:02d}") for index in range(allocation_count)]
    all_wallets = [*user_wallets, *authority_wallets, *allocation_wallets]
    verification_identities = {
        wallet.address: generate_identity(f"verification_service_{index + 1:02d}", wallet.address)
        for index, wallet in enumerate(allocation_wallets)
    }
    tasknode_identity = tasknode_identity_from_seed(config.faucet_seed)

    assignments = []
    for index, user_wallet in enumerate(user_wallets):
        assignment = assignment_for_index(
            index,
            authority_count=authority_count,
            allocation_count=allocation_count,
            allocation_shard_size=args.allocation_shard_size,
        )
        authority_wallet = authority_wallets[assignment["authority_index"]]
        allocation_wallet = allocation_wallets[assignment["allocation_index"]]
        assignments.append({
            "index": index,
            "user_wallet": user_wallet,
            "authority_wallet": authority_wallet,
            "allocation_wallet": allocation_wallet,
            "authority_index": assignment["authority_index"],
            "allocation_index": assignment["allocation_index"],
        })

    print("Funding wallets from faucet...")
    funding = fund_wallets(pftl, config.faucet_seed, all_wallets, target_pft=args.fund_pft)
    print("Publishing MessageKeys...")
    key_publications = publish_message_keys_safely(
        pftl,
        all_wallets,
        replace_existing=args.replace_message_key,
    )
    resolved_keys = resolved_encryption_keys(pftl, all_wallets)
    balances_before = {wallet.address: pftl.account_balance_drops(wallet.address) for wallet in all_wallets}

    taskgen_lock = threading.Semaphore(max(1, int(args.taskgen_concurrency)))
    results = []
    print("Running wallet lifecycles...")
    with ThreadPoolExecutor(max_workers=max(1, int(args.concurrency))) as executor:
        futures = {
            executor.submit(
                run_one_wallet_lifecycle,
                index=assignment["index"],
                run_id=run_id,
                config=config,
                ipfs=ipfs,
                queue_engine=queue_engine,
                user_wallet=assignment["user_wallet"],
                authority_wallet=assignment["authority_wallet"],
                allocation_wallet=assignment["allocation_wallet"],
                tasknode_identity=tasknode_identity,
                verification_identity=verification_identities[assignment["allocation_wallet"].address],
                reward_pft=args.reward_pft,
                allow_taskgen_fallback=args.allow_taskgen_fallback,
                benchmark_high_reasoning=args.benchmark_high_reasoning,
                taskgen_lock=taskgen_lock,
            ): assignment
            for assignment in assignments
        }
        for future in as_completed(futures):
            assignment = futures[future]
            result = future.result()
            results.append(result)
            print(
                "  user {user:02d}: task {task} reward_tx {tx}".format(
                    user=assignment["index"] + 1,
                    task=result["task_id"],
                    tx=result["txs"]["reward"]["tx_hash"],
                )
            )
    results.sort(key=lambda item: item["index"])

    balances_after = {wallet.address: pftl.account_balance_drops(wallet.address) for wallet in all_wallets}
    all_pointer_events = []
    for wallet in all_wallets:
        all_pointer_events.extend(pftl.pointer_events_for_wallet(wallet.address))
    task_ids = {result["task_id"] for result in results}
    cid_set = {cid for result in results for cid in (result.get("cids") or {}).values()}
    relevant_events = [
        event for event in all_pointer_events
        if event.get("task_id") in task_ids or event.get("cid") in cid_set
    ]
    hydrated, projections = hydrate_and_reduce_with_retry(
        events=relevant_events,
        ipfs=ipfs,
        identity=tasknode_identity,
        task_ids=task_ids,
    )
    projection_dict = {task: projection.to_dict() for task, projection in projections.items()}
    rewarded_count = sum(1 for task_id in task_ids if projection_dict.get(task_id, {}).get("status") == "rewarded")
    if rewarded_count != wallet_count:
        raise RuntimeError(f"Replay did not reward every task: {rewarded_count}/{wallet_count}")

    public_receipt = {
        "run_id": run_id,
        "schema": "pf.tasknode.multi_wallet_async_demo.receipt.v1",
        "network": {
            "name": config.network_name,
            "rpc_url": config.rpc_url,
            "archive_wss_url": config.archive_wss_url,
            "note": "PFTL is its own Post Fiat L1; xrpl-py is used only as the PFTL wire library.",
        },
        "wallet_count": wallet_count,
        "authority_count": authority_count,
        "allocation_count": allocation_count,
        "allocation_shard_size": args.allocation_shard_size,
        "reward_pft": f"{float(args.reward_pft):.2f}",
        "rewarded_count": rewarded_count,
        "wallets": public_wallets(all_wallets),
        "assignments": [
            {
                "index": assignment["index"],
                "user_wallet": assignment["user_wallet"].address,
                "authority_wallet": assignment["authority_wallet"].address,
                "allocation_wallet": assignment["allocation_wallet"].address,
                "authority_index": assignment["authority_index"],
                "allocation_index": assignment["allocation_index"],
            }
            for assignment in assignments
        ],
        "funding": funding,
        "message_keys": key_publications,
        "resolved_encryption_keys": resolved_keys,
        "balances_before_pft": {address: drops_to_pft(value) for address, value in balances_before.items()},
        "balances_after_pft": {address: drops_to_pft(value) for address, value in balances_after.items()},
        "tasks": results,
        "pointer_events_found": len(relevant_events),
        "hydrated_events": [
            {
                "schema": event.payload.get("schema"),
                "tx_hash": event.source_tx_hash,
                "cid": event.pointer.get("cid"),
                "task_id": event.payload.get("task_id") or event.pointer.get("task_id"),
            }
            for event in hydrated
        ],
        "projection": projection_dict,
        "queue_state": queue_engine.queue_state(all_wallets),
        "capacity_estimate": {
            "assumed_confirm_seconds": args.assumed_confirm_seconds,
            "single_wallet_tx_per_minute": round(60 / args.assumed_confirm_seconds, 2),
            "authority_role_tx_per_minute": round(authority_count * (60 / args.assumed_confirm_seconds), 2),
            "allocation_role_tx_per_minute": round(allocation_count * (60 / args.assumed_confirm_seconds), 2),
        },
    }
    private_receipt = {
        "run_id": run_id,
        "wallets": private_wallets(all_wallets),
        "tasknode_identity": tasknode_identity.private_descriptor(),
        "verification_service_identities": {
            address: identity.private_descriptor()
            for address, identity in verification_identities.items()
        },
    }
    write_json(run_dir / "receipt_public.json", public_receipt)
    write_json(run_dir / "receipt_private.json", private_receipt)
    write_markdown_receipt(run_dir / "multi_wallet_async_demo.md", public_receipt)

    print("\nMulti-wallet async demo complete")
    print(f"  run_id: {run_id}")
    print(f"  rewarded: {rewarded_count}/{wallet_count}")
    print(f"  pointer_events_found: {len(relevant_events)}")
    print(f"  public_receipt: {run_dir / 'receipt_public.json'}")
    print(f"  markdown_receipt: {run_dir / 'multi_wallet_async_demo.md'}")
    return public_receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a live 10-wallet PFTL async task lifecycle demo."
    )
    parser.add_argument("--wallet-count", type=int, default=DEFAULT_WALLET_COUNT)
    parser.add_argument("--authority-count", type=int, default=DEFAULT_AUTHORITY_COUNT)
    parser.add_argument("--allocation-count", type=int, default=None)
    parser.add_argument("--allocation-shard-size", type=int, default=DEFAULT_ALLOCATION_SHARD_SIZE)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--taskgen-concurrency", type=int, default=2)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--fund-pft", type=float, default=25.0)
    parser.add_argument("--reward-pft", type=float, default=DEFAULT_REWARD_PFT)
    parser.add_argument("--replace-message-key", action="store_true")
    parser.add_argument("--benchmark-high-reasoning", action="store_true")
    parser.add_argument("--assumed-confirm-seconds", type=float, default=4.0)
    parser.add_argument(
        "--allow-taskgen-fallback",
        action="store_true",
        help="Permit deterministic local task generation if OpenAI is missing or fails. Off by default.",
    )
    return parser.parse_args()


def main() -> None:
    run_multi_wallet_async_demo(parse_args())


if __name__ == "__main__":
    main()
