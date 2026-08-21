-- Board Manager v2 (Gate F): public transcript mirror.
--
-- Hive Brain becomes a read-only view of each board agent's terminal
-- reasoning stream. Lines are secret-scrubbed before insert by the
-- ingesting script; this table stores only displayable text.

CREATE TABLE IF NOT EXISTS board_manager_transcripts (
  id text PRIMARY KEY,
  board_id text NOT NULL,
  session_name text NOT NULL DEFAULT '',
  seq bigint NOT NULL DEFAULT 0,
  content text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_manager_transcripts_board_recent_idx
  ON board_manager_transcripts (board_id, seq DESC);
