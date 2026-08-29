#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { closePool, databaseEnabled, transaction } from "../server/db/pool.js";
import { legacyConversationId } from "../server/repositories/legacy-pftasks-history.js";

const batchSize = 250;

function parseArgs(argv = []) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument: ${token}`);
    if (["--execute", "--help"].includes(token)) {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_required: ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return { values, flags };
}

function parseEnv(text = "") {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

async function sourceDatabaseUrl({ sourceEnv = "" } = {}) {
  if (process.env.PFTASKS_DATABASE_URL) return process.env.PFTASKS_DATABASE_URL;
  if (!sourceEnv) throw new Error("pftasks_source_database_required");
  const values = parseEnv(await readFile(sourceEnv, "utf8"));
  const url = values.DATABASE_READONLY || values.DATABASE_URL;
  if (!url) throw new Error("pftasks_source_database_required");
  return url;
}

async function readSourceHistory(client, { wallet = "" } = {}) {
  const walletRows = (await client.query(
    `SELECT id::text, user_id::text, wallet_address, is_active, is_primary, created_at
       FROM user_wallets
      WHERE wallet_address IS NOT NULL
      ORDER BY user_id, is_active DESC, is_primary DESC, created_at ASC, id ASC`
  )).rows;
  const walletById = new Map(walletRows.map((row) => [row.id, row]));
  const walletsByUser = new Map();
  for (const row of walletRows) {
    const rows = walletsByUser.get(row.user_id) || [];
    rows.push(row);
    walletsByUser.set(row.user_id, rows);
  }
  const walletFor = (row) => walletById.get(row.wallet_id) || walletsByUser.get(row.legacy_user_id)?.[0] || null;
  const attachWallet = (rows) => rows
    .map((row) => ({ ...row, wallet_address: walletFor(row)?.wallet_address || "" }))
    .filter((row) => row.wallet_address && (!wallet || row.wallet_address === wallet));

  const chatMessages = attachWallet((await client.query(
    `SELECT
       messages.id::text AS source_message_id,
       messages.user_id::text AS legacy_user_id,
       messages.wallet_id::text AS wallet_id,
       messages.chat_type,
       messages.role,
       messages.content AS body,
       COALESCE(messages.metadata, '{}'::jsonb) AS source_metadata_json,
       messages.created_at AS source_created_at
     FROM chat_messages messages
     ORDER BY messages.created_at, messages.id`
  )).rows).map((row) => ({
    ...row,
    conversation_id: legacyConversationId({ legacyUserId: row.legacy_user_id, chatType: row.chat_type }),
  }));

  const tasks = attachWallet((await client.query(
    `SELECT
       tasks.id::text AS source_task_id,
       tasks.user_id::text AS legacy_user_id,
       tasks.wallet_id::text AS wallet_id,
       tasks.title,
       COALESCE(tasks.description, '') AS description,
       COALESCE(tasks.status, '') AS source_status,
       COALESCE(tasks.task_category, '') AS task_category,
       COALESCE(tasks.verification_type, '') AS verification_type,
       COALESCE(tasks.verification_criteria, '{}'::jsonb) AS verification_criteria_json,
       COALESCE(tasks.steps, '[]'::jsonb) AS steps_json,
       COALESCE(tasks.refusal_reason, '') AS refusal_reason,
       COALESCE(tasks.cancellation_reason, '') AS cancellation_reason,
       COALESCE(tasks.rejection_reason, '') AS rejection_reason,
       tasks.reward_amount_estimate,
       tasks.reward_amount_actual,
       COALESCE(tasks.reward_tx_hash, '') AS reward_tx_hash,
       tasks.accepted_at,
       tasks.submitted_at,
       tasks.verified_at,
       tasks.reward_paid_at,
       tasks.due_at,
       tasks.deadline_at,
       tasks.created_at AS source_created_at,
       NULL::timestamptz AS source_updated_at,
       COALESCE(tasks.task_metadata, '{}'::jsonb) AS source_metadata_json
     FROM tasks
     ORDER BY tasks.created_at, tasks.id`
  )).rows);

  const contextRevisions = attachWallet((await client.query(
    `SELECT
       revisions.id::text AS source_revision_id,
       revisions.user_id::text AS legacy_user_id,
       revisions.wallet_id::text AS wallet_id,
       revisions.cid,
       COALESCE(revisions.tx_hash, '') AS tx_hash,
       revisions.word_count,
       revisions.created_at AS source_created_at
     FROM context_revisions revisions
     ORDER BY revisions.created_at, revisions.id`
  )).rows);

  return { chatMessages, tasks, contextRevisions };
}

function chunks(rows = []) {
  const result = [];
  for (let index = 0; index < rows.length; index += batchSize) result.push(rows.slice(index, index + batchSize));
  return result;
}

async function importChatMessages(client, rows = []) {
  for (const batch of chunks(rows)) {
    await client.query(
      `INSERT INTO legacy_pftasks_chat_messages (
         source_message_id, legacy_user_id, wallet_address, conversation_id, chat_type,
         role, body, source_metadata_json, source_created_at, imported_at
       )
       SELECT source_message_id, legacy_user_id, wallet_address, conversation_id, chat_type,
              role, body, source_metadata_json, source_created_at, now()
       FROM jsonb_to_recordset($1::jsonb) AS source(
         source_message_id text, legacy_user_id text, wallet_address text, conversation_id text,
         chat_type text, role text, body text, source_metadata_json jsonb, source_created_at timestamptz
       )
       ON CONFLICT (source_message_id) DO UPDATE SET
         legacy_user_id = EXCLUDED.legacy_user_id,
         wallet_address = EXCLUDED.wallet_address,
         conversation_id = EXCLUDED.conversation_id,
         chat_type = EXCLUDED.chat_type,
         role = EXCLUDED.role,
         body = EXCLUDED.body,
         source_metadata_json = EXCLUDED.source_metadata_json,
         source_created_at = EXCLUDED.source_created_at,
         imported_at = now()`,
      [JSON.stringify(batch)]
    );
  }
}

async function importTasks(client, rows = []) {
  for (const batch of chunks(rows)) {
    await client.query(
      `INSERT INTO legacy_pftasks_tasks (
         source_task_id, legacy_user_id, wallet_address, title, description, source_status,
         task_category, verification_type, verification_criteria_json, steps_json,
         refusal_reason, cancellation_reason, rejection_reason, reward_amount_estimate,
         reward_amount_actual, reward_tx_hash, accepted_at, submitted_at, verified_at,
         reward_paid_at, due_at, deadline_at, source_created_at, source_updated_at,
         source_metadata_json, imported_at
       )
       SELECT source_task_id, legacy_user_id, wallet_address, title, description, source_status,
              task_category, verification_type, verification_criteria_json, steps_json,
              refusal_reason, cancellation_reason, rejection_reason, reward_amount_estimate,
              reward_amount_actual, reward_tx_hash, accepted_at, submitted_at, verified_at,
              reward_paid_at, due_at, deadline_at, source_created_at, source_updated_at,
              source_metadata_json, now()
       FROM jsonb_to_recordset($1::jsonb) AS source(
         source_task_id text, legacy_user_id text, wallet_address text, title text, description text,
         source_status text, task_category text, verification_type text, verification_criteria_json jsonb,
         steps_json jsonb, refusal_reason text, cancellation_reason text, rejection_reason text,
         reward_amount_estimate numeric, reward_amount_actual numeric, reward_tx_hash text,
         accepted_at timestamptz, submitted_at timestamptz, verified_at timestamptz,
         reward_paid_at timestamptz, due_at date, deadline_at timestamptz,
         source_created_at timestamptz, source_updated_at timestamptz, source_metadata_json jsonb
       )
       ON CONFLICT (source_task_id) DO UPDATE SET
         legacy_user_id = EXCLUDED.legacy_user_id,
         wallet_address = EXCLUDED.wallet_address,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         source_status = EXCLUDED.source_status,
         task_category = EXCLUDED.task_category,
         verification_type = EXCLUDED.verification_type,
         verification_criteria_json = EXCLUDED.verification_criteria_json,
         steps_json = EXCLUDED.steps_json,
         refusal_reason = EXCLUDED.refusal_reason,
         cancellation_reason = EXCLUDED.cancellation_reason,
         rejection_reason = EXCLUDED.rejection_reason,
         reward_amount_estimate = EXCLUDED.reward_amount_estimate,
         reward_amount_actual = EXCLUDED.reward_amount_actual,
         reward_tx_hash = EXCLUDED.reward_tx_hash,
         accepted_at = EXCLUDED.accepted_at,
         submitted_at = EXCLUDED.submitted_at,
         verified_at = EXCLUDED.verified_at,
         reward_paid_at = EXCLUDED.reward_paid_at,
         due_at = EXCLUDED.due_at,
         deadline_at = EXCLUDED.deadline_at,
         source_created_at = EXCLUDED.source_created_at,
         source_updated_at = EXCLUDED.source_updated_at,
         source_metadata_json = EXCLUDED.source_metadata_json,
         imported_at = now()`,
      [JSON.stringify(batch)]
    );
  }
}

async function importContextRevisions(client, rows = []) {
  for (const batch of chunks(rows)) {
    await client.query(
      `INSERT INTO legacy_pftasks_context_revisions (
         source_revision_id, legacy_user_id, wallet_address, cid, tx_hash,
         word_count, source_created_at, imported_at
       )
       SELECT source_revision_id, legacy_user_id, wallet_address, cid, tx_hash,
              word_count, source_created_at, now()
       FROM jsonb_to_recordset($1::jsonb) AS source(
         source_revision_id text, legacy_user_id text, wallet_address text, cid text,
         tx_hash text, word_count integer, source_created_at timestamptz
       )
       ON CONFLICT (source_revision_id) DO UPDATE SET
         legacy_user_id = EXCLUDED.legacy_user_id,
         wallet_address = EXCLUDED.wallet_address,
         cid = EXCLUDED.cid,
         tx_hash = EXCLUDED.tx_hash,
         word_count = EXCLUDED.word_count,
         source_created_at = EXCLUDED.source_created_at,
         imported_at = now()`,
      [JSON.stringify(batch)]
    );
  }
}

const usage = [
  "Usage:",
  "  node scripts/import-pftasks-user-history.mjs --source-env <legacy-env-file> [--wallet <address>] [--execute]",
  "  PFTASKS_DATABASE_URL=<read-only-url> node scripts/import-pftasks-user-history.mjs [--wallet <address>] [--execute]",
  "",
  "Dry-run is the default. The import is wallet-scoped and idempotent.",
].join("\n");

let exitCode = 0;
let sourceClient;
try {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log(usage);
  } else {
    if (!databaseEnabled()) throw new Error("target_database_required");
    const sourceUrl = await sourceDatabaseUrl({ sourceEnv: values["source-env"] || "" });
    sourceClient = new pg.Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } });
    await sourceClient.connect();
    await sourceClient.query("BEGIN TRANSACTION READ ONLY");
    const source = await readSourceHistory(sourceClient, { wallet: values.wallet || "" });
    const walletCount = new Set([
      ...source.chatMessages,
      ...source.tasks,
      ...source.contextRevisions,
    ].map((row) => row.wallet_address).filter(Boolean)).size;
    const preview = {
      ok: true,
      dryRun: !flags.has("--execute"),
      scope: values.wallet ? "wallet" : "all_wallets",
      walletCount,
      chatMessageCount: source.chatMessages.length,
      conversationCount: new Set(source.chatMessages.map((row) => row.conversation_id)).size,
      taskCount: source.tasks.length,
      contextRevisionCount: source.contextRevisions.length,
    };
    if (flags.has("--execute")) {
      const runId = `legacy_import_${randomUUID()}`;
      await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["legacy-pftasks-history-import"]);
        await importChatMessages(client, source.chatMessages);
        await importTasks(client, source.tasks);
        await importContextRevisions(client, source.contextRevisions);
        await client.query(
          `INSERT INTO legacy_pftasks_import_runs (
             id, status, chat_message_count, task_count, context_revision_count,
             wallet_count, metadata_json
           ) VALUES ($1, 'completed', $2, $3, $4, $5, $6::jsonb)`,
          [runId, source.chatMessages.length, source.tasks.length, source.contextRevisions.length, walletCount,
            JSON.stringify({ scope: preview.scope, requestedWallet: values.wallet || null })]
        );
      });
      preview.runId = runId;
    }
    console.log(JSON.stringify(preview, null, 2));
  }
} catch (error) {
  exitCode = 1;
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
} finally {
  if (sourceClient) {
    await sourceClient.query("ROLLBACK").catch(() => null);
    await sourceClient.end().catch(() => null);
  }
  await closePool();
}
process.exitCode = exitCode;
