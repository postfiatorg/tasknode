import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { getChatMessages } from "../server/repositories/chat-billing-read.js";
import { listChatConversations, searchChatConversations } from "../server/repositories/chat-conversations.js";
import { getContextHistory } from "../server/repositories/context.js";
import { getTaskDetail, listTaskState } from "../server/repositories/tasks.js";
import { buildRecentChats } from "../src/features/chat/chat-surface-state.js";
import {
  getLegacyChatMessages,
  getLegacyTaskDetail,
  legacyChatTitle,
  legacyConversationId,
  listLegacyChatConversations,
  listLegacyContextRows,
  listLegacyTasks,
} from "../server/repositories/legacy-pftasks-history.js";

assert.equal(legacyChatTitle("llm:brainstorming"), "Brainstorming history");
assert.equal(legacyChatTitle("task_personal"), "Task Personal task history");
assert.equal(
  legacyConversationId({ legacyUserId: "user-1", chatType: "chat" }),
  legacyConversationId({ legacyUserId: "user-1", chatType: "chat" }),
  "conversation ids must be stable"
);
assert.deepEqual(
  buildRecentChats([{
    id: "legacy-conversation",
    title: "Historical conversation",
    source: "legacy_pftasks_archive",
    readOnly: true,
  }])[0],
  {
    id: "legacy-conversation",
    conversationId: "legacy-conversation",
    kind: "",
    virtual: false,
    source: "legacy_pftasks_archive",
    readOnly: true,
    title: "Historical conversation",
    lastMessagePreview: "",
    messageCount: 0,
    updatedAt: "",
    unreadCount: 0,
    unread: false,
  },
  "the client must preserve historical read-only metadata"
);

if (!databaseEnabled()) {
  console.log("legacy PFTasks history smoke ok (pure checks; database not configured)");
  process.exit(0);
}

await migrateDatabase();
const suffix = randomUUID();
const accountA = `acct_legacy_a_${suffix}`;
const accountB = `acct_legacy_b_${suffix}`;
const walletA = `rLegacyA${suffix}`;
const walletB = `rLegacyB${suffix}`;
const legacyUser = `legacy-user-${suffix}`;
const conversationId = legacyConversationId({ legacyUserId: legacyUser, chatType: "chat" });
const sourceTaskId = `task-source-${suffix}`;
const publicTaskId = `legacy_pftasks_task_${sourceTaskId}`;

try {
  await query(
    `INSERT INTO account_linked_wallets (account_id, wallet_address, status)
     VALUES ($1, $2, 'linked'), ($3, $4, 'linked')`,
    [accountA, walletA, accountB, walletB]
  );
  await query(
    `INSERT INTO legacy_pftasks_chat_messages (
       source_message_id, legacy_user_id, wallet_address, conversation_id,
       chat_type, role, body, source_created_at
     ) VALUES
       ($1, $2, $3, $4, 'chat', 'user', 'first historical message', '2026-03-01T00:00:00Z'),
       ($5, $2, $3, $4, 'chat', 'assistant', 'second historical message', '2026-03-01T00:00:01Z')`,
    [`msg-a-${suffix}`, legacyUser, walletA, conversationId, `msg-b-${suffix}`]
  );
  await query(
    `INSERT INTO legacy_pftasks_tasks (
       source_task_id, legacy_user_id, wallet_address, title, description,
       source_status, task_category, reward_amount_actual, source_created_at
     ) VALUES ($1, $2, $3, 'Historical task', 'Preserved description',
               'rewarded', 'personal', 12.5, '2026-03-02T00:00:00Z')`,
    [sourceTaskId, legacyUser, walletA]
  );
  await query(
    `INSERT INTO legacy_pftasks_context_revisions (
       source_revision_id, legacy_user_id, wallet_address, cid, word_count, source_created_at
     ) VALUES ($1, $2, $3, 'bafy-legacy-context', 321, '2026-03-03T00:00:00Z')`,
    [`context-${suffix}`, legacyUser, walletA]
  );

  const conversationsA = await listLegacyChatConversations({ accountId: accountA });
  assert.equal(conversationsA.length, 1);
  assert.equal(conversationsA[0].messageCount, 2);
  assert.equal(conversationsA[0].readOnly, true);
  assert.deepEqual(await listLegacyChatConversations({ accountId: accountB }), [], "wallet B must not read wallet A chats");

  const messagesA = await getLegacyChatMessages({ accountId: accountA, conversationId });
  assert.deepEqual(messagesA.map((row) => row.body), ["first historical message", "second historical message"]);
  assert.deepEqual(
    await getLegacyChatMessages({ accountId: accountB, conversationId }),
    [],
    "wallet B must not read wallet A messages"
  );

  const tasksA = await listLegacyTasks({ accountId: accountA, walletAddress: walletA });
  assert.equal(tasksA.length, 1);
  assert.equal(tasksA[0].legacyReadOnly, true);
  assert.equal(tasksA[0].statusKey, "rewarded");
  assert.equal((await getLegacyTaskDetail({ accountId: accountA, walletAddress: walletA, taskId: publicTaskId })).task.pft, 12.5);
  assert.equal(await getLegacyTaskDetail({ accountId: accountB, walletAddress: walletB, taskId: publicTaskId }), null);

  const contextsA = await listLegacyContextRows({ accountId: accountA, walletAddress: walletA });
  assert.equal(contextsA.length, 1);
  assert.equal(contextsA[0].cid, "bafy-legacy-context");
  assert.deepEqual(await listLegacyContextRows({ accountId: accountB, walletAddress: walletB }), []);

  const applicationConversations = await listChatConversations({ accountId: accountA });
  assert.equal(applicationConversations.some((row) => row.conversationId === conversationId && row.readOnly), true);
  assert.deepEqual(
    (await getChatMessages({ accountId: accountA, conversationId })).map((row) => row.body),
    ["first historical message", "second historical message"]
  );
  const applicationSearch = await searchChatConversations({ accountId: accountA, query: "historical message" });
  assert.equal(applicationSearch.some((row) => row.conversationId === conversationId && row.readOnly), true);

  const applicationTasks = await listTaskState({ accountId: accountA, walletAddress: walletA });
  assert.equal(applicationTasks.rewarded.some((row) => row.taskId === publicTaskId && row.legacyReadOnly), true);
  assert.equal(applicationTasks.sync.legacyHistoryCount, 1);
  assert.equal((await getTaskDetail({ accountId: accountA, walletAddress: walletA, taskId: publicTaskId })).task.title, "Historical task");

  const applicationContext = await getContextHistory({ accountId: accountA, walletAddress: walletA });
  assert.equal(applicationContext.contextUpdates.some((row) => row.cid === "bafy-legacy-context"), true);
  assert.equal(applicationContext.contextUpdateCount, 1);

  console.log("legacy PFTasks history smoke ok");
} finally {
  await query("DELETE FROM legacy_pftasks_chat_messages WHERE legacy_user_id = $1", [legacyUser]);
  await query("DELETE FROM legacy_pftasks_tasks WHERE legacy_user_id = $1", [legacyUser]);
  await query("DELETE FROM legacy_pftasks_context_revisions WHERE legacy_user_id = $1", [legacyUser]);
  await query("DELETE FROM account_linked_wallets WHERE account_id = ANY($1::text[])", [[accountA, accountB]]);
  await closePool();
}
