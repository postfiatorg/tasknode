// Regression smoke: Board Manager routing duties must honor a board's
// assignable_handles constraint before asking the manager to route again.
//
// Asserts:
//   1. An engine-eligible idle pool with no allowed-handle match records a
//      clear skip and suppresses routing_due.
//   2. A matching eligible handle produces routing_due with only the
//      permitted candidate.
//
// Usage: node scripts/board-manager-routing-constraints-smoke.mjs

import assert from "node:assert/strict";
import { evaluateBoardRouting, formatDuties } from "./bm/lib.mjs";

const eligibleContributor = {
  account_id: "acct_eligible",
  badges: ["core_contributor"],
  rewarded_tasks: 3,
  free_slots: 1,
  engine_verdict: "eligible",
  routing_handles: ["someone_else"],
};
const constrainedBoard = {
  assignable_handles: ["@GoodAlexander"],
};

const emptyMatch = evaluateBoardRouting({
  boardId: "board_tasknode_fixes",
  freeSlots: 2,
  idleContributors: [eligibleContributor],
  routingConstraints: constrainedBoard,
});

assert.equal(emptyMatch.duty, null, "empty allowed-handle intersection must not emit routing_due");
assert.deepEqual(emptyMatch.skip, {
  board_id: "board_tasknode_fixes",
  reason_code: "assignable_handles_empty_eligible_pool",
  retry_suppressed: true,
  detail:
    "Routing skipped without retry: assignable_handles=[goodalexander] " +
    "has no match in the engine-eligible idle contributor handles=[someone_else].",
});
assert.match(
  formatDuties({ duties: [], routing_skips: [emptyMatch.skip] }),
  /ROUTING SKIPS \(retry suppressed: 1\).*assignable_handles_empty_eligible_pool/s,
  "operators must see why the scheduler suppressed the retry"
);

const matchingContributor = {
  ...eligibleContributor,
  account_id: "acct_goodalexander",
  routing_handles: ["GOODALEXANDER"],
};
const matchingHandle = evaluateBoardRouting({
  boardId: "board_tasknode_fixes",
  freeSlots: 2,
  idleContributors: [eligibleContributor, matchingContributor],
  routingConstraints: constrainedBoard,
});

assert.equal(matchingHandle.skip, null, "a matching handle must not be marked skipped");
assert.equal(matchingHandle.duty?.type, "routing_due", "a matching handle must permit routing");
assert.deepEqual(
  matchingHandle.duty?.candidate_account_ids,
  ["acct_goodalexander"],
  "the routing duty must expose only contributors allowed by the board"
);
assert.match(matchingHandle.duty?.detail || "", /acct_goodalexander/);
assert.doesNotMatch(matchingHandle.duty?.detail || "", /acct_eligible\[/);

console.log(
  "board manager routing constraints smoke passed: empty match suppresses retry with a reason; matching handle permits routing"
);
