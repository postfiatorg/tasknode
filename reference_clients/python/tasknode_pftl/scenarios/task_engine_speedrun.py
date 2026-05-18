from __future__ import annotations

import argparse
import os
from pathlib import Path
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
from tasknode_pftl.engine.lifecycle import run_task_engine_lifecycle
from tasknode_pftl.engine.receipts import write_json, write_n1_markdown
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, drops_to_pft
from tasknode_pftl.scenarios.app_request_lifecycle import publish_message_keys_safely
from tasknode_pftl.scenarios.full_lifecycle import RUNS_DIR, private_wallets, public_wallets
from tasknode_pftl.wallets import ProtocolWallet, create_protocol_wallet, fund_wallets, wallet_from_seed
from tasknode_pftl.scenarios.task_engine_stage_b import (
    DEFAULT_ALLOCATION_SHARD_SIZE,
    DEFAULT_AUTHORITY_COUNT,
    DEFAULT_WALLET_COUNT,
    run_n10,
)


DEFAULT_USER_SEED_FILE = Path(os.environ.get("TASKNODE_USER_SEED_FILE", "~/.tasknode/user_seed.txt")).expanduser()
DEFAULT_CHAT_TITLE = "task_sample"

def read_seed_file(path: Path) -> str:
    seed = path.read_text(encoding="utf-8").strip()
    if not seed:
        raise RuntimeError(f"Seed file is empty: {path}")
    return seed


def resolved_encryption_keys(client: PftlClient, wallets: list[ProtocolWallet]) -> dict[str, str]:
    keys = {}
    for wallet in wallets:
        message_key = client.account_message_key(wallet.address) or ""
        keys[wallet.role] = x25519_public_key_b64_from_message_key(message_key)
        if keys[wallet.role] != wallet.encryption.public_key_b64:
            raise RuntimeError(f"Resolved MessageKey does not match local encryption identity for {wallet.role}")
    return keys


def provider_configured(config: PftlConfig, provider: str) -> bool:
    normalized = str(provider or "frontier").strip().lower()
    if normalized == "private":
        return bool(config.openrouter_api_key)
    return bool(config.openai_api_key)


def provider_required_env(provider: str) -> str:
    return "OPENROUTER_API_KEY" if str(provider).strip().lower() == "private" else "OPENAI_API_KEY"


def load_user_wallet(args: argparse.Namespace) -> ProtocolWallet:
    path = Path(args.user_seed_file)
    if path.exists():
        return wallet_from_seed("user", read_seed_file(path))
    if args.create_user_wallet:
        return create_protocol_wallet("user")
    raise RuntimeError(f"User seed file not found: {path}. Pass --create-user-wallet for a generated test wallet.")


def evidence_plan_from_args(args: argparse.Namespace) -> EvidencePlan:
    return EvidencePlan(
        artifact_type=args.evidence_type,
        url=args.evidence_url,
        path=args.evidence_path,
        faulty=args.faulty_evidence,
        screenshot_detail=args.vision_detail,
    )




def run_n1(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_live()
    provider = str(args.provider or "frontier").strip().lower()
    if not provider_configured(config, provider):
        raise RuntimeError(f"{provider_required_env(provider)} is required for live task engine execution")
    if args.evidence_type in {"screenshot", "mixed"} and not config.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required because screenshot evidence uses OpenAI vision in v1")

    run_id = args.run_id or f"task_engine_n1_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    database_url = tasknode_database_url(args.database_url)
    fixture = load_task_request_fixture(
        database_url=database_url,
        chat_title=args.chat_title,
        request_id=args.request_id,
    )

    pftl = PftlClient(config.rpc_url)
    ipfs = IpfsClient(config)
    user_wallet = load_user_wallet(args)
    authority_wallet = create_protocol_wallet("task_authority")
    allocation_wallet = create_protocol_wallet("allocation_reward")
    wallets = [user_wallet, authority_wallet, allocation_wallet]
    tasknode_identity = tasknode_identity_from_seed(config.faucet_seed)
    verification_identity = generate_identity("verification_reward_service", allocation_wallet.address)

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print(f"Run id: {run_id}")
    print(f"Fixture: {args.chat_title} / {fixture.request_id}")
    print(f"Provider: {provider}")
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

    context_doc = build_context_doc_payload(fixture, subject_wallet=user_wallet.address)
    request_bundle = build_request_bundle_from_fixture(
        fixture,
        subject_wallet=user_wallet.address,
        allocation_wallet=allocation_wallet.address,
        authority_wallet=authority_wallet.address,
        client_name="tasknodeofficial-python-task-engine",
    )
    if args.task_detail:
        request_bundle["request"]["user_detail_text"] = args.task_detail
    if args.task_request_text:
        request_bundle["request"]["request_text"] = args.task_request_text
    if args.requested_task_kind:
        request_bundle["request"]["requested_task_kind"] = args.requested_task_kind
    if args.task_detail:
        request_bundle["recent_chat"]["summary"] = (
            f"{request_bundle['recent_chat']['summary']} Explicit N=1 task detail: {args.task_detail}"
        )
    attach_task_queue_cache(
        request_bundle,
        database_url=database_url,
        account_id=fixture.account_id,
        wallet_address=user_wallet.address,
    )

    result = run_task_engine_lifecycle(
        config=config,
        pftl=pftl,
        ipfs=ipfs,
        run_id=run_id,
        run_dir=run_dir,
        user_wallet=user_wallet,
        authority_wallet=authority_wallet,
        allocation_wallet=allocation_wallet,
        tasknode_identity=tasknode_identity,
        verification_identity=verification_identity,
        context_doc=context_doc,
        request_bundle=request_bundle,
        provider=provider,
        taskgen_model=args.taskgen_model,
        verification_model=args.verification_model,
        scoring_model=args.scoring_model,
        evidence_plan=evidence_plan_from_args(args),
        allow_taskgen_fallback=args.allow_taskgen_fallback,
        benchmark_high_reasoning=args.benchmark_high_reasoning,
    )
    balances_after = {wallet.role: pftl.account_balance_drops(wallet.address) for wallet in wallets}

    public_receipt = {
        "run_id": run_id,
        "schema": "pf.tasknode.task_engine_n1.receipt.v1",
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
            "request_id": fixture.request_id,
            "request_message_id": fixture.request_message.get("id"),
            "request_detail_excerpt": request_bundle["request"].get("user_detail_text", "")[:240],
            "recent_message_count": len(fixture.recent_messages),
            "recent_memory_count": len(fixture.recent_memory),
            "deep_memory_count": len(fixture.deep_memory),
            "task_queue_summary": (request_bundle.get("task_queue") or {}).get("summary"),
        },
        "task_id": result["task_id"],
        "wallets": public_wallets(wallets),
        "funding": funding,
        "message_keys": key_publications,
        "resolved_encryption_keys": resolved_keys,
        "balances_before_pft": {role: drops_to_pft(value) for role, value in balances_before.items()},
        "balances_after_pft": {role: drops_to_pft(value) for role, value in balances_after.items()},
        "cids": result["cids"],
        "txs": result["txs"],
        "taskgen": result["taskgen"],
        "generated_task": result["generated_task"],
        "submission_summaries": [
            {
                "phase": phase,
                "artifact_type": evidence["processed_evidence"]["artifacts"][0]["artifact_type"]
                if evidence["processed_evidence"].get("artifacts")
                else "",
                "response": evidence.get("response", {}).get("response_text")
                or evidence.get("submission", {}).get("summary")
                or "",
                "processed_evidence": evidence["processed_evidence"],
            }
            for phase, evidence in result.get("submissions", {}).items()
        ],
        "pointer_events_found": result["pointer_events_found"],
        "hydrated_events": result["hydrated_events"],
        "projection": result["projection"],
        "queue_state": result["queue_state"],
        "result": result,
    }
    private_receipt = {
        "run_id": run_id,
        "wallets": private_wallets([authority_wallet, allocation_wallet]),
        "user_wallet": {
            "role": user_wallet.role,
            "address": user_wallet.address,
            "public_key": user_wallet.wallet.public_key,
            "x25519": user_wallet.encryption.public_descriptor(),
            "seed_file": str(args.user_seed_file) if Path(args.user_seed_file).exists() else None,
            "generated_private_descriptor": user_wallet.private_descriptor if args.create_user_wallet else None,
        },
        "tasknode_identity": tasknode_identity.private_descriptor(),
        "verification_service_identity": verification_identity.private_descriptor(),
    }
    write_json(run_dir / "receipt_public.json", public_receipt)
    write_json(run_dir / "receipt_private.json", private_receipt)
    write_n1_markdown(run_dir / "TASK_ENGINE_N1.md", public_receipt)

    projection = result["projection"].get(result["task_id"], {})
    print("\nTask engine N=1 complete")
    print(f"  run_id: {run_id}")
    print(f"  task_id: {result['task_id']}")
    print(f"  replay_status: {projection.get('status')}")
    print(f"  reward_paid: {result['reward_paid']}")
    print(f"  reward_pft: {result['reward_pft']}")
    print(f"  public_receipt: {run_dir / 'receipt_public.json'}")
    print(f"  markdown: {run_dir / 'TASK_ENGINE_N1.md'}")
    return public_receipt




def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Pythonic Task Engine speedrun.")
    parser.add_argument("--stage", choices=["n1", "n10"], default="n1")
    parser.add_argument("--chat-title", default=DEFAULT_CHAT_TITLE)
    parser.add_argument("--request-id", default=None)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--user-seed-file", default=str(DEFAULT_USER_SEED_FILE))
    parser.add_argument("--create-user-wallet", action="store_true")
    parser.add_argument("--wallet-count", type=int, default=DEFAULT_WALLET_COUNT)
    parser.add_argument("--authority-count", type=int, default=DEFAULT_AUTHORITY_COUNT)
    parser.add_argument("--allocation-count", type=int, default=None)
    parser.add_argument("--allocation-shard-size", type=int, default=DEFAULT_ALLOCATION_SHARD_SIZE)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--provider", choices=["frontier", "private"], default="frontier")
    parser.add_argument("--taskgen-model", default=None)
    parser.add_argument("--verification-model", default=None)
    parser.add_argument("--scoring-model", default=None)
    parser.add_argument("--task-detail", default=None)
    parser.add_argument("--task-request-text", default=None)
    parser.add_argument("--requested-task-kind", default=None)
    parser.add_argument("--evidence-type", choices=["auto", "text", "url", "github_commit", "screenshot", "file", "mixed", "code"], default="mixed")
    parser.add_argument("--evidence-url", default="https://gist.github.com/goodalexander/d390caddb019ec3cb08748a15a97a760")
    parser.add_argument("--evidence-path", default=None)
    parser.add_argument("--faulty-evidence", action="store_true")
    parser.add_argument("--vision-detail", default="high", choices=["low", "high", "auto"])
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--fund-pft", type=float, default=25.0)
    parser.add_argument("--replace-message-key", action="store_true")
    parser.add_argument("--benchmark-high-reasoning", action="store_true")
    parser.add_argument(
        "--allow-taskgen-fallback",
        action="store_true",
        help="Protocol-only fallback for local smoke tests. Do not use for live acceptance runs.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.stage == "n1":
        run_n1(args)
    elif args.stage == "n10":
        run_n10(args)


if __name__ == "__main__":
    main()
