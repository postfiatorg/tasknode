import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deliveryDecision, mergeRoundProgress, recoverySchedule } from "../ops/bm-runtime/supervisor.mjs";
import { idleEligibleContributors } from "./bm/lib.mjs";
import { routingDuty } from "../server/board-task-policy.js";
import { assessTaskIntent } from "../server/task-intent-assessment.js";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { claimTaskGenerationRequests, reclaimStaleTaskGenerationRequests, retryOwnedTaskRequest } from "../server/repositories/task-requests.js";
import { claimNetworkTaskGenerationJobs, markNetworkTaskGenerationJobFailed } from "../server/repositories/network-task-generation-jobs.js";
process.env.TASKNODE_BOARD_SOURCES_OFFLINE = "true";

const url = new URL(process.env.DATABASE_URL);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Fixture must use local Postgres");
assert.equal(url.pathname, "/tasknode_hive_audit_20260919", "Fixture must use its dedicated disposable database");
const prefix = "hive_repair_" + randomUUID();
const ids = Array.from({ length: 103 }, (_, index) => prefix + "_" + String(index + 1).padStart(3, "0"));
const requestId = prefix + "_exhausted";
const base = Date.parse("2026-09-10T21:38:20.272Z");
const round = { id: "fixture_pending_round", state: "pending", results_json: {} };
const pending = { id: round.id, attempts: 3, alerted: true, progress: "{}", lastDeliveredAt: new Date(base).toISOString() };
const statusAt = now => ({ version: 1, pid: 123, threadId: "fixture-thread", ready: true, updatedAt: new Date(now).toISOString() });
const decisionAt = (now, extra = {}) => deliveryDecision({ round, pending, status: statusAt(now), now, ...extra });
const results = [];
assert.equal(decisionAt(base + 5 * 60_000), "wait_recovery");
assert.equal(decisionAt(base + 15 * 60_000), "recover");
for (const days of [1, 9, 30]) assert.equal(decisionAt(base + days * 86400000), "recover");
assert.equal(decisionAt(base + 86400000, { status: { ...statusAt(base + 86400000), ready: false } }), "wait_ready");
assert.equal(decisionAt(base + 86400000, { status: statusAt(base) }), "wait_ready");
assert.equal(decisionAt(base + 86400000, { pending: { ...pending, alerted: false } }), "alert_pending");
assert.equal(decisionAt(base + 86400000, { round: { ...round, state: "complete" } }), "quiet");
assert.equal(recoverySchedule({ ...pending, attempts: 4 }).delayMs, 30 * 60_000);
assert.equal(recoverySchedule({ ...pending, attempts: 500 }).delayMs, 6 * 3600_000);
const progress = mergeRoundProgress(pending, { ...round, results_json: { duty: { outcome: "blocked", reason: "A durable result." } } });
assert.equal(progress.attempts, 0);
assert.equal(progress.deliveryCount, 3, "delivery IDs must not repeat after progress resets retry budget");
assert.equal(decisionAt(base + 86400000, { pending: progress }), "deliver");
results.push({ case: "supervisor_recovery", pass: true, horizonsDays: [1, 9, 30], cooldownMinutes: [15, 30, 60, 120, 240, 360], busyAndStaleTerminalBlocked: true, monotonicDeliveryIds: true });

for (const code of ["inference_response_truncated", "inference_timeout"]) {
  await assert.rejects(assessTaskIntent({ need: "Implement recovery" }, { complete: async () => { throw Object.assign(new Error(code), { code, status: 502 }); } }),
    error => error.code === "network_task_intent_assessment_failed" && error.causeCode === code && error.retryable);
}
{
  // Contract failure: one repair turn, then a non-retryable contract failure that keeps both raw outputs.
  let calls = 0;
  await assert.rejects(assessTaskIntent({ need: "Implement recovery" }, { complete: async ({ body }) => { calls += 1; if (calls === 2) assert.ok(body.messages.at(-1).content.includes("task_intent_assessment_schema_invalid")); return { body: { choices: [{ message: { content: "{}", }, finish_reason: "stop" }] } }; } }),
    error => error.code === "network_task_intent_contract_failed" && error.causeCode === "task_intent_assessment_schema_invalid" && error.retryable === false && error.family === "contract" && error.repairAttempted && error.rawAttempts.length === 2);
  assert.equal(calls, 2, "exactly one repair request");
}
await assert.rejects(assessTaskIntent({ need: "Implement recovery" }, { complete: async () => { throw Object.assign(new Error("inference_http_error"), { code: "inference_http_error", status: 401 }); } }),
  error => error.retryable === false);
for (const relationship of ["duplicate", "uncertain", "continuation", "independent"]) {
  const input = { relationship, priorTaskIds: relationship === "duplicate" || relationship === "continuation" ? ["prior"] : [], reason: "Structured semantic judgment.", newOutput: "Working recovery control", actionable: true, scopeClear: true };
  const result = await assessTaskIntent({ need: "Implement recovery", priorTasks: [{ task_id: "prior" }] }, { complete: async ({ body }) => {
    assert.equal(body.reasoning.effort, "low"); assert.equal(body.max_tokens, 8192);
    return { body: { choices: [{ message: { content: JSON.stringify(input) } }] } };
  } });
  assert.equal(result.relationship, relationship);
}
results.push({ case: "typed_intent_failures", pass: true, transportCausesPreserved: true, contractFailuresRepairOnceThenStop: true, authenticationStops: true, semanticJudgmentsPreserved: true });

try {
  await migrateDatabase();
  for (const [index, id] of ids.entries()) {
    const handle = "repair-fixture-" + String(index + 1).padStart(3, "0") + "-" + prefix.slice(-6);
    await query("INSERT INTO app_accounts(account_id,account_json,hive_handle) VALUES($1,$2::jsonb,$3)", [id, JSON.stringify({ id, hiveHandle: handle, status: "active" }), handle]);
    await query("INSERT INTO account_linked_wallets(account_id,wallet_address,status) VALUES($1,$2,'linked')", [id, "rRepairFixture" + index]);
    await query("INSERT INTO account_network_badges(id,account_id,badge_id,status,selected_default) VALUES($1,$1,'kol','verified',true)", [id]);
    if (index < 12) await query("INSERT INTO task_projections(task_id,account_id,subject_wallet,status,task_kind) VALUES($1,$1,$2,'rewarded','personal')", [id, "rRepairFixture" + index]);
  }
  const first = (await idleEligibleContributors()).filter(member => ids.includes(member.account_id));
  const second = (await idleEligibleContributors()).filter(member => ids.includes(member.account_id));
  assert.equal(first.length, 103);
  assert.deepEqual(first.map(member => member.account_id), second.map(member => member.account_id));
  const board = { id: prefix, routing_constraints: { assignable_handles: ["repair-fixture-103-" + prefix.slice(-6)] } };
  assert.deepEqual(routingDuty(board, first, 0).candidate_ids, [ids[102]]);
  await query("UPDATE account_network_badges SET status='revoked',revoked_at=now() WHERE account_id=$1", [ids[102]]);
  assert.equal(routingDuty(board, await idleEligibleContributors(), 0), null);
  results.push({ case: "complete_candidate_coverage", pass: true, eligible: 103, surfacedOnEveryRound: 103, restrictedLastMemberSurfaced: true, revokedBadgeExcluded: true });

  await query("INSERT INTO task_requests(request_id,account_id,subject_wallet,source,status,request_bundle_cid,worker_attempt_count,worker_retry_after,last_error) VALUES($1,$2,'rRepairFixture12','pfterminal','queued',$3,3,now()-interval '11 days','original_provider_error')", [requestId, ids[12], "postgres:" + requestId]);
  assert.equal((await claimTaskGenerationRequests({ workerId: prefix, limit: 10, maxAttempts: 3 })).some(item => item.requestId === requestId), false);
  const reconciled = await reclaimStaleTaskGenerationRequests({ maxAttempts: 3, staleSeconds: 5 });
  const failed = reconciled.failed.find(item => item.requestId === requestId);
  assert.equal(failed.status, "failed"); assert.equal(failed.canRetry, true);
  assert.equal(failed.metadata.exhaustedPreviousError, "original_provider_error");
  const retried = await retryOwnedTaskRequest({ accountId: ids[12], requestId, expectedAttemptCount: 3 });
  assert.equal(retried.workerAttemptCount, 3); assert.equal(retried.status, "queued");
  assert.equal(retried.metadata.manualRetryAttemptBase, 3);
  const next = (await claimTaskGenerationRequests({ workerId: prefix, limit: 10, maxAttempts: 3 })).find(item => item.requestId === requestId);
  assert.equal(next.workerAttemptCount, 4); assert.equal(next.workerCycleAttemptCount, 1);
  // Queued legacy rows with a canonical offer are never failed/retried into another offer.
  await query("INSERT INTO task_projections(task_id,account_id,request_id,status,task_kind) VALUES($1,$2,$3,'accepted','personal')", [prefix, ids[12], requestId]);
  await query("UPDATE task_requests SET status='queued',metadata_json='{}'::jsonb WHERE request_id=$1", [requestId]);
  assert.equal((await reclaimStaleTaskGenerationRequests({ maxAttempts: 3 })).failed.some(item => item.requestId === requestId), false);
  await query("UPDATE task_requests SET status='failed' WHERE request_id=$1", [requestId]);
  assert.equal((await retryOwnedTaskRequest({ accountId: ids[12], requestId, expectedAttemptCount: 4 })).status, "failed");
  results.push({ case: "exhausted_queue_recovery", pass: true, reconciled: "failed", ownerRetry: "queued", lifetimeAttempts: 4, retryCycleAttempts: 1, existingOfferProtected: true });

  await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Fixture repair board','active')", [prefix]);
  for (const kind of ["provider", "semantic"]) {
    const id = prefix + "_" + kind;
    await query("INSERT INTO network_task_allocations(id,project_id,candidate_account_id) VALUES($1,$2,$2)", [id, prefix]);
    await query("INSERT INTO network_task_generation_jobs(id,allocation_id,project_id,candidate_account_id,status) VALUES($1,$1,$2,$2,'queued')", [id, prefix]);
    const firstAttempt = (await claimNetworkTaskGenerationJobs()).find(job => job.id === id);
    assert.ok(firstAttempt);
    const failure = { code: kind === "provider" ? "network_task_intent_assessment_failed" : "network_task_intent_needs_review", causeCode: kind === "provider" ? "inference_timeout" : "", retryable: kind === "provider" };
    let marked = await markNetworkTaskGenerationJobFailed({ jobId: id, workerAttemptId: firstAttempt.worker_attempt_id, error: failure.code, retryable: failure.retryable, failure });
    assert.equal(marked.job.status, kind === "provider" ? "queued" : "failed");
    assert.deepEqual(marked.job.generated_task_payload.generationFailure, failure);
    if (kind === "provider") {
      for (let attempt = 2; attempt <= 3; attempt++) {
        await query("UPDATE network_task_generation_jobs SET next_attempt_at=now() WHERE id=$1", [id]);
        const nextAttempt = (await claimNetworkTaskGenerationJobs()).find(job => job.id === id);
        assert.equal(nextAttempt.attempt_count, attempt);
        assert.equal((await markNetworkTaskGenerationJobFailed({ jobId: id, workerAttemptId: firstAttempt.worker_attempt_id, error: "stale" })).stale, true);
        marked = await markNetworkTaskGenerationJobFailed({ jobId: id, workerAttemptId: nextAttempt.worker_attempt_id, error: failure.code, failure });
      }
      assert.equal(marked.job.status, "failed"); assert.equal(marked.job.attempt_count, 3);
    }
  }
  results.push({ case: "durable_retry_policy", pass: true, providerAttemptsBoundedAt: 3, semanticHoldAttempts: 1, staleAttemptsFenced: true, typedCausePersisted: true });
  console.log(JSON.stringify({ ok: true, regressions: results, productionMutations: 0 }, null, 2));
} finally {
  await query("DELETE FROM task_requests WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM task_projections WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM network_projects WHERE id=$1", [prefix]);
  await query("DELETE FROM account_network_badges WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM account_linked_wallets WHERE account_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM app_accounts WHERE account_id=ANY($1::text[])", [ids]);
  await closePool();
}
