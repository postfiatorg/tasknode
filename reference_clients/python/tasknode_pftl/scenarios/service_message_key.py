from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

from xrpl.wallet import Wallet

from tasknode_pftl.codec import short
from tasknode_pftl.config import PftlConfig, load_env
from tasknode_pftl.encryption import (
    message_key_from_x25519_public_key,
    tasknode_identity_from_seed,
    x25519_public_key_from_message_key,
)
from tasknode_pftl.pftl import PftlClient


def service_seed_from_env() -> tuple[str, str]:
    env = load_env()
    candidates = [
        ("TASKNODE_SERVICE_SEED", env.get("TASKNODE_SERVICE_SEED")),
        ("TASKNODE_ENCRYPTION_SEED", env.get("TASKNODE_ENCRYPTION_SEED")),
        ("TASKNODE_PFT_FAUCET_SEED", env.get("TASKNODE_PFT_FAUCET_SEED")),
        ("FAUCET_SEED", env.get("FAUCET_SEED")),
    ]
    for name, value in candidates:
        seed = str(value or "").strip()
        if seed:
            return name, seed
    raise RuntimeError(
        "Missing TaskNode service seed. Configure TASKNODE_SERVICE_SEED, "
        "TASKNODE_ENCRYPTION_SEED, TASKNODE_PFT_FAUCET_SEED, or FAUCET_SEED."
    )


def normalize_message_key(value: str | None) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    return message_key_from_x25519_public_key(x25519_public_key_from_message_key(text))


def build_status(client: PftlClient, seed_source: str, seed: str) -> dict[str, Any]:
    wallet = Wallet.from_seed(seed)
    identity = tasknode_identity_from_seed(seed)
    expected_message_key = identity.message_key
    current_message_key = normalize_message_key(client.account_message_key(wallet.address))
    return {
        "serviceAddress": wallet.address,
        "seedSource": seed_source,
        "expectedMessageKey": expected_message_key,
        "currentMessageKey": current_message_key,
        "messageKeyMatches": current_message_key == expected_message_key,
        "messageKeyPublished": bool(current_message_key),
        "expectedX25519PublicKey": identity.public_key_b64,
        "expectedRecipientId": identity.recipient_id,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    if not config.rpc_url:
        raise RuntimeError("Missing PFTL_RPC_URL")
    seed_source, seed = service_seed_from_env()
    wallet = Wallet.from_seed(seed)
    client = PftlClient(config.rpc_url)
    status = build_status(client, seed_source, seed)

    if not args.publish:
        return {
            **status,
            "rpcUrl": config.rpc_url,
            "changed": False,
            "action": "status",
        }

    current_message_key = status["currentMessageKey"]
    expected_message_key = status["expectedMessageKey"]
    if current_message_key == expected_message_key:
        return {
            **status,
            "rpcUrl": config.rpc_url,
            "changed": False,
            "action": "already_published",
        }
    if current_message_key and not args.replace:
        raise RuntimeError(
            "TaskNode service wallet already has a different MessageKey. "
            "Re-run with --replace only after confirming the advertised key is wrong."
        )

    tx = client.submit_message_key(wallet, expected_message_key)
    if args.settle_seconds > 0:
        time.sleep(args.settle_seconds)
    updated = build_status(client, seed_source, seed)
    if not updated["messageKeyMatches"]:
        raise RuntimeError("Published MessageKey did not resolve to the expected service encryption key.")
    return {
        **updated,
        "rpcUrl": config.rpc_url,
        "changed": True,
        "action": "published",
        "txHash": tx.tx_hash,
        "ledgerIndex": tx.ledger_index,
        "result": tx.result,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect or publish the TaskNode service wallet encryption MessageKey on PFTL."
    )
    parser.add_argument("--publish", action="store_true", help="Submit AccountSet MessageKey if missing.")
    parser.add_argument("--replace", action="store_true", help="Replace a mismatched existing MessageKey.")
    parser.add_argument("--settle-seconds", type=float, default=1.5)
    return parser.parse_args()


def main() -> None:
    try:
        result = run(parse_args())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        raise SystemExit(1)

    display = {
        **result,
        "expectedMessageKeyShort": short(result.get("expectedMessageKey", "")),
        "currentMessageKeyShort": short(result.get("currentMessageKey", "")),
    }
    print(json.dumps({"ok": True, **display}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
