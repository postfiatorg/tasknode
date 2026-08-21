import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { createTaskRequestForNetworkJob } from "../server/network-task-generation-worker.js";
import {
  listFailedRequestNetworkTaskGenerationChains,
  markNetworkTaskGenerationJobFailed,
  reclaimStaleNetworkTaskGenerationJobs,
  recoverFailedRequestNetworkTaskGenerationChains,
} from "../server/repositories/network-tasks.js";
import { claimTaskGenerationRequests } from "../server/repositories/task-requests.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const projectId = `netgen_guard_project_${suffix}`;
const accountId = `acct_netgen_guard_${suffix}`;
const wallet = `rNetgenGuard${suffix}`.slice(0, 120);
const advancedRequestId = `req_netgen_guard_advanced_${suffix}`;
const regressedRequestId = `req_netgen_guard_regressed_${suffix}`;
const proposedRequestId = `req_netgen_guard_proposed_${suffix}`;
const claimableRequestId = `req_netgen_guard_claimable_${suffix}`;
const failedChainRequestId = `req_netgen_guard_failed_chain_${suffix}`;
const midGenerationRequestId = `req_netgen_guard_mid_generation_${suffix}`;
const healthyQueuedRequestId = `req_netgen_guard_healthy_queued_${suffix}`;
const generatedTaskRequestId = `req_netgen_guard_generated_task_${suffix}`;
const generatedTaskId = `task_netgen_guard_generated_${suffix}`;
const requestIds = [
  advancedRequestId,
  regressedRequestId,
  proposedRequestId,
  claimableRequestId,
  failedChainRequestId,
  midGenerationRequestId,
  healthyQueuedRequestId,
  generatedTaskRequestId,
];

async function cleanup() {
  await query("DELETE FROM network_project_task_refs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM task_projections WHERE request_id = ANY($1::text[]) OR task_id = $2", [
    requestIds,
    generatedTaskId,
  ]);
  await query("DELETE FROM task_requests WHERE request_id = ANY($1::text[])", [requestIds]);
  await query("DELETE FROM network_task_generation_jobs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_task_intents WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_task_allocations WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
}

async function insertAllocation(allocationId, { allocationStatus = "queued", requestId = "", generatedTaskId = "" } = {}) {
  await query(
    `
      INSERT INTO network_task_allocations (
        id, idempotency_key, project_id, task_class, allocation_status,
        task_request_id, generated_task_id, candidate_account_id, candidate_wallet_address
      )
      VALUES ($1, $2, $3, 'network', $4, $5, $6, $7, $8)
    `,
    [allocationId, allocationId, projectId, allocationStatus, requestId, generatedTaskId, accountId, wallet]
  );
}

async function insertJob({
  jobId,
  allocationId,
  requestId = "",
  status = "running",
  taskId = "",
  attemptCount = 1,
  lockedAtSql = "now()",
}) {
  await query(
    `
      INSERT INTO network_task_generation_jobs (
        id, idempotency_key, allocation_id, project_id, task_class, candidate_account_id,
        candidate_wallet_address, status, request_id, task_id, attempt_count, locked_at
      )
      VALUES ($1, $2, $3, $4, 'network', $5, $6, $7, $8, $9, $10, ${lockedAtSql})
    `,
    [jobId, jobId, allocationId, projectId, accountId, wallet, status, requestId, taskId, attemptCount]
  );
}

async function insertTaskRequest({ requestId, status, generatedTaskId = "", requestBundleCid = "", lastError = "" }) {
  await query(
    `
      INSERT INTO task_requests (
        request_id, account_id, subject_wallet, source, request_text,
        requested_task_kind, request_bundle_cid, bundle_id, status, generated_task_id, last_error
      )
      VALUES ($1, $2, $3, 'network_task', 'Network Task', 'network', $4, $5, $6, $7, $8)
    `,
    [requestId, accountId, wallet, requestBundleCid, `bundle_${requestId}`, status, generatedTaskId, lastError]
  );
}

async function insertIntent({ intentId, allocationId, jobId, requestId = "", taskId = "", status = "generated" }) {
  await query(
    `
      INSERT INTO network_task_intents (
        id, semantic_key, project_id, task_class, candidate_account_id, candidate_wallet_address,
        normalized_need_hash, project_need_summary, routing_reason_summary, status,
        allocation_id, generation_job_id, request_id, task_id
      )
      VALUES ($1, $2, $3, 'network', $4, $5, $6, 'Smoke need', 'Smoke route', $7, $8, $9, $10, $11)
    `,
    [
      intentId,
      `semantic_${intentId}`,
      projectId,
      accountId,
      wallet,
      `need_${intentId}`,
      status,
      allocationId,
      jobId,
      requestId,
      taskId,
    ]
  );
}

async function jobRow(jobId) {
  const result = await query("SELECT * FROM network_task_generation_jobs WHERE id = $1", [jobId]);
  return result.rows[0] || null;
}

async function requestRow(requestId) {
  const result = await query("SELECT * FROM task_requests WHERE request_id = $1", [requestId]);
  return result.rows[0] || null;
}

async function main() {
  if (!databaseEnabled()) {
    console.log("network task generation recovery smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();
  await cleanup();
  try {
    await query(
      `
        INSERT INTO network_projects (
          id, type, title, summary, objective, about, status, origin, proposed_by
        )
        VALUES (
          $1, 'network_validation', 'Network generation guard smoke', 'Guard smoke',
          'Verify double-publish guard and stale-running recovery.',
          'Fixture project for Network Task generation recovery.', 'active', 'smoke', 'hive'
        )
      `,
      [projectId]
    );

    // 1. claimTaskGenerationRequests must skip requests that already produced a task,
    //    even if their status regressed to 'queued'.
    await insertTaskRequest({
      requestId: regressedRequestId,
      status: "queued",
      generatedTaskId: `task_netgen_guard_regressed_${suffix}`,
      requestBundleCid: `QmNetgenGuardRegressed${suffix}`,
    });
    await insertTaskRequest({
      requestId: proposedRequestId,
      status: "proposed",
      generatedTaskId: `task_netgen_guard_proposed_${suffix}`,
      requestBundleCid: `QmNetgenGuardProposed${suffix}`,
    });
    await insertTaskRequest({
      requestId: claimableRequestId,
      status: "queued",
      requestBundleCid: `QmNetgenGuardClaimable${suffix}`,
    });
    const claimed = await claimTaskGenerationRequests({ limit: 10 });
    const claimedIds = claimed.map((request) => request.requestId);
    assert.ok(claimedIds.includes(claimableRequestId), "claimable request was not claimed");
    assert.ok(!claimedIds.includes(regressedRequestId), "regressed generated request was claimed");
    assert.ok(!claimedIds.includes(proposedRequestId), "proposed generated request was claimed");
    assert.equal((await requestRow(regressedRequestId)).status, "queued");
    assert.equal((await requestRow(proposedRequestId)).status, "proposed");

    // 2. createTaskRequestForNetworkJob must not regress an already-advanced request;
    //    it marks the retried job generated from the existing request instead.
    const advancedAllocationId = `netalloc_guard_advanced_${suffix}`;
    const advancedJobId = `netjob_guard_advanced_${suffix}`;
    const advancedTaskId = `task_netgen_guard_advanced_${suffix}`;
    const advancedCid = `QmNetgenGuardAdvanced${suffix}`;
    await insertAllocation(advancedAllocationId);
    await insertJob({ jobId: advancedJobId, allocationId: advancedAllocationId, requestId: advancedRequestId });
    await insertTaskRequest({
      requestId: advancedRequestId,
      status: "proposed",
      generatedTaskId: advancedTaskId,
      requestBundleCid: advancedCid,
    });
    const guardResult = await createTaskRequestForNetworkJob(await jobRow(advancedJobId));
    assert.equal(guardResult.reusedExistingRequest, true);
    assert.equal(guardResult.requestId, advancedRequestId);
    assert.equal(guardResult.requestBundleCid, advancedCid);
    const advancedRequest = await requestRow(advancedRequestId);
    assert.equal(advancedRequest.status, "proposed", "guard path regressed the request status");
    assert.equal(advancedRequest.generated_task_id, advancedTaskId);
    const advancedJob = await jobRow(advancedJobId);
    assert.equal(advancedJob.status, "generated");
    assert.equal(advancedJob.request_bundle_cid, advancedCid);

    // 3. markNetworkTaskGenerationJobFailed must not flip a non-running job.
    const failedMark = await markNetworkTaskGenerationJobFailed({
      jobId: advancedJobId,
      error: "smoke_late_failure",
    });
    assert.equal(failedMark.job, null);
    assert.equal((await jobRow(advancedJobId)).status, "generated");

    // 4. Stale-running reclaim: stale jobs go back to queued, fresh jobs stay running,
    //    stale jobs at the attempt limit converge to failed and fail the allocation.
    const staleAllocationId = `netalloc_guard_stale_${suffix}`;
    const freshAllocationId = `netalloc_guard_fresh_${suffix}`;
    const exhaustedAllocationId = `netalloc_guard_exhausted_${suffix}`;
    const staleJobId = `netjob_guard_stale_${suffix}`;
    const freshJobId = `netjob_guard_fresh_${suffix}`;
    const exhaustedJobId = `netjob_guard_exhausted_${suffix}`;
    await insertAllocation(staleAllocationId);
    await insertAllocation(freshAllocationId);
    await insertAllocation(exhaustedAllocationId);
    await insertJob({
      jobId: staleJobId,
      allocationId: staleAllocationId,
      attemptCount: 1,
      lockedAtSql: "now() - interval '10 minutes'",
    });
    await insertJob({ jobId: freshJobId, allocationId: freshAllocationId, attemptCount: 1 });
    await insertJob({
      jobId: exhaustedJobId,
      allocationId: exhaustedAllocationId,
      attemptCount: 3,
      lockedAtSql: "now() - interval '10 minutes'",
    });
    const reclaimed = await reclaimStaleNetworkTaskGenerationJobs({ staleMinutes: 5, limit: 10 });
    const reclaimedById = new Map(reclaimed.map((job) => [job.id, job]));
    assert.ok(reclaimedById.has(staleJobId), "stale running job was not reclaimed");
    assert.ok(reclaimedById.has(exhaustedJobId), "exhausted stale job was not reclaimed");
    assert.ok(!reclaimedById.has(freshJobId), "fresh running job was reclaimed");
    assert.equal((await jobRow(staleJobId)).status, "queued");
    assert.equal((await jobRow(freshJobId)).status, "running");
    assert.equal((await jobRow(exhaustedJobId)).status, "failed");
    const exhaustedAllocation = await query("SELECT allocation_status FROM network_task_allocations WHERE id = $1", [
      exhaustedAllocationId,
    ]);
    assert.equal(exhaustedAllocation.rows[0].allocation_status, "failed");

    // 5. Failed-request recovery: select only the wedged generated/link_failed chain
    //    and never healthy in-flight, queued, or generated-task chains.
    const failedChainAllocationId = `netalloc_guard_failed_chain_${suffix}`;
    const failedChainJobId = `netjob_guard_failed_chain_${suffix}`;
    const failedChainIntentId = `netintent_guard_failed_chain_${suffix}`;
    const midGenerationAllocationId = `netalloc_guard_mid_generation_${suffix}`;
    const midGenerationJobId = `netjob_guard_mid_generation_${suffix}`;
    const healthyQueuedAllocationId = `netalloc_guard_healthy_queued_${suffix}`;
    const healthyQueuedJobId = `netjob_guard_healthy_queued_${suffix}`;
    const generatedTaskAllocationId = `netalloc_guard_generated_task_${suffix}`;
    const generatedTaskJobId = `netjob_guard_generated_task_${suffix}`;
    await insertAllocation(failedChainAllocationId, { requestId: failedChainRequestId });
    await insertJob({
      jobId: failedChainJobId,
      allocationId: failedChainAllocationId,
      requestId: failedChainRequestId,
      status: "generated",
    });
    await insertIntent({
      intentId: failedChainIntentId,
      allocationId: failedChainAllocationId,
      jobId: failedChainJobId,
      requestId: failedChainRequestId,
    });
    await insertTaskRequest({
      requestId: failedChainRequestId,
      status: "failed",
      lastError: "smoke_context_ipfs_fetch_failed",
    });

    await insertAllocation(midGenerationAllocationId, { requestId: midGenerationRequestId });
    await insertJob({
      jobId: midGenerationJobId,
      allocationId: midGenerationAllocationId,
      requestId: midGenerationRequestId,
      status: "generated",
    });
    await insertTaskRequest({ requestId: midGenerationRequestId, status: "generating" });

    await insertAllocation(healthyQueuedAllocationId, { requestId: healthyQueuedRequestId });
    await insertJob({
      jobId: healthyQueuedJobId,
      allocationId: healthyQueuedAllocationId,
      requestId: healthyQueuedRequestId,
      status: "queued",
    });
    await insertTaskRequest({
      requestId: healthyQueuedRequestId,
      status: "failed",
      lastError: "smoke_failed_but_job_still_queued",
    });

    await insertAllocation(generatedTaskAllocationId, {
      requestId: generatedTaskRequestId,
      generatedTaskId,
    });
    await insertJob({
      jobId: generatedTaskJobId,
      allocationId: generatedTaskAllocationId,
      requestId: generatedTaskRequestId,
      taskId: generatedTaskId,
      status: "generated",
    });
    await insertTaskRequest({
      requestId: generatedTaskRequestId,
      status: "failed",
      generatedTaskId,
      lastError: "smoke_generated_task_not_recoverable",
    });
    await query(
      `
        INSERT INTO task_projections (task_id, request_id, account_id, subject_wallet, status, title, task_kind, source)
        VALUES ($1, $2, $3, $4, 'proposed', 'Generated smoke task', 'network', 'smoke')
      `,
      [generatedTaskId, generatedTaskRequestId, accountId, wallet]
    );
    await query(
      `
        INSERT INTO network_project_task_refs (id, project_id, task_id, request_id, title, state, source, metadata_json)
        VALUES ($1, $2, $3, $4, 'Generated smoke task', 'proposed', 'network_task_generation', $5::jsonb)
      `,
      [
        `netref_guard_generated_task_${suffix}`,
        projectId,
        generatedTaskId,
        generatedTaskRequestId,
        JSON.stringify({ generation_job_id: generatedTaskJobId, allocation_id: generatedTaskAllocationId }),
      ]
    );
    const failedRequestCandidates = await listFailedRequestNetworkTaskGenerationChains({
      limit: 20,
      projectId,
    });
    assert.deepEqual(
      failedRequestCandidates.map((row) => row.job_id),
      [failedChainJobId],
      "failed-request predicate selected a healthy or generated-task chain"
    );

    const failedRequestRecovery = await recoverFailedRequestNetworkTaskGenerationChains({
      limit: 20,
      projectId,
      logger: { warn() {} },
      operator: "network_task_generation_recovery_smoke",
    });
    assert.equal(failedRequestRecovery.checked, 1);
    assert.equal(failedRequestRecovery.recovered[0].jobId, failedChainJobId);
    assert.equal((await jobRow(failedChainJobId)).status, "failed");
    const recoveredAllocation = await query("SELECT allocation_status FROM network_task_allocations WHERE id = $1", [
      failedChainAllocationId,
    ]);
    assert.equal(recoveredAllocation.rows[0].allocation_status, "failed");
    const recoveredIntent = await query("SELECT status FROM network_task_intents WHERE id = $1", [failedChainIntentId]);
    assert.equal(recoveredIntent.rows[0].status, "stale");
    assert.equal((await requestRow(failedChainRequestId)).status, "cancelled");
    assert.equal((await jobRow(midGenerationJobId)).status, "generated");
    assert.equal((await jobRow(healthyQueuedJobId)).status, "queued");
    assert.equal((await jobRow(generatedTaskJobId)).status, "generated");

    console.log("network task generation recovery smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}
