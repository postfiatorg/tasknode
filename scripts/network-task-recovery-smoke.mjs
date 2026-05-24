import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  formatNetworkTaskRecoveryLogs,
  recoverNetworkTasksOnce,
} from "../server/network-task-recovery.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const projectId = `network_recovery_project_${suffix}`;
const accountId = `acct_network_recovery_${suffix}`;
const wallet = `rNetworkRecovery${suffix}`.slice(0, 120);

const tasks = [
  {
    key: "accepted",
    taskId: `task_network_recovery_accepted_${suffix}`,
    status: "accepted",
    refState: "proposed",
    allocationStatus: "proposed",
    expectedNext: "await_user_evidence",
    expectedWorker: "",
  },
  {
    key: "submitted",
    taskId: `task_network_recovery_submitted_${suffix}`,
    status: "submitted",
    refState: "accepted",
    allocationStatus: "accepted",
    expectedNext: "resume_verification_request_worker",
    expectedWorker: "verification_request",
    eventType: "pf.task.submission.v1",
    phase: "initial_submission",
    cid: `QmRecoverySubmission${suffix}`,
    txHash: `TX_RECOVERY_SUBMISSION_${suffix}`,
  },
  {
    key: "review_pending",
    taskId: `task_network_recovery_review_${suffix}`,
    status: "verification_response_submitted",
    refState: "verification_requested",
    allocationStatus: "verification_requested",
    expectedNext: "resume_reward_scoring_worker",
    expectedWorker: "reward_scoring",
    eventType: "pf.task.verification_response.v1",
    phase: "verification_response",
    cid: `QmRecoveryVerification${suffix}`,
    txHash: `TX_RECOVERY_VERIFICATION_${suffix}`,
  },
];

async function cleanup() {
  const ids = tasks.map((task) => task.taskId);
  await query("DELETE FROM network_task_allocations WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_task_generation_jobs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_project_task_refs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
  await query("DELETE FROM task_events WHERE task_id = ANY($1::text[])", [ids]);
  await query("DELETE FROM task_projections WHERE task_id = ANY($1::text[])", [ids]);
}

function workerMetadata(status) {
  if (status === "submitted") {
    return { workers: { verification_request: { processing: "false", published: "false" } } };
  }
  if (status === "verification_response_submitted") {
    return { workers: { reward_scoring: { processing: "false", published: "false" } } };
  }
  return { workers: {} };
}

async function seedTask(task, index) {
  const allocationId = `netalloc_recovery_${task.key}_${suffix}`;
  const jobId = `netjob_recovery_${task.key}_${suffix}`;
  const requestId = `req_recovery_${task.key}_${suffix}`;
  await query(
    `
      INSERT INTO network_task_allocations (
        id, idempotency_key, project_id, task_class, allocation_status,
        task_request_id, generated_task_id, candidate_account_id,
        candidate_wallet_address
      )
      VALUES ($1, $2, $3, 'network', $4, $5, $6, $7, $8)
    `,
    [allocationId, allocationId, projectId, task.allocationStatus, requestId, task.taskId, accountId, wallet]
  );
  await query(
    `
      INSERT INTO network_task_generation_jobs (
        id, idempotency_key, allocation_id, project_id, task_class, candidate_account_id,
        candidate_wallet_address, status, request_id, task_id
      )
      VALUES ($1, $2, $3, $4, 'network', $5, $6, 'published', $7, $8)
    `,
    [jobId, jobId, allocationId, projectId, accountId, wallet, requestId, task.taskId]
  );
  await query(
    `
      INSERT INTO network_project_task_refs (
        id, project_id, task_id, request_id, title, state, assignee_wallet,
        reward_pft, source, sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 12000, 'network_task_generation', $8)
    `,
    [`netref_recovery_${task.key}_${suffix}`, projectId, task.taskId, requestId, `Recovery ${task.key}`, task.refState, wallet, index]
  );
  await query(
    `
      INSERT INTO task_projections (
        task_id, account_id, subject_wallet, authority_wallet, allocation_wallet,
        request_id, status, title, description, task_kind, reward_offer_pft,
        reward_actual_pft, last_event_tx_hash, last_event_cid, last_event_at,
        metadata_json, source, updated_at
      )
      VALUES (
        $1, $2, $3, 'rRecoveryAuthority', 'rRecoveryAllocation',
        $4, $5, $6, $7, 'network', 12000, 0, $8, $9, now(),
        $10::jsonb, 'network_recovery_smoke', now()
      )
    `,
    [
      task.taskId,
      accountId,
      wallet,
      requestId,
      task.status,
      `Recovery ${task.key}`,
      `Fixture task for ${task.status} restart recovery.`,
      task.txHash || `TX_RECOVERY_${task.key}_${suffix}`,
      task.cid || `QmRecovery${task.key}${suffix}`,
      JSON.stringify(workerMetadata(task.status)),
    ]
  );
  if (task.eventType) {
    await query(
      `
        INSERT INTO task_events (
          id, task_id, account_id, wallet_address, event_type, source_tx_hash,
          source_cid, event_digest, payload_json, pointer_json, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb, now())
      `,
      [
        `taskevent_recovery_${task.key}_${suffix}`,
        task.taskId,
        accountId,
        wallet,
        task.eventType,
        task.txHash,
        task.cid,
        `sha256:recovery_${task.key}_${suffix}`,
        JSON.stringify({
          schema: task.eventType,
          task_id: task.taskId,
          event_id: `evt_recovery_${task.key}_${suffix}`,
          phase: task.phase,
          evidence_refs: [
            {
              artifact_type: "text",
              artifact_cid: task.cid,
              artifact_digest: `sha256:recovery_${task.key}_${suffix}`,
            },
          ],
        }),
      ]
    );
  }
}

async function main() {
  if (!databaseEnabled()) {
    console.log("network task recovery smoke skipped: database not configured");
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
          $1, 'network_validation', 'Network recovery smoke', 'Recovery smoke',
          'Verify restart recovery for active Network Tasks.',
          'Fixture project for Network Task recovery.', 'active', 'smoke', 'hive'
        )
      `,
      [projectId]
    );
    for (const [index, task] of tasks.entries()) {
      await seedTask(task, index + 1);
    }

    const result = await recoverNetworkTasksOnce({
      limit: 20,
      projectId,
      executeReviewQueue: false,
      logger: { info() {}, warn: console.warn, error: console.error },
    });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);

    const byId = new Map(result.tasks.map((task) => [task.taskId, task]));
    for (const task of tasks) {
      const recovered = byId.get(task.taskId);
      assert.ok(recovered, `missing recovered task ${task.taskId}`);
      assert.equal(recovered.state, task.status);
      assert.equal(recovered.nextAction, task.expectedNext);
      assert.equal(recovered.workerName, task.expectedWorker);
      assert.equal(recovered.duplicateGuard.recoverySignsUserAcceptance, false);
      assert.equal(recovered.duplicateGuard.recoverySubmitsUserEvidence, false);
      if (task.cid) {
        assert.equal(recovered.latestEvidence.sourceCid, task.cid);
        assert.equal(recovered.latestEvidence.sourceTxHash, task.txHash);
        assert.equal(recovered.latestEvidence.evidenceRefCount, 1);
      }
    }

    const mirrorResult = await query(
      `
        SELECT refs.task_id, refs.state, alloc.allocation_status
        FROM network_project_task_refs refs
        JOIN network_task_allocations alloc
          ON alloc.generated_task_id = refs.task_id
        WHERE refs.project_id = $1
        ORDER BY refs.task_id
      `,
      [projectId]
    );
    for (const row of mirrorResult.rows) {
      const expected = tasks.find((task) => task.taskId === row.task_id);
      assert.equal(row.state, expected.status);
      assert.equal(row.allocation_status, expected.status);
    }

    console.log(formatNetworkTaskRecoveryLogs(result));
    console.log("network task recovery smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}
