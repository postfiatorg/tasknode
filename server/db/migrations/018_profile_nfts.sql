CREATE TABLE IF NOT EXISTS profile_nfts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet_address text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated',
  image_cid text NOT NULL DEFAULT '',
  image_gateway_url text NOT NULL DEFAULT '',
  image_mime_type text NOT NULL DEFAULT '',
  image_size_bytes integer NOT NULL DEFAULT 0,
  image_sha256 text NOT NULL DEFAULT '',
  metadata_cid text NOT NULL DEFAULT '',
  metadata_uri text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_source text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  template_digest text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  size text NOT NULL DEFAULT '',
  quality text NOT NULL DEFAULT '',
  output_format text NOT NULL DEFAULT '',
  mint_tx_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  tx_hash text NOT NULL DEFAULT '',
  nft_token_id text NOT NULL DEFAULT '',
  selected boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  generated_at timestamptz,
  prepared_at timestamptz,
  minted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_nfts_account_updated_idx
  ON profile_nfts (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS profile_nfts_account_status_idx
  ON profile_nfts (account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS profile_nfts_wallet_idx
  ON profile_nfts (wallet_address)
  WHERE wallet_address <> '';
