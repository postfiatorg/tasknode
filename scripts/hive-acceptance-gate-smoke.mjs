import assert from "node:assert/strict";

import { hiveProjectsDocumentForTests } from "../server/repositories/hive-projects.js";

const wallet = "rAcceptanceGateSmokeWallet000001";
const document = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "project_acceptance_gate_smoke",
      title: "Hive Acceptance Gate Smoke",
      type: "network_validation",
      summary: "Verify Hive makes task state and next action explicit.",
      objective: "A contributor should see the next reward-bearing task and know what to do.",
      status: "active",
      priority: 1,
    },
  ],
  taskRows: [
    {
      project_id: "project_acceptance_gate_smoke",
      id: "task_ref_acceptance_gate_smoke",
      task_id: "task_acceptance_gate_smoke",
      title: "Submit one evidence packet",
      state: "accepted",
      assignee_wallet: wallet,
      reward_pft: 18000,
      updated_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
    },
  ],
  walletIdentities: [
    {
      accountId: "acct_acceptance_gate_smoke",
      walletAddress: wallet,
      displayName: "@acceptance-smoke",
      hiveHandle: "acceptance-smoke",
    },
  ],
});

const project = document.projects.project_acceptance_gate_smoke;
assert.equal(project.nextTask.title, "Submit one evidence packet");
assert.equal(project.nextTask.state, "accepted");
assert.equal(project.nextTask.nextAction, "Complete the task and submit evidence for review.");
assert.equal(project.tasks[0].nextAction, "Complete the task and submit evidence for review.");
assert.equal(project.activity[0].nextAction, "Complete the task and submit evidence for review.");
assert.equal(document.operators[wallet].codename, "@acceptance-smoke");

console.log("hive-acceptance-gate-smoke ok");
