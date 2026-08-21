from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class QueueEntry:
    idempotency_key: str
    status: str = "prepared"
    result: object | None = None
    error: str | None = None


@dataclass
class WalletTxQueue:
    wallet_address: str
    entries: list[QueueEntry] = field(default_factory=list)

    def run(self, idempotency_key: str, fn: Callable[[], object]) -> object:
        entry = QueueEntry(idempotency_key=idempotency_key, status="prepared")
        self.entries.append(entry)
        try:
            entry.status = "submitted"
            entry.result = fn()
            entry.status = "confirmed"
            return entry.result
        except Exception as exc:
            entry.status = "failed_retryable"
            entry.error = f"{type(exc).__name__}: {exc}"
            raise

