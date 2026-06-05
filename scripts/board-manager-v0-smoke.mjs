import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.OPENAI_API_KEY = "board-manager-smoke-openai-key";
process.env.OPENROUTER_API_KEY = "board-manager-smoke-openrouter-key";
delete process.env.TASKNODE_BOARD_MANAGER_PROVIDER;
delete process.env.TASKNODE_BOARD_MANAGER_MODEL;
delete process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT;

const {
  boardManagerActions,
  buildBoardManagerSourcePacket,
  formatBoardManagerAgentJob,
  formatBoardManagerAgentRun,
  formatBoardManagerCodexPrompt,
  normalizeBoardManagerDecision,
} = await import("../server/repositories/board-manager.js");
const { buildBoardManagerActionPressure } = await import("../server/repositories/board-manager-health.js");
const {
  boardManagerModel,
  boardManagerProvider,
  fetchBoardManagerDecision,
} = await import("../server/board-manager-decision-provider.js");
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
assert.equal(stalledBoard.candidateCapacity.policy.personalTasksDoNotAffectNetworkTaskEligibility, true);
assert.equal(stalledBoard.candidateCapacity.policy.candidateCapacityIsConsumedOnlyByOutstandingOrPendingNetworkTasks, true);
assert.equal(stalledBoard.signals[0].pressure, "empty_or_stalled_active_project");
assert.ok(stalledBoard.signals[0].allowedNextActions.includes("initiate_network_task"));

const personalTaskContextBoard = buildBoardManagerActionPressure({
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
  taskState: {
    recent: [
      {
        taskId: "task_personal_context_only",
        taskKind: "personal",
        status: "accepted",
        title: "Accepted personal task should not consume Network Task capacity",
      },
    ],
  },
  recentBoardManagerRuns: [],
});
assert.equal(personalTaskContextBoard.summary.eligibleCandidateCount, 1);
assert.equal(personalTaskContextBoard.candidateCapacity.ignoredForCapacity.taskStateRecentCount, 1);
assert.equal(personalTaskContextBoard.candidateCapacity.eligibleCandidates[0].accountId, "acct_candidate");
assert.ok(personalTaskContextBoard.signals[0].allowedNextActions.includes("initiate_network_task"));

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
assert.equal(busyCandidateBoard.summary.activeNetworkTaskCapacityBlockerCount, 1);
assert.equal(busyCandidateBoard.candidateCapacity.activeNetworkTaskCapacityBlockers[0].source, "outstanding_network_task");
assert.equal(busyCandidateBoard.candidateCapacity.activeNetworkTaskCapacityBlockers[0].candidateWalletAddress, "rCandidate");
assert.equal(busyCandidateBoard.signals[0].allowedNextActions.includes("initiate_network_task"), false);
assert.equal(busyCandidateBoard.signals[0].allowedNextActions.includes("message_user"), true);
assert.equal(busyCandidateBoard.signals[0].preferredNextAction, "message_user");

const relinkedWalletBoard = buildBoardManagerActionPressure({
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
    outstanding: [
      {
        projectId: "other_project",
        candidateAccountId: "acct_candidate",
        candidateWalletAddress: "rOldWallet",
      },
    ],
    stopped: [],
    pendingGeneration: [],
  },
  networkTaskCandidates: [{ accountId: "acct_candidate", walletAddress: "rNewWallet" }],
  recentBoardManagerRuns: [],
});
assert.equal(relinkedWalletBoard.summary.eligibleCandidateCount, 1);
assert.equal(relinkedWalletBoard.candidateCapacity.candidates[0].availableForNetworkTask, true);
assert.equal(relinkedWalletBoard.candidateCapacity.candidates[0].capacityBlockers.length, 0);

const accountOnlyPendingBoard = buildBoardManagerActionPressure({
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
    outstanding: [],
    stopped: [],
    pendingGeneration: [
      {
        projectId: "other_project",
        candidateAccountId: "acct_candidate",
        generationJobId: "job_without_wallet_yet",
      },
    ],
  },
  networkTaskCandidates: [{ accountId: "acct_candidate", walletAddress: "rNewWallet" }],
  recentBoardManagerRuns: [],
});
assert.equal(accountOnlyPendingBoard.summary.eligibleCandidateCount, 0);
assert.equal(accountOnlyPendingBoard.candidateCapacity.candidates[0].availableForNetworkTask, false);
assert.equal(accountOnlyPendingBoard.candidateCapacity.candidates[0].capacityBlockers[0].generationJobId, "job_without_wallet_yet");

const pendingUserFollowupBoard = buildBoardManagerActionPressure({
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
  recentBoardManagerRuns: [
    {
      action: "message_user",
      state: "executed",
      dryRun: false,
      completedAt: new Date().toISOString(),
    },
  ],
});
assert.equal(pendingUserFollowupBoard.summary.recentUserFollowup, true);
assert.equal(pendingUserFollowupBoard.summary.requiresAction, false);
assert.equal(pendingUserFollowupBoard.signals[0].requiresAction, false);

const documentRefreshOnlyBoard = buildBoardManagerActionPressure({
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
  networkTaskCandidates: [],
  recentBoardManagerRuns: [
    {
      selectedAction: "refresh_project_document",
      targetId: "empty_protocol_project",
      actionResults: [{ targetId: "empty_protocol_project" }],
    },
  ],
});
assert.equal(documentRefreshOnlyBoard.summary.requiresAction, true);
assert.equal(documentRefreshOnlyBoard.signals[0].requiresAction, true);

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
assert.match(prompt, /Recent refusals are routing feedback/);

const smokeDecisionOutput = {
  action: "message_user",
  target_type: "account",
  target_id: "acct_candidate",
  reason: "The board is stalled and no contributor capacity is available, so ask for the smallest decision input.",
  confidence: 0.74,
  decision_basis: {
    source_facts: [
      "boardActionPressure requires action.",
      "No eligible candidate capacity is available after active Network Task blockers.",
    ],
    tradeoffs: ["A message is safer than over-capacity task routing."],
    rejected_actions: [
      {
        action: "initiate_network_task",
        reason: "No eligible candidate capacity is available in the source packet.",
      },
    ],
    risk_notes: ["The user may need to make a priority decision before new routing is useful."],
    next_check: "Wait for a user response or a capacity change before routing another Network Task.",
  },
  payload: {
    summary: "Ask the contributor for the smallest useful project input.",
    next_steps: ["Wait for the contributor response before routing another task."],
    message_text: "What is the smallest concrete decision input that would unblock this project?",
    archive_reason: "",
    project: {
      id: "",
      type: "",
      title: "",
      summary: "",
      objective: "",
      about: "",
      priority: 0,
      phase_label: "",
      phase_current: 0,
      phase_total: 0,
      pft_routed: 0,
      task_count: 0,
      contributor_count: 0,
    },
    project_document: {
      title: "",
      summary: "",
      project_status: "",
      key_points: [],
      blocked_or_unclear: [],
      next_actions: [],
    },
    contributor: {
      project_id: "",
      account_id: "",
      wallet_address: "",
      codename: "",
      archetype: "",
      role_label: "",
      status: "",
      allotted: false,
      cap: 0,
      load: 0,
      sort_order: 0,
    },
    network_task: {
      task_class: "",
      candidate_account_id: "",
      candidate_wallet_address: "",
      project_need_summary: "",
      routing_reason: "",
      cadence_reason: "",
      reward_min_pft: 10000,
      reward_max_pft: 50000,
      accept_window_hours: 24,
      allow_over_capacity: false,
    },
  },
};

assert.equal(boardManagerProvider(), "openrouter");
assert.equal(boardManagerModel(), "qwen/qwen3.7-max");

let capturedOpenRouterUrl = "";
let capturedOpenRouterBody = null;
const openRouterDecision = await fetchBoardManagerDecision({
  sourcePacket: packet,
  fetchImpl: async (url, options = {}) => {
    capturedOpenRouterUrl = url;
    capturedOpenRouterBody = JSON.parse(options.body);
    assert.match(options.headers.authorization, /^Bearer /);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          id: "or_board_manager_smoke",
          model: "qwen/qwen3.7-max",
          choices: [{ message: { content: JSON.stringify(smokeDecisionOutput) } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            reasoning_tokens: 25,
            cost: 0.000625,
          },
        });
      },
    };
  },
});
assert.match(capturedOpenRouterUrl, /\/chat\/completions$/);
assert.equal(capturedOpenRouterBody.model, "qwen/qwen3.7-max");
assert.equal(capturedOpenRouterBody.reasoning.effort, "high");
assert.equal(capturedOpenRouterBody.response_format.type, "json_schema");
assert.equal(capturedOpenRouterBody.response_format.json_schema.name, "board_manager_action");
assert.ok(capturedOpenRouterBody.response_format.json_schema.schema.properties.payload.properties.project.properties.title);
assert.ok(capturedOpenRouterBody.response_format.json_schema.schema.properties.decision_basis.properties.source_facts);
assert.equal(capturedOpenRouterBody.provider.data_collection, "deny");
assert.equal(capturedOpenRouterBody.provider.require_parameters, true);
assert.equal(capturedOpenRouterBody.usage.include, true);
assert.equal(capturedOpenRouterBody.metadata.prompt_version, "board_manager_v1");
assert.equal(openRouterDecision.provider, "openrouter");
assert.equal(openRouterDecision.model, "qwen/qwen3.7-max");
assert.equal(openRouterDecision.decision.action, "message_user");
assert.equal(openRouterDecision.usage.reasoningTokens, 25);
assert.equal(openRouterDecision.usage.costUsd, 0.000625);

let capturedOpenAiBody = null;
const openAiDecision = await fetchBoardManagerDecision({
  sourcePacket: packet,
  provider: "openai",
  model: "gpt-5.5-pro",
  fetchImpl: async (_url, options = {}) => {
    capturedOpenAiBody = JSON.parse(options.body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          id: "resp_board_manager_smoke",
          model: "gpt-5.5-pro-2026-04-23",
          output_text: JSON.stringify(smokeDecisionOutput),
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            output_tokens_details: { reasoning_tokens: 25 },
          },
        });
      },
    };
  },
});
assert.equal(capturedOpenAiBody.model, "gpt-5.5-pro");
assert.equal(capturedOpenAiBody.reasoning.effort, "high");
assert.equal(capturedOpenAiBody.text.format.type, "json_schema");
assert.equal(capturedOpenAiBody.text.format.name, "board_manager_action");
assert.ok(capturedOpenAiBody.text.format.schema.properties.payload.properties.project.properties.title);
assert.ok(capturedOpenAiBody.text.format.schema.properties.decision_basis.properties.source_facts);
assert.equal(capturedOpenAiBody.store, false);
assert.equal(capturedOpenAiBody.metadata.prompt_version, "board_manager_v1");
assert.equal(openAiDecision.provider, "openai");
assert.equal(openAiDecision.model, "gpt-5.5-pro-2026-04-23");
assert.equal(openAiDecision.decision.action, "message_user");
assert.equal(openAiDecision.usage.reasoningTokens, 25);

const decision = normalizeBoardManagerDecision({
  action: "refresh_hive_secretary",
  target_type: "hive_secretary_report",
  target_id: "latest",
  reason: "The report is stale relative to validated Hive Context entries.",
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
assert.deepEqual(decision.decision_basis.source_facts, ["The report is stale relative to validated Hive Context entries."]);
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

const pendingDecisionFeedItem = formatBoardManagerAgentRun({
  id: "boardrun_pending_decision",
  status: "running",
  selectedAction: "",
  decision: {},
  dryRun: false,
  actionResults: [],
  startedAt: "2026-05-22T00:00:00.000Z",
});
assert.equal(pendingDecisionFeedItem.action, "decision_pending");
assert.equal(pendingDecisionFeedItem.label, "Decision pending");
assert.equal(pendingDecisionFeedItem.state, "running");
assert.equal(
  pendingDecisionFeedItem.summary,
  "The Board Manager is evaluating Hive state and has not recorded a decision yet."
);

const pendingJobFeedItem = formatBoardManagerAgentJob({
  id: "boardjob_pending_decision",
  scope: "global_hive",
  trigger: "periodic_tick",
  reason: "Periodic Board Manager tick due.",
  status: "running",
  claimedBy: "worker_smoke",
  claimedAt: "2026-05-22T00:01:00.000Z",
  details: {
    job: {
      id: "boardjob_pending_decision",
      trigger: "periodic_tick",
      status: "running",
      reason: "Periodic Board Manager tick due.",
      claimedBy: "worker_smoke",
      attemptCount: 1,
      maxAttempts: 3,
    },
  },
});
assert.equal(pendingJobFeedItem.id, "boardjob_pending_decision");
assert.equal(pendingJobFeedItem.action, "decision_pending");
assert.equal(pendingJobFeedItem.label, "Decision pending");
assert.equal(pendingJobFeedItem.state, "running");
assert.equal(pendingJobFeedItem.trigger, "periodic_tick");
assert.equal(pendingJobFeedItem.startedAt, "2026-05-22T00:01:00.000Z");
assert.equal(pendingJobFeedItem.details.job.id, "boardjob_pending_decision");
assert.equal(pendingJobFeedItem.details.job.attemptCount, 1);

const queuedJobFeedItem = formatBoardManagerAgentJob({
  id: "boardjob_queued_decision",
  scope: "global_hive",
  trigger: "periodic_tick",
  reason: "Periodic Board Manager tick queued.",
  status: "queued",
  runAfter: "2026-05-22T00:02:00.000Z",
});
assert.equal(queuedJobFeedItem.action, "decision_queued");
assert.equal(queuedJobFeedItem.label, "Decision queued");
assert.equal(queuedJobFeedItem.summary, "The Board Manager job is queued and has not been claimed by the worker yet.");

const deferredJobFeedItem = formatBoardManagerAgentJob({
  id: "boardjob_deferred_decision",
  scope: "global_hive",
  trigger: "periodic_tick",
  reason: "Periodic Board Manager tick retry.",
  status: "deferred",
  runAfter: "2026-05-22T00:03:00.000Z",
});
assert.equal(deferredJobFeedItem.action, "decision_retry_scheduled");
assert.equal(deferredJobFeedItem.label, "Decision retry scheduled");
assert.equal(deferredJobFeedItem.summary, "The Board Manager job was deferred after an error and is scheduled for retry.");

const noDecisionFeedItem = formatBoardManagerAgentRun({
  id: "boardrun_no_decision",
  status: "completed",
  selectedAction: "",
  decision: {},
  dryRun: false,
  actionResults: [],
  startedAt: "2026-05-22T00:00:00.000Z",
  completedAt: "2026-05-22T00:00:02.000Z",
});
assert.equal(noDecisionFeedItem.action, "no_decision");
assert.equal(noDecisionFeedItem.label, "No decision");
assert.equal(noDecisionFeedItem.state, "no_decision");

console.log("board manager v0 smoke ok");
