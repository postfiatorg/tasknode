CREATE TABLE IF NOT EXISTS ipfs_replication_jobs (
  id text PRIMARY KEY,
  cid text NOT NULL,
  payload_class text NOT NULL DEFAULT 'unknown',
  source text NOT NULL DEFAULT '',
  source_ref text NOT NULL DEFAULT '',
  exact_cid_required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  verified_gateway text NOT NULL DEFAULT '',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ipfs_replication_jobs_status_chk
    CHECK (status IN (
      'queued',
      'pinning',
      'first_party_pinned',
      'verified',
      'retry_wait',
      'failed',
      'exception_required'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS ipfs_replication_jobs_cid_payload_source_ref_idx
  ON ipfs_replication_jobs (cid, payload_class, source, source_ref);

CREATE INDEX IF NOT EXISTS ipfs_replication_jobs_status_next_attempt_idx
  ON ipfs_replication_jobs (status, next_attempt_at, first_seen_at);

CREATE INDEX IF NOT EXISTS ipfs_replication_jobs_recent_idx
  ON ipfs_replication_jobs (first_seen_at DESC, id);

CREATE INDEX IF NOT EXISTS ipfs_replication_jobs_unverified_idx
  ON ipfs_replication_jobs (first_seen_at DESC, status)
  WHERE status <> 'verified';
