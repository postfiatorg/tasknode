from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Any

from .codec import now_iso, sha256_hex


LOCAL_DOCKER_DATABASE_URL = "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial"
CANONICAL_TASK_REQUEST_TEXT = (
    "Request a task using my current context document, account memory, recent messages, "
    "and the additional task details I just provided."
)


@dataclass
class AppTaskRequestFixture:
    account_id: str
    conversation: dict[str, Any]
    request_message: dict[str, Any]
    receipt_message: dict[str, Any]
    context_document: dict[str, Any]
    recent_messages: list[dict[str, Any]]
    recent_memory: list[dict[str, Any]]
    deep_memory: list[dict[str, Any]]

    @property
    def request_metadata(self) -> dict[str, Any]:
        metadata = self.request_message.get("metadata") or {}
        return metadata if isinstance(metadata, dict) else {}

    @property
    def request_id(self) -> str:
        return str(self.request_metadata.get("requestId") or self.request_message.get("response_id") or "")

    @property
    def bundle_id(self) -> str:
        return str(self.request_metadata.get("bundleId") or "")


def tasknode_database_url(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    return (
        os.environ.get("TASKNODEOFFICIAL_DATABASE_URL")
        or os.environ.get("TASKNODE_APP_DATABASE_URL")
        or os.environ.get("TASKNODE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or LOCAL_DOCKER_DATABASE_URL
    )


def sql_literal(value: str | None) -> str:
    return "'" + str(value or "").replace("'", "''") + "'"


def psql_json(database_url: str, sql: str) -> Any:
    result = subprocess.run(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    output = result.stdout.strip()
    if not output:
        return None
    return json.loads(output)


def load_task_request_fixture(
    *,
    database_url: str | None = None,
    chat_title: str = "task_sample",
    request_id: str | None = None,
    recent_message_limit: int = 24,
    recent_memory_limit: int = 36,
    deep_memory_limit: int = 3,
) -> AppTaskRequestFixture:
    db_url = tasknode_database_url(database_url)
    request_filter = ""
    if request_id:
        request_filter = f"AND request_message.metadata_json->>'requestId' = {sql_literal(request_id)}"

    sql = f"""
WITH selected_conversation AS (
  SELECT *
  FROM chat_conversations
  WHERE title = {sql_literal(chat_title)}
    AND status IN ('active', 'task_request')
    AND deleted_at IS NULL
  ORDER BY updated_at DESC, id DESC
  LIMIT 1
),
selected_request AS (
  SELECT request_message.*
  FROM chat_messages AS request_message
  JOIN selected_conversation AS conversation
    ON conversation.id = request_message.conversation_id
  WHERE request_message.role = 'user'
    AND request_message.metadata_json->>'kind' = 'task_request_intent'
    {request_filter}
  ORDER BY request_message.message_order DESC
  LIMIT 1
),
selected_receipt AS (
  SELECT receipt_message.*
  FROM chat_messages AS receipt_message
  JOIN selected_request AS request_message
    ON receipt_message.conversation_id = request_message.conversation_id
   AND receipt_message.metadata_json->>'kind' = 'task_request_intent'
   AND receipt_message.metadata_json->>'requestId' = request_message.metadata_json->>'requestId'
   AND receipt_message.role = 'assistant'
  ORDER BY message_order DESC
  LIMIT 1
),
context_doc AS (
  SELECT
    document.id,
    document.account_id,
    document.title,
    document.revision,
    document.created_at,
    document.updated_at,
    revision.id AS revision_id,
    COALESCE(revision.body, '') AS body,
    COALESCE(revision.body_sha256, '') AS body_sha256,
    COALESCE(revision.word_count, 0) AS word_count
  FROM context_documents AS document
  LEFT JOIN context_revisions AS revision
    ON revision.id = document.current_revision_id
  JOIN selected_conversation AS conversation
    ON conversation.account_id = document.account_id
  WHERE document.deleted_at IS NULL
  LIMIT 1
)
SELECT jsonb_build_object(
  'account_id', conversation.account_id,
  'conversation', to_jsonb(conversation),
  'request_message', to_jsonb(request_message),
  'receipt_message', COALESCE((SELECT to_jsonb(selected_receipt) FROM selected_receipt LIMIT 1), '{{}}'::jsonb),
  'context_document', COALESCE((SELECT to_jsonb(context_doc) FROM context_doc LIMIT 1), '{{}}'::jsonb),
  'recent_messages', COALESCE((
    SELECT jsonb_agg(to_jsonb(row) ORDER BY row.message_order ASC)
    FROM (
      SELECT
        message.message_order,
        message.id,
        message.role,
        message.body,
        message.mode,
        message.provider,
        message.model,
        message.response_id,
        message.created_at,
        message.metadata_json
      FROM chat_messages AS message
      WHERE message.conversation_id = conversation.id
        AND message.message_order < request_message.message_order
      ORDER BY message.message_order DESC
      LIMIT {max(1, min(int(recent_message_limit), 100))}
    ) AS row
  ), '[]'::jsonb),
  'recent_memory', COALESCE((
    SELECT jsonb_agg(to_jsonb(row) ORDER BY row.created_at ASC)
    FROM (
      SELECT *
      FROM chat_memory_entries
      WHERE account_id = conversation.account_id
        AND kind = 'turn_memory'
      ORDER BY created_at DESC, id DESC
      LIMIT {max(1, min(int(recent_memory_limit), 100))}
    ) AS row
  ), '[]'::jsonb),
  'deep_memory', COALESCE((
    SELECT jsonb_agg(to_jsonb(row) ORDER BY row.created_at ASC)
    FROM (
      SELECT *
      FROM chat_memory_entries
      WHERE account_id = conversation.account_id
        AND kind = 'deep_memory'
      ORDER BY created_at DESC, id DESC
      LIMIT {max(1, min(int(deep_memory_limit), 10))}
    ) AS row
  ), '[]'::jsonb)
)
FROM selected_conversation AS conversation
JOIN selected_request AS request_message
  ON request_message.conversation_id = conversation.id;
"""
    raw = psql_json(db_url, sql)
    if not raw:
        detail = f"chat_title={chat_title!r}"
        if request_id:
            detail += f", request_id={request_id!r}"
        raise RuntimeError(f"No task request fixture found in Task Node Postgres ({detail}).")
    return AppTaskRequestFixture(
        account_id=raw["account_id"],
        conversation=raw["conversation"],
        request_message=normalize_message_row(raw["request_message"]),
        receipt_message=normalize_message_row(raw.get("receipt_message") or {}),
        context_document=raw.get("context_document") or {},
        recent_messages=[normalize_message_row(item) for item in raw.get("recent_messages") or []],
        recent_memory=raw.get("recent_memory") or [],
        deep_memory=raw.get("deep_memory") or [],
    )


def normalize_message_row(row: dict[str, Any]) -> dict[str, Any]:
    if not row:
        return {}
    out = dict(row)
    if "metadata_json" in out and "metadata" not in out:
        out["metadata"] = out.pop("metadata_json") or {}
    return out


def compact_text(value: str | None, max_length: int = 4000) -> str:
    text = re.sub(r"\s+", " ", strip_html(value or "")).strip()
    if len(text) <= max_length:
        return text
    head = int(max_length * 0.7)
    tail = max_length - head - 32
    return f"{text[:head]} [...middle truncated...] {text[-tail:]}"


def strip_html(value: str) -> str:
    text = re.sub(r"<(br|/p|/div|/li|/h[1-6])\\b[^>]*>", "\n", value, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return text.replace("&nbsp;", " ").replace("&amp;", "&")


def message_projection(row: dict[str, Any]) -> dict[str, Any]:
    body = str(row.get("body") or "")
    return {
        "id": row.get("id"),
        "role": row.get("role"),
        "content": compact_text(body, 4000),
        "created_at": isoish(row.get("created_at")),
        "digest": "sha256:" + sha256_hex(body),
        "provider": row.get("provider"),
        "model": row.get("model"),
    }


def memory_projection(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "kind": row.get("kind") or "turn_memory",
        "conversation_id": row.get("conversation_id"),
        "conversation_title": row.get("conversation_title") or "New chat",
        "created_at": isoish(row.get("created_at")),
        "user_request_summary": compact_text(row.get("user_request_summary"), 1200),
        "system_response_summary": compact_text(row.get("system_response_summary"), 1200),
        "memory_text": compact_text(row.get("memory_text"), 1800),
        "digest": "sha256:" + sha256_hex({
            "user": row.get("user_request_summary") or "",
            "system": row.get("system_response_summary") or "",
            "memory": row.get("memory_text") or "",
        }),
    }


def isoish(value: Any) -> str:
    text = str(value or "")
    return text.replace(" ", "T", 1) if text else now_iso()


def build_context_doc_payload(fixture: AppTaskRequestFixture, *, subject_wallet: str) -> dict[str, Any]:
    context = fixture.context_document or {}
    body = str(context.get("body") or "")
    return {
        "schema": "pf.context.doc.v1",
        "context_id": context.get("id") or f"ctx_{sha256_hex(fixture.account_id)[:24]}",
        "revision_id": context.get("revision_id"),
        "account_id": fixture.account_id,
        "created_at": isoish(context.get("created_at")),
        "updated_at": isoish(context.get("updated_at")),
        "subject_wallet": subject_wallet,
        "title": context.get("title") or "Task Node Context",
        "revision": context.get("revision") or 0,
        "word_count": context.get("word_count") or len(compact_text(body).split()),
        "body_sha256": context.get("body_sha256") or sha256_hex(body),
        "content": body,
    }


def build_request_bundle_from_fixture(
    fixture: AppTaskRequestFixture,
    *,
    subject_wallet: str,
    allocation_wallet: str,
    authority_wallet: str,
    client_name: str = "tasknodeofficial-python-app-fixture",
) -> dict[str, Any]:
    metadata = fixture.request_metadata
    context = fixture.context_document or {}
    context_body = str(context.get("body") or "")
    recent_messages = [message_projection(row) for row in fixture.recent_messages]
    recent_memory = [memory_projection(row) for row in fixture.recent_memory]
    deep_memory = [memory_projection(row) for row in fixture.deep_memory]
    user_detail_text = str(metadata.get("userDetailText") or fixture.request_message.get("body") or "")
    request_text = str(metadata.get("requestText") or CANONICAL_TASK_REQUEST_TEXT)
    created_at = isoish(fixture.request_message.get("created_at"))
    context_summary = compact_text(context_body, 1600)
    recent_chat_summary = summarize_recent_chat(recent_messages, user_detail_text)
    return {
        "schema": "pf.task.request_bundle.v1",
        "bundle_id": fixture.bundle_id or f"bundle_{sha256_hex(fixture.request_id + created_at)[:24]}",
        "subject_wallet": subject_wallet,
        "created_at": created_at,
        "client": {
            "name": client_name,
            "version": "0.1.0",
            "source_app": "tasknodeofficial",
            "account_id": fixture.account_id,
            "conversation_id": fixture.conversation.get("id"),
            "conversation_title": fixture.conversation.get("title") or "task_sample",
            "request_message_id": fixture.request_message.get("id"),
            "receipt_message_id": fixture.receipt_message.get("id"),
        },
        "request": {
            "request_id": fixture.request_id or f"req_{sha256_hex(user_detail_text + created_at)[:24]}",
            "request_text": request_text,
            "user_detail_text": user_detail_text,
            "requested_task_kind": metadata.get("requestedTaskKind") or "personal",
            "source": metadata.get("source") or "user_chat",
            "source_conversation_title": metadata.get("sourceConversationTitle") or fixture.conversation.get("title"),
        },
        "recent_chat": {
            "messages": recent_messages,
            "summary": recent_chat_summary,
            "window": {
                "started_at": recent_messages[0]["created_at"] if recent_messages else created_at,
                "ended_at": recent_messages[-1]["created_at"] if recent_messages else created_at,
                "request_at": created_at,
            },
        },
        "memory": {
            "deep_memory": deep_memory,
            "recent_memory": recent_memory,
        },
        "relevant_history": {
            "strategy": "app_memory_recent_36_plus_deep_3",
            "items": [
                {
                    "kind": item["kind"],
                    "digest": item["digest"],
                    "summary": item["memory_text"],
                    "conversation_title": item["conversation_title"],
                    "created_at": item["created_at"],
                }
                for item in [*deep_memory, *recent_memory]
                if item.get("memory_text")
            ],
        },
        "context": {
            "primary_context_doc": {
                "context_id": context.get("id") or f"ctx_{sha256_hex(fixture.account_id)[:24]}",
                "cid": None,
                "digest": "sha256:" + sha256_hex(context_body),
                "summary": context_summary,
                "revision": context.get("revision") or 0,
                "word_count": context.get("word_count") or len(context_summary.split()),
            },
            "additional_refs": [],
        },
        "policy": {
            "task_policy_version": "task-policy-minimal-v1",
            "reward_policy_version": "reward-policy-minimal-v1",
            "generation_policy_version": "taskgen-policy-minimal-v1",
        },
        "wallet": {
            "subject_wallet": subject_wallet,
            "allocation_wallet": allocation_wallet,
            "authority_wallet": authority_wallet,
            "authority_hint": authority_wallet,
        },
    }


def summarize_recent_chat(messages: list[dict[str, Any]], request_detail: str) -> str:
    user_lines = [item["content"] for item in messages if item.get("role") == "user"]
    assistant_lines = [item["content"] for item in messages if item.get("role") == "assistant"]
    parts = []
    if user_lines:
        parts.append("Recent user messages: " + " | ".join(compact_text(line, 240) for line in user_lines[-4:]))
    if assistant_lines:
        parts.append("Recent assistant responses: " + " | ".join(compact_text(line, 240) for line in assistant_lines[-3:]))
    parts.append("Explicit task request detail: " + compact_text(request_detail, 500))
    return " ".join(parts)
