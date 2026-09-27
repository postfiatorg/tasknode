ALTER TABLE decision_jobs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'budget' CHECK (mode IN ('budget', 'premium'));
