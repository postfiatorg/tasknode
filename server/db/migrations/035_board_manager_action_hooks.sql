CREATE TABLE IF NOT EXISTS board_manager_user_messages (
  id text PRIMARY KEY,
  run_id text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  message_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'sent',
  source_action text NOT NULL DEFAULT 'message_user',
  source_packet_digest text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT board_manager_user_messages_status_chk
    CHECK (status IN ('sent', 'read', 'archived'))
);

CREATE INDEX IF NOT EXISTS board_manager_user_messages_account_recent_idx
  ON board_manager_user_messages (account_id, created_at DESC, id)
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS board_manager_user_messages_run_idx
  ON board_manager_user_messages (run_id, created_at DESC, id);
