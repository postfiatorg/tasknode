-- Pillar 9 Finance Hub: daily Top-30 snapshots, anti-bounce grace cooldowns,
-- operator suspensions, signed Publish API replay nonces + monotonic manifest
-- history, per-account Today desk state (watchlist + visit baseline), and
-- per-account access audit log.

CREATE TABLE IF NOT EXISTS finance_hub_top30_snapshots (
  snapshot_id text PRIMARY KEY,
  snapshot_date_utc date NOT NULL,
  snapshot_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'fallback_retained')),
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_hub_top30_snapshots_at_idx
  ON finance_hub_top30_snapshots (snapshot_at DESC);

CREATE TABLE IF NOT EXISTS finance_hub_grace_cooldowns (
  account_id text PRIMARY KEY,
  grace_started_at timestamptz NOT NULL,
  grace_ends_at timestamptz NOT NULL,
  grace_cooldown_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_hub_grace_cooldowns_until_idx
  ON finance_hub_grace_cooldowns (grace_cooldown_until DESC);

CREATE TABLE IF NOT EXISTS finance_hub_suspensions (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS finance_hub_suspensions_active_idx
  ON finance_hub_suspensions (account_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_hub_publish_nonces (
  index_id text NOT NULL,
  nonce text NOT NULL,
  version integer NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_id, nonce)
);
CREATE INDEX IF NOT EXISTS finance_hub_publish_nonces_expiry_idx
  ON finance_hub_publish_nonces (expires_at);

CREATE TABLE IF NOT EXISTS finance_hub_publish_manifests (
  index_id text NOT NULL,
  version integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('publish', 'rollback')),
  manifest_sha256 text NOT NULL,
  bundle_hash text NOT NULL,
  rollback_target_version integer,
  file_count integer NOT NULL,
  total_bytes integer NOT NULL,
  allowed_bases jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_id text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm IN ('ed25519', 'hmac-sha256')),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_id, version)
);
CREATE INDEX IF NOT EXISTS finance_hub_publish_manifests_hash_idx
  ON finance_hub_publish_manifests (index_id, manifest_sha256);

CREATE TABLE IF NOT EXISTS finance_hub_user_state (
  account_id text PRIMARY KEY,
  watchlist_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  visit_baseline_at timestamptz,
  last_active_at timestamptz,
  goodbrief_notify_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_hub_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  index_id text NOT NULL,
  file_path text NOT NULL,
  access_basis text NOT NULL DEFAULT '',
  watermark_id text NOT NULL DEFAULT '',
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_hub_access_audit_account_idx
  ON finance_hub_access_audit (account_id, created_at DESC);
