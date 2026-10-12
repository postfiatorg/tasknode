import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import {
  appendChatUserMessage,
  deleteChatConversation,
  listChatConversations,
  searchChatConversations,
} from "../server/repositories/chat-conversations.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

// Stubbed pool, runs before the database check so the unit suite covers it: no statement reaches
// Postgres; every call records its params. LIMIT is bound as bigint, so it must be an integer.
{
  const envKeys = ["DATABASE_URL", "TASKNODE_DATABASE_ENABLED", "TASKNODE_DATABASE_DISABLED", "TASKNODE_POSTGRES_DISABLED"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const realPoolQuery = pg.Pool.prototype.query;
  const statements = [];
  process.env.DATABASE_URL ||= "postgres://stub@127.0.0.1:1/stub";
  process.env.TASKNODE_DATABASE_ENABLED = "true";
  delete process.env.TASKNODE_DATABASE_DISABLED;
  delete process.env.TASKNODE_POSTGRES_DISABLED;
  pg.Pool.prototype.query = async (text, params) => {
    statements.push({ text, params });
    return { rows: [] };
  };
  try {
    assert.equal(databaseEnabled(), true, "stubbed section must take the database path");
    for (const [limit, expected] of [[undefined, 30], [30, 30], ["30", 30], ["1", 1], ["100", 100], ["500", 100], [2.5, 2], ["2.5", 2], ["49.9", 49], ["0.5", 30], ["abc", 30], ["NaN", 30]]) {
      statements.length = 0;
      await listChatConversations({ accountId: "acct_limit_stub", limit });
      const main = statements.find(({ text }) => /AND id <> \$3[\s\S]*LIMIT \$2/.test(text));
      const legacy = statements.find(({ text }) => /legacy_pftasks_chat_messages[\s\S]*LIMIT \$2/.test(text));
      assert.equal(main?.params[1], expected, `list limit ${JSON.stringify(limit)} binds LIMIT ${expected}`);
      assert.equal(legacy?.params[1], expected, `list limit ${JSON.stringify(limit)} passes ${expected} to the legacy list`);
    }
    for (const [limit, expected] of [[undefined, 20], [20, 20], ["20", 20], ["1", 1], ["50", 50], ["500", 50], [2.5, 2], ["2.5", 2], ["49.9", 49], ["0.5", 20], ["abc", 20], ["NaN", 20]]) {
      statements.length = 0;
      await searchChatConversations({ accountId: "acct_limit_stub", query: "zebra", limit });
      const bound = statements.filter(({ text }) => /LIMIT \$3/.test(text)).map(({ params }) => params[2]);
      assert.deepEqual(bound, [expected, expected], `search limit ${JSON.stringify(limit)} binds LIMIT ${expected} twice`);
    }
    statements.length = 0;
    await searchChatConversations({ accountId: "acct_limit_stub", query: "zebra", limit: 20 });
    assert.deepEqual(statements[0].params, ["acct_limit_stub", "%zebra%", 20]);
  } finally {
    pg.Pool.prototype.query = realPoolQuery;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
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

  // (g) A fractional limit is truncated; it must not reach Postgres as LIMIT '2.5' (22P02).
  for (const [limit, truncated] of [[2.5, 2], ["49.9", 49]]) {
    const limitedResults = await searchChatConversations({ accountId: accountA, query: "discount", limit });
    assert.ok(limitedResults.length >= 1 && limitedResults.length <= truncated, `search limit ${limit} returns 1..${truncated} rows`);
  }
  const limitedConversations = await listChatConversations({ accountId: accountA, limit: 2.5 });
  assert.ok(limitedConversations.length >= 1 && limitedConversations.length <= 2, "list limit 2.5 returns 1..2 rows");

  console.log("chat search smoke ok");
} finally {
  await query("DELETE FROM chat_attachments WHERE account_id = ANY($1)", [accountIds]);
  await query("DELETE FROM chat_messages WHERE account_id = ANY($1)", [accountIds]);
  await query("DELETE FROM chat_conversations WHERE account_id = ANY($1)", [accountIds]);
  await closePool();
}
