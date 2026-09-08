// Regression: a runtime badge refresh must not reset the account's selected default badge.
// Keyless: no Postgres. The runtime store backs the identity profile; the refresh transaction
// runs against an in-process fake pg client that records every statement and applies the
// ON CONFLICT clause literally, so the durable outcome is exactly what the SQL says it is.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.TASKNODE_PROJECT_LEADER_HIVE_HANDLES = "jollydinger";
process.env.TASKNODE_STORE_PATH = join(mkdtempSync(join(tmpdir(), "tasknode-badge-default-")), "store.json");


const { getAccount, getOrCreateProviderAccount, setAccountHiveHandle } = await import("../server/runtime-store.js");
const { networkBadgeProjectionForAccount } = await import("../server/repositories/network-badges.js");
const {
  approvalRecordsFromNetworkBadgeProjection,
  refreshIdentityApprovalsFromProjection,
} = await import("../server/repositories/identity-approvals.js");

// Account shaped like the reported case: X >= 5000 followers (kol) + hive handle on the
// Project Leader allowlist, and the user has picked project_leader as the default lane.
const account = getOrCreateProviderAccount({
  provider: "x",
  providerUserId: "badge-default-x",
  username: "jollydinger",
  displayName: "Jolly",
  profileUrl: "https://x.com/jollydinger",
  metadata: { publicMetrics: { followersCount: 12000 } },
});
const handleResult = setAccountHiveHandle({ accountId: account.id, handle: "jollydinger" });
assert.equal(handleResult.ok, true, JSON.stringify(handleResult));

const projection = await networkBadgeProjectionForAccount({
  accountId: account.id,
  walletAddress: "rJolly",
  preferDurable: false,
});
assert.deepEqual(projection.verifiedBadgeIds, ["kol", "project_leader"], "both badges must project");

// 1. End to end: the real refreshIdentityApprovalsFromProjection against a recording fake pg client.
const durableBadges = new Map([
  ["kol", { selected_default: false, source: "runtime_projection_refresh" }],
  ["project_leader", { selected_default: true, source: "runtime_projection_refresh" }],
]);
const statements = [];
function fakeQuery(text, params = []) {
  const sql = String(text);
  statements.push({ sql, params });
  if (/FROM app_accounts/.test(sql)) {
    return { rows: [{ account_json: getAccount(params[0]) }] };
  }
  if (/SELECT badge_id\s+FROM account_network_badges/.test(sql) && /selected_default = true/.test(sql)) {
    const rows = [...durableBadges.entries()]
      .filter(([badgeId, row]) => row.selected_default && (
        (Array.isArray(params[1]) && params[1].includes(badgeId)) || row.source !== "runtime_projection_refresh"
      ))
      .map(([badgeId]) => ({ badge_id: badgeId }));
    return { rows: rows.slice(0, 1) };
  }
  if (/INSERT INTO account_network_badges/.test(sql)) {
    const badgeId = params[2];
    const excluded = params[4] === true;
    const existing = durableBadges.get(badgeId);
    if (!existing) {
      durableBadges.set(badgeId, { selected_default: excluded, source: "runtime_projection_refresh" });
    } else if (/selected_default = EXCLUDED\.selected_default OR account_network_badges\.selected_default/.test(sql)) {
      existing.selected_default = excluded || existing.selected_default;
    } else if (/selected_default = EXCLUDED\.selected_default/.test(sql)) {
      existing.selected_default = excluded;
    }
    return { rows: [] };
  }
  return { rows: [] };
}
const fakeClient = { query: async (text, params) => fakeQuery(text, params), release() {} };
pg.Pool.prototype.connect = async () => fakeClient;
pg.Pool.prototype.query = async (text, params) => fakeQuery(text, params);

process.env.DATABASE_URL = "postgres://keyless.invalid/tasknode";
process.env.TASKNODE_DATABASE_ENABLED = "true";
const refresh = await refreshIdentityApprovalsFromProjection({
  accountId: account.id,
  walletAddress: "rJolly",
  verifiedByAccountId: account.id,
  verifiedByOperator: "profile_network_badge_refresh",
});
process.env.TASKNODE_DATABASE_ENABLED = "false";
delete process.env.DATABASE_URL;

assert.equal(refresh.ok, true);
assert.deepEqual(refresh.materialized.badgeIds, ["kol", "project_leader"]);
const upserts = statements.filter((statement) => /INSERT INTO account_network_badges/.test(statement.sql));
assert.equal(upserts.length, 2, "one upsert per materialized badge");
const durableDefaults = Object.fromEntries([...durableBadges.entries()].map(([badgeId, row]) => [badgeId, row.selected_default]));
assert.deepEqual(
  durableDefaults,
  { kol: false, project_leader: true },
  `refresh must not flip the durable default back to kol; got ${JSON.stringify(durableDefaults)}`
);
assert.equal(Object.values(durableDefaults).filter(Boolean).length, 1, "exactly one selected_default after refresh");

// 2. Materialization carries the account's stored selection instead of the push order.
const preserved = approvalRecordsFromNetworkBadgeProjection({
  projection,
  selectedDefaultBadgeId: "project_leader",
});
const preservedDefaults = Object.fromEntries(preserved.accountBadges.map((badge) => [badge.badgeId, badge.selectedDefault]));
assert.deepEqual(
  preservedDefaults,
  { kol: false, project_leader: true },
  `materialization must keep project_leader as the selected default; got ${JSON.stringify(preservedDefaults)}`
);

// 3. First-ever materialization: when kol is skipped for lacking a handle, the first badge
//    that actually materialized is the default (not "none", not a positional ghost).
const skippedKol = approvalRecordsFromNetworkBadgeProjection({
  projection: {
    catalogVersion: "network_badges_v1",
    source: "runtime_projection",
    accountId: "acct_metric_only_kol",
    verifiedBadges: [
      { badgeId: "kol", evidence: { followersCount: 9000, proofMethod: "x_public_metrics" } },
      { badgeId: "project_leader", evidence: { handle: "jollydinger", proofMethod: "backend_hive_handle_allowlist" } },
    ],
  },
});
assert.deepEqual(skippedKol.badgeIds, ["project_leader"]);
assert.equal(
  skippedKol.accountBadges.filter((badge) => badge.selectedDefault).length,
  1,
  "exactly one materialized badge must be selected_default when the first projected badge was skipped"
);
assert.equal(skippedKol.accountBadges[0].selectedDefault, true);

// 4. A stored selection that is not part of this projection (an operator-approved badge)
//    is left alone: no materialized badge claims the default.
const manualDefaultElsewhere = approvalRecordsFromNetworkBadgeProjection({
  projection,
  selectedDefaultBadgeId: "core_contributor",
});
assert.equal(manualDefaultElsewhere.accountBadges.some((badge) => badge.selectedDefault), false);

console.log("network badge default preserved smoke ok");
