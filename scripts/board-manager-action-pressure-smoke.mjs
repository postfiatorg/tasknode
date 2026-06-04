import assert from "node:assert/strict";

import { buildBoardManagerActionPressure } from "../server/repositories/board-manager-health.js";

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

console.log("board-manager-action-pressure-smoke ok");
