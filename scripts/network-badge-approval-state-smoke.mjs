import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  approvalRecordsFromNetworkBadgeProjection,
  manualBadgeApprovalRecords,
  refreshIdentityApprovalsAfterSignal,
} from "../server/repositories/identity-approvals.js";

const materialized = approvalRecordsFromNetworkBadgeProjection({
  projection: {
    catalogVersion: "network_badges_v1",
    source: "runtime_projection",
    accountId: "acct_demo",
    verifiedBadges: [
      {
        badgeId: "kol",
        evidence: {
          handle: "goodalexander",
          followersCount: 134000,
          proofMethod: "x_public_metrics",
        },
      },
      {
        badgeId: "core_contributor",
        evidence: {
          handle: "goodalexander",
          proofMethod: "github_handle_allowlist",
        },
      },
      {
        badgeId: "project_leader",
        evidence: {
          handle: "goodalexander",
          proofMethod: "backend_hive_handle_allowlist",
        },
      },
      {
        badgeId: "anon",
        evidence: {
          proofMethod: "default_unverified_public_lane",
        },
      },
    ],
  },
  verifiedByAccountId: "acct_demo",
  verifiedByOperator: "profile_network_badge_refresh",
});

assert.equal(materialized.schema, "pf.task_node.identity_approval_materialization.v1");
assert.deepEqual(materialized.badgeIds, ["kol", "core_contributor", "project_leader"]);
assert.equal(materialized.identityApprovals.length, 3);
assert.equal(materialized.accountBadges.length, 3);

const kolApproval = materialized.identityApprovals.find((approval) => approval.approvalScope === "badge:kol");
assert.equal(kolApproval.provider, "x");
assert.equal(kolApproval.approvalLevel, "L3");
assert.equal(kolApproval.publicHandle, "goodalexander");
assert.equal(kolApproval.metricsJson.followersCount, 134000);
assert.match(kolApproval.providerUserIdHash, /^sha256:/);

const coreApproval = materialized.identityApprovals.find((approval) => approval.approvalScope === "badge:core_contributor");
assert.equal(coreApproval.provider, "github");
assert.equal(coreApproval.approvalLevel, "L3");

const leaderApproval = materialized.identityApprovals.find((approval) => approval.approvalScope === "badge:project_leader");
assert.equal(leaderApproval.provider, "hive");
assert.equal(leaderApproval.approvalLevel, "L4");

const defaultBadge = materialized.accountBadges.find((badge) => badge.selectedDefault);
assert.equal(defaultBadge.badgeId, "kol");
assert.equal(materialized.accountBadges.every((badge) => badge.status === "verified"), true);
assert.equal(materialized.accountBadges.every((badge) => badge.evidenceJson.source === "runtime_projection_refresh"), true);

const manualApproval = manualBadgeApprovalRecords({
  accountId: "acct_demo",
  badgeId: "project_leader",
  publicHandle: "goodalexander",
  approvedByOperator: "nazgul",
  evidence: { reason: "allowlisted project leader" },
  selectedDefault: true,
});
assert.equal(manualApproval.identityApproval.approvalLevel, "L4");
assert.equal(manualApproval.identityApproval.provider, "hive");
assert.equal(manualApproval.accountBadge.selectedDefault, true);
assert.equal(manualApproval.accountBadge.evidenceJson.source, "operator_manual_approval");

const cliDryRun = JSON.parse(execFileSync(
  process.execPath,
  [
    "scripts/network-badge-admin.mjs",
    "approve",
    "--account-id",
    "acct_demo",
    "--badge-id",
    "project_leader",
    "--public-handle",
    "goodalexander",
    "--operator",
    "nazgul",
  ],
  { encoding: "utf8" }
));
assert.equal(cliDryRun.dryRun, true);
assert.equal(cliDryRun.plannedRecords.accountBadge.badgeId, "project_leader");

const previousDatabaseDisabled = process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_DISABLED = "true";
const skippedRefresh = await refreshIdentityApprovalsAfterSignal({
  accountId: "acct_demo",
  signal: "x_oauth_linked",
  metadata: { providerId: "x" },
});
if (previousDatabaseDisabled === undefined) {
  delete process.env.TASKNODE_DATABASE_DISABLED;
} else {
  process.env.TASKNODE_DATABASE_DISABLED = previousDatabaseDisabled;
}
assert.equal(skippedRefresh.ok, false);
assert.equal(skippedRefresh.skipped, true);
assert.equal(skippedRefresh.reason, "network_badges_database_not_configured");
assert.equal(skippedRefresh.signal, "x_oauth_linked");

console.log("network badge approval state smoke ok");
