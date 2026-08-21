CREATE TABLE IF NOT EXISTS task_requests (
  request_id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  subject_wallet text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'task_interface',
  source_conversation_id text NOT NULL DEFAULT '',
  source_conversation_title text NOT NULL DEFAULT '',
  request_text text NOT NULL DEFAULT '',
  user_detail_text text NOT NULL DEFAULT '',
  requested_task_kind text NOT NULL DEFAULT 'personal',
  request_bundle_cid text NOT NULL DEFAULT '',
  request_event_cid text NOT NULL DEFAULT '',
  request_tx_hash text NOT NULL DEFAULT '',
  bundle_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'published',
  generated_task_id text NOT NULL DEFAULT '',
  worker_claimed_at timestamptz,
  worker_completed_at timestamptz,
  worker_attempt_count integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_requests_account_recent_idx
  ON task_requests (account_id, updated_at DESC, request_id);

CREATE INDEX IF NOT EXISTS task_requests_wallet_status_recent_idx
  ON task_requests (subject_wallet, status, updated_at DESC, request_id);

CREATE INDEX IF NOT EXISTS task_requests_status_recent_idx
  ON task_requests (status, updated_at DESC, request_id);

INSERT INTO task_requests (
  request_id,
  account_id,
  source,
  source_conversation_id,
  source_conversation_title,
  request_text,
  user_detail_text,
  requested_task_kind,
  request_bundle_cid,
  request_event_cid,
  request_tx_hash,
  bundle_id,
  status,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  request_id,
  account_id,
  source,
  conversation_id,
  source_conversation_title,
  request_text,
  user_detail_text,
  requested_task_kind,
  request_bundle_cid,
  request_event_cid,
  request_tx_hash,
  bundle_id,
  status,
  metadata_json,
  created_at,
  created_at
FROM (
  SELECT DISTINCT ON (metadata_json->>'requestId')
    metadata_json->>'requestId' AS request_id,
    account_id,
    COALESCE(NULLIF(metadata_json->>'source', ''), 'task_interface') AS source,
    COALESCE(NULLIF(metadata_json->>'conversationId', ''), conversation_id) AS conversation_id,
    COALESCE(NULLIF(metadata_json->>'sourceConversationTitle', ''), 'Task request') AS source_conversation_title,
    COALESCE(NULLIF(metadata_json->>'requestText', ''), '') AS request_text,
    COALESCE(NULLIF(metadata_json->>'userDetailText', ''), body) AS user_detail_text,
    COALESCE(NULLIF(metadata_json->>'requestedTaskKind', ''), 'personal') AS requested_task_kind,
    COALESCE(NULLIF(metadata_json->>'requestBundleCid', ''), '') AS request_bundle_cid,
    COALESCE(NULLIF(metadata_json->>'requestEventCid', ''), '') AS request_event_cid,
    COALESCE(NULLIF(metadata_json->>'txHash', ''), '') AS request_tx_hash,
    COALESCE(NULLIF(metadata_json->>'bundleId', ''), '') AS bundle_id,
    CASE
      WHEN COALESCE(NULLIF(metadata_json->>'status', ''), '') = 'pftl_request_published' THEN 'published'
      ELSE COALESCE(NULLIF(metadata_json->>'status', ''), 'published')
    END AS status,
    metadata_json,
    created_at
  FROM chat_messages
  WHERE metadata_json->>'kind' = 'task_request_intent'
    AND COALESCE(metadata_json->>'requestId', '') <> ''
  ORDER BY metadata_json->>'requestId', created_at DESC
) AS existing_requests
ON CONFLICT (request_id) DO NOTHING;
