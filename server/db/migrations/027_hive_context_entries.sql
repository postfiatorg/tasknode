CREATE TABLE IF NOT EXISTS hive_context_entries (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  body_sha256 text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'chat_hive_input',
  source_conversation_id text NOT NULL DEFAULT '',
  source_conversation_title text NOT NULL DEFAULT '',
  attachments_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS hive_context_entries_user_sort_idx
  ON hive_context_entries (lower(display_name), account_id, created_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS hive_context_entries_recent_idx
  ON hive_context_entries (created_at DESC, id)
  WHERE deleted_at IS NULL;
