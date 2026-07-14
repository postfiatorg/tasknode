import assert from "node:assert/strict";
import {
  applyOffchainTaskOfferWithClient,
  applyOffchainTaskTransitionWithClient,
  offchainTaskLifecycleDualWriteEnabled,
  offchainTaskLifecycleEnabled,
  transitionForSubmissionMode,
  transitionForTaskAction,
} from "../server/offchain-task-lifecycle.js";
import { listNetworkTaskAllocationDivergences } from "../server/repositories/network-task-allocation-sync.js";

function mockClient({ projectionRowCount = 1, terminalPreserved = false, mirrorError = "" } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/UPDATE task_projections/i.test(sql)) {
        return {
          rowCount: projectionRowCount,
          rows: [{ task_id: params[0], status: params[1], event_count: 2, terminal_preserved: terminalPreserved }],
        };
      }
      if (/UPDATE network_task_allocations/i.test(sql) && mirrorError) {
        throw new Error(mirrorError);
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
assert.match(updateCall.sql, /current_projection AS/i);
assert.match(updateCall.sql, /preserve_terminal/i);
assert.match(updateCall.sql, /agent_cancelled_terminal/i);
assert.equal(updateCall.params[0], "task_smoke");
assert.equal(updateCall.params[1], "submitted");
assert.equal(updateCall.params[4], "direct_write");
assert.equal(updateCall.params[8], true);
assert.deepEqual(updateCall.params[9], [
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "failed",
  "completed",
  "rewarded",
]);
assert.equal(updateCall.params[10], "evt_smoke_submission");
assert.equal(result.terminalPreserved, false);

async function assertMirrorTransition({ taskId, previousStatus, transition, expectedStatus }) {
  const transitionClient = mockClient();
  const transitionResult = await applyOffchainTaskTransitionWithClient(transitionClient, {
    accountId: "acct_terminal_sync_smoke",
    walletAddress: "rTerminalSyncWallet",
    task: {
      task_id: taskId,
      request_id: `${taskId}_request`,
      status: previousStatus,
    },
    transition,
    payload: {
      offchainPayload: {
        event_id: `${taskId}_event`,
        task_id: taskId,
        schema: "pf.task.update.v1",
      },
    },
  });
  assert.equal(transitionClient.calls.length, 3);
  assert.match(transitionClient.calls[2].sql, /UPDATE network_task_allocations/i);
  assert.equal(transitionClient.calls[2].params[2], expectedStatus);
  assert.equal(transitionClient.calls[2].params[3], expectedStatus);
  assert.equal(transitionResult.terminalMirrorSync.allocationsUpdated, 1);
}

await assertMirrorTransition({
  taskId: "task_proposed_refused_sync",
  previousStatus: "proposed",
  transition: "refused",
  expectedStatus: "refused",
});
await assertMirrorTransition({
  taskId: "task_accepted_cancelled_sync",
  previousStatus: "accepted",
  transition: "cancelled",
  expectedStatus: "cancelled",
});

const mirrorFailureClient = mockClient({ mirrorError: "network_task_mirror_sync_failed" });
await assert.rejects(
  () =>
    applyOffchainTaskTransitionWithClient(mirrorFailureClient, {
      accountId: "acct_terminal_sync_smoke",
      walletAddress: "rTerminalSyncWallet",
      task: {
        task_id: "task_mirror_sync_failure",
        request_id: "req_mirror_sync_failure",
        status: "proposed",
      },
      transition: "refused",
      payload: {
        offchainPayload: {
          event_id: "evt_mirror_sync_failure",
          task_id: "task_mirror_sync_failure",
          schema: "pf.task.update.v1",
        },
      },
    }),
  /network_task_mirror_sync_failed/
);
assert.equal(mirrorFailureClient.calls.length, 3);

const divergenceQueryClient = mockClient();
await listNetworkTaskAllocationDivergences({ client: divergenceQueryClient });
assert.equal(divergenceQueryClient.calls.length, 1);
assert.equal(divergenceQueryClient.calls[0].params[3], 500);

const simpleSubmissionClient = mockClient();
await applyOffchainTaskTransitionWithClient(simpleSubmissionClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_simple_submission",
    request_id: "req_simple_submission",
    status: "accepted",
  },
  transition: "submitted",
  payload: {
    method: "text",
    value: "Simple direct-write evidence must survive review processing.",
    notes: "Simple submission notes.",
  },
});
const simpleSubmissionPayload = JSON.parse(simpleSubmissionClient.calls[0].params[8]);
assert.equal(simpleSubmissionPayload.evidence.value, "Simple direct-write evidence must survive review processing.");
assert.equal(simpleSubmissionPayload.submission.value, "Simple direct-write evidence must survive review processing.");
assert.equal(simpleSubmissionPayload.evidence_items[0].notes, "Simple submission notes.");

const simpleVerificationClient = mockClient();
await applyOffchainTaskTransitionWithClient(simpleVerificationClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_simple_verification",
    request_id: "req_simple_verification",
    status: "verification_requested",
  },
  transition: "verification_response_submitted",
  payload: {
    method: "text",
    response: "Simple verification response text must survive review processing.",
  },
});
const simpleVerificationPayload = JSON.parse(simpleVerificationClient.calls[0].params[8]);
assert.equal(simpleVerificationClient.calls[0].params[4], "pf.task.verification_response.v1");
assert.equal(simpleVerificationPayload.schema, "pf.task.verification_response.v1");
assert.equal(simpleVerificationPayload.phase, "verification_response");
assert.equal(simpleVerificationPayload.response.value, "Simple verification response text must survive review processing.");
assert.equal(simpleVerificationPayload.response_text, "Simple verification response text must survive review processing.");
assert.equal(simpleVerificationPayload.evidence_items[0].artifact_type, "text");

const stalePreparedVerificationClient = mockClient();
await applyOffchainTaskTransitionWithClient(stalePreparedVerificationClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_stale_prepared_verification",
    request_id: "req_stale_prepared_verification",
    status: "verification_requested",
  },
  transition: "verification_response_submitted",
  payload: {
    offchainPayload: {
      event_id: "evt_stale_prepared_verification",
      task_id: "task_stale_prepared_verification",
      schema: "pf.task.submission.v1",
      phase: "initial_submission",
      response: "A stale prepared payload must still record as a verification response.",
    },
  },
});
const stalePreparedVerificationPayload = JSON.parse(stalePreparedVerificationClient.calls[0].params[8]);
assert.equal(stalePreparedVerificationClient.calls[0].params[4], "pf.task.verification_response.v1");
assert.equal(stalePreparedVerificationPayload.schema, "pf.task.verification_response.v1");
assert.equal(stalePreparedVerificationPayload.phase, "verification_response");
assert.equal(stalePreparedVerificationPayload.response.value, "A stale prepared payload must still record as a verification response.");

const terminalClient = mockClient({ terminalPreserved: true });
const terminalResult = await applyOffchainTaskTransitionWithClient(terminalClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_terminal_smoke",
    request_id: "req_terminal_smoke",
    status: "accepted",
  },
  transition: "submitted",
  payload: {
    offchainPayload: {
      event_id: "evt_terminal_smoke",
      task_id: "task_terminal_smoke",
      schema: "pf.task.submission.v1",
    },
  },
});
assert.equal(terminalResult.terminalPreserved, true);

const offerClient = mockClient();
const offerResult = await applyOffchainTaskOfferWithClient(offerClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  offerPayload: {
    schema: "pf.task.offer.v1",
    event_id: "evt_smoke_offer",
    task_id: "task_offer_smoke",
    request_id: "req_offer_smoke",
    actor_wallet: "rAuthoritySmoke",
    subject_wallet: "rSmokeWallet",
    authority_wallet: "rAuthoritySmoke",
    allocation_wallet: "rAllocationSmoke",
    status: "proposed",
    title: "Direct offer smoke",
    description: "A direct-written offer should create its projection without pointer reduction.",
    task_kind: "personal",
    steps: ["Inspect the direct-write offer."],
    submission_requirement: { type: "text", criteria: "Submit the observation." },
    verification_policy: { followup_required: false, mode: "standard", verification_type: "text" },
    reward_offer: { amount_estimate_pft: "1.25" },
    accept_by: "2026-06-24T23:59:59.000Z",
    deadline_at: null,
    generation: { request_bundle_cid: "QmSmokeRequestBundle", model: "smoke" },
  },
});
assert.equal(offerResult.ok, true);
assert.equal(offerResult.event.eventId, "evt_smoke_offer");
assert.equal(offerResult.event.schema, "pf.task.offer.v1");
assert.equal(offerResult.event.sourceTxHash, "offchain:evt_smoke_offer");
assert.equal(offerClient.calls.length, 2);
const [offerInsertCall, offerProjectionCall] = offerClient.calls;
assert.match(offerInsertCall.sql, /INSERT INTO task_events/i);
assert.equal(offerInsertCall.params[4], "pf.task.offer.v1");
assert.equal(offerInsertCall.params[10], "direct_write");
assert.match(offerProjectionCall.sql, /INSERT INTO task_projections/i);
assert.match(offerProjectionCall.sql, /agent_cancelled_terminal/i);
assert.equal(offerProjectionCall.params[0], "task_offer_smoke");
assert.equal(offerProjectionCall.params[9], 1.25);
assert.equal(offerProjectionCall.params[19], "direct_write");
assert.equal(offerProjectionCall.params[23], true);

const rewardClient = mockClient();
const rewardResult = await applyOffchainTaskTransitionWithClient(rewardClient, {
  accountId: "acct_smoke",
  walletAddress: "rSmokeWallet",
  task: {
    task_id: "task_reward_smoke",
    request_id: "req_reward_smoke",
    status: "verification_response_submitted",
  },
  transition: "rewarded",
  payload: {
    sourceTxHash: "REAL_REWARD_TX",
    sourceCid: "QmRewardForensics",
    offchainPayload: {
      event_id: "evt_reward_smoke",
      task_id: "task_reward_smoke",
      schema: "pf.reward.v1",
      reward_pft: "4.50",
      economic_reward_pft: "4.50",
    },
  },
});
assert.equal(rewardResult.event.schema, "pf.reward.v1");
assert.equal(rewardResult.event.sourceTxHash, "REAL_REWARD_TX");
assert.equal(rewardResult.event.sourceCid, "QmRewardForensics");
assert.match(rewardClient.calls[1].sql, /reward_actual_pft/i);
assert.equal(rewardClient.calls[1].params[12], 4.5);
assert.equal(rewardClient.calls.length, 3);
assert.match(rewardClient.calls[2].sql, /UPDATE network_task_allocations/i);
assert.match(rewardClient.calls[2].sql, /generated_task_id/i);
assert.match(rewardClient.calls[2].sql, /task_request_id/i);
assert.equal(rewardResult.terminalMirrorSync.allocationsUpdated, 1);

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
