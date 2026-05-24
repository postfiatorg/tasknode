ALTER TABLE board_manager_scopes
  ALTER COLUMN max_actions_per_hour SET DEFAULT 8;

UPDATE board_manager_scopes
SET max_actions_per_hour = 8,
    metadata_json = metadata_json || jsonb_build_object(
      'action_budget_default_updated_at', now(),
      'action_budget_default', 8
    ),
    updated_at = now()
WHERE scope = 'global_hive'
  AND max_actions_per_hour = 4;
