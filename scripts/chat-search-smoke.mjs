import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import {
  appendChatUserMessage,
  deleteChatConversation,
  searchChatConversations,
} from "../server/repositories/chat-conversations.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

if (!databaseEnabled()) {
  console.log("chat search smoke skipped: database not configured");
  process.exit(0);
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountA = `acct_search_a_${suffix}`;
const accountB = `acct_search_b_${suffix}`;
const accountIds = [accountA, accountB];

const conversationA1 = `account_${accountA}_zebra`;
const conversationA2 = `account_${accountA}_discount`;
const conversationA3 = `account_${accountA}_control`;
const conversationA4 = `account_${accountA}_deleted`;
const conversationB1 = `account_${accountB}_zebra`;

const conversationIds = (results) => results.map((row) => row.conversationId);

try {
  await appendChatUserMessage({
    accountId: accountA,
    conversationId: conversationA1,
    conversationTitle: "Alpha zebra strategy",
    userMessage: "Tell me about the unicorn budget forecast for spring planting season.",
  });
  await appendChatUserMessage({
    accountId: accountA,
    conversationId: conversationA2,
    conversationTitle: "Discount planning",
    userMessage: "The discount is 10% off_list today only.",
  });
  await appendChatUserMessage({
    accountId: accountA,
    conversationId: conversationA3,
    conversationTitle: "Control conversation",
    userMessage: "The discount is 10x offYlist today only.",
  });
  await appendChatUserMessage({
    accountId: accountA,
    conversationId: conversationA4,
    conversationTitle: "Deleted zebra thread",
    userMessage: "This zebra conversation gets deleted.",
  });
  const deleted = await deleteChatConversation({ accountId: accountA, conversationId: conversationA4 });
  assert.equal(deleted.ok, true, "fixture conversation should soft-delete");
  await appendChatUserMessage({
    accountId: accountB,
    conversationId: conversationB1,
    conversationTitle: "Beta zebra strategy",
    userMessage: "Account B talks about something entirely different.",
  });

  // (a) Title match returns the conversation.
  const titleResults = await searchChatConversations({ accountId: accountA, query: "zebra" });
  assert.equal(conversationIds(titleResults).includes(conversationA1), true, "title match should return A1");
  const titleRow = titleResults.find((row) => row.conversationId === conversationA1);
  assert.equal(titleRow.matchSource, "title");
  assert.equal(titleRow.title, "Alpha zebra strategy");

  // (b) Message-content match returns the conversation with a matching snippet.
  const messageResults = await searchChatConversations({ accountId: accountA, query: "unicorn budget" });
  const messageRow = messageResults.find((row) => row.conversationId === conversationA1);
  assert.ok(messageRow, "message match should return A1");
  assert.equal(messageRow.matchSource, "message");
  assert.equal(messageRow.snippet.toLowerCase().includes("unicorn budget"), true, "snippet should contain match");

  // (c) Account isolation, asserted in both directions.
  assert.equal(
    conversationIds(titleResults).some((id) => id === conversationB1),
    false,
    "account A search must never return account B conversations"
  );
  const accountBTitleResults = await searchChatConversations({ accountId: accountB, query: "zebra" });
  assert.deepEqual(
    conversationIds(accountBTitleResults),
    [conversationB1],
    "account B search must only return account B conversations"
  );
  const accountBMessageResults = await searchChatConversations({ accountId: accountB, query: "unicorn budget" });
  assert.deepEqual(accountBMessageResults, [], "account B must not see account A message content");
  const accountACrossTitle = await searchChatConversations({ accountId: accountA, query: "Beta zebra" });
  assert.deepEqual(accountACrossTitle, [], "account A must not see account B titles");

  // (d) ILIKE wildcards in the query are treated literally.
  const literalWildcardResults = await searchChatConversations({ accountId: accountA, query: "10% off_list" });
  assert.deepEqual(
    conversationIds(literalWildcardResults),
    [conversationA2],
    "wildcard query must match the literal text only, not the wildcard-pattern control row"
  );
  const wildcardMissResults = await searchChatConversations({ accountId: accountA, query: "10%_off" });
  assert.deepEqual(wildcardMissResults, [], "escaped wildcards must not match anything");

  // (e) Deleted conversations are excluded.
  assert.equal(
    conversationIds(titleResults).includes(conversationA4),
    false,
    "deleted conversation must be excluded from search"
  );
  const deletedBodyResults = await searchChatConversations({ accountId: accountA, query: "gets deleted" });
  assert.deepEqual(deletedBodyResults, [], "deleted conversation messages must be excluded from search");

  // (f) Short queries return empty.
  const shortQueryResults = await searchChatConversations({ accountId: accountA, query: "z" });
  assert.deepEqual(shortQueryResults, [], "short query must return no results");

  console.log("chat search smoke ok");
} finally {
  await query("DELETE FROM chat_attachments WHERE account_id = ANY($1)", [accountIds]);
  await query("DELETE FROM chat_messages WHERE account_id = ANY($1)", [accountIds]);
  await query("DELETE FROM chat_conversations WHERE account_id = ANY($1)", [accountIds]);
  await closePool();
}
