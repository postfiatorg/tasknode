-- Hive Brain narrator (security hardening): plain-English summaries of
-- board-manager activity replace the raw terminal mirror in the public
-- feed. One summary row per (board, latest audit action) — regenerated
-- only when a new action lands.

CREATE TABLE IF NOT EXISTS bm_activity_summaries (
  id text PRIMARY KEY,
  board_id text NOT NULL,
  latest_audit_id text NOT NULL,
  summary text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'model',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bm_activity_summaries_board_audit_idx
  ON bm_activity_summaries (board_id, latest_audit_id);

CREATE INDEX IF NOT EXISTS bm_activity_summaries_board_recent_idx
  ON bm_activity_summaries (board_id, created_at DESC);
