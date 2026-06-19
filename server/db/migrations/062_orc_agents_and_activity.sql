CREATE TABLE IF NOT EXISTS orc_agents (
  id text PRIMARY KEY,
  handle text NOT NULL DEFAULT '',
  agent_id text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'operator',
  status text NOT NULL DEFAULT 'active',
  active boolean NOT NULL DEFAULT true,
  runtime_kind text NOT NULL DEFAULT 'codex',
  tmux_target text NOT NULL DEFAULT '',
  capacity_limit integer NOT NULL DEFAULT 1,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_agents
  ADD COLUMN IF NOT EXISTS handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS wallet_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS runtime_kind text NOT NULL DEFAULT 'codex',
  ADD COLUMN IF NOT EXISTS tmux_target text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS capacity_limit integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS orc_agents_handle_unique_idx
  ON orc_agents (lower(handle))
  WHERE handle <> '';

CREATE INDEX IF NOT EXISTS orc_agents_active_status_idx
  ON orc_agents (active, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS orc_agents_account_idx
  ON orc_agents (account_id)
  WHERE account_id <> '';

CREATE INDEX IF NOT EXISTS orc_agents_wallet_idx
  ON orc_agents (wallet_address)
  WHERE wallet_address <> '';

CREATE TABLE IF NOT EXISTS orc_run_journal (
  id text PRIMARY KEY,
  orc_handle text NOT NULL DEFAULT '',
  agent_id text NOT NULL DEFAULT '',
  command text NOT NULL DEFAULT '',
  phase text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'recorded',
  task_id text NOT NULL DEFAULT '',
  followup_task_id text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_run_journal
  ADD COLUMN IF NOT EXISTS orc_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS command text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS followup_task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cid text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tx_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS orc_run_journal_orc_idx
  ON orc_run_journal (orc_handle, created_at DESC);

CREATE INDEX IF NOT EXISTS orc_run_journal_task_idx
  ON orc_run_journal (task_id, created_at DESC)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS orc_run_journal_status_idx
  ON orc_run_journal (status, created_at DESC);

CREATE TABLE IF NOT EXISTS orc_operator_interactions (
  id text PRIMARY KEY,
  orc_handle text NOT NULL DEFAULT '',
  interaction_type text NOT NULL,
  directive text NOT NULL DEFAULT '',
  issue text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'recorded',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_operator_interactions
  ADD COLUMN IF NOT EXISTS orc_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS interaction_type text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS directive text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS issue text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS orc_operator_interactions_orc_idx
  ON orc_operator_interactions (orc_handle, created_at DESC);

CREATE INDEX IF NOT EXISTS orc_operator_interactions_type_idx
  ON orc_operator_interactions (interaction_type, created_at DESC);

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
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_review_states
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
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE orc_task_review_states
  DROP CONSTRAINT IF EXISTS orc_task_review_states_disposition_check;
ALTER TABLE orc_task_review_states
  ADD CONSTRAINT orc_task_review_states_disposition_check
    CHECK (disposition = ANY(ARRAY[
      'not_reviewed',
      'in_review',
      'reviewed_no_action',
      'reviewed_follow_up',
      'reviewed_follow_up_completed',
      'reviewed_integrity_follow_up',
      'reviewed_unclear',
      'reviewed_duplicate_or_superseded'
    ]::text[]));

ALTER TABLE orc_task_review_states
  DROP CONSTRAINT IF EXISTS orc_task_review_states_confidence_check;
ALTER TABLE orc_task_review_states
  ADD CONSTRAINT orc_task_review_states_confidence_check
    CHECK (confidence = ANY(ARRAY['low', 'medium', 'high']::text[]));

CREATE INDEX IF NOT EXISTS orc_task_review_states_disposition_idx
  ON orc_task_review_states (disposition, updated_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_review_states_action_idx
  ON orc_task_review_states (action_required, updated_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_review_states_categories_idx
  ON orc_task_review_states USING gin (categories);

CREATE INDEX IF NOT EXISTS orc_task_review_states_integrity_idx
  ON orc_task_review_states USING gin (integrity_signals);

CREATE OR REPLACE VIEW orc_task_review_queue AS
SELECT
  p.task_id,
  p.account_id,
  p.subject_wallet AS wallet_address,
  p.title,
  p.status AS task_status,
  p.reward_offer_pft::text AS reward_offer_pft,
  p.reward_actual_pft::text AS reward_actual_pft,
  p.request_bundle_cid,
  p.last_event_cid,
  p.last_event_tx_hash,
  p.updated_at AS task_updated_at,
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
FROM task_projections p
LEFT JOIN orc_task_review_states s
  ON s.task_id = p.task_id
WHERE lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', '')) = 'network'
  AND p.status = 'rewarded'
  AND p.reward_actual_pft > 0
  AND COALESCE(p.event_count, 0) > 0
  AND COALESCE(p.last_event_tx_hash, '') <> ''
  AND COALESCE(p.last_event_cid, '') <> ''
  AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
  AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
  AND p.task_id NOT LIKE 'directory_polish_%'
  AND p.task_id NOT LIKE 'task_cancel_paid_%';
