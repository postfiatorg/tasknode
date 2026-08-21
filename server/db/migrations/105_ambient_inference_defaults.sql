ALTER TABLE IF EXISTS board_manager_secretary_packets
  ALTER COLUMN provider SET DEFAULT 'ambient';

ALTER TABLE IF EXISTS hive_decision_runs
  ALTER COLUMN provider SET DEFAULT 'ambient';

ALTER TABLE IF EXISTS jobs_corpus_chunks
  ALTER COLUMN embedding_provider SET DEFAULT 'deterministic';

ALTER TABLE IF EXISTS recommended_connection_profiles
  ALTER COLUMN embedding_provider SET DEFAULT 'deterministic';
