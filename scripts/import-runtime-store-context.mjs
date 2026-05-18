import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query, transaction } from "../server/db/pool.js";
import { normalizeContextHistoryProjection } from "../server/context-history.js";
import {
  saveContextHistoryProjection,
} from "../server/repositories/context.js";

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

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function accountIdForContextDocument(key, document) {
  const accountId = String(document?.accountId || "").trim();
  if (accountId) return accountId;
  if (!key || key === "signed_out") return "";
  return String(key).trim();
}

function accountIdForHistory(key, snapshot) {
  const accountId = String(snapshot?.accountId || "").trim();
  if (accountId) return accountId;
  return String(key || "").split(":")[0]?.trim() || "";
}

function safeKey(value = "", fallback = "item") {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, 100);
}

function cleanTitle(title = "") {
  return String(title || "Task Node Context").trim().replace(/\s+/g, " ").slice(0, 120) || "Task Node Context";
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function wordCount(body = "") {
  const words = String(body || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

function dateOrNow(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

async function existingContextRevision(accountId) {
  const result = await query(
    `
      SELECT revision
      FROM context_documents
      WHERE account_id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [accountId]
  );
  return Number(result.rows[0]?.revision || 0);
}

async function importContextDocument(document) {
  const body = String(document.body || "").slice(0, 50_000);
  const bodyHash = sha256(body);
  const revision = Math.max(1, Number(document.revision || 1));
  const preferredDocumentId = String(document.id || `ctx_${safeKey(document.accountId, "account")}`).slice(0, 180);
  const revisionId = `ctxrev_import_${sha256(`${document.accountId}:${revision}:${bodyHash}`).slice(0, 32)}`;
  const title = cleanTitle(document.title);
  const createdAt = dateOrNow(document.createdAt);
  const updatedAt = dateOrNow(document.updatedAt);

  await transaction(async (client) => {
    const existing = await client.query(
      `
        SELECT id
        FROM context_documents
        WHERE account_id = $1
          AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE
      `,
      [document.accountId]
    );
    const documentId = existing.rows[0]?.id || preferredDocumentId;

    if (!existing.rows[0]) {
      await client.query(
        `
          INSERT INTO context_documents (
            id,
            account_id,
            title,
            revision,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 0, $4, $5)
          ON CONFLICT DO NOTHING
        `,
        [documentId, document.accountId, title, createdAt, updatedAt]
      );
    }

    await client.query(
      `
        INSERT INTO context_revisions (
          id,
          context_document_id,
          account_id,
          revision,
          title,
          body,
          body_sha256,
          word_count,
          source,
          provenance_json,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'runtime_store_import', $9, $10)
        ON CONFLICT DO NOTHING
      `,
      [
        revisionId,
        documentId,
        document.accountId,
        revision,
        title,
        body,
        bodyHash,
        wordCount(body),
        {
          source: "runtime-store.json",
          key: document.key,
          previousRevision: document.revision,
        },
        updatedAt,
      ]
    );

    await client.query(
      `
        UPDATE context_documents
        SET
          title = $2,
          current_revision_id = $3,
          revision = GREATEST(revision, $4),
          updated_at = GREATEST(updated_at, $5)
        WHERE id = $1
      `,
      [documentId, title, revisionId, revision, updatedAt]
    );
  });
}

async function existingHistoryPointerCount({ accountId, walletAddress }) {
  const result = await query(
    `
      SELECT count(*)::integer AS count
      FROM context_history_pointers
      WHERE account_id = $1
        AND wallet_address = $2
    `,
    [accountId, walletAddress]
  );
  return Number(result.rows[0]?.count || 0);
}

if (!existsSync(storePath)) {
  throw new Error(`Runtime store not found at ${storePath}`);
}

const state = JSON.parse(readFileSync(storePath, "utf8"));
const contextDocuments = Object.entries(jsonObject(state.contextDocuments))
  .map(([key, document]) => ({
    key,
    accountId: accountIdForContextDocument(key, document),
    id: document?.id || "",
    title: document?.title || "Task Node Context",
    body: document?.body || "",
    revision: Number(document?.revision || 0),
    createdAt: document?.createdAt || "",
    updatedAt: document?.updatedAt || "",
  }))
  .filter((row) => row.accountId && row.body);

const contextHistorySnapshots = Object.entries(jsonObject(state.contextHistorySnapshots))
  .map(([key, snapshot]) => {
    const normalized = normalizeContextHistoryProjection(snapshot);
    return {
      key,
      accountId: accountIdForHistory(key, snapshot),
      walletAddress: normalized.walletAddress || snapshot?.walletAddress || "",
      pointerCount: normalized.pointerCount,
      snapshot,
    };
  })
  .filter((row) => row.accountId && row.walletAddress && row.pointerCount > 0);

const dryRunReport = {
  storePath,
  execute,
  source: {
    contextDocuments: contextDocuments.length,
    contextHistorySnapshots: contextHistorySnapshots.length,
    contextHistoryPointers: contextHistorySnapshots.reduce((sum, row) => sum + row.pointerCount, 0),
  },
};

if (!execute) {
  console.log(JSON.stringify({
    ...dryRunReport,
    message: "Dry run only. Re-run with --execute to import context rows.",
  }, null, 2));
  process.exit(0);
}

await migrateDatabase();

let importedDocuments = 0;
let skippedDocuments = 0;
for (const document of contextDocuments) {
  const existingRevision = await existingContextRevision(document.accountId);
  if (existingRevision >= Math.max(1, document.revision)) {
    skippedDocuments += 1;
    continue;
  }

  await importContextDocument(document);
  importedDocuments += 1;
}

let importedHistorySnapshots = 0;
let skippedHistorySnapshots = 0;
for (const history of contextHistorySnapshots) {
  const existingPointerCount = await existingHistoryPointerCount({
    accountId: history.accountId,
    walletAddress: history.walletAddress,
  });
  if (existingPointerCount >= history.pointerCount) {
    skippedHistorySnapshots += 1;
    continue;
  }

  const result = await saveContextHistoryProjection({
    accountId: history.accountId,
    projection: history.snapshot,
  });
  if (result.ok) importedHistorySnapshots += 1;
}

console.log(JSON.stringify({
  ...dryRunReport,
  imported: {
    contextDocuments: importedDocuments,
    contextHistorySnapshots: importedHistorySnapshots,
  },
  skipped: {
    contextDocuments: skippedDocuments,
    contextHistorySnapshots: skippedHistorySnapshots,
  },
}, null, 2));
await closePool();
