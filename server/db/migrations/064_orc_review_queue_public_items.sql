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
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_review_items
  ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'local_projection',
  ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operator_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operator_wallet text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS task_kind text NOT NULL DEFAULT 'network',
  ADD COLUMN IF NOT EXISTS task_status text NOT NULL DEFAULT 'rewarded',
  ADD COLUMN IF NOT EXISTS reward_offer_pft numeric(20, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reward_actual_pft numeric(20, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS request_bundle_cid text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_event_cid text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_event_tx_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS public_hive_task_detail_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS event_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_event_tx_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE orc_task_review_items
  DROP CONSTRAINT IF EXISTS orc_task_review_items_source_mode_check;
ALTER TABLE orc_task_review_items
  ADD CONSTRAINT orc_task_review_items_source_mode_check
    CHECK (source_mode = ANY(ARRAY['local_projection', 'directory_public', 'hive_public_detail']::text[]));

CREATE INDEX IF NOT EXISTS orc_task_review_items_source_idx
  ON orc_task_review_items (source_mode, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_review_items_kind_status_idx
  ON orc_task_review_items (task_kind, task_status, reward_actual_pft DESC, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_review_items_operator_wallet_idx
  ON orc_task_review_items (operator_wallet, last_seen_at DESC)
  WHERE operator_wallet <> '';

-- Local task_projections remain the richest forensic source. This backfill
-- preserves that path and makes local_projection win on conflict so later
-- thinner public Directory packets cannot clobber local reducer/event context.
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
  CASE
    WHEN refs.task_id IS NOT NULL THEN '/api/hive/task-detail?taskId=' || p.task_id
    ELSE ''
  END,
  COALESCE(p.event_count, 0),
  COALESCE(p.created_at, p.updated_at, now()),
  COALESCE(p.last_event_at, p.updated_at, now()),
  p.last_event_tx_hash,
  jsonb_build_object(
    'ingestedFrom', 'task_projections',
    'networkProjectRef', CASE
      WHEN refs.task_id IS NOT NULL THEN jsonb_build_object('projectId', refs.project_id, 'source', refs.source)
      ELSE NULL
    END
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
  AND p.reward_actual_pft > 0
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
  reward_actual_pft = CASE WHEN EXCLUDED.reward_actual_pft > 0 THEN EXCLUDED.reward_actual_pft ELSE orc_task_review_items.reward_actual_pft END,
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
  AND item.task_status = 'rewarded'
  AND item.reward_actual_pft > 0
  AND COALESCE(item.event_count, 0) > 0
  AND COALESCE(item.last_event_tx_hash, '') <> ''
  AND COALESCE(item.last_event_cid, '') <> '';
