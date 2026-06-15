from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import stat
from typing import Any
from urllib.parse import urljoin

import requests
from xrpl.core.binarycodec import decode, encode, encode_for_signing
from xrpl.core.keypairs import derive_classic_address, is_valid_message, sign as sign_message_hex
from xrpl.models.transactions import Memo, Payment, Transaction
from xrpl.transaction import sign as sign_transaction

from .codec import sha256_hex, sha256_hex_bytes
from .encryption import encrypt_json_bytes
from .pointers import Pointer, build_memo, extract_pointer_memos
from .wallets import ProtocolWallet, wallet_from_seed


DEFAULT_BASE_URL = "http://localhost:5174"
DEFAULT_SECRET_FILE = "/home/pfrpc/repos/tasknode_agent_wallets.json"
DEFAULT_PFTL_NETWORK_ID = 21338
TASKNODE_AGENT_DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"


class TaskNodeApiError(RuntimeError):
    def __init__(self, status_code: int, body: Any, message: str | None = None):
        self.status_code = int(status_code)
        self.body = body
        reason = message or ""
        if not reason and isinstance(body, dict):
            reason = str(body.get("message") or body.get("error") or "")
        super().__init__(reason or f"Task Node API returned HTTP {self.status_code}")


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


@dataclass
class SignedFlowResult:
    config: dict[str, Any]
    prepared: dict[str, Any]
    signed: SignedTransaction
    payload: dict[str, Any]
    submitted: dict[str, Any] | None = None

    @property
    def submit_skipped(self) -> bool:
        return self.submitted is None


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_text(value: Any = "", limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _body_json(response: Any) -> Any:
    try:
        return response.json()
    except Exception:
        return getattr(response, "text", "")


def message_to_hex(message: str) -> str:
    return str(message or "").encode("utf-8").hex().upper()


def event_id_for(payload: dict[str, Any]) -> str:
    digest = sha256_hex(payload)
    return f"evt_{digest[:24]}"


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


def _require_0600(path: str) -> None:
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise PermissionError(f"{path} must not be readable by group/other")


def _wallet_entries_from_secret(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [entry for entry in data if isinstance(entry, dict)]
    if isinstance(data, dict):
        for key in ("wallets", "agentWallets", "agents"):
            if isinstance(data.get(key), list):
                return [entry for entry in data[key] if isinstance(entry, dict)]
        entries = []
        for key, value in data.items():
            if isinstance(value, dict):
                entry = {**value}
                entry.setdefault("address", key)
                entries.append(entry)
        if entries:
            return entries
    raise ValueError("agent wallet secret file must contain wallet entries")


def load_agent_wallets(path: str = DEFAULT_SECRET_FILE, *, strict_permissions: bool = True) -> list[ProtocolWallet]:
    if strict_permissions:
        _require_0600(path)
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    wallets = []
    for index, entry in enumerate(_wallet_entries_from_secret(data)):
        seed = entry.get("mnemonic") or entry.get("seed") or entry.get("secret")
        if not seed:
            continue
        role = str(entry.get("role") or entry.get("label") or f"agent_{index + 1}")
        wallet = wallet_from_seed(role, str(seed))
        expected_address = str(entry.get("address") or entry.get("classicAddress") or "").strip()
        if expected_address and expected_address != wallet.address:
            raise ValueError(f"agent wallet entry {index + 1} address mismatch")
        wallets.append(wallet)
    if not wallets:
        raise ValueError("no agent wallets found in secret file")
    return wallets


def load_agent_wallet(
    path: str = DEFAULT_SECRET_FILE,
    *,
    address: str | None = None,
    index: int = 0,
    strict_permissions: bool = True,
) -> ProtocolWallet:
    wallets = load_agent_wallets(path, strict_permissions=strict_permissions)
    if address:
        wanted = str(address).strip()
        for wallet in wallets:
            if wallet.address == wanted:
                return wallet
        raise ValueError("requested agent wallet address was not found")
    return wallets[int(index)]


class TaskNodeAgentClient:
    def __init__(
        self,
        wallet: ProtocolWallet,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30,
        http: requests.Session | None = None,
    ):
        self.wallet = wallet
        self.base_url = str(base_url or DEFAULT_BASE_URL).rstrip("/") + "/"
        self.timeout = timeout
        self.http = http or requests.Session()
        self.account_id: str | None = None
        self.session_expires_at: str | None = None

    @property
    def address(self) -> str:
        return self.wallet.address

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, str(path or "").lstrip("/"))

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        auth: bool = True,
        allow_error: bool = False,
        relogin: bool = True,
    ) -> Any:
        if auth and not self.account_id:
            self.login()
        response = self.http.request(
            method.upper(),
            self._url(path),
            json=json_body,
            params=params,
            timeout=self.timeout,
        )
        body = _body_json(response)
        status_code = int(getattr(response, "status_code", getattr(response, "status", 0)) or 0)
        if status_code == 401 and auth and relogin:
            self.login()
            return self.request(
                method,
                path,
                json_body=json_body,
                params=params,
                auth=auth,
                allow_error=allow_error,
                relogin=False,
            )
        if status_code >= 400 and not allow_error:
            raise TaskNodeApiError(status_code, body)
        return body

    def login(self) -> dict[str, Any]:
        start_response = self.http.request(
            "POST",
            self._url("/api/auth/wallet/start"),
            json={"address": self.wallet.address, "publicKey": self.wallet.wallet.public_key},
            timeout=self.timeout,
        )
        start = _body_json(start_response)
        start_status = int(getattr(start_response, "status_code", getattr(start_response, "status", 0)) or 0)
        if start_status >= 400:
            raise TaskNodeApiError(start_status, start)
        challenge = start.get("challenge") if isinstance(start, dict) else None
        if not challenge or not challenge.get("id") or not challenge.get("message"):
            raise TaskNodeApiError(start_status or 500, start, "wallet login challenge response was incomplete")

        proof = sign_wallet_login_challenge(self.wallet, challenge["message"])
        verify_response = self.http.request(
            "POST",
            self._url("/api/auth/wallet/verify"),
            json={
                "challengeId": challenge["id"],
                "address": proof["address"],
                "publicKey": proof["publicKey"],
                "signature": proof["signature"],
            },
            timeout=self.timeout,
        )
        verified = _body_json(verify_response)
        verify_status = int(getattr(verify_response, "status_code", getattr(verify_response, "status", 0)) or 0)
        if verify_status >= 400:
            raise TaskNodeApiError(verify_status, verified)
        if not isinstance(verified, dict) or not verified.get("accountId"):
            raise TaskNodeApiError(verify_status or 500, verified, "wallet login verification response was incomplete")
        self.account_id = str(verified["accountId"])
        session = verified.get("session") or {}
        self.session_expires_at = session.get("expiresAt") or session.get("expires_at")
        return verified

    def tasks(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks", params=params)

    def task_detail(self, task_id: str, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks/detail", params={"taskId": task_id, **params})

    def hive_projects(self) -> dict[str, Any]:
        return self.request("GET", "/api/hive/projects")

    def hive_context(self, *, limit: int = 120, agent_logs: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if agent_logs:
            params["agentLogs"] = agent_logs
        return self.request("GET", "/api/hive/context", params=params)

    def hive_say(self, message: str, *, conversation_id: str = "agent-phase1a") -> dict[str, Any]:
        return self.request(
            "POST",
            "/api/hive/context",
            json_body={"message": message, "conversationId": conversation_id, "conversationTitle": "Agent"},
        )

    def profile(self) -> dict[str, Any]:
        return self.request("GET", "/api/profile/identity")

    def profile_identity(self) -> dict[str, Any]:
        return self.request("GET", "/api/profile/identity")

    def public_profile(self) -> dict[str, Any]:
        return self.request("GET", "/api/profile/public")

    def memory(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/memory", params=params)

    def network_task_profile(self, *, force: bool = False) -> dict[str, Any]:
        method = "POST" if force else "GET"
        return self.request(method, "/api/memory/network-task-profile")

    def ensure_eligible(self) -> dict[str, Any]:
        profile = self.network_task_profile(force=True)
        tasks = self.tasks()
        eligibility = tasks.get("networkTasks") or tasks.get("networkTaskEligibility") or {}
        gates = eligibility.get("gates") or eligibility.get("gateView") or []
        return {
            "profile": profile,
            "tasks": tasks,
            "status": eligibility.get("status") or eligibility.get("networkStatus") or tasks.get("networkStatus"),
            "gates": gates,
        }

    def context_document(self) -> dict[str, Any]:
        return self.request("GET", "/api/context")

    def save_context(self, *, title: str, body: str, revision: int | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title, "body": body}
        if revision is not None:
            payload["revision"] = revision
        return self.request("POST", "/api/context/edit/save", json_body=payload)

    def publish_context(self, *, title: str, body: str, revision: int = 0, submit: bool = False) -> SignedFlowResult:
        config = self.request("POST", "/api/context/manifest/ink", json_body={"phase": "config"})
        payload = {
            "schema": "tasknode.context.v1",
            "title": _safe_text(title or "Task Node Context", 120),
            "body": str(body or ""),
            "body_format": "html",
            "revision": int(revision or 0),
            "published_at": _utcnow(),
        }
        encrypted = tasknode_encrypted_payload(
            payload,
            wallet=self.wallet,
            tasknode_encryption_pubkey=config["tasknodeEncryptionPubkey"],
        )
        prepared = self.request(
            "POST",
            "/api/context/manifest/ink",
            json_body={
                "phase": "prepare",
                "encryptedPayload": encrypted,
                "title": payload["title"],
                "body": payload["body"],
                "wordCount": len(payload["body"].split()),
            },
        )
        signed = sign_prepared_transaction(prepared["txJson"], self.wallet, expected_address=self.wallet.address)
        submitted = None
        if submit:
            submitted = self.request(
                "POST",
                "/api/context/manifest/ink",
                json_body={
                    "phase": "submit",
                    "cid": prepared.get("cid"),
                    "signedTxBlob": signed.tx_blob,
                    "pointer": prepared.get("pointer"),
                    "context": prepared.get("context"),
                    "transaction": prepared.get("transaction"),
                },
            )
        return SignedFlowResult(config=config, prepared=prepared, signed=signed, payload=payload, submitted=submitted)

    def accept_task(
        self,
        task_id: str,
        *,
        reason: str = "",
        detail: dict[str, Any] | None = None,
        submit: bool = False,
    ) -> SignedFlowResult:
        return self._task_action(task_id, task_action="accept", reason=reason, detail=detail, submit=submit)

    def _task_action(
        self,
        task_id: str,
        *,
        task_action: str,
        reason: str = "",
        detail: dict[str, Any] | None = None,
        submit: bool = False,
    ) -> SignedFlowResult:
        task_id = _safe_text(task_id, 180)
        config = self.request(
            "POST",
            "/api/tasks/action",
            json_body={"phase": "config", "taskId": task_id, "taskAction": task_action},
        )
        transition = "accepted" if task_action == "accept" else "refused" if task_action == "refuse" else "cancelled"
        wallets = (detail or {}).get("wallets") or config.get("wallets") or {}
        created_at = _utcnow()
        base_payload = {
            "schema": "pf.task.update.v1",
            "protocol": "tasknode.pftl",
            "created_at": created_at,
            "chain": "pftl-testnet",
            "task_id": task_id,
            "actor_wallet": self.wallet.address,
            "subject_wallet": self.wallet.address,
            "authority_wallet": wallets.get("authority") or "",
            "allocation_wallet": wallets.get("allocation") or "",
            "transition": transition,
            "status_after": transition,
            "reason": _safe_text(reason, 2000) or "Agent accepted the task.",
            f"{transition}_at": created_at,
        }
        payload = {**base_payload, "event_id": event_id_for(base_payload)}
        encrypted = tasknode_encrypted_payload(
            payload,
            wallet=self.wallet,
            tasknode_encryption_pubkey=config["tasknodeEncryptionPubkey"],
        )
        prepared = self.request(
            "POST",
            "/api/tasks/action",
            json_body={"phase": "prepare", "taskId": task_id, "taskAction": task_action, "encryptedPayload": encrypted},
        )
        signed = sign_prepared_transaction(prepared["txJson"], self.wallet, expected_address=self.wallet.address)
        submitted = None
        if submit:
            submitted = self.request(
                "POST",
                "/api/tasks/action",
                json_body={
                    "phase": "submit",
                    "taskId": task_id,
                    "taskAction": task_action,
                    "cid": prepared.get("cid"),
                    "signedTxBlob": signed.tx_blob,
                    "pointer": prepared.get("pointer"),
                    "transaction": prepared.get("transaction"),
                },
            )
        return SignedFlowResult(config=config, prepared=prepared, signed=signed, payload=payload, submitted=submitted)

    def submit_evidence(
        self,
        task_id: str,
        *,
        evidence_text: str,
        notes: str = "",
        verification_response: bool = False,
        submit: bool = False,
    ) -> SignedFlowResult:
        return self._task_submission(
            task_id,
            evidence_text=evidence_text,
            notes=notes,
            verification_response=verification_response,
            submit=submit,
        )

    def respond_verification(
        self,
        task_id: str,
        *,
        response_text: str,
        notes: str = "",
        submit: bool = False,
    ) -> SignedFlowResult:
        return self._task_submission(
            task_id,
            evidence_text=response_text,
            notes=notes,
            verification_response=True,
            submit=submit,
        )

    def _task_submission(
        self,
        task_id: str,
        *,
        evidence_text: str,
        notes: str = "",
        verification_response: bool = False,
        submit: bool = False,
    ) -> SignedFlowResult:
        task_id = _safe_text(task_id, 180)
        config = self.request("POST", "/api/tasks/submission", json_body={"phase": "config", "taskId": task_id})
        mode = "verification_response" if verification_response else config.get("submissionMode") or "initial_submission"
        schema = "pf.task.verification_response.v1" if mode == "verification_response" else "pf.task.submission.v1"
        wallets = config.get("wallets") or {}
        created_at = _utcnow()
        evidence = {
            "index": 1,
            "artifact_type": "text",
            "value": _safe_text(evidence_text, 120000),
            "notes": _safe_text(notes, 8000),
        }
        base_payload = {
            "schema": schema,
            "protocol": "tasknode.pftl",
            "created_at": created_at,
            "chain": "pftl-testnet",
            "task_id": task_id,
            "actor_wallet": self.wallet.address,
            "subject_wallet": self.wallet.address,
            "authority_wallet": wallets.get("authority") or "",
            "allocation_wallet": wallets.get("allocation") or "",
            "phase": mode,
            "artifact_type": "text",
            "evidence_type": "text",
            "evidence_count": 1,
            "evidence_items": [evidence],
            "evidence": evidence,
        }
        if mode == "verification_response":
            base_payload["responded_at"] = created_at
            base_payload["response_text"] = _safe_text(evidence_text, 120000)
            base_payload["response"] = evidence
        else:
            base_payload["submitted_at"] = created_at
            base_payload["submission"] = evidence
        payload = {**base_payload, "event_id": event_id_for(base_payload)}
        encrypted = tasknode_encrypted_payload(
            payload,
            wallet=self.wallet,
            tasknode_encryption_pubkey=config["tasknodeEncryptionPubkey"],
        )
        prepared = self.request(
            "POST",
            "/api/tasks/submission",
            json_body={"phase": "prepare", "taskId": task_id, "encryptedPayload": encrypted},
        )
        signed = sign_prepared_transaction(prepared["txJson"], self.wallet, expected_address=self.wallet.address)
        submitted = None
        if submit:
            submitted = self.request(
                "POST",
                "/api/tasks/submission",
                json_body={
                    "phase": "submit",
                    "taskId": task_id,
                    "cid": prepared.get("cid"),
                    "signedTxBlob": signed.tx_blob,
                    "pointer": prepared.get("pointer"),
                    "transaction": prepared.get("transaction"),
                },
            )
        return SignedFlowResult(config=config, prepared=prepared, signed=signed, payload=payload, submitted=submitted)

    def request_task(
        self,
        *,
        user_detail_text: str = "",
        requested_task_kind: str = "personal",
        conversation_id: str = "",
        submit: bool = False,
    ) -> SignedFlowResult:
        request_payload = {
            "phase": "config",
            "conversationId": conversation_id,
            "userDetailText": _safe_text(user_detail_text, 8000),
            "requestedTaskKind": requested_task_kind,
            "source": "agent_capability_client",
            "sourceConversationTitle": "Agent",
            "attachments": [],
        }
        config = self.request("POST", "/api/tasks/request", json_body=request_payload)
        encrypted_bundle = tasknode_encrypted_payload(
            config["requestBundle"],
            wallet=self.wallet,
            tasknode_encryption_pubkey=config["tasknodeEncryptionPubkey"],
        )
        bundle_prepared = self.request(
            "POST",
            "/api/tasks/request",
            json_body={**request_payload, "phase": "prepare_bundle", "encryptedBundlePayload": encrypted_bundle},
        )
        created_at = _utcnow()
        event_base = {
            "schema": "pf.task.request.v1",
            "protocol": "tasknode.pftl",
            "created_at": created_at,
            "chain": config.get("chain") or "pftl-testnet",
            "request_id": config.get("requestId") or "",
            "actor_wallet": self.wallet.address,
            "subject_wallet": self.wallet.address,
            "authority_wallet": (config.get("wallets") or {}).get("authority") or config.get("tasknodeServiceAddress") or "",
            "allocation_wallet": "",
            "request_bundle": {
                "bundle_id": config.get("bundleId") or "",
                "cid": bundle_prepared.get("bundleCid") or "",
                "digest": bundle_prepared.get("bundleDigest") or "",
            },
            "request_text": config.get("requestText") or "",
            "user_detail_text": config.get("userDetailText") or _safe_text(user_detail_text, 8000),
            "requested_task_kind": config.get("requestedTaskKind") or requested_task_kind,
        }
        event_payload = {**event_base, "event_id": event_id_for(event_base)}
        encrypted_event = tasknode_encrypted_payload(
            event_payload,
            wallet=self.wallet,
            tasknode_encryption_pubkey=config["tasknodeEncryptionPubkey"],
        )
        prepared = self.request(
            "POST",
            "/api/tasks/request",
            json_body={
                **request_payload,
                "phase": "prepare",
                "bundleCid": bundle_prepared.get("bundleCid"),
                "bundleDigest": bundle_prepared.get("bundleDigest"),
                "encryptedEventPayload": encrypted_event,
            },
        )
        signed = sign_prepared_transaction(prepared["txJson"], self.wallet, expected_address=self.wallet.address)
        submitted = None
        if submit:
            submitted = self.request(
                "POST",
                "/api/tasks/request",
                json_body={
                    **request_payload,
                    "phase": "submit",
                    "cid": prepared.get("cid"),
                    "eventCid": prepared.get("cid"),
                    "bundleCid": bundle_prepared.get("bundleCid"),
                    "bundleDigest": bundle_prepared.get("bundleDigest"),
                    "signedTxBlob": signed.tx_blob,
                    "pointer": prepared.get("pointer"),
                    "transaction": prepared.get("transaction"),
                },
            )
        return SignedFlowResult(config=config, prepared=prepared, signed=signed, payload=event_payload, submitted=submitted)
