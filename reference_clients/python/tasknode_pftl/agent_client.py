from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from http.cookies import SimpleCookie
import json
import os
import stat
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
DEFAULT_SESSION_STORE = "/home/pfrpc/repos/tasknode_agent_sessions.json"
DEFAULT_PFTL_NETWORK_ID = 21338
SESSION_COOKIE_NAME = "tasknode_session"
SESSION_EXPIRY_SKEW_SECONDS = 300
MAX_RATE_LIMIT_SLEEP_SECONDS = 60
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


def _safe_int(value: Any = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


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
    if callable(getter):
        return str(getter(key) or getter(key.lower()) or getter(key.title()) or "")
    return ""


def _parse_iso_datetime(value: str) -> datetime | None:
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


def _session_expires_soon(expires_at: str, *, skew_seconds: int = SESSION_EXPIRY_SKEW_SECONDS) -> bool:
    parsed = _parse_iso_datetime(expires_at)
    if not parsed:
        return True
    return (parsed - datetime.now(timezone.utc)).total_seconds() <= skew_seconds


def _secure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _write_json_0600(path: str, payload: dict[str, Any]) -> None:
    _secure_parent_dir(path)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)
    os.chmod(path, 0o600)


def _read_json_0600(path: str) -> dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise PermissionError(f"{path} must not be readable by group/other")
    with open(path, "r", encoding="utf-8") as handle:
        try:
            data = json.load(handle)
        except json.JSONDecodeError:
            return {}
    return data if isinstance(data, dict) else {}


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
        base_url: str = DEFAULT_BASE_URL,
        seed: str | None = None,
        *,
        timeout: float = 30,
        http: requests.Session | None = None,
        session_store_path: str | None = None,
        sleep_fn=time.sleep,
    ):
        # Seed isolation (H2): load ONE agent seed from an explicit arg or the
        # TASKNODE_AGENT_WALLET_SEED env var. Never read a shared/multi-wallet
        # file here; agents must receive only their own seed.
        resolved_seed = seed if seed is not None else os.environ.get("TASKNODE_AGENT_WALLET_SEED")
        if not resolved_seed:
            raise ValueError("TASKNODE_AGENT_WALLET_SEED is required unless seed= is provided")
        self.wallet = wallet_from_seed("agent", str(resolved_seed))
        self.base_url = str(base_url or DEFAULT_BASE_URL).rstrip("/") + "/"
        self.timeout = timeout
        self.http = http or requests.Session()
        self.account_id: str | None = None
        self.session_expires_at: str | None = None
        self._submitted_once: set[tuple[str, str, str]] = set()
        self.session_store_path = (
            str(session_store_path)
            if session_store_path is not None
            else str(os.environ.get("TASKNODE_AGENT_SESSION_STORE") or DEFAULT_SESSION_STORE)
        )
        self.sleep_fn = sleep_fn
        self._load_cached_session()

    @property
    def address(self) -> str:
        return self.wallet.address

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, str(path or "").lstrip("/"))

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

    def _session_store(self) -> dict[str, Any]:
        if not self.session_store_path:
            return {}
        return _read_json_0600(self.session_store_path)

    def _write_session_store(self, data: dict[str, Any]) -> None:
        if not self.session_store_path:
            return
        _write_json_0600(self.session_store_path, data)

    def _session_token_from_response(self, response: Any) -> str:
        set_cookie = _header_value(_response_headers(response), "set-cookie")
        if set_cookie:
            cookie = SimpleCookie()
            try:
                cookie.load(set_cookie)
                token = cookie.get(SESSION_COOKIE_NAME)
                if token:
                    return str(token.value or "").strip()
            except Exception:
                pass
            marker = f"{SESSION_COOKIE_NAME}="
            start = set_cookie.find(marker)
            if start >= 0:
                value = set_cookie[start + len(marker):].split(";", 1)[0]
                return value.strip()
        cookies = getattr(self.http, "cookies", None)
        getter = getattr(cookies, "get", None)
        if callable(getter):
            return str(getter(SESSION_COOKIE_NAME) or "").strip()
        return ""

    def _install_session_token(self, token: str) -> None:
        normalized = str(token or "").strip()
        if not normalized:
            return
        cookies = getattr(self.http, "cookies", None)
        setter = getattr(cookies, "set", None)
        if callable(setter):
            setter(SESSION_COOKIE_NAME, normalized, path="/")

    def _clear_session_cookie(self) -> None:
        cookies = getattr(self.http, "cookies", None)
        clearer = getattr(cookies, "clear", None)
        if callable(clearer):
            try:
                clearer(domain=None, path="/", name=SESSION_COOKIE_NAME)
            except Exception:
                try:
                    del cookies[SESSION_COOKIE_NAME]
                except Exception:
                    pass

    def _load_cached_session(self) -> bool:
        store = self._session_store()
        entry = store.get(self.wallet.address) if isinstance(store, dict) else None
        if not isinstance(entry, dict):
            return False
        token = str(entry.get("session_token") or "").strip()
        expires_at = str(entry.get("expires_at") or "").strip()
        if not token or _session_expires_soon(expires_at):
            return False
        self._install_session_token(token)
        self.session_expires_at = expires_at
        self.account_id = str(entry.get("account_id") or "cached_session")
        return True

    def _persist_session(self, *, token: str, expires_at: str, account_id: str = "") -> None:
        if not token or not expires_at:
            return
        store = self._session_store()
        store[self.wallet.address] = {
            "session_token": token,
            "expires_at": expires_at,
            "account_id": account_id,
        }
        self._write_session_store(store)

    def _discard_cached_session(self) -> None:
        self._clear_session_cookie()
        self.account_id = None
        self.session_expires_at = None
        if not self.session_store_path or not os.path.exists(self.session_store_path):
            return
        store = self._session_store()
        if self.wallet.address in store:
            del store[self.wallet.address]
            self._write_session_store(store)

    def _reserve_submit(self, flow: str, task_id: str, phase: str) -> None:
        key = (
            _safe_text(flow, 80) or "flow",
            _safe_text(task_id, 180) or "task",
            _safe_text(phase, 80) or "submit",
        )
        if key in self._submitted_once:
            raise TaskNodeApiError(
                409,
                {
                    "ok": False,
                    "error": "agent_double_submit_blocked",
                    "flow": key[0],
                    "taskId": key[1],
                    "phase": key[2],
                    "message": "This client already submitted this flow/task/phase in this process.",
                },
                "agent double submit blocked",
            )
        self._submitted_once.add(key)

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
        response, body, status_code = self._request_with_rate_limit_retry(
            method,
            path,
            json_body=json_body,
            params=params,
        )
        if status_code == 401 and auth and relogin:
            self._discard_cached_session()
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

    def login(self, *, force: bool = False) -> dict[str, Any]:
        if not force and self._load_cached_session():
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
        if not challenge or not challenge.get("id") or not challenge.get("message"):
            raise TaskNodeApiError(start_status or 500, start, "wallet login challenge response was incomplete")

        proof = sign_wallet_login_challenge(self.wallet, challenge["message"])
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
        token = self._session_token_from_response(verify_response)
        if token and self.session_expires_at:
            self._persist_session(token=token, expires_at=self.session_expires_at, account_id=self.account_id)
        return verified

    def tasks(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks", params=params)

    def task_detail(self, task_id: str, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/api/tasks/detail", params={"taskId": task_id, **params})

    def hive_projects(self) -> dict[str, Any]:
        return self.request("GET", "/api/hive/projects")

    def hive_task_detail(self, task_id: str) -> dict[str, Any]:
        return self.request("GET", "/api/hive/task-detail", params={"taskId": _safe_text(task_id, 180)})

    def hive_project_tasks(self) -> list[dict[str, Any]]:
        document = self.hive_projects()
        projects = ((document.get("document") or {}).get("projects") if isinstance(document, dict) else {}) or {}
        tasks: list[dict[str, Any]] = []
        for project_id, project in projects.items():
            if not isinstance(project, dict):
                continue
            project_tasks = project.get("tasks") or []
            if not isinstance(project_tasks, list):
                continue
            for task in project_tasks:
                if not isinstance(task, dict):
                    continue
                tasks.append({
                    **task,
                    "projectId": task.get("projectId") or project.get("id") or project_id,
                    "projectTitle": project.get("title") or project.get("name") or "",
                })
        return tasks

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
            self._reserve_submit("context_publish", "context", f"revision:{revision}")
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

    def ensure_context_published(self, *, title: str, body: str, force: bool = False) -> dict[str, Any]:
        current = self.context_document()
        history = current.get("history") if isinstance(current, dict) else {}
        document = current.get("document") if isinstance(current, dict) else {}
        pointer_count = _safe_int(history.get("pointerCount") if isinstance(history, dict) else 0)
        latest_pointer = history.get("latestContextPointer") if isinstance(history, dict) else None
        revision = _safe_int(document.get("revision") if isinstance(document, dict) else current.get("revision") if isinstance(current, dict) else 0)

        if pointer_count >= 1 and latest_pointer is not None and not force:
            return {
                "published": False,
                "reason": "already_published",
                "pointerCount": pointer_count,
                "revision": revision,
                "latestContextPointer": latest_pointer,
            }

        saved = self.save_context(title=title, body=body, revision=revision)
        saved_document = saved.get("document") if isinstance(saved, dict) else {}
        publish_revision = _safe_int(saved_document.get("revision") if isinstance(saved_document, dict) else revision)
        published = self.publish_context(title=title, body=body, revision=publish_revision, submit=True)

        verified = self.context_document()
        verified_history = verified.get("history") if isinstance(verified, dict) else {}
        verified_document = verified.get("document") if isinstance(verified, dict) else {}
        verified_pointer_count = _safe_int(verified_history.get("pointerCount") if isinstance(verified_history, dict) else 0)
        verified_latest_pointer = verified_history.get("latestContextPointer") if isinstance(verified_history, dict) else None
        if verified_pointer_count < 1 or verified_latest_pointer is None:
            raise TaskNodeApiError(
                502,
                {
                    "ok": False,
                    "error": "context_publish_not_pinned",
                    "message": "Context publish completed but no pinned context pointer was visible on the follow-up read.",
                    "pointerCount": verified_pointer_count,
                    "latestContextPointer": verified_latest_pointer,
                },
                "context publish did not actually pin a context pointer",
            )

        submitted = published.submitted or {}
        return {
            "published": True,
            "revision": _safe_int(verified_document.get("revision") if isinstance(verified_document, dict) else publish_revision),
            "cid": submitted.get("cid") or published.prepared.get("cid"),
            "pointerTx": submitted.get("txHash") or submitted.get("tx_hash") or published.signed.tx_hash,
            "pointerCount": verified_pointer_count,
        }

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
            self._reserve_submit("task_action", task_id, task_action)
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
            self._reserve_submit("task_submission", task_id, mode)
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
        request_payload = {
            **request_payload,
            "requestId": config.get("requestId") or request_payload.get("requestId") or "",
            "bundleId": config.get("bundleId") or request_payload.get("bundleId") or "",
            "requestText": config.get("requestText") or request_payload.get("requestText") or "",
            "userDetailText": config.get("userDetailText") or request_payload.get("userDetailText") or "",
            "requestedTaskKind": config.get("requestedTaskKind") or request_payload.get("requestedTaskKind") or "",
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
            self._reserve_submit(
                "task_request",
                config.get("requestId") or request_payload.get("requestId") or "request",
                "request",
            )
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
