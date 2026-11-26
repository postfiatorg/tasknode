// Blacklisted accounts must never occupy the reward-scoring slot (2026-11-04 queue clog):
// their verification responses are parked before any scoring work, a thrown
// account_blacklisted error is parked (fixed wait) instead of retried, the claim query
// excludes active blacklist entries, and non-blacklisted tasks are unaffected.
import assert from "node:assert/strict";
import {
  BLACKLIST_PARK_RETRY,
  REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL,
  claimVerificationResponses,
  isAccountBlacklistedError,
  nextWorkerClaimState,
} from "../server/task-review-publication.js";
import { processVerificationResponse } from "../server/task-review-reward.js";

const row = { task_id: "task_blacklist_fixture", account_id: "acct_fixture", subject_wallet: "rFixture", metadata_json: {} };

// 1. Blacklisted: parked before any wallet sync or scoring, with a fixed long wait.
const parked = [];
const result = await processVerificationResponse(row, {
  logger: { info() {}, warn() {} },
  blacklistLookup: async ({ accountId, walletAddress }) => {
    assert.equal(accountId, "acct_fixture");
    assert.equal(walletAddress, "rFixture");
    return { id: "bl_1", reason_code: "value_accountability_deadline_missed" };
  },
  parkClaim: async (args) => { parked.push(args); return {}; },
});
assert.deepEqual(result, { ok: true, taskId: row.task_id, skipped: true, reason: "account_blacklisted_parked" });
assert.equal(parked.length, 1);
assert.equal(parked[0].workerName, "reward_scoring");
assert.equal(parked[0].retryMode, "fixed");
assert.equal(parked[0].retryDelayMs, 6 * 60 * 60 * 1000);
assert.match(parked[0].error, /^account_blacklisted:reward: value_accountability_deadline_missed$/);

// 2. Not blacklisted: the guard does not park; processing continues past it
// (in this fixture environment it then stops at a later prerequisite, never at the blacklist).
const parkedB = [];
await assert.rejects(
  processVerificationResponse(row, {
    logger: { info() {}, warn() {} },
    blacklistLookup: async () => null,
    parkClaim: async (args) => { parkedB.push(args); },
  }),
  (error) => !isAccountBlacklistedError(error),
);
assert.equal(parkedB.length, 0, "a non-blacklisted task must not be parked");

// 3. A thrown account_blacklisted error is recognised (worker parks, never exponential retry).
assert.equal(isAccountBlacklistedError(Object.assign(new Error("x"), { code: "account_blacklisted" })), true);
assert.equal(isAccountBlacklistedError(new Error("account_blacklisted:reward: value_accountability_deadline_missed")), true);
assert.equal(isAccountBlacklistedError(new Error("task_scoring_missing_required_events")), false);
assert.equal(isAccountBlacklistedError(null), false);

// 4. Parking is a fixed wait: no exponential streak growth, retry_after ~6h out.
const now = Date.parse("2026-11-04T17:30:00Z");
const state = nextWorkerClaimState({ retry_count: 4 }, { ...BLACKLIST_PARK_RETRY, nowMs: now });
assert.equal(state.retry_count, 0);
assert.equal(state.retry_after, new Date(now + 6 * 60 * 60 * 1000).toISOString());

// 5. The reward claim query excludes active blacklist entries by account and wallet.
assert.match(REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL, /FROM account_blacklist bl/);
assert.match(REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL, /bl\.status = 'active'/);
assert.match(REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL, /bl\.account_id = task_projections\.account_id/);
assert.match(REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL, /task_projections\.subject_wallet = ANY\(bl\.wallet_addresses\)/);
assert.ok(claimVerificationResponses.toString().includes("REWARD_CLAIM_BLACKLIST_EXCLUSION_SQL"),
  "claimVerificationResponses must apply the blacklist exclusion");

console.log(JSON.stringify({ ok: true, blacklistedParkedBeforeScoring: true, nonBlacklistedUnaffected: true,
  thrownBlacklistNotRetried: true, parkIsFixedWait: true, claimExcludesBlacklisted: true }));
