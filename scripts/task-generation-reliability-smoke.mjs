import assert from "node:assert/strict";

process.env.TASKNODE_TASKGEN_PROVIDER = "ambient";
process.env.AMBIENT_API_KEY = "taskgen-reliability-smoke-key";
process.env.AMBIENT_MODEL_STRUCTURED = "taskgen-reliability-smoke-model";
process.env.TASKNODE_NETWORK_TASK_GENERATION_V2_ENABLED = "false";
process.env.TASKNODE_HIVE_TASK_GENERATION_V2_ENABLED = "false";

const {
  generateTaskWithProvider,
} = await import("../server/task-generation-worker.js");
const {
  closePool,
  databaseEnabled,
  query,
} = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const {
  claimTaskGenerationRequests,
  heartbeatTaskGenerationRequest,
  markTaskRequestFailed,
  markTaskRequestProposed,
  reclaimStaleTaskGenerationRequests,
} = await import("../server/repositories/task-requests.js");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const requestId = `req_taskgen_reliability_${suffix}`;
const exhaustedRequestId = `req_taskgen_exhausted_${suffix}`;
const accountId = `acct_taskgen_reliability_${suffix}`;
const wallet = `rTaskgenReliability${suffix.slice(-12)}`;

const taskInput = {
  schema: "pf.taskgen.input.v1",
  request_bundle: {
    bundle_id: `bundle_${requestId}`,
    cid: `QmTaskgenReliability${suffix}`,
    digest: "sha256:taskgen-reliability",
  },
  request: {
    request_id: requestId,
    requestedTaskKind: "network",
    source: "network_task",
    requestText: "Create a small reliability smoke task.",
  },
  context: {},
  chat: {},
  memory: {},
  task_queue: {},
  network_task: {
    generation_job_id: `netjob_taskgen_reliability_${suffix}`,
    allocation_id: `netalloc_taskgen_reliability_${suffix}`,
    project_id: `project_taskgen_reliability_${suffix}`,
    task_class: "network",
    project_title: "Task Generation Reliability Smoke",
    project_need_summary: "Verify provider timeout and stale generation ownership guards.",
    action_output: "Prepare reliability evidence",
    reward_band_pft: { min: "3", max: "3" },
  },
  wallet: { wallet_address: wallet },
  policy: {
    task_class: "network",
    reward_offer_min_pft: "3",
    reward_offer_max_pft: "3",
    reward_policy_version: "network-reward-policy-v1",
    task_policy_version: "task-policy-network-v1",
    generation_policy_version: "taskgen-policy-network-v1",
  },
};

async function providerTimeoutSmoke() {
  const timeoutMs = 15;
  await assert.rejects(
    generateTaskWithProvider(taskInput, {
      providerTimeoutMs: timeoutMs,
      fetchImpl: (_url, init = {}) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason || new Error("AbortError"));
        }, { once: true });
      }),
    }),
    (error) => error?.code === "TASKGEN_PROVIDER_TIMEOUT" && error?.timeoutMs === timeoutMs
  );
}

async function ambientRequestBodySmoke() {
  let requestBody = null;
  const responsePayload = {
    id: "taskgen-reliability-ambient-request-smoke",
    choices: [{
      message: {
        content: JSON.stringify({
          schema: "pf.taskgen.output.v1",
          title: "Prepare reliability evidence",
          description: "Create a concise reliability evidence packet.",
          task_kind: "network",
          steps: ["Review the request.", "Create the evidence packet."],
          submission_requirement: { type: "text", criteria: "Submit the evidence packet." },
          verification_policy: { followup_required: false, mode: "standard_followup", verification_type: "text" },
          reward_offer: { amount_estimate_pft: "3.00" },
          deadline: { accept_by: "2030-01-01T00:00:00.000Z", deadline_at: null },
        }),
      },
    }],
  };
  const generated = await generateTaskWithProvider(taskInput, {
    fetchImpl: async (_url, init = {}) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(generated.metadata.provider, "ambient");
  assert.equal(requestBody.model, "taskgen-reliability-smoke-model");
  assert.deepEqual(requestBody.reasoning, { effort: "xhigh" });
}

async function requestRow(id) {
  const result = await query("SELECT * FROM task_requests WHERE request_id = $1", [id]);
  return result.rows[0] || null;
}

async function cleanup() {
  await query("DELETE FROM task_requests WHERE request_id = ANY($1::text[])", [
    [requestId, exhaustedRequestId],
  ]);
}

async function insertQueuedRequest() {
  await query(
    `
      INSERT INTO task_requests (
        request_id, account_id, subject_wallet, source, request_text,
        requested_task_kind, request_bundle_cid, bundle_id, status
      )
      VALUES ($1, $2, $3, 'network_task', 'Task generation reliability smoke',
        'network', $4, $5, 'queued')
    `,
    [requestId, accountId, wallet, `QmTaskgenReliabilityRequest${suffix}`, `bundle_${requestId}`]
  );
}

async function insertExhaustedGeneratingRequest() {
  await query(
    `
      INSERT INTO task_requests (
        request_id, account_id, subject_wallet, source, request_text,
        requested_task_kind, request_bundle_cid, bundle_id, status,
        worker_id, worker_attempt_id, worker_claimed_at, worker_heartbeat_at,
        worker_attempt_count
      )
      VALUES ($1, $2, $3, 'network_task', 'Task generation exhausted smoke',
        'network', $4, $5, 'generating', 'worker_exhausted', 'attempt_exhausted',
        now() - interval '2 hours', now() - interval '2 hours', 3)
    `,
    [exhaustedRequestId, accountId, wallet, `QmTaskgenExhaustedRequest${suffix}`, `bundle_${exhaustedRequestId}`]
  );
}

async function ownershipSmoke() {
  if (!databaseEnabled()) {
    console.log("task generation ownership smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();
  await cleanup();
  try {
    await insertQueuedRequest();
    await insertExhaustedGeneratingRequest();

    const [claimA] = await claimTaskGenerationRequests({
      limit: 1,
      workerId: "taskgen_reliability_worker_a",
      maxAttempts: 3,
    });
    assert.equal(claimA.requestId, requestId);
    assert.equal(claimA.workerId, "taskgen_reliability_worker_a");
    assert.match(claimA.workerAttemptId, /^taskgen_attempt_[a-f0-9]+$/);
    assert.equal(claimA.workerAttemptCount, 1);

    const wrongHeartbeat = await heartbeatTaskGenerationRequest({
      requestId,
      workerAttemptId: "wrong_attempt",
      workerId: "taskgen_reliability_worker_a",
      stage: "wrong_attempt",
    });
    assert.equal(wrongHeartbeat.ok, false);

    const wrongPropose = await markTaskRequestProposed({
      requestId,
      generatedTaskId: "task_wrong_attempt",
      workerAttemptId: "wrong_attempt",
      workerId: "taskgen_reliability_worker_a",
    });
    assert.equal(wrongPropose.ok, false);
    assert.equal((await requestRow(requestId)).generated_task_id, "");

    await query(
      `
        UPDATE task_requests
        SET worker_claimed_at = now() - interval '2 hours',
            worker_heartbeat_at = now() - interval '2 hours',
            updated_at = now() - interval '2 hours'
        WHERE request_id = $1
      `,
      [requestId]
    );

    const reclaimed = await reclaimStaleTaskGenerationRequests({
      maxAttempts: 3,
      staleSeconds: 60,
      limit: 10,
    });
    assert.equal(reclaimed.retried.some((request) => request.requestId === requestId), true);
    assert.equal(reclaimed.failed.some((request) => request.requestId === exhaustedRequestId), true);
    assert.equal((await requestRow(requestId)).status, "queued");
    assert.equal((await requestRow(exhaustedRequestId)).status, "failed");

    const [claimB] = await claimTaskGenerationRequests({
      limit: 1,
      workerId: "taskgen_reliability_worker_b",
      maxAttempts: 3,
    });
    assert.equal(claimB.requestId, requestId);
    assert.equal(claimB.workerId, "taskgen_reliability_worker_b");
    assert.notEqual(claimB.workerAttemptId, claimA.workerAttemptId);
    assert.equal(claimB.workerAttemptCount, 2);

    const staleAPropose = await markTaskRequestProposed({
      requestId,
      generatedTaskId: "task_stale_worker_a",
      subjectWallet: wallet,
      workerAttemptId: claimA.workerAttemptId,
      workerId: claimA.workerId,
    });
    assert.equal(staleAPropose.ok, false);
    assert.equal((await requestRow(requestId)).generated_task_id, "");

    const staleAFail = await markTaskRequestFailed({
      requestId,
      error: "stale_worker_a_failure",
      workerAttemptId: claimA.workerAttemptId,
      workerId: claimA.workerId,
    });
    assert.equal(staleAFail.ok, false);
    assert.equal((await requestRow(requestId)).status, "generating");

    const heartbeatB = await heartbeatTaskGenerationRequest({
      requestId,
      workerAttemptId: claimB.workerAttemptId,
      workerId: claimB.workerId,
      stage: "worker_b_complete",
    });
    assert.equal(heartbeatB.ok, true);

    const proposedB = await markTaskRequestProposed({
      requestId,
      generatedTaskId: "task_worker_b",
      subjectWallet: wallet,
      workerAttemptId: claimB.workerAttemptId,
      workerId: claimB.workerId,
      metadata: { smoke: "task_generation_reliability" },
    });
    assert.equal(proposedB.ok, true);
    const finalRow = await requestRow(requestId);
    assert.equal(finalRow.status, "proposed");
    assert.equal(finalRow.generated_task_id, "task_worker_b");
  } finally {
    await cleanup();
    await closePool();
  }
}

await ambientRequestBodySmoke();
await providerTimeoutSmoke();
await ownershipSmoke();

console.log("task generation reliability smoke ok");
