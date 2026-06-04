import assert from "node:assert/strict";

import { hiveProjectsDocumentForTests } from "../server/repositories/hive-projects.js";

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
      codename: "stale-board-label",
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
assert.equal(project.contributors[0].codename, "@public-handle");
assert.equal(document.operators[wallet].codename, "@public-handle");
assert.equal(document.operators[wallet].hiveHandle, "public-handle");
assert.equal(project.tasks[0].assignee, wallet);
assert.equal(project.activity[0].wallet, wallet);

console.log("hive-public-identity-smoke ok");
