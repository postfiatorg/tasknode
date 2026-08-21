ALTER TABLE network_task_generation_jobs
  ALTER COLUMN prompt_version SET DEFAULT 'taskgen_network_v1';

UPDATE network_task_generation_jobs
SET prompt_version = 'taskgen_network_v1',
    updated_at = now()
WHERE prompt_version = 'taskgen_minimal_v1'
  AND status IN ('queued', 'running', 'failed', 'link_failed');
