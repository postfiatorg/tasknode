import assert from "node:assert/strict";
import "./core-contributor-allowlist-smoke.mjs";
import {
  buildNetworkTaskProfileSourcePacket,
  enqueueNetworkTaskProfileForAccount,
  enqueueNetworkTaskProfileForRewardThreshold,
  enqueueNetworkTaskProfilesForRewardedAccounts,
  enqueueNetworkTaskProfilesForRoutingAccounts,
  formatLiveTaskRoutingContext,
  formatNetworkContextInputs,
  formatNetworkTaskProfileOutput,
} from "../server/repositories/network-task-profile.js";

const live = formatLiveTaskRoutingContext([
  {
    taskId: "task_smoke_proposed",
    title: "Draft member routing spec",
    statusKey: "proposed",
    tab: "outstanding",
    description: "Write a concise plan for routing network work to members based on their current task state.",
    rewardOfferPft: 2.4,
    updatedAtDisplay: "May 22, 1:00 PM UTC",
  },
  {
    taskId: "task_smoke_rewarded",
    title: "Implement task copy controls",
    statusKey: "rewarded",
    tab: "rewarded",
    description: "Add copy controls to task cards so users can paste task briefs into external agents.",
    rewardActualPft: 2.4,
    rewardOutcome: { summary: "Completed with deterministic copy acknowledgement and readable exported task text." },
    updatedAtDisplay: "May 22, 2:00 PM UTC",
  },
  {
    taskId: "legacy_orphan_submission",
    title: "",
    statusKey: "unknown",
    tab: "outstanding",
    description: "",
    updatedAtDisplay: "May 22, 3:00 PM UTC",
  },
]);

assert.match(live.text, /Proposed \(1\)/);
assert.match(live.text, /Rewarded \(1\)/);
assert.doesNotMatch(live.text, /legacy_orphan_submission/);
assert.doesNotMatch(live.text, /Updated:/);
assert.doesNotMatch(live.text, /Qm[A-Za-z0-9]{10,}/);
assert.doesNotMatch(live.text, /Transaction/i);

const networkInputs = formatNetworkContextInputs({
  liveTaskContext: live,
  profileInput: {
    account_id: "acct_network_task_profile_smoke",
    identity: { primary_wallet: "rSmokeWallet" },
    reward_totals: { lifetimeTaskRewardPft: 4.8, trailing30dRewardedTasks: 2, trailing30dTaskRewardPft: 4.8 },
    alignment: { score0To100: 82 },
    contribution_tier: { tier: "T1", basis: "2 rewarded tasks" },
  },
  latestProfileSnapshot: {
    roleTitle: "Protocol Product Engineer",
    roleSummary: "Builds reliable task loops.",
    skills: ["Task routing", "Protocol UX"],
  },
});
assert.match(networkInputs, /NETWORK CONTEXT INPUTS/);
assert.match(networkInputs, /Public role: Protocol Product Engineer/);
assert.match(networkInputs, /Task State/);

const packet = buildNetworkTaskProfileSourcePacket({
  accountId: "acct_network_task_profile_smoke",
  contextDocument: {
    title: "Task Node Context",
    revision: 2,
    updatedAt: "2026-05-22T12:00:00.000Z",
    body: "<h1>Current focus</h1><p>Build a reliable task routing loop.</p>",
  },
  memoryContext: {
    deepMemories: [
      {
        createdAt: "2026-05-22T12:30:00.000Z",
        userRequestSummary: "The user wants task routing to be auditable.",
        systemResponseSummary: "The system planned a Memory-visible profile packet.",
        memoryText: "Keep routing evidence visible to the user.",
      },
    ],
  },
  liveTaskContext: live,
  profileInput: {
    account_id: "acct_network_task_profile_smoke",
    identity: { primary_wallet: "rSmokeWallet" },
    reward_totals: { lifetimeTaskRewardPft: 4.8, trailing30dRewardedTasks: 2, trailing30dTaskRewardPft: 4.8 },
    alignment: { score0To100: 82 },
    contribution_tier: { tier: "T1", basis: "2 rewarded tasks" },
  },
  latestProfileSnapshot: {
    roleTitle: "Protocol Product Engineer",
    roleSummary: "Builds reliable task loops.",
    skills: ["Task routing", "Protocol UX"],
  },
});

assert.match(packet.sourceText, /NETWORK TASK PROFILE SOURCE PACKET/);
assert.match(packet.sourceText, /Context Document/);
assert.match(packet.sourceText, /Network Context Inputs/);
assert.equal(packet.sourceCounts.deepMemoryCount, 1);
assert.equal(packet.sourceCounts.rewardedTaskCount, 1);
assert.equal(packet.sourcePacketDigest.length, 64);

const output = formatNetworkTaskProfileOutput({
  profile_title: "Protocol Product Engineer",
  current_focus: ["Rebuilding a reliable task loop with auditable task state and memory-backed routing context."],
  primary_contribution_ability: ["Turns ambiguous product and protocol failures into deterministic app behavior that can be tested and replayed."],
  domain_expertise: [
    "Coinbase: digital asset infrastructure and user-facing crypto workflow reliability.",
    "Block: financial product engineering with wallet and payments-adjacent systems.",
    "Cloudflare: reliability engineering for distributed systems with clear operational surfaces.",
    "Datadog: observability and diagnostics for production workflows.",
    "GitLab: developer tooling and workflow automation for engineering teams.",
  ],
});

assert.match(output, /Protocol Product Engineer/);
assert.match(output, /Current focus/);
assert.match(output, /Primary contribution ability/);
assert.match(output, /Companies this User Would Move the Needle At/);
assert.doesNotMatch(output, /Best task types/);
assert.doesNotMatch(output, /Caveats/);

const automaticNoDb = await enqueueNetworkTaskProfileForAccount({
  accountId: "acct_network_task_profile_smoke",
});
assert.equal(automaticNoDb.queued, false);
assert.equal(automaticNoDb.reason, "database_not_configured");

const thresholdNoDb = await enqueueNetworkTaskProfileForRewardThreshold({
  accountId: "acct_network_task_profile_smoke",
});
assert.equal(thresholdNoDb.queued, false);
assert.equal(thresholdNoDb.reason, "database_not_configured");

const routingBackfillNoDb = await enqueueNetworkTaskProfilesForRoutingAccounts({ limit: 1 });
assert.equal(routingBackfillNoDb.skipped, true);
assert.equal(routingBackfillNoDb.reason, "database_not_configured");

const rewardedBackfillNoDb = await enqueueNetworkTaskProfilesForRewardedAccounts({ limit: 1 });
assert.equal(rewardedBackfillNoDb.skipped, true);
assert.equal(rewardedBackfillNoDb.reason, "database_not_configured");

console.log("network task profile smoke ok");
