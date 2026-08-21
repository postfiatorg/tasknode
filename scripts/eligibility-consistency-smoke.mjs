// Regression smoke: the routing pool and the task-creation engine must
// agree on candidate eligibility (defect: duty work orders listed accounts
// that task creation refused with a bare 422).
//
// Asserts:
//   1. Every member of idleEligibleContributors() passes the shared
//      eligibility predicate the creation engine uses, with a resolvable
//      delivery wallet.
//   2. An account with no verified badge is refused with the named reason
//      `no_verified_badge` (explained rejection, not a bare 422).
//
// Usage: DATABASE_URL=... node scripts/eligibility-consistency-smoke.mjs

import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const { idleEligibleContributors } = await import("./bm/lib.mjs");
const { explainNetworkTaskCandidateEligibility } = await import(
  "../server/repositories/network-tasks.js"
);
const { closePool } = await import("../server/db/pool.js");

try {
  const pool = await idleEligibleContributors();
  assert.ok(pool.length > 0, "expected a non-empty routing pool for a meaningful check");
  let checked = 0;
  for (const member of pool) {
    const verdict = await explainNetworkTaskCandidateEligibility({ accountId: member.account_id });
    assert.equal(
      verdict.eligible,
      true,
      `pool/engine divergence: ${member.account_id} listed as routable but engine refuses with '${verdict.reason}'`
    );
    assert.ok(verdict.walletAddress, `eligible member ${member.account_id} has no delivery wallet`);
    checked += 1;
  }

  const refusal = await explainNetworkTaskCandidateEligibility({ accountId: "acct_nonexistent_smoke" });
  assert.equal(refusal.eligible, false);
  assert.equal(refusal.reason, "no_verified_badge", "refusals must carry a named reason");

  const unresolved = await explainNetworkTaskCandidateEligibility({ accountId: "" });
  assert.equal(unresolved.reason, "account_unresolved");

  console.log(
    `eligibility consistency smoke passed: ${checked} pool members all engine-eligible with delivery wallets; refusal reasons named`
  );
} finally {
  await closePool();
}
