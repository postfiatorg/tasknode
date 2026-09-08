-- Keep historical provider/model values; change defaults only for new work.
ALTER TABLE board_manager_secretary_packets ALTER COLUMN provider SET DEFAULT 'vercel';
ALTER TABLE hive_decision_runs ALTER COLUMN provider SET DEFAULT 'vercel';
ALTER TABLE bm_activity_summaries ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '';
