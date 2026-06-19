-- Postgres-backed Orc runtime directive queue.
-- This is the durable queue/claim primitive only; it does not start or replace
-- any supervised Orc worker process.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'orc_runtime_directive_status'
  ) THEN
    CREATE TYPE orc_runtime_directive_status AS ENUM (
      'queued',
      'claimed',
      'completed',
      'failed',
      'cancelled'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orc_runtime_directives (
  directive_id text PRIMARY KEY,
  orc text NOT NULL DEFAULT '',
  directive text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  status orc_runtime_directive_status NOT NULL DEFAULT 'queued',
  worker_id text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_runtime_directives
  ADD COLUMN IF NOT EXISTS orc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS directive text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status orc_runtime_directive_status NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS worker_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS orc_runtime_directives_orc_status_created_idx
  ON orc_runtime_directives (orc, status, created_at);

CREATE INDEX IF NOT EXISTS orc_runtime_directives_status_created_idx
  ON orc_runtime_directives (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS orc_runtime_directives_claimed_worker_unique
  ON orc_runtime_directives (worker_id, status)
  WHERE status = 'claimed' AND worker_id <> '';
