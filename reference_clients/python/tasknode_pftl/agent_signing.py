from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from typing import Any

from xrpl.core.binarycodec import decode, encode, encode_for_signing
from xrpl.core.keypairs import derive_classic_address, is_valid_message, sign as sign_message_hex
from xrpl.models.transactions import Memo, Payment, Transaction
from xrpl.transaction import sign as sign_transaction

from .codec import sha256_hex, sha256_hex_bytes
from .encryption import encrypt_json_bytes
from .pointers import Pointer, build_memo, extract_pointer_memos
from .wallets import ProtocolWallet


DEFAULT_PFTL_NETWORK_ID = 21338
TASKNODE_AGENT_DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"


@dataclass
class SignedTransaction:
    address: str
    tx_blob: str
    tx_hash: str | None
    tx_json: dict[str, Any]
    verified: bool

    def as_api_payload(self) -> dict[str, Any]:
        return {
            "address": self.address,
            "txBlob": self.tx_blob,
            "txHash": self.tx_hash,
            "verified": self.verified,
        }


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_text(value: Any = "", limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def message_to_hex(message: str) -> str:
    return str(message or "").encode("utf-8").hex().upper()


def event_id_for(payload: dict[str, Any]) -> str:
    digest = sha256_hex(payload)
    return f"evt_{digest[:24]}"


def stable_json(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(stable_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), separators=(",", ":"), ensure_ascii=False) + ":" + stable_json(value[key])
            for key in sorted(value.keys())
        ) + "}"
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def task_transition_signature_message(
    payload: dict[str, Any],
    *,
    role: str = "actor",
    transition: str = "",
    task_id: str = "",
) -> tuple[str, str]:
    digest = f"sha256:{sha256_hex(stable_json(payload))}"
    message = "\n".join([
        "Post Fiat Task Node task transition",
        "Purpose: task_transition",
        f"Role: {_safe_text(role, 80)}",
        f"Task-ID: {_safe_text(task_id or payload.get('task_id') or payload.get('taskId'), 180)}",
        f"Transition: {_safe_text(transition or payload.get('transition') or payload.get('status_after') or payload.get('schema'), 120)}",
        f"Payload-Digest: {digest}",
    ])
    return digest, message


def sign_task_transition(
    wallet: ProtocolWallet,
    payload: dict[str, Any],
    *,
    role: str = "actor",
    transition: str = "",
    task_id: str = "",
) -> dict[str, Any]:
    digest, message = task_transition_signature_message(
        payload,
        role=role,
        transition=transition,
        task_id=task_id,
    )
    return {
        "schema": "pf.task.transition_signature.v1",
        "role": _safe_text(role, 80),
        "task_id": _safe_text(task_id or payload.get("task_id") or payload.get("taskId"), 180),
        "transition": _safe_text(transition or payload.get("transition") or payload.get("status_after") or payload.get("schema"), 120),
        "signer_wallet": wallet.address,
        "public_key": wallet.wallet.public_key,
        "payload_digest": digest,
        "message": message,
        "signature": sign_message_hex(message_to_hex(message), wallet.wallet.private_key),
        "signed_at": _utcnow(),
        "algorithm": "ripple-keypairs.secp256k1",
    }


def direct_signed_transition(wallet: ProtocolWallet) -> SignedTransaction:
    return SignedTransaction(
        address=wallet.address,
        tx_blob="",
        tx_hash=None,
        tx_json={},
        verified=True,
    )


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def tasknode_encrypted_payload(
    payload: dict[str, Any],
    *,
    wallet: ProtocolWallet,
    tasknode_encryption_pubkey: str,
) -> dict[str, Any]:
    plaintext = _json_bytes(payload)
    encrypted = encrypt_json_bytes(plaintext, [wallet.encryption, tasknode_encryption_pubkey])
    return {
        "version": 1,
        **encrypted,
        "content_hash": sha256_hex_bytes(plaintext),
    }


def sign_wallet_login_challenge(wallet: ProtocolWallet, message: str) -> dict[str, str]:
    signature = sign_message_hex(message_to_hex(message), wallet.wallet.private_key)
    return {
        "address": wallet.address,
        "publicKey": wallet.wallet.public_key,
        "signature": signature,
    }


def sign_prepared_transaction(
    tx_json: dict[str, Any],
    wallet: ProtocolWallet,
    *,
    expected_address: str = "",
) -> SignedTransaction:
    if not isinstance(tx_json, dict) or not tx_json:
        raise ValueError("prepared transaction JSON is required")
    account = _safe_text(tx_json.get("Account") or tx_json.get("account"), 120)
    expected = _safe_text(expected_address or account, 120)
    if expected and expected != wallet.address:
        raise ValueError("wallet address does not match expected transaction signer")
    if account and account != wallet.address:
        raise ValueError("prepared transaction Account does not match wallet")

    transaction = Transaction.from_xrpl(tx_json)
    signed = sign_transaction(transaction, wallet.wallet)
    signed_json = signed.to_xrpl()
    tx_blob = encode(signed_json)
    verification = verify_signed_transaction_blob(tx_blob, expected_address=wallet.address)
    return SignedTransaction(
        address=wallet.address,
        tx_blob=tx_blob,
        tx_hash=signed.get_hash(),
        tx_json=signed_json,
        verified=verification["verified"],
    )


def verify_signed_transaction_blob(tx_blob: str, *, expected_address: str = "") -> dict[str, Any]:
    decoded = decode(str(tx_blob or ""))
    signing_pubkey = str(decoded.get("SigningPubKey") or "")
    signature = str(decoded.get("TxnSignature") or "")
    address = derive_classic_address(signing_pubkey) if signing_pubkey else ""
    signing_bytes = bytes.fromhex(encode_for_signing(decoded))
    verified = bool(
        signing_pubkey
        and signature
        and is_valid_message(signing_bytes, bytes.fromhex(signature), signing_pubkey)
        and (not expected_address or address == expected_address)
    )
    return {
        "verified": verified,
        "address": address,
        "signingPubKey": signing_pubkey,
        "txBlobSha256": sha256_hex_bytes(bytes.fromhex(str(tx_blob or ""))).upper(),
        "pointers": extract_pointer_memos(decoded),
    }


def build_synthetic_signed_pointer(
    wallet: ProtocolWallet,
    *,
    kind: str = "TASK_UPDATE",
    schema: int = 1,
    cid: str = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    task_id: str = "task_agent_signing_proof",
    destination: str = TASKNODE_AGENT_DESTINATION,
    network_id: int = DEFAULT_PFTL_NETWORK_ID,
) -> dict[str, Any]:
    if destination == wallet.address:
        raise ValueError("synthetic proof destination must differ from the signing wallet")
    memo = build_memo(Pointer(cid=cid, kind=kind, schema=schema, task_id=task_id))
    payment = Payment(
        account=wallet.address,
        destination=destination,
        amount="1",
        fee="12",
        sequence=1,
        last_ledger_sequence=1000,
        network_id=int(network_id),
        memos=[
            Memo(
                memo_type=memo["memo_type"].upper(),
                memo_format=memo["memo_format"].upper(),
                memo_data=memo["memo_data"].upper(),
            )
        ],
    )
    signed = sign_transaction(payment, wallet.wallet)
    signed_json = signed.to_xrpl()
    tx_blob = encode(signed_json)
    verification = verify_signed_transaction_blob(tx_blob, expected_address=wallet.address)
    return {
        "ok": verification["verified"],
        "kind": kind,
        "schema": schema,
        "taskId": task_id,
        "address": wallet.address,
        "txBlob": tx_blob,
        "txHash": signed.get_hash(),
        "verification": verification,
        "txJson": signed_json,
    }
