CREATE INDEX IF NOT EXISTS network_task_generation_jobs_task_recent_idx
  ON network_task_generation_jobs (task_id, updated_at DESC, id)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS network_task_allocations_generated_task_recent_idx
  ON network_task_allocations (generated_task_id, updated_at DESC, id)
  WHERE generated_task_id <> '';

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

CREATE INDEX IF NOT EXISTS profile_nfts_wallet_avatar_recent_idx
  ON profile_nfts (wallet_address, selected DESC, created_at DESC NULLS LAST, updated_at DESC NULLS LAST, id)
  WHERE wallet_address <> ''
    AND status IN ('minted', 'prepared', 'generated')
    AND (
      COALESCE(image_gateway_url, '') <> ''
      OR COALESCE(image_cid, '') <> ''
    );

CREATE INDEX IF NOT EXISTS profile_nfts_account_avatar_recent_idx
  ON profile_nfts (account_id, selected DESC, created_at DESC NULLS LAST, updated_at DESC NULLS LAST, id)
  WHERE lower(status) IN ('minted', 'prepared', 'generated')
    AND (
      COALESCE(image_gateway_url, '') <> ''
      OR COALESCE(image_cid, '') <> ''
    );
