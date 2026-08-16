import { randomUUID } from "node:crypto";
import { query } from "./db/pool.js";
import { appendAssistantMessage } from "./repositories/chat-assistant-messages.js";
import {
  ensureHiveConversation,
  hiveConversationIdForAccount,
} from "./repositories/chat-conversations.js";
import {
  createBoardManagerFollowup,
  findOpenBoardManagerFollowup,
} from "./repositories/board-manager-state.js";
import { buildHiveAccountLiveState } from "./repositories/hive-account-live-state.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import {
  guardBoardManagerMessageUserFreshness,
  normalizedBoardManagerMessagePrecondition,
} from "./board-manager-message-policy.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function projectIdForDecision(decision = {}) {
  const payload = safeObject(decision.payload);
  return safeText(
    payload.project?.id ||
      payload.contributor?.project_id ||
      payload.contributor?.projectId ||
      payload.network_task?.project_id ||
      payload.networkTask?.projectId ||
      (decision.target_type === "network_project" ? decision.target_id : ""),
    180
  );
}

function displayNameForAccount(sourcePacket = {}, accountId = "") {
  for (const account of sourcePacket?.actionTargetRegistry?.accounts || []) {
    if (account.accountId === accountId) return safeText(account.displayName, 120);
  }
  for (const group of sourcePacket?.hiveContext?.groups || []) {
    if (group.accountId === accountId) return safeText(group.displayName, 120);
  }
  return safeText(accountId, 120);
}

function flattenHiveContextEntries(sourcePacket = {}) {
  const byId = new Map();
  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    const id = safeText(entry.id, 180);
    if (!id) continue;
    byId.set(id, {
      id,
      accountId: safeText(entry.accountId, 180),
      displayName: safeText(entry.displayName, 120),
      sourceConversationId: safeText(entry.sourceConversationId, 180),
      walletValidated: Boolean(entry.walletValidated),
      walletAddress: safeText(entry.walletAddress, 120),
      createdAt: entry.createdAt || null,
    });
  }
  const groups = Array.isArray(sourcePacket?.hiveContext?.groups) ? sourcePacket.hiveContext.groups : [];
  for (const group of groups) {
    for (const entry of Array.isArray(group.entries) ? group.entries : []) {
      const id = safeText(entry.id, 180);
      if (!id) continue;
      byId.set(id, {
        ...entry,
        id,
        accountId: safeText(entry.accountId || group.accountId, 180),
        displayName: safeText(entry.displayName || group.displayName, 120),
      });
    }
  }
  return [...byId.values()];
}

function latestHiveInputForAccount({ accountId = "", sourcePacket = {} } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  return flattenHiveContextEntries(sourcePacket)
    .filter((entry) => entry.accountId === normalizedAccountId && safeText(entry.sourceConversationId, 180))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function sourceAccountIds(sourcePacket = {}) {
  const ids = new Set();
  for (const account of sourcePacket?.actionTargetRegistry?.accounts || []) {
    const accountId = safeText(account.accountId || account.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const entry of sourcePacket?.actionTargetRegistry?.hiveContextEntries || []) {
    const accountId = safeText(entry.accountId || entry.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const group of sourcePacket?.hiveContext?.groups || []) {
    const accountId = safeText(group.accountId, 180);
    if (accountId) ids.add(accountId);
  }
  for (const candidate of sourcePacket?.networkTaskCandidates || []) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  for (const candidate of sourcePacket?.orcOperations?.routingCandidates || sourcePacket?.orc_operations?.routingCandidates || []) {
    const accountId = safeText(candidate.accountId || candidate.account_id, 180);
    if (accountId) ids.add(accountId);
  }
  return ids;
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
  if (!sourceAccountIds(sourcePacket).has(accountId)) {
    throw new Error("board_manager_message_user_account_not_in_source_packet");
  }
  const entry = latestHiveInputForAccount({ accountId, sourcePacket });
  return {
    accountId,
    conversationId: safeText(entry?.sourceConversationId, 180) || hiveConversationIdForAccount(accountId),
    hiveContextEntryId: safeText(entry?.id, 180),
    displayName: safeText(entry?.displayName, 120) || displayNameForAccount(sourcePacket, accountId),
  };
}


async function findDuplicateMessageDelivery({ accountId = "", hiveContextEntryId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedHiveContextEntryId = safeText(hiveContextEntryId, 180);
  if (!normalizedAccountId || !normalizedHiveContextEntryId) return null;
  const existing = await query(
    `
      SELECT id, run_id, account_id, message_text, created_at, metadata_json
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
        AND metadata_json->>'hive_context_entry_id' = $2
        AND EXISTS (
          SELECT 1
          FROM chat_messages cm
          WHERE cm.id = board_manager_user_messages.metadata_json->>'chat_message_id'
            AND cm.account_id = board_manager_user_messages.account_id
            AND cm.conversation_id = board_manager_user_messages.metadata_json->>'conversation_id'
            AND cm.role = 'assistant'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, normalizedHiveContextEntryId]
  );
  return existing.rows[0] || null;
}

async function findRecentAccountMessageDelivery({ accountId = "", hours = 6 } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return null;
  const windowHours = Math.min(Math.max(Number(hours) || 6, 1), 24);
  const existing = await query(
    `
      SELECT id, run_id, account_id, message_text, created_at, metadata_json
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
        AND created_at > now() - ($2::text || ' hours')::interval
        AND EXISTS (
          SELECT 1
          FROM chat_messages cm
          WHERE cm.id = board_manager_user_messages.metadata_json->>'chat_message_id'
            AND cm.account_id = board_manager_user_messages.account_id
            AND cm.conversation_id = board_manager_user_messages.metadata_json->>'conversation_id'
            AND cm.role = 'assistant'
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, String(windowHours)]
  );
  return existing.rows[0] || null;
}


export async function executeBoardManagerMessageUser({ runId, decision, sourcePacket }) {
  const target = resolveMessageTarget({ decision, sourcePacket });
  const accountId = target.accountId;
  let conversationId = target.conversationId;
  const messageText = safeText(decision.payload.message_text || decision.payload.summary, 4000);
  const projectId = projectIdForDecision(decision);
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
  const accountLiveState = await buildHiveAccountLiveState({ accountId, limit: 12 });
  const messagePreconditionForAudit = normalizedBoardManagerMessagePrecondition(decision);
  const freshnessGuard = guardBoardManagerMessageUserFreshness({
    decision,
    messageText,
    accountLiveState,
  });
  if (!freshnessGuard.ok) {
    return {
      executed: false,
      skipped: true,
      reason: freshnessGuard.reason,
      accountId,
      projectId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      messagePreview: messageText.slice(0, 240),
      freshnessGuard,
    };
  }
  const duplicate = await findDuplicateMessageDelivery({
    accountId,
    hiveContextEntryId: target.hiveContextEntryId,
  });
  if (duplicate) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_message_user_duplicate_hive_context_entry",
      duplicateMessageId: duplicate.id,
      duplicateRunId: duplicate.run_id,
      accountId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      messagePreview: safeText(duplicate.message_text, 240),
    };
  }
  const openFollowup = await findOpenBoardManagerFollowup({
    accountId,
    projectId,
  });
  if (openFollowup) {
    return {
      executed: false,
      skipped: true,
      reason: "board_manager_message_user_open_followup",
      followupId: openFollowup.id,
      accountId,
      projectId,
      conversationId,
      hiveContextEntryId: target.hiveContextEntryId,
      lastSentAt: openFollowup.lastSentAt,
      blockerSummary: openFollowup.blockerSummary,
    };
  }
  if (!target.hiveContextEntryId) {
    const recent = await findRecentAccountMessageDelivery({ accountId });
    if (recent) {
      return {
        executed: false,
        skipped: true,
        reason: "board_manager_message_user_recent_account_message",
        duplicateMessageId: recent.id,
        duplicateRunId: recent.run_id,
        accountId,
        conversationId,
        messagePreview: safeText(recent.message_text, 240),
      };
    }
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
        account_live_state_digest: safeText(accountLiveState.digest, 120),
        account_live_state_snapshot_at: safeText(accountLiveState.snapshotAt, 80),
        message_precondition: messagePreconditionForAudit,
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
      accountLiveStateDigest: safeText(accountLiveState.digest, 120),
      accountLiveStateSnapshotAt: safeText(accountLiveState.snapshotAt, 80),
      messagePrecondition: messagePreconditionForAudit,
      reason: decision.reason,
    },
  });
  const followupRequired = decision.payload.followup_required !== false;
  const followup = followupRequired
    ? await createBoardManagerFollowup({
        runId,
        accountId,
        projectId,
        hiveContextEntryId: target.hiveContextEntryId,
        conversationId,
        boardMessageId: inserted.rows[0]?.id || messageId,
        chatMessageId: chatTurn.assistant?.id || assistantMessageId,
        blockerType: projectId ? "project_blocked_on_user" : "account_followup",
        blockerSummary: safeText(decision.reason || decision.payload.summary, 1200),
        expectedResponse: safeText(decision.payload.next_steps?.join("; ") || decision.payload.summary, 1200),
        sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
        metadata: {
          target_type: decision.target_type,
          target_id: decision.target_id,
          hive_context_entry_id: target.hiveContextEntryId,
          decision_summary: decision.payload.summary,
          account_live_state_digest: safeText(accountLiveState.digest, 120),
          account_live_state_snapshot_at: safeText(accountLiveState.snapshotAt, 80),
          related_task_ids: safeArray(accountLiveState.networkTasks).map((task) => task.taskId).filter(Boolean),
          related_allocation_ids: safeArray(accountLiveState.networkTasks).map((task) => task.allocationId).filter(Boolean),
          message_precondition: messagePreconditionForAudit,
        },
      }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
    : { ok: true, skipped: true, reason: "followup_not_required", followup: null };
  await recordUserObservabilityEvent({
    eventType: "user.hive.board_message_delivered",
    accountId,
    conversationId,
    projectId,
    sourceSurface: "hive",
    sourceRoute: "server/board-manager-message-action.js::executeBoardManagerMessageUser",
    resultStatus: "sent",
    reasonCode: "message_user",
    metadata: {
      boardMessageId: inserted.rows[0]?.id || messageId,
      runId: safeText(runId, 180),
      chatMessageId: chatTurn.assistant?.id || assistantMessageId,
      hiveContextEntryId: target.hiveContextEntryId,
      sourcePacketDigest: safeText(sourcePacket.sourcePacketDigest, 120),
      followupId: followup.followup?.id || "",
      followupCreated: followupRequired && followup.ok === true && followup.idempotent !== true,
      followupRequired,
    },
    metrics: {
      messageCharacterCount: messageText.length,
    },
  }).catch(() => {});
  if (followup.followup?.id) {
    await recordUserObservabilityEvent({
      eventType: "user.hive.followup_opened",
      accountId,
      conversationId,
      projectId,
      sourceSurface: "hive",
      sourceRoute: "server/board-manager-message-action.js::executeBoardManagerMessageUser",
      resultStatus: followup.ok === false ? "failed" : followup.idempotent ? "already_open" : "open",
      reasonCode: followup.ok === false ? followup.error || "followup_open_failed" : "message_user",
      metadata: {
        followupId: followup.followup.id,
        boardMessageId: inserted.rows[0]?.id || messageId,
        runId: safeText(runId, 180),
        blockerType: safeText(followup.followup.blockerType || followup.followup.blocker_type, 120),
      },
    }).catch(() => {});
  }
  return {
    executed: true,
    messageId: inserted.rows[0]?.id || "",
    followupId: followup.followup?.id || "",
    accountId,
    projectId,
    conversationId,
    chatMessageId: chatTurn.assistant?.id || assistantMessageId,
    messagePreview: messageText.slice(0, 240),
  };
}
