import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.OPENAI_API_KEY = "board-manager-smoke-openai-key";
delete process.env.TASKNODE_BOARD_MANAGER_MODEL;
delete process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT;

const {
  boardManagerActions,
  buildBoardManagerSourcePacket,
  formatBoardManagerAgentRun,
  formatBoardManagerCodexPrompt,
  normalizeBoardManagerDecision,
} = await import("../server/repositories/board-manager.js");
const { buildBoardManagerActionPressure } = await import("../server/repositories/board-manager-health.js");
const { fetchBoardManagerDecision } = await import("../server/board-manager-decision-provider.js");
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
assert.equal(busyCandidateBoard.signals[0].allowedNextActions.includes("message_user"), true);
assert.equal(busyCandidateBoard.signals[0].preferredNextAction, "message_user");

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

let capturedDecisionBody = null;
const directDecision = await fetchBoardManagerDecision({
  sourcePacket: packet,
  fetchImpl: async (_url, options = {}) => {
    capturedDecisionBody = JSON.parse(options.body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          id: "resp_board_manager_smoke",
          model: "gpt-5.5-pro-2026-04-23",
          output_text: JSON.stringify({
            action: "message_user",
            target_type: "account",
            target_id: "acct_candidate",
            reason: "The board is stalled and no contributor capacity is available, so ask for the smallest decision input.",
            confidence: 0.74,
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
          }),
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
assert.equal(capturedDecisionBody.model, "gpt-5.5-pro");
assert.equal(capturedDecisionBody.reasoning.effort, "high");
assert.equal(capturedDecisionBody.text.format.type, "json_schema");
assert.equal(capturedDecisionBody.text.format.name, "board_manager_action");
assert.ok(capturedDecisionBody.text.format.schema.properties.payload.properties.project.properties.title);
assert.equal(capturedDecisionBody.store, false);
assert.equal(capturedDecisionBody.metadata.prompt_version, "board_manager_v1");
assert.equal(directDecision.provider, "openai");
assert.equal(directDecision.model, "gpt-5.5-pro-2026-04-23");
assert.equal(directDecision.decision.action, "message_user");
assert.equal(directDecision.usage.reasoningTokens, 25);

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
