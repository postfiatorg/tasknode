from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from tasknode_pftl.app_data import tasknode_database_url

from .payload import redact_secrets


def _safe_int(value: Any, default: int = 100, *, minimum: int = 1, maximum: int = 500) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def duplicate_reward_monitor_sql(*, limit: int = 100) -> str:
    capped_limit = _safe_int(limit)
    return f"""
WITH ordered_payments AS (
  SELECT
    e.task_id,
    e.source_tx_hash,
    e.source_cid,
    e.occurred_at,
    e.id,
    NULLIF(COALESCE(
      e.payload_json->>'reward_pft',
      e.payload_json->>'economic_reward_pft',
      e.payload_json->>'reward_actual_pft',
      e.payload_json->'score'->>'reward_pft'
    ), '')::numeric AS reward_pft,
    row_number() OVER (
      PARTITION BY e.task_id
      ORDER BY e.occurred_at, e.source_tx_hash, e.source_cid, e.id
    ) AS payment_index
  FROM task_events e
  WHERE e.event_type = 'pf.reward.v1'
),
payment_summary AS (
  SELECT
    p.task_id,
    count(*)::int AS payment_count,
    count(p.reward_pft)::int AS readable_payment_count,
    count(*) FILTER (WHERE p.reward_pft IS NULL)::int AS unreadable_payment_count,
    COALESCE(sum(p.reward_pft), 0)::numeric AS payment_total_pft,
    COALESCE(sum(p.reward_pft) FILTER (WHERE p.payment_index > 1), 0)::numeric AS duplicate_after_first_pft,
    jsonb_agg(jsonb_build_object(
      'paymentIndex', p.payment_index,
      'rewardPft', p.reward_pft::text,
      'txHash', p.source_tx_hash,
      'cid', p.source_cid,
      'occurredAt', p.occurred_at
    ) ORDER BY p.payment_index) AS payments
  FROM ordered_payments p
  GROUP BY p.task_id
),
joined AS (
  SELECT
    t.task_id,
    t.title,
    t.status,
    lower(COALESCE(NULLIF(t.task_kind, ''), t.metadata_json->'generatedTask'->>'task_kind', '')) AS task_kind,
    t.reward_actual_pft::numeric AS projection_reward_pft,
    COALESCE(s.payment_count, 0)::int AS payment_count,
    COALESCE(s.readable_payment_count, 0)::int AS readable_payment_count,
    COALESCE(s.unreadable_payment_count, 0)::int AS unreadable_payment_count,
    COALESCE(s.payment_total_pft, 0)::numeric AS payment_total_pft,
    COALESCE(s.duplicate_after_first_pft, 0)::numeric AS duplicate_after_first_pft,
    COALESCE(s.payments, '[]'::jsonb) AS payments,
    (COALESCE(s.payment_total_pft, 0)::numeric - COALESCE(t.reward_actual_pft, 0)::numeric) AS payment_projection_delta_pft,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN COALESCE(s.payment_count, 0) > 1 THEN 'duplicate_reward_outcome_events' END,
      CASE
        WHEN abs(COALESCE(s.payment_total_pft, 0)::numeric - COALESCE(t.reward_actual_pft, 0)::numeric) > 0.000001
          THEN 'payment_total_differs_from_projection_reward'
      END,
      CASE
        WHEN COALESCE(s.unreadable_payment_count, 0) > 0
          THEN 'unreadable_reward_amount_event'
      END,
      CASE
        WHEN COALESCE(t.reward_actual_pft, 0)::numeric > 0 AND COALESCE(s.payment_count, 0) = 0
          THEN 'missing_positive_reward_outcome_event'
      END,
      CASE
        WHEN COALESCE(t.reward_actual_pft, 0)::numeric = 0 AND COALESCE(s.payment_total_pft, 0)::numeric > 0
          THEN 'positive_payment_on_zero_reward_projection'
      END
    ], NULL) AS flags
  FROM task_projections t
  LEFT JOIN payment_summary s ON s.task_id = t.task_id
  WHERE t.status = 'rewarded'
),
flagged AS (
  SELECT *
  FROM joined
  WHERE cardinality(flags) > 0
  ORDER BY duplicate_after_first_pft DESC, abs(payment_projection_delta_pft) DESC, task_id
  LIMIT {capped_limit}
),
aggregate AS (
  SELECT jsonb_build_object(
    'rewardedTaskCount', count(*)::int,
    'duplicateRewardOutcomeTasks', count(*) FILTER (WHERE payment_count > 1)::int,
    'rewardProjectionMismatchTasks', count(*) FILTER (
      WHERE abs(payment_total_pft - projection_reward_pft) > 0.000001
    )::int,
    'unreadableRewardAmountTasks', count(*) FILTER (WHERE unreadable_payment_count > 0)::int,
    'missingPositiveRewardOutcomeTasks', count(*) FILTER (
      WHERE projection_reward_pft > 0 AND payment_count = 0
    )::int,
    'positivePaymentOnZeroProjectionTasks', count(*) FILTER (
      WHERE projection_reward_pft = 0 AND payment_total_pft > 0
    )::int,
    'duplicateRewardOutcomeExcessAfterFirstPft', COALESCE(sum(duplicate_after_first_pft), 0)::text,
    'totalPaymentProjectionDeltaPft', COALESCE(sum(payment_projection_delta_pft), 0)::text
  ) AS value
  FROM joined
)
SELECT jsonb_pretty(jsonb_build_object(
  'ok', true,
  'readOnly', true,
  'monitor', 'duplicate_reward_outcome',
  'generatedAt', now(),
  'aggregate', (SELECT value FROM aggregate),
  'tasks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'taskId', task_id,
      'title', title,
      'status', status,
      'taskKind', task_kind,
      'projectionRewardPft', projection_reward_pft::text,
      'paymentCount', payment_count,
      'readablePaymentCount', readable_payment_count,
      'unreadablePaymentCount', unreadable_payment_count,
      'paymentTotalPft', payment_total_pft::text,
      'duplicateAfterFirstPft', duplicate_after_first_pft::text,
      'paymentProjectionDeltaPft', payment_projection_delta_pft::text,
      'flags', flags,
      'payments', payments
    ) ORDER BY duplicate_after_first_pft DESC, abs(payment_projection_delta_pft) DESC, task_id)
    FROM flagged
  ), '[]'::jsonb),
  'secretPrinted', false
));
"""


def _run_psql_json(
    database_url: str,
    sql: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    result = runner(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {
            "ok": False,
            "error": "reward_monitor_query_failed",
            "returnCode": result.returncode,
            "stderr": str(result.stderr or "").strip(),
            "secretPrinted": False,
        }
    lines = [line for line in str(result.stdout or "").splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "error": "reward_monitor_empty_output", "secretPrinted": False}
    try:
        return json.loads("\n".join(lines))
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "error": "reward_monitor_invalid_json",
            "message": str(exc),
            "stdout": str(result.stdout or "").strip()[:2000],
            "secretPrinted": False,
        }


def run_duplicate_reward_monitor(
    *,
    database_url: str | None = None,
    output_dir: str | Path = "runs/orc_reward_monitor",
    limit: int = 100,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    payload = _run_psql_json(db_url, duplicate_reward_monitor_sql(limit=limit), runner=runner)
    payload = redact_secrets(payload)
    if not payload.get("ok"):
        return payload

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output_path = out_dir / f"duplicate_reward_monitor_{stamp}.json"
    output_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    payload["outputPath"] = str(output_path)
    payload["taskCount"] = len(payload.get("tasks") or [])
    payload["secretPrinted"] = False
    return payload
