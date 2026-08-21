from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any

from xrpl.clients import JsonRpcClient
from xrpl.models.requests import AccountInfo, AccountTx, ServerInfo, Tx
from xrpl.models.transactions import AccountSet, Memo, Payment
from xrpl.transaction import autofill_and_sign, submit
from xrpl.wallet import Wallet

from .pointers import Pointer, build_memo, extract_pointer_memos

PFT_DROPS_PER_PFT = 1_000_000
DEFAULT_TX_TIMEOUT_SECONDS = 45.0
DEFAULT_TX_POLL_SECONDS = 2.0


def pft_to_drops(value: float | int | str) -> str:
    return str(int(round(float(value) * PFT_DROPS_PER_PFT)))


def drops_to_pft(value: int | str) -> float:
    return int(value) / PFT_DROPS_PER_PFT


def pftl_error_result(result: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(result)
    message = sanitized.get("engine_result_message")
    if isinstance(message, str):
        sanitized["engine_result_message"] = message.replace("XRP", "PFT")
    return sanitized


@dataclass
class SubmittedTx:
    tx_hash: str
    result: str
    ledger_index: int | None
    sender: str
    destination: str | None
    amount_drops: str


class PftlClient:
    def __init__(self, rpc_url: str):
        self.rpc_url = rpc_url
        self.client = JsonRpcClient(rpc_url)
        self.network_id = self._load_network_id()

    def _load_network_id(self) -> int | None:
        try:
            response = self.client.request(ServerInfo())
            raw = (response.result or {}).get("info", {}).get("network_id")
            return int(raw) if raw is not None else None
        except Exception:
            return None

    def account_balance_drops(self, address: str) -> int:
        try:
            response = self.client.request(AccountInfo(account=address, ledger_index="validated"))
            result = response.result or {}
            if result.get("error") == "actNotFound" or "account_data" not in result:
                return 0
            return int(result["account_data"]["Balance"])
        except Exception as exc:
            text = str(exc)
            if "actNotFound" in text or "Account not found" in text:
                return 0
            raise

    def account_balance_pft(self, address: str) -> float:
        return drops_to_pft(self.account_balance_drops(address))

    def account_info(self, address: str) -> dict[str, Any]:
        response = self.client.request(AccountInfo(account=address, ledger_index="validated"))
        result = response.result or {}
        if result.get("error") == "actNotFound" or "account_data" not in result:
            return {}
        return result["account_data"]

    def account_message_key(self, address: str) -> str | None:
        value = self.account_info(address).get("MessageKey")
        if not value:
            return None
        return str(value).strip().upper() or None

    def submit_payment(
        self,
        wallet: Wallet,
        destination: str,
        amount_drops: str,
        *,
        pointer: Pointer | None = None,
    ) -> SubmittedTx:
        memos = []
        if pointer:
            memos.append(Memo(**build_memo(pointer)))
        tx = Payment(
            account=wallet.address,
            destination=destination,
            amount=str(amount_drops),
            memos=memos or None,
            network_id=self.network_id,
        )
        result = self._submit_and_wait_bounded(tx, wallet)
        meta = result.get("meta") or {}
        tx_result = meta.get("TransactionResult") or result.get("engine_result") or "unknown"
        tx_hash = result.get("hash") or result.get("tx_json", {}).get("hash") or result.get("tx", {}).get("hash")
        if tx_result != "tesSUCCESS":
            raise RuntimeError(f"PFTL transaction failed: {tx_result} {result}")
        return SubmittedTx(
            tx_hash=tx_hash,
            result=tx_result,
            ledger_index=result.get("ledger_index") or result.get("validated_ledger_index"),
            sender=wallet.address,
            destination=destination,
            amount_drops=str(amount_drops),
        )

    def submit_message_key(self, wallet: Wallet, message_key: str) -> SubmittedTx:
        tx = AccountSet(
            account=wallet.address,
            message_key=str(message_key).strip().upper(),
            network_id=self.network_id,
        )
        result = self._submit_and_wait_bounded(tx, wallet)
        meta = result.get("meta") or {}
        tx_result = meta.get("TransactionResult") or result.get("engine_result") or "unknown"
        tx_hash = result.get("hash") or result.get("tx_json", {}).get("hash") or result.get("tx", {}).get("hash")
        if tx_result != "tesSUCCESS":
            raise RuntimeError(f"PFTL MessageKey transaction failed: {tx_result} {result}")
        return SubmittedTx(
            tx_hash=tx_hash,
            result=tx_result,
            ledger_index=result.get("ledger_index") or result.get("validated_ledger_index"),
            sender=wallet.address,
            destination=None,
            amount_drops="0",
        )

    def _submit_and_wait_bounded(
        self,
        tx: Payment | AccountSet,
        wallet: Wallet,
        *,
        timeout_seconds: float = DEFAULT_TX_TIMEOUT_SECONDS,
        poll_seconds: float = DEFAULT_TX_POLL_SECONDS,
    ) -> dict[str, Any]:
        signed = autofill_and_sign(tx, self.client, wallet, check_fee=False)
        submit_response = submit(signed, self.client)
        submit_result = submit_response.result or {}
        engine_result = submit_result.get("engine_result")
        if engine_result and engine_result not in {"tesSUCCESS", "terQUEUED"}:
            raise RuntimeError(f"PFTL transaction submit failed: {engine_result} {pftl_error_result(submit_result)}")
        tx_hash = (
            submit_result.get("hash")
            or submit_result.get("tx_json", {}).get("hash")
            or submit_result.get("tx", {}).get("hash")
            or signed.get_hash()
        )
        deadline = time.time() + max(1.0, float(timeout_seconds))
        last_error: str | None = None
        while time.time() < deadline:
            try:
                response = self.client.request(Tx(transaction=tx_hash, binary=False))
                result = response.result or {}
                meta = result.get("meta") or {}
                tx_result = meta.get("TransactionResult")
                if tx_result:
                    result.setdefault("hash", tx_hash)
                    return result
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            time.sleep(max(0.2, float(poll_seconds)))
        raise RuntimeError(f"PFTL transaction validation timeout: {tx_hash} {last_error or ''}".strip())

    def account_tx(self, address: str, *, limit: int = 200) -> list[dict[str, Any]]:
        marker = None
        rows: list[dict[str, Any]] = []
        while True:
            request = AccountTx(
                account=address,
                ledger_index_min=-1,
                ledger_index_max=-1,
                binary=False,
                forward=False,
                limit=limit,
                marker=marker,
            )
            response = self.client.request(request)
            result = response.result or {}
            rows.extend(result.get("transactions") or [])
            marker = result.get("marker")
            if not marker:
                return rows

    def pointer_events_for_wallet(self, address: str) -> list[dict[str, Any]]:
        events = []
        for row in self.account_tx(address):
            tx = row.get("tx") or row.get("tx_json") or {}
            meta = row.get("meta") or {}
            tx_hash = tx.get("hash") or row.get("hash")
            for pointer in extract_pointer_memos(tx):
                events.append({
                    **pointer,
                    "wallet": address,
                    "account": tx.get("Account"),
                    "destination": tx.get("Destination"),
                    "amount": tx.get("Amount"),
                    "tx_hash": tx_hash,
                    "ledger_index": row.get("ledger_index") or tx.get("ledger_index"),
                    "validated": row.get("validated"),
                    "transaction_result": meta.get("TransactionResult"),
                })
        return events
