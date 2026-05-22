import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, databaseStatus, query } from "../db/pool.js";

const maxBodyLength = 24_000;
const maxDisplayNameLength = 120;
const maxConversationTitleLength = 160;
const maxConversationIdLength = 180;
const maxLimit = 240;
const fallbackEntries = [];

function useDatabase() {
  return databaseEnabled();
}

export function hiveContextRepositoryStatus() {
  return databaseStatus();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().replace(/\s+\n/g, "\n").slice(0, max);
}

function safeAccountId(value = "") {
  return safeText(value, 160);
}

function safeDisplayName(value = "", fallback = "Unknown user") {
  return safeText(value, maxDisplayNameLength) || fallback;
}

function safeConversationId(value = "") {
  return safeText(value, maxConversationIdLength);
}

function cleanBody(value = "") {
  return safeText(value, maxBodyLength);
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function publicEntry(row = {}) {
  const attachments = row.attachments_json || row.attachments || [];
  const metadata = row.metadata_json || row.metadata || {};
  return {
    id: row.id,
    accountId: row.account_id || row.accountId || "",
    displayName: row.display_name || row.displayName || "Unknown user",
    body: row.body || "",
    excerpt: safeText(row.body || "", 220),
    source: row.source || "chat_hive_input",
    sourceConversationId: row.source_conversation_id || row.sourceConversationId || "",
    sourceConversationTitle: row.source_conversation_title || row.sourceConversationTitle || "",
    attachments: jsonArray(attachments).map((attachment) => ({
      name: safeText(attachment?.name || "attachment", 160),
      mimeType: safeText(attachment?.mimeType || attachment?.mime_type || "", 120),
      size: Math.max(0, Number(attachment?.size || attachment?.sizeBytes || attachment?.size_bytes || 0)),
    })),
    metadata: jsonObject(metadata),
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

function groupedDocument(entries = []) {
  const groupsByKey = new Map();
  for (const entry of entries.map(publicEntry)) {
    const key = entry.accountId || entry.displayName;
    const existing = groupsByKey.get(key) || {
      accountId: entry.accountId,
      displayName: entry.displayName,
      latestAt: entry.createdAt,
      entryCount: 0,
      entries: [],
    };
    existing.displayName = existing.displayName || entry.displayName;
    existing.latestAt = latestIso(existing.latestAt, entry.createdAt);
    existing.entryCount += 1;
    existing.entries.push(entry);
    groupsByKey.set(key, existing);
  }

  const groups = Array.from(groupsByKey.values())
    .map((group) => ({
      ...group,
      entries: group.entries.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    }))
    .sort((a, b) => {
      const nameSort = String(a.displayName || "").toLowerCase().localeCompare(String(b.displayName || "").toLowerCase());
      if (nameSort !== 0) return nameSort;
      return String(a.accountId || "").localeCompare(String(b.accountId || ""));
    });

  return {
    id: "hive_context",
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    userCount: groups.length,
    groups,
  };
}

function latestIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return String(a) > String(b) ? a : b;
}

export async function saveHiveContextEntry({
  accountId = "",
  displayName = "",
  body = "",
  sourceConversationId = "",
  sourceConversationTitle = "",
  attachments = [],
  metadata = {},
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    const error = new Error("hive_context_login_required");
    error.status = 401;
    throw error;
  }

  const normalizedBody = cleanBody(body);
  if (!normalizedBody) {
    const error = new Error("hive_context_body_required");
    error.status = 400;
    throw error;
  }

  const now = new Date();
  const entry = {
    id: `hivectx_${randomUUID()}`,
    accountId: normalizedAccountId,
    displayName: safeDisplayName(displayName, normalizedAccountId),
    body: normalizedBody,
    bodySha256: sha256(normalizedBody),
    source: "chat_hive_input",
    sourceConversationId: safeConversationId(sourceConversationId),
    sourceConversationTitle: safeText(sourceConversationTitle, maxConversationTitleLength),
    attachments: jsonArray(attachments),
    metadata: jsonObject(metadata),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (!useDatabase()) {
    fallbackEntries.unshift(entry);
    return publicEntry(entry);
  }

  const result = await query(
    `
      INSERT INTO hive_context_entries (
        id,
        account_id,
        display_name,
        body,
        body_sha256,
        source,
        source_conversation_id,
        source_conversation_title,
        attachments_json,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'chat_hive_input', $6, $7, $8, $9, $10, $10)
      RETURNING *
    `,
    [
      entry.id,
      entry.accountId,
      entry.displayName,
      entry.body,
      entry.bodySha256,
      entry.sourceConversationId,
      entry.sourceConversationTitle,
      JSON.stringify(entry.attachments),
      JSON.stringify(entry.metadata),
      now,
    ]
  );
  return publicEntry(result.rows[0]);
}

export async function getHiveContextDocument({ limit = 120 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 120, 1), maxLimit);
  if (!useDatabase()) {
    return groupedDocument(fallbackEntries.slice(0, normalizedLimit));
  }

  const result = await query(
    `
      SELECT *
      FROM hive_context_entries
      WHERE deleted_at IS NULL
      ORDER BY lower(display_name) ASC, account_id ASC, created_at DESC, id DESC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return groupedDocument(result.rows);
}
