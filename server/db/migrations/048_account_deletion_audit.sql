CREATE TABLE IF NOT EXISTS account_deletion_audit (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  archive_id text NOT NULL,
  reason text NOT NULL DEFAULT '',
  deleted_at timestamptz NOT NULL DEFAULT now(),
  wallet_address text NOT NULL DEFAULT '',
  ethereum_deposit_address text NOT NULL DEFAULT '',
  provider_identity_hashes text[] NOT NULL DEFAULT '{}',
  provider_summaries_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_email_hash text NOT NULL DEFAULT '',
  actor_session_hash text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS account_deletion_audit_account_idx
  ON account_deletion_audit (account_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS account_deletion_audit_archive_idx
  ON account_deletion_audit (archive_id);

CREATE INDEX IF NOT EXISTS account_deletion_audit_wallet_idx
  ON account_deletion_audit (wallet_address)
  WHERE wallet_address <> '';

CREATE INDEX IF NOT EXISTS account_deletion_audit_eth_deposit_idx
  ON account_deletion_audit (ethereum_deposit_address)
  WHERE ethereum_deposit_address <> '';

CREATE INDEX IF NOT EXISTS account_deletion_audit_provider_hashes_idx
  ON account_deletion_audit USING gin (provider_identity_hashes);

CREATE INDEX IF NOT EXISTS account_deletion_audit_email_hash_idx
  ON account_deletion_audit (primary_email_hash)
  WHERE primary_email_hash <> '';
