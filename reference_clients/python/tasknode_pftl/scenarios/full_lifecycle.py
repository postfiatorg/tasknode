from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from xrpl.wallet import Wallet

from tasknode_pftl.codec import canonical_json, now_iso, sha256_hex, short
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.encryption import (
    X25519Identity,
    encrypt_json_bytes,
    generate_identity,
    tasknode_identity_from_seed,
    x25519_public_key_b64_from_message_key,
)
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, drops_to_pft, pft_to_drops
from tasknode_pftl.pointers import Pointer
from tasknode_pftl.reducer import hydrate_and_reduce
from tasknode_pftl.taskgen import (
    build_request_bundle,
    build_verification_request,
    generate_task,
    project_taskgen_input,
)
from tasknode_pftl.tx_queue import WalletTxQueue
from tasknode_pftl.wallets import ProtocolWallet, create_protocol_wallet, fund_wallets, publish_wallet_message_keys


ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = ROOT / "runs"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


def event_id(prefix: str, payload: dict[str, Any]) -> str:
    return f"{prefix}_{sha256_hex(payload)[:24]}"


def make_task_id(config: PftlConfig, authority_address: str, bundle_cid: str, offer_core: dict[str, Any]) -> str:
    digest = sha256_hex({
        "domain": "tasknode.task.v1",
        "chain": config.network_name,
        "authority_wallet": authority_address,
        "request_bundle_cid": bundle_cid,
        "offer_core_digest": sha256_hex(offer_core),
    })
    return f"task_{digest[:32]}"


def encrypted_upload(
    *,
    ipfs: IpfsClient,
    payload: dict[str, Any],
    recipients: list[X25519Identity | str],
    name: str,
    content_kind: str,
    task_id: str | None = None,
) -> dict[str, Any]:
    plaintext = canonical_json(payload).encode("utf-8")
    encrypted = encrypt_json_bytes(plaintext, recipients)
    pin = ipfs.upload_json(
        encrypted,
        name=name,
        keyvalues={
            "content_kind": content_kind,
            **({"task_id": task_id} if task_id else {}),
        },
    )
    return {
        "cid": pin["cid"],
        "sha256": pin["sha256"],
        "size_bytes": pin["size_bytes"],
        "payload_digest": sha256_hex(payload),
        "encrypted": encrypted,
    }


def submit_pointer_payment(
    *,
    client: PftlClient,
    queue: WalletTxQueue,
    wallet: Wallet,
    destination: str,
    pointer: Pointer,
    amount_drops: str = "1",
    idem: str,
) -> dict[str, Any]:
    tx = queue.run(
        idem,
        lambda: client.submit_payment(wallet, destination, amount_drops, pointer=pointer),
    )
    return {
        "tx_hash": tx.tx_hash,
        "result": tx.result,
        "ledger_index": tx.ledger_index,
        "sender": tx.sender,
        "destination": tx.destination,
        "amount_drops": tx.amount_drops,
    }


def public_wallets(wallets: list[ProtocolWallet]) -> list[dict[str, Any]]:
    return [wallet.public_seedless for wallet in wallets]


def private_wallets(wallets: list[ProtocolWallet]) -> list[dict[str, Any]]:
    return [wallet.private_descriptor for wallet in wallets]


def queue_entries_public(queue: WalletTxQueue) -> list[dict[str, Any]]:
    rows = []
    for entry in queue.entries:
        result = entry.result
        rows.append({
            "idempotency_key": entry.idempotency_key,
            "status": entry.status,
            "error": entry.error,
            "result": result.__dict__ if hasattr(result, "__dict__") else result,
        })
    return rows


def run_full_lifecycle(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_live()

    run_id = args.run_id or f"run_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    pftl = PftlClient(config.rpc_url)
    ipfs = IpfsClient(config)

    user_wallet = create_protocol_wallet("user")
    authority_wallet = create_protocol_wallet("task_authority")
    allocation_wallet = create_protocol_wallet("allocation_reward")
    wallets = [user_wallet, authority_wallet, allocation_wallet]

    tasknode_identity = tasknode_identity_from_seed(config.faucet_seed)
    verification_service_identity = generate_identity("verification_reward_service", allocation_wallet.address)
    recipients = [
        user_wallet.encryption,
        tasknode_identity,
        verification_service_identity,
    ]
    if config.tasknode_encryption_pubkey and config.tasknode_encryption_pubkey != tasknode_identity.public_key_b64:
        recipients.append(config.tasknode_encryption_pubkey)

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print("Created wallets:")
    for wallet in wallets:
        print(f"  {wallet.role}: {wallet.address}")

    funding = fund_wallets(
        pftl,
        config.faucet_seed,
        wallets,
        target_pft=args.fund_pft,
    )
    print("Funding complete:")
    for item in funding:
        print(f"  {item['address']}: {drops_to_pft(item['balance_drops']):,.6f} PFT")

    key_publications = publish_wallet_message_keys(pftl, wallets)
    print("MessageKey publication complete:")
    for item in key_publications:
        state = "already set" if item.get("already_published") else "published"
        print(f"  {item['role']}: {state} {short(item['message_key'])}")
    resolved_encryption_keys = {
        wallet.role: x25519_public_key_b64_from_message_key(pftl.account_message_key(wallet.address) or "")
        for wallet in wallets
    }
    for wallet in wallets:
        if resolved_encryption_keys[wallet.role] != wallet.encryption.public_key_b64:
            raise RuntimeError(f"Resolved MessageKey does not match local encryption identity for {wallet.role}")

    balances_before = {wallet.role: pftl.account_balance_drops(wallet.address) for wallet in wallets}

    context_doc = {
        "schema": "pf.context.doc.v1",
        "context_id": f"ctx_{sha256_hex(run_id)[:24]}",
        "created_at": now_iso(),
        "subject_wallet": user_wallet.address,
        "content": (
            "Build and validate a PFTL-native Task Node lifecycle. The canonical record should be "
            "pf.ptr/v4 pointer events with encrypted IPFS payloads. The database should be a cache only."
        ),
    }
    context_upload = encrypted_upload(
        ipfs=ipfs,
        payload=context_doc,
        recipients=recipients,
        name=f"{run_id}-context-doc",
        content_kind="CONTEXT",
    )

    request_bundle = build_request_bundle(
        subject_wallet=user_wallet.address,
        allocation_wallet=allocation_wallet.address,
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
        allow_fallback=args.allow_taskgen_fallback,
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
        "context_refs": [
            {
                "context_id": context_doc["context_id"],
                "cid": context_upload["cid"],
                "digest": "sha256:" + context_upload["payload_digest"],
            }
        ],
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
        "response": "The PFTL-native lifecycle harness was run through request, offer, accept, and initial submission.",
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
        "summary": "Initial lifecycle evidence submitted.",
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
        "transition": "verification_requested",
        "status_after": "verification_requested",
        "verification_request": verification_request,
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
            "Confirmed. The run produced PFTL pointer transactions for request, offer, acceptance, "
            "initial submission, verification request, verification response, and reward."
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
        "response_text": "Confirmed lifecycle run and pointer set.",
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
        "reward_tier": "simulation",
        "reward_score": 1.0,
        "reward_summary": "Reference lifecycle simulation completed and replayed.",
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
    relevant_pointer_events = [
        event for event in all_pointer_events
        if event.get("task_id") == task_id or event.get("cid") in {
            request_event_upload["cid"],
            offer_upload["cid"],
            accepted_upload["cid"],
            initial_submission_upload["cid"],
            verification_request_upload["cid"],
            verification_response_upload["cid"],
            reward_upload["cid"],
        }
    ]
    hydrated, projections = hydrate_and_reduce(relevant_pointer_events, ipfs, tasknode_identity)

    txs = {
        "request": request_tx,
        "offer": offer_tx,
        "accepted": accepted_tx,
        "submission": submission_tx,
        "verification_request": verification_request_tx,
        "verification_response": verification_response_tx,
        "reward": reward_tx,
    }
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

    public_receipt = {
        "run_id": run_id,
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
        "resolved_encryption_keys": resolved_encryption_keys,
        "balances_before_pft": {role: drops_to_pft(value) for role, value in balances_before.items()},
        "balances_after_pft": {role: drops_to_pft(value) for role, value in balances_after.items()},
        "cids": cids,
        "txs": txs,
        "taskgen": taskgen.metadata,
        "pointer_events_found": len(relevant_pointer_events),
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
        "wallets": private_wallets(wallets),
        "tasknode_identity": tasknode_identity.private_descriptor(),
        "verification_service_identity": verification_service_identity.private_descriptor(),
    }
    write_json(run_dir / "receipt_public.json", public_receipt)
    write_json(run_dir / "receipt_private.json", private_receipt)

    print("\nLifecycle complete")
    print(f"  run_id: {run_id}")
    print(f"  task_id: {task_id}")
    print(f"  reward_tx: {reward_tx['tx_hash']}")
    print(f"  reward_cid: {short(reward_upload['cid'])}")
    projection = public_receipt["projection"].get(task_id, {})
    print(f"  replay_status: {projection.get('status')}")
    print(f"  pointer_events_found: {public_receipt['pointer_events_found']}")
    print(f"  public_receipt: {run_dir / 'receipt_public.json'}")
    print(f"  private_receipt: {run_dir / 'receipt_private.json'}")
    return public_receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a live PFTL-native Task Node lifecycle simulation.")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--fund-pft", type=float, default=25.0)
    parser.add_argument("--reward-pft", type=float, default=3.2)
    parser.add_argument("--benchmark-high-reasoning", action="store_true")
    parser.add_argument(
        "--allow-taskgen-fallback",
        action="store_true",
        help="Permit deterministic local task generation if OpenAI is missing or fails. Off by default.",
    )
    return parser.parse_args()


def main() -> None:
    run_full_lifecycle(parse_args())


if __name__ == "__main__":
    main()
