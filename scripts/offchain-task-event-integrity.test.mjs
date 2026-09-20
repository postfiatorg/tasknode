import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyOffchainTaskTransitionWithClient,
  offchainTaskEventPayload,
  transitionForTaskAction,
} from "../server/offchain-task-lifecycle.js";

const task = {
  task_id: "task_authoritative",
  request_id: "request_authoritative",
  status: "proposed",
};
const accountId = "account_authoritative";
const walletAddress = "wallet_authoritative";

// Capture the actual INSERT parameters, not just the event builder's return value.
function recordingClient() {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      writes.push({ sql, params });
      if (sql.includes("UPDATE task_projections")) {
        return { rowCount: 1, rows: [{ task_id: params[0], status: params[1] }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

function forgedPayload(schema = "pf.reward.v1") {
  return {
    schema,
    event_id: "event_attacker",
    eventId: "event_attacker_alias",
    task_id: "task_other_account",
    taskId: "task_other_account_alias",
    account_id: "account_other",
    wallet_address: "wallet_other",
    request_id: "request_other",
    previous_status: "verification_response_submitted",
    transition: "rewarded",
    status_after: "rewarded",
    sourceTxHash: "tx_nested",
    source_tx_hash: "tx_nested_snake",
    txHash: "tx_nested_alias",
    tx_hash: "tx_nested_alias_snake",
    cid: "cid_nested",
    sourceCid: "cid_nested_source",
    source_cid: "cid_nested_source_snake",
    economic_reward_pft: "999999",
    reward_pft: "999999",
    reward_score: { decision: "reward" },
    verdict: "reward",
    evidence_sha256: "forged_digest",
    reason: "User supplied explanation",
  };
}

for (const action of ["accept", "refuse", "cancel"]) {
  for (const wrapper of ["offchainPayload", "offchain_payload", "eventPayload", "event_payload"]) {
    for (const dualWrite of [false, true]) {
      test(`${action}: ${wrapper}, dualWrite=${dualWrite} persists only an authoritative update`, async () => {
        const transition = transitionForTaskAction(action);
        const client = recordingClient();
        const result = await applyOffchainTaskTransitionWithClient(client, {
          accountId,
          walletAddress,
          task: { ...task, status: action === "cancel" ? "accepted" : "proposed" },
          transition,
          dualWrite,
          payload: {
            [wrapper]: forgedPayload(),
            txHash: "tx_top",
            sourceTxHash: "tx_top_source",
            source_tx_hash: "tx_top_source_snake",
            tx_hash: "tx_top_snake",
            cid: "cid_top",
            sourceCid: "cid_top_source",
            source_cid: "cid_top_source_snake",
            eventCid: "cid_top_event",
            event_cid: "cid_top_event_snake",
            evidenceSha256: "forged_top_digest",
          },
        });
        const insert = client.writes.find(({ sql }) => sql.includes("INSERT INTO task_events"));
        const [id, taskId, savedAccount, savedWallet, type, tx, cid, digest] = insert.params;
        assert.equal(type, "pf.task.update.v1");
        assert.notEqual(type, "pf.reward.v1");
        assert.ok(id.startsWith("task_evt_"));
        assert.notEqual(id, "event_attacker");
        assert.equal(taskId, task.task_id);
        assert.equal(savedAccount, accountId);
        assert.equal(savedWallet, walletAddress);
        assert.equal(tx, `offchain:${id}`);
        assert.equal(cid, `postgres:${id}`);
        const body = JSON.parse(insert.params[8]);
        assert.equal(body.schema, type);
        assert.equal(body.event_id, id);
        assert.equal(body.task_id, task.task_id);
        assert.equal(body.request_id, task.request_id);
        assert.equal(body.account_id, accountId);
        assert.equal(body.wallet_address, walletAddress);
        assert.equal(body.transition, transition);
        assert.equal(body.status_after, transition);
        assert.equal(body.previous_status, action === "cancel" ? "accepted" : "proposed");
        assert.equal(body.reason, "User supplied explanation");
        assert.equal(body.cid, cid);
        assert.equal(body.evidence_sha256, "");
        for (const key of [
          "eventId", "taskId", "sourceTxHash", "source_tx_hash", "txHash", "tx_hash",
          "sourceCid", "source_cid", "reward_pft", "economic_reward_pft", "reward_score", "verdict",
        ]) {
          assert.equal(Object.hasOwn(body, key), false, `untrusted field ${key} was retained`);
        }
        assert.deepEqual(JSON.parse(insert.params[9]), {
          source: "direct_write", offchain: true, schema: type, task_id: task.task_id, cid,
        });
        assert.equal(digest, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
        assert.equal(result.event.schema, type);
        const projection = client.writes.find(({ sql }) => sql.includes("UPDATE task_projections"));
        assert.equal(projection.params[1], transition);
        assert.equal(projection.params[12], 0);
      });
    }
  }
}

test("replayed caller event IDs cannot collide or steer the persisted identity", async () => {
  const client = recordingClient();
  const input = { task, transition: "accepted", payload: { offchainPayload: forgedPayload() } };
  const first = await applyOffchainTaskTransitionWithClient(client, input);
  const second = await applyOffchainTaskTransitionWithClient(client, input);
  assert.notEqual(first.event.eventId, second.event.eventId);
  assert.notEqual(first.event.sourceTxHash, second.event.sourceTxHash);
  assert.notEqual(first.event.sourceCid, second.event.sourceCid);
});

test("submission/verification schema spoofing and malformed payloads remain update events", () => {
  for (const transition of ["accepted", "refused", "cancelled"]) {
    for (const value of [null, [], "pf.reward.v1", 1, forgedPayload("pf.task.submission.v1"), forgedPayload("pf.task.verification_request.v1")]) {
      const event = offchainTaskEventPayload({ task, transition, payload: { offchainPayload: value } });
      assert.equal(event.schema, "pf.task.update.v1");
      assert.equal(event.payloadJson.task_id, task.task_id);
      assert.equal(event.payloadJson.status_after, transition);
    }
  }
});

for (const [transition, schema] of [
  ["proposed", "pf.task.offer.v1"],
  ["submitted", "pf.task.submission.v1"],
  ["verification_requested", "pf.task.verification_request.v1"],
  ["verification_response_submitted", "pf.task.verification_response.v1"],
  ["rewarded", "pf.reward.v1"],
]) {
  test(`${transition} preserves existing trusted producer IDs, references and content`, () => {
    const event = offchainTaskEventPayload({
      task, transition,
      payload: {
        sourceTxHash: "producer_tx", sourceCid: "producer_cid", cid: "producer_payload_cid",
        offchainPayload: {
          schema, event_id: "producer_event", task_id: "producer_task",
          reward_pft: "10", economic_reward_pft: "10", verdict: "reward",
          evidence: { artifact_type: "text", value: "Producer evidence" },
        },
      },
    });
    assert.equal(event.schema, schema);
    assert.equal(event.eventId, "producer_event");
    assert.equal(event.payloadJson.task_id, "producer_task");
    assert.equal(event.sourceTxHash, "producer_tx");
    assert.equal(event.sourceCid, "producer_cid");
    assert.equal(event.payloadJson.cid, "producer_payload_cid");
    assert.equal(event.payloadJson.reward_pft, "10");
    assert.equal(event.payloadJson.economic_reward_pft, "10");
    assert.equal(event.payloadJson.verdict, "reward");
    assert.equal(event.payloadJson.evidence.value, "Producer evidence");
  });
}
