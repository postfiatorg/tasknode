CREATE TABLE IF NOT EXISTS profile_nft_render_jobs (
  id text PRIMARY KEY,
  profile_nft_id text NOT NULL REFERENCES profile_nfts(id) ON DELETE CASCADE,
  sanitized_prompt text NOT NULL,
  model text NOT NULL,
  size text NOT NULL,
  quality text NOT NULL,
  output_format text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_nft_render_jobs_status_chk
    CHECK (status IN ('queued', 'rendering', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_nft_render_jobs_nft_idx
  ON profile_nft_render_jobs (profile_nft_id);

CREATE INDEX IF NOT EXISTS profile_nft_render_jobs_claim_idx
  ON profile_nft_render_jobs (status, available_at, created_at)
  WHERE status = 'queued';
