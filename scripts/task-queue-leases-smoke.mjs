import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { claimNetworkTaskGenerationJobs, heartbeatNetworkTaskGenerationJob, markNetworkTaskGenerationJobFailed, persistNetworkTaskRequest, reclaimStaleNetworkTaskGenerationJobs } from "../server/repositories/network-task-generation-jobs.js";
import { applyOffchainTaskOffer } from "../server/offchain-task-lifecycle.js";
import { claimTaskGenerationRequests, getOwnedTaskRequest } from "../server/repositories/task-requests.js";
import { recoverAbandonedReviewPublications } from "../server/task-review-recovery.js";

assert.ok(databaseEnabled(), "Use an isolated fixture database");
const id = `lease_smoke_${randomUUID()}`;
const taskIds = ["abandoned", "unknown", "fresh", "attempted"].map((kind) => `${id}_${kind}`);
try {
  await migrateDatabase();
  await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Lease smoke','active')", [id]);
  await query("INSERT INTO network_task_allocations(id,project_id,candidate_account_id) VALUES($1,$1,$1)", [id]);
  await query("INSERT INTO network_task_generation_jobs(id,allocation_id,project_id,candidate_account_id) VALUES($1,$1,$1,$1)", [id]);
  const first = (await claimNetworkTaskGenerationJobs({ limit: 1 }))[0];
  assert.equal(first.id, id);
  assert.ok(first.worker_attempt_id);
  assert.equal((await heartbeatNetworkTaskGenerationJob(first)).ok, true);
  await query("UPDATE network_task_generation_jobs SET worker_heartbeat_at=now()-interval '10 minutes', lease_expires_at=now()-interval '1 minute' WHERE id=$1", [id]);
  await reclaimStaleNetworkTaskGenerationJobs({ staleMinutes: 5 });
  await query("UPDATE network_task_generation_jobs SET next_attempt_at=now() WHERE id=$1", [id]);
  const replacement = (await claimNetworkTaskGenerationJobs({ limit: 1 }))[0];
  assert.notEqual(first.worker_attempt_id, replacement.worker_attempt_id);
  assert.equal((await heartbeatNetworkTaskGenerationJob(first)).ok, false);
  assert.equal((await markNetworkTaskGenerationJobFailed({ jobId: id, workerAttemptId: first.worker_attempt_id, error: "late_failure" })).stale, true);
  const request = { requestId: `req_${id}`, accountId: id, subjectWallet: "", userDetailText: "Lease-fenced request", requestBundleCid: "postgres:lease", status: "queued" };
  await assert.rejects(persistNetworkTaskRequest({ job: first, request }), { message: "network_task_generation_attempt_lost" });
  assert.equal((await query("SELECT 1 FROM task_requests WHERE request_id=$1", [request.requestId])).rowCount, 0);
  assert.equal((await persistNetworkTaskRequest({ job: replacement, request })).ok, true);
  const linked = (await query("SELECT j.status,a.task_request_id FROM network_task_generation_jobs j JOIN network_task_allocations a ON a.id=j.allocation_id WHERE j.id=$1", [id])).rows[0];
  assert.equal(linked.status, "generated");
  assert.equal(linked.task_request_id, request.requestId);
  const attempt = (await claimTaskGenerationRequests({ limit: 1, workerId: "offer-fixture" }))[0];
  const offerInput = { accountId: id, walletAddress: "rOfferFixture", requestAttempt: { workerAttemptId: "replaced" },
    offerPayload: { schema: "pf.task.offer.v1", task_id: `${id}_offer`, request_id: request.requestId, title: "Fenced offer", task_kind: "personal", reward_offer: { amount_estimate_pft: "1" } },
  };
  await assert.rejects(applyOffchainTaskOffer(offerInput), { message: "task_generation_attempt_lost" });
  offerInput.requestAttempt.workerAttemptId = attempt.workerAttemptId;
  await applyOffchainTaskOffer(offerInput);
  const completed = await getOwnedTaskRequest({ accountId: id, requestId: request.requestId });
  assert.equal(completed.generatedTaskId, `${id}_offer`);
  assert.equal(completed.status, "proposed");
  await assert.rejects(applyOffchainTaskOffer({ ...offerInput, offerPayload: { ...offerInput.offerPayload, task_id: `${id}_late_duplicate` } }), { message: "task_generation_attempt_lost" });
  assert.equal((await query("SELECT 1 FROM task_events WHERE account_id=$1", [id])).rowCount, 1);

  for (const [index, taskId] of taskIds.entries()) {
    const metadata = index === 1 ? { reward_payment_guard: { status: "submit_unknown" } } : {};
    await query("INSERT INTO task_projections(task_id,account_id,status,metadata_json) VALUES($1,$2,'verification_response_submitted',$3::jsonb)", [taskId, id, JSON.stringify(metadata)]);
    await query(`INSERT INTO task_review_publications(task_id,worker_name,status,metadata_json,updated_at)
      VALUES($1,'reward_scoring','reserved',$2::jsonb,CASE WHEN $3 THEN now() ELSE now()-interval '1 day' END)`, [taskId, JSON.stringify({ submission_attempted: index === 3 }), index === 2]);
  }
  assert.deepEqual((await recoverAbandonedReviewPublications()).recovered, [taskIds[0]]);
  assert.deepEqual((await recoverAbandonedReviewPublications()).recovered, []);
  assert.equal((await query("SELECT metadata_json->'reward_payment_guard'->>'status' AS status FROM task_projections WHERE task_id=$1", [taskIds[1]])).rows[0].status, "submit_unknown");
  console.log(JSON.stringify({ ok: true, staleCompletionRejected: true, atomicRequestAndLinks: true, abandonedReviewRecovered: true, uncertainPaymentPreserved: true }));
} finally {
  await query("DELETE FROM task_review_publications WHERE task_id=ANY($1::text[])", [taskIds]);
  await query("DELETE FROM task_events WHERE account_id=$1", [id]);
  await query("DELETE FROM task_projections WHERE account_id=$1", [id]);
  await query("DELETE FROM task_requests WHERE account_id=$1", [id]);
  await query("DELETE FROM network_projects WHERE id=$1", [id]);
  await closePool();
}
