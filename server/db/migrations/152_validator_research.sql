-- Validator proofs are separate from wallet login and existing shadow evidence.
CREATE TABLE validator_challenges (
  challenge text PRIMARY KEY,
  account_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validator_challenges_account ON validator_challenges(account_id, created_at DESC);
CREATE TABLE validator_bindings (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  master_public_key text NOT NULL,
  network text NOT NULL CHECK (network IN ('devnet','testnet')),
  signature text NOT NULL,
  challenge text NOT NULL REFERENCES validator_challenges(challenge),
  bound_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX validator_bindings_active_key ON validator_bindings(master_public_key) WHERE revoked_at IS NULL;
CREATE INDEX validator_bindings_account ON validator_bindings(account_id) WHERE revoked_at IS NULL;
CREATE TABLE validator_reward_grants (
  idempotency_key text PRIMARY KEY,
  master_public_key text NOT NULL,
  account_id text NOT NULL,
  reward_month text NOT NULL,
  amount_usd numeric(18,6) NOT NULL CHECK (amount_usd = 20),
  evidence_json jsonb NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(master_public_key, reward_month)
);
CREATE TABLE research_api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  name text NOT NULL DEFAULT '',
  scope text NOT NULL CHECK (scope = 'research:run'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX research_api_keys_account ON research_api_keys(account_id, created_at DESC);
CREATE TABLE research_gateway_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  api_key_id text REFERENCES research_api_keys(id) ON DELETE SET NULL,
  upstream_id text UNIQUE,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  request_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitting',
  cost_usd numeric(30,12) CHECK (cost_usd >= 0),
  billed_at timestamptz,
  result_json jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, request_key)
);
CREATE INDEX research_gateway_jobs_pending ON research_gateway_jobs(updated_at) WHERE billed_at IS NULL;
-- Revoke old unbound grants at release. Old browser viewers can restart auth.
ALTER TABLE index_viewer_tokens ADD COLUMN return_origin text NOT NULL DEFAULT '';
UPDATE index_viewer_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
UPDATE index_viewer_codes SET consumed_at = now() WHERE consumed_at IS NULL;
