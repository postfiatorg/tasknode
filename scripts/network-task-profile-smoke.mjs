import assert from "node:assert/strict";
import {
  buildNetworkTaskProfileSourcePacket,
  formatLiveTaskRoutingContext,
  formatNetworkTaskProfileOutput,
} from "../server/repositories/network-task-profile.js";

const live = formatLiveTaskRoutingContext([
  {
    title: "Draft member routing spec",
    statusKey: "proposed",
    tab: "outstanding",
    description: "Write a concise plan for routing network work to members based on their current task state.",
    rewardOfferPft: 2.4,
    updatedAtDisplay: "May 22, 1:00 PM UTC",
  },
  {
    title: "Implement task copy controls",
    statusKey: "rewarded",
    tab: "rewarded",
    description: "Add copy controls to task cards so users can paste task briefs into external agents.",
    rewardActualPft: 2.4,
    rewardOutcome: { summary: "Completed with deterministic copy acknowledgement and readable exported task text." },
    updatedAtDisplay: "May 22, 2:00 PM UTC",
  },
]);

assert.match(live.text, /LIVE TASK ROUTING CONTEXT/);
assert.match(live.text, /Proposed \(1\)/);
assert.match(live.text, /Rewarded \(1\)/);
assert.doesNotMatch(live.text, /Qm[A-Za-z0-9]{10,}/);
assert.doesNotMatch(live.text, /Transaction/i);

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
assert.match(packet.sourceText, /Live Task Routing Context/);
assert.equal(packet.sourceCounts.deepMemoryCount, 1);
assert.equal(packet.sourceCounts.rewardedTaskCount, 1);
assert.equal(packet.sourcePacketDigest.length, 64);

const output = formatNetworkTaskProfileOutput({
  profile_title: "Protocol Product Engineer",
  routing_summary: "Route reliability and task-loop work to this member.",
  best_task_types: ["Protocol UX fixes"],
  avoid_task_types: ["Pure social feed work"],
  current_capacity_signal: "medium",
  routing_reasons: ["Rewarded work shows task loop completion."],
  confidence: "medium",
  user_visible_caveats: ["Only a small sample is available."],
});

assert.match(output, /Protocol Product Engineer/);
assert.match(output, /Best task types/);
assert.match(output, /Confidence: medium/);

console.log("network task profile smoke ok");
