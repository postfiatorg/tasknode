import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { enqueueNetworkTaskGenerationFromBoardDecision as enqueue } from "../server/repositories/network-task-enqueue.js";
import { claimNetworkTaskGenerationJobs, markNetworkTaskGenerationJobFailed } from "../server/repositories/network-task-generation-jobs.js";
import { boardPacket } from "./bm/lib.mjs";
import { parseAgentCommand } from "../server/board-agent-dispatch.js";
const url = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/tasknode_hive_audit_20260919");
const id = "network_retry_" + randomUUID(), wallet = "rExplicitRetryFixture";
const request = retry => ({ decision: { action: "initiate_network_task", target_id: id, payload: { network_task: {
  candidate_account_id: id, candidate_wallet_address: wallet, project_need_summary: "Implement a bounded provider-recovery control with regression evidence.",
  task_class: "network", task_work_type: "code_task", required_badge_id: "core_contributor", operating_badge_id: "core_contributor",
  badge_work_type: "code_task", reward_min_pft: 1, reward_max_pft: 2, retry_failed: retry,
} } }, sourcePacket: {} });
let jobId = "", allocId = "", intentId = "";
async function fail(cause = "inference_timeout") {
  await query("UPDATE network_task_generation_jobs SET status='failed',attempt_count=3,request_id='',task_id='',generated_task_payload=$2::jsonb WHERE id=$1", [jobId, JSON.stringify({ intentAssessment: { error: cause, relationship: "uncertain" } })]);
  await query("UPDATE network_task_allocations SET allocation_status='failed' WHERE id=$1", [allocId]);
  await query("UPDATE network_task_intents SET status='failed' WHERE id=$1", [intentId]);
}
try {
  await migrateDatabase();
  await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Retry fixture','active')", [id]);
  await query("INSERT INTO pftl_sync_wallets(wallet_address,account_id,role,status) VALUES($1,$2,'user','active')", [wallet,id]);
  await query("INSERT INTO account_network_badges(id,account_id,badge_id,status,selected_default) VALUES($1,$1,'core_contributor','verified',true)", [id]);
  assert.equal(parseAgentCommand(["task","create",id,"--retry-failed","--execute"]).flags["retry-failed"], true);
  await assert.rejects(enqueue(request(true)), { message: "network_task_retry_target_not_found" });
  const first = await enqueue(request(false));
  jobId = first.jobId; allocId = first.allocationId;
  intentId = (await query("SELECT id FROM network_task_intents WHERE generation_job_id=$1", [jobId])).rows[0].id;
  await fail();
  const replay = await enqueue(request(false));
  assert.equal(replay.executed, false); assert.equal(replay.reason, "network_task_failed_intent_requires_explicit_retry");
  const packet = await boardPacket(id);
  assert.equal(packet.generation_queue.queued, 0); assert.equal(packet.generation_queue.historical_failed, 1);
  assert.equal(packet.generation_failures[0].legacy_intent_provider_error, "inference_timeout");
  const retries = await Promise.all(Array.from({ length: 6 }, () => enqueue(request(true))));
  assert.equal(retries.filter(r => r.reason === "network_task_provider_failure_requeued").length, 1);
  assert.ok(retries.every(r => r.jobId === jobId && r.allocationId === allocId));
  for (let attempt = 4; attempt <= 6; attempt++) {
    await query("UPDATE network_task_generation_jobs SET next_attempt_at=now() WHERE id=$1", [jobId]);
    const job = (await claimNetworkTaskGenerationJobs()).find(j => j.id === jobId);
    assert.equal(job.attempt_count, attempt);
    assert.equal(job.generated_task_payload.manualRetryAttemptBase, 3);
    const failed = await markNetworkTaskGenerationJobFailed({ jobId, workerAttemptId: job.worker_attempt_id, error: "network_task_intent_assessment_failed:inference_timeout",
      failure: { code: "network_task_intent_assessment_failed", causeCode: "inference_timeout", retryable: true } });
    assert.equal(failed.job.status, attempt === 6 ? "failed" : "queued");
  }
  await fail("semantic_duplicate");
  await assert.rejects(enqueue(request(true)), { message: "network_task_retry_requires_pre_request_provider_failure" });
  await fail();
  const deterministicRequestId = "req_net_" + createHash("sha256").update(jobId).digest("hex").slice(0,32);
  await query("INSERT INTO task_requests(request_id,account_id,status,request_bundle_cid) VALUES($1,$2,'queued','fixture')", [deterministicRequestId,id]);
  await assert.rejects(enqueue(request(true)), { message: "network_task_retry_request_exists" });
  await query("DELETE FROM task_requests WHERE account_id=$1", [id]);
  // A new assignment can consume the free slot while an old job is failed.
  await query("INSERT INTO network_task_allocations(id,project_id,candidate_account_id,candidate_wallet_address,allocation_status) VALUES($1,$2,$2,$3,'accepted')", [id+"_blocker",id,wallet]);
  await assert.rejects(enqueue(request(true)), { message: "network_task_candidate_at_capacity" });
  await query("DELETE FROM network_task_allocations WHERE id=$1", [id+"_blocker"]);
  await query("UPDATE account_network_badges SET status='revoked',revoked_at=now() WHERE id=$1", [id]);
  await assert.rejects(enqueue(request(true)), error => error.message.includes("badge"));
  console.log(JSON.stringify({ ok: true, historicalFailuresNotPending: true, explicitRecoveryRequired: true, concurrentRetries: 6, requeues: 1, durableIdsPreserved: true, lifetimeAttempts: 6, retryBudget: 3, semanticHoldProtected: true, existingRequestProtected: true, capacityAndBadgeRechecked: true }));
} finally {
  await query("DELETE FROM task_requests WHERE account_id=$1", [id]);
  await query("DELETE FROM network_projects WHERE id=$1", [id]);
  await query("DELETE FROM account_network_badges WHERE account_id=$1", [id]);
  await query("DELETE FROM pftl_sync_wallets WHERE account_id=$1", [id]);
  await query("DELETE FROM user_observability_events WHERE account_id=$1", [id]);
  await closePool();
}
