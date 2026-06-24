ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS signature_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE task_review_publications
  ADD COLUMN IF NOT EXISTS forensic_cid text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS forensic_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS signature_json jsonb NOT NULL DEFAULT '{}'::jsonb;
