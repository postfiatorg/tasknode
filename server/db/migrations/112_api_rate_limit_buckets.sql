CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
  bucket_hash text PRIMARY KEY CHECK (length(bucket_hash) = 64),
  route_id text NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  limit_count integer NOT NULL CHECK (limit_count >= 1),
  window_ms integer NOT NULL CHECK (window_ms >= 1000),
  reset_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limit_buckets_reset_at
  ON api_rate_limit_buckets (reset_at);

CREATE INDEX IF NOT EXISTS idx_api_rate_limit_buckets_route
  ON api_rate_limit_buckets (route_id, reset_at);
