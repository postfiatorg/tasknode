import assert from "node:assert/strict";
import { deriveAddress, deriveKeypair, generateSeed } from "ripple-keypairs";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
process.env.TASKNODE_HIVE_SECRETARY_ENABLED = "false";

const { databaseEnabled, query } = await import("../server/db/pool.js");
const { closePool } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const {
  appendChatTurn,
  getChatMessages,
} = await import("../server/repositories/chat-billing.js");
const {
  getHiveConversation,
  hiveConversationIdForAccount,
  listChatConversations,
  markHiveConversationRead,
} = await import("../server/repositories/chat-conversations.js");
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
    ...overrides,
  };
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager action hooks smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();

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
  const wallet = deriveAddress(deriveKeypair(generateSeed()).publicKey);
  const smokeAccountId = "acct_board_manager_smoke";
  const smokeConversationId = "conversation_board_manager_smoke";
  const smokeHiveEntryId = "hivectx_board_manager_smoke";
  const fallbackAccountId = "acct_board_manager_missing_source_conversation_smoke";
  const fallbackHiveEntryId = "hivectx_board_manager_missing_source_conversation_smoke";
  const fallbackHiveConversationId = hiveConversationIdForAccount(fallbackAccountId);
  const smokeProfileId = "nettaskprofile_board_manager_smoke";

  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
  await query("DELETE FROM pftl_sync_wallets WHERE account_id = $1", [smokeAccountId]);
  await query("DELETE FROM board_manager_user_messages WHERE account_id = $1", [smokeAccountId]);
  await query("DELETE FROM board_manager_user_messages WHERE account_id = $1", [fallbackAccountId]);
  await query("DELETE FROM chat_messages WHERE account_id = $1", [fallbackAccountId]);
  await query("DELETE FROM chat_conversations WHERE account_id = $1", [fallbackAccountId]);

  await appendChatTurn({
    accountId: smokeAccountId,
    conversationId: smokeConversationId,
    mode: "Hive",
    provider: "tasknode",
    model: "hive_context_store",
    userMessage: "Smoke Hive chat asking whether the Board Manager can respond in chat.",
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
      body: "Smoke Hive chat asking whether the Board Manager can respond in chat.",
      sourceConversationId: smokeConversationId,
      walletValidated: true,
      walletAddress: wallet,
      createdAt: new Date().toISOString(),
    }],
  });
  sourcePacket.hiveContext.groups.push({
    accountId: fallbackAccountId,
    displayName: "Fallback Operator",
    latestAt: new Date().toISOString(),
    entryCount: 1,
    entries: [{
      id: fallbackHiveEntryId,
      accountId: fallbackAccountId,
      displayName: "Fallback Operator",
      body: "Smoke Hive chat entry imported before source conversations existed.",
      sourceConversationId: "",
      walletValidated: true,
      walletAddress: wallet,
      createdAt: new Date().toISOString(),
    }],
  });
  await query(
    `
      INSERT INTO pftl_sync_wallets (wallet_address, account_id, role, status, priority, last_hot_sync_at, metadata_json)
      VALUES ($1, $2, 'user', 'active', 10, now(), '{}'::jsonb)
      ON CONFLICT (wallet_address) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        last_hot_sync_at = now(),
        updated_at = now()
    `,
    [wallet, smokeAccountId]
  );
  await query(
    `
      INSERT INTO network_task_profiles (
        id,
        account_id,
        status,
        source_packet_digest,
        source_packet_json,
        source_packet_text,
        output_json,
        output_text,
        provider,
        model,
        prompt_version,
        completed_at
      )
      VALUES ($1, $2, 'completed', 'smoke_digest', '{}'::jsonb, 'smoke source', $3::jsonb, $4, 'smoke', 'smoke', 'network_task_profile_v2', now())
      ON CONFLICT (id) DO UPDATE SET
        output_json = EXCLUDED.output_json,
        output_text = EXCLUDED.output_text,
        completed_at = now(),
        superseded_at = NULL
    `,
    [
      smokeProfileId,
      smokeAccountId,
      JSON.stringify({
        profile_title: "Smoke Network Operator",
        current_focus: ["Verifying Board Manager action hooks."],
        primary_contribution_ability: ["Can validate network task routing plumbing."],
        domain_expertise: ["Task Node smoke testing."],
      }),
      "Smoke Network Operator\n\nCurrent focus:\n- Verifying Board Manager action hooks.",
    ]
  );

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

  const networkTaskDecision = {
    action: "initiate_network_task",
    target_type: "network_project",
    target_id: projectId,
    reason: "Smoke verifies network task allocation and generation job creation.",
    confidence: 1,
    payload: payload({
      summary: "Queue a smoke Network Task generation job.",
      next_steps: ["Create a queued allocation.", "Create a queued generation job."],
      network_task: {
        task_class: "network",
        candidate_account_id: smokeAccountId,
        candidate_wallet_address: wallet,
        project_need_summary: "Verify the Board Manager can initiate a project-linked Network Task without writing the final task offer.",
        routing_reason: "The smoke operator has a Network Diagnostic Report and an active wallet.",
        cadence_reason: "Action hook smoke only.",
        reward_min_pft: 10000,
        reward_max_pft: 50000,
        accept_window_hours: 24,
        allow_over_capacity: true,
      },
    }),
  };
  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: networkTaskDecision,
  });
  const idempotentNetworkTask = await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: networkTaskDecision,
  });
  assert.equal(idempotentNetworkTask.result?.idempotent, true);

  await assert.rejects(
    () => executeBoardManagerDecision({
      runId: "",
      sourcePacket,
      dryRun: false,
      decision: {
        ...networkTaskDecision,
        payload: payload({
          network_task: {
            ...networkTaskDecision.payload.network_task,
            candidate_account_id: "acct_board_manager_missing_candidate",
            candidate_wallet_address: deriveAddress(deriveKeypair(generateSeed()).publicKey),
          },
        }),
      },
    }),
    /network_task_candidate_not_eligible/
  );

  await executeBoardManagerDecision({
    runId,
    sourcePacket,
    dryRun: false,
    decision: {
      action: "refresh_project_document",
      target_type: "network_project",
      target_id: projectId,
      reason: "Smoke verifies project document refresh action hook.",
      confidence: 1,
      payload: payload({
        summary: "Refresh the temporary project product document.",
        project_document: {
          title: "Board Manager Action Smoke Status",
          summary: "The temporary project exists to prove Board Manager action hooks can mutate Hive state.",
          project_status: "The project was created by the Board Manager, assigned one contributor, and refreshed into a durable product document without calling an external writer model.",
          key_points: [
            "The action hook path can create project records.",
            "The project document is stored separately from the static project description.",
          ],
          blocked_or_unclear: [],
          next_actions: [
            "Archive the temporary project after verification.",
          ],
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
      target_type: "account",
      target_id: fallbackAccountId,
      reason: "Smoke verifies user message action hook falls back to the default Hive chat when sourceConversationId is missing.",
      confidence: 1,
      payload: payload({
        message_text: "Board Manager default Hive chat fallback smoke message.",
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

  const [project, contributor, productDoc, networkJob, networkJobCount, message, fallbackMessage, actions] = await Promise.all([
    query("SELECT status, metadata_json->>'operator_archived' AS operator_archived FROM network_projects WHERE id = $1", [projectId]),
    query("SELECT status FROM network_project_contributors WHERE project_id = $1 AND wallet_address = $2", [projectId, wallet]),
    query(
      `
        SELECT id, project_status, status, provider, model, prompt_version
        FROM network_project_product_docs
        WHERE project_id = $1
          AND status = 'current'
          AND superseded_at IS NULL
        LIMIT 1
      `,
      [projectId]
    ),
    query("SELECT id, status, task_class, candidate_account_id FROM network_task_generation_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [projectId]),
    query("SELECT count(*)::int AS count FROM network_task_generation_jobs WHERE project_id = $1 AND candidate_account_id = $2", [projectId, smokeAccountId]),
    query("SELECT id, metadata_json->>'chat_message_id' AS chat_message_id FROM board_manager_user_messages WHERE run_id = $1 AND account_id = $2", [runId, smokeAccountId]),
    query("SELECT id, metadata_json->>'chat_message_id' AS chat_message_id FROM board_manager_user_messages WHERE run_id = $1 AND account_id = $2", [runId, fallbackAccountId]),
    query("SELECT count(*)::int AS count FROM board_manager_action_results WHERE run_id = $1", [runId]),
  ]);
  assert.equal(project.rows[0]?.status, "archived");
  assert.equal(project.rows[0]?.operator_archived, "true");
  assert.equal(contributor.rows[0]?.status, "active");
  assert.ok(productDoc.rows[0]?.id);
  assert.match(productDoc.rows[0]?.project_status || "", /project/i);
  assert.equal(productDoc.rows[0]?.provider, "codex_exec");
  assert.equal(productDoc.rows[0]?.model, "smoke");
  assert.equal(productDoc.rows[0]?.prompt_version, "board_manager_v1");
  assert.ok(networkJob.rows[0]?.id);
  assert.equal(networkJob.rows[0]?.status, "queued");
  assert.equal(networkJob.rows[0]?.task_class, "network");
  assert.equal(networkJob.rows[0]?.candidate_account_id, smokeAccountId);
  assert.equal(networkJobCount.rows[0]?.count, 1);
  assert.ok(message.rows[0]?.id);
  assert.ok(message.rows[0]?.chat_message_id);
  assert.ok(fallbackMessage.rows[0]?.id);
  assert.ok(fallbackMessage.rows[0]?.chat_message_id);
  const chatMessages = await getChatMessages({ accountId: smokeAccountId, conversationId: smokeConversationId, limit: 10 });
  assert.ok(chatMessages.some((item) => item.role === "assistant" && item.body === "Board Manager action hook smoke message."));
  const fallbackChatMessages = await getChatMessages({ accountId: fallbackAccountId, conversationId: fallbackHiveConversationId, limit: 10 });
  assert.ok(fallbackChatMessages.some((item) => item.role === "assistant" && item.body === "Board Manager default Hive chat fallback smoke message."));
  const fallbackHiveConversation = await getHiveConversation({ accountId: fallbackAccountId });
  assert.equal(fallbackHiveConversation.unreadCount, 1);
  assert.equal(fallbackHiveConversation.unread, true);
  const fallbackRecents = await listChatConversations({ accountId: fallbackAccountId, limit: 5 });
  assert.equal(fallbackRecents.find((item) => item.kind === "hive")?.unreadCount, 1);
  const markRead = await markHiveConversationRead({ accountId: fallbackAccountId });
  assert.equal(markRead.ok, true);
  assert.equal(markRead.updated, 1);
  assert.equal(markRead.conversation.unreadCount, 0);
  assert.equal(actions.rows[0]?.count, 8);
  const publicFeed = await getBoardManagerAgentFeed({ limit: 20 });
  assert.equal(publicFeed.some((entry) => entry.runId === runId), false);
  const feed = await getBoardManagerAgentFeed({ limit: 20, includeInternal: true });
  const runFeed = feed.find((entry) => entry.runId === runId);
  assert.ok(runFeed);
  assert.ok(runFeed.actionResults.some((entry) => entry.action === "refresh_project_document"));
  assert.ok(runFeed.actionResults.some((entry) => entry.action === "initiate_network_task"));
  assert.ok(runFeed.actionResults.some((entry) => entry.action === "archive_project"));
  await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'failed',
          last_error = 'board manager action hook smoke complete',
          locked_at = NULL,
          updated_at = now()
      WHERE project_id = $1
        AND board_manager_run_id = $2
        AND status IN ('queued', 'running', 'generated')
    `,
    [projectId, runId]
  );
  await query(
    `
      UPDATE network_task_allocations
      SET allocation_status = 'failed',
          metadata_json = metadata_json || '{"smoke_complete": true}'::jsonb,
          updated_at = now()
      WHERE project_id = $1
        AND metadata_json->>'board_manager_run_id' = $2
        AND allocation_status IN ('candidate', 'queued', 'proposed', 'accepted')
    `,
    [projectId, runId]
  );
  await query(
    "DELETE FROM network_project_contributors WHERE project_id = $1 AND wallet_address = $2",
    [projectId, wallet]
  );
  await query(
    "DELETE FROM pftl_sync_wallets WHERE account_id = $1 AND wallet_address = $2",
    [smokeAccountId, wallet]
  );
  console.log(JSON.stringify({ ok: true, runId, projectId, actionResults: actions.rows[0]?.count }, null, 2));
}

try {
  await main();
} finally {
  await closePool();
}
