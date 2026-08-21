import assert from "node:assert/strict";
import {
  reduceHydratedTaskEvents,
  shouldSkipTaskPointerReducerEvent,
} from "../server/pftl-cache-reducer.js";
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
      kind: schema === "pf.reward.v1" ? "REWARD" : "TASK_UPDATE",
      cid: resolvedCid,
      task_id: taskId,
      memo_index: memoIndex,
      ledger_index: ledgerIndex,
    },
    payload,
  };
}

const positiveRewardOutcome = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.offer.v1", ledgerIndex: 1, memoIndex: 1 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 2 }),
  hydratedEvent({ schema: "pf.reward.v1", rewardPft: "3.25", ledgerIndex: 3, memoIndex: 3 }),
]).projections.get("task_replay_smoke");
assert.equal(positiveRewardOutcome.status, TASK_STATUS.rewarded);
assert.equal(positiveRewardOutcome.reward_actual_pft, "3.25");

const deduped = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1, cid: "cid-shared" }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1, cid: "cid-shared" }),
  hydratedEvent({ schema: "pf.reward.v1", rewardPft: "0.00", ledgerIndex: 4, memoIndex: 2 }),
]).projections.get("task_replay_smoke");
assert.equal(deduped.events.length, 2);
assert.equal(deduped.status, TASK_STATUS.rewarded);

const outOfOrder = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.reward.v1", rewardPft: "0.00", ledgerIndex: 4, memoIndex: 2 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2, memoIndex: 1 }),
]).projections.get("task_replay_smoke");
assert.equal(outOfOrder.status, TASK_STATUS.rewarded);

const terminalGuard = reduceHydratedTaskEvents([
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 2 }),
  hydratedEvent({ schema: "pf.reward.v1", rewardPft: "0.00", ledgerIndex: 4 }),
  hydratedEvent({ schema: "pf.task.update.v1", transition: "accepted", ledgerIndex: 5, txHash: "tx-late" }),
]).projections.get("task_replay_smoke");
assert.equal(terminalGuard.status, TASK_STATUS.rewarded);

assert.equal(
  shouldSkipTaskPointerReducerEvent(
    { reducer_kind: "task_projection_replay", pointer_kind: "TASK_UPDATE", task_id: "task_replay_smoke" },
    { TASKNODE_TASK_POINTER_REDUCER_ENABLED: "false" }
  ),
  true,
  "retired task pointer reducer must skip lifecycle update replay rows"
);
assert.equal(
  shouldSkipTaskPointerReducerEvent(
    { reducer_kind: "task_projection_replay", pointer_kind: "REWARD", task_id: "task_replay_smoke" },
    { TASKNODE_TASK_POINTER_REDUCER_ENABLED: "false" }
  ),
  false,
  "retired task pointer reducer must keep reward replay rows for reward forensics"
);
assert.equal(
  shouldSkipTaskPointerReducerEvent(
    { reducer_kind: "task_projection_replay", pointer_kind: "TASK_SUBMISSION", task_id: "task_replay_smoke" },
    {}
  ),
  false,
  "task pointer reducer remains enabled by default unless explicitly disabled"
);

console.log("pftl cache reducer replay smoke ok");
