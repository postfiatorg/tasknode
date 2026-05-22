UPDATE network_projects
SET status = 'archived',
    metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object(
      'archived_reason', 'operator_rejected_scoping_as_project',
      'archived_at', now(),
      'archived_by', 'migration_032_archive_rejected_hive_scoping_projects'
    ),
    updated_at = now()
WHERE id IN (
  'capital_deployment_protocol_scoping',
  'post_fiat_l1_scoping',
  'task_node_product_scoping'
)
AND status = 'active';
