-- Password credentials, retained browser accounts, and the active-wallet
-- ownership invariant. Existing duplicate active wallet rows intentionally make
-- the final index fail so ownership is never selected by migration order.

CREATE TABLE IF NOT EXISTS account_password_credentials (
  account_id text PRIMARY KEY REFERENCES app_accounts(account_id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS device_account_sets (
  set_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  rotation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_account_sets_active_idx
  ON device_account_sets (expires_at, last_used_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_account_set_members (
  set_id uuid NOT NULL REFERENCES device_account_sets(set_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES app_accounts(account_id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (set_id, account_id)
);

CREATE INDEX IF NOT EXISTS device_account_set_members_account_idx
  ON device_account_set_members (account_id, added_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS device_account_set_id uuid
  REFERENCES device_account_sets(set_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_device_account_set_active_idx
  ON auth_sessions (device_account_set_id, expires_at DESC)
  WHERE revoked_at IS NULL AND device_account_set_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS account_linked_wallets_active_wallet_unique_idx
  ON account_linked_wallets (wallet_address)
  WHERE status = 'linked';
