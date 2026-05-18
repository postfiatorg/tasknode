from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass
import math
from pathlib import Path
import threading
from typing import Any

from tasknode_pftl.app_data import (
    build_context_doc_payload,
    build_request_bundle_from_fixture,
    load_task_request_fixture,
    tasknode_database_url,
)
from tasknode_pftl.codec import now_iso
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.encryption import (
    generate_identity,
    tasknode_identity_from_seed,
    x25519_public_key_b64_from_message_key,
)
from tasknode_pftl.engine.cache import attach_task_queue_cache
from tasknode_pftl.engine.evidence_suite import EvidencePlan
from tasknode_pftl.engine.lifecycle import EngineQueues, run_task_engine_lifecycle
from tasknode_pftl.engine.receipts import write_json, write_n10_markdown
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, drops_to_pft
from tasknode_pftl.scenarios.app_request_lifecycle import publish_message_keys_safely
from tasknode_pftl.scenarios.full_lifecycle import RUNS_DIR, private_wallets, public_wallets, queue_entries_public
from tasknode_pftl.tx_queue import WalletTxQueue
from tasknode_pftl.wallets import ProtocolWallet, create_protocol_wallet, fund_wallets


DEFAULT_WALLET_COUNT = 10
DEFAULT_AUTHORITY_COUNT = 2
DEFAULT_ALLOCATION_SHARD_SIZE = 5


@dataclass(frozen=True)
class StageBCase:
    label: str
    evidence_type: str
    task_detail: str
    requested_task_kind: str = "system"
    faulty_initial: bool = False
    faulty_verification: bool = False
    task_decision: str = "accept"
    refusal_reason: str = ""
    re_request_after_refusal: bool = False


class SharedQueueRegistry:
    def __init__(self) -> None:
        self._queues: dict[str, WalletTxQueue] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._registry_lock = threading.Lock()

    def queue_for(self, wallet: ProtocolWallet) -> WalletTxQueue:
        with self._registry_lock:
            if wallet.address not in self._queues:
                self._queues[wallet.address] = WalletTxQueue(wallet.address)
            return self._queues[wallet.address]

    def lock_for(self, wallet: ProtocolWallet) -> threading.Lock:
        with self._registry_lock:
            if wallet.address not in self._locks:
                self._locks[wallet.address] = threading.Lock()
            return self._locks[wallet.address]

    def engine_queues(
        self,
        *,
        user_wallet: ProtocolWallet,
        authority_wallet: ProtocolWallet,
        allocation_wallet: ProtocolWallet,
    ) -> EngineQueues:
        return EngineQueues(
            user=self.queue_for(user_wallet),
            authority=self.queue_for(authority_wallet),
            allocation=self.queue_for(allocation_wallet),
            user_lock=self.lock_for(user_wallet),
            authority_lock=self.lock_for(authority_wallet),
            allocation_lock=self.lock_for(allocation_wallet),
        )

    def public_state(self, wallets: list[ProtocolWallet]) -> dict[str, list[dict[str, Any]]]:
        return {
            f"{wallet.role}:{wallet.address}": queue_entries_public(self.queue_for(wallet))
            for wallet in wallets
        }


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


def stage_b_case_for_index(index: int) -> StageBCase:
    cases = [
        StageBCase(
            label="url",
            evidence_type="url",
            task_detail=(
                "Generate a compact URL-evidence task for this live Stage B protocol run. It must be completable "
                "by submitting the public gist URL https://gist.github.com/goodalexander/d390caddb019ec3cb08748a15a97a760. "
                "Do not require a repository commit, external deployment, or artifact outside this harness."
            ),
        ),
        StageBCase(
            label="screenshot",
            evidence_type="screenshot",
            task_detail=(
                "Generate a compact screenshot-evidence task for this live Stage B protocol run. It must be "
                "completable by submitting the canonical screenshot generated by the Python harness."
            ),
        ),
        StageBCase(
            label="text",
            evidence_type="text",
            task_detail=(
                "Generate a compact text-evidence task for this live Stage B protocol run. It must be completable "
                "by submitting a concise written attestation that references the PFTL replay identifiers."
            ),
        ),
        StageBCase(
            label="code",
            evidence_type="code",
            task_detail=(
                "Generate a compact code-evidence task for this live Stage B protocol run. It must be completable "
                "by submitting the canonical code sample generated by the Python harness."
            ),
        ),
        StageBCase(
            label="file",
            evidence_type="file",
            task_detail=(
                "Generate a compact file-evidence task for this live Stage B protocol run. It must be completable "
                "by submitting the canonical PDF evidence file generated by the Python harness."
            ),
        ),
        StageBCase(
            label="mixed",
            evidence_type="mixed",
            task_detail=(
                "Generate a compact mixed-evidence task for this live Stage B protocol run. It must be completable "
                "by submitting the public gist URL, the canonical screenshot, and a short text attestation from the Python harness."
            ),
        ),
        StageBCase(
            label="faulty",
            evidence_type="text",
            task_detail=(
                "Generate a compact task whose evidence requirement is concrete and checkable. This Stage B case "
                "will deliberately submit faulty evidence so the verifier should request a harder follow-up and scoring should not grant a full reward."
            ),
            faulty_initial=True,
            faulty_verification=True,
        ),
        StageBCase(
            label="wrong-evidence-type",
            evidence_type="text",
            task_detail=(
                "Generate a compact screenshot-evidence task for this live Stage B protocol run. This case will "
                "intentionally submit text instead of the requested screenshot so the scoring path can reject or reduce reward."
            ),
            faulty_initial=True,
            faulty_verification=True,
        ),
        StageBCase(
            label="refuse-then-rerequest",
            evidence_type="text",
            task_detail=(
                "Generate a compact task offer that a user might reasonably refuse because it is too broad for a "
                "single protocol check. This run will publish the refusal on chain, then request a narrower replacement."
            ),
            task_decision="refuse",
            refusal_reason="The offered task is too broad for this protocol check; requesting a narrower replacement.",
            re_request_after_refusal=True,
        ),
        StageBCase(
            label="duplicate-guard",
            evidence_type="mixed",
            task_detail=(
                "Generate a compact task that explicitly avoids duplicating the cached completed task in task_queue. "
                "The new task should verify a distinct aspect of PFTL replay with mixed evidence."
            ),
        ),
    ]
    return cases[index % len(cases)]


def normalized_public_wallet(wallet: ProtocolWallet, role: str) -> dict[str, Any]:
    out = dict(wallet.public_seedless)
    out["role"] = role
    return out


def task_receipt_wallets(
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
) -> list[dict[str, Any]]:
    return [
        normalized_public_wallet(user_wallet, "user"),
        normalized_public_wallet(authority_wallet, "task_authority"),
        normalized_public_wallet(allocation_wallet, "allocation_reward"),
    ]


def build_public_receipt(
    *,
    run_id: str,
    schema: str,
    provider: str,
    config: PftlConfig,
    fixture: Any,
    request_bundle: dict[str, Any],
    result: dict[str, Any],
    wallets: list[dict[str, Any]],
    funding: Any,
    key_publications: Any,
    resolved_keys: dict[str, str],
    balances_before_pft: dict[str, str],
    balances_after_pft: dict[str, str],
    case: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "schema": schema,
        "provider": provider,
        "network": {
            "name": config.network_name,
            "rpc_url": config.rpc_url,
            "archive_wss_url": config.archive_wss_url,
            "note": "PFTL is its own Post Fiat L1; xrpl-py is used only as the PFTL wire library.",
        },
        "fixture": {
            "account_id": fixture.account_id,
            "conversation_id": fixture.conversation.get("id"),
            "conversation_title": fixture.conversation.get("title"),
            "request_id": result.get("request_id") or fixture.request_id,
            "request_message_id": fixture.request_message.get("id"),
            "request_detail_excerpt": request_bundle["request"].get("user_detail_text", "")[:240],
            "recent_message_count": len(fixture.recent_messages),
            "recent_memory_count": len(fixture.recent_memory),
            "deep_memory_count": len(fixture.deep_memory),
            "task_queue_summary": (request_bundle.get("task_queue") or {}).get("summary"),
        },
        "case": case or {},
        "task_id": result["task_id"],
        "wallets": wallets,
        "funding": funding,
        "message_keys": key_publications,
        "resolved_encryption_keys": resolved_keys,
        "balances_before_pft": balances_before_pft,
        "balances_after_pft": balances_after_pft,
        "cids": result["cids"],
        "txs": result["txs"],
        "taskgen": result["taskgen"],
        "generated_task": result["generated_task"],
        "submission_summaries": [
            {
                "phase": phase,
                "artifact_type": evidence["processed_evidence"]["artifacts"][0]["artifact_type"]
                if evidence.get("processed_evidence", {}).get("artifacts")
                else "",
                "response": evidence.get("response", {}).get("response_text")
                or evidence.get("submission", {}).get("summary")
                or "",
                "processed_evidence": evidence.get("processed_evidence") or {},
            }
            for phase, evidence in result.get("submissions", {}).items()
        ],
        "pointer_events_found": result["pointer_events_found"],
        "hydrated_events": result["hydrated_events"],
        "projection": result["projection"],
        "queue_state": result["queue_state"],
        "result": result,
    }

def prepare_stage_b_bundle(
    *,
    fixture: Any,
    base_context_doc: dict[str, Any],
    base_request_bundle: dict[str, Any],
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
    case: StageBCase,
    index: int,
    attempt: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    context_doc = deepcopy(base_context_doc)
    request_bundle = deepcopy(base_request_bundle)
    suffix = f"stage_b_user_{index + 1:02d}_{attempt}_{case.label}"
    created_at = now_iso()
    context_doc["context_id"] = f"ctx_{index + 1:02d}_{attempt}_{user_wallet.address[-8:]}"
    context_doc["subject_wallet"] = user_wallet.address
    context_doc["title"] = f"Stage B Context {index + 1:02d}: {case.label}"
    context_doc["content"] = (
        str(context_doc.get("content") or "")
        + "\n\n"
        + (
            f"Representative Stage B user {index + 1} is validating the {case.label} task path. "
            "This context document is intentionally wallet-specific so replay can prove that context, memory, "
            "chat, task request, evidence, verification, and reward state travel together without Postgres as canonical truth."
        )
    )
    request_bundle["bundle_id"] = f"bundle_{suffix}_{user_wallet.address[-6:]}"
    request_bundle["subject_wallet"] = user_wallet.address
    request_bundle["created_at"] = created_at
    request_bundle["client"]["session_id"] = suffix
    request_bundle["client"]["source_app"] = "tasknodeofficial-stage-b"
    request_bundle["request"]["request_id"] = f"req_{suffix}_{user_wallet.address[-6:]}"
    request_bundle["request"]["request_text"] = (
        "Request a live protocol task using this wallet-specific context, memory, recent chat, and task queue cache."
    )
    request_bundle["request"]["user_detail_text"] = case.task_detail
    request_bundle["request"]["requested_task_kind"] = case.requested_task_kind
    request_bundle["request"]["source"] = "python_task_engine_stage_b"
    request_bundle["recent_chat"]["messages"] = [
        *request_bundle["recent_chat"].get("messages", [])[-8:],
        {
            "id": f"{suffix}_user_message",
            "role": "user",
            "content": case.task_detail,
            "created_at": created_at,
            "digest": f"sha256:{user_wallet.address[-12:]}",
            "provider": None,
            "model": None,
        },
    ]
    request_bundle["recent_chat"]["summary"] = (
        f"Stage B user {index + 1} is executing the {case.label} path. "
        f"Requested task detail: {case.task_detail}"
    )
    request_bundle["memory"]["deep_memory"] = [
        *request_bundle["memory"].get("deep_memory", [])[-2:],
        {
            "kind": "deep_memory",
            "conversation_title": "stage_b_protocol_test",
            "created_at": created_at,
            "memory_text": (
                "The user is validating that tasks can be requested, accepted or refused, evidenced, verified, "
                "scored, rewarded, and replayed from PFTL/IPFS without making Postgres canonical."
            ),
        },
    ]
    request_bundle["memory"]["recent_memory"] = [
        *request_bundle["memory"].get("recent_memory", [])[-8:],
        {
            "kind": "turn_memory",
            "conversation_title": "stage_b_protocol_test",
            "created_at": created_at,
            "memory_text": f"Stage B wallet {index + 1} is exercising the {case.label} evidence path.",
        },
    ]
    request_bundle["wallet"]["subject_wallet"] = user_wallet.address
    request_bundle["wallet"]["authority_wallet"] = authority_wallet.address
    request_bundle["wallet"]["authority_hint"] = authority_wallet.address
    request_bundle["wallet"]["allocation_wallet"] = allocation_wallet.address
    request_bundle["policy"]["task_policy_version"] = "task-policy-stage-b-v1"
    request_bundle["policy"]["reward_policy_version"] = "reward-policy-stage-b-v1"
    if case.label == "duplicate-guard":
        request_bundle["task_queue"] = {
            "schema": "pf.task.queue_cache.v1",
            "source": "stage_b_synthetic_duplicate_guard",
            "groups": {
                "outstanding": [],
                "pending_verification": [],
                "refused": [],
                "rewarded": [
                    {
                        "task_id": "task_stage_b_existing_mixed_replay",
                        "status": "rewarded",
                        "title": "Verify PFTL replay with mixed evidence",
                        "task_kind": "system",
                        "reward_actual_pft": "0.75",
                        "submission_type": "mixed",
                        "updated_at": created_at,
                    }
                ],
            },
            "summary": {
                "outstanding": 0,
                "pending_verification": 0,
                "refused": 0,
                "rewarded": 1,
            },
        }
    return context_doc, request_bundle


def run_stage_b_attempt(
    *,
    config: PftlConfig,
    run_id: str,
    run_dir: Path,
    fixture: Any,
    base_context_doc: dict[str, Any],
    base_request_bundle: dict[str, Any],
    queue_registry: SharedQueueRegistry,
    user_wallet: ProtocolWallet,
    authority_wallet: ProtocolWallet,
    allocation_wallet: ProtocolWallet,
    tasknode_identity: Any,
    verification_identity: Any,
    case: StageBCase,
    index: int,
    attempt: str,
    provider: str,
    taskgen_model: str | None,
    verification_model: str | None,
    scoring_model: str | None,
    vision_detail: str,
    allow_taskgen_fallback: bool,
    benchmark_high_reasoning: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    pftl = PftlClient(config.rpc_url)
    ipfs = IpfsClient(config)
    context_doc, request_bundle = prepare_stage_b_bundle(
        fixture=fixture,
        base_context_doc=base_context_doc,
        base_request_bundle=base_request_bundle,
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
        case=case,
        index=index,
        attempt=attempt,
    )
    if "task_queue" not in request_bundle:
        attach_task_queue_cache(
            request_bundle,
            account_id=fixture.account_id,
            wallet_address=user_wallet.address,
        )
    evidence_plan = EvidencePlan(
        artifact_type=case.evidence_type,
        faulty=case.faulty_initial,
        screenshot_detail=vision_detail,
    )
    verification_plan = None
    if case.faulty_verification:
        verification_plan = EvidencePlan(
            artifact_type="text",
            response_text=(
                f"Faulty Stage B verification response for user {index + 1}: I cannot provide the requested artifact detail."
            ),
            faulty=True,
            screenshot_detail=vision_detail,
        )
    result = run_task_engine_lifecycle(
        config=config,
        pftl=pftl,
        ipfs=ipfs,
        run_id=f"{run_id}_{index + 1:02d}_{attempt}",
        run_dir=run_dir / f"user_{index + 1:02d}_{attempt}",
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
        tasknode_identity=tasknode_identity,
        verification_identity=verification_identity,
        context_doc=context_doc,
        request_bundle=request_bundle,
        provider=provider,
        taskgen_model=taskgen_model,
        verification_model=verification_model,
        scoring_model=scoring_model,
        evidence_plan=evidence_plan,
        verification_evidence_plan=verification_plan,
        allow_taskgen_fallback=allow_taskgen_fallback,
        benchmark_high_reasoning=benchmark_high_reasoning,
        queues=queue_registry.engine_queues(
            user_wallet=user_wallet,
            authority_wallet=authority_wallet,
            allocation_wallet=allocation_wallet,
        ),
        task_decision=case.task_decision,
        refusal_reason=case.refusal_reason,
    )
    return result, request_bundle


def run_stage_b_user(
    *,
    index: int,
    assignment: dict[str, Any],
    **kwargs: Any,
) -> list[dict[str, Any]]:
    case = stage_b_case_for_index(index)
    results = []
    result, request_bundle = run_stage_b_attempt(
        index=index,
        user_wallet=assignment["user_wallet"],
        authority_wallet=assignment["authority_wallet"],
        allocation_wallet=assignment["allocation_wallet"],
        case=case,
        attempt="refusal" if case.task_decision == "refuse" else "primary",
        **kwargs,
    )
    results.append({
        "index": index,
        "case": case,
        "attempt": "refusal" if case.task_decision == "refuse" else "primary",
        "result": result,
        "request_bundle": request_bundle,
    })
    if case.re_request_after_refusal:
        replacement_case = StageBCase(
            label="rerequest-replacement",
            evidence_type="text",
            task_detail=(
                "Generate a narrow replacement task after the prior offer was refused. The task must be completable "
                "with a concise text attestation that includes PFTL replay identifiers."
            ),
        )
        replacement_result, replacement_bundle = run_stage_b_attempt(
            index=index,
            user_wallet=assignment["user_wallet"],
            authority_wallet=assignment["authority_wallet"],
            allocation_wallet=assignment["allocation_wallet"],
            case=replacement_case,
            attempt="rerequest",
            **kwargs,
        )
        results.append({
            "index": index,
            "case": replacement_case,
            "attempt": "rerequest",
            "result": replacement_result,
            "request_bundle": replacement_bundle,
        })
    return results


def run_n10(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_live()
    provider = str(args.provider or "frontier").strip().lower()
    if not provider_configured(config, provider):
        raise RuntimeError(f"{provider_required_env(provider)} is required for live task engine execution")
    if not config.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required because Stage B includes screenshot evidence and OpenAI vision")

    wallet_count = max(1, int(args.wallet_count))
    authority_count = max(1, int(args.authority_count))
    allocation_count = allocation_count_for(wallet_count, args.allocation_count, args.allocation_shard_size)
    run_id = args.run_id or f"task_engine_n10_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    receipts_dir = run_dir / "task_receipts"
    receipts_dir.mkdir(parents=True, exist_ok=True)

    database_url = tasknode_database_url(args.database_url)
    fixture = load_task_request_fixture(
        database_url=database_url,
        chat_title=args.chat_title,
        request_id=args.request_id,
    )

    pftl = PftlClient(config.rpc_url)
    user_wallets = [create_protocol_wallet(f"user_wallet_{index + 1:02d}") for index in range(wallet_count)]
    authority_wallets = [create_protocol_wallet(f"task_authority_{index + 1:02d}") for index in range(authority_count)]
    allocation_wallets = [create_protocol_wallet(f"allocation_reward_{index + 1:02d}") for index in range(allocation_count)]
    all_wallets = [*user_wallets, *authority_wallets, *allocation_wallets]
    tasknode_identity = tasknode_identity_from_seed(config.faucet_seed)
    verification_identities = {
        wallet.address: generate_identity(f"verification_service_{index + 1:02d}", wallet.address)
        for index, wallet in enumerate(allocation_wallets)
    }
    assignments = []
    for index, user_wallet in enumerate(user_wallets):
        assignment = assignment_for_index(
            index,
            authority_count=authority_count,
            allocation_count=allocation_count,
            allocation_shard_size=args.allocation_shard_size,
        )
        assignments.append({
            "index": index,
            "user_wallet": user_wallet,
            "authority_wallet": authority_wallets[assignment["authority_index"]],
            "allocation_wallet": allocation_wallets[assignment["allocation_index"]],
            "authority_index": assignment["authority_index"],
            "allocation_index": assignment["allocation_index"],
        })

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print(f"Run id: {run_id}")
    print(f"User wallets: {wallet_count}")
    print(f"Authority wallets: {authority_count}")
    print(f"Allocation wallets: {allocation_count}")
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

    base_context_doc = build_context_doc_payload(fixture, subject_wallet=user_wallets[0].address)
    base_request_bundle = build_request_bundle_from_fixture(
        fixture,
        subject_wallet=user_wallets[0].address,
        allocation_wallet=allocation_wallets[0].address,
        authority_wallet=authority_wallets[0].address,
        client_name="tasknodeofficial-python-task-engine-stage-b",
    )
    queue_registry = SharedQueueRegistry()
    all_task_runs: list[dict[str, Any]] = []
    print("Running Stage B wallet lifecycles...")
    with ThreadPoolExecutor(max_workers=max(1, int(args.concurrency))) as executor:
        futures = {
            executor.submit(
                run_stage_b_user,
                index=assignment["index"],
                assignment=assignment,
                config=config,
                run_id=run_id,
                run_dir=run_dir,
                fixture=fixture,
                base_context_doc=base_context_doc,
                base_request_bundle=base_request_bundle,
                queue_registry=queue_registry,
                tasknode_identity=tasknode_identity,
                verification_identity=verification_identities[assignment["allocation_wallet"].address],
                provider=provider,
                taskgen_model=args.taskgen_model,
                verification_model=args.verification_model,
                scoring_model=args.scoring_model,
                vision_detail=args.vision_detail,
                allow_taskgen_fallback=args.allow_taskgen_fallback,
                benchmark_high_reasoning=args.benchmark_high_reasoning,
            ): assignment
            for assignment in assignments
        }
        for future in as_completed(futures):
            assignment = futures[future]
            runs = future.result()
            all_task_runs.extend(runs)
            statuses = [
                next(iter(run["result"].get("projection", {}).values()), {}).get("status", "missing")
                for run in runs
            ]
            print(
                "  user {user:02d}: {statuses}".format(
                    user=assignment["index"] + 1,
                    statuses=", ".join(statuses),
                )
            )
    all_task_runs.sort(key=lambda item: (item["index"], item["attempt"]))
    balances_after = {wallet.address: pftl.account_balance_drops(wallet.address) for wallet in all_wallets}

    task_receipts = []
    for item in all_task_runs:
        result = item["result"]
        case = item["case"]
        assignment = next(row for row in assignments if row["user_wallet"].address == result["wallets"]["user"])
        receipt = build_public_receipt(
            run_id=run_id,
            schema="pf.tasknode.task_engine_n10.task_receipt.v1",
            provider=provider,
            config=config,
            fixture=fixture,
            request_bundle=item["request_bundle"],
            result=result,
            wallets=task_receipt_wallets(
                assignment["user_wallet"],
                assignment["authority_wallet"],
                assignment["allocation_wallet"],
            ),
            funding=funding,
            key_publications=key_publications,
            resolved_keys={
                assignment["user_wallet"].role: resolved_keys.get(assignment["user_wallet"].role, ""),
                assignment["authority_wallet"].role: resolved_keys.get(assignment["authority_wallet"].role, ""),
                assignment["allocation_wallet"].role: resolved_keys.get(assignment["allocation_wallet"].role, ""),
            },
            balances_before_pft={
                assignment["user_wallet"].address: drops_to_pft(balances_before[assignment["user_wallet"].address]),
                assignment["authority_wallet"].address: drops_to_pft(balances_before[assignment["authority_wallet"].address]),
                assignment["allocation_wallet"].address: drops_to_pft(balances_before[assignment["allocation_wallet"].address]),
            },
            balances_after_pft={
                assignment["user_wallet"].address: drops_to_pft(balances_after[assignment["user_wallet"].address]),
                assignment["authority_wallet"].address: drops_to_pft(balances_after[assignment["authority_wallet"].address]),
                assignment["allocation_wallet"].address: drops_to_pft(balances_after[assignment["allocation_wallet"].address]),
            },
            case={
                "label": case.label,
                "attempt": item["attempt"],
                "evidence_type": case.evidence_type,
                "faulty_initial": case.faulty_initial,
                "faulty_verification": case.faulty_verification,
                "task_decision": case.task_decision,
            },
        )
        task_receipts.append(receipt)
        write_json(receipts_dir / f"{item['attempt']}_{result['task_id']}.json", receipt)

    status_counts: dict[str, int] = {}
    for receipt in task_receipts:
        projection = next(iter((receipt.get("projection") or {}).values()), {})
        status = str(projection.get("status") or "missing")
        status_counts[status] = status_counts.get(status, 0) + 1
    rewarded_count = status_counts.get("rewarded", 0)
    refused_count = status_counts.get("refused", 0)
    public_receipt = {
        "run_id": run_id,
        "schema": "pf.tasknode.task_engine_n10.receipt.v1",
        "provider": provider,
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
        "task_count": len(task_receipts),
        "status_counts": status_counts,
        "rewarded_count": rewarded_count,
        "refused_count": refused_count,
        "wallets": public_wallets(all_wallets),
        "assignments": [
            {
                "index": item["index"],
                "user_wallet": item["user_wallet"].address,
                "authority_wallet": item["authority_wallet"].address,
                "allocation_wallet": item["allocation_wallet"].address,
                "authority_index": item["authority_index"],
                "allocation_index": item["allocation_index"],
            }
            for item in assignments
        ],
        "funding": funding,
        "message_keys": key_publications,
        "resolved_encryption_keys": resolved_keys,
        "balances_before_pft": {address: drops_to_pft(value) for address, value in balances_before.items()},
        "balances_after_pft": {address: drops_to_pft(value) for address, value in balances_after.items()},
        "queue_state": queue_registry.public_state(all_wallets),
        "task_receipts": task_receipts,
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
    write_n10_markdown(run_dir / "TASK_ENGINE_N10.md", public_receipt)

    print("\nTask engine Stage B complete")
    print(f"  run_id: {run_id}")
    print(f"  tasks: {len(task_receipts)}")
    print(f"  rewarded: {rewarded_count}")
    print(f"  refused: {refused_count}")
    print(f"  public_receipt: {run_dir / 'receipt_public.json'}")
    print(f"  markdown: {run_dir / 'TASK_ENGINE_N10.md'}")
    return public_receipt
