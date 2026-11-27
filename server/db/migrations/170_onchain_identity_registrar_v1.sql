-- Pillar 6: On-chain Identity Registrar, Salted Handle Reservations & Custom NIP-05 Claims
-- Migration 170 (Wave 3 Lane 4C)

CREATE TABLE IF NOT EXISTS identity_handle_reservations (
  namespace TEXT NOT NULL DEFAULT 'tasknode.postfiat.org',
  handle TEXT NOT NULL,
  account_id TEXT NOT NULL,
  l1_account TEXT NOT NULL DEFAULT '',
  nostr_pubkey_hex TEXT NOT NULL,
  derivation_version SMALLINT NOT NULL DEFAULT 1,
  commitment_hash TEXT NOT NULL,
  salt_hex TEXT NOT NULL,
  reserved_category TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'reserved',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, handle)
);

CREATE INDEX IF NOT EXISTS idx_identity_handle_reservations_account
  ON identity_handle_reservations (account_id, status);

CREATE INDEX IF NOT EXISTS idx_identity_handle_reservations_pubkey
  ON identity_handle_reservations (nostr_pubkey_hex);

CREATE TABLE IF NOT EXISTS identity_custom_nip05_claims (
  account_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  domain TEXT NOT NULL,
  local_part TEXT NOT NULL,
  nostr_pubkey_hex TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'well_known_https',
  status TEXT NOT NULL DEFAULT 'verified',
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, identifier)
);

CREATE INDEX IF NOT EXISTS idx_identity_custom_nip05_pubkey
  ON identity_custom_nip05_claims (nostr_pubkey_hex, status);

CREATE TABLE IF NOT EXISTS identity_onchain_cache (
  account_id TEXT NOT NULL,
  l1_account TEXT NOT NULL,
  nostr_pubkey_hex TEXT NOT NULL,
  derivation_version SMALLINT NOT NULL DEFAULT 1,
  key_index INTEGER NOT NULL DEFAULT 0,
  identity_kind TEXT NOT NULL DEFAULT 'human',
  registered_namespace TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  compromised BOOLEAN NOT NULL DEFAULT false,
  sequence BIGINT NOT NULL DEFAULT 1,
  relays_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  links_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  avatar_nft_id TEXT NOT NULL DEFAULT '',
  message_key TEXT NOT NULL DEFAULT '',
  pq_receive_address TEXT NOT NULL DEFAULT '',
  synced_height BIGINT NOT NULL DEFAULT 0,
  revoked_at_height BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (l1_account)
);

CREATE INDEX IF NOT EXISTS idx_identity_onchain_cache_account
  ON identity_onchain_cache (account_id);

CREATE INDEX IF NOT EXISTS idx_identity_onchain_cache_handle
  ON identity_onchain_cache (registered_namespace, handle);

CREATE INDEX IF NOT EXISTS idx_identity_onchain_cache_nostr
  ON identity_onchain_cache (nostr_pubkey_hex);
