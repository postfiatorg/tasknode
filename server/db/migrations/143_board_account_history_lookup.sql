-- Candidate lookup only; the original account/wallet predicates remain the
-- final authority in accountRelevantBoardRuns.
CREATE INDEX IF NOT EXISTS board_manager_runs_account_lookup_idx
  ON board_manager_runs USING gin ((ARRAY[
    action_payload_json #>> '{network_task,candidate_account_id}',
    action_payload_json #>> '{networkTask,candidateAccountId}',
    action_payload_json #>> '{network_task,candidate_wallet_address}',
    action_payload_json #>> '{networkTask,candidateWalletAddress}'
  ]));

CREATE INDEX IF NOT EXISTS board_manager_action_results_account_lookup_idx
  ON board_manager_action_results USING gin ((ARRAY[
    target_id,
    result_json->>'accountId',
    result_json->>'candidateAccountId',
    result_json->>'candidateWalletAddress'
  ]));
