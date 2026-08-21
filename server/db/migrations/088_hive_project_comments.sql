CREATE INDEX IF NOT EXISTS hive_context_entries_project_comment_recent_idx
  ON hive_context_entries ((metadata_json #>> '{projectComment,projectId}'), created_at DESC, id)
  WHERE deleted_at IS NULL
    AND COALESCE(metadata_json #>> '{projectComment,projectId}', '') <> '';
