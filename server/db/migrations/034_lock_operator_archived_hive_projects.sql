UPDATE network_projects
SET status = 'archived',
    metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object(
      'operator_archived', true,
      'archive_lock_applied_at', now(),
      'archive_lock_source', 'migration_034_lock_operator_archived_hive_projects'
    ),
    updated_at = now()
WHERE COALESCE(metadata_json->>'archived_reason', '') <> '';
