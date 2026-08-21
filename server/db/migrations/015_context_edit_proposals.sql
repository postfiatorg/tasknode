CREATE TABLE IF NOT EXISTS context_edit_proposals (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  assistant_message_id text NOT NULL,
  base_context_revision integer NOT NULL DEFAULT 0,
  base_body_sha256 text NOT NULL DEFAULT '',
  operation text NOT NULL,
  anchor_type text NOT NULL DEFAULT '',
  line_start integer,
  line_end integer,
  target_heading text NOT NULL DEFAULT '',
  target_before text NOT NULL DEFAULT '',
  target_after text NOT NULL DEFAULT '',
  rationale text NOT NULL DEFAULT '',
  risk text NOT NULL DEFAULT 'low',
  state text NOT NULL DEFAULT 'pending',
  saved_context_revision integer,
  saved_context_document_id text,
  saved_context_hash text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  rejected_at timestamptz
);

CREATE INDEX IF NOT EXISTS context_edit_proposals_account_recent_idx
  ON context_edit_proposals (account_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS context_edit_proposals_conversation_state_idx
  ON context_edit_proposals (account_id, conversation_id, state, updated_at DESC, id);
