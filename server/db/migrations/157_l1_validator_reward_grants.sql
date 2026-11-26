-- Separate L1 reward receipts preserve existing Ledger reward/billing schemas.
CREATE TABLE l1_validator_reward_grants (
  idempotency_key text PRIMARY KEY,
  network text NOT NULL CHECK (network = 'l1-devnet'),
  chain_id text NOT NULL,
  validator_id text NOT NULL,
  ml_dsa_public_key text NOT NULL,
  account_id text NOT NULL,
  reward_month text NOT NULL,
  amount_usd numeric(18,6) NOT NULL CHECK (amount_usd = 20),
  evidence_json jsonb NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network, chain_id, validator_id, reward_month)
);
CREATE UNIQUE INDEX l1_validator_rewards_key_month
  ON l1_validator_reward_grants(sha256(decode(ml_dsa_public_key, 'hex')), reward_month);
