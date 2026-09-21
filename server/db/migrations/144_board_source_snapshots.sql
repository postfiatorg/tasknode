-- Cached remote grounding sources for board packets. The board manager reads
-- these instead of a checkout on the operator host; each row records when it
-- was fetched and any fetch error so a source outage is visible, not silent.
CREATE TABLE IF NOT EXISTS board_source_snapshots (
  source_key text PRIMARY KEY,
  kind text NOT NULL,
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'unavailable',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
