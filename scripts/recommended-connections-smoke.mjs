import assert from "node:assert/strict";
import {
  deterministicRecommendedConnections,
  parseRecommendedConnectionsJson,
  recommendedConnectionIdentityFromParts,
  shouldIndexRecommendedConnectionProfile,
} from "../server/repositories/recommended-connections.js";

const candidates = [
  {
    accountId: "acct_alpha",
    displayName: "Alpha Builder",
    roleTitle: "Protocol QA",
    currentFocus: ["wallet unlock testing"],
    primaryContribution: ["finds reproducible product failures"],
    skills: ["QA"],
    currentTasks: [{ title: "Test wallet unlock" }],
    similarity: 0.91,
  },
  {
    accountId: "acct_beta",
    displayName: "Beta Operator",
    roleTitle: "Task Node Product",
    currentFocus: ["recommended connections"],
    primaryContribution: ["ships profile surfaces"],
    skills: ["React"],
    currentTasks: [{ title: "Fix private profile page" }],
    similarity: 0.88,
  },
];

assert.equal(
  shouldIndexRecommendedConnectionProfile({ visibility: "private", discoverable: true }),
  false,
  "private profiles must be excluded before vector indexing"
);
assert.equal(
  shouldIndexRecommendedConnectionProfile({ visibility: "public", discoverable: false }),
  false,
  "non-discoverable profiles must be excluded before vector indexing"
);
assert.equal(
  shouldIndexRecommendedConnectionProfile({ visibility: "public", discoverable: true }),
  true,
  "public discoverable profiles can enter vector indexing"
);

const identityWithoutWallet = recommendedConnectionIdentityFromParts({
  accountId: "acct_profile_only",
  networkProfile: {
    output: {
      profile_title: "Protocol QA Operator",
    },
  },
});
assert.equal(identityWithoutWallet.walletAddress, "", "wallet address should be optional recommendation metadata");
assert.equal(
  identityWithoutWallet.displayName,
  "Protocol QA Operator",
  "profile-only accounts should still get a usable display name from the Network Diagnostic"
);

const parsed = parseRecommendedConnectionsJson(JSON.stringify({
  recommendations: [
    {
      candidate_account_id: "acct_alpha",
      rank: 1,
      reason: "They are testing the same wallet surface and can compare failures.",
      suggested_first_action: "Ask them to review one fresh-install unlock trace.",
      shared_context: "Wallet unlock testing.",
      complementary_value: "Reproducible QA judgment.",
      risk_or_uncertainty: "Scope may overlap.",
      supporting_signals: ["wallet unlock testing", "Protocol QA"],
      score: 0.9,
    },
    {
      candidate_account_id: "acct_not_in_candidates",
      rank: 2,
      reason: "Should be rejected.",
      suggested_first_action: "Should be rejected.",
      supporting_signals: ["unknown"],
      score: 1,
    },
  ],
}), candidates);

assert.deepEqual(
  parsed.map((entry) => entry.candidateAccountId),
  ["acct_alpha"],
  "rerank parsing must reject account ids outside the top candidate set"
);

const fallback = deterministicRecommendedConnections({ candidates });
assert.equal(fallback.length, 2, "deterministic fallback should return available candidates");
assert.ok(fallback.every((entry) => entry.reason && entry.suggestedFirstAction), "fallback recommendations need visible copy");

console.log("recommended-connections-smoke ok");
