ALTER TABLE context_history_imports
  ALTER COLUMN source SET DEFAULT 'pftl_cache_context_projection';

UPDATE context_history_imports
SET source = 'pftl_cache_context_projection'
WHERE source <> 'pftl_cache_context_projection';
