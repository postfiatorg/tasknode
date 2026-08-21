-- Bounded read model that feeds Orc review outcomes back into routing context.
-- This view intentionally contains counts, controlled labels, timestamps, and
-- task ids only. It does not expose raw review summaries or recommendation text.

DROP VIEW IF EXISTS orc_review_rollups;

CREATE VIEW orc_review_rollups AS
WITH review_base AS (
  SELECT
    s.task_id,
    COALESCE(NULLIF(item.account_id, ''), NULLIF(p.account_id, ''), '') AS account_id,
    COALESCE(NULLIF(item.operator_wallet, ''), NULLIF(p.subject_wallet, ''), '') AS wallet_address,
    COALESCE(NULLIF(category.category, ''), 'uncategorized') AS category,
    s.disposition,
    COALESCE(s.action_required, false) AS action_required,
    COALESCE(s.integrity_signals, ARRAY[]::text[]) AS integrity_signals,
    s.confidence,
    s.reviewer_handle,
    s.reviewer_wallet,
    COALESCE(s.reviewed_at, s.updated_at, s.created_at) AS reviewed_at,
    COALESCE(s.updated_at, s.reviewed_at, s.created_at) AS updated_at
  FROM orc_task_review_states s
  LEFT JOIN orc_task_review_items item
    ON item.task_id = s.task_id
  LEFT JOIN task_projections p
    ON p.task_id = s.task_id
  CROSS JOIN LATERAL unnest(
    CASE WHEN cardinality(COALESCE(s.categories, ARRAY[]::text[])) > 0
      THEN s.categories
      ELSE ARRAY['uncategorized']::text[]
    END
  ) AS category(category)
  WHERE s.disposition <> 'not_reviewed'
    AND (
      COALESCE(NULLIF(item.account_id, ''), NULLIF(p.account_id, ''), '') <> ''
      OR COALESCE(NULLIF(item.operator_wallet, ''), NULLIF(p.subject_wallet, ''), '') <> ''
    )
),
disposition_counts AS (
  SELECT
    account_id,
    wallet_address,
    category,
    jsonb_object_agg(disposition, total ORDER BY disposition) AS by_disposition
  FROM (
    SELECT account_id, wallet_address, category, disposition, count(*)::int AS total
    FROM review_base
    GROUP BY account_id, wallet_address, category, disposition
  ) counts
  GROUP BY account_id, wallet_address, category
),
integrity_counts AS (
  SELECT
    account_id,
    wallet_address,
    category,
    jsonb_object_agg(signal, total ORDER BY signal) AS integrity_signal_counts,
    COALESCE(jsonb_agg(signal ORDER BY total DESC, signal) FILTER (WHERE total > 1), '[]'::jsonb) AS repeated_integrity_signals
  FROM (
    SELECT account_id, wallet_address, category, signal, count(*)::int AS total
    FROM review_base
    CROSS JOIN LATERAL unnest(integrity_signals) AS signal
    WHERE signal <> ''
    GROUP BY account_id, wallet_address, category, signal
  ) counts
  GROUP BY account_id, wallet_address, category
),
latest_action AS (
  SELECT DISTINCT ON (account_id, wallet_address, category)
    account_id,
    wallet_address,
    category,
    task_id,
    disposition,
    action_required,
    confidence,
    reviewer_handle,
    reviewed_at,
    updated_at
  FROM review_base
  ORDER BY account_id, wallet_address, category, updated_at DESC NULLS LAST, task_id DESC
)
SELECT
  base.account_id,
  base.wallet_address,
  base.category,
  count(*)::int AS reviewed_count,
  count(*) FILTER (WHERE base.action_required)::int AS action_required_count,
  count(*) FILTER (WHERE base.disposition = 'reviewed_integrity_follow_up')::int AS integrity_follow_up_count,
  count(*) FILTER (WHERE base.disposition IN ('reviewed_no_action', 'reviewed_follow_up_completed'))::int AS resolved_review_count,
  bool_or(cardinality(base.integrity_signals) > 0) AS has_integrity_signals,
  (base.category = ANY(ARRAY['reward_accounting', 'security', 'task_generation', 'task_routing', 'verification_policy']::text[])) AS high_value_category,
  max(base.updated_at) AS last_review_at,
  COALESCE(d.by_disposition, '{}'::jsonb) AS by_disposition,
  COALESCE(i.integrity_signal_counts, '{}'::jsonb) AS integrity_signal_counts,
  COALESCE(i.repeated_integrity_signals, '[]'::jsonb) AS repeated_integrity_signals,
  jsonb_build_object(
    'taskId', latest.task_id,
    'disposition', latest.disposition,
    'actionRequired', latest.action_required,
    'confidence', latest.confidence,
    'reviewerHandle', latest.reviewer_handle,
    'reviewedAt', latest.reviewed_at,
    'updatedAt', latest.updated_at
  ) AS last_reviewed_action
FROM review_base base
LEFT JOIN disposition_counts d
  ON d.account_id = base.account_id
 AND d.wallet_address = base.wallet_address
 AND d.category = base.category
LEFT JOIN integrity_counts i
  ON i.account_id = base.account_id
 AND i.wallet_address = base.wallet_address
 AND i.category = base.category
LEFT JOIN latest_action latest
  ON latest.account_id = base.account_id
 AND latest.wallet_address = base.wallet_address
 AND latest.category = base.category
GROUP BY
  base.account_id,
  base.wallet_address,
  base.category,
  d.by_disposition,
  i.integrity_signal_counts,
  i.repeated_integrity_signals,
  latest.task_id,
  latest.disposition,
  latest.action_required,
  latest.confidence,
  latest.reviewer_handle,
  latest.reviewed_at,
  latest.updated_at;
