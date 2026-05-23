import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  boardManagerActions,
  buildBoardManagerSourcePacket,
  formatBoardManagerAgentRun,
  formatBoardManagerCodexPrompt,
  normalizeBoardManagerDecision,
} = await import("../server/repositories/board-manager.js");
const { buildBoardManagerActionPressure } = await import("../server/repositories/board-manager-health.js");
const { loadPrompt } = await import("../server/prompt-registry.js");

assert.ok(boardManagerActions.includes("do_nothing"));
assert.ok(boardManagerActions.includes("archive_project"));
assert.ok(boardManagerActions.includes("initiate_network_task"));
assert.equal(boardManagerActions.includes("research"), false);
assert.equal(boardManagerActions.includes("update_project"), false);
assert.equal(boardManagerActions.includes("review_evidence_packet"), false);

const packet = await buildBoardManagerSourcePacket({
  trigger: "board_manager_smoke",
  scope: "global_hive",
});

assert.equal(packet.schema, "pf.hive.board_manager.source.v0");
assert.equal(packet.scope, "global_hive");
assert.equal(packet.trigger, "board_manager_smoke");
assert.equal(packet.executionPolicy.dryRunDefault, true);
assert.ok(packet.executionPolicy.implementedActionHooks.includes("message_user"));
assert.ok(packet.executionPolicy.implementedActionHooks.includes("create_project"));
assert.ok(packet.sourcePacketDigest.length >= 40);
assert.deepEqual(packet.actionRegistry, boardManagerActions);
assert.equal(packet.boardActionPressure.schema, "pf.hive.board_action_pressure.v1");
assert.equal(packet.boardActionPressure.policy.emptyActiveProjectRequiresAction, true);

const stalledBoard = buildBoardManagerActionPressure({
  hiveProjects: {
    projects: {
      empty_protocol_project: {
        id: "empty_protocol_project",
        title: "Empty Protocol Project",
        status: "active",
        taskCount: 2,
        contributorCount: 1,
        tasks: [],
        contributors: [],
      },
    },
  },
  networkTaskContent: { completed: [], outstanding: [], stopped: [], pendingGeneration: [] },
  networkTaskCandidates: [{ accountId: "acct_candidate", walletAddress: "rCandidate" }],
  recentBoardManagerRuns: [],
});
assert.equal(stalledBoard.summary.requiresAction, true);
assert.equal(stalledBoard.summary.projectsWithoutLiveTasks, 1);
assert.equal(stalledBoard.summary.eligibleCandidateCount, 1);
assert.equal(stalledBoard.signals[0].pressure, "empty_or_stalled_active_project");
assert.ok(stalledBoard.signals[0].allowedNextActions.includes("initiate_network_task"));

const busyCandidateBoard = buildBoardManagerActionPressure({
  hiveProjects: {
    projects: {
      empty_protocol_project: {
        id: "empty_protocol_project",
        title: "Empty Protocol Project",
        status: "active",
        taskCount: 2,
        contributorCount: 1,
        tasks: [],
        contributors: [],
      },
    },
  },
  networkTaskContent: {
    completed: [],
    outstanding: [{ projectId: "other_project", candidateWalletAddress: "rCandidate" }],
    stopped: [],
    pendingGeneration: [],
  },
  networkTaskCandidates: [{ accountId: "acct_candidate", walletAddress: "rCandidate" }],
  recentBoardManagerRuns: [],
});
assert.equal(busyCandidateBoard.summary.eligibleCandidateCount, 0);
assert.equal(busyCandidateBoard.signals[0].allowedNextActions.includes("initiate_network_task"), false);

const movingBoard = buildBoardManagerActionPressure({
  hiveProjects: {
    projects: {
      moving_protocol_project: {
        id: "moving_protocol_project",
        title: "Moving Protocol Project",
        status: "active",
        taskCount: 1,
        contributorCount: 1,
        tasks: [{ taskId: "task_live" }],
        contributors: [{ walletAddress: "rCandidate" }],
      },
    },
  },
  networkTaskContent: {
    completed: [],
    outstanding: [{ projectId: "moving_protocol_project" }],
    stopped: [],
    pendingGeneration: [],
  },
  networkTaskCandidates: [{ accountId: "acct_candidate", walletAddress: "rCandidate" }],
  recentBoardManagerRuns: [],
});
assert.equal(movingBoard.summary.requiresAction, false);
assert.equal(movingBoard.signals.length, 0);

const prompt = formatBoardManagerCodexPrompt({
  prompt: loadPrompt("hive/board_manager_v1.md"),
  sourcePacket: packet,
});
assert.match(prompt, /BOARD MANAGER SOURCE PACKET/);
assert.match(prompt, /Do not mutate database state/);
assert.match(prompt, /pf\.hive\.board_manager\.source\.v0/);

const decision = normalizeBoardManagerDecision({
  action: "refresh_hive_secretary",
  target_type: "hive_secretary_report",
  target_id: "latest",
  reason: "The report is stale relative to validated Hive Inputs.",
  confidence: 0.72,
  payload: {
    summary: "Refresh the Hive Secretary report because validated inputs changed.",
    next_steps: ["Run the secretary refresh action when mutation execution is enabled."],
  },
});
assert.equal(decision.action, "refresh_hive_secretary");
assert.equal(decision.confidence, 0.72);
assert.equal(decision.payload.summary, "Refresh the Hive Secretary report because validated inputs changed.");
assert.deepEqual(decision.payload.next_steps, ["Run the secretary refresh action when mutation execution is enabled."]);
assert.equal(decision.payload.project.title, "");
assert.equal(decision.payload.contributor.wallet_address, "");

const networkDecision = normalizeBoardManagerDecision({
  action: "initiate_network_task",
  target_type: "network_project",
  target_id: "capital_deployment_protocol",
  reason: "Route one explicit eligible contributor.",
  confidence: 0.8,
  payload: {
    network_task: {
      task_class: "network",
      candidate_account_id: "acct_candidate",
      candidate_wallet_address: "rCandidate",
      project_need_summary: "Need a concrete network task.",
      routing_reason: "Candidate is eligible.",
      cadence_reason: "No active task in this class.",
      reward_min_pft: 1,
      reward_max_pft: 100000000,
      accept_window_hours: 24,
      allow_over_capacity: false,
    },
  },
});
assert.equal(networkDecision.payload.network_task.reward_min_pft, 10000);
assert.equal(networkDecision.payload.network_task.reward_max_pft, 50000);

assert.throws(
  () => normalizeBoardManagerDecision({ action: "delete_everything", reason: "bad", payload: {} }),
  /board_manager_invalid_action/
);

const doNothingFeedItem = formatBoardManagerAgentRun({
  id: "boardrun_do_nothing",
  status: "completed",
  selectedAction: "do_nothing",
  actionPayload: { summary: "State reviewed; no board mutation is needed." },
  decision: { action: "do_nothing", reason: "No strong reason to act.", confidence: 0.8 },
  dryRun: false,
  actionResults: [{ id: "result_1", action: "do_nothing", result: { executed: true }, createdAt: "2026-05-22T00:00:00.000Z" }],
  startedAt: "2026-05-22T00:00:00.000Z",
  completedAt: "2026-05-22T00:00:02.000Z",
});
assert.equal(doNothingFeedItem.label, "No board change");
assert.equal(doNothingFeedItem.state, "executed");
assert.equal(doNothingFeedItem.summary, "State reviewed; no board mutation is needed.");

const noDecisionFeedItem = formatBoardManagerAgentRun({
  id: "boardrun_no_decision",
  status: "running",
  selectedAction: "",
  decision: {},
  dryRun: false,
  actionResults: [],
  startedAt: "2026-05-22T00:00:00.000Z",
});
assert.equal(noDecisionFeedItem.action, "no_decision");
assert.equal(noDecisionFeedItem.label, "No decision");
assert.equal(noDecisionFeedItem.state, "no_decision");

console.log("board manager v0 smoke ok");
