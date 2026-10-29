-- Research state only; existing billing tables and rollup definitions are unchanged.
ALTER TABLE research_gateway_jobs ADD COLUMN progress_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE deep_research_jobs ADD COLUMN research_options jsonb NOT NULL DEFAULT '{}'::jsonb;
