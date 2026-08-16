CREATE TABLE IF NOT EXISTS app_accounts (
  account_id text PRIMARY KEY,
  account_json jsonb NOT NULL,
  hive_handle text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_hive_handle_unique_idx
  ON app_accounts (lower(hive_handle))
  WHERE hive_handle IS NOT NULL AND hive_handle <> '';

CREATE TABLE IF NOT EXISTS account_email_identities (
  email_canonical text PRIMARY KEY,
  account_id text NOT NULL REFERENCES app_accounts(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_email_identities_account_idx
  ON account_email_identities (account_id);

CREATE TABLE IF NOT EXISTS account_provider_identities (
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  account_id text NOT NULL REFERENCES app_accounts(account_id) ON DELETE CASCADE,
  identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS account_provider_identities_account_idx
  ON account_provider_identities (account_id);
