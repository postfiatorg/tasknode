CREATE TABLE IF NOT EXISTS orc_task_reviews (
  id text PRIMARY KEY,
  task_id text NOT NULL DEFAULT '',
  disposition text NOT NULL DEFAULT 'not_reviewed',
  action_required boolean NOT NULL DEFAULT false,
  action_owner text NOT NULL DEFAULT '',
  confidence text NOT NULL DEFAULT 'medium',
  categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  integrity_signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  summary text NOT NULL DEFAULT '',
  recommended_action text NOT NULL DEFAULT '',
  reviewer_handle text NOT NULL DEFAULT '',
  reviewer_wallet text NOT NULL DEFAULT '',
  source_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_cids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_tx_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_task_reviews
  ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'not_reviewed',
  ADD COLUMN IF NOT EXISTS action_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS action_owner text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS integrity_signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recommended_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewer_wallet text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_task_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS source_cids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS source_tx_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE orc_task_reviews
  DROP CONSTRAINT IF EXISTS orc_task_reviews_disposition_check;
ALTER TABLE orc_task_reviews
  ADD CONSTRAINT orc_task_reviews_disposition_check
    CHECK (disposition = ANY(ARRAY[
      'not_reviewed',
      'in_review',
      'reviewed_no_action',
      'reviewed_follow_up',
      'reviewed_follow_up_completed',
      'reviewed_integrity_follow_up',
      'reviewed_unclear',
      'reviewed_duplicate_or_superseded'
    ]::text[]));

ALTER TABLE orc_task_reviews
  DROP CONSTRAINT IF EXISTS orc_task_reviews_confidence_check;
ALTER TABLE orc_task_reviews
  ADD CONSTRAINT orc_task_reviews_confidence_check
    CHECK (confidence = ANY(ARRAY['low', 'medium', 'high']::text[]));

CREATE INDEX IF NOT EXISTS orc_task_reviews_task_idx
  ON orc_task_reviews (task_id, created_at DESC)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS orc_task_reviews_reviewer_idx
  ON orc_task_reviews (reviewer_handle, created_at DESC)
  WHERE reviewer_handle <> '';

CREATE INDEX IF NOT EXISTS orc_task_reviews_disposition_idx
  ON orc_task_reviews (disposition, created_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_reviews_action_idx
  ON orc_task_reviews (action_required, created_at DESC);

CREATE INDEX IF NOT EXISTS orc_task_reviews_categories_idx
  ON orc_task_reviews USING gin (categories);

CREATE INDEX IF NOT EXISTS orc_task_reviews_integrity_idx
  ON orc_task_reviews USING gin (integrity_signals);

INSERT INTO orc_task_reviews (
  id,
  task_id,
  disposition,
  action_required,
  action_owner,
  confidence,
  categories,
  integrity_signals,
  summary,
  recommended_action,
  reviewer_handle,
  reviewer_wallet,
  source_task_ids,
  source_cids,
  source_tx_hashes,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  'orcrev_backfill_' || md5(task_id || ':' || COALESCE(updated_at::text, '')),
  task_id,
  disposition,
  action_required,
  action_owner,
  confidence,
  categories,
  integrity_signals,
  summary,
  recommended_action,
  reviewer_handle,
  reviewer_wallet,
  source_task_ids,
  source_cids,
  source_tx_hashes,
  metadata_json || jsonb_build_object('backfilledFrom', 'orc_task_review_states'),
  COALESCE(reviewed_at, updated_at, created_at, now()),
  COALESCE(updated_at, reviewed_at, created_at, now())
FROM orc_task_review_states
WHERE disposition <> 'not_reviewed'
ON CONFLICT (id) DO NOTHING;
