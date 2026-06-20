import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import {
  ensureHiveConversation,
  hiveConversationIdForAccount,
} from "../server/repositories/chat-conversations.js";
import { appendAssistantMessage } from "../server/repositories/chat-assistant-messages.js";
import { recordAgentWorkJournal } from "../server/repositories/orc-work-journal.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const SCRIPT_SOURCE = "scripts/orc-hive-signal.mjs";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function safeId(value = "", max = 180) {
  return String(value || "").trim().slice(0, max);
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function messagePreview(message = "") {
  return safeText(message, 180);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function errorWithCode(code, message = code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] || "";
}

function parseMetadataJson(raw = "") {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw errorWithCode("orc_hive_signal_metadata_not_object", "--metadata-json must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw errorWithCode("orc_hive_signal_metadata_invalid_json", "--metadata-json must be valid JSON");
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const taskId = safeId(readArg(argv, "--task-id"));
  const message = String(readArg(argv, "--message") || "").trim();
  const metadata = parseMetadataJson(readArg(argv, "--metadata-json"));
  return {
    taskId,
    message,
    accountId: safeId(readArg(argv, "--account-id")),
    conversationId: safeId(readArg(argv, "--conversation-id")),
    reviewerHandle: safeText(readArg(argv, "--reviewer-handle"), 120),
    reviewerWallet: safeText(readArg(argv, "--reviewer-wallet"), 120),
    reason: safeText(readArg(argv, "--reason"), 500),
    extraMetadata: metadata,
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
  };
}

function usage() {
  return [
    "Usage: node scripts/orc-hive-signal.mjs --task-id <task_id> --message <text> [options]",
    "",
    "Options:",
    "  --execute                       Actually append the Hive Chat assistant message. Default is dry-run.",
    "  --json                          Print machine-readable JSON.",
    "  --account-id <account_id>        Override the resolved task owner account.",
    "  --conversation-id <id>           Override the target conversation.",
    "  --reviewer-handle <handle>       Reviewer handle stored in metadata.",
    "  --reviewer-wallet <wallet>       Reviewer wallet stored in metadata.",
    "  --reason <text>                  Audit reason stored in metadata.",
    "  --metadata-json <json-object>     Extra metadata stored under metadata.extra.",
  ].join("\n");
}

function publicTaskFromRow(row = {}) {
  if (!row || typeof row !== "object") return null;
  return {
    taskId: safeId(row.task_id || row.taskId),
    accountId: safeId(row.account_id || row.accountId),
    wallet: safeText(row.subject_wallet || row.wallet || row.subjectWallet, 120),
    title: safeText(row.title, 240),
    status: safeText(row.status, 80),
    taskKind: safeText(row.task_kind || row.taskKind, 80),
    rewardActualPft: String(row.reward_actual_pft ?? row.rewardActualPft ?? ""),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

async function queryTaskProjection({ taskId, queryImpl = query } = {}) {
  if (!taskId) return null;
  const result = await queryImpl(
    `
      SELECT task_id, account_id, subject_wallet, status, title, task_kind,
             reward_actual_pft::text AS reward_actual_pft, updated_at
      FROM task_projections
      WHERE task_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  return publicTaskFromRow(result.rows[0]);
}

export async function resolveSignalTarget({
  taskId,
  accountId = "",
  conversationId = "",
  queryImpl = query,
  databaseEnabledImpl = databaseEnabled,
  requireDatabaseForLookup = true,
} = {}) {
  const normalizedTaskId = safeId(taskId);
  const explicitAccountId = safeId(accountId);
  const explicitConversationId = safeId(conversationId);
  let task = null;
  let lookupError = null;

  if (normalizedTaskId && databaseEnabledImpl()) {
    try {
      task = await queryTaskProjection({ taskId: normalizedTaskId, queryImpl });
    } catch (error) {
      lookupError = error;
      if (!explicitAccountId) throw error;
    }
  } else if (!explicitAccountId && requireDatabaseForLookup) {
    throw errorWithCode("database_not_configured", "database_not_configured", 503);
  }

  const resolvedAccountId = explicitAccountId || task?.accountId || "";
  if (!resolvedAccountId) {
    throw errorWithCode("orc_hive_signal_task_owner_not_found", "task owner account could not be resolved", 404);
  }

  const resolvedConversationId = explicitConversationId || hiveConversationIdForAccount(resolvedAccountId);
  if (!resolvedConversationId) {
    throw errorWithCode("orc_hive_signal_conversation_not_found", "Hive conversation id could not be resolved", 404);
  }

  return {
    task,
    taskLookupError: lookupError ? lookupError.message || "task_lookup_failed" : "",
    accountId: resolvedAccountId,
    conversationId: resolvedConversationId,
    explicitConversation: Boolean(explicitConversationId),
  };
}

export function buildOrcHiveSignalMetadata({
  task,
  taskId,
  reviewerHandle = "",
  reviewerWallet = "",
  reason = "",
  extraMetadata = {},
} = {}) {
  const metadata = {
    kind: "orc_hive_signal",
    source: SCRIPT_SOURCE,
    senderType: "machine_agent",
    agentOrigin: {
      agent: true,
      actorType: "machine_agent",
      agentHandle: safeText(reviewerHandle, 120),
      walletAddress: safeText(reviewerWallet, 120),
      client: "orc-hive-signal",
    },
    taskId: safeId(task?.taskId || taskId),
    taskTitle: safeText(task?.title, 240),
    taskStatus: safeText(task?.status, 80),
    taskKind: safeText(task?.taskKind, 80),
    taskWallet: safeText(task?.wallet, 120),
    taskRewardActualPft: String(task?.rewardActualPft || ""),
    taskUpdatedAt: task?.updatedAt || null,
    reviewerHandle: safeText(reviewerHandle, 120),
    reviewerWallet: safeText(reviewerWallet, 120),
    reason: safeText(reason, 500),
  };
  const extra = jsonObject(extraMetadata);
  if (Object.keys(extra).length > 0) metadata.extra = extra;
  return metadata;
}

function publicMetadataSummary(metadata = {}) {
  const extra = jsonObject(metadata.extra);
  return {
    kind: metadata.kind || "",
    source: metadata.source || "",
    taskId: metadata.taskId || "",
    taskTitle: metadata.taskTitle || "",
    taskStatus: metadata.taskStatus || "",
    reviewerHandle: metadata.reviewerHandle || "",
    reviewerWallet: metadata.reviewerWallet || "",
    senderType: metadata.senderType || "",
    agentHandle: metadata.agentOrigin?.agentHandle || "",
    reason: metadata.reason || "",
    extraMetadataKeys: Object.keys(extra).sort(),
  };
}

function publicDeliverySummary(row = {}) {
  const metadata = jsonObject(row.metadata_json || row.metadataJson);
  return {
    chatMessageId: safeId(row.id || row.chatMessageId),
    accountId: safeId(row.account_id || row.accountId),
    conversationId: safeId(row.conversation_id || row.conversationId),
    role: safeText(row.role, 40),
    kind: safeText(metadata.kind, 80),
    senderType: safeText(metadata.senderType, 80),
    agentHandle: safeText(metadata.agentOrigin?.agentHandle || metadata.reviewerHandle, 120),
    createdAt: toIso(row.created_at || row.createdAt),
  };
}

function agentOriginForSignal({ metadata = {}, accountId = "" } = {}) {
  const origin = jsonObject(metadata.agentOrigin);
  if (origin.agent !== true && origin.actorType !== "machine_agent") return null;
  return {
    ...origin,
    agent: true,
    actorType: "machine_agent",
    accountId: safeId(origin.accountId || accountId),
  };
}

async function recordOrcHiveSignalWorkJournal({
  metadata = {},
  target = {},
  taskId = "",
  message = "",
  conversationId = "",
  chatMessageId = "",
  idempotent = false,
  deps = {},
} = {}) {
  const agentOrigin = agentOriginForSignal({ metadata, accountId: target.accountId });
  if (!agentOrigin?.agent) return { ok: false, skipped: true, reason: "agent_origin_missing" };
  const recordAgentWorkJournalImpl = deps.recordAgentWorkJournalImpl || recordAgentWorkJournal;
  return recordAgentWorkJournalImpl({
    agentOrigin,
    taskAction: "hive_signal",
    status: "recorded",
    outcomeStatus: "sent",
    accountId: target.accountId,
    sourceTaskId: taskId,
    conversationId,
    chatMessageId,
    messageCharacterCount: String(message || "").length,
    metadata: {
      kind: "orc_hive_signal",
      source: SCRIPT_SOURCE,
      idempotent,
      reason: safeText(metadata.reason, 500),
      taskTitle: safeText(metadata.taskTitle, 240),
      taskStatus: safeText(metadata.taskStatus, 80),
      taskKind: safeText(metadata.taskKind, 80),
    },
    idempotencyKey: `orc_hive_signal:${safeText(
      agentOrigin.walletAddress || agentOrigin.agentHandle || target.accountId,
      120
    )}:${safeId(chatMessageId || taskId)}`,
  }).catch((error) => ({ ok: false, error: error?.message || "orc_work_journal_failed" }));
}

export async function verifyOrcHiveSignalDelivery({
  accountId = "",
  conversationId = "",
  chatMessageId = "",
  reviewerHandle = "",
  queryImpl = query,
} = {}) {
  const normalizedAccountId = safeId(accountId);
  const normalizedConversationId = safeId(conversationId);
  const normalizedMessageId = safeId(chatMessageId);
  if (!normalizedAccountId || !normalizedConversationId || !normalizedMessageId) {
    throw errorWithCode("orc_hive_signal_delivery_incomplete", "Orc signal delivery identifiers were incomplete", 500);
  }

  const result = await queryImpl(
    `
      SELECT id, account_id, conversation_id, role, body, metadata_json, created_at
      FROM chat_messages
      WHERE id = $1
        AND account_id = $2
        AND conversation_id = $3
      LIMIT 1
    `,
    [normalizedMessageId, normalizedAccountId, normalizedConversationId]
  );
  const row = result.rows[0];
  if (!row) {
    throw errorWithCode(
      "orc_hive_signal_delivery_missing",
      "Orc signal was not readable from the recipient Hive chat after insert",
      500
    );
  }

  const metadata = jsonObject(row.metadata_json);
  const actualHandle = safeText(metadata.agentOrigin?.agentHandle || metadata.reviewerHandle, 120);
  const expectedHandle = safeText(reviewerHandle, 120);
  const mismatches = [];
  if (row.role !== "assistant") mismatches.push("role");
  if (metadata.kind !== "orc_hive_signal") mismatches.push("kind");
  if (metadata.senderType !== "machine_agent") mismatches.push("senderType");
  if (expectedHandle && actualHandle !== expectedHandle) mismatches.push("agentHandle");
  if (mismatches.length > 0) {
    throw errorWithCode(
      "orc_hive_signal_delivery_mismatch",
      `Orc signal delivery row failed verification: ${mismatches.join(", ")}`,
      500
    );
  }

  return publicDeliverySummary(row);
}

export async function findExistingOrcHiveSignal({
  accountId = "",
  conversationId = "",
  taskId = "",
  message = "",
  reviewerHandle = "",
  reviewerWallet = "",
  reason = "",
  queryImpl = query,
} = {}) {
  const normalizedAccountId = safeId(accountId);
  const normalizedConversationId = safeId(conversationId);
  const normalizedTaskId = safeId(taskId);
  const normalizedMessage = String(message || "").trim();
  if (!normalizedAccountId || !normalizedConversationId || !normalizedTaskId || !normalizedMessage) {
    return null;
  }

  const result = await queryImpl(
    `
      SELECT id, account_id, conversation_id, role, body, metadata_json, created_at
      FROM chat_messages
      WHERE account_id = $1
        AND conversation_id = $2
        AND role = 'assistant'
        AND body = $3
        AND metadata_json->>'kind' = 'orc_hive_signal'
        AND metadata_json->>'taskId' = $4
        AND COALESCE(metadata_json->>'reviewerHandle', '') = $5
        AND COALESCE(metadata_json->>'reviewerWallet', '') = $6
        AND COALESCE(metadata_json->>'reason', '') = $7
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [
      normalizedAccountId,
      normalizedConversationId,
      normalizedMessage,
      normalizedTaskId,
      safeText(reviewerHandle, 120),
      safeText(reviewerWallet, 120),
      safeText(reason, 500),
    ]
  );
  return result.rows[0] ? publicDeliverySummary(result.rows[0]) : null;
}

export async function sendOrcHiveSignal({
  taskId,
  message,
  accountId = "",
  conversationId = "",
  reviewerHandle = "",
  reviewerWallet = "",
  reason = "",
  extraMetadata = {},
  execute = false,
  deps = {},
} = {}) {
  const normalizedTaskId = safeId(taskId);
  const normalizedMessage = String(message || "").trim();
  if (!normalizedTaskId) {
    throw errorWithCode("orc_hive_signal_task_id_required", "taskId is required");
  }
  if (!normalizedMessage) {
    throw errorWithCode("orc_hive_signal_message_required", "message is required");
  }

  const databaseEnabledImpl = deps.databaseEnabledImpl || databaseEnabled;
  if (execute && !databaseEnabledImpl()) {
    throw errorWithCode("database_not_configured", "database_not_configured", 503);
  }

  const target = await resolveSignalTarget({
    taskId: normalizedTaskId,
    accountId,
    conversationId,
    queryImpl: deps.queryImpl || query,
    databaseEnabledImpl,
    requireDatabaseForLookup: execute,
  });
  const metadata = buildOrcHiveSignalMetadata({
    task: target.task,
    taskId: normalizedTaskId,
    reviewerHandle,
    reviewerWallet,
    reason,
    extraMetadata,
  });

  const baseResult = {
    ok: true,
    dryRun: !execute,
    executed: Boolean(execute),
    taskId: normalizedTaskId,
    accountId: target.accountId,
    conversationId: target.conversationId,
    messagePreview: messagePreview(normalizedMessage),
    metadata: publicMetadataSummary(metadata),
    secretPrinted: false,
  };
  if (target.taskLookupError) baseResult.taskLookupError = target.taskLookupError;

  if (!execute) return baseResult;

  const ensureHiveConversationImpl = deps.ensureHiveConversationImpl || ensureHiveConversation;
  const appendAssistantMessageImpl = deps.appendAssistantMessageImpl || appendAssistantMessage;
  let finalConversationId = target.conversationId;

  if (!target.explicitConversation) {
    const hiveConversation = await ensureHiveConversationImpl({ accountId: target.accountId });
    if (!hiveConversation?.ok || !hiveConversation.conversation?.id) {
      throw errorWithCode(
        hiveConversation?.error || "orc_hive_signal_conversation_not_found",
        hiveConversation?.error || "Hive conversation could not be created",
        hiveConversation?.status || 409
      );
    }
    finalConversationId = hiveConversation.conversation.id;
  }

  const findExistingSignalImpl = deps.findExistingSignalImpl || findExistingOrcHiveSignal;
  const existingSignal = await findExistingSignalImpl({
    accountId: target.accountId,
    conversationId: finalConversationId,
    taskId: normalizedTaskId,
    message: normalizedMessage,
    reviewerHandle,
    reviewerWallet,
    reason,
    queryImpl: deps.queryImpl || query,
  });
  if (existingSignal?.chatMessageId) {
    const verifyDeliveryImpl = deps.verifyDeliveryImpl || verifyOrcHiveSignalDelivery;
    const delivery = await verifyDeliveryImpl({
      accountId: target.accountId,
      conversationId: finalConversationId,
      chatMessageId: existingSignal.chatMessageId,
      reviewerHandle,
      queryImpl: deps.queryImpl || query,
    });
    const orcWorkJournal = await recordOrcHiveSignalWorkJournal({
      metadata,
      target,
      taskId: normalizedTaskId,
      message: normalizedMessage,
      conversationId: finalConversationId,
      chatMessageId: existingSignal.chatMessageId,
      idempotent: true,
      deps,
    });
    return {
      ...baseResult,
      dryRun: false,
      executed: true,
      idempotent: true,
      reason: "existing_orc_hive_signal",
      conversationId: finalConversationId,
      chatMessageId: existingSignal.chatMessageId,
      deliveryVerified: true,
      visibleInHiveChat: true,
      delivery,
      orcWorkJournal,
    };
  }

  const signalId = `orcsignal_${randomUUID()}`;
  const assistantMessageId = `msg_${signalId}_assistant`.slice(0, 180);
  const chatTurn = await appendAssistantMessageImpl({
    accountId: target.accountId,
    conversationId: finalConversationId,
    mode: "Hive",
    provider: "tasknode",
    model: "orc_hive_signal",
    responseId: signalId,
    assistantMessage: normalizedMessage,
    assistantMessageId,
    assistantMetadata: metadata,
  });
  const chatMessageId = chatTurn?.assistant?.id || assistantMessageId;
  const verifyDeliveryImpl = deps.verifyDeliveryImpl || verifyOrcHiveSignalDelivery;
  const delivery = await verifyDeliveryImpl({
    accountId: target.accountId,
    conversationId: finalConversationId,
    chatMessageId,
    reviewerHandle,
    queryImpl: deps.queryImpl || query,
  });
  const orcWorkJournal = await recordOrcHiveSignalWorkJournal({
    metadata,
    target,
    taskId: normalizedTaskId,
    message: normalizedMessage,
    conversationId: finalConversationId,
    chatMessageId,
    idempotent: false,
    deps,
  });

  return {
    ...baseResult,
    dryRun: false,
    executed: true,
    conversationId: finalConversationId,
    chatMessageId,
    deliveryVerified: true,
    visibleInHiveChat: true,
    delivery,
    orcWorkJournal,
  };
}

function errorPayload(error) {
  return {
    ok: false,
    error: error?.code || error?.message || "orc_hive_signal_failed",
    message: error?.message || "orc_hive_signal_failed",
    status: error?.status || 500,
    secretPrinted: false,
  };
}

function printResult(result, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ok) {
    console.error(`${result.error}: ${result.message || result.error}`);
    return;
  }
  console.log(
    result.executed
      ? `Verified Orc Hive signal to ${result.accountId} (${result.chatMessageId || "message queued"})`
      : `Dry-run Orc Hive signal to ${result.accountId} (${result.conversationId})`
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  try {
    const result = await sendOrcHiveSignal(args);
    printResult(result, { json: args.json });
    return 0;
  } catch (error) {
    const result = errorPayload(error);
    printResult(result, { json: args.json });
    return 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await main();
  process.exitCode = code;
}
