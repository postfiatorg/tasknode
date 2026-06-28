CREATE INDEX IF NOT EXISTS task_projections_network_status_recent_idx
  ON task_projections (status, updated_at DESC, last_event_at DESC, task_id)
  WHERE task_kind = 'network';

CREATE INDEX IF NOT EXISTS network_project_task_refs_state_recent_idx
  ON network_project_task_refs (state, updated_at DESC, id)
  WHERE assignee_wallet <> '';

CREATE INDEX IF NOT EXISTS network_project_task_refs_task_recent_idx
  ON network_project_task_refs (task_id, updated_at DESC, id)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS network_project_task_refs_request_recent_idx
  ON network_project_task_refs (request_id, updated_at DESC, id)
  WHERE request_id <> '';
