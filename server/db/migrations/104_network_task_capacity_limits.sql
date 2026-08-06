-- Per-account network task capacity limits (operator-set). Default capacity
-- is 1 live allocation per account; rows here raise it for trusted
-- high-throughput contributors. Mutable only by migration or operator
-- tooling, never by agents.

CREATE TABLE IF NOT EXISTS network_task_capacity_limits (
  account_id text PRIMARY KEY,
  max_live_allocations integer NOT NULL DEFAULT 1,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO network_task_capacity_limits (account_id, max_live_allocations, note)
VALUES
  ('acct_oauth_3c70e69ab7b8ef1fad3df508', 4, 'operator directive 2026-08-06: goodalexander capacity 4'),
  ('acct_oauth_fa3af2fecd900ec5fec47cb6', 4, 'operator directive 2026-08-06: DRavlic capacity 4')
ON CONFLICT (account_id) DO UPDATE SET
  max_live_allocations = EXCLUDED.max_live_allocations,
  note = EXCLUDED.note,
  updated_at = now();
