-- New public Nostr room. Private legacy Hive conversations are never imported.
CREATE TABLE hive_group_channels (
  id text PRIMARY KEY,
  root_event jsonb NOT NULL,
  bot_pubkey text NOT NULL,
  metadata_event jsonb NOT NULL,
  relays jsonb NOT NULL,
  published_at timestamptz,
  bot_cursor bigint NOT NULL DEFAULT 0,
  bot_next_at timestamptz NOT NULL DEFAULT now(),
  bot_claim text NOT NULL DEFAULT '',
  bot_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE hive_group_message_sequence;
CREATE TABLE hive_group_messages (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES hive_group_channels(id),
  sequence bigint UNIQUE,
  account_id text NOT NULL DEFAULT '',
  author_pubkey text NOT NULL,
  author_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_json jsonb NOT NULL,
  actor text NOT NULL DEFAULT 'member',
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','delivered')),
  relay_url text NOT NULL DEFAULT '',
  publish_attempts integer NOT NULL DEFAULT 0,
  next_publish_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_group_messages_feed ON hive_group_messages(channel_id,sequence DESC);
CREATE INDEX hive_group_messages_outbox ON hive_group_messages(next_publish_at) WHERE delivery_state='pending';
CREATE TABLE hive_group_reads (
  account_id text PRIMARY KEY,
  last_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hive_group_bot_runs (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES hive_group_channels(id),
  through_sequence bigint NOT NULL,
  decision_json jsonb NOT NULL,
  reply_event_id text NOT NULL DEFAULT '',
  decision_model text NOT NULL DEFAULT '',
  reply_model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id,through_sequence)
);
CREATE TABLE hive_group_escalations (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES hive_group_channels(id),
  board_id text NOT NULL REFERENCES network_projects(id),
  source_event_id text NOT NULL REFERENCES hive_group_messages(id),
  summary text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved','declined')),
  response_event_id text NOT NULL DEFAULT '',
  resolved_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(board_id,source_event_id)
);
CREATE INDEX hive_group_escalations_pending ON hive_group_escalations(board_id,created_at) WHERE state='pending';
