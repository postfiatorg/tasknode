-- Production durable FastPay payout store: atomic owned-object leases,
-- pre-broadcast signed-order persistence, durable fallback attempt IDs,
-- and an atomic first-pin IPFS outbox committed with the payout.

CREATE TABLE l1_fastpay_payout_objects (
  object_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 0),
  value_atoms bigint NOT NULL CHECK (value_atoms > 0),
  nonce bigint NOT NULL DEFAULT 0 CHECK (nonce >= 0),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'leased', 'spent', 'retired')),
  leased_by_payout_id text,
  lease_token text NOT NULL DEFAULT '',
  leased_at timestamptz,
  spent_by_payout_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_id, version)
);

CREATE UNIQUE INDEX l1_fastpay_payout_objects_active_object_idx
  ON l1_fastpay_payout_objects (object_id)
  WHERE status IN ('available', 'leased');

CREATE UNIQUE INDEX l1_fastpay_payout_objects_leased_payout_idx
  ON l1_fastpay_payout_objects (leased_by_payout_id)
  WHERE status = 'leased' AND leased_by_payout_id IS NOT NULL;

CREATE INDEX l1_fastpay_payout_objects_available_idx
  ON l1_fastpay_payout_objects (value_atoms ASC, object_id ASC, version ASC)
  WHERE status = 'available';

CREATE TABLE l1_fastpay_payouts (
  payout_id text PRIMARY KEY,
  task_id text NOT NULL DEFAULT '',
  lane text NOT NULL DEFAULT 'fastpay'
    CHECK (lane IN ('fastpay', 'consensus_pft')),
  status text NOT NULL
    CHECK (status IN ('order_persisted', 'submitting', 'submit_unknown', 'fallback_unknown', 'confirmed')),
  object_id text NOT NULL,
  object_version bigint NOT NULL CHECK (object_version >= 0),
  order_hash text NOT NULL UNIQUE,
  lock_id text NOT NULL DEFAULT '',
  fallback_attempt_id text UNIQUE,
  fallback_tx_hash text,
  cid text NOT NULL DEFAULT '',
  raw_envelope_hex text NOT NULL DEFAULT '',
  active_worker_token text NOT NULL DEFAULT '',
  active_worker_claimed_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, object_version)
);

CREATE INDEX l1_fastpay_payouts_status_idx
  ON l1_fastpay_payouts (status, updated_at ASC);

CREATE TABLE l1_fastpay_pin_outbox (
  payout_id text PRIMARY KEY REFERENCES l1_fastpay_payouts (payout_id) ON DELETE CASCADE,
  cid text NOT NULL,
  raw_envelope_hex text NOT NULL,
  task_id text NOT NULL DEFAULT '',
  schema_name text NOT NULL DEFAULT 'pf.reward.v1',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'pinning', 'pinned', 'retry_wait', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NOT NULL DEFAULT '',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  pinned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, cid)
);

CREATE INDEX l1_fastpay_pin_outbox_due_idx
  ON l1_fastpay_pin_outbox (next_attempt_at ASC, created_at ASC)
  WHERE status IN ('queued', 'retry_wait', 'pinning');
