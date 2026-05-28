CREATE INDEX IF NOT EXISTS board_manager_user_messages_account_hive_entry_idx
  ON board_manager_user_messages (account_id, (metadata_json->>'hive_context_entry_id'), created_at DESC)
  WHERE status <> 'archived'
    AND COALESCE(metadata_json->>'hive_context_entry_id', '') <> '';

CREATE INDEX IF NOT EXISTS board_manager_user_messages_account_recent_delivery_idx
  ON board_manager_user_messages (account_id, created_at DESC)
  WHERE status <> 'archived';
