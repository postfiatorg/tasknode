import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES = "goodalexander";
process.env.TASKNODE_STORE_PATH = join(mkdtempSync(join(tmpdir(), "tasknode-badge-profile-")), "store.json");

const { getOrCreateProviderAccount } = await import("../server/runtime-store.js");
const { publicNetworkBadgesForAccount } = await import("../server/repositories/network-badges.js");
const { publicProfileFromParts } = await import("../server/repositories/profile-public.js");

const account = getOrCreateProviderAccount({
  provider: "github",
  providerUserId: "badge-profile-gh",
  username: "goodalexander",
  displayName: "Good Alexander",
  profileUrl: "https://github.com/goodalexander",
  metadata: {
    proofIntent: "core_contributor",
    coreContributorAccess: {
      sanctioned: true,
      scopeRecorded: true,
      username: "goodalexander",
      matchedHandle: "goodalexander",
      proofMethod: "github_handle_allowlist",
      oauthScope: "user:email",
    },
  },
});

const publicBadgeState = await publicNetworkBadgesForAccount({
  accountId: account.id,
  walletAddress: "rBadgeProfileSmoke",
});

assert.equal(publicBadgeState.schema, "pf.task_node.public_network_badges.v1");
assert.equal(publicBadgeState.badges[0]?.badgeId, "core_contributor");
assert.equal(publicBadgeState.badges[0]?.label, "Core Contributor");
assert.equal(publicBadgeState.badges[0]?.symbolKey, "git_pull_request");
assert.equal(publicBadgeState.badges[0]?.maxPayoutPft, 30000);
assert.equal(publicBadgeState.badges[0]?.evidence, undefined);

const profile = publicProfileFromParts({
  accountId: account.id,
  input: {
    account_id: account.id,
    identity: {
      primary_wallet: "rBadgeProfileSmoke",
      active_wallet: "rBadgeProfileSmoke",
      wallet_count: 1,
    },
    reward_totals: {},
    contribution_tier: {},
  },
  networkBadges: publicBadgeState.badges,
});

assert.equal(profile.identity.networkBadges[0].badgeId, "core_contributor");
assert.equal(profile.identity.networkBadges[0].symbolKey, "git_pull_request");
assert.equal(profile.identity.networkBadges[0].rewardCaps.code_task, 30000);
assert.equal(profile.identity.networkBadges[0].evidence, undefined);
assert.equal(JSON.stringify(profile).includes("coreContributorAccess"), false);

console.log("network badge profile smoke ok");
