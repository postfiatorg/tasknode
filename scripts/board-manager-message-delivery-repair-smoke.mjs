#!/usr/bin/env node

import assert from "node:assert/strict";

import { repairUndeliveredMessages } from "./board-manager-message-delivery-repair.mjs";

const candidateRows = [
  {
    id: "bmmsg_null_metadata",
    run_id: "bmrun_1",
    account_id: "acct_needs_lookup",
    message_text: "Visible repaired Board Manager message",
    metadata_json: null,
    created_at: "2026-06-20T00:00:00.000Z",
    trigger: "manual",
    manager_id: "board-manager",
  },
  {
    id: "bmmsg_metadata_conversation",
    run_id: "bmrun_2",
    account_id: "acct_metadata",
    message_text: "Already-addressed repaired Board Manager message",
    metadata_json: { conversation_id: "hive_convo_from_metadata" },
    created_at: "2026-06-20T00:01:00.000Z",
    trigger: "manual",
    manager_id: "board-manager",
  },
  {
    id: "bmmsg_missing_conversation",
    run_id: "bmrun_3",
    account_id: "acct_missing_conversation",
    message_text: "Unrepairable Board Manager message",
    metadata_json: {},
    created_at: "2026-06-20T00:02:00.000Z",
    trigger: "manual",
    manager_id: "board-manager",
  },
];

function createQueryMock({ existingChatMessageIds = new Set() } = {}) {
  const calls = [];
  const updates = [];
  async function queryImpl(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes("FROM board_manager_user_messages")) return { rows: candidateRows };
    if (sql.includes("FROM hive_context_entries")) {
      if (params[0] === "acct_needs_lookup") {
        return { rows: [{ source_conversation_id: "hive_convo_from_lookup" }] };
      }
      return { rows: [] };
    }
    if (sql.includes("FROM chat_messages")) {
      return { rows: existingChatMessageIds.has(params[0]) ? [{ id: params[0] }] : [] };
    }
    if (sql.includes("UPDATE board_manager_user_messages")) {
      updates.push({ sql, params });
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
  return { queryImpl, calls, updates };
}

const disabled = await repairUndeliveredMessages({
  databaseEnabledImpl: () => false,
});
assert.equal(disabled.ok, false);
assert.equal(disabled.skipped, true);
assert.equal(disabled.reason, "database_not_configured");

{
  const { queryImpl, calls, updates } = createQueryMock();
  const appended = [];
  const dryRun = await repairUndeliveredMessages({
    apply: false,
    queryImpl,
    appendAssistantMessageImpl: async (payload) => appended.push(payload),
    databaseEnabledImpl: () => true,
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.candidateCount, 3);
  assert.equal(dryRun.repaired.length, 2);
  assert.equal(dryRun.skipped.length, 1);
  assert.equal(appended.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(calls.filter((call) => call.sql.includes("FROM chat_messages")).length, 0);
}

{
  const existingChatMessageIds = new Set(["msg_bmmsg_metadata_conversation_assistant"]);
  const { queryImpl, updates } = createQueryMock({ existingChatMessageIds });
  const appended = [];
  const applied = await repairUndeliveredMessages({
    apply: true,
    queryImpl,
    appendAssistantMessageImpl: async (payload) => appended.push(payload),
    databaseEnabledImpl: () => true,
    now: () => "2026-06-20T01:00:00.000Z",
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.apply, true);
  assert.equal(applied.repaired.length, 2);
  assert.equal(applied.skipped.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].accountId, "acct_needs_lookup");
  assert.equal(appended[0].conversationId, "hive_convo_from_lookup");
  assert.equal(appended[0].assistantMessageId, "msg_bmmsg_null_metadata_assistant");
  assert.equal(appended[0].assistantMetadata.repairedDelivery, true);

  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.match(update.sql, /COALESCE\(metadata_json, '\{\}'::jsonb\) \|\| \$2::jsonb/);
    const metadata = JSON.parse(update.params[1]);
    assert.equal(metadata.delivery_repaired_at, "2026-06-20T01:00:00.000Z");
    assert.ok(metadata.conversation_id);
    assert.ok(metadata.chat_message_id);
  }

  const nullMetadataUpdate = updates.find((update) => update.params[0] === "bmmsg_null_metadata");
  assert.equal(JSON.parse(nullMetadataUpdate.params[1]).delivery_repair_source, "latest_hive_context_before_message");

  const metadataConversationUpdate = updates.find((update) => update.params[0] === "bmmsg_metadata_conversation");
  assert.equal(JSON.parse(metadataConversationUpdate.params[1]).delivery_repair_source, "metadata");
}

console.log("board manager message delivery repair smoke ok");
