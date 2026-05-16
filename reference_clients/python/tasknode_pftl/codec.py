import base64
import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_hex(value: Any) -> str:
    if isinstance(value, bytes):
        return sha256_hex_bytes(value)
    if isinstance(value, str):
        return sha256_hex_bytes(value.encode("utf-8"))
    return sha256_hex_bytes(canonical_json(value).encode("utf-8"))


def b64e(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def b64d(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"))


def short(value: str, prefix: int = 10, suffix: int = 6) -> str:
    text = str(value or "")
    if len(text) <= prefix + suffix + 3:
        return text
    return f"{text[:prefix]}...{text[-suffix:]}"


def now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

