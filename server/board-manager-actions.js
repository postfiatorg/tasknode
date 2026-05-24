import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";
import { appendAssistantMessage } from "./repositories/chat-assistant-messages.js";
import {
  ensureHiveConversation,
  hiveConversationIdForAccount,
} from "./repositories/chat-conversations.js";
import { enqueueHiveSecretaryJob } from "./repositories/hive-context.js";
import {
  boardManagerPromptVersion,
  normalizeBoardManagerDecision,
  recordBoardManagerActionResult,
} from "./repositories/board-manager.js";
import { scheduleHiveSecretaryQueue } from "./hive-secretary-worker.js";
import { scheduleNetworkTaskGenerationQueue } from "./network-task-generation-worker.js";
import {
  buildHiveProjectProductDocSourcePacket,
  completeHiveProjectProductDoc,
} from "./repositories/hive-project-product-docs.js";
import { enqueueNetworkTaskGenerationFromBoardDecision } from "./repositories/network-tasks.js";

const projectTypes = new Set([
  "protocol_marketing",
  "protocol_development",
  "alpha_generation",
  "protocol_applications",
  "network_validation",
]);

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function slug(value = "") {
  const normalized = safeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || `project_${randomUUID().slice(0, 12)}`;
}

function reportInput(sourcePacket = {}) {
  const report = sourcePacket?.hiveSecretary?.report || {};
  return {
    report_id: safeText(report.id, 180),
    source_packet_digest: safeText(report.sourcePacketDigest || sourcePacket?.hiveSecretarySource?.digest, 180),
    completed_at: report.completedAt || null,
    title: report.output?.title || "Hive Secretary Report",
  };
}

function displayNameForAccount(sourcePacket = {}, accountId = "") {
  for (const group of sourcePacket?.hiveContext?.groups || []) {
    if (group.accountId === accountId) return safeText(group.displayName, 120);
  }
  return safeText(accountId, 120);
}

function flattenHiveContextEntries(sourcePacket = {}) {
  const groups = Array.isArray(sourcePacket?.hiveContext?.groups) ? sourcePacket.hiveContext.groups : [];
  return groups.flatMap((group) => (
    Array.isArray(group.entries) ? group.entries.map((entry) => ({
      ...entry,
      accountId: safeText(entry.accountId || group.accountId, 180),
      displayName: safeText(entry.displayName || group.displayName, 120),
    })) : []
  ));
}

function latestHiveInputForAccount({ accountId = "", sourcePacket = {} } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  return flattenHiveContextEntries(sourcePacket)
    .filter((entry) => entry.accountId === normalizedAccountId && safeText(entry.sourceConversationId, 180))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function resolveMessageTarget({ decision, sourcePacket }) {
  const targetType = safeText(decision.target_type, 120);
  const targetId = safeText(decision.target_id, 180);
  const entries = flattenHiveContextEntries(sourcePacket);
  if (targetType === "hive_context_entry") {
    const entry = entries.find((item) => item.id === targetId);
    if (!entry) throw new Error("board_manager_message_user_hive_input_not_found");
    return {
      accountId: safeText(entry.accountId, 180),
      conversationId: safeText(entry.sourceConversationId, 180) || hiveConversationIdForAccount(entry.accountId),
      hiveContextEntryId: safeText(entry.id, 180),
      displayName: safeText(entry.displayName, 120),
    };
  }

  const accountId = targetId;
  const entry = latestHiveInputForAccount({ accountId, sourcePacket });
  return {
    accountId,
    conversationId: safeText(entry?.sourceConversationId, 180) || hiveConversationIdForAccount(accountId),
    hiveContextEntryId: safeText(entry?.id, 180),
    displayName: safeText(entry?.displayName, 120) || displayNameForAccount(sourcePacket, accountId),
  };
}

async function recordResult({ runId, decision, result }) {
  if (!runId) return { ok: true, skipped: true, reason: "run_not_recorded", result };
  return recordBoardManagerActionResult({
    runId,
    action: decision.action,
    targetType: decision.target_type,
    targetId: decision.target_id,
    result,
  });
}

async function executeMessageUser({ runId, decision, sourcePacket }) {
  const target = resolveMessageTarget({ decision, sourcePacket });
  const accountId = target.accountId;
  let conversationId = target.conversationId;
  const messageText = safeText(decision.payload.message_text || decision.payload.summary, 4000);
  if (!accountId) throw new Error("board_manager_message_user_missing_account");
  if (!conversationId) conversationId = hiveConversationIdForAccount(accountId);
  if (!conversationId) throw new Error("board_manager_message_user_missing_conversation");
  if (!messageText) throw new Error("board_manager_message_user_missing_message");
  if (conversationId === hiveConversationIdForAccount(accountId)) {
    const hiveConversation = await ensureHiveConversation({ accountId });
    if (!hiveConversation.ok) {
      throw new Error(`board_manager_message_user_${hiveConversation.error || "hive_chat_unavailable"}`);
    }
    conversationId = hiveConversation.conversation?.conversationId || hiveConversation.conversation?.id || conversationId;
  }
  const messageId = `boardmsg_${randomUUID()}`;
  const assistantMessageId = `msg_${messageId}_assistant`.slice(0, 180);
  const inserted = await query(
    `
      INSERT INTO board_manager_user_messages (
        id,
        run_id,
        account_id,
        display_name,
        message_text,
        status,
        source_action,
        source_packet_digest,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, 'sent', 'message_user', $6, $7::jsonb)
      RETURNING id, account_id, message_text, created_at
    `,
    [
      messageId,
      safeText(runId, 180),
      accountId,
      target.displayName || displayNameForAccount(sourcePacket, accountId),
      messageText,
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue({
        reason: decision.reason,
        next_steps: decision.payload.next_steps,
        conversation_id: conversationId,
        hive_context_entry_id: target.hiveContextEntryId,
        chat_message_id: assistantMessageId,
      }),
    ]
  );
  const chatTurn = await appendAssistantMessage({
    accountId,
    conversationId,
    mode: "Hive",
    provider: "tasknode",
    model: "board_manager",
    responseId: safeText(runId, 180),
    assistantMessage: messageText,
    assistantMessageId,
    assistantMetadata: {
      kind: "hive_manager_response",
      boardManagerRunId: safeText(runId, 180),
      boardManagerMessageId: inserted.rows[0]?.id || messageId,
      hiveContextEntryId: target.hiveContextEntryId,
      sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
      reason: decision.reason,
    },
  });
  return {
    executed: true,
    messageId: inserted.rows[0]?.id || "",
    accountId,
    conversationId,
    chatMessageId: chatTurn.assistant?.id || assistantMessageId,
    messagePreview: messageText.slice(0, 240),
  };
}

async function executeRefreshHiveSecretary({ decision }) {
  const queued = await enqueueHiveSecretaryJob({
    reason: "board_manager_refresh",
    sourceEntryId: safeText(decision.target_id, 180),
  });
  if (queued?.queued) {
    scheduleHiveSecretaryQueue({ delayMs: 250 });
  }
  return {
    executed: true,
    queued: Boolean(queued?.queued),
    jobId: queued?.job?.id || "",
    sourcePacketDigest: queued?.sourcePacket?.sourcePacketDigest || "",
    reason: queued?.reason || "",
  };
}

async function executeCreateProject({ runId, decision, sourcePacket }) {
  const project = safeObject(decision.payload.project);
  const title = safeText(project.title, 180);
  const summary = safeText(project.summary, 600);
  const objective = safeText(project.objective, 900);
  const about = safeText(project.about, 2000);
  const id = slug(project.id || decision.target_id || title);
  const type = projectTypes.has(project.type) ? project.type : "protocol_development";
  if (!title || !summary || !objective) throw new Error("board_manager_create_project_missing_required_fields");
  const hiveSecretary = reportInput(sourcePacket);
  const result = await query(
    `
      INSERT INTO network_projects (
        id,
        type,
        title,
        summary,
        objective,
        about,
        status,
        priority,
        origin,
        proposed_by,
        proposed_at,
        phase_label,
        phase_current,
        phase_total,
        pft_routed,
        task_count,
        contributor_count,
        source_hive_secretary_report_id,
        source_hive_secretary_report_digest,
        source_inputs_json,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'active', $7, 'board_manager', 'board_manager',
        CURRENT_DATE, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        objective = EXCLUDED.objective,
        about = EXCLUDED.about,
        status = 'active',
        priority = EXCLUDED.priority,
        origin = EXCLUDED.origin,
        proposed_by = EXCLUDED.proposed_by,
        phase_label = EXCLUDED.phase_label,
        phase_current = EXCLUDED.phase_current,
        phase_total = EXCLUDED.phase_total,
        pft_routed = EXCLUDED.pft_routed,
        task_count = EXCLUDED.task_count,
        contributor_count = EXCLUDED.contributor_count,
        source_hive_secretary_report_id = EXCLUDED.source_hive_secretary_report_id,
        source_hive_secretary_report_digest = EXCLUDED.source_hive_secretary_report_digest,
        source_inputs_json = EXCLUDED.source_inputs_json,
        metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING id, title, status
    `,
    [
      id,
      type,
      title,
      summary,
      objective,
      about || objective,
      intValue(project.priority, 100),
      safeText(project.phase_label, 100),
      intValue(project.phase_current),
      intValue(project.phase_total),
      numberValue(project.pft_routed),
      intValue(project.task_count),
      intValue(project.contributor_count),
      hiveSecretary.report_id,
      hiveSecretary.source_packet_digest,
      jsonValue({
        inputs: ["board_manager_action", "hive_secretary_report"],
        board_manager: {
          run_id: runId,
          source_packet_digest: sourcePacket.sourcePacketDigest,
        },
        hive_secretary: hiveSecretary,
      }),
      jsonValue({
        board_manager_reason: decision.reason,
        board_manager_created_at: new Date().toISOString(),
      }),
    ]
  );
  return { executed: true, projectId: result.rows[0]?.id || id, status: result.rows[0]?.status || "active" };
}

async function executeArchiveProject({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_archive_project_missing_project");
  const archiveReason = safeText(decision.payload.archive_reason || decision.reason, 1000);
  const result = await query(
    `
      UPDATE network_projects
      SET status = 'archived',
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING id, title, status
    `,
    [
      projectId,
      jsonValue({
        operator_archived: true,
        archived_reason: archiveReason,
        archived_by: "board_manager",
        archived_run_id: safeText(runId, 180),
        archived_source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        archived_at: new Date().toISOString(),
      }),
    ]
  );
  if (!result.rows[0]) throw new Error("board_manager_archive_project_not_found");
  return { executed: true, projectId, status: result.rows[0].status, archiveReason };
}

async function executeAssignContributor({ runId, decision, sourcePacket }) {
  const contributor = safeObject(decision.payload.contributor);
  const projectId = safeText(contributor.project_id || decision.target_id, 180);
  const walletAddress = safeText(contributor.wallet_address, 120);
  if (!projectId) throw new Error("board_manager_assign_contributor_missing_project");
  if (!walletAddress) throw new Error("board_manager_assign_contributor_missing_wallet");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_assign_contributor_project_not_found");
  const result = await query(
    `
      INSERT INTO network_project_contributors (
        project_id,
        wallet_address,
        codename,
        archetype,
        allotted,
        cap,
        load,
        status,
        role_label,
        sort_order,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (project_id, wallet_address) DO UPDATE SET
        codename = EXCLUDED.codename,
        archetype = EXCLUDED.archetype,
        allotted = EXCLUDED.allotted,
        cap = EXCLUDED.cap,
        load = EXCLUDED.load,
        status = EXCLUDED.status,
        role_label = EXCLUDED.role_label,
        sort_order = EXCLUDED.sort_order,
        metadata_json = network_project_contributors.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING project_id, wallet_address, status
    `,
    [
      projectId,
      walletAddress,
      safeText(contributor.codename, 120) || safeText(contributor.account_id, 120) || "Operator",
      safeText(contributor.archetype, 180),
      Boolean(contributor.allotted),
      intValue(contributor.cap),
      intValue(contributor.load),
      safeText(contributor.status, 80) || "active",
      safeText(contributor.role_label, 80),
      intValue(contributor.sort_order, 100),
      jsonValue({
        account_id: safeText(contributor.account_id, 180),
        board_manager_run_id: safeText(runId, 180),
        board_manager_reason: decision.reason,
        source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
      }),
    ]
  );
  return {
    executed: true,
    projectId: result.rows[0]?.project_id || projectId,
    walletAddress: result.rows[0]?.wallet_address || walletAddress,
    status: result.rows[0]?.status || "active",
  };
}

async function executeRefreshProjectDocument({ runId, decision, sourcePacket }) {
  const projectId = safeText(decision.target_id || decision.payload.project?.id, 180);
  if (!projectId) throw new Error("board_manager_refresh_project_document_missing_project");
  const exists = await query("SELECT id FROM network_projects WHERE id = $1 AND status <> 'archived'", [projectId]);
  if (!exists.rows[0]) throw new Error("board_manager_refresh_project_document_project_not_found");
  const document = safeObject(decision.payload.project_document);
  if (!safeText(document.project_status || document.projectStatus, 1800)) {
    throw new Error("board_manager_refresh_project_document_missing_project_status");
  }
  const source = await buildHiveProjectProductDocSourcePacket({
    projectId,
    boardSourcePacket: sourcePacket,
  });
  const run = runId
    ? await query("SELECT model, reasoning_effort FROM board_manager_runs WHERE id = $1 LIMIT 1", [runId])
    : { rows: [] };
  const completed = await completeHiveProjectProductDoc({
    projectId,
    output: document,
    sourcePacket: source,
    boardManagerRunId: runId,
    provider: "codex_exec",
    model: safeText(run.rows[0]?.model || "board_manager", 160),
    promptVersion: boardManagerPromptVersion,
    usage: {
      source: "board_manager_decision",
      reasoningEffort: safeText(run.rows[0]?.reasoning_effort, 40),
    },
  });
  return {
    executed: true,
    projectId,
    productDocId: completed.doc?.id || "",
    sourcePacketDigest: source.sourcePacketDigest,
    title: completed.doc?.title || "",
    model: completed.doc?.model || "",
    promptVersion: completed.doc?.promptVersion || boardManagerPromptVersion,
  };
}

async function executeInitiateNetworkTask({ runId, decision, sourcePacket }) {
  let enqueued;
  try {
    enqueued = await enqueueNetworkTaskGenerationFromBoardDecision({
      runId,
      decision,
      sourcePacket,
    });
  } catch (error) {
    if (error?.message === "network_task_candidate_at_capacity") {
      return {
        executed: false,
        skipped: true,
        reason: "network_task_candidate_at_capacity",
      };
    }
    throw error;
  }
  const scheduled = scheduleNetworkTaskGenerationQueue({
    delayMs: 250,
    limit: 2,
    reason: "board_manager_initiate_network_task",
  });
  return {
    ...enqueued,
    workerScheduled: scheduled,
  };
}

export async function executeBoardManagerDecision({
  runId = "",
  decision = {},
  sourcePacket = {},
  dryRun = true,
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedDecision = normalizeBoardManagerDecision(decision);
  if (dryRun) {
    const result = { executed: false, dryRun: true, action: normalizedDecision.action };
    await recordResult({ runId, decision: normalizedDecision, result });
    return { ok: true, result };
  }

  let result;
  try {
    switch (normalizedDecision.action) {
      case "do_nothing":
        result = { executed: true, action: "do_nothing" };
        break;
      case "message_user":
        result = await executeMessageUser({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_hive_secretary":
        result = await executeRefreshHiveSecretary({ decision: normalizedDecision });
        break;
      case "create_project":
        result = await executeCreateProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "archive_project":
        result = await executeArchiveProject({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "assign_contributor":
        result = await executeAssignContributor({ runId, decision: normalizedDecision, sourcePacket });
        break;
      case "refresh_project_document":
        result = await executeRefreshProjectDocument({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      case "initiate_network_task":
        result = await executeInitiateNetworkTask({
          runId,
          decision: normalizedDecision,
          sourcePacket,
        });
        break;
      default:
        throw new Error(`board_manager_action_not_implemented:${normalizedDecision.action}`);
    }
  } catch (error) {
    const failure = {
      executed: false,
      error: error?.message || String(error),
      action: normalizedDecision.action,
    };
    await recordResult({ runId, decision: normalizedDecision, result: failure }).catch(() => null);
    throw error;
  }
  await recordResult({ runId, decision: normalizedDecision, result });
  return { ok: true, result };
}
