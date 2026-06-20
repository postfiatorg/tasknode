import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import { hiveConversationIdForAccount } from "../server/repositories/chat-conversations.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const SCRIPT_SOURCE = "scripts/orc-hive-followup.mjs";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function safeId(value = "", max = 180) {
  return String(value || "").trim().slice(0, max);
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

function messagePreview(message = "") {
  return safeText(message, 180);
}

function digestObject(value = {}) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  return {
    taskId: safeId(readArg(argv, "--task-id")),
    message: String(readArg(argv, "--message") || "").trim(),
    accountId: safeId(readArg(argv, "--account-id")),
    conversationId: safeId(readArg(argv, "--conversation-id")),
    followupRequired: argv.includes("--followup-required"),
    reason: safeText(readArg(argv, "--reason"), 500) || "Orc Hive follow-up",
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
  };
}

function usage() {
  return [
    "Usage: node scripts/orc-hive-followup.mjs --task-id <task_id> --message <text> [options]",
    "",
    "Options:",
    "  --execute                  Deliver through Board Manager message_user. Default is dry-run.",
    "  --json                     Print machine-readable JSON.",
    "  --account-id <account_id>   Override the resolved task owner account.",
    "  --conversation-id <id>      Override the target Hive conversation.",
    "  --followup-required         Open a Board Manager follow-up waiting for the user.",
    "  --reason <text>             Audit reason for the Board Manager decision.",
  ].join("\n");
}

function publicTaskFromRow(row = {}) {
  if (!row || typeof row !== "object") return null;
  return {
    taskId: safeId(row.task_id || row.taskId),
    accountId: safeId(row.account_id || row.accountId),
    wallet: safeText(row.subject_wallet || row.wallet || row.subjectWallet, 120),
    displayName: safeText(row.public_display_name || row.display_name || row.displayName, 120),
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
      SELECT
        task_id,
        account_id,
        subject_wallet,
        status,
        title,
        task_kind,
        reward_actual_pft::text AS reward_actual_pft,
        updated_at
      FROM task_projections
      WHERE task_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  return publicTaskFromRow(result.rows[0]);
}

export async function resolveFollowupTarget({
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
  let taskLookupError = "";

  if (normalizedTaskId && databaseEnabledImpl()) {
    try {
      task = await queryTaskProjection({ taskId: normalizedTaskId, queryImpl });
    } catch (error) {
      taskLookupError = error?.message || "task_lookup_failed";
      if (!explicitAccountId) throw error;
    }
  } else if (!explicitAccountId && requireDatabaseForLookup) {
    throw errorWithCode("database_not_configured", "database_not_configured", 503);
  }

  const resolvedAccountId = explicitAccountId || task?.accountId || "";
  if (!resolvedAccountId) {
    throw errorWithCode("orc_hive_followup_task_owner_not_found", "task owner account could not be resolved", 404);
  }

  return {
    task,
    taskLookupError,
    accountId: resolvedAccountId,
    conversationId: explicitConversationId || hiveConversationIdForAccount(resolvedAccountId),
    explicitConversation: Boolean(explicitConversationId),
    displayName: task?.displayName || resolvedAccountId,
    wallet: task?.wallet || "",
  };
}

export function buildFollowupSourcePacket({
  taskId = "",
  target = {},
  message = "",
  followupRequired = false,
} = {}) {
  const normalizedTaskId = safeId(taskId);
  const accountId = safeId(target.accountId);
  const conversationId = safeId(target.conversationId);
  const useExplicitConversation = Boolean(target.explicitConversation && conversationId);
  const hiveContextEntryId = useExplicitConversation
    ? `orc_followup_${digestObject({ taskId: normalizedTaskId, accountId, conversationId })}`
    : "";
  const account = {
    accountId,
    displayName: safeText(target.displayName || accountId, 120),
    walletAddress: safeText(target.wallet, 120),
  };
  const hiveEntry = hiveContextEntryId
    ? {
        id: hiveContextEntryId,
        accountId,
        displayName: account.displayName,
        sourceConversationId: conversationId,
        walletValidated: Boolean(account.walletAddress),
        walletAddress: account.walletAddress,
        createdAt: new Date().toISOString(),
      }
    : null;
  const digestInput = {
    source: SCRIPT_SOURCE,
    taskId: normalizedTaskId,
    accountId,
    conversationId,
    followupRequired: Boolean(followupRequired),
    messagePreview: messagePreview(message),
  };
  const sourcePacketDigest = digestObject(digestInput);
  return {
    source: SCRIPT_SOURCE,
    sourcePacketDigest,
    generatedAt: new Date().toISOString(),
    actionTargetRegistry: {
      accounts: [account],
      hiveContextEntries: hiveEntry ? [hiveEntry] : [],
    },
    networkTaskCandidates: [account],
    hiveContext: {
      groups: [
        {
          accountId,
          displayName: account.displayName,
          entries: hiveEntry ? [hiveEntry] : [],
        },
      ],
    },
    orcOperations: {
      routingCandidates: [account],
    },
    orcHiveFollowup: {
      taskId: normalizedTaskId,
      task: target.task || null,
      messagePreview: messagePreview(message),
      followupRequired: Boolean(followupRequired),
      source: SCRIPT_SOURCE,
    },
  };
}

export function buildMessageUserDecision({
  taskId = "",
  target = {},
  message = "",
  followupRequired = false,
  reason = "",
} = {}) {
  const sourcePacket = buildFollowupSourcePacket({ taskId, target, message, followupRequired });
  const hiveContextEntry = sourcePacket.actionTargetRegistry.hiveContextEntries[0];
  const nextSteps = followupRequired
    ? ["Reply in Hive if this follow-up needs clarification or follow-through."]
    : [];
  return {
    action: "message_user",
    target_type: hiveContextEntry ? "hive_context_entry" : "account",
    target_id: hiveContextEntry?.id || safeId(target.accountId),
    reason: safeText(reason, 500) || "Orc Hive follow-up",
    confidence: 1,
    payload: {
      summary: messagePreview(message),
      message_text: String(message || "").trim(),
      next_steps: nextSteps,
      followup_required: Boolean(followupRequired),
    },
    decision_basis: {
      source_facts: [
        `Orc follow-up references task ${safeId(taskId)}.`,
        `Target account ${safeId(target.accountId)} was resolved from the task projection or explicit override.`,
      ],
      tradeoffs: [
        followupRequired
          ? "A follow-up is intentionally opened for a user response."
          : "Informational delivery is marked no-follow-up so it does not create fake user work.",
      ],
      rejected_actions: [],
      risk_notes: [],
      next_check: followupRequired ? "Wait for the user response in Hive." : "No user action requested.",
    },
    sourcePacket,
  };
}

function publicTaskSummary(task = null) {
  if (!task) return null;
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    taskKind: task.taskKind,
    rewardActualPft: task.rewardActualPft,
    updatedAt: task.updatedAt,
  };
}

export async function sendOrcHiveFollowup({
  taskId,
  message,
  accountId = "",
  conversationId = "",
  followupRequired = false,
  reason = "",
  execute = false,
  deps = {},
} = {}) {
  const normalizedTaskId = safeId(taskId);
  const normalizedMessage = String(message || "").trim();
  if (!normalizedTaskId) throw errorWithCode("orc_hive_followup_task_id_required", "taskId is required");
  if (!normalizedMessage) throw errorWithCode("orc_hive_followup_message_required", "message is required");

  const databaseEnabledImpl = deps.databaseEnabledImpl || databaseEnabled;
  if (execute && !databaseEnabledImpl()) {
    throw errorWithCode("database_not_configured", "database_not_configured", 503);
  }

  const target = await resolveFollowupTarget({
    taskId: normalizedTaskId,
    accountId,
    conversationId,
    queryImpl: deps.queryImpl || query,
    databaseEnabledImpl,
    requireDatabaseForLookup: execute,
  });
  const { sourcePacket, ...decision } = buildMessageUserDecision({
    taskId: normalizedTaskId,
    target,
    message: normalizedMessage,
    followupRequired,
    reason,
  });
  const baseResult = {
    ok: true,
    dryRun: !execute,
    executed: false,
    taskId: normalizedTaskId,
    accountId: target.accountId,
    conversationId: target.conversationId,
    followupRequired: Boolean(followupRequired),
    messagePreview: messagePreview(normalizedMessage),
    sourcePacketDigest: sourcePacket.sourcePacketDigest,
    task: publicTaskSummary(target.task),
    secretPrinted: false,
  };
  if (target.taskLookupError) baseResult.taskLookupError = target.taskLookupError;
  if (!execute) return baseResult;

  const executeBoardManagerDecisionImpl = deps.executeBoardManagerDecisionImpl || executeBoardManagerDecision;
  const hookResult = await executeBoardManagerDecisionImpl({
    runId: "",
    decision,
    sourcePacket,
    dryRun: false,
  });
  const actionResult = hookResult?.result || {};
  if (hookResult?.ok === false || actionResult.skipped || !actionResult.executed) {
    return {
      ...baseResult,
      ok: false,
      dryRun: false,
      executed: false,
      skipped: Boolean(actionResult.skipped || hookResult?.skipped),
      error: actionResult.reason || hookResult?.reason || "orc_hive_followup_not_delivered",
      result: actionResult,
    };
  }

  return {
    ...baseResult,
    dryRun: false,
    executed: true,
    boardManagerMessageId: actionResult.messageId || "",
    chatMessageId: actionResult.chatMessageId || "",
    followupId: actionResult.followupId || "",
    result: {
      accountId: actionResult.accountId || target.accountId,
      conversationId: actionResult.conversationId || target.conversationId,
      projectId: actionResult.projectId || "",
      messagePreview: actionResult.messagePreview || messagePreview(normalizedMessage),
    },
  };
}

function errorPayload(error) {
  return {
    ok: false,
    error: error?.code || error?.message || "orc_hive_followup_failed",
    message: error?.message || "orc_hive_followup_failed",
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
      ? `Verified Orc Hive follow-up to ${result.accountId} (${result.chatMessageId || "message queued"})`
      : `Dry-run Orc Hive follow-up to ${result.accountId} (${result.conversationId})`
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  try {
    const result = await sendOrcHiveFollowup(args);
    printResult(result, { json: args.json });
    return result.ok ? 0 : 1;
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
