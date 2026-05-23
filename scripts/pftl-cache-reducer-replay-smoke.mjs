import assert from "node:assert/strict";
import { reduceHydratedTaskEvents } from "../server/pftl-cache-reducer.js";
import { TASK_STATUS } from "../shared/task-lifecycle.js";

function hydratedEvent({
  schema,
  taskId = "task_replay_smoke",
  transition = "",
  rewardPft = "",
  ledgerIndex = 0,
  memoIndex = 0,
  txHash = "tx-smoke",
  cid = "",
} = {}) {
  const resolvedCid = cid || `cid-${schema}-${ledgerIndex}-${memoIndex}`;
  const payload = { schema, task_id: taskId };
  if (transition) payload.transition = transition;
  if (rewardPft) payload.score = { reward_pft: rewardPft };
  if (schema === "pf.reward.v1") {
    delete payload.score;
    payload.reward_pft = rewardPft;
  }
  return {
    tx_hash: txHash,
    ledger_index: ledgerIndex,
    memo_index: memoIndex,
    pointer: {
      kind: "TASK_UPDATE",
      cid: resolvedCid,
      task_id: taskId,
      memo_index: memoIndex,
      ledger_index: ledgerIndex,
    },
    payload,
  };
}

const positiveDecision = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.offer.v1", ledgerIndex: 1, memoIndex: 1 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 2 }),
  hydratedEvent({ schema: "pf.task.reward_decision.v1", rewardPft: "3.25", ledgerIndex: 3, memoIndex: 3 }),
]).projections.get("task_replay_smoke");
assert.equal(positiveDecision.status, TASK_STATUS.rewardDecided);
assert.equal(positiveDecision.reward_actual_pft, "3.25");

const deduped = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1, cid: "cid-shared" }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1, cid: "cid-shared" }),
  hydratedEvent({ schema: "pf.task.reward_decision.v1", rewardPft: "0.00", ledgerIndex: 4, memoIndex: 2 }),
]).projections.get("task_replay_smoke");
assert.equal(deduped.events.length, 2);
assert.equal(deduped.status, TASK_STATUS.rewarded);

const outOfOrder = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.reward_decision.v1", rewardPft: "0.00", ledgerIndex: 4, memoIndex: 2 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1 }),
]).projections.get("task_replay_smoke");
assert.equal(outOfOrder.status, TASK_STATUS.rewarded);

const terminalGuard = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2 }),
  hydratedEvent({ schema: "pf.task.reward_decision.v1", rewardPft: "0.00", ledgerIndex: 4 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 1, txHash: "tx-late" }),
]).projections.get("task_replay_smoke");
assert.equal(terminalGuard.status, TASK_STATUS.rewarded);

console.log("pftl cache reducer replay smoke ok");
