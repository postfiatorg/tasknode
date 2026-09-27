-- The daily airdrop idempotency lookup filters board_manager_runs by manager,
-- action and status; without this index it scans the whole table.
CREATE INDEX IF NOT EXISTS board_manager_runs_manager_action_idx
  ON board_manager_runs (manager_id, selected_action, status, completed_at DESC);
