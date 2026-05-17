CREATE TABLE IF NOT EXISTS chat_attachments (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  ordinal integer NOT NULL DEFAULT 0,
  name text NOT NULL,
  mime_type text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'file',
  source text NOT NULL DEFAULT '',
  size_bytes integer NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  text_content text,
  text_excerpt text,
  storage_uri text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chat_attachments_message_fk
    FOREIGN KEY (message_id)
    REFERENCES chat_messages (id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_attachments_message_ordinal_idx
  ON chat_attachments (message_id, ordinal);

CREATE INDEX IF NOT EXISTS chat_attachments_conversation_idx
  ON chat_attachments (conversation_id, message_id, ordinal);

CREATE INDEX IF NOT EXISTS chat_attachments_account_recent_idx
  ON chat_attachments (account_id, created_at DESC, id);
