CREATE TABLE IF NOT EXISTS sybil_review_runs (
  id text PRIMARY KEY,
  schema text NOT NULL DEFAULT 'pf.orc.sybil_detection_report.v1',
  detector_version text NOT NULL DEFAULT 'sybil_review_detector_v1',
  generated_by text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'recommend_only_no_enforcement',
  criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sybil_review_runs
  ADD COLUMN IF NOT EXISTS schema text NOT NULL DEFAULT 'pf.orc.sybil_detection_report.v1',
  ADD COLUMN IF NOT EXISTS detector_version text NOT NULL DEFAULT 'sybil_review_detector_v1',
  ADD COLUMN IF NOT EXISTS generated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'recommend_only_no_enforcement',
  ADD COLUMN IF NOT EXISTS criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE sybil_review_runs
  DROP CONSTRAINT IF EXISTS sybil_review_runs_mode_chk;
ALTER TABLE sybil_review_runs
  ADD CONSTRAINT sybil_review_runs_mode_chk
    CHECK (mode = 'recommend_only_no_enforcement');

CREATE TABLE IF NOT EXISTS sybil_review_flags (
  id text PRIMARY KEY,
  run_id text REFERENCES sybil_review_runs (id) ON DELETE CASCADE,
  subject_key text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  wallet_addresses text[] NOT NULL DEFAULT ARRAY[]::text[],
  handles text[] NOT NULL DEFAULT ARRAY[]::text[],
  provider_risk text NOT NULL DEFAULT 'unknown',
  risk_score numeric(8, 3) NOT NULL DEFAULT 0,
  risk_band text NOT NULL DEFAULT 'watch',
  status text NOT NULL DEFAULT 'sybil_review_flagged',
  flag_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_action text NOT NULL DEFAULT '',
  operational_use_allowed boolean NOT NULL DEFAULT false,
  requires_human_approval boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sybil_review_flags
  ADD COLUMN IF NOT EXISTS run_id text REFERENCES sybil_review_runs (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS wallet_addresses text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS handles text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS provider_risk text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS risk_score numeric(8, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_band text NOT NULL DEFAULT 'watch',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sybil_review_flagged',
  ADD COLUMN IF NOT EXISTS flag_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recommended_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operational_use_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_human_approval boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE sybil_review_flags
  DROP CONSTRAINT IF EXISTS sybil_review_flags_status_chk;
ALTER TABLE sybil_review_flags
  ADD CONSTRAINT sybil_review_flags_status_chk
    CHECK (status = ANY(ARRAY[
      'sybil_review_flagged',
      'human_review_required',
      'cleared',
      'expired'
    ]::text[]));

ALTER TABLE sybil_review_flags
  DROP CONSTRAINT IF EXISTS sybil_review_flags_operational_guard_chk;
ALTER TABLE sybil_review_flags
  ADD CONSTRAINT sybil_review_flags_operational_guard_chk
    CHECK (operational_use_allowed = false AND requires_human_approval = true);

CREATE INDEX IF NOT EXISTS sybil_review_flags_run_idx
  ON sybil_review_flags (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sybil_review_flags_subject_idx
  ON sybil_review_flags (subject_key, created_at DESC)
  WHERE subject_key <> '';

CREATE INDEX IF NOT EXISTS sybil_review_flags_account_idx
  ON sybil_review_flags (account_id, created_at DESC)
  WHERE account_id <> '';

CREATE INDEX IF NOT EXISTS sybil_review_flags_wallets_idx
  ON sybil_review_flags USING gin (wallet_addresses);

CREATE INDEX IF NOT EXISTS sybil_review_flags_rules_idx
  ON sybil_review_flags USING gin (flag_rules);

CREATE INDEX IF NOT EXISTS sybil_review_flags_status_idx
  ON sybil_review_flags (status, risk_score DESC, created_at DESC);
