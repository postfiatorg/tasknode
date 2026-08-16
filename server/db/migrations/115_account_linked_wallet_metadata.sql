ALTER TABLE account_linked_wallets
  ADD COLUMN IF NOT EXISTS public_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS encryption_public_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS custody text NOT NULL DEFAULT 'local_seed_required',
  ADD COLUMN IF NOT EXISTS proof_purpose text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS wallet_created_in_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS proof_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
