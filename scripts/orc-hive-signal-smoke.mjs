import assert from "node:assert/strict";
import {
  buildOrcHiveSignalMetadata,
  parseArgs,
  resolveSignalTarget,
  sendOrcHiveSignal,
  verifyOrcHiveSignalDelivery,
} from "./orc-hive-signal.mjs";

const taskId = "task_orc_signal_smoke";
const accountId = "acct_orc_signal";
const defaultConversationId = `account_${accountId}_hive`;

function taskRow(overrides = {}) {
  return {
    task_id: taskId,
    account_id: accountId,
    subject_wallet: "rOrcSignalOwner",
    status: "accepted",
    title: "Review Orc Signal Smoke",
    task_kind: "network",
    reward_actual_pft: "0.000000",
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function deliveryRow({ messageId = "msg_orcsignal_test_assistant", overrides = {} } = {}) {
  return {
    id: messageId,
    account_id: accountId,
    conversation_id: defaultConversationId,
    role: "assistant",
    body: "Reviewed and closed.",
    metadata_json: {
      kind: "orc_hive_signal",
      senderType: "machine_agent",
      agentOrigin: {
        agent: true,
        actorType: "machine_agent",
        agentHandle: "grashnuk",
        walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
        client: "orc-hive-signal",
      },
    },
    created_at: "2026-06-19T00:01:00.000Z",
    ...overrides,
  };
}

function fixtureDeps({ rows = [taskRow()], deliveryRows, databaseEnabledValue = true } = {}) {
  const calls = {
    queries: [],
    ensured: [],
    appended: [],
  };
  return {
    calls,
    databaseEnabledImpl: () => databaseEnabledValue,
    queryImpl: async (sql, params) => {
      calls.queries.push({ sql, params });
      if (String(sql).includes("FROM chat_messages")) {
        return { rows: deliveryRows === undefined ? [deliveryRow({ messageId: params[0] })] : deliveryRows };
      }
      return { rows };
    },
    ensureHiveConversationImpl: async (input) => {
      calls.ensured.push(input);
      return {
        ok: true,
        conversation: {
          id: defaultConversationId,
          conversationId: defaultConversationId,
        },
      };
    },
    appendAssistantMessageImpl: async (input) => {
      calls.appended.push(input);
      return { assistant: { id: input.assistantMessageId } };
    },
  };
}

{
  const parsed = parseArgs([
    "--task-id",
    taskId,
    "--message",
    "Signal user.",
    "--reviewer-handle",
    "grashnuk",
    "--metadata-json",
    "{\"reviewState\":\"done\"}",
    "--json",
  ]);
  assert.equal(parsed.taskId, taskId);
  assert.equal(parsed.message, "Signal user.");
  assert.equal(parsed.reviewerHandle, "grashnuk");
  assert.deepEqual(parsed.extraMetadata, { reviewState: "done" });
  assert.equal(parsed.json, true);
}

{
  const deps = fixtureDeps();
  const result = await sendOrcHiveSignal({
    taskId,
    message: "Reviewed and closed.",
    reviewerHandle: "grashnuk",
    extraMetadata: { reviewState: "reviewed_follow_up_completed" },
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(result.accountId, accountId);
  assert.equal(result.conversationId, defaultConversationId);
  assert.equal(result.metadata.kind, "orc_hive_signal");
  assert.deepEqual(result.metadata.extraMetadataKeys, ["reviewState"]);
  assert.equal(deps.calls.ensured.length, 0, "dry-run must not create the Hive conversation");
  assert.equal(deps.calls.appended.length, 0, "dry-run must not append a chat message");
}

{
  const deps = fixtureDeps();
  const result = await sendOrcHiveSignal({
    taskId,
    message: "Reviewed and closed.",
    reviewerHandle: "grashnuk",
    reviewerWallet: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
    reason: "operator_review_notice",
    extraMetadata: { reviewState: "done" },
    execute: true,
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.match(result.chatMessageId, /^msg_orcsignal_/);
  assert.equal(result.deliveryVerified, true);
  assert.equal(result.visibleInHiveChat, true);
  assert.equal(result.delivery.chatMessageId, result.chatMessageId);
  assert.equal(result.delivery.kind, "orc_hive_signal");
  assert.equal(result.delivery.senderType, "machine_agent");
  assert.equal(result.delivery.agentHandle, "grashnuk");
  assert.equal(deps.calls.ensured.length, 1);
  assert.deepEqual(deps.calls.ensured[0], { accountId });
  assert.equal(deps.calls.appended.length, 1);
  const appended = deps.calls.appended[0];
  assert.equal(appended.accountId, accountId);
  assert.equal(appended.conversationId, defaultConversationId);
  assert.equal(appended.mode, "Hive");
  assert.equal(appended.model, "orc_hive_signal");
  assert.equal(appended.assistantMessage, "Reviewed and closed.");
  assert.equal(appended.assistantMetadata.kind, "orc_hive_signal");
  assert.equal(appended.assistantMetadata.senderType, "machine_agent");
  assert.equal(appended.assistantMetadata.agentOrigin.agentHandle, "grashnuk");
  assert.equal(appended.assistantMetadata.agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");
  assert.equal(appended.assistantMetadata.taskId, taskId);
  assert.equal(appended.assistantMetadata.taskTitle, "Review Orc Signal Smoke");
  assert.deepEqual(appended.assistantMetadata.extra, { reviewState: "done" });
}

{
  const deps = fixtureDeps();
  const conversationId = "account_acct_orc_signal_manual_hive";
  const result = await sendOrcHiveSignal({
    taskId,
    message: "Manual conversation override.",
    conversationId,
    execute: true,
    deps,
  });
  assert.equal(result.conversationId, conversationId);
  assert.equal(deps.calls.ensured.length, 0, "explicit conversation must not be auto-created");
  assert.equal(deps.calls.appended[0].conversationId, conversationId);
}

{
  const deps = fixtureDeps({ deliveryRows: [] });
  await assert.rejects(
    () => sendOrcHiveSignal({
      taskId,
      message: "Should fail read-back.",
      reviewerHandle: "grashnuk",
      execute: true,
      deps,
    }),
    /not readable from the recipient Hive chat/
  );
  assert.equal(deps.calls.appended.length, 1, "the smoke simulates an insert that cannot be read back");
}

{
  await assert.rejects(
    () => verifyOrcHiveSignalDelivery({
      accountId,
      conversationId: defaultConversationId,
      chatMessageId: "msg_bad",
      reviewerHandle: "grashnuk",
      queryImpl: async () => ({
        rows: [
          deliveryRow({
            messageId: "msg_bad",
            overrides: {
              metadata_json: { kind: "hive_manager_response", senderType: "machine_agent" },
            },
          }),
        ],
      }),
    }),
    /failed verification: kind/
  );
}

{
  const deps = fixtureDeps({ rows: [] });
  await assert.rejects(
    () => sendOrcHiveSignal({ taskId: "task_missing", message: "Signal.", deps }),
    /task owner account could not be resolved/
  );
}

{
  const deps = fixtureDeps({ rows: [], databaseEnabledValue: false });
  const target = await resolveSignalTarget({
    taskId: "task_db_free",
    accountId: "acct_explicit",
    databaseEnabledImpl: deps.databaseEnabledImpl,
    queryImpl: deps.queryImpl,
    requireDatabaseForLookup: false,
  });
  assert.equal(target.accountId, "acct_explicit");
  assert.equal(target.conversationId, "account_acct_explicit_hive");
  assert.equal(deps.calls.queries.length, 0, "explicit-account dry-run does not need the DB");
}

{
  const metadata = buildOrcHiveSignalMetadata({
    task: {
      taskId,
      title: "Review Orc Signal Smoke",
      status: "accepted",
      taskKind: "network",
      wallet: "rOrcSignalOwner",
      rewardActualPft: "0.000000",
      updatedAt: "2026-06-19T00:00:00.000Z",
    },
    reviewerHandle: "grashnuk",
    extraMetadata: { reviewState: "done" },
  });
  assert.equal(metadata.kind, "orc_hive_signal");
  assert.equal(metadata.senderType, "machine_agent");
  assert.equal(metadata.agentOrigin.agentHandle, "grashnuk");
  assert.equal(metadata.source, "scripts/orc-hive-signal.mjs");
  assert.equal(metadata.taskId, taskId);
  assert.deepEqual(metadata.extra, { reviewState: "done" });
}

console.log("orc-hive-signal-smoke ok");
