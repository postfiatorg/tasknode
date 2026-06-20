CREATE TABLE IF NOT EXISTS agent_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  action text NOT NULL,
  agent_key text NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  limit_count integer NOT NULL DEFAULT 1 CHECK (limit_count >= 1),
  window_ms integer NOT NULL CHECK (window_ms >= 1000),
  reset_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_rate_limit_buckets_reset_at
  ON agent_rate_limit_buckets (reset_at);

CREATE INDEX IF NOT EXISTS idx_agent_rate_limit_buckets_action_agent
  ON agent_rate_limit_buckets (action, agent_key);
