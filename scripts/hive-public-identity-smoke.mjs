import assert from "node:assert/strict";

import {
  hiveProjectsDocumentForTests,
  resolveHivePublicWalletIdentities,
} from "../server/repositories/hive-projects.js";

const wallet = "rPublicIdentitySmokeWallet000001";
const document = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "project_public_identity_smoke",
      title: "Public Identity Smoke",
      type: "network_validation",
      summary: "Verify Hive uses current public profile identity.",
      objective: "Keep operator labels current when users change public handles.",
      status: "active",
      priority: 1,
    },
  ],
  contributorRows: [
    {
      project_id: "project_public_identity_smoke",
      wallet_address: wallet,
      codename: "board-codename",
      archetype: "Network contributor",
      status: "active",
      cap: 1,
      load: 1,
      task_count: 1,
      pft_earned: 0,
    },
  ],
  taskRows: [
    {
      project_id: "project_public_identity_smoke",
      id: "task_ref_public_identity_smoke",
      task_id: "task_public_identity_smoke",
      title: "Confirm the public handle renders in Hive",
      state: "accepted",
      assignee_wallet: wallet,
      reward_pft: 30000,
      updated_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
    },
  ],
  activityRows: [
    {
      id: "activity_public_identity_smoke",
      project_id: "project_public_identity_smoke",
      wallet_address: wallet,
      action: "accepted",
      task_title: "Confirm the public handle renders in Hive",
      time_label: "now",
      pft_amount: null,
      updated_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
    },
  ],
  walletIdentities: [
    {
      accountId: "acct_public_identity_smoke",
      walletAddress: wallet,
      displayName: "@public-handle",
      hiveHandle: "public-handle",
    },
  ],
});

const project = document.projects.project_public_identity_smoke;
// The Hive board codename is the displayed name and must be preserved; the public
// profile displayName is exposed as a separate fallback field (not a replacement).
assert.equal(project.contributors[0].codename, "board-codename");
assert.equal(project.contributors[0].displayName, "@public-handle");
assert.equal(document.operators[wallet].codename, "board-codename");
assert.equal(document.operators[wallet].displayName, "@public-handle");
assert.equal(document.operators[wallet].hiveHandle, "public-handle");
assert.equal(project.contributors[0].accountId, "acct_public_identity_smoke");
assert.equal(project.tasks[0].assignee, wallet);
assert.equal(project.activity[0].wallet, wallet);

const dbWallet = "rKa3YawxpdTRDX41psbzPtKLmTzxw1R13b";
const dbAccountId = "acct_oauth_2be237fbe1e6cb91fe010df8";
const dbIdentities = await resolveHivePublicWalletIdentities({
  wallets: [dbWallet],
  databaseReady: true,
  queryImpl: async (sql, params = []) => {
    if (sql.includes("to_regclass('public.recommended_connection_profiles')")) {
      return { rows: [{ profile_table: "recommended_connection_profiles" }] };
    }
    assert.deepEqual(params, [[dbWallet], [dbAccountId], [dbWallet]]);
    assert.match(sql, /FROM unnest\(\$1::text\[\], \$2::text\[\]\)/);
    assert.doesNotMatch(sql, /FROM task_projections/);
    assert.doesNotMatch(sql, /FROM network_task_allocations/);
    assert.match(sql, /FROM user_observability_events/);
    assert.match(sql, /profile.visibility = 'public'/);
    assert.match(sql, /profile.discoverable = true/);
    return {
      rows: [{
        wallet_address: dbWallet,
        account_id: dbAccountId,
        hive_handle: "sanemi",
        display_name: "@sanemi",
        public_display_name: "",
        hero_nft_title: "Task Node Profile NFT",
        hero_nft_status: "generated",
        hero_nft_image_cid: "QmSanemiProfileNft",
        hero_nft_image_gateway_url: "https://dweb.link/ipfs/QmSanemiProfileNft",
      }],
    };
  },
  walletAccounts: [{ walletAddress: dbWallet, accountId: dbAccountId }],
});
assert.equal(dbIdentities.length, 1);
assert.equal(dbIdentities[0].displayName, "@sanemi");
assert.equal(dbIdentities[0].hiveHandle, "sanemi");
assert.equal(dbIdentities[0].nft.imageCid, "QmSanemiProfileNft");

const dbDocument = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "project_db_identity_smoke",
      title: "DB Identity Smoke",
      type: "network_validation",
      summary: "Verify DB public identity fills derived Hive operators.",
      objective: "Do not leave public discoverable operators displayed as compact wallets.",
      status: "active",
      priority: 2,
    },
  ],
  taskRows: [
    {
      project_id: "project_db_identity_smoke",
      id: "task_ref_db_identity_smoke",
      task_id: "task_db_identity_smoke",
      title: "Confirm DB public handle renders in Hive",
      state: "proposed",
      projected_subject_wallet: dbWallet,
      projected_reward_pft: 15000,
      projected_updated_at: "2026-06-15T11:42:16.040Z",
      created_at: "2026-06-15T11:42:16.040Z",
    },
  ],
  walletIdentities: dbIdentities,
  publicProfileIds: new Set([dbAccountId]),
});
assert.equal(dbDocument.operators[dbWallet].codename, "@sanemi");
assert.equal(dbDocument.operators[dbWallet].displayName, "@sanemi");
assert.equal(dbDocument.operators[dbWallet].accountId, dbAccountId);
assert.equal(dbDocument.operators[dbWallet].hasPublicProfile, true);
assert.equal(dbDocument.operators[dbWallet].nft.imageCid, "QmSanemiProfileNft");
assert.equal(dbDocument.projects.project_db_identity_smoke.tasks[0].assigneeDisplayName, "@sanemi");

console.log("hive-public-identity-smoke ok");
