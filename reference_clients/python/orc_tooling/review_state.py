from __future__ import annotations

import json
import subprocess
from typing import Any
from uuid import uuid4

from tasknode_pftl.app_data import sql_literal, tasknode_database_url

from .payload import redact_secrets
from .review_integrity_policy import (
    EXECUTABLE_REWARD_CLAWBACK_SIGNAL,
    apply_reward_clawback_integrity_policy,
)


REVIEW_DISPOSITIONS = {
    "not_reviewed": "No review state has been recorded yet.",
    "in_review": "An orc has started reviewing the task but has not committed a disposition.",
    "reviewed_no_action": "Reviewed and self-contained; no core team or agent action needed.",
    "reviewed_follow_up": "Reviewed and useful feedback requires categorization or action.",
    "reviewed_follow_up_completed": "Reviewed follow-up was completed, routed, or closed; no current action remains.",
    "reviewed_integrity_follow_up": "Reviewed and negative integrity signal requires reconciliation or detection work.",
    "reviewed_unclear": "Reviewed but evidence is missing, ambiguous, inaccessible, or needs a second pass.",
    "reviewed_duplicate_or_superseded": "Reviewed but already captured, duplicated, or superseded by later work.",
}

FOLLOW_UP_CATEGORIES = {
    "agent_tooling",
    "bug_report",
    "data_quality",
    "docs",
    "onboarding",
    "operator_workflow",
    "other",
    "product_feedback",
    "reward_accounting",
    "security",
    "task_generation",
    "task_routing",
    "verification_policy",
}

INTEGRITY_SIGNALS = {
    "duplicate_submission",
    EXECUTABLE_REWARD_CLAWBACK_SIGNAL,
    "fabricated_evidence",
    "generic_ai_response",
    "impossible_or_unverifiable_claim",
    "nonresponsive_submission",
    "plagiarized_or_reused_work",
    "reward_abuse_pattern",
    "suspected_sybil_cluster",
}

CONFIDENCE_LEVELS = {"low", "medium", "high"}
ACTION_REQUIRED_DISPOSITIONS = {
    "reviewed_follow_up",
    "reviewed_integrity_follow_up",
    "reviewed_unclear",
}


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_int(value: Any, default: int = 50, *, minimum: int = 1, maximum: int = 500) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def _normalized_labels(values: list[str] | tuple[str, ...] | None) -> list[str]:
    labels: list[str] = []
    for value in values or []:
        for part in str(value or "").split(","):
            label = part.strip().lower().replace(" ", "_")
            if label and label not in labels:
                labels.append(label)
    return labels


def _text_array_literal(values: list[str]) -> str:
    if not values:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ",".join(sql_literal(value) for value in values) + "]::text[]"


def _jsonb_literal(value: dict[str, Any] | list[Any] | None) -> str:
    return sql_literal(json.dumps(value if value is not None else {}, sort_keys=True)) + "::jsonb"


def _reviewed_at_sql(disposition: str) -> str:
    return "now()" if disposition.startswith("reviewed_") else "NULL"


def review_disposition_requires_action(disposition: str) -> bool:
    return disposition in ACTION_REQUIRED_DISPOSITIONS


def validate_review_labels(categories: list[str], integrity_signals: list[str]) -> None:
    unknown_categories = sorted(set(categories) - FOLLOW_UP_CATEGORIES)
    if unknown_categories:
        raise ValueError(f"Unknown review categories: {', '.join(unknown_categories)}")
    unknown_signals = sorted(set(integrity_signals) - INTEGRITY_SIGNALS)
    if unknown_signals:
        raise ValueError(f"Unknown integrity signals: {', '.join(unknown_signals)}")


def normalize_review_state_record(
    *,
    task_id: str,
    disposition: str,
    action_required: bool | None = None,
    action_owner: str = "",
    confidence: str = "medium",
    categories: list[str] | tuple[str, ...] | None = None,
    integrity_signals: list[str] | tuple[str, ...] | None = None,
    summary: str = "",
    recommended_action: str = "",
    reviewer_handle: str = "",
    reviewer_wallet: str = "",
    source_task_ids: list[str] | tuple[str, ...] | None = None,
    source_cids: list[str] | tuple[str, ...] | None = None,
    source_tx_hashes: list[str] | tuple[str, ...] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_task_id = _safe_text(task_id, 160)
    normalized_disposition = _safe_text(disposition, 120).lower()
    normalized_confidence = _safe_text(confidence or "medium", 40).lower()
    normalized_categories = _normalized_labels(list(categories or []))
    normalized_integrity = _normalized_labels(list(integrity_signals or []))
    policy = apply_reward_clawback_integrity_policy(
        categories=normalized_categories,
        integrity_signals=normalized_integrity,
        metadata=metadata or {},
    )
    normalized_categories = policy["categories"]
    normalized_integrity = policy["integritySignals"]
    normalized_metadata = policy["metadata"]
    normalized_source_tasks = _normalized_labels(list(source_task_ids or []))
    if normalized_task_id and normalized_task_id not in normalized_source_tasks:
        normalized_source_tasks.insert(0, normalized_task_id)

    if not normalized_task_id:
        raise ValueError("task_id is required")
    if normalized_disposition not in REVIEW_DISPOSITIONS:
        raise ValueError(f"Unknown review disposition: {normalized_disposition}")
    if normalized_confidence not in CONFIDENCE_LEVELS:
        raise ValueError(f"Unknown confidence level: {normalized_confidence}")
    validate_review_labels(normalized_categories, normalized_integrity)

    if normalized_disposition == "reviewed_follow_up" and not normalized_categories:
        raise ValueError("reviewed_follow_up requires at least one category")
    if normalized_disposition == "reviewed_integrity_follow_up" and not normalized_integrity:
        raise ValueError("reviewed_integrity_follow_up requires at least one integrity signal")
    if normalized_disposition.startswith("reviewed_") and not _safe_text(summary, 4000):
        raise ValueError("reviewed dispositions require a summary")

    return redact_secrets({
        "taskId": normalized_task_id,
        "disposition": normalized_disposition,
        "actionRequired": review_disposition_requires_action(normalized_disposition)
        if action_required is None
        else bool(action_required),
        "actionOwner": _safe_text(action_owner, 160),
        "confidence": normalized_confidence,
        "categories": normalized_categories,
        "integritySignals": normalized_integrity,
        "summary": _safe_text(summary, 12000),
        "recommendedAction": _safe_text(recommended_action, 12000),
        "reviewerHandle": _safe_text(reviewer_handle, 160),
        "reviewerWallet": _safe_text(reviewer_wallet, 160),
        "sourceTaskIds": normalized_source_tasks,
        "sourceCids": [_safe_text(value, 160) for value in source_cids or [] if _safe_text(value, 160)],
        "sourceTxHashes": [_safe_text(value, 160) for value in source_tx_hashes or [] if _safe_text(value, 160)],
        "metadata": normalized_metadata,
        "secretPrinted": False,
    })


def _run_psql(database_url: str, sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _run_json(database_url: str, sql: str) -> Any:
    output = _run_psql(database_url, sql)
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    return json.loads(lines[-1])


def ensure_review_state_schema(*, database_url: str | None = None) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    allowed_dispositions = _text_array_literal(sorted(REVIEW_DISPOSITIONS))
    allowed_confidence = _text_array_literal(sorted(CONFIDENCE_LEVELS))
    sql = f"""
CREATE TABLE IF NOT EXISTS orc_task_review_states (
  task_id text PRIMARY KEY,
  disposition text NOT NULL DEFAULT 'not_reviewed',
  action_required boolean NOT NULL DEFAULT false,
  action_owner text NOT NULL DEFAULT '',
  confidence text NOT NULL DEFAULT 'medium',
  categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  integrity_signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  summary text NOT NULL DEFAULT '',
  recommended_action text NOT NULL DEFAULT '',
  reviewer_handle text NOT NULL DEFAULT '',
  reviewer_wallet text NOT NULL DEFAULT '',
  source_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_cids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_tx_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata_json jsonb NOT NULL DEFAULT '{{}}'::jsonb,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_review_states
  DROP CONSTRAINT IF EXISTS orc_task_review_states_disposition_check;
ALTER TABLE orc_task_review_states
  ADD CONSTRAINT orc_task_review_states_disposition_check
    CHECK (disposition = ANY({allowed_dispositions}));
ALTER TABLE orc_task_review_states
  DROP CONSTRAINT IF EXISTS orc_task_review_states_confidence_check;
ALTER TABLE orc_task_review_states
  ADD CONSTRAINT orc_task_review_states_confidence_check
    CHECK (confidence = ANY({allowed_confidence}));

CREATE INDEX IF NOT EXISTS orc_task_review_states_disposition_idx
  ON orc_task_review_states (disposition, updated_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_review_states_action_idx
  ON orc_task_review_states (action_required, updated_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_review_states_categories_idx
  ON orc_task_review_states USING gin (categories);
CREATE INDEX IF NOT EXISTS orc_task_review_states_integrity_idx
  ON orc_task_review_states USING gin (integrity_signals);

CREATE TABLE IF NOT EXISTS orc_task_reviews (
  id text PRIMARY KEY,
  task_id text NOT NULL DEFAULT '',
  disposition text NOT NULL DEFAULT 'not_reviewed',
  action_required boolean NOT NULL DEFAULT false,
  action_owner text NOT NULL DEFAULT '',
  confidence text NOT NULL DEFAULT 'medium',
  categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  integrity_signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  summary text NOT NULL DEFAULT '',
  recommended_action text NOT NULL DEFAULT '',
  reviewer_handle text NOT NULL DEFAULT '',
  reviewer_wallet text NOT NULL DEFAULT '',
  source_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_cids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_tx_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata_json jsonb NOT NULL DEFAULT '{{}}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_reviews
  ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'not_reviewed',
  ADD COLUMN IF NOT EXISTS action_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS action_owner text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS integrity_signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recommended_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_wallet text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS source_cids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS source_tx_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE orc_task_reviews
  DROP CONSTRAINT IF EXISTS orc_task_reviews_disposition_check;
ALTER TABLE orc_task_reviews
  ADD CONSTRAINT orc_task_reviews_disposition_check
    CHECK (disposition = ANY({allowed_dispositions}));
ALTER TABLE orc_task_reviews
  DROP CONSTRAINT IF EXISTS orc_task_reviews_confidence_check;
ALTER TABLE orc_task_reviews
  ADD CONSTRAINT orc_task_reviews_confidence_check
    CHECK (confidence = ANY({allowed_confidence}));

CREATE INDEX IF NOT EXISTS orc_task_reviews_task_idx
  ON orc_task_reviews (task_id, created_at DESC)
  WHERE task_id <> '';
CREATE INDEX IF NOT EXISTS orc_task_reviews_reviewer_idx
  ON orc_task_reviews (reviewer_handle, created_at DESC)
  WHERE reviewer_handle <> '';
CREATE INDEX IF NOT EXISTS orc_task_reviews_disposition_idx
  ON orc_task_reviews (disposition, created_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_reviews_action_idx
  ON orc_task_reviews (action_required, created_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_reviews_categories_idx
  ON orc_task_reviews USING gin (categories);
CREATE INDEX IF NOT EXISTS orc_task_reviews_integrity_idx
  ON orc_task_reviews USING gin (integrity_signals);

CREATE TABLE IF NOT EXISTS orc_task_review_items (
  task_id text PRIMARY KEY,
  source_mode text NOT NULL DEFAULT 'local_projection',
  account_id text NOT NULL DEFAULT '',
  operator_handle text NOT NULL DEFAULT '',
  operator_wallet text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  task_kind text NOT NULL DEFAULT 'network',
  task_status text NOT NULL DEFAULT 'rewarded',
  reward_offer_pft numeric(20, 6) NOT NULL DEFAULT 0,
  reward_actual_pft numeric(20, 6) NOT NULL DEFAULT 0,
  request_bundle_cid text NOT NULL DEFAULT '',
  last_event_cid text NOT NULL DEFAULT '',
  last_event_tx_hash text NOT NULL DEFAULT '',
  public_hive_task_detail_url text NOT NULL DEFAULT '',
  event_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_event_tx_hash text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{{}}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_review_items
  DROP CONSTRAINT IF EXISTS orc_task_review_items_source_mode_check;
ALTER TABLE orc_task_review_items
  ADD CONSTRAINT orc_task_review_items_source_mode_check
    CHECK (source_mode = ANY(ARRAY['local_projection', 'directory_public', 'hive_public_detail', 'network_status_packet']::text[]));

CREATE INDEX IF NOT EXISTS orc_task_review_items_source_idx
  ON orc_task_review_items (source_mode, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_review_items_kind_status_idx
  ON orc_task_review_items (task_kind, task_status, reward_actual_pft DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS orc_task_review_items_operator_wallet_idx
  ON orc_task_review_items (operator_wallet, last_seen_at DESC)
  WHERE operator_wallet <> '';

INSERT INTO orc_task_review_items (
  task_id,
  source_mode,
  account_id,
  operator_wallet,
  title,
  description,
  task_kind,
  task_status,
  reward_offer_pft,
  reward_actual_pft,
  request_bundle_cid,
  last_event_cid,
  last_event_tx_hash,
  public_hive_task_detail_url,
  event_count,
  first_seen_at,
  last_seen_at,
  last_seen_event_tx_hash,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  p.task_id,
  'local_projection',
  p.account_id,
  p.subject_wallet,
  p.title,
  p.description,
  lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', 'network')),
  p.status,
  p.reward_offer_pft,
  p.reward_actual_pft,
  p.request_bundle_cid,
  p.last_event_cid,
  p.last_event_tx_hash,
  CASE WHEN refs.task_id IS NOT NULL THEN '/api/hive/task-detail?taskId=' || p.task_id ELSE '' END,
  COALESCE(p.event_count, 0),
  COALESCE(p.created_at, p.updated_at, now()),
  COALESCE(p.last_event_at, p.updated_at, now()),
  p.last_event_tx_hash,
  jsonb_build_object(
    'ingestedFrom', 'task_projections',
    'statusPacket', jsonb_build_object(
      'schema', 'pf.task_node.network_task_status_packet.v1',
      'allocationState', 'published',
      'taskState', 'rewarded',
      'rewardMovement', CASE
        WHEN lower(COALESCE(p.metadata_json->'reward_payment_guard'->>'status', '')) IN ('submitting', 'submitted', 'submit_unknown', 'duplicate_guarded', 'duplicate') THEN 'duplicate_guarded'
        WHEN p.reward_actual_pft > 0 THEN 'paid_positive'
        ELSE 'closed_zero'
      END,
      'repairRequired', false,
      'repairReason', ''
    )
  ),
  now(),
  now()
FROM task_projections p
LEFT JOIN LATERAL (
  SELECT refs.task_id, refs.project_id, refs.source
  FROM network_project_task_refs refs
  WHERE refs.task_id = p.task_id
  ORDER BY (refs.source = 'network_task_generation') DESC,
           refs.updated_at DESC NULLS LAST,
           refs.id DESC
  LIMIT 1
) refs ON true
WHERE lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', '')) = 'network'
  AND p.status = 'rewarded'
  AND COALESCE(p.event_count, 0) > 0
  AND COALESCE(p.last_event_tx_hash, '') <> ''
  AND COALESCE(p.last_event_cid, '') <> ''
  AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
  AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
  AND p.task_id NOT LIKE 'directory_polish_%'
  AND p.task_id NOT LIKE 'task_cancel_paid_%'
ON CONFLICT (task_id) DO UPDATE SET
  source_mode = 'local_projection',
  account_id = COALESCE(NULLIF(EXCLUDED.account_id, ''), orc_task_review_items.account_id),
  operator_wallet = COALESCE(NULLIF(EXCLUDED.operator_wallet, ''), orc_task_review_items.operator_wallet),
  title = COALESCE(NULLIF(EXCLUDED.title, ''), orc_task_review_items.title),
  description = COALESCE(NULLIF(EXCLUDED.description, ''), orc_task_review_items.description),
  task_kind = COALESCE(NULLIF(EXCLUDED.task_kind, ''), orc_task_review_items.task_kind),
  task_status = COALESCE(NULLIF(EXCLUDED.task_status, ''), orc_task_review_items.task_status),
  reward_offer_pft = CASE WHEN EXCLUDED.reward_offer_pft > 0 THEN EXCLUDED.reward_offer_pft ELSE orc_task_review_items.reward_offer_pft END,
  reward_actual_pft = EXCLUDED.reward_actual_pft,
  request_bundle_cid = COALESCE(NULLIF(EXCLUDED.request_bundle_cid, ''), orc_task_review_items.request_bundle_cid),
  last_event_cid = COALESCE(NULLIF(EXCLUDED.last_event_cid, ''), orc_task_review_items.last_event_cid),
  last_event_tx_hash = COALESCE(NULLIF(EXCLUDED.last_event_tx_hash, ''), orc_task_review_items.last_event_tx_hash),
  public_hive_task_detail_url = COALESCE(NULLIF(EXCLUDED.public_hive_task_detail_url, ''), orc_task_review_items.public_hive_task_detail_url),
  event_count = GREATEST(orc_task_review_items.event_count, EXCLUDED.event_count),
  last_seen_at = GREATEST(orc_task_review_items.last_seen_at, EXCLUDED.last_seen_at),
  last_seen_event_tx_hash = COALESCE(NULLIF(EXCLUDED.last_seen_event_tx_hash, ''), orc_task_review_items.last_seen_event_tx_hash),
  metadata_json = orc_task_review_items.metadata_json || EXCLUDED.metadata_json,
  updated_at = now();

DROP VIEW IF EXISTS orc_task_review_queue;

CREATE VIEW orc_task_review_queue AS
SELECT
  item.task_id,
  item.account_id,
  item.operator_wallet AS wallet_address,
  item.title,
  item.task_status,
  item.reward_offer_pft::text AS reward_offer_pft,
  item.reward_actual_pft::text AS reward_actual_pft,
  item.request_bundle_cid,
  item.last_event_cid,
  item.last_event_tx_hash,
  item.last_seen_at AS task_updated_at,
  item.source_mode,
  item.operator_handle,
  item.description,
  item.public_hive_task_detail_url,
  item.task_kind,
  item.event_count,
  item.metadata_json AS item_metadata_json,
  item.metadata_json->'statusPacket' AS status_packet_json,
  COALESCE(s.disposition, 'not_reviewed') AS review_disposition,
  COALESCE(s.action_required, false) AS action_required,
  s.action_owner,
  COALESCE(s.confidence, 'medium') AS confidence,
  COALESCE(s.categories, ARRAY[]::text[]) AS categories,
  COALESCE(s.integrity_signals, ARRAY[]::text[]) AS integrity_signals,
  COALESCE(s.summary, '') AS review_summary,
  COALESCE(s.recommended_action, '') AS recommended_action,
  s.reviewer_handle,
  s.reviewer_wallet,
  s.source_task_ids,
  s.source_cids,
  s.source_tx_hashes,
  s.reviewed_at,
  s.updated_at AS review_updated_at
FROM orc_task_review_items item
LEFT JOIN orc_task_review_states s
  ON s.task_id = item.task_id
WHERE lower(COALESCE(item.task_kind, '')) = 'network'
  AND (
    (
      item.task_status = 'rewarded'
      AND (
        item.reward_actual_pft > 0
        OR item.metadata_json->'statusPacket'->>'rewardMovement' IN ('closed_zero', 'duplicate_guarded')
      )
    )
    OR COALESCE(item.metadata_json->'statusPacket'->>'repairRequired', 'false') = 'true'
  )
  AND (
    (
      COALESCE(item.event_count, 0) > 0
      AND COALESCE(item.last_event_tx_hash, '') <> ''
      AND COALESCE(item.last_event_cid, '') <> ''
    )
    OR COALESCE(item.metadata_json->'statusPacket'->>'repairRequired', 'false') = 'true'
  );

SELECT jsonb_build_object(
  'ok', true,
  'table', 'orc_task_review_states',
  'historyTable', 'orc_task_reviews',
  'itemsTable', 'orc_task_review_items',
  'view', 'orc_task_review_queue',
  'dispositions', {sql_literal(json.dumps(REVIEW_DISPOSITIONS, sort_keys=True))}::jsonb,
  'secretPrinted', false
);
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def upsert_review_state(record: dict[str, Any], *, database_url: str | None = None) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    disposition = record["disposition"]
    review_id = f"orcrev_{uuid4()}"
    sql = f"""
WITH upsert AS (
  INSERT INTO orc_task_review_states (
    task_id,
    disposition,
    action_required,
    action_owner,
    confidence,
    categories,
    integrity_signals,
    summary,
    recommended_action,
    reviewer_handle,
    reviewer_wallet,
    source_task_ids,
    source_cids,
    source_tx_hashes,
    metadata_json,
    reviewed_at,
    updated_at
  )
  VALUES (
    {sql_literal(record["taskId"])},
    {sql_literal(disposition)},
    {'true' if record["actionRequired"] else 'false'},
    {sql_literal(record["actionOwner"])},
    {sql_literal(record["confidence"])},
    {_text_array_literal(record["categories"])},
    {_text_array_literal(record["integritySignals"])},
    {sql_literal(record["summary"])},
    {sql_literal(record["recommendedAction"])},
    {sql_literal(record["reviewerHandle"])},
    {sql_literal(record["reviewerWallet"])},
    {_text_array_literal(record["sourceTaskIds"])},
    {_text_array_literal(record["sourceCids"])},
    {_text_array_literal(record["sourceTxHashes"])},
    {_jsonb_literal(record["metadata"])},
    {_reviewed_at_sql(disposition)},
    now()
  )
  ON CONFLICT (task_id) DO UPDATE SET
    disposition = EXCLUDED.disposition,
    action_required = EXCLUDED.action_required,
    action_owner = EXCLUDED.action_owner,
    confidence = EXCLUDED.confidence,
    categories = EXCLUDED.categories,
    integrity_signals = EXCLUDED.integrity_signals,
    summary = EXCLUDED.summary,
    recommended_action = EXCLUDED.recommended_action,
    reviewer_handle = EXCLUDED.reviewer_handle,
    reviewer_wallet = EXCLUDED.reviewer_wallet,
    source_task_ids = EXCLUDED.source_task_ids,
    source_cids = EXCLUDED.source_cids,
    source_tx_hashes = EXCLUDED.source_tx_hashes,
    metadata_json = EXCLUDED.metadata_json,
    reviewed_at = EXCLUDED.reviewed_at,
    updated_at = now()
  RETURNING *
),
review_insert AS (
  INSERT INTO orc_task_reviews (
    id,
    task_id,
    disposition,
    action_required,
    action_owner,
    confidence,
    categories,
    integrity_signals,
    summary,
    recommended_action,
    reviewer_handle,
    reviewer_wallet,
    source_task_ids,
    source_cids,
    source_tx_hashes,
    metadata_json,
    updated_at
  )
  SELECT
    {sql_literal(review_id)},
    task_id,
    disposition,
    action_required,
    action_owner,
    confidence,
    categories,
    integrity_signals,
    summary,
    recommended_action,
    reviewer_handle,
    reviewer_wallet,
    source_task_ids,
    source_cids,
    source_tx_hashes,
    metadata_json,
    now()
  FROM upsert
  RETURNING id
)
SELECT to_jsonb(upsert) || jsonb_build_object(
  'review_id', (SELECT id FROM review_insert),
  'secretPrinted', false
)
FROM upsert;
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def get_review_state(task_id: str, *, database_url: str | None = None) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    sql = f"""
SELECT COALESCE((
  SELECT to_jsonb(s) || jsonb_build_object('secretPrinted', false)
  FROM orc_task_review_states s
  WHERE s.task_id = {sql_literal(task_id)}
  LIMIT 1
), jsonb_build_object(
  'task_id', {sql_literal(task_id)},
  'disposition', 'not_reviewed',
  'secretPrinted', false
));
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def list_review_states(
    *,
    disposition: str = "",
    limit: int = 50,
    database_url: str | None = None,
) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    disposition_filter = ""
    if disposition:
        disposition_filter = f"WHERE disposition = {sql_literal(disposition)}"
    sql = f"""
SELECT jsonb_build_object(
  'ok', true,
  'count', count(*),
  'rows', COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.updated_at DESC), '[]'::jsonb),
  'secretPrinted', false
)
FROM (
  SELECT *
  FROM orc_task_review_states
  {disposition_filter}
  ORDER BY updated_at DESC
  LIMIT {_safe_int(limit)}
) row;
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def review_queue(
    *,
    disposition: str = "",
    limit: int = 50,
    database_url: str | None = None,
) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    if disposition and disposition not in REVIEW_DISPOSITIONS:
        raise ValueError(f"Unknown review disposition: {disposition}")
    disposition_filter = ""
    if disposition:
        disposition_filter = f"WHERE review_disposition = {sql_literal(disposition)}"
    sql = f"""
SELECT jsonb_build_object(
  'ok', true,
  'count', count(*),
  'rows', COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.task_updated_at DESC), '[]'::jsonb),
  'secretPrinted', false
)
FROM (
  SELECT *
  FROM orc_task_review_queue
  {disposition_filter}
  ORDER BY task_updated_at DESC
  LIMIT {_safe_int(limit)}
) row;
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def review_queue_item(
    task_id: str,
    *,
    database_url: str | None = None,
) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    normalized = _safe_text(task_id, 180)
    if not normalized:
        return {}
    sql = f"""
SELECT COALESCE(to_jsonb(row), '{{}}'::jsonb)
FROM (
  SELECT *
  FROM orc_task_review_queue
  WHERE task_id = {sql_literal(normalized)}
  LIMIT 1
) row;
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def review_state_summary(*, database_url: str | None = None) -> dict[str, Any]:
    ensure_review_state_schema(database_url=database_url)
    db_url = tasknode_database_url(database_url)
    sql = f"""
WITH counts AS (
  SELECT review_disposition, count(*) AS total
  FROM orc_task_review_queue
  GROUP BY review_disposition
),
integrity_controls AS (
  SELECT
    count(*) FILTER (
      WHERE {sql_literal(EXECUTABLE_REWARD_CLAWBACK_SIGNAL)} = ANY(COALESCE(integrity_signals, ARRAY[]::text[]))
    ) AS executable_reward_clawback_artifact,
    count(*) FILTER (
      WHERE metadata_json->'integrityControl'->>'controlMarker' = 'no_signing_no_fund_movement'
    ) AS no_signing_no_fund_movement,
    count(*) FILTER (
      WHERE metadata_json->'integrityControl'->>'independentOrcReviewRequired' = 'true'
    ) AS independent_orc_review_required
  FROM orc_task_review_states
)
SELECT jsonb_build_object(
  'ok', true,
  'counts', COALESCE((SELECT jsonb_object_agg(review_disposition, total) FROM counts), '{{}}'::jsonb),
  'integrityControls', (
    SELECT jsonb_build_object(
      'executable_reward_clawback_artifact', executable_reward_clawback_artifact,
      'no_signing_no_fund_movement', no_signing_no_fund_movement,
      'independentOrcReviewRequired', independent_orc_review_required
    )
    FROM integrity_controls
  ),
  'secretPrinted', false
)
;
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def review_state_ontology() -> dict[str, Any]:
    return {
        "dispositions": REVIEW_DISPOSITIONS,
        "actionRequiredDispositions": sorted(ACTION_REQUIRED_DISPOSITIONS),
        "categories": sorted(FOLLOW_UP_CATEGORIES),
        "integritySignals": sorted(INTEGRITY_SIGNALS),
        "confidence": sorted(CONFIDENCE_LEVELS),
        "table": "orc_task_review_states",
        "historyTable": "orc_task_reviews",
        "itemsTable": "orc_task_review_items",
        "queueView": "orc_task_review_queue",
        "secretPrinted": False,
    }
