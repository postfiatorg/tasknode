ALTER TABLE chat_model_runs
  ADD COLUMN IF NOT EXISTS prompt_cache_hit_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_cache_miss_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_usage_reported boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cache_savings_usd numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_source text NOT NULL DEFAULT '';

ALTER TABLE billing_ledger_entries
  ADD COLUMN IF NOT EXISTS prompt_cache_hit_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_cache_miss_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_usage_reported boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cache_savings_usd numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_source text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS chat_model_runs_cache_efficiency_idx
  ON chat_model_runs (provider, model, started_at DESC)
  WHERE status = 'completed';
