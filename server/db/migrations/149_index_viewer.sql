-- Index viewer: wallet-gated research bundles published on static sites.
--
-- Bundles are encrypted at publish time and hosted publicly (GitHub Pages).
-- Task Node custodies the symmetric content key and releases it only to an
-- account with a linked wallet, so the gate is membership rather than a shared
-- password. Nothing here stores plaintext report content.

CREATE TABLE IF NOT EXISTS index_viewer_indices (
  index_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'tasknode-active-wallet',
  content_key TEXT NOT NULL,
  content_url TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time authorization codes handed back to the static site after the
-- account has been identified. Short lived and single use.
CREATE TABLE IF NOT EXISTS index_viewer_codes (
  code_hash TEXT PRIMARY KEY,
  index_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  return_origin TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS index_viewer_codes_expiry
  ON index_viewer_codes (expires_at);

-- Viewer tokens exchanged from a code. Scoped to one index and one account so
-- a leaked token cannot unlock the whole catalog.
CREATE TABLE IF NOT EXISTS index_viewer_tokens (
  token_hash TEXT PRIMARY KEY,
  index_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS index_viewer_tokens_account
  ON index_viewer_tokens (account_id, index_id);
CREATE INDEX IF NOT EXISTS index_viewer_tokens_expiry
  ON index_viewer_tokens (expires_at);
