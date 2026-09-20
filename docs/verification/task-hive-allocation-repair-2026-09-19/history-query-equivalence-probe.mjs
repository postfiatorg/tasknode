// Read-only comparison of original and indexed-candidate SQL, same snapshot.
import pg from "/app/node_modules/pg/lib/index.js";
import {createHash} from "node:crypto";
const client=new pg.Client({connectionString:process.env.DATABASE_URL,query_timeout:60000});
const before="      SELECT\n        runs.id,\n        runs.trigger,\n        runs.status,\n        runs.selected_action,\n        runs.started_at,\n        runs.completed_at,\n        results.target_type,\n        results.target_id,\n        COALESCE(results.result_json->>'reason', runs.decision_json->>'reason', '') AS reason\n      FROM board_manager_runs runs\n      LEFT JOIN board_manager_action_results results\n        ON results.run_id = runs.id\n      WHERE ($1::text <> '' AND (\n          results.target_id = $1\n          OR results.result_json->>'accountId' = $1\n          OR results.result_json->>'candidateAccountId' = $1\n          OR runs.action_payload_json #>> '{network_task,candidate_account_id}' = $1\n          OR runs.action_payload_json #>> '{networkTask,candidateAccountId}' = $1\n        ))\n        OR ($2::text <> '' AND (\n          results.result_json->>'candidateWalletAddress' = $2\n          OR runs.action_payload_json #>> '{network_task,candidate_wallet_address}' = $2\n          OR runs.action_payload_json #>> '{networkTask,candidateWalletAddress}' = $2\n        ))\n      ORDER BY runs.started_at DESC, runs.id DESC\n      LIMIT $3\n    ";
const after="      WITH relevant_runs AS MATERIALIZED (\n        SELECT id FROM board_manager_runs\n        WHERE ARRAY[\n          action_payload_json #>> '{network_task,candidate_account_id}',\n          action_payload_json #>> '{networkTask,candidateAccountId}',\n          action_payload_json #>> '{network_task,candidate_wallet_address}',\n          action_payload_json #>> '{networkTask,candidateWalletAddress}'\n        ] && ARRAY[NULLIF($1::text, ''), NULLIF($2::text, '')]\n        UNION\n        SELECT run_id FROM board_manager_action_results\n        WHERE ARRAY[\n          target_id, result_json->>'accountId',\n          result_json->>'candidateAccountId', result_json->>'candidateWalletAddress'\n        ] && ARRAY[NULLIF($1::text, ''), NULLIF($2::text, '')]\n      )\n      SELECT\n        runs.id,\n        runs.trigger,\n        runs.status,\n        runs.selected_action,\n        runs.started_at,\n        runs.completed_at,\n        results.target_type,\n        results.target_id,\n        COALESCE(results.result_json->>'reason', runs.decision_json->>'reason', '') AS reason\n      FROM board_manager_runs runs\n      JOIN relevant_runs relevant ON relevant.id = runs.id\n      LEFT JOIN board_manager_action_results results\n        ON results.run_id = runs.id\n      WHERE ($1::text <> '' AND (\n          results.target_id = $1\n          OR results.result_json->>'accountId' = $1\n          OR results.result_json->>'candidateAccountId' = $1\n          OR runs.action_payload_json #>> '{network_task,candidate_account_id}' = $1\n          OR runs.action_payload_json #>> '{networkTask,candidateAccountId}' = $1\n        ))\n        OR ($2::text <> '' AND (\n          results.result_json->>'candidateWalletAddress' = $2\n          OR runs.action_payload_json #>> '{network_task,candidate_wallet_address}' = $2\n          OR runs.action_payload_json #>> '{networkTask,candidateWalletAddress}' = $2\n        ))\n      ORDER BY runs.started_at DESC, runs.id DESC\n      LIMIT $3\n    ";
await client.connect();
try{
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout=60000");
  const results=[];
  for(const params of [
    ["acct_oauth_3c70e69ab7b8ef1fad3df508","rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",8],
    ["acct_oauth_3c70e69ab7b8ef1fad3df508","",8],
    ["","rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",8],
    ["no_such_hive_recovery_account","",8]
  ]){
    let start=Date.now();
    const oldRows=(await client.query(before,params)).rows;const beforeMs=Date.now()-start;
    start=Date.now();
    const newRows=(await client.query(after,params)).rows;const afterMs=Date.now()-start;
    const canonical=rows=>JSON.stringify(rows.map(row=>JSON.stringify(row)).sort());
    const oldText=canonical(oldRows),newText=canonical(newRows);
    const hash=text=>createHash("sha256").update(text).digest("hex");
    results.push({case:results.length+1,rows:oldRows.length,beforeMs,afterMs,beforeHash:hash(oldText),afterHash:hash(newText),identical:oldText===newText});
  }
  const plan=(await client.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+after,["acct_oauth_3c70e69ab7b8ef1fad3df508","rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",8])).rows[0]["QUERY PLAN"];
  console.log(JSON.stringify({observedAt:new Date().toISOString(),productionMutations:0,results,plan},null,2));
  if(results.some(r=>!r.identical)) process.exitCode=1;
}finally{await client.query("ROLLBACK");await client.end();}
