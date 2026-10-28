-- L1 proofs use a separate public-key field. Existing Ledger identities and
-- billing tables are unchanged. No reward credit is enabled by this migration.
ALTER TABLE validator_bindings DROP CONSTRAINT validator_bindings_network_check;
ALTER TABLE validator_bindings ALTER COLUMN master_public_key DROP NOT NULL;
ALTER TABLE validator_bindings ADD COLUMN chain_id text;
ALTER TABLE validator_bindings ADD COLUMN validator_id text;
ALTER TABLE validator_bindings ADD COLUMN ml_dsa_public_key text;
ALTER TABLE validator_bindings ADD COLUMN registry_evidence jsonb;
ALTER TABLE validator_bindings ADD CONSTRAINT validator_bindings_network_check
  CHECK (network IN ('devnet', 'testnet', 'l1-devnet'));
ALTER TABLE validator_bindings ADD CONSTRAINT validator_bindings_identity_check CHECK (
  (network IN ('devnet', 'testnet') AND master_public_key IS NOT NULL AND chain_id IS NULL
    AND validator_id IS NULL AND ml_dsa_public_key IS NULL AND registry_evidence IS NULL)
  OR (network = 'l1-devnet' AND master_public_key IS NULL AND signing_public_key IS NULL AND manifest IS NULL
    AND chain_id IS NOT NULL AND chain_id = 'postfiat-wan-devnet-2' AND validator_id IS NOT NULL
    AND ml_dsa_public_key IS NOT NULL AND length(ml_dsa_public_key) = 3904 AND registry_evidence IS NOT NULL)
);
CREATE UNIQUE INDEX validator_bindings_active_l1_identity ON validator_bindings(network,chain_id,validator_id)
  WHERE revoked_at IS NULL AND network = 'l1-devnet';
-- ML-DSA public keys exceed a btree tuple's size. A digest enforces key identity
-- without truncating the stored public key (a digest collision fails closed).
CREATE UNIQUE INDEX validator_bindings_active_l1_key ON validator_bindings(sha256(decode(ml_dsa_public_key, 'hex')))
  WHERE revoked_at IS NULL AND network = 'l1-devnet';
