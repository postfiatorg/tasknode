import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
process.env.TASKNODE_HIVE_SECRETARY_ENABLED = "false";

const { databaseEnabled, query } = await import("../server/db/pool.js");
const { closePool } = await import("../server/db/pool.js");
const {
  appendChatTurn,
  getChatMessages,
} = await import("../server/repositories/chat-billing.js");
const {
  buildBoardManagerSourcePacket,
  getBoardManagerAgentFeed,
  startBoardManagerRun,
} = await import("../server/repositories/board-manager.js");
const { executeBoardManagerDecision } = await import("../server/board-manager-actions.js");

function payload(overrides = {}) {
  return {
    summary: "Board Manager action hook smoke.",
    next_steps: ["Verify action hook persistence."],
    message_text: "",
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
    ...overrides,
  };
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager action hooks smoke skipped: database not configured");
    return;
  }

  const sourcePacket = await buildBoardManagerSourcePacket({
    trigger: "board_manager_action_hooks_smoke",
    scope: "global_hive",
  });
  const run = await startBoardManagerRun({
    scope: "global_hive",
    managerId: "board_manager_action_hooks_smoke",
    trigger: "board_manager_action_hooks_smoke",
    sourcePacket,
    dryRun: false,
    model: "smoke",
    reasoningEffort: "none",
  });
  const runId = run.run.id;
  const projectId = "board_manager_action_smoke_project";
  const wallet = "rBoardManagerSmokeWallet111111111111111111";
  const smokeAccountId = "acct_board_manager_smoke";
  const smokeConversationId = "conversation_board_manager_smoke";
  const smokeHiveEntryId = "hivectx_board_manager_smoke";

  await appendChatTurn({
    accountId: smokeAccountId,
    conversationId: smokeConversationId,
    mode: "Hive Input",
    provider: "tasknode",
    model: "hive_context_store",
    userMessage: "Smoke Hive Input asking whether the Board Manager can respond in chat.",
    assistantMessage: "Hive input saved to Hive Context.",
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  sourcePacket.hiveContext.groups.push({
    accountId: smokeAccountId,
    displayName: "Smoke Operator",
    latestAt: new Date().toISOString(),
    entryCount: 1,
    entries: [{
      id: smokeHiveEntryId,
      accountId: smokeAccountId,
      displayName: "Smoke Operator",
      body: "Smoke Hive Input asking whether the Board Manager can respond in chat.",
      sourceConversationId: smokeConversationId,
      walletValidated: true,
      walletAddress: wallet,
      createdAt: new Date().toISOString(),
    }],
  });

  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "create_project",
      target_type: "network_project",
      target_id: projectId,
      reason: "Smoke verifies project creation action hook.",
      confidence: 1,
      payload: payload({
        project: {
          id: projectId,
          type: "network_validation",
          title: "Board Manager Action Smoke",
          summary: "Temporary project for Board Manager action hook verification.",
          objective: "Verify create, assign, message, and archive hooks.",
          about: "This row is created by the Board Manager action hook smoke and archived before the script exits.",
          priority: 999,
          phase_label: "Smoke",
          phase_current: 1,
          phase_total: 1,
          pft_routed: 0,
          task_count: 0,
          contributor_count: 1,
        },
      }),
    },
  });

  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "assign_contributor",
      target_type: "network_project",
      target_id: projectId,
      reason: "Smoke verifies contributor assignment action hook.",
      confidence: 1,
      payload: payload({
        contributor: {
          project_id: projectId,
          account_id: smokeAccountId,
          wallet_address: wallet,
          codename: "Smoke Operator",
          archetype: "Action hook verifier",
          role_label: "smoke",
          status: "active",
          allotted: true,
          cap: 1,
          load: 0,
          sort_order: 999,
        },
      }),
    },
  });

  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "message_user",
      target_type: "hive_context_entry",
      target_id: smokeHiveEntryId,
      reason: "Smoke verifies user message action hook.",
      confidence: 1,
      payload: payload({
        message_text: "Board Manager action hook smoke message.",
      }),
    },
  });

  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "archive_project",
      target_type: "network_project",
      target_id: projectId,
      reason: "Smoke verifies project archive action hook.",
      confidence: 1,
      payload: payload({
        archive_reason: "Board Manager action hook smoke complete.",
      }),
    },
  });

  const [project, contributor, message, actions] = await Promise.all([
    query("SELECT status, metadata_json->>'operator_archived' AS operator_archived FROM network_projects WHERE id = $1", [projectId]),
    query("SELECT status FROM network_project_contributors WHERE project_id = $1 AND wallet_address = $2", [projectId, wallet]),
    query("SELECT id, metadata_json->>'chat_message_id' AS chat_message_id FROM board_manager_user_messages WHERE run_id = $1 AND account_id = $2", [runId, smokeAccountId]),
    query("SELECT count(*)::int AS count FROM board_manager_action_results WHERE run_id = $1", [runId]),
  ]);
  assert.equal(project.rows[0]?.status, "archived");
  assert.equal(project.rows[0]?.operator_archived, "true");
  assert.equal(contributor.rows[0]?.status, "active");
  assert.ok(message.rows[0]?.id);
  assert.ok(message.rows[0]?.chat_message_id);
  const chatMessages = await getChatMessages({ accountId: smokeAccountId, conversationId: smokeConversationId, limit: 10 });
  assert.ok(chatMessages.some((item) => item.role === "assistant" && item.body === "Board Manager action hook smoke message."));
  assert.equal(actions.rows[0]?.count, 4);
  const feed = await getBoardManagerAgentFeed({ limit: 20 });
  const runFeed = feed.find((entry) => entry.runId === runId);
  assert.ok(runFeed);
  assert.equal(runFeed.actionResults.length, 4);
  assert.ok(runFeed.actionResults.some((entry) => entry.action === "archive_project"));
  console.log(JSON.stringify({ ok: true, runId, projectId, actionResults: actions.rows[0]?.count }, null, 2));
}

try {
  await main();
} finally {
  await closePool();
}
