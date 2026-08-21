from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from tasknode_pftl.codec import canonical_json, now_iso, sha256_hex, short
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.encryption import (
    X25519Identity,
    decrypt_json_bytes,
    encrypt_json_bytes,
    generate_identity,
    x25519_public_key_b64_from_message_key,
)
from tasknode_pftl.ipfs import IpfsClient
from tasknode_pftl.pftl import PftlClient, drops_to_pft
from tasknode_pftl.pointers import Pointer
from tasknode_pftl.wallets import (
    ProtocolWallet,
    create_protocol_wallet,
    fund_wallets,
    publish_wallet_message_keys,
)


ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = ROOT / "runs"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


def public_wallets(wallets: list[ProtocolWallet]) -> list[dict[str, Any]]:
    return [wallet.public_seedless for wallet in wallets]


def private_wallets(wallets: list[ProtocolWallet]) -> list[dict[str, Any]]:
    return [wallet.private_descriptor for wallet in wallets]


def resolve_onchain_recipient_keys(client: PftlClient, wallets: list[ProtocolWallet]) -> list[dict[str, str]]:
    resolved = []
    for wallet in wallets:
        message_key = client.account_message_key(wallet.address)
        if not message_key:
            raise RuntimeError(f"{wallet.role} wallet has no PFTL MessageKey: {wallet.address}")
        public_key_b64 = x25519_public_key_b64_from_message_key(message_key)
        resolved.append({
            "role": wallet.role,
            "address": wallet.address,
            "message_key": message_key,
            "x25519_public_key": public_key_b64,
            "recipient_id": sha256_hex(bytes.fromhex(message_key[2:] if message_key.startswith("ED") else message_key)),
        })
    return resolved


def decryptions_for_wallets(blob: dict[str, Any], wallets: list[ProtocolWallet]) -> dict[str, dict[str, Any]]:
    out = {}
    for wallet in wallets:
        plaintext = decrypt_json_bytes(blob, wallet.encryption)
        parsed = json.loads(plaintext)
        out[wallet.role] = {
            "ok": True,
            "address": wallet.address,
            "schema": parsed.get("schema"),
            "request_id": parsed.get("request_id"),
            "body_contains_private_task": "encrypted task request" in canonical_json(parsed),
        }
    return out


def run_demo(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    config.require_pftl_ipfs()

    run_id = args.run_id or f"encryption_pubkey_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    client = PftlClient(config.rpc_url)
    ipfs = IpfsClient(config)

    user_wallet = create_protocol_wallet("user")
    authority_wallet = create_protocol_wallet("task_authority")
    allocation_wallet = create_protocol_wallet("allocation_reward")
    wallets = [user_wallet, authority_wallet, allocation_wallet]
    outsider = generate_identity("outsider")

    print(f"PFTL network: {config.network_name}")
    print(f"RPC: {config.rpc_url}")
    print("Created wallets:")
    for wallet in wallets:
        print(f"  {wallet.role}: {wallet.address}")

    funding = fund_wallets(client, config.faucet_seed, wallets, target_pft=args.fund_pft)
    print("Funding complete:")
    for item in funding:
        print(f"  {item['address']}: {drops_to_pft(item['balance_drops']):,.6f} PFT")

    key_publications = publish_wallet_message_keys(client, wallets)
    print("MessageKey publication complete:")
    for item in key_publications:
        state = "already set" if item.get("already_published") else "published"
        print(f"  {item['role']}: {state} {short(item['message_key'])}")

    resolved_recipients = resolve_onchain_recipient_keys(client, wallets)
    recipient_keys = [entry["x25519_public_key"] for entry in resolved_recipients]

    task_request = {
        "schema": "pf.task.request.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "request_id": f"req_{sha256_hex(run_id)[:24]}",
        "actor_wallet": user_wallet.address,
        "subject_wallet": user_wallet.address,
        "authority_wallet": authority_wallet.address,
        "allocation_wallet": allocation_wallet.address,
        "request_text": "Issue an encrypted task request that proves wallet MessageKey publication and recipient-key resolution.",
        "chat_packet": {
            "summary": "A new user is learning how PFTL wallet pubkeys work for encrypted task payloads.",
            "recent_user_message": "Please show how new wallets publish pubkeys and how encrypted task payloads are shared.",
            "recent_assistant_response": "The canonical path is to publish X25519 pubkeys as PFTL MessageKey and encrypt IPFS payloads to those resolved keys.",
        },
        "context_doc": {
            "content": (
                "This is private encrypted task request context. It should be present only after decrypting "
                "the IPFS payload with a wallet whose MessageKey was included as a recipient."
            ),
        },
    }
    encrypted = encrypt_json_bytes(canonical_json(task_request).encode("utf-8"), recipient_keys)
    encrypted_json = canonical_json(encrypted)
    plaintext_json = canonical_json(task_request)
    if plaintext_json in encrypted_json or task_request["context_doc"]["content"] in encrypted_json:
        raise RuntimeError("encrypted payload leaked plaintext")

    pin = ipfs.upload_json(
        encrypted,
        name=f"{run_id}-encrypted-task-request",
        keyvalues={
            "content_kind": "TASK",
            "scenario": "encryption_pubkey_demo",
            "request_id": task_request["request_id"],
        },
    )
    pointer_tx = client.submit_payment(
        user_wallet.wallet,
        authority_wallet.address,
        "1",
        pointer=Pointer(cid=pin["cid"], kind="TASK", schema=1, task_id=task_request["request_id"]),
    )

    fetched_blob = ipfs.fetch_json(pin["cid"])
    decryptions = decryptions_for_wallets(fetched_blob, wallets)
    outsider_rejection = ""
    try:
        decrypt_json_bytes(fetched_blob, outsider)
    except Exception as exc:
        outsider_rejection = str(exc)
    if not outsider_rejection:
        raise RuntimeError("outsider unexpectedly decrypted the encrypted task payload")

    public_receipt = {
        "run_id": run_id,
        "network": {
            "name": config.network_name,
            "rpc_url": config.rpc_url,
            "note": "PFTL is its own Post Fiat L1; xrpl-py is used only as the PFTL wire library.",
        },
        "wallets": public_wallets(wallets),
        "funding": funding,
        "message_keys": key_publications,
        "resolved_recipients_from_chain": resolved_recipients,
        "encrypted_payload": {
            "cid": pin["cid"],
            "sha256": pin["sha256"],
            "size_bytes": pin["size_bytes"],
            "enc": fetched_blob.get("enc"),
            "recipient_count": len(fetched_blob.get("recipients") or []),
            "plaintext_absent_from_ipfs_json": plaintext_json not in canonical_json(fetched_blob)
                and task_request["context_doc"]["content"] not in canonical_json(fetched_blob),
        },
        "pointer_tx": {
            "tx_hash": pointer_tx.tx_hash,
            "result": pointer_tx.result,
            "ledger_index": pointer_tx.ledger_index,
            "sender": pointer_tx.sender,
            "destination": pointer_tx.destination,
            "amount_drops": pointer_tx.amount_drops,
        },
        "decryptions": decryptions,
        "outsider_rejection": outsider_rejection,
    }
    private_receipt = {
        "run_id": run_id,
        "wallets": private_wallets(wallets),
        "outsider": outsider.private_descriptor(),
    }

    write_json(run_dir / "encryption_pubkey_demo_public.json", public_receipt)
    write_json(run_dir / "encryption_pubkey_demo_private.json", private_receipt)

    print("\nEncryption pubkey demo complete")
    print(f"  run_id: {run_id}")
    print(f"  encrypted_cid: {pin['cid']}")
    print(f"  pointer_tx: {pointer_tx.tx_hash}")
    print(f"  recipients: {len(resolved_recipients)}")
    print(f"  outsider_rejection: {outsider_rejection}")
    print(f"  public_receipt: {run_dir / 'encryption_pubkey_demo_public.json'}")
    print(f"  private_receipt: {run_dir / 'encryption_pubkey_demo_private.json'}")
    return public_receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Demonstrate PFTL MessageKey publication and encrypted task payload sharing.")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--fund-pft", type=float, default=15.0)
    return parser.parse_args()


def main() -> None:
    run_demo(parse_args())


if __name__ == "__main__":
    main()
