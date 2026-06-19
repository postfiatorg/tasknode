ALTER TABLE orc_task_review_items
  DROP CONSTRAINT IF EXISTS orc_task_review_items_source_mode_check;

ALTER TABLE orc_task_review_items
  ADD CONSTRAINT orc_task_review_items_source_mode_check
    CHECK (source_mode = ANY(ARRAY['local_projection', 'directory_public', 'hive_public_detail', 'network_status_packet']::text[]));

-- Backfill/update local terminal network tasks, including valid zero-reward
-- outcomes. The status packet is derived from projection/allocation/job state
-- and is not an operator-editable lifecycle source.
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
    END,
    'statusPacket', jsonb_build_object(
      'schema', 'pf.task_node.network_task_status_packet.v1',
      'allocationState', CASE
        WHEN job.status IN ('queued', 'running', 'generated', 'published', 'link_failed', 'failed') THEN job.status
        WHEN alloc.allocation_status IN ('candidate', 'queued', 'expired', 'rerouted', 'failed') THEN alloc.allocation_status
        ELSE 'published'
      END,
      'taskState', CASE
        WHEN p.status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled') THEN p.status
        WHEN p.status = 'rejected' THEN 'refused'
        WHEN p.status IN ('expired', 'failed') THEN 'cancelled'
        WHEN p.status = 'completed' THEN 'rewarded'
        WHEN p.status = 'reward_decided' THEN 'verification_response_submitted'
        ELSE 'proposed'
      END,
      'rewardMovement', CASE
        WHEN lower(COALESCE(p.metadata_json->'reward_payment_guard'->>'status', '')) IN ('submitting', 'submitted', 'submit_unknown', 'duplicate_guarded', 'duplicate') THEN 'duplicate_guarded'
        WHEN p.reward_actual_pft > 0 THEN 'paid_positive'
        ELSE 'closed_zero'
      END,
      'repairRequired', CASE
        WHEN job.status = 'link_failed' THEN true
        WHEN p.status = 'rewarded' AND COALESCE(p.last_event_tx_hash, '') = '' AND COALESCE(p.last_event_cid, '') = '' THEN true
        ELSE false
      END,
      'repairReason', CASE
        WHEN job.status = 'link_failed' THEN 'link_failed'
        WHEN p.status = 'rewarded' AND COALESCE(p.last_event_tx_hash, '') = '' AND COALESCE(p.last_event_cid, '') = '' THEN 'missing_reward_pointer'
        ELSE ''
      END
    )
  ),
  now(),
  now()
FROM task_projections p
LEFT JOIN LATERAL (
  SELECT refs.task_id, refs.project_id, refs.source, refs.metadata_json, refs.updated_at, refs.id
  FROM network_project_task_refs refs
  WHERE refs.task_id = p.task_id
  ORDER BY (refs.source = 'network_task_generation') DESC,
           refs.updated_at DESC NULLS LAST,
           refs.id DESC
  LIMIT 1
) refs ON true
LEFT JOIN LATERAL (
  SELECT job.*
  FROM network_task_generation_jobs job
  WHERE job.task_id = p.task_id
     OR (p.request_id <> '' AND job.request_id = p.request_id)
     OR (refs.metadata_json->>'generation_job_id' <> '' AND job.id = refs.metadata_json->>'generation_job_id')
  ORDER BY (job.task_id = p.task_id) DESC,
           job.updated_at DESC NULLS LAST,
           job.id DESC
  LIMIT 1
) job ON true
LEFT JOIN LATERAL (
  SELECT alloc.*
  FROM network_task_allocations alloc
  WHERE alloc.generated_task_id = p.task_id
     OR (p.request_id <> '' AND alloc.task_request_id = p.request_id)
     OR (job.allocation_id <> '' AND alloc.id = job.allocation_id)
  ORDER BY (alloc.generated_task_id = p.task_id) DESC,
           alloc.updated_at DESC NULLS LAST,
           alloc.id DESC
  LIMIT 1
) alloc ON true
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

-- A link_failed generation job can be operationally important even when no
-- positive reward exists. Only include rows with a generated task id, because
-- this queue is task-id keyed; request-only dead chains remain owned by the
-- generation recovery lane.
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
  job.task_id,
  'network_status_packet',
  job.candidate_account_id,
  job.candidate_wallet_address,
  COALESCE(NULLIF(job.generated_task_payload->>'title', ''), p.title, 'Network task generation link failed'),
  COALESCE(NULLIF(job.generated_task_payload->>'description', ''), p.description, job.last_error),
  job.task_class,
  COALESCE(NULLIF(p.status, ''), 'proposed'),
  COALESCE(p.reward_offer_pft, job.reward_max_pft, 0),
  COALESCE(p.reward_actual_pft, 0),
  job.request_bundle_cid,
  COALESCE(NULLIF(p.last_event_cid, ''), job.offer_cid, ''),
  COALESCE(NULLIF(p.last_event_tx_hash, ''), job.offer_tx_hash, ''),
  CASE
    WHEN refs.task_id IS NOT NULL THEN '/api/hive/task-detail?taskId=' || job.task_id
    ELSE ''
  END,
  COALESCE(p.event_count, 0),
  COALESCE(p.created_at, job.created_at, now()),
  COALESCE(p.updated_at, job.updated_at, now()),
  COALESCE(NULLIF(p.last_event_tx_hash, ''), job.offer_tx_hash, ''),
  jsonb_build_object(
    'ingestedFrom', 'network_task_generation_jobs',
    'statusPacket', jsonb_build_object(
      'schema', 'pf.task_node.network_task_status_packet.v1',
      'allocationState', 'link_failed',
      'taskState', CASE
        WHEN p.status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled') THEN p.status
        ELSE 'proposed'
      END,
      'rewardMovement', CASE
        WHEN lower(COALESCE(p.metadata_json->'reward_payment_guard'->>'status', '')) IN ('submitting', 'submitted', 'submit_unknown', 'duplicate_guarded', 'duplicate') THEN 'duplicate_guarded'
        WHEN COALESCE(p.reward_actual_pft, 0) > 0 THEN 'paid_positive'
        WHEN p.status = 'rewarded' THEN 'closed_zero'
        ELSE 'none'
      END,
      'repairRequired', true,
      'repairReason', 'link_failed'
    ),
    'generationJob', jsonb_build_object(
      'id', job.id,
      'status', job.status,
      'lastError', job.last_error
    )
  ),
  now(),
  now()
FROM network_task_generation_jobs job
JOIN network_task_allocations alloc
  ON alloc.id = job.allocation_id
LEFT JOIN task_projections p
  ON p.task_id = job.task_id
LEFT JOIN LATERAL (
  SELECT refs.task_id
  FROM network_project_task_refs refs
  WHERE refs.task_id = job.task_id
  LIMIT 1
) refs ON true
WHERE job.status = 'link_failed'
  AND job.task_class = 'network'
  AND job.task_id <> ''
ON CONFLICT (task_id) DO UPDATE SET
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
