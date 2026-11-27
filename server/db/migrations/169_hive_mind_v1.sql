-- Pillar 10: Information Hive Mind schema delta on migration 158_finance_agent.sql.
-- Strictly enforces hash-only MNPI refusal logging (zero raw user text columns),
-- contributor-confirmed knowledge areas, two-phase isolated interviews, signed claims,
-- corroboration clustering, model-owner proposals, idempotent accelerated alpha rewards,
-- and encrypted Pillar 2 claim packets.

CREATE TABLE hive_mind_contributor_profiles (
  account_id text PRIMARY KEY,
  confirmed boolean NOT NULL DEFAULT false,
  confirmed_areas_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_info_types_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_summary text NOT NULL DEFAULT '',
  attribution_mode text NOT NULL DEFAULT 'pseudonym'
    CHECK (attribution_mode IN ('handle', 'hive_identity', 'pseudonym')),
  attribution_label text NOT NULL DEFAULT '',
  domain_weight numeric(8,4) NOT NULL DEFAULT 1.0000
    CHECK (domain_weight >= 0.1000 AND domain_weight <= 5.0000),
  max_concurrent_interviews integer NOT NULL DEFAULT 3
    CHECK (max_concurrent_interviews >= 1 AND max_concurrent_interviews <= 10),
  verified_claims_count integer NOT NULL DEFAULT 0,
  falsified_claims_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hive_mind_attestations (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  model_id text NOT NULL,
  relationship text NOT NULL,
  no_mnpi_attested boolean NOT NULL DEFAULT false,
  no_nda_violation_attested boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  block_reason text NOT NULL DEFAULT '',
  attestation_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_attestations_account_model
  ON hive_mind_attestations(account_id, model_id, created_at DESC);

-- STRICT COMPLIANCE TABLE: NEVER add raw text, message, excerpt, or transcript columns.
CREATE TABLE hive_mind_mnpi_refusal_audit (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  model_id text NOT NULL,
  thread_id text NOT NULL DEFAULT '',
  reason_code text NOT NULL,
  salted_sha256 text NOT NULL,
  salt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_mnpi_refusal_audit_account
  ON hive_mind_mnpi_refusal_audit(account_id, created_at DESC);
CREATE INDEX hive_mind_mnpi_refusal_audit_model
  ON hive_mind_mnpi_refusal_audit(model_id, created_at DESC);

CREATE TABLE hive_mind_interviews (
  id text PRIMARY KEY,
  thread_id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  model_id text NOT NULL,
  ticker text NOT NULL,
  asset_class text NOT NULL
    CHECK (asset_class IN ('crypto_protocol', 'perp_megacap_equity')),
  access_tier text NOT NULL
    CHECK (access_tier IN ('public_only', 'member')),
  phase text NOT NULL DEFAULT 'phase1_triangulation'
    CHECK (phase IN ('phase1_triangulation', 'phase2_targeted', 'completed', 'refused')),
  attestation_id text NOT NULL REFERENCES hive_mind_attestations(id),
  sanitized_brief_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  triangulation_score numeric(5,2) NOT NULL DEFAULT 0,
  observed_roles_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  turn_count integer NOT NULL DEFAULT 0,
  max_turns integer NOT NULL DEFAULT 8,
  token_count integer NOT NULL DEFAULT 0,
  max_tokens integer NOT NULL DEFAULT 8000,
  paid_interview_eligible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'refused', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_interviews_account_status
  ON hive_mind_interviews(account_id, status, updated_at DESC);
CREATE INDEX hive_mind_interviews_model
  ON hive_mind_interviews(model_id, created_at DESC);

CREATE TABLE hive_mind_claim_clusters (
  id text PRIMARY KEY,
  model_id text NOT NULL,
  topic_key text NOT NULL,
  consensus_status text NOT NULL DEFAULT 'single_source'
    CHECK (consensus_status IN ('single_source', 'consensus', 'contested')),
  weighted_stance text NOT NULL DEFAULT 'refines'
    CHECK (weighted_stance IN ('confirms', 'refines', 'challenges', 'contested')),
  corroborating_accounts_count integer NOT NULL DEFAULT 1,
  weighted_confidence numeric(8,4) NOT NULL DEFAULT 0,
  reviewer_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_claim_clusters_model
  ON hive_mind_claim_clusters(model_id, updated_at DESC);

CREATE TABLE hive_mind_claims (
  id text PRIMARY KEY,
  interview_id text NOT NULL REFERENCES hive_mind_interviews(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  ticker text NOT NULL,
  asset_class text NOT NULL
    CHECK (asset_class IN ('crypto_protocol', 'perp_megacap_equity')),
  account_id text NOT NULL,
  attribution_mode text NOT NULL
    CHECK (attribution_mode IN ('handle', 'hive_identity', 'pseudonym')),
  attribution_label text NOT NULL,
  claim_text text NOT NULL,
  info_type text NOT NULL
    CHECK (info_type IN ('operator', 'builder', 'customer', 'trader', 'public_data_analyst')),
  stance text NOT NULL
    CHECK (stance IN ('confirms', 'refines', 'challenges')),
  evidence_mechanism text NOT NULL,
  client_signature_json jsonb NOT NULL,
  model_estimate_before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  market_consensus_before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_event_key text NOT NULL DEFAULT '',
  check_event_date text NOT NULL DEFAULT '',
  check_event_description text NOT NULL DEFAULT '',
  checkable boolean NOT NULL DEFAULT false,
  screening_result text NOT NULL
    CHECK (screening_result IN ('pass', 'redacted_confirmed')),
  attestation_id text NOT NULL REFERENCES hive_mind_attestations(id),
  cluster_id text REFERENCES hive_mind_claim_clusters(id),
  novelty_score numeric(5,2) NOT NULL DEFAULT 0,
  evidence_score numeric(5,2) NOT NULL DEFAULT 0,
  checkability_score numeric(5,2) NOT NULL DEFAULT 0,
  contributor_weight numeric(8,4) NOT NULL DEFAULT 1.0000,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'verified', 'falsified', 'unresolvable')),
  forecast_accuracy_delta numeric(10,4),
  takedown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_claims_model_status
  ON hive_mind_claims(model_id, status, created_at DESC);
CREATE INDEX hive_mind_claims_cluster
  ON hive_mind_claims(cluster_id);
CREATE INDEX hive_mind_claims_anti_hedge
  ON hive_mind_claims(account_id, model_id, check_event_key)
  WHERE check_event_key <> '';

CREATE TABLE hive_mind_proposals (
  id text PRIMARY KEY,
  cluster_id text NOT NULL REFERENCES hive_mind_claim_clusters(id),
  model_id text NOT NULL,
  owner_account_id text NOT NULL DEFAULT '',
  submitted_by_accounts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'escalated_operator', 'approved', 'rejected', 'applied', 'unresolvable')),
  changelog_entry text NOT NULL DEFAULT '',
  decided_by text NOT NULL DEFAULT '',
  decided_at timestamptz,
  applied_commit_ref text NOT NULL DEFAULT '',
  applied_changelog_ref text NOT NULL DEFAULT '',
  applied_at timestamptz,
  escalate_after timestamptz NOT NULL,
  expire_after timestamptz NOT NULL,
  takedown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_proposals_status
  ON hive_mind_proposals(status, updated_at DESC);
CREATE INDEX hive_mind_proposals_model
  ON hive_mind_proposals(model_id, created_at DESC);

CREATE TABLE hive_mind_reward_ledger (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  claim_id text NOT NULL REFERENCES hive_mind_claims(id),
  cluster_id text NOT NULL,
  proposal_id text NOT NULL DEFAULT '',
  account_id text NOT NULL,
  model_id text NOT NULL,
  payout_type text NOT NULL
    CHECK (payout_type IN ('citation_fast', 'alpha_verified_bonus')),
  usd_equivalent numeric(12,4) NOT NULL DEFAULT 0,
  pft_amount numeric(16,4) NOT NULL DEFAULT 0,
  multiplier numeric(6,3) NOT NULL DEFAULT 1.000,
  cluster_share_ratio numeric(8,6) NOT NULL DEFAULT 1.000000,
  badge_cap_applied_pft numeric(16,4) NOT NULL DEFAULT 0,
  sybil_review_status text NOT NULL DEFAULT 'clear'
    CHECK (sybil_review_status IN ('clear', 'flagged', 'blocked')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'disbursed', 'blocked_cap', 'blocked_sybil', 'blocked_counsel', 'zero_falsified')),
  forecast_accuracy_delta numeric(10,4),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_mind_reward_ledger_account
  ON hive_mind_reward_ledger(account_id, created_at DESC);
CREATE INDEX hive_mind_reward_ledger_claim
  ON hive_mind_reward_ledger(claim_id);

CREATE TABLE hive_mind_pillar2_packets (
  id text PRIMARY KEY,
  claim_id text NOT NULL UNIQUE REFERENCES hive_mind_claims(id),
  model_id text NOT NULL,
  schema_version text NOT NULL DEFAULT 'pf.hive-mind.claim-packet.v1',
  envelope_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
