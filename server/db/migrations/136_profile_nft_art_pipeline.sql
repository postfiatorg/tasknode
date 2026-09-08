ALTER TABLE profile_nft_render_jobs
  ADD COLUMN IF NOT EXISTS art_spec jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS style_preference text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS prompt_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS template_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS render_asset jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS worker_attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Unfinished legacy jobs get the new spec pipeline on their next claim.
-- Finished images and selected portraits remain intact.
UPDATE profile_nft_render_jobs SET sanitized_prompt = '' WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS profile_nft_render_jobs_lease_idx
 ON profile_nft_render_jobs (lease_expires_at) WHERE status = 'rendering';

ALTER TABLE profile_nft_daily_awards DROP CONSTRAINT IF EXISTS profile_nft_daily_awards_status_chk;
ALTER TABLE profile_nft_daily_awards ADD CONSTRAINT profile_nft_daily_awards_status_chk
 CHECK (status IN ('pending','running','rendering','generated','failed','retry_wait','failed_permanent','skipped'));
UPDATE profile_nft_daily_awards award SET status='rendering',completed_at=NULL
 FROM profile_nfts nft,profile_nft_render_jobs job
 WHERE award.profile_nft_id=nft.id AND job.profile_nft_id=nft.id
 AND job.status IN ('queued','rendering') AND award.status='generated';
