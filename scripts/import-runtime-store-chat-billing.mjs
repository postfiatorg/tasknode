import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query, transaction } from "../server/db/pool.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const execute = process.argv.includes("--execute");
const defaultPath = process.env.TASKNODE_STORE_PATH || "/data/runtime-store.json";
const storePath = path.resolve(argValue("--path", defaultPath));

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function safeAccountId(accountId = "") {
  return String(accountId || "").trim().slice(0, 160);
}

function inferAccountIdFromConversationId(conversationId = "", accounts = {}) {
  const text = String(conversationId || "");
  if (!text.startsWith("account_")) return "";
  const scopedId = text.slice("account_".length);
  return Object.keys(accounts || {})
    .sort((left, right) => right.length - left.length)
    .find((accountId) => scopedId.startsWith(`${accountId.replace(/[^a-zA-Z0-9_-]+/g, "_")}_`)) || "";
}

function cleanTitle(title = "") {
  return String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function titleFromMessages(messages = []) {
  const firstUser = messages.find((message) => message?.role === "user");
  return cleanTitle(firstUser?.body || "") || "New chat";
}

function previewFromMessages(messages = []) {
  const last = messages[messages.length - 1] || null;
  return String(last?.body || last?.text || last?.content || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function dateOrNow(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function ledgerKind(entry) {
  return String(entry?.kind || "").trim() || "account_credit";
}

function ledgerAmount(entry) {
  return number(entry?.amountUsd ?? entry?.amount_usd ?? 0);
}

function entryCreatedAt(entry) {
  return dateOrNow(entry?.createdAt || entry?.created_at);
}

function conversationRows(state) {
  const conversations = jsonObject(state.conversations);
  const meta = jsonObject(state.conversationMeta);
  const rows = [];

  for (const [conversationId, rawMessages] of Object.entries(conversations)) {
    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    if (messages.length === 0) continue;
    const existing = jsonObject(meta[conversationId]);
    const accountId = safeAccountId(
      existing.accountId || inferAccountIdFromConversationId(conversationId, state.accounts)
    );
    const createdAt = dateOrNow(existing.createdAt || messages[0]?.createdAt);
    const updatedAt = dateOrNow(existing.updatedAt || messages[messages.length - 1]?.createdAt);
    rows.push({
      id: String(conversationId).slice(0, 180),
      accountId,
      title: cleanTitle(existing.title) || titleFromMessages(messages),
      status: existing.status === "deleted" ? "deleted" : "active",
      mode: existing.mode || messages.find((message) => message?.mode)?.mode || null,
      createdAt,
      updatedAt,
      lastMessageAt: dateOrNow(existing.lastMessageAt || messages[messages.length - 1]?.createdAt),
      lastMessagePreview: existing.lastMessagePreview || previewFromMessages(messages),
      messageCount: messages.length,
      messages,
    });
  }

  return rows;
}

async function importConversations(client, rows) {
  let conversations = 0;
  let messages = 0;

  for (const row of rows) {
    const insertedConversation = await client.query(
      `
        INSERT INTO chat_conversations (
          id,
          account_id,
          title,
          status,
          mode,
          created_at,
          updated_at,
          last_message_at,
          last_message_preview,
          message_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        row.id,
        row.accountId,
        row.title,
        row.status,
        row.mode,
        row.createdAt,
        row.updatedAt,
        row.lastMessageAt,
        row.lastMessagePreview,
        row.messageCount,
      ]
    );
    if (insertedConversation.rows[0]) conversations += 1;

    for (const message of row.messages) {
      const messageId = String(message?.id || "").trim() || `json_${row.id}_${messages}`;
      const insertedMessage = await client.query(
        `
          INSERT INTO chat_messages (
            id,
            conversation_id,
            account_id,
            role,
            body,
            mode,
            provider,
            model,
            response_id,
            created_at,
            metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `,
        [
          messageId,
          row.id,
          row.accountId,
          message?.role === "assistant" ? "assistant" : "user",
          String(message?.body || message?.text || message?.content || ""),
          message?.mode || null,
          message?.provider || null,
          message?.model || null,
          message?.responseId || null,
          dateOrNow(message?.createdAt),
          {},
        ]
      );
      if (insertedMessage.rows[0]) messages += 1;
    }
  }

  return { conversations, messages };
}

async function importLedgerEntries(client, entries) {
  let ledgerEntries = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const inserted = await client.query(
      `
        INSERT INTO billing_ledger_entries (
          id,
          account_id,
          kind,
          amount_usd,
          source,
          note,
          created_by,
          conversation_id,
          provider,
          model,
          mode,
          response_id,
          input_tokens,
          output_tokens,
          total_tokens,
          web_search_calls,
          tool_cost_usd,
          idempotency_key,
          metadata_json,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        String(entry.id || `json_ledger_${ledgerEntries}`).slice(0, 180),
        safeAccountId(entry.accountId || entry.account_id || "dev") || "dev",
        ledgerKind(entry),
        ledgerAmount(entry),
        String(entry.source || "").slice(0, 80),
        String(entry.note || "").slice(0, 240),
        String(entry.createdBy || entry.created_by || "system").slice(0, 80),
        entry.conversationId || entry.conversation_id || null,
        entry.provider || null,
        entry.model || null,
        entry.mode || null,
        entry.responseId || entry.response_id || null,
        Math.max(0, Number(entry.inputTokens || entry.input_tokens || 0)),
        Math.max(0, Number(entry.outputTokens || entry.output_tokens || 0)),
        Math.max(0, Number(entry.totalTokens || entry.total_tokens || 0)),
        Math.max(0, Number(entry.webSearchCalls || entry.web_search_calls || 0)),
        number(entry.toolCostUsd || entry.tool_cost_usd || 0),
        entry.uniqueKey || entry.idempotency_key || null,
        jsonObject(entry.metadata || entry.metadata_json),
        entryCreatedAt(entry),
      ]
    );
    if (inserted.rows[0]) ledgerEntries += 1;
  }

  return { ledgerEntries };
}

async function rebuildBillingProjection(client) {
  await client.query(
    `
      INSERT INTO billing_accounts (
        account_id,
        current_spend_usd,
        current_credit_usd,
        ledger_entry_count,
        updated_at
      )
      SELECT
        account_id,
        COALESCE(SUM(CASE WHEN kind = 'chat_debit' THEN amount_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE
          WHEN kind IN ('account_credit', 'top_up_credit', 'reward_credit', 'refund_credit')
            THEN amount_usd
          WHEN kind = 'admin_adjustment' AND amount_usd > 0
            THEN amount_usd
          ELSE 0
        END), 0),
        COUNT(*)::integer,
        now()
      FROM billing_ledger_entries
      GROUP BY account_id
      ON CONFLICT (account_id) DO UPDATE SET
        current_spend_usd = EXCLUDED.current_spend_usd,
        current_credit_usd = EXCLUDED.current_credit_usd,
        ledger_entry_count = EXCLUDED.ledger_entry_count,
        updated_at = now()
    `
  );
}

if (!existsSync(storePath)) {
  throw new Error(`Runtime store not found at ${storePath}`);
}

const state = JSON.parse(readFileSync(storePath, "utf8"));
const conversations = conversationRows(state);
const ledgerEntries = Array.isArray(state.ledgerEntries) ? state.ledgerEntries : [];
const dryRunReport = {
  storePath,
  execute,
  source: {
    conversations: conversations.length,
    messages: conversations.reduce((sum, row) => sum + row.messages.length, 0),
    ledgerEntries: ledgerEntries.length,
  },
};

if (!execute) {
  console.log(JSON.stringify({
    ...dryRunReport,
    message: "Dry run only. Re-run with --execute to import chat and billing rows.",
  }, null, 2));
  process.exit(0);
}

await migrateDatabase();
const result = await transaction(async (client) => {
  const importedConversations = await importConversations(client, conversations);
  const importedLedger = await importLedgerEntries(client, ledgerEntries);
  await rebuildBillingProjection(client);
  return {
    ...dryRunReport,
    imported: {
      ...importedConversations,
      ...importedLedger,
    },
  };
});

const accountCount = await query("SELECT COUNT(*)::integer AS count FROM billing_accounts");
console.log(JSON.stringify({
  ...result,
  billingAccounts: accountCount.rows[0]?.count || 0,
}, null, 2));
await closePool();
