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

-- Account-specific capacity grants are production operations data. They are
-- applied through the private operator path, never seeded by a public schema
-- migration.
