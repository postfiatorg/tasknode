from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from tasknode_pftl.app_data import (
    build_context_doc_payload,
    build_request_bundle_from_fixture,
    load_task_request_fixture,
    tasknode_database_url,
)
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
from tasknode_pftl.engine.scoring import generate_verification_request
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
from tasknode_pftl.taskgen import generate_task, project_taskgen_input
from tasknode_pftl.tx_queue import WalletTxQueue
from tasknode_pftl.wallets import ProtocolWallet, create_protocol_wallet, fund_wallets, wallet_from_seed


DEFAULT_USER_SEED_FILE = Path(
    os.environ.get("TASKNODE_USER_SEED_FILE", ".secrets/tasknode-user-seed.txt")
).expanduser()


def read_seed_file(path: Path) -> str:
    seed = path.read_text(encoding="utf-8").strip()
    if not seed:
        raise RuntimeError(f"Seed file is empty: {path}")
    return seed


def publish_message_keys_safely(
    client: PftlClient,
    wallets: list[ProtocolWallet],
    *,
    replace_existing: bool = False,
) -> list[dict[str, Any]]:
    rows = []
    for protocol_wallet in wallets:
        expected = protocol_wallet.encryption.message_key
        current = client.account_message_key(protocol_wallet.address)
        if current == expected:
            rows.append({
                "role": protocol_wallet.role,
                "address": protocol_wallet.address,
                "published": False,
                "already_published": True,
                "message_key": expected,
                "x25519_public_key": protocol_wallet.encryption.public_key_b64,
                "x25519_public_key_hex": protocol_wallet.encryption.public_key_hex,
            })
            continue
        if current and not replace_existing:
            raise RuntimeError(
                f"{protocol_wallet.role} wallet already has a different MessageKey. "
                "Use --replace-message-key only after confirming this wallet should use the Task Node standard."
            )
        tx = client.submit_message_key(protocol_wallet.wallet, expected)
        rows.append({
            "role": protocol_wallet.role,
            "address": protocol_wallet.address,
            "published": True,
            "already_published": False,
            "prior_message_key": current,
            "message_key": expected,
            "resolved_message_key": client.account_message_key(protocol_wallet.address),
            "x25519_public_key": protocol_wallet.encryption.public_key_b64,
            "x25519_public_key_hex": protocol_wallet.encryption.public_key_hex,
            "tx_hash": tx.tx_hash,
            "ledger_index": tx.ledger_index,
            "result": tx.result,
        })
    return rows


def resolved_encryption_keys(client: PftlClient, wallets: list[ProtocolWallet]) -> dict[str, str]:
    keys = {}
    for wallet in wallets:
        message_key = client.account_message_key(wallet.address) or ""
        keys[wallet.role] = x25519_public_key_b64_from_message_key(message_key)
        if keys[wallet.role] != wallet.encryption.public_key_b64:
            raise RuntimeError(f"Resolved MessageKey does not match local encryption identity for {wallet.role}")
    return keys


def run_app_request_lifecycle(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_live()
    if not config.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required for prompt-backed task generation.")

    run_id = args.run_id or f"app_request_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    database_url = tasknode_database_url(args.database_url)
    fixture = load_task_request_fixture(
        database_url=database_url,
        chat_title=args.chat_title,
        request_id=args.request_id,
    )

    pftl = PftlClient(config.rpc_url)
    user_wallet = wallet_from_seed("user", read_seed_file(Path(args.user_seed_file)))
    authority_wallet = create_protocol_wallet("task_authority")
    allocation_wallet = create_protocol_wallet("allocation_reward")
    wallets = [user_wallet, authority_wallet, allocation_wallet]

    tasknode_identity = tasknode_identity_from_seed(config.faucet_seed)
    verification_service_identity = generate_identity("verification_reward_service", allocation_wallet.address)
    recipients: list[X25519Identity | str] = [
        user_wallet.encryption,
        authority_wallet.encryption,
        allocation_wallet.encryption,
        tasknode_identity,
        verification_service_identity,
    ]
    if config.tasknode_encryption_pubkey and config.tasknode_encryption_pubkey != tasknode_identity.public_key_b64:
        recipients.append(config.tasknode_encryption_pubkey)

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print(f"Fixture: {args.chat_title} / {fixture.request_id}")
    print(f"User wallet: {user_wallet.address}")
    print(f"Authority wallet: {authority_wallet.address}")
    print(f"Allocation wallet: {allocation_wallet.address}")

    funding = fund_wallets(pftl, config.faucet_seed, wallets, target_pft=args.fund_pft)
    key_publications = publish_message_keys_safely(
        pftl,
        wallets,
        replace_existing=args.replace_message_key,
    )
    resolved_keys = resolved_encryption_keys(pftl, wallets)
    balances_before = {wallet.role: pftl.account_balance_drops(wallet.address) for wallet in wallets}

    ipfs = IpfsClient(config)
    context_doc = build_context_doc_payload(fixture, subject_wallet=user_wallet.address)
    context_upload = encrypted_upload(
        ipfs=ipfs,
        payload=context_doc,
        recipients=recipients,
        name=f"{run_id}-context-doc",
        content_kind="CONTEXT",
    )

    request_bundle = build_request_bundle_from_fixture(
        fixture,
        subject_wallet=user_wallet.address,
        allocation_wallet=allocation_wallet.address,
        authority_wallet=authority_wallet.address,
    )
    request_bundle["context"]["primary_context_doc"]["cid"] = context_upload["cid"]
    request_bundle["context"]["primary_context_doc"]["digest"] = "sha256:" + context_upload["payload_digest"]
    request_upload = encrypted_upload(
        ipfs=ipfs,
        payload=request_bundle,
        recipients=recipients,
        name=f"{run_id}-request-bundle",
        content_kind="TASK",
    )

    user_queue = WalletTxQueue(user_wallet.address)
    authority_queue = WalletTxQueue(authority_wallet.address)
    allocation_queue = WalletTxQueue(allocation_wallet.address)

    request_event = {
        "schema": "pf.task.request.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "request_id": request_bundle["request"]["request_id"],
        "event_id": event_id("evt", request_bundle),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
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
        name=f"{run_id}-task-request-event",
        content_kind="TASK",
    )
    request_tx = submit_pointer_payment(
        client=pftl,
        queue=user_queue,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=request_event_upload["cid"], kind="TASK", schema=1),
        idem=sha256_hex(request_event),
    )

    task_input = project_taskgen_input(
        request_bundle,
        bundle_cid=request_upload["cid"],
        bundle_digest="sha256:" + request_upload["payload_digest"],
    )
    taskgen = generate_task(
        config,
        task_input,
        benchmark_high_reasoning=args.benchmark_high_reasoning,
    )

    offer_core = {
        "request_id": request_bundle["request"]["request_id"],
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "taskgen_output": taskgen.output,
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
        "title": taskgen.output["title"],
        "description": taskgen.output["description"],
        "task_kind": taskgen.output["task_kind"],
        "submission_requirement": taskgen.output["submission_requirement"],
        "verification_policy": taskgen.output["verification_policy"],
        "reward_offer": taskgen.output["reward_offer"],
        "proposed_at": now_iso(),
        "accept_by": taskgen.output["deadline"]["accept_by"],
        "deadline_at": taskgen.output["deadline"].get("deadline_at"),
        "context_refs": [{
            "context_id": context_doc["context_id"],
            "cid": context_upload["cid"],
            "digest": "sha256:" + context_upload["payload_digest"],
        }],
        "generation": {
            **taskgen.metadata,
            "request_bundle_cid": request_upload["cid"],
            "request_bundle_digest": "sha256:" + request_upload["payload_digest"],
        },
    }
    offer_upload = encrypted_upload(
        ipfs=ipfs,
        payload=task_offer,
        recipients=recipients,
        name=f"{run_id}-task-offer",
        content_kind="TASK",
        task_id=task_id,
    )
    offer_tx = submit_pointer_payment(
        client=pftl,
        queue=authority_queue,
        wallet=authority_wallet.wallet,
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
        "transition": "accepted",
        "status_after": "accepted",
        "accepted_at": now_iso(),
    }
    accepted_upload = encrypted_upload(
        ipfs=ipfs,
        payload=accepted_event,
        recipients=recipients,
        name=f"{run_id}-task-accepted",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    accepted_tx = submit_pointer_payment(
        client=pftl,
        queue=user_queue,
        wallet=user_wallet.wallet,
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
            "Initial submission for the app-data replay: the task request was generated from the "
            "task_sample chat intent, current context document, memory, and recent chat window."
        ),
        "created_at": now_iso(),
    }
    initial_evidence_upload = encrypted_upload(
        ipfs=ipfs,
        payload=initial_evidence,
        recipients=recipients,
        name=f"{run_id}-initial-evidence",
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
        "phase": "initial_submission",
        "artifact_cid": initial_evidence_upload["cid"],
        "artifact_type": "text",
        "artifact_digest": "sha256:" + initial_evidence_upload["payload_digest"],
        "summary": "Initial app-data replay evidence submitted.",
        "submitted_at": now_iso(),
    }
    initial_submission_upload = encrypted_upload(
        ipfs=ipfs,
        payload=initial_submission,
        recipients=recipients,
        name=f"{run_id}-initial-submission",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    submission_tx = submit_pointer_payment(
        client=pftl,
        queue=user_queue,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=initial_submission_upload["cid"], kind="TASK_SUBMISSION", schema=1, task_id=task_id),
        idem=sha256_hex(initial_submission),
    )

    verification_result = generate_verification_request(
        config=config,
        task_offer=task_offer,
        initial_submission=initial_submission,
        processed_evidence={
            "schema": "pf.task.processed_evidence.v1",
            "artifact_count": 1,
            "artifacts": [
                {
                    "artifact_type": initial_submission["artifact_type"],
                    "source_type": "encrypted_ipfs_pointer",
                    "status": "submitted",
                    "excerpt": initial_evidence["response"],
                }
            ],
        },
        context=request_bundle.get("context") or {},
    )
    verification_request = verification_result.output
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
        "transition": "verification_requested",
        "status_after": "verification_requested",
        "verification_request": verification_request,
        "generation": verification_result.metadata,
    }
    verification_request_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_event,
        recipients=recipients,
        name=f"{run_id}-verification-request",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    verification_request_tx = submit_pointer_payment(
        client=pftl,
        queue=authority_queue,
        wallet=authority_wallet.wallet,
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
            "Verification response for app-data replay. The run created request, offer, accept, "
            "initial submission, verification request, verification response, and reward pointers."
        ),
        "created_at": now_iso(),
    }
    verification_evidence_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_evidence,
        recipients=recipients,
        name=f"{run_id}-verification-evidence",
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
        "phase": "verification_response",
        "verification_response_cid": verification_evidence_upload["cid"],
        "verification_response_digest": "sha256:" + verification_evidence_upload["payload_digest"],
        "response_text": "Confirmed app-data replay pointer set.",
        "artifact_type": "text",
        "responded_at": now_iso(),
    }
    verification_response_upload = encrypted_upload(
        ipfs=ipfs,
        payload=verification_response,
        recipients=recipients,
        name=f"{run_id}-verification-response",
        content_kind="TASK_SUBMISSION",
        task_id=task_id,
    )
    verification_response_tx = submit_pointer_payment(
        client=pftl,
        queue=user_queue,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        pointer=Pointer(cid=verification_response_upload["cid"], kind="TASK_SUBMISSION", schema=1, task_id=task_id),
        idem=sha256_hex(verification_response),
    )

    reward_pft = float((task_offer.get("reward_offer") or {}).get("amount_estimate_pft") or args.reward_pft)
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
        "allocation_wallet": allocation_wallet.address,
        "recipient_wallet_address": user_wallet.address,
        "reward_pft": f"{reward_pft:.2f}",
        "reward_tier": "app_data_replay",
        "reward_score": 1.0,
        "reward_summary": "App-data Task Node replay completed and rewarded.",
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
        name=f"{run_id}-reward",
        content_kind="REWARD",
        task_id=task_id,
    )
    reward_tx = submit_pointer_payment(
        client=pftl,
        queue=allocation_queue,
        wallet=allocation_wallet.wallet,
        destination=user_wallet.address,
        pointer=Pointer(cid=reward_upload["cid"], kind="REWARD", schema=1, task_id=task_id),
        amount_drops=pft_to_drops(reward_pft),
        idem=sha256_hex(reward_payload),
    )

    balances_after = {wallet.role: pftl.account_balance_drops(wallet.address) for wallet in wallets}
    all_pointer_events = []
    for wallet in wallets:
        all_pointer_events.extend(pftl.pointer_events_for_wallet(wallet.address))
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
    relevant_events = [
        event for event in all_pointer_events
        if event.get("task_id") == task_id or event.get("cid") in set(cids.values())
    ]
    hydrated, projections = hydrate_and_reduce(relevant_events, ipfs, tasknode_identity)

    txs = {
        "request": request_tx,
        "offer": offer_tx,
        "accepted": accepted_tx,
        "submission": submission_tx,
        "verification_request": verification_request_tx,
        "verification_response": verification_response_tx,
        "reward": reward_tx,
    }
    public_receipt = {
        "run_id": run_id,
        "fixture": {
            "account_id": fixture.account_id,
            "conversation_id": fixture.conversation.get("id"),
            "conversation_title": fixture.conversation.get("title"),
            "request_id": fixture.request_id,
            "bundle_id": request_bundle["bundle_id"],
            "request_message_id": fixture.request_message.get("id"),
            "request_detail_excerpt": request_bundle["request"]["user_detail_text"][:240],
            "recent_message_count": len(fixture.recent_messages),
            "recent_memory_count": len(fixture.recent_memory),
            "deep_memory_count": len(fixture.deep_memory),
        },
        "network": {
            "name": config.network_name,
            "rpc_url": config.rpc_url,
            "archive_wss_url": config.archive_wss_url,
            "note": "PFTL is its own Post Fiat L1; xrpl-py is used only as the PFTL wire library.",
        },
        "task_id": task_id,
        "wallets": public_wallets(wallets),
        "funding": funding,
        "message_keys": key_publications,
        "resolved_encryption_keys": resolved_keys,
        "balances_before_pft": {role: drops_to_pft(value) for role, value in balances_before.items()},
        "balances_after_pft": {role: drops_to_pft(value) for role, value in balances_after.items()},
        "cids": cids,
        "txs": txs,
        "taskgen": taskgen.metadata,
        "generated_task": taskgen.output,
        "submission_summaries": [
            {
                "phase": "initial_submission",
                "artifact_type": initial_evidence["artifact_type"],
                "response": initial_evidence["response"],
                "artifact_cid": initial_evidence_upload["cid"],
                "pointer_cid": initial_submission_upload["cid"],
                "tx_hash": submission_tx["tx_hash"],
            },
            {
                "phase": "verification_response",
                "artifact_type": verification_evidence["artifact_type"],
                "response": verification_evidence["response"],
                "artifact_cid": verification_evidence_upload["cid"],
                "pointer_cid": verification_response_upload["cid"],
                "tx_hash": verification_response_tx["tx_hash"],
            },
        ],
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
        "projection": {task: projection.to_dict() for task, projection in projections.items()},
        "queue_state": {
            "user": queue_entries_public(user_queue),
            "authority": queue_entries_public(authority_queue),
            "allocation": queue_entries_public(allocation_queue),
        },
    }
    private_receipt = {
        "run_id": run_id,
        "wallets": private_wallets([authority_wallet, allocation_wallet]),
        "user_wallet": {
            "role": user_wallet.role,
            "address": user_wallet.address,
            "public_key": user_wallet.wallet.public_key,
            "x25519": user_wallet.encryption.public_descriptor(),
            "seed_file": str(args.user_seed_file),
        },
        "tasknode_identity": tasknode_identity.private_descriptor(),
        "verification_service_identity": verification_service_identity.private_descriptor(),
    }
    write_json(run_dir / "receipt_public.json", public_receipt)
    write_json(run_dir / "receipt_private.json", private_receipt)
    write_markdown_receipt(run_dir / "app_request_replay.md", public_receipt)

    projection = public_receipt["projection"].get(task_id, {})
    print("\nApp request lifecycle complete")
    print(f"  run_id: {run_id}")
    print(f"  task_id: {task_id}")
    print(f"  request_tx: {request_tx['tx_hash']}")
    print(f"  reward_tx: {reward_tx['tx_hash']}")
    print(f"  reward_cid: {short(reward_upload['cid'])}")
    print(f"  replay_status: {projection.get('status')}")
    print(f"  pointer_events_found: {public_receipt['pointer_events_found']}")
    print(f"  public_receipt: {run_dir / 'receipt_public.json'}")
    print(f"  markdown_receipt: {run_dir / 'app_request_replay.md'}")
    return public_receipt


def write_markdown_receipt(path: Path, receipt: dict[str, Any]) -> None:
    fixture = receipt["fixture"]
    projection = receipt["projection"].get(receipt["task_id"], {})
    task = receipt.get("generated_task") or projection
    reward_offer = (
        ((task.get("reward_offer") or {}).get("amount_estimate_pft") if isinstance(task.get("reward_offer"), dict) else None)
        or projection.get("reward_offer_pft")
        or ""
    )
    submission_requirement = task.get("submission_requirement") or {}
    lines = [
        "# App Task Request PFTL Replay",
        "",
        f"- Run id: `{receipt['run_id']}`",
        f"- Chat fixture: `{fixture['conversation_title']}` / `{fixture['conversation_id']}`",
        f"- Request id: `{fixture['request_id']}`",
        f"- Bundle id: `{fixture['bundle_id']}`",
        f"- Task id: `{receipt['task_id']}`",
        f"- Replay status: `{projection.get('status')}`",
        f"- Pointer events found: `{receipt['pointer_events_found']}`",
        "",
        "## Request Detail",
        "",
        fixture["request_detail_excerpt"] or "",
        "",
        "## Generated Task",
        "",
        f"- Title: {task.get('title') or ''}",
        f"- Task kind: {task.get('task_kind') or projection.get('task_kind') or ''}",
        f"- Reward offer: {reward_offer} PFT",
        f"- Submission type: {submission_requirement.get('type') or ''}",
        "",
        task.get("description") or projection.get("description") or "",
        "",
        "## Submission Requirement",
        "",
        submission_requirement.get("description") or submission_requirement.get("criteria") or "",
        "",
        "## Verification Policy",
        "",
        json.dumps(task.get("verification_policy") or {}, indent=2, sort_keys=True),
        "",
        "## Submitted Evidence",
        "",
    ]
    for item in receipt.get("submission_summaries") or []:
        lines.extend([
            f"### {item.get('phase')}",
            "",
            item.get("response") or "",
            "",
            f"- Artifact CID: `{item.get('artifact_cid')}`",
            f"- Pointer CID: `{item.get('pointer_cid')}`",
            f"- Transaction: `{item.get('tx_hash')}`",
            "",
        ])
    lines.extend([
        "",
        "## Transactions",
        "",
    ])
    tx_order = [
        "request",
        "offer",
        "accepted",
        "submission",
        "verification_request",
        "verification_response",
        "reward",
    ]
    for key in tx_order:
        tx = receipt["txs"].get(key)
        if tx:
            lines.append(f"- {key}: `{tx['tx_hash']}`")
    lines.extend(["", "## IPFS CIDs", ""])
    cid_order = [
        "context_doc",
        "request_bundle",
        "request_event",
        "offer",
        "accepted",
        "initial_evidence",
        "initial_submission",
        "verification_request",
        "verification_evidence",
        "verification_response",
        "reward",
    ]
    for key in cid_order:
        cid = receipt["cids"].get(key)
        if cid:
            lines.append(f"- {key}: `{cid}`")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a live PFTL lifecycle from a Task Node app task request intent."
    )
    parser.add_argument("--chat-title", default="task_sample")
    parser.add_argument("--request-id", default=None)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--user-seed-file", default=str(DEFAULT_USER_SEED_FILE))
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--fund-pft", type=float, default=25.0)
    parser.add_argument("--reward-pft", type=float, default=3.2)
    parser.add_argument("--replace-message-key", action="store_true")
    parser.add_argument("--benchmark-high-reasoning", action="store_true")
    return parser.parse_args()


def main() -> None:
    run_app_request_lifecycle(parse_args())


if __name__ == "__main__":
    main()
