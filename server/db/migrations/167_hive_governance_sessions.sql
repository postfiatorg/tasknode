-- Pillar 1 — Multi-Channel Hive & Governance Session Engine Foundation.
-- Strictly additive migration preserving existing default channel (`tasknode-hive-v1`)
-- and implementing carry-over accountability with zero automatic PFT bounties.

ALTER TABLE hive_group_channels
  ADD COLUMN IF NOT EXISTS channel_kind text NOT NULL DEFAULT 'general'
    CHECK (channel_kind IN ('general', 'governance')),
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS session_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS posting_policy text NOT NULL DEFAULT 'all_members'
    CHECK (posting_policy IN ('founder_only', 'allowlist', 'all_members')),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('scheduled', 'active', 'closed', 'archived'));

CREATE INDEX IF NOT EXISTS hive_group_channels_kind_status
  ON hive_group_channels(channel_kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS hive_group_channel_reads (
  account_id text NOT NULL,
  channel_id text NOT NULL REFERENCES hive_group_channels(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, channel_id)
);

CREATE TABLE IF NOT EXISTS hive_governance_sessions (
  session_id text PRIMARY KEY,
  session_number bigint NOT NULL UNIQUE,
  channel_id text NOT NULL REFERENCES hive_group_channels(id),
  state text NOT NULL CHECK (state IN ('scheduled', 'live', 'closing', 'anchored', 'archived', 'aborted')),
  proto_state text NOT NULL DEFAULT 'SESSION_STATE_DRAFT',
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  chain_id text NOT NULL DEFAULT 'postfiat-l1-v2',
  founder_account_id text NOT NULL,
  founder_l1_address text NOT NULL DEFAULT '',
  founder_nostr_pubkey text NOT NULL DEFAULT '',
  posting_policy text NOT NULL DEFAULT 'all_members'
    CHECK (posting_policy IN ('founder_only', 'allowlist', 'all_members')),
  facilitator_mode text NOT NULL DEFAULT 'agenda'
    CHECK (facilitator_mode IN ('off', 'agenda', 'interactive')),
  duration_minutes integer NOT NULL DEFAULT 30,
  rate_limit_seconds integer NOT NULL DEFAULT 15,
  max_non_founder_messages integer NOT NULL DEFAULT 10,
  max_facilitator_turns integer NOT NULL DEFAULT 25,
  reserved_founder_turns integer NOT NULL DEFAULT 15,
  previous_session_id text NOT NULL DEFAULT '',
  eligible_pubkeys_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligible_pubkeys_cid text NOT NULL DEFAULT '',
  eligible_pubkeys_sha256 text NOT NULL DEFAULT '',
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_cid text NOT NULL DEFAULT '',
  snapshot_sha256 text NOT NULL DEFAULT '',
  packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  packet_cid text NOT NULL DEFAULT '',
  packet_sha256 text NOT NULL DEFAULT '',
  transcript_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  transcript_cid text NOT NULL DEFAULT '',
  transcript_root_sha256 text NOT NULL DEFAULT '',
  minutes_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  minutes_revision integer NOT NULL DEFAULT 0,
  minutes_cid text NOT NULL DEFAULT '',
  minutes_sha256 text NOT NULL DEFAULT '',
  anchors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ruling_state text NOT NULL DEFAULT 'none'
    CHECK (ruling_state IN ('none', 'ruling_pending', 'ruling_anchored')),
  ruling_anchors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  scheduled_close_at timestamptz,
  closed_at timestamptz,
  anchored_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hive_governance_sessions_state_idx
  ON hive_governance_sessions(state, session_number DESC);

-- Direct carry-over accountability table (strictly NO automatic PFT bounty columns).
CREATE TABLE IF NOT EXISTS hive_governance_deliverables (
  id text PRIMARY KEY,
  origin_session_id text NOT NULL REFERENCES hive_governance_sessions(session_id) ON DELETE CASCADE,
  reviewed_in_session_id text NOT NULL DEFAULT '',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner text NOT NULL DEFAULT '',
  target_date text NOT NULL DEFAULT '',
  cited_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'in_progress', 'not_done', 'dropped')),
  evidence_note text NOT NULL DEFAULT '',
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hive_governance_deliverables_origin_idx
  ON hive_governance_deliverables(origin_session_id, status);

-- Idempotent postfiatl1v2 anchor tracking keyed by (session_id, artifact_schema, sha256).
CREATE TABLE IF NOT EXISTS hive_governance_anchors (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES hive_governance_sessions(session_id) ON DELETE CASCADE,
  artifact_schema text NOT NULL,
  sha256 text NOT NULL,
  cid text NOT NULL,
  memo_hex text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  block_height bigint,
  pinner_confirmations integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'confirmed', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, artifact_schema, sha256)
);
