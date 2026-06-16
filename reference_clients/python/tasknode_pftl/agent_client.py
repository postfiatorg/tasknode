from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import time
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
DEFAULT_PFTL_NETWORK_ID = 21338
MAX_RATE_LIMIT_SLEEP_SECONDS = 60
SESSION_EXPIRY_SKEW_SECONDS = 300
TASKNODE_AGENT_DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"


class TaskNodeApiError(RuntimeError):
    def __init__(self, status_code: int, body: Any, message: str | None = None):
        self.status_code = int(status_code)
        self.body = _redact_sensitive(body)
        reason = message or ""
        if not reason and isinstance(self.body, dict):
            reason = str(self.body.get("message") or self.body.get("error") or "")
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


def _status_code(response: Any) -> int:
    return int(getattr(response, "status_code", getattr(response, "status", 0)) or 0)


def _response_headers(response: Any) -> Any:
    return getattr(response, "headers", {}) or {}


def _header_value(headers: Any, key: str) -> str:
    if not headers:
        return ""
    getter = getattr(headers, "get", None)
    if not callable(getter):
        return ""
    return str(getter(key) or getter(key.lower()) or getter(key.title()) or "")


def _parse_iso_datetime(value: str | None) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _expires_soon(expires_at: str | None) -> bool:
    parsed = _parse_iso_datetime(expires_at)
    if parsed is None:
        return False
    return (parsed - datetime.now(timezone.utc)).total_seconds() <= SESSION_EXPIRY_SKEW_SECONDS


def _redact_sensitive(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() in {"seed", "mnemonic", "secret", "privatekey", "private_key"}:
                redacted[key] = "[redacted]"
            else:
                redacted[key] = _redact_sensitive(item)
        return redacted
    if isinstance(value, list):
        return [_redact_sensitive(item) for item in value]
    return value


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


class TaskNodeAgentClient:
    def __init__(
        self,
        base_url: str,
        seed: str | None = None,
        *,
        timeout: float = 30,
        http: requests.Session | None = None,
        sleep_fn=time.sleep,
    ):
        resolved_seed = seed if seed is not None else os.environ.get("TASKNODE_AGENT_WALLET_SEED")
        if not resolved_seed:
            raise ValueError("TASKNODE_AGENT_WALLET_SEED is required unless seed= is provided")
        self.wallet = wallet_from_seed("agent", str(resolved_seed))
        self.base_url = str(base_url or DEFAULT_BASE_URL).rstrip("/") + "/"
        self.timeout = timeout
        self.http = http or requests.Session()
        self.sleep_fn = sleep_fn
        self.account_id: str | None = None
        self.session_expires_at: str | None = None
        self._submitted_once: set[tuple[str, str, str]] = set()

    @property
    def address(self) -> str:
        return self.wallet.address

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, str(path or "").lstrip("/"))

    def _clear_session_state(self) -> None:
        self.account_id = None
        self.session_expires_at = None
        cookies = getattr(self.http, "cookies", None)
        clearer = getattr(cookies, "clear", None)
        if callable(clearer):
            try:
                clearer(domain=None, path="/", name="tasknode_session")
            except Exception:
                pass

    def _request_once(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[Any, Any, int]:
        response = self.http.request(
            method.upper(),
            self._url(path),
            json=json_body,
            params=params,
            timeout=self.timeout,
        )
        body = _body_json(response)
        return response, body, _status_code(response)

    def _retry_after_seconds(self, response: Any, body: Any) -> float:
        raw = ""
        if isinstance(body, dict):
            raw = body.get("retryAfterSeconds") or body.get("retry_after_seconds") or ""
        if raw == "":
            raw = _header_value(_response_headers(response), "retry-after")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = 1.0
        return max(0.0, min(float(MAX_RATE_LIMIT_SLEEP_SECONDS), value))

    def _request_with_rate_limit_retry(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[Any, Any, int]:
        response, body, status_code = self._request_once(method, path, json_body=json_body, params=params)
        if status_code != 429:
            return response, body, status_code
        self.sleep_fn(self._retry_after_seconds(response, body))
        return self._request_once(method, path, json_body=json_body, params=params)

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
        if auth:
            self.ensure_session()
        _response, body, status_code = self._request_with_rate_limit_retry(
            method,
            path,
            json_body=json_body,
            params=params,
        )
        if status_code == 401 and auth and relogin:
            self._clear_session_state()
            self.login(force=True)
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

    def ensure_session(self) -> dict[str, Any] | None:
        if self.account_id and not _expires_soon(self.session_expires_at):
            return None
        return self.login(force=True)

    def login(self, *, force: bool = False) -> dict[str, Any]:
        if self.account_id and not force and not _expires_soon(self.session_expires_at):
            return {
                "ok": True,
                "accountId": self.account_id,
                "address": self.wallet.address,
                "session": {"expiresAt": self.session_expires_at},
                "cached": True,
            }
        start_response, start, start_status = self._request_with_rate_limit_retry(
            "POST",
            "/api/auth/wallet/start",
            json_body={"address": self.wallet.address, "publicKey": self.wallet.wallet.public_key},
        )
        if start_status >= 400:
            raise TaskNodeApiError(start_status, start)
        challenge = start.get("challenge") if isinstance(start, dict) else None
        if not isinstance(challenge, dict) or not challenge.get("id") or not challenge.get("message"):
            raise TaskNodeApiError(start_status or 500, start, "wallet login challenge response was incomplete")

        proof = sign_wallet_login_challenge(self.wallet, str(challenge["message"]))
        verify_response, verified, verify_status = self._request_with_rate_limit_retry(
            "POST",
            "/api/auth/wallet/verify",
            json_body={
                "challengeId": challenge["id"],
                "address": proof["address"],
                "publicKey": proof["publicKey"],
                "signature": proof["signature"],
            },
        )
        if verify_status >= 400:
            raise TaskNodeApiError(verify_status, verified)
        if not isinstance(verified, dict) or not verified.get("accountId"):
            raise TaskNodeApiError(verify_status or 500, verified, "wallet login verification response was incomplete")
        self.account_id = str(verified["accountId"])
        session = verified.get("session") or {}
        self.session_expires_at = session.get("expiresAt") or session.get("expires_at")
        return verified

    def list_tasks(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks", params=params)

    def tasks(self, **params: Any) -> dict[str, Any]:
        return self.list_tasks(**params)

    def task_detail(self, task_id: str, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks/detail", params={"taskId": task_id, **params})

    def hive_projects(self) -> dict[str, Any]:
        return self.request("GET", "/api/hive/projects")

    def hive_context(self, *, limit: int = 120, agent_logs: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if agent_logs:
            params["agentLogs"] = agent_logs
        return self.request("GET", "/api/hive/context", params=params)

    def hive_say(self, message: str) -> dict[str, Any]:
        return self.request(
            "POST",
            "/api/hive/context",
            json_body={"message": _safe_text(message, 12000), "conversationTitle": "Agent"},
        )

    def _reserve_submit(self, flow: str, task_id: str, phase: str) -> None:
        key = (_safe_text(flow, 80), _safe_text(task_id, 180), _safe_text(phase, 80))
        if key in self._submitted_once:
            raise TaskNodeApiError(
                409,
                {
                    "ok": False,
                    "error": "agent_double_submit_blocked",
                    "message": "submit=True was already used for this task and phase in this client process",
                },
            )
        self._submitted_once.add(key)

    def accept_task(self, task_id: str, *, submit: bool = False) -> SignedFlowResult:
        """Preview or submit a task-acceptance pointer.

        ``submit=False`` is the default preview mode and does not publish
        anything on-ledger. ``submit=True`` publishes an irreversible PFTL task
        update pointer, guarded against duplicate submit calls in this client.
        """
        return self._task_action(task_id, task_action="accept", reason="Agent accepted the task.", submit=submit)

    def _task_action(
        self,
        task_id: str,
        *,
        task_action: str,
        reason: str,
        submit: bool = False,
    ) -> SignedFlowResult:
        task_id = _safe_text(task_id, 180)
        if submit:
            self._reserve_submit("task_action", task_id, task_action)
        config = self.request(
            "POST",
            "/api/tasks/action",
            json_body={"phase": "config", "taskId": task_id, "taskAction": task_action},
        )
        transition = "accepted" if task_action == "accept" else task_action
        wallets = config.get("wallets") or {}
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
            "reason": _safe_text(reason, 2000),
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

    def submit_evidence(self, task_id: str, evidence: str | dict[str, Any], *, submit: bool = False) -> SignedFlowResult:
        """Preview or submit task evidence.

        ``submit=False`` is the default preview mode and does not publish
        anything on-ledger. ``submit=True`` publishes an irreversible PFTL task
        submission pointer, guarded against duplicate submit calls in this
        client.
        """
        return self._task_submission(task_id, evidence=evidence, verification_response=False, submit=submit)

    def respond_verification(
        self,
        task_id: str,
        response: str | dict[str, Any],
        *,
        submit: bool = False,
    ) -> SignedFlowResult:
        """Preview or submit a verification response.

        ``submit=False`` is the default preview mode and does not publish
        anything on-ledger. ``submit=True`` publishes an irreversible PFTL
        verification-response pointer, guarded against duplicate submit calls
        in this client.
        """
        return self._task_submission(task_id, evidence=response, verification_response=True, submit=submit)

    def _evidence_text_and_notes(self, evidence: str | dict[str, Any]) -> tuple[str, str]:
        if isinstance(evidence, dict):
            text = evidence.get("text") or evidence.get("value") or evidence.get("evidence") or evidence.get("response")
            notes = evidence.get("notes") or ""
            return _safe_text(text, 120000), _safe_text(notes, 8000)
        return _safe_text(evidence, 120000), ""

    def _task_submission(
        self,
        task_id: str,
        *,
        evidence: str | dict[str, Any],
        verification_response: bool,
        submit: bool = False,
    ) -> SignedFlowResult:
        task_id = _safe_text(task_id, 180)
        phase = "verification_response" if verification_response else "evidence"
        if submit:
            self._reserve_submit("task_submission", task_id, phase)
        evidence_text, notes = self._evidence_text_and_notes(evidence)
        config = self.request("POST", "/api/tasks/submission", json_body={"phase": "config", "taskId": task_id})
        mode = "verification_response" if verification_response else config.get("submissionMode") or "initial_submission"
        schema = "pf.task.verification_response.v1" if mode == "verification_response" else "pf.task.submission.v1"
        wallets = config.get("wallets") or {}
        created_at = _utcnow()
        evidence_item = {
            "index": 1,
            "artifact_type": "text",
            "value": evidence_text,
            "notes": notes,
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
            "evidence_items": [evidence_item],
            "evidence": evidence_item,
        }
        if mode == "verification_response":
            base_payload["responded_at"] = created_at
            base_payload["response_text"] = evidence_text
            base_payload["response"] = evidence_item
        else:
            base_payload["submitted_at"] = created_at
            base_payload["submission"] = evidence_item
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
        message: str = "",
        requested_task_kind: str = "personal",
        conversation_id: str = "",
        submit: bool = False,
    ) -> SignedFlowResult:
        """Preview or submit a signed task request.

        ``submit=False`` is the default preview mode and does not publish
        anything on-ledger. ``submit=True`` publishes an irreversible PFTL task
        request pointer, guarded against duplicate submit calls after the
        server assigns a request id.
        """
        request_payload = {
            "phase": "config",
            "conversationId": _safe_text(conversation_id, 180),
            "userDetailText": _safe_text(message, 8000),
            "requestedTaskKind": _safe_text(requested_task_kind or "personal", 80),
            "source": "agent_capability_client",
            "sourceConversationTitle": "Agent",
            "attachments": [],
        }
        config = self.request("POST", "/api/tasks/request", json_body=request_payload)
        request_id = _safe_text(config.get("requestId") or "", 180)
        if submit:
            self._reserve_submit("task_request", request_id or "pending", "request")
        request_payload = {
            **request_payload,
            "requestId": request_id,
            "bundleId": config.get("bundleId") or "",
            "requestText": config.get("requestText") or "",
            "userDetailText": config.get("userDetailText") or request_payload["userDetailText"],
            "requestedTaskKind": config.get("requestedTaskKind") or request_payload["requestedTaskKind"],
        }
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
            "request_id": request_id,
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
            "user_detail_text": request_payload["userDetailText"],
            "requested_task_kind": request_payload["requestedTaskKind"],
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
