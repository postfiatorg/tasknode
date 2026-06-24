import assert from "node:assert/strict";
import {
  applyOffchainTaskTransitionWithClient,
  offchainTaskLifecycleDualWriteEnabled,
  offchainTaskLifecycleEnabled,
  transitionForSubmissionMode,
  transitionForTaskAction,
} from "../server/offchain-task-lifecycle.js";

function mockClient({ projectionRowCount = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/UPDATE task_projections/i.test(sql)) {
        return {
          rowCount: projectionRowCount,
          rows: [{ task_id: params[0], status: params[1], event_count: 2 }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

assert.equal(offchainTaskLifecycleEnabled({ TASKNODE_OFFCHAIN_TASK_LIFECYCLE: "true" }), true);
assert.equal(offchainTaskLifecycleEnabled({ TASKNODE_OFFCHAIN_TASK_LIFECYCLE: "0" }), false);
assert.equal(offchainTaskLifecycleDualWriteEnabled({ TASKNODE_OFFCHAIN_TASK_LIFECYCLE_DUAL_WRITE: "on" }), true);
assert.equal(transitionForTaskAction("accept"), "accepted");
assert.equal(transitionForTaskAction("refuse"), "refused");
assert.equal(transitionForSubmissionMode("initial_submission"), "submitted");
assert.equal(transitionForSubmissionMode("verification_response"), "verification_response_submitted");

const client = mockClient();
const result = await applyOffchainTaskTransitionWithClient(client, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_smoke",
    request_id: "req_smoke",
    status: "accepted",
  },
  transition: "submitted",
  payload: {
    offchainPayload: {
      event_id: "evt_smoke_submission",
      task_id: "task_smoke",
      schema: "pf.task.submission.v1",
      artifact_type: "text",
      evidence: {
        artifact_type: "text",
        value: "Real evidence retained in direct-write payload.",
      },
    },
  },
  metadata: {
    endpoint: "POST /api/tasks/submission",
    submissionMode: "initial_submission",
  },
  dualWrite: true,
});

assert.equal(result.ok, true);
assert.equal(result.source, "direct_write");
assert.equal(result.transition, "submitted");
assert.equal(result.eventInserted, true);
assert.equal(result.event.eventId, "evt_smoke_submission");
assert.equal(result.event.sourceTxHash, "offchain:evt_smoke_submission");
assert.equal(client.calls.length, 2);

const [insertCall, updateCall] = client.calls;
assert.match(insertCall.sql, /INSERT INTO task_events/i);
assert.match(insertCall.sql, /DO NOTHING/i);
assert.equal(insertCall.params[0], "evt_smoke_submission");
assert.equal(insertCall.params[1], "task_smoke");
assert.equal(insertCall.params[4], "pf.task.submission.v1");
assert.equal(insertCall.params[10], "direct_write");
const insertedPayload = JSON.parse(insertCall.params[8]);
assert.equal(insertedPayload.event_id, "evt_smoke_submission");
assert.equal(insertedPayload.evidence.value, "Real evidence retained in direct-write payload.");
assert.equal(insertedPayload.transition, "submitted");
const insertedProvenance = JSON.parse(insertCall.params[11]);
assert.equal(insertedProvenance.source, "direct_write");
assert.equal(insertedProvenance.mode, "server_authoritative_postgres");
assert.equal(insertedProvenance.dualWrite, true);
const insertedSignature = JSON.parse(insertCall.params[12]);
assert.equal(insertedSignature.verification.present, false);
assert.equal(insertedSignature.verification.reason, "signature_missing");

assert.match(updateCall.sql, /UPDATE task_projections/i);
assert.equal(updateCall.params[0], "task_smoke");
assert.equal(updateCall.params[1], "submitted");
assert.equal(updateCall.params[4], "direct_write");
assert.equal(updateCall.params[8], true);

const missClient = mockClient({ projectionRowCount: 0 });
await assert.rejects(
  () =>
    applyOffchainTaskTransitionWithClient(missClient, {
      accountId: "acct_smoke",
      walletAddress: "rSmokeWallet",
      task: { task_id: "task_smoke", status: "accepted" },
      transition: "submitted",
      payload: { offchainPayload: { event_id: "evt_smoke_miss", task_id: "task_smoke" } },
    }),
  /offchain_task_projection_update_missed/
);

console.log("offchain-task-lifecycle-smoke ok");
