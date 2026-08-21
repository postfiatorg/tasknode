-- A PFTL connection failure happens before submitAndWait is called, so no
-- transaction can have reached the network. Older review workers classified
-- these failures as submit_unknown and permanently excluded them from claims.
UPDATE task_review_publications AS publication
SET status = 'retry_wait',
    metadata_json = COALESCE(publication.metadata_json, '{}'::jsonb) || jsonb_build_object(
      'retry_count', GREATEST(COALESCE((publication.metadata_json->>'retry_count')::integer, 0), 1),
      'retry_after', now(),
      'submission_attempted', false,
      'submission_stage', 'historical_connect_before_submit'
    ),
    updated_at = now()
WHERE publication.worker_name = 'reward_scoring'
  AND publication.status = 'error'
  AND publication.error = 'PFTL websocket endpoint could not be reached.'
  AND publication.source_tx_hash = ''
  AND publication.source_cid = '';

UPDATE task_projections AS projection
SET metadata_json = jsonb_set(
      COALESCE(projection.metadata_json, '{}'::jsonb),
      '{reward_payment_guard}',
      COALESCE(projection.metadata_json->'reward_payment_guard', '{}'::jsonb) || jsonb_build_object(
        'status', 'retry_wait',
        'retry_after', now(),
        'last_error', 'PFTL websocket endpoint could not be reached.',
        'updated_at', now()
      ),
      true
    ),
    updated_at = now()
WHERE COALESCE(projection.metadata_json->'reward_payment_guard'->>'status', '') = 'submit_unknown'
  AND COALESCE(projection.metadata_json->'reward_payment_guard'->>'last_error', '') =
      'PFTL websocket endpoint could not be reached.'
  AND EXISTS (
    SELECT 1
    FROM task_review_publications AS publication
    WHERE publication.task_id = projection.task_id
      AND publication.worker_name = 'reward_scoring'
      AND publication.status = 'retry_wait'
      AND publication.source_tx_hash = ''
      AND publication.source_cid = ''
      AND publication.metadata_json->>'submission_stage' = 'historical_connect_before_submit'
  );
