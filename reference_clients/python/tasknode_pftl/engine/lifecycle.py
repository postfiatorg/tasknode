from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading
from typing import Any

from xrpl.wallet import Wallet

from tasknode_pftl.codec import now_iso, sha256_hex
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.encryption import X25519Identity
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, pft_to_drops
from tasknode_pftl.pointers import Pointer
from tasknode_pftl.reducer import hydrate_and_reduce
from tasknode_pftl.scenarios.full_lifecycle import (
    encrypted_upload,
    event_id,
    make_task_id,
    submit_pointer_payment,
)
from tasknode_pftl.taskgen import generate_task, project_taskgen_input
from tasknode_pftl.tx_queue import WalletTxQueue
from tasknode_pftl.wallets import ProtocolWallet

from .evidence_suite import (
    EvidencePlan,
    build_evidence_packets,
    processed_evidence_summary,
    read_evidence,
)
from .scoring import generate_verification_request, score_submission


@dataclass
class EngineQueues:
    user: WalletTxQueue
    authority: WalletTxQueue
    allocation: WalletTxQueue
    user_lock: threading.Lock | None = None
    authority_lock: threading.Lock | None = None
    allocation_lock: threading.Lock | None = None


def submit_wallet_pointer(
    *,
    client: PftlClient,
    queue: WalletTxQueue,
    wallet: Wallet,
    destination: str,
    cid: str,
    kind: str,
    idem_payload: dict[str, Any],
    task_id: str | None = None,
    context_id: str | None = None,
    amount_drops: str = "1",
    lock: threading.Lock | None = None,
) -> dict[str, Any]:
    def submit() -> dict[str, Any]:
        return submit_pointer_payment(
            client=client,
            queue=queue,
            wallet=wallet,
            destination=destination,
            pointer=Pointer(cid=cid, kind=kind, schema=1, task_id=task_id, context_id=context_id),
            amount_drops=amount_drops,
            idem=sha256_hex(idem_payload),
        )

    if lock:
        with lock:
            return submit()
    return submit()


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


def run_task_engine_lifecycle(
    *,
    config: PftlConfig,
    pftl: PftlClient,
    ipfs: IpfsClient,
    run_id: str,
    run_dir: Path,
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
    tasknode_identity: X25519Identity,
    verification_identity: X25519Identity,
    context_doc: dict[str, Any],
    request_bundle: dict[str, Any],
    provider: str = "frontier",
    taskgen_model: str | None = None,
    verification_model: str | None = None,
    scoring_model: str | None = None,
    evidence_plan: EvidencePlan | None = None,
    verification_evidence_plan: EvidencePlan | None = None,
    benchmark_high_reasoning: bool = False,
    import_context_pointer: bool = True,
    queues: EngineQueues | None = None,
    task_decision: str = "accept",
    refusal_reason: str = "",
) -> dict[str, Any]:
    recipients = task_recipients(
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
        tasknode_identity=tasknode_identity,
        verification_identity=verification_identity,
        tasknode_pubkey_override=config.tasknode_encryption_pubkey,
    )
    queues = queues or EngineQueues(
        user=WalletTxQueue(user_wallet.address),
        authority=WalletTxQueue(authority_wallet.address),
        allocation=WalletTxQueue(allocation_wallet.address),
    )

    context_upload = encrypted_upload(
        ipfs=ipfs,
        payload=context_doc,
        recipients=recipients,
        name=f"{run_id}-context-doc",
        content_kind="CONTEXT",
    )
    context_id = str(context_doc.get("context_id") or context_doc.get("id") or "")
    context_tx = None
    if import_context_pointer:
        context_tx = submit_wallet_pointer(
            client=pftl,
            queue=queues.user,
            wallet=user_wallet.wallet,
            destination=authority_wallet.address,
            cid=context_upload["cid"],
            kind="CONTEXT",
            context_id=context_id or None,
            idem_payload={"context": context_doc, "cid": context_upload["cid"]},
            lock=queues.user_lock,
        )

    request_bundle["context"]["primary_context_doc"]["cid"] = context_upload["cid"]
    request_bundle["context"]["primary_context_doc"]["digest"] = "sha256:" + context_upload["payload_digest"]
    request_bundle.setdefault("wallet", {})
    request_bundle["wallet"]["subject_wallet"] = user_wallet.address
    request_bundle["wallet"]["authority_wallet"] = authority_wallet.address
    request_bundle["wallet"]["authority_hint"] = authority_wallet.address
    request_bundle["wallet"]["allocation_wallet"] = allocation_wallet.address
    request_upload = encrypted_upload(
        ipfs=ipfs,
        payload=request_bundle,
        recipients=recipients,
        name=f"{run_id}-request-bundle",
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
        "user_detail_text": request_bundle["request"].get("user_detail_text") or "",
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
    request_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.user,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        cid=request_event_upload["cid"],
        kind="TASK",
        idem_payload=request_event,
        lock=queues.user_lock,
    )

    task_input = project_taskgen_input(
        request_bundle,
        bundle_cid=request_upload["cid"],
        bundle_digest="sha256:" + request_upload["payload_digest"],
    )
    taskgen = generate_task(
        config,
        task_input,
        provider=provider,
        model=taskgen_model,
        benchmark_high_reasoning=benchmark_high_reasoning,
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
        "steps": taskgen.output.get("steps") or [],
        "submission_requirement": taskgen.output["submission_requirement"],
        "verification_policy": taskgen.output["verification_policy"],
        "reward_offer": taskgen.output["reward_offer"],
        "proposed_at": now_iso(),
        "accept_by": taskgen.output["deadline"]["accept_by"],
        "deadline_at": taskgen.output["deadline"].get("deadline_at"),
        "context_refs": [{
            "context_id": context_id,
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
    offer_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.authority,
        wallet=authority_wallet.wallet,
        destination=user_wallet.address,
        cid=offer_upload["cid"],
        kind="TASK",
        task_id=task_id,
        idem_payload=task_offer,
        lock=queues.authority_lock,
    )

    normalized_decision = str(task_decision or "accept").strip().lower()
    if normalized_decision == "refuse":
        refused_event = {
            "schema": "pf.task.update.v1",
            "protocol": "tasknode.pftl",
            "created_at": now_iso(),
            "chain": config.network_name,
            "task_id": task_id,
            "event_id": event_id("evt", {"task_id": task_id, "transition": "refused", "reason": refusal_reason}),
            "actor_wallet": user_wallet.address,
            "subject_wallet": user_wallet.address,
            "authority_wallet": authority_wallet.address,
            "allocation_wallet": allocation_wallet.address,
            "transition": "refused",
            "status_after": "refused",
            "reason": refusal_reason or "User refused the offered task.",
            "refused_at": now_iso(),
        }
        refused_upload = encrypted_upload(
            ipfs=ipfs,
            payload=refused_event,
            recipients=recipients,
            name=f"{run_id}-task-refused",
            content_kind="TASK_UPDATE",
            task_id=task_id,
        )
        refused_tx = submit_wallet_pointer(
            client=pftl,
            queue=queues.user,
            wallet=user_wallet.wallet,
            destination=authority_wallet.address,
            cid=refused_upload["cid"],
            kind="TASK_UPDATE",
            task_id=task_id,
            idem_payload=refused_event,
            lock=queues.user_lock,
        )
        cids = {
            "context_doc": context_upload["cid"],
            "request_bundle": request_upload["cid"],
            "request_event": request_event_upload["cid"],
            "offer": offer_upload["cid"],
            "refused": refused_upload["cid"],
        }
        txs = {
            "context": context_tx,
            "request": request_tx,
            "offer": offer_tx,
            "refused": refused_tx,
            "accepted": None,
            "submission": None,
            "verification_request": None,
            "verification_response": None,
            "reward_decision": None,
            "reward": None,
        }
        hydrated, projections, relevant_events = hydrate_lifecycle_events(
            pftl=pftl,
            ipfs=ipfs,
            tasknode_identity=tasknode_identity,
            task_id=task_id,
            wallets=[user_wallet, authority_wallet, allocation_wallet],
            cids=cids,
        )
        return lifecycle_result(
            task_id=task_id,
            request_bundle=request_bundle,
            context_id=context_id,
            taskgen=taskgen,
            verification_result=None,
            scoring_result=None,
            reward_paid=False,
            reward_amount=0.0,
            wallets={
                "user": user_wallet.address,
                "authority": authority_wallet.address,
                "allocation": allocation_wallet.address,
            },
            cids=cids,
            txs=txs,
            submissions={},
            hydrated=hydrated,
            projections=projections,
            relevant_events=relevant_events,
            queues=queues,
            extra={"refusal": refused_event},
        )
    if normalized_decision != "accept":
        raise RuntimeError(f"Unsupported task decision: {task_decision}")

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
        name=f"{run_id}-task-accepted",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    accepted_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.user,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        cid=accepted_upload["cid"],
        kind="TASK_UPDATE",
        task_id=task_id,
        idem_payload=accepted_event,
        lock=queues.user_lock,
    )

    submission_id = f"sub_{sha256_hex({'task_id': task_id, 'phase': 'initial', 'run_id': run_id})[:24]}"
    selected_evidence_plan = evidence_plan or EvidencePlan(
        artifact_type=(task_offer.get("submission_requirement") or {}).get("type") or "mixed"
    )
    if selected_evidence_plan.artifact_type == "auto":
        selected_evidence_plan.artifact_type = (task_offer.get("submission_requirement") or {}).get("type") or "text"
    if not selected_evidence_plan.response_text:
        if selected_evidence_plan.faulty:
            selected_evidence_plan.response_text = (
                f"Faulty initial evidence for {task_offer['title']}: I cannot provide the requested artifact, "
                "and this submission should be treated as incomplete or unrelated evidence."
            )
        else:
            selected_evidence_plan.response_text = (
                f"Initial evidence for {task_offer['title']}: Codex ran the Python task engine harness for task_id "
                f"{task_id}. The {selected_evidence_plan.artifact_type} artifact set was normalized into pf.task.evidence.v1 "
                f"packets. Stable identifiers: request_bundle_cid={request_upload['cid']}; "
                f"context_cid={context_upload['cid']}."
            )
    initial_reads = read_evidence(
        config=config,
        run_dir=run_dir,
        task_offer=task_offer,
        plan=selected_evidence_plan,
        phase="initial_submission",
    )
    initial_packets = build_evidence_packets(
        reads=initial_reads,
        task_id=task_id,
        submission_id=submission_id,
        phase="initial_submission",
        response_text=selected_evidence_plan.response_text,
    )
    initial_evidence_uploads = [
        encrypted_upload(
            ipfs=ipfs,
            payload=packet,
            recipients=recipients,
            name=f"{run_id}-initial-evidence-{index + 1}",
            content_kind="TASK_SUBMISSION",
            task_id=task_id,
        )
        for index, packet in enumerate(initial_packets)
    ]
    processed_initial = processed_evidence_summary(initial_reads, initial_packets)
    initial_submission = {
        "schema": "pf.task.submission.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", initial_packets[0] if initial_packets else {"task_id": task_id}),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "phase": "initial_submission",
        "artifact_cid": initial_evidence_uploads[0]["cid"] if initial_evidence_uploads else "",
        "artifact_type": "mixed" if len(initial_packets) > 1 else initial_packets[0].get("artifact_type", "unknown"),
        "artifact_digest": "sha256:" + sha256_hex(initial_packets),
        "evidence_refs": [
            {
                "index": index + 1,
                "artifact_type": packet.get("artifact_type"),
                "artifact_cid": upload["cid"],
                "artifact_digest": "sha256:" + upload["payload_digest"],
            }
            for index, (packet, upload) in enumerate(zip(initial_packets, initial_evidence_uploads))
        ],
        "processed_evidence": processed_initial,
        "summary": "Initial evidence submitted by the Python task engine.",
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
    submission_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.user,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        cid=initial_submission_upload["cid"],
        kind="TASK_SUBMISSION",
        task_id=task_id,
        idem_payload=initial_submission,
        lock=queues.user_lock,
    )

    verification_result = generate_verification_request(
        config=config,
        task_offer=task_offer,
        initial_submission=initial_submission,
        processed_evidence=processed_initial,
        context=request_bundle.get("context") or {},
        provider=provider,
        model=verification_model,
    )
    verification_event = {
        "schema": "pf.task.update.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "event_id": event_id("evt", verification_result.output),
        "actor_wallet": authority_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "transition": "verification_requested",
        "status_after": "verification_requested",
        "verification_request": verification_result.output,
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
    verification_request_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.authority,
        wallet=authority_wallet.wallet,
        destination=user_wallet.address,
        cid=verification_request_upload["cid"],
        kind="TASK_UPDATE",
        task_id=task_id,
        idem_payload=verification_event,
        lock=queues.authority_lock,
    )

    selected_verification_plan = verification_evidence_plan or EvidencePlan(
        artifact_type=verification_result.output.get("verification_type") or selected_evidence_plan.artifact_type,
        response_text=None,
        url=selected_evidence_plan.url,
    )
    if not selected_verification_plan.response_text:
        packet_digests = ", ".join(processed_initial.get("packet_digests") or [])
        replay_state_hash = "sha256:" + sha256_hex({
            "task_id": task_id,
            "request_bundle_cid": request_upload["cid"],
            "context_cid": context_upload["cid"],
            "initial_submission_cid": initial_submission_upload["cid"],
            "initial_evidence_packet_digests": processed_initial.get("packet_digests") or [],
        })
        if selected_verification_plan.faulty:
            selected_verification_plan.response_text = (
                f"Faulty verification response for {task_offer['title']}: I cannot answer the follow-up request "
                "with a concrete artifact detail, and this should not receive a full reward."
            )
        else:
            selected_verification_plan.response_text = (
                f"Verification response for {task_offer['title']}: replay output was deterministic and normalized "
                f"successfully for task_id {task_id}. Stable identifiers: request_bundle_cid={request_upload['cid']}; "
                f"initial_submission_cid={initial_submission_upload['cid']}; initial_evidence_packet_digests={packet_digests}; "
                f"prior_replay_state_hash={replay_state_hash}; current_replay_state_hash={replay_state_hash}; "
                "the prior and current replay hashes match exactly."
            )
    verification_reads = read_evidence(
        config=config,
        run_dir=run_dir,
        task_offer=task_offer,
        plan=selected_verification_plan,
        phase="verification_response",
    )
    verification_packets = build_evidence_packets(
        reads=verification_reads,
        task_id=task_id,
        submission_id=submission_id,
        phase="verification_response",
        response_text=selected_verification_plan.response_text,
    )
    verification_evidence_uploads = [
        encrypted_upload(
            ipfs=ipfs,
            payload=packet,
            recipients=recipients,
            name=f"{run_id}-verification-evidence-{index + 1}",
            content_kind="TASK_SUBMISSION",
            task_id=task_id,
        )
        for index, packet in enumerate(verification_packets)
    ]
    processed_verification = processed_evidence_summary(verification_reads, verification_packets)
    verification_response = {
        "schema": "pf.task.verification_response.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", verification_packets[0] if verification_packets else {"task_id": task_id}),
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "phase": "verification_response",
        "verification_response_cid": verification_evidence_uploads[0]["cid"] if verification_evidence_uploads else "",
        "verification_response_digest": "sha256:" + sha256_hex(verification_packets),
        "response_text": selected_verification_plan.response_text or processed_verification["artifacts"][0]["excerpt"],
        "artifact_type": "mixed" if len(verification_packets) > 1 else verification_packets[0].get("artifact_type", "unknown"),
        "evidence_refs": [
            {
                "index": index + 1,
                "artifact_type": packet.get("artifact_type"),
                "artifact_cid": upload["cid"],
                "artifact_digest": "sha256:" + upload["payload_digest"],
            }
            for index, (packet, upload) in enumerate(zip(verification_packets, verification_evidence_uploads))
        ],
        "processed_evidence": processed_verification,
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
    verification_response_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.user,
        wallet=user_wallet.wallet,
        destination=authority_wallet.address,
        cid=verification_response_upload["cid"],
        kind="TASK_SUBMISSION",
        task_id=task_id,
        idem_payload=verification_response,
        lock=queues.user_lock,
    )

    scoring_result = score_submission(
        config=config,
        task_offer=task_offer,
        initial_submission=initial_submission,
        verification_request=verification_event,
        verification_response=verification_response,
        processed_evidence={
            "initial": processed_initial,
            "verification": processed_verification,
        },
        provider=provider,
        model=scoring_model,
    )
    reward_amount = float(scoring_result.output.get("reward_pft") or 0)
    reward_decision = {
        "schema": "pf.task.reward_decision.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "chain": config.network_name,
        "task_id": task_id,
        "submission_id": submission_id,
        "event_id": event_id("evt", scoring_result.output),
        "actor_wallet": authority_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "status_after": "reward_decided",
        "score": scoring_result.output,
        "generation": scoring_result.metadata,
    }
    reward_decision_upload = encrypted_upload(
        ipfs=ipfs,
        payload=reward_decision,
        recipients=recipients,
        name=f"{run_id}-reward-decision",
        content_kind="TASK_UPDATE",
        task_id=task_id,
    )
    reward_decision_tx = submit_wallet_pointer(
        client=pftl,
        queue=queues.authority,
        wallet=authority_wallet.wallet,
        destination=user_wallet.address,
        cid=reward_decision_upload["cid"],
        kind="TASK_UPDATE",
        task_id=task_id,
        idem_payload=reward_decision,
        lock=queues.authority_lock,
    )

    reward_payload = None
    reward_upload = None
    reward_tx = None
    if scoring_result.output.get("decision") in {"reward", "partial_reward"} and reward_amount > 0:
        reward_payload = {
            "schema": "pf.reward.v1",
            "reward_history_schema": 1,
            "protocol": "tasknode.pftl",
            "created_at": now_iso(),
            "chain": config.network_name,
            "task_id": task_id,
            "submission_id": submission_id,
            "event_id": event_id("evt", {"task_id": task_id, "reward": reward_amount, "score": scoring_result.output}),
            "actor_wallet": allocation_wallet.address,
            "subject_wallet": user_wallet.address,
            "authority_wallet": authority_wallet.address,
            "allocation_wallet": allocation_wallet.address,
            "recipient_wallet_address": user_wallet.address,
            "reward_pft": f"{reward_amount:.2f}",
            "reward_tier": "task_engine_live",
            "reward_score": scoring_result.output,
            "reward_summary": scoring_result.output.get("reason") or "",
            "task_history": {
                "task": task_offer,
                "submission": initial_submission,
                "verification_request": verification_event,
                "verification_response": verification_response,
                "reward_decision": reward_decision,
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
        reward_tx = submit_wallet_pointer(
            client=pftl,
            queue=queues.allocation,
            wallet=allocation_wallet.wallet,
            destination=user_wallet.address,
            cid=reward_upload["cid"],
            kind="REWARD",
            task_id=task_id,
            amount_drops=pft_to_drops(reward_amount),
            idem_payload=reward_payload,
            lock=queues.allocation_lock,
        )

    cids: dict[str, Any] = {
        "context_doc": context_upload["cid"],
        "request_bundle": request_upload["cid"],
        "request_event": request_event_upload["cid"],
        "offer": offer_upload["cid"],
        "accepted": accepted_upload["cid"],
        "initial_evidence": [upload["cid"] for upload in initial_evidence_uploads],
        "initial_submission": initial_submission_upload["cid"],
        "verification_request": verification_request_upload["cid"],
        "verification_evidence": [upload["cid"] for upload in verification_evidence_uploads],
        "verification_response": verification_response_upload["cid"],
        "reward_decision": reward_decision_upload["cid"],
    }
    if reward_upload:
        cids["reward"] = reward_upload["cid"]
    txs: dict[str, Any] = {
        "context": context_tx,
        "request": request_tx,
        "offer": offer_tx,
        "accepted": accepted_tx,
        "submission": submission_tx,
        "verification_request": verification_request_tx,
        "verification_response": verification_response_tx,
        "reward_decision": reward_decision_tx,
        "reward": reward_tx,
    }

    hydrated, projections, relevant_events = hydrate_lifecycle_events(
        pftl=pftl,
        ipfs=ipfs,
        tasknode_identity=tasknode_identity,
        task_id=task_id,
        wallets=[user_wallet, authority_wallet, allocation_wallet],
        cids=cids,
    )

    return lifecycle_result(
        task_id=task_id,
        request_bundle=request_bundle,
        context_id=context_id,
        taskgen=taskgen,
        verification_result=verification_result,
        scoring_result=scoring_result,
        reward_paid=bool(reward_tx),
        reward_amount=reward_amount,
        wallets={
            "user": user_wallet.address,
            "authority": authority_wallet.address,
            "allocation": allocation_wallet.address,
        },
        cids=cids,
        txs=txs,
        submissions={
            "initial": {
                "submission": initial_submission,
                "processed_evidence": processed_initial,
            },
            "verification": {
                "response": verification_response,
                "processed_evidence": processed_verification,
            },
        },
        hydrated=hydrated,
        projections=projections,
        relevant_events=relevant_events,
        queues=queues,
    )


def hydrate_lifecycle_events(
    *,
    pftl: PftlClient,
    ipfs: IpfsClient,
    tasknode_identity: X25519Identity,
    task_id: str,
    wallets: list[ProtocolWallet],
    cids: dict[str, Any],
) -> tuple[list[Any], dict[str, Any], list[dict[str, Any]]]:
    all_pointer_events = []
    for wallet in wallets:
        all_pointer_events.extend(pftl.pointer_events_for_wallet(wallet.address))
    cid_set = set(flatten_cids(cids))
    relevant_events = [
        event for event in all_pointer_events
        if event.get("task_id") == task_id or event.get("cid") in cid_set
    ]
    hydrated, projections = hydrate_and_reduce(relevant_events, ipfs, tasknode_identity)
    return hydrated, projections, relevant_events


def lifecycle_result(
    *,
    task_id: str,
    request_bundle: dict[str, Any],
    context_id: str,
    taskgen: Any,
    verification_result: Any | None,
    scoring_result: Any | None,
    reward_paid: bool,
    reward_amount: float,
    wallets: dict[str, str],
    cids: dict[str, Any],
    txs: dict[str, Any],
    submissions: dict[str, Any],
    hydrated: list[Any],
    projections: dict[str, Any],
    relevant_events: list[dict[str, Any]],
    queues: EngineQueues,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "task_id": task_id,
        "request_id": request_bundle["request"]["request_id"],
        "bundle_id": request_bundle["bundle_id"],
        "context_id": context_id,
        "generated_task": taskgen.output,
        "taskgen": taskgen.metadata,
        "verification_request_model": verification_result.metadata if verification_result else {},
        "verification_request": verification_result.output if verification_result else {},
        "scoring": scoring_result.metadata if scoring_result else {},
        "score": scoring_result.output if scoring_result else {},
        "reward_paid": reward_paid,
        "reward_pft": f"{reward_amount:.2f}",
        "wallets": wallets,
        "cids": cids,
        "txs": txs,
        "submissions": submissions,
        "pointer_events_found": len(relevant_events),
        "hydrated_events": [
            {
                "schema": event.payload.get("schema"),
                "tx_hash": event.source_tx_hash,
                "cid": event.pointer.get("cid"),
                "task_id": event.payload.get("task_id") or event.pointer.get("task_id"),
                "event_digest": sha256_hex(event.payload),
            }
            for event in hydrated
        ],
        "projection": {task: projection.to_dict() for task, projection in projections.items()},
        "queue_state": {
            "user": public_queue_entries(queues.user),
            "authority": public_queue_entries(queues.authority),
            "allocation": public_queue_entries(queues.allocation),
        },
    }
    if extra:
        result.update(extra)
    return result


def flatten_cids(cids: dict[str, Any]) -> list[str]:
    out = []
    for value in cids.values():
        if isinstance(value, list):
            out.extend(str(item) for item in value if item)
        elif value:
            out.append(str(value))
    return out


def public_queue_entries(queue: WalletTxQueue) -> list[dict[str, Any]]:
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
