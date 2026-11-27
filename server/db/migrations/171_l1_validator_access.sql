-- Validator access from the signed three-observer uptime feed
-- (postfiat-validator-uptime-v1; postfiatl1v2 docs/specs/validator-uptime-feed-v1.md).
--
-- A binding is suspended when the feed says its validator is revoked, and
-- restored when the feed says it has access again. Suspension is not
-- revocation: the binding and its history stay, and the operator sees why.
ALTER TABLE validator_bindings ADD COLUMN access_suspended_at timestamptz;

-- The latest row two observers agreed on, per validator. Written only from a
-- feed that verified; an indeterminate feed changes nothing here.
CREATE TABLE l1_validator_access (
  network text NOT NULL,
  chain_id text NOT NULL,
  validator_id text NOT NULL,
  ml_dsa_public_key text NOT NULL,
  access_state text NOT NULL CHECK (access_state IN ('pending', 'active', 'lapsed', 'revoked')),
  access_state_reason text NOT NULL,
  finance_hub_access boolean NOT NULL,
  research_api_keys_active boolean NOT NULL,
  reward_eligible boolean NOT NULL,
  removal_proposal_eligible boolean NOT NULL,
  observed_days integer NOT NULL,
  mean_daily_participation_bps integer,
  consecutive_passing_days integer NOT NULL,
  grace_started_at timestamptz,
  grace_expires_at timestamptz,
  window_end timestamptz NOT NULL,
  source_observer_id text NOT NULL,
  agreeing_observer_ids jsonb NOT NULL,
  feed_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, chain_id, validator_id)
);

-- The last attestation accepted from each observer, so an older feed cannot
-- replace a newer one.
CREATE TABLE l1_uptime_feed_observers (
  keyset_id text NOT NULL,
  observer_id text NOT NULL,
  last_observed_at text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyset_id, observer_id)
);
