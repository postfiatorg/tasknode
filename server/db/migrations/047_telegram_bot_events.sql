CREATE TABLE IF NOT EXISTS telegram_bot_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  account_id text NOT NULL DEFAULT '',
  provider_user_id text NOT NULL DEFAULT '',
  chat_id text NOT NULL DEFAULT '',
  update_id text NOT NULL DEFAULT '',
  message_id text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  text_preview text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_bot_events_account_recent_idx
  ON telegram_bot_events (account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_bot_events_provider_recent_idx
  ON telegram_bot_events (provider_user_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS telegram_bot_events_chat_recent_idx
  ON telegram_bot_events (chat_id, created_at DESC, id);
