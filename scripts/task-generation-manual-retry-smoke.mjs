import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, closePool, transactionCommand } from "../server/db/pool.js";
import { claimTaskGenerationRequests, markTaskRequestFailed, reclaimStaleTaskGenerationRequests, retryOwnedTaskRequest } from "../server/repositories/task-requests.js";
const requestId = `req_manual_retry_fixture_${randomUUID()}`;
const accountId = `acct_manual_retry_fixture_${randomUUID()}`;
const rollback = new Error("fixture_rollback");
try {
  await transactionCommand(async () => {
    // All writes roll back, including any stale rows encountered by the worker.
    // Hold the table lock so no local worker can observe the synthetic request.
    await query("LOCK TABLE task_requests IN EXCLUSIVE MODE");
    await query("INSERT INTO task_requests (request_id,account_id,status,request_bundle_cid,worker_attempt_count,updated_at) VALUES ($1,$2,'failed','postgres:fixture',3,'2000-01-01')", [requestId,accountId]);
    for (const base of [3,6]) {
      await retryOwnedTaskRequest({ accountId,requestId,expectedAttemptCount:base });
      for (let attempt=1;attempt<=3;attempt++) {
        await query("UPDATE task_requests SET updated_at='2000-01-01' WHERE request_id=$1",[requestId]);
        const [claimed]=await claimTaskGenerationRequests({maxAttempts:3});
        assert.equal(claimed.requestId,requestId);
        assert.equal(claimed.workerAttemptCount,base+attempt);
        assert.equal(claimed.workerCycleAttemptCount,attempt);
        await query("UPDATE task_requests SET worker_heartbeat_at='2000-01-01' WHERE request_id=$1",[requestId]);
        const stale=await reclaimStaleTaskGenerationRequests({maxAttempts:3,staleSeconds:60});
        assert.ok((attempt<3?stale.retried:stale.failed).some(row=>row.requestId===requestId));
      }
      if(base===3){
        const staleRetry=await retryOwnedTaskRequest({accountId,requestId,expectedAttemptCount:3});
        assert.equal(staleRetry.status,'failed',"old retry receipt cannot restart a newer exhausted cycle");
        assert.equal(staleRetry.workerAttemptCount,6);
      }
    }
    await markTaskRequestFailed({requestId,error:'fixture_done'});
    throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
  console.log(JSON.stringify({ok:true,checks:['exhausted request is claimable after manual retry','fresh bounded automatic attempts each cycle','stale reclaim respects renewed budget','monotonic lifetime count rejects obsolete retries']}));
} finally { await closePool(); }
