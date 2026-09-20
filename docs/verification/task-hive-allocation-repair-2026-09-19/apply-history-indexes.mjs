// Apply only migration 143, using the same lock and marker as the app migrator.
process.env.DATABASE_STATEMENT_TIMEOUT_MS="60000";
const {query,transactionCommand,closePool}=await import("/app/server/db/pool.js");
const name="143_board_account_history_lookup.sql";
const sql="-- Candidate lookup only; the original account/wallet predicates remain the\n-- final authority in accountRelevantBoardRuns.\nCREATE INDEX IF NOT EXISTS board_manager_runs_account_lookup_idx\n  ON board_manager_runs USING gin ((ARRAY[\n    action_payload_json #>> '{network_task,candidate_account_id}',\n    action_payload_json #>> '{networkTask,candidateAccountId}',\n    action_payload_json #>> '{network_task,candidate_wallet_address}',\n    action_payload_json #>> '{networkTask,candidateWalletAddress}'\n  ]));\n\nCREATE INDEX IF NOT EXISTS board_manager_action_results_account_lookup_idx\n  ON board_manager_action_results USING gin ((ARRAY[\n    target_id,\n    result_json->>'accountId',\n    result_json->>'candidateAccountId',\n    result_json->>'candidateWalletAddress'\n  ]));\n";
try {
  const result=await transactionCommand(async()=>{
    await query("SELECT pg_advisory_xact_lock(hashtext($1))",["tasknode:migration:"+name]);
    const previous=await query("SELECT 1 FROM tasknode_schema_migrations WHERE name=$1",[name]);
    if(previous.rows.length) return {applied:false,alreadyApplied:true};
    await query(sql);
    await query("INSERT INTO tasknode_schema_migrations(name) VALUES($1)",[name]);
    return {applied:true};
  });
  console.log(JSON.stringify({observedAt:new Date().toISOString(),migration:name,...result},null,2));
}finally{await closePool();}
