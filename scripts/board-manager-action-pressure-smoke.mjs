import assert from "node:assert/strict";

import { buildBoardManagerActionPressure } from "../server/repositories/board-manager-health.js";
import { compactBoardActionPressureForBoardManager } from "../server/repositories/board-manager-source-compact.js";

const projectId = "project_reward_followup_pressure";
const closedAt = "2026-05-30T02:45:27.000Z";

const baseInput = {
  hiveProjects: {
    projects: {
      [projectId]: {
        id: projectId,
        title: "Reward follow-up pressure",
        status: "active",
        tasks: [],
        contributors: [{ walletAddress: "rPressureSmoke" }],
        taskCount: 1,
        contributorCount: 1,
      },
    },
  },
  networkTaskCandidates: [
    {
      accountId: "acct_pressure_smoke",
      walletAddress: "rPressureSmoke",
    },
  ],
  taskState: { recent: [] },
  recentBoardManagerRuns: [
    {
      selectedAction: "message_user",
      status: "completed",
      completedAt: "2026-05-30T02:28:37.000Z",
    },
  ],
  openFollowups: [
    {
      status: "open",
      projectId: "",
      createdAt: "2026-05-30T02:28:37.000Z",
      lastSentAt: "2026-05-30T02:28:37.000Z",
    },
  ],
};

const staleFollowupPressure = buildBoardManagerActionPressure({
  ...baseInput,
  networkTaskContent: {
    completed: [
      {
        projectId,
        taskId: "task_rewarded_pressure",
        state: "rewarded",
        updatedAt: closedAt,
      },
    ],
    outstanding: [],
    pendingGeneration: [],
    stopped: [],
  },
});

assert.equal(staleFollowupPressure.summary.requiresAction, true);
assert.equal(staleFollowupPressure.summary.outstandingNetworkTaskCount, 0);
assert.equal(staleFollowupPressure.summary.eligibleCandidateCount, 1);
assert.equal(staleFollowupPressure.signals[0].requiresAction, true);
assert.equal(staleFollowupPressure.signals[0].hasOpenFollowup, false);
assert.equal(staleFollowupPressure.signals[0].latestClosureAt, closedAt);
assert.match(staleFollowupPressure.signals[0].reasons.join(" "), /active project has no live task movement/);

const freshGlobalFollowupPressure = buildBoardManagerActionPressure({
  ...baseInput,
  networkTaskContent: {
    completed: [
      {
        projectId,
        taskId: "task_rewarded_pressure",
        state: "rewarded",
        updatedAt: closedAt,
      },
    ],
    outstanding: [],
    pendingGeneration: [],
    stopped: [],
  },
  openFollowups: [
    {
      status: "open",
      projectId: "",
      createdAt: "2026-05-30T02:46:00.000Z",
      lastSentAt: "2026-05-30T02:46:00.000Z",
    },
  ],
});

assert.equal(freshGlobalFollowupPressure.summary.requiresAction, true);
assert.equal(freshGlobalFollowupPressure.signals[0].requiresAction, true);
assert.equal(freshGlobalFollowupPressure.signals[0].hasOpenFollowup, false);

const freshProjectFollowupPressure = buildBoardManagerActionPressure({
  ...baseInput,
  networkTaskContent: {
    completed: [
      {
        projectId,
        taskId: "task_rewarded_pressure",
        state: "rewarded",
        updatedAt: closedAt,
      },
    ],
    outstanding: [],
    pendingGeneration: [],
    stopped: [],
  },
  openFollowups: [
    {
      status: "open",
      projectId,
      createdAt: "2026-05-30T02:46:00.000Z",
      lastSentAt: "2026-05-30T02:46:00.000Z",
    },
  ],
});

assert.equal(freshProjectFollowupPressure.summary.requiresAction, false);
assert.equal(freshProjectFollowupPressure.signals[0].requiresAction, false);
assert.equal(freshProjectFollowupPressure.signals[0].hasOpenFollowup, true);

const stoppedAfterOlderOutstandingPressure = buildBoardManagerActionPressure({
  hiveProjects: {
    projects: {
      active_product_project: {
        id: "active_product_project",
        title: "Active product project",
        status: "active",
        tasks: [{ taskId: "task_old_open" }, { taskId: "task_recent_refused" }],
        contributors: [{ walletAddress: "rPressureSmoke" }],
        taskCount: 2,
        contributorCount: 1,
      },
    },
  },
  networkTaskContent: {
    completed: [],
    outstanding: [
      {
        projectId: "active_product_project",
        taskId: "task_old_open",
        state: "accepted",
        updatedAt: "2026-05-30T02:40:00.000Z",
      },
    ],
    stopped: [
      {
        projectId: "active_product_project",
        taskId: "task_recent_refused",
        state: "refused",
        updatedAt: "2026-05-30T02:50:00.000Z",
      },
    ],
    pendingGeneration: [],
  },
  networkTaskCandidates: [{ accountId: "acct_pressure_smoke", walletAddress: "rPressureSmoke" }],
  recentBoardManagerRuns: [],
  openFollowups: [],
});
assert.equal(stoppedAfterOlderOutstandingPressure.summary.requiresAction, true);
assert.equal(stoppedAfterOlderOutstandingPressure.signals[0].requiresAction, true);
assert.equal(stoppedAfterOlderOutstandingPressure.signals[0].preferredNextAction, "initiate_network_task");
assert.match(
  stoppedAfterOlderOutstandingPressure.signals[0].reasons.join(" "),
  /latest stopped Network Task has no newer replacement task or generation job/
);

const replacementAfterStoppedPressure = buildBoardManagerActionPressure({
  hiveProjects: {
    projects: {
      active_product_project: {
        id: "active_product_project",
        title: "Active product project",
        status: "active",
        tasks: [{ taskId: "task_recent_refused" }, { taskId: "task_new_open" }],
        contributors: [{ walletAddress: "rPressureSmoke" }],
        taskCount: 2,
        contributorCount: 1,
      },
    },
  },
  networkTaskContent: {
    completed: [],
    outstanding: [
      {
        projectId: "active_product_project",
        taskId: "task_new_open",
        state: "proposed",
        updatedAt: "2026-05-30T02:55:00.000Z",
      },
    ],
    stopped: [
      {
        projectId: "active_product_project",
        taskId: "task_recent_refused",
        state: "refused",
        updatedAt: "2026-05-30T02:50:00.000Z",
      },
    ],
    pendingGeneration: [],
  },
  networkTaskCandidates: [{ accountId: "acct_pressure_smoke", walletAddress: "rPressureSmoke" }],
  recentBoardManagerRuns: [],
  openFollowups: [],
});
assert.equal(replacementAfterStoppedPressure.summary.requiresAction, false);
assert.equal(replacementAfterStoppedPressure.signals.length, 0);

const acceptanceBlockerPressure = buildBoardManagerActionPressure({
  ...baseInput,
  networkTaskContent: {
    completed: [],
    outstanding: [],
    pendingGeneration: [],
    stopped: [],
  },
  candidateCapacityChecks: [
    {
      accountId: "acct_pressure_smoke",
      walletAddress: "rPressureSmoke",
      availableForNetworkTask: false,
      blockers: [
        {
          kind: "proposed_task",
          taskId: "task_acceptance_blocker",
          allocationId: "alloc_acceptance_blocker",
          projectId,
          title: "Acceptance blocker",
          state: "proposed",
          rewardOfferPft: 12000,
          acceptBy: "2026-06-28T12:30:00.000Z",
          deadlineAt: "2026-06-29T12:30:00.000Z",
        },
      ],
    },
  ],
});
const acceptanceCandidateBlocker = acceptanceBlockerPressure.candidateCapacity.candidates[0].capacityBlockers[0];
assert.equal(acceptanceCandidateBlocker.title, "Acceptance blocker");
assert.equal(acceptanceCandidateBlocker.rewardOfferPft, 12000);
assert.equal(acceptanceCandidateBlocker.acceptBy, "2026-06-28T12:30:00.000Z");
assert.equal(acceptanceCandidateBlocker.deadlineAt, "2026-06-29T12:30:00.000Z");

const compactAcceptancePressure = compactBoardActionPressureForBoardManager(acceptanceBlockerPressure);
const compactAcceptanceBlocker = compactAcceptancePressure.candidateCapacity.candidates[0].capacityBlockers[0];
assert.equal(compactAcceptanceBlocker.title, "Acceptance blocker");
assert.equal(compactAcceptanceBlocker.rewardOfferPft, 12000);
assert.equal(compactAcceptanceBlocker.acceptBy, "2026-06-28T12:30:00.000Z");
assert.equal(compactAcceptanceBlocker.deadlineAt, "2026-06-29T12:30:00.000Z");
assert.equal(compactAcceptancePressure.candidateCapacity.activeNetworkTaskCapacityBlockers[0].rewardOfferPft, 12000);

console.log("board-manager-action-pressure-smoke ok");
