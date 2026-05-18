ALTER TABLE pftl_cache_reducer_events
  ADD COLUMN IF NOT EXISTS dedupe_key text NOT NULL DEFAULT '';

UPDATE pftl_cache_reducer_events
SET dedupe_key = wallet_address || '|' || tx_hash || '|' || reducer_kind || '|' ||
  COALESCE(memo_index, -1)::text || '|' || COALESCE(cid, '')
WHERE dedupe_key = '';

DROP INDEX IF EXISTS pftl_cache_reducer_events_dedupe_idx;

CREATE UNIQUE INDEX IF NOT EXISTS pftl_cache_reducer_events_dedupe_idx
  ON pftl_cache_reducer_events (dedupe_key);
