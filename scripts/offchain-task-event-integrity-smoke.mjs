// Negative test: a session user who owns a *proposed* task calls
// POST /api/tasks/action {phase:"submit", taskAction:"accept", offchainPayload:{...}}.
// In production offchain mode (fly.toml: TASKNODE_OFFCHAIN_TASK_LIFECYCLE=true,
// TASKNODE_OFFCHAIN_TASK_LIFECYCLE_DUAL_WRITE=false; no transition-signature
// requirement) task-actions.js -> applyOffchainTaskTransition(payload) with the
// validated request body. The taskBody contract (server/request-body-contracts.js)
// allows offchainPayload:opaqueObject plus txHash/cid, and
// server/offchain-task-lifecycle.js copies them straight into the persisted
// task_events row: the event_type, event id, source_tx_hash, source_cid and
// payload.task_id are all client-controllable for accept/refuse/cancel, which are
// NOT in eventSchemaForTransition's fixed list.
//
// Expectation (server-authoritative): for a stop transition the persisted row is a
// server-typed pf.task.update.v1 event whose id and source refs are server-derived
// and whose task_id is the authoritative task; no client-chosen economic reward.
//
// Keyless: TASKNODE_DATABASE_ENABLED=false and a mocked pg client. Drives the real
// offchainTaskEventPayload / applyOffchainTaskTransitionWithClient. Runs the three
// CONTRIBUTING-required negative classes (forged reward, forged submission event,
// PK collision). FAILS on the unmodified tree; with the guard applied and
// GUARD_APPLIED=1 (which gates the red-only exploit characterization) it PASSES.
process.env.TASKNODE_DATABASE_ENABLED = "false";

import assert from "node:assert/strict";
import {
  applyOffchainTaskTransitionWithClient,
  offchainTaskEventPayload,
} from "../server/offchain-task-lifecycle.js";

const GUARDED = ["1", "true", "yes", "on"].includes(
  String(process.env.GUARD_APPLIED || "").trim().toLowerCase()
);

// Mocked pg client: captures every query + params, reports the projection moved.
function mockClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/UPDATE task_projections/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ task_id: params[0], status: params[1], event_count: 2, terminal_preserved: false }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}
function insertRow(client) {
  return client.calls.find((call) => /INSERT INTO task_events/i.test(call.sql));
}

const failures = [];
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// Negative case 1 - forged reward via an `accept` stop action.
// Exactly what task-actions.js passes: the validated request body. offchainPayload
// carries a pf.reward.v1 schema, a client-chosen event id, a foreign task_id, a
// forged on-chain tx hash / cid and a fabricated economic_reward_pft.
// ---------------------------------------------------------------------------
const attackerBody = {
  phase: "submit",
  taskAction: "accept",
  taskId: "task_victim_owned_by_attacker",
  txHash: "DEADBEEF00000000000000000000000000000000000000000000000000000001",
  cid: "bafyforgedcid",
  offchainPayload: {
    schema: "pf.reward.v1",
    event_id: "task_evt_attacker_chosen",
    task_id: "task_someone_elses",
    economic_reward_pft: 5000,
    reward_pft: 5000,
    verdict: "rewarded",
    source_tx_hash: "FORGED_SOURCE_TX",
    source_cid: "QmForgedForensics",
  },
};
const serverTask = { task_id: "task_victim_owned_by_attacker", request_id: "req_1", status: "proposed" };

const acceptEvent = offchainTaskEventPayload({
  accountId: "acct_attacker",
  walletAddress: "rAttacker",
  task: serverTask,
  transition: "accepted",
  payload: attackerBody,
  metadata: { action: "accept", endpoint: "POST /api/tasks/action" },
});

// Red-only characterization: on the unmodified tree, assert the exploit is real so
// the report has a proven pre-guard baseline. Skipped once GUARD_APPLIED=1.
if (!GUARDED) {
  const exploit = [];
  const seen = (label, fn) => {
    try {
      fn();
    } catch (error) {
      exploit.push(`${label}: ${error.message}`);
    }
  };
  seen("event_type is attacker-chosen pf.reward.v1", () =>
    assert.equal(acceptEvent.schema, "pf.reward.v1"));
  seen("event id is attacker-chosen", () =>
    assert.equal(acceptEvent.eventId, "task_evt_attacker_chosen"));
  seen("source_tx_hash is the attacker's forged hash", () =>
    assert.equal(acceptEvent.sourceTxHash, attackerBody.txHash));
  seen("payload.task_id is a foreign task", () =>
    assert.equal(acceptEvent.payloadJson.task_id, "task_someone_elses"));
  seen("economic_reward_pft is attacker-chosen", () =>
    assert.equal(acceptEvent.payloadJson.economic_reward_pft, 5000));
  if (exploit.length) {
    console.error(`characterization mismatch (${exploit.length}):\n- ${exploit.join("\n- ")}`);
  } else {
    console.log(
      "[characterization] pre-guard exploit reproduced: accept emits",
      `${acceptEvent.schema} id=${acceptEvent.eventId} tx=${acceptEvent.sourceTxHash}`,
      `task_id=${acceptEvent.payloadJson.task_id} economic_reward_pft=${acceptEvent.payloadJson.economic_reward_pft}`
    );
  }
}

// Server-authoritative expectations (fail red, pass green) - payload builder.
check("accept event_type must be server-derived pf.task.update.v1", () =>
  assert.equal(acceptEvent.schema, "pf.task.update.v1"));
check("accept event id must be server-generated, not client-chosen", () => {
  assert.notEqual(acceptEvent.eventId, "task_evt_attacker_chosen");
  assert.match(acceptEvent.eventId, /^task_evt_/);
});
check("accept source_tx_hash must be server ref offchain:<eventId>", () => {
  assert.equal(acceptEvent.sourceTxHash, `offchain:${acceptEvent.eventId}`);
  assert.notEqual(acceptEvent.sourceTxHash, attackerBody.txHash);
  assert.notEqual(acceptEvent.sourceTxHash, "FORGED_SOURCE_TX");
});
check("accept source_cid must be server ref postgres:<eventId>", () => {
  assert.equal(acceptEvent.sourceCid, `postgres:${acceptEvent.eventId}`);
  assert.notEqual(acceptEvent.sourceCid, attackerBody.cid);
  assert.notEqual(acceptEvent.sourceCid, "QmForgedForensics");
});
check("accept payload.task_id must be the authoritative task", () =>
  assert.equal(acceptEvent.payloadJson.task_id, serverTask.task_id));
check("accept pointer.task_id must be the authoritative task", () =>
  assert.equal(acceptEvent.pointerJson.task_id, serverTask.task_id));
check("accept must not carry a client economic reward", () => {
  assert.equal(acceptEvent.payloadJson.economic_reward_pft, undefined);
  assert.equal(acceptEvent.payloadJson.reward_pft, undefined);
});

// Same through the DB write path with a mocked pg client - the *persisted* row.
const acceptClient = mockClient();
const acceptResult = await applyOffchainTaskTransitionWithClient(acceptClient, {
  accountId: "acct_attacker",
  walletAddress: "rAttacker",
  task: serverTask,
  transition: "accepted",
  payload: attackerBody,
  metadata: { action: "accept", endpoint: "POST /api/tasks/action" },
});
const acceptInsert = insertRow(acceptClient);
check("persisted task_events.event_type for accept must be pf.task.update.v1", () =>
  assert.equal(acceptInsert.params[4], "pf.task.update.v1"));
check("persisted task_events.id must not be client-chosen", () =>
  assert.notEqual(acceptInsert.params[0], "task_evt_attacker_chosen"));
check("persisted source_tx_hash must not be client-chosen", () => {
  assert.notEqual(acceptInsert.params[5], attackerBody.txHash);
  assert.notEqual(acceptInsert.params[5], "FORGED_SOURCE_TX");
});
check("persisted source_cid must not be client-chosen", () => {
  assert.notEqual(acceptInsert.params[6], attackerBody.cid);
  assert.notEqual(acceptInsert.params[6], "QmForgedForensics");
});
check("persisted payload_json.task_id must be the authoritative task", () =>
  assert.equal(JSON.parse(acceptInsert.params[8]).task_id, serverTask.task_id));
check("persisted payload_json.economic_reward_pft must not be client-chosen", () =>
  assert.equal(JSON.parse(acceptInsert.params[8]).economic_reward_pft, undefined));
check("projection still transitioned to accepted (forged row is silently persisted, not rejected, pre-guard)", () =>
  assert.equal(acceptResult.transition, "accepted"));

// ---------------------------------------------------------------------------
// Negative case 2 - forged submission event via a `cancel` stop action.
// Attacker tries to mint a pf.task.submission.v1 row (which board-task-detail.js
// and network-task-status.js treat as real submitted work) off a cancel.
// ---------------------------------------------------------------------------
const cancelBody = {
  phase: "submit",
  taskAction: "cancel",
  taskId: "task_cancel_target",
  offchainPayload: {
    schema: "pf.task.submission.v1",
    event_id: "task_evt_forged_submission",
    task_id: "task_cancel_target",
    evidence: { artifact_type: "text", value: "fabricated submission" },
  },
};
const cancelTask = { task_id: "task_cancel_target", request_id: "req_2", status: "accepted" };
const cancelClient = mockClient();
await applyOffchainTaskTransitionWithClient(cancelClient, {
  accountId: "acct_attacker",
  walletAddress: "rAttacker",
  task: cancelTask,
  transition: "cancelled",
  payload: cancelBody,
  metadata: { action: "cancel", endpoint: "POST /api/tasks/action" },
});
const cancelInsert = insertRow(cancelClient);
check("cancel must not emit a client-chosen pf.task.submission.v1 event_type", () =>
  assert.equal(cancelInsert.params[4], "pf.task.update.v1"));
check("cancel event id must not be client-chosen", () =>
  assert.notEqual(cancelInsert.params[0], "task_evt_forged_submission"));

// ---------------------------------------------------------------------------
// Negative case 3 - primary-key collision / steering.
// task_events.id is the PRIMARY KEY (006_task_projections.sql). A client-chosen id
// lets an attacker force a duplicate PK (txn aborts -> 500) or pin a known key.
// The server must generate its own id every time, so two attacker calls that both
// try to pin the same id still get distinct server ids.
// ---------------------------------------------------------------------------
const collide = (n) =>
  offchainTaskEventPayload({
    accountId: "acct_attacker",
    walletAddress: "rAttacker",
    task: { task_id: `task_collide_${n}`, request_id: "req_3", status: "proposed" },
    transition: "refused",
    payload: {
      taskAction: "refuse",
      offchainPayload: { event_id: "task_evt_pinned_pk", task_id: `task_collide_${n}`, schema: "pf.reward.v1" },
    },
    metadata: { action: "refuse" },
  });
const collideA = collide("a");
const collideB = collide("b");
check("refuse event_type must be server-derived, not the client's pf.reward.v1", () =>
  assert.equal(collideA.schema, "pf.task.update.v1"));
check("client cannot pin the task_events primary key (A)", () =>
  assert.notEqual(collideA.eventId, "task_evt_pinned_pk"));
check("client cannot pin the task_events primary key (B)", () =>
  assert.notEqual(collideB.eventId, "task_evt_pinned_pk"));
check("two attacker calls get distinct server-generated ids (no forced collision)", () =>
  assert.notEqual(collideA.eventId, collideB.eventId));

if (failures.length) {
  console.error(`FAIL (${failures.length} assertions):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("offchain task event integrity smoke ok");
