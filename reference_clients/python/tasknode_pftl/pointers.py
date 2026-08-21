from __future__ import annotations

from dataclasses import dataclass
from typing import Any

POINTER_MEMO_TYPE = "pf.ptr"
POINTER_MEMO_FORMAT = "v4"
POINTER_MEMO_TYPE_HEX = POINTER_MEMO_TYPE.encode("utf-8").hex()
POINTER_MEMO_FORMAT_HEX = POINTER_MEMO_FORMAT.encode("utf-8").hex()

TARGET_CONTENT_BLOB = 1

CONTENT_KIND = {
    "TASK": 1,
    "TASK_UPDATE": 2,
    "TASK_SUBMISSION": 3,
    "CHAT": 4,
    "CONTEXT": 5,
    "REWARD": 6,
    "POLICY": 7,
    "IDENTITY": 8,
    "ASSET": 9,
    "DOCUMENT": 10,
    "SYSTEM": 11,
    "TEST": 99,
}

CONTENT_KIND_BY_ID = {v: k for k, v in CONTENT_KIND.items()}

POINTER_FLAGS = {
    "encrypted": 0x01,
    "public": 0x02,
    "ephemeral": 0x04,
    "tombstone": 0x08,
    "multipart": 0x10,
}


@dataclass
class Pointer:
    cid: str
    kind: str
    schema: int
    task_id: str | None = None
    thread_id: str | None = None
    context_id: str | None = None
    flags: int = POINTER_FLAGS["encrypted"]
    target: int = TARGET_CONTENT_BLOB


def _varint(value: int) -> bytes:
    out = bytearray()
    value = int(value)
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _read_varint(data: bytes, offset: int) -> tuple[int, int]:
    shift = 0
    value = 0
    while True:
        if offset >= len(data):
            raise ValueError("Truncated varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7


def _field_key(field_number: int, wire_type: int) -> bytes:
    return _varint((field_number << 3) | wire_type)


def _string_field(field_number: int, value: str | None) -> bytes:
    if not value:
        return b""
    raw = value.encode("utf-8")
    return _field_key(field_number, 2) + _varint(len(raw)) + raw


def _varint_field(field_number: int, value: int | None) -> bytes:
    if value is None:
        return b""
    return _field_key(field_number, 0) + _varint(int(value))


def _kind_value(kind: str | int) -> int:
    if isinstance(kind, int):
        return kind
    normalized = str(kind).strip().upper().replace("-", "_")
    normalized = normalized.replace("CONTENT_KIND_", "")
    if normalized not in CONTENT_KIND:
        raise ValueError(f"Unknown content kind: {kind}")
    return CONTENT_KIND[normalized]


def encode_pointer(pointer: Pointer) -> bytes:
    if not pointer.cid:
        raise ValueError("Pointer CID is required")
    if not pointer.schema:
        raise ValueError("Pointer schema is required")
    payload = b"".join([
        _string_field(1, pointer.cid),
        _varint_field(2, pointer.target),
        _varint_field(3, _kind_value(pointer.kind)),
        _varint_field(4, pointer.schema),
        _string_field(5, pointer.task_id),
        _string_field(6, pointer.thread_id),
        _string_field(7, pointer.context_id),
        _varint_field(8, pointer.flags),
    ])
    return payload


def decode_pointer(data: bytes) -> dict[str, Any]:
    offset = 0
    out: dict[str, Any] = {}
    while offset < len(data):
        key, offset = _read_varint(data, offset)
        field_number = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, offset = _read_varint(data, offset)
        elif wire_type == 2:
            length, offset = _read_varint(data, offset)
            value = data[offset:offset + length].decode("utf-8")
            offset += length
        else:
            raise ValueError(f"Unsupported pointer wire type: {wire_type}")
        if field_number == 1:
            out["cid"] = value
        elif field_number == 2:
            out["target"] = value
        elif field_number == 3:
            out["kind"] = CONTENT_KIND_BY_ID.get(value, str(value))
            out["kind_id"] = value
        elif field_number == 4:
            out["schema"] = value
        elif field_number == 5:
            out["task_id"] = value
        elif field_number == 6:
            out["thread_id"] = value
        elif field_number == 7:
            out["context_id"] = value
        elif field_number == 8:
            out["flags"] = value
    return out


def build_memo(pointer: Pointer) -> dict[str, str]:
    return {
        "memo_type": POINTER_MEMO_TYPE_HEX,
        "memo_format": POINTER_MEMO_FORMAT_HEX,
        "memo_data": encode_pointer(pointer).hex(),
    }


def _hex_to_text(value: str | None) -> str:
    if not value:
        return ""
    try:
        return bytes.fromhex(value).decode("utf-8")
    except Exception:
        return ""


def extract_pointer_memos(tx: dict[str, Any]) -> list[dict[str, Any]]:
    memos = tx.get("Memos") or tx.get("memos") or []
    out = []
    for index, entry in enumerate(memos):
        memo = entry.get("Memo") if isinstance(entry, dict) else None
        if not memo:
            continue
        memo_type = memo.get("MemoType") or memo.get("memo_type")
        memo_format = memo.get("MemoFormat") or memo.get("memo_format")
        memo_data = memo.get("MemoData") or memo.get("memo_data")
        if _hex_to_text(memo_type) != POINTER_MEMO_TYPE or _hex_to_text(memo_format) != POINTER_MEMO_FORMAT:
            continue
        pointer = decode_pointer(bytes.fromhex(memo_data))
        pointer["memo_index"] = index
        out.append(pointer)
    return out

