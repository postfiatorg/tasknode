CREATE TABLE IF NOT EXISTS legacy_pftasks_chat_messages (
  source_message_id text PRIMARY KEY,
  legacy_user_id text NOT NULL,
  wallet_address text NOT NULL,
  conversation_id text NOT NULL,
  chat_type text NOT NULL DEFAULT 'chat',
  role text NOT NULL,
  body text NOT NULL,
  source_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_created_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_pftasks_chat_wallet_recent_idx
  ON legacy_pftasks_chat_messages (wallet_address, source_created_at DESC, source_message_id);

CREATE INDEX IF NOT EXISTS legacy_pftasks_chat_conversation_order_idx
  ON legacy_pftasks_chat_messages (conversation_id, source_created_at, source_message_id);

CREATE TABLE IF NOT EXISTS legacy_pftasks_tasks (
  source_task_id text PRIMARY KEY,
  legacy_user_id text NOT NULL,
  wallet_address text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_status text NOT NULL DEFAULT '',
  task_category text NOT NULL DEFAULT '',
  verification_type text NOT NULL DEFAULT '',
  verification_criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  refusal_reason text NOT NULL DEFAULT '',
  cancellation_reason text NOT NULL DEFAULT '',
  rejection_reason text NOT NULL DEFAULT '',
  reward_amount_estimate numeric,
  reward_amount_actual numeric,
  reward_tx_hash text NOT NULL DEFAULT '',
  accepted_at timestamptz,
  submitted_at timestamptz,
  verified_at timestamptz,
  reward_paid_at timestamptz,
  due_at date,
  deadline_at timestamptz,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz,
  source_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_pftasks_tasks_wallet_recent_idx
  ON legacy_pftasks_tasks (wallet_address, source_created_at DESC, source_task_id);

CREATE TABLE IF NOT EXISTS legacy_pftasks_context_revisions (
  source_revision_id text PRIMARY KEY,
  legacy_user_id text NOT NULL,
  wallet_address text NOT NULL,
  cid text NOT NULL,
  tx_hash text NOT NULL DEFAULT '',
  word_count integer,
  source_created_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_pftasks_context_wallet_recent_idx
  ON legacy_pftasks_context_revisions (wallet_address, source_created_at DESC, source_revision_id);

CREATE TABLE IF NOT EXISTS legacy_pftasks_import_runs (
  id text PRIMARY KEY,
  status text NOT NULL,
  source_label text NOT NULL DEFAULT 'pftasks_postgres',
  chat_message_count integer NOT NULL DEFAULT 0,
  task_count integer NOT NULL DEFAULT 0,
  context_revision_count integer NOT NULL DEFAULT 0,
  wallet_count integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
