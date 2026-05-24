import { createHash, randomUUID } from "node:crypto";
import {
  appendChatTurn as appendRuntimeChatTurn,
  deleteChatConversation as deleteRuntimeChatConversation,
  listChatConversations as listRuntimeChatConversations,
  renameChatConversation as renameRuntimeChatConversation,
} from "../runtime-store.js";
import {
  decodeTextDataUrl,
  normalizeChatAttachments,
} from "../chat-attachment-utils.js";
import { databaseEnabled, query, transaction } from "../db/pool.js";

const maxConversationLimit = 100;

const safeAccountId = (accountId = "") => String(accountId || "").trim().slice(0, 160);
const safeConversationId = (conversationId = "dev") =>
  String(conversationId || "dev").trim().slice(0, 180) || "dev";

function useDatabase() {
  return databaseEnabled();
}

function safeConversationAccountId(accountId = "") {
  return String(accountId || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function hiveConversationIdForAccount(accountId = "") {
  const accountKey = safeConversationAccountId(accountId);
  return accountKey ? `account_${accountKey}_hive`.slice(0, 160) : "";
}

function isHiveConversation({ accountId = "", conversationId = "" } = {}) {
  const hiveId = hiveConversationIdForAccount(accountId);
  return Boolean(hiveId && safeConversationId(conversationId) === hiveId);
}

function assertConversationIdAccountBoundary({ accountId = "", conversationId = "" } = {}) {
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedConversationId.startsWith("account_")) return;

  const conversationAccountId = safeConversationAccountId(accountId);
  const accountPrefix = conversationAccountId ? `account_${conversationAccountId}_` : "";
  if (!accountPrefix || !normalizedConversationId.startsWith(accountPrefix)) {
    const error = new Error("chat_conversation_not_found");
    error.status = 404;
    throw error;
  }
}

const cleanTitle = (title = "") => String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
const titleFromPrompt = (prompt = "") => cleanTitle(prompt).slice(0, 64) || "New chat";
const messagePreview = (message = "") => String(message || "").trim().replace(/\s+/g, " ").slice(0, 140);
const HIVE_CHAT_TITLE = "Hive Chat";
const HIVE_CHAT_MODE = "Hive";
const HIVE_CHAT_PREVIEW = "Talk to Hive Chat.";
const conversationStatusForInsert = (status = "active") =>
  String(status || "active").trim().toLowerCase().slice(0, 40) === "task_request" ? "task_request" : "active";

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function jsonValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function publicConversation(row, { unreadCount = 0 } = {}) {
  const kind = isHiveConversation({ accountId: row.account_id || row.accountId, conversationId: row.id })
    ? "hive"
    : "";
  const normalizedUnreadCount = Math.max(0, Math.round(Number(unreadCount) || 0));
  return {
    id: row.id,
    conversationId: row.id,
    kind: kind || undefined,
    title: kind === "hive" ? HIVE_CHAT_TITLE : row.title || "New chat",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastMessageAt: toIso(row.last_message_at || row.updated_at),
    lastMessagePreview: row.last_message_preview || "",
    messageCount: Number(row.message_count || 0),
    unreadCount: normalizedUnreadCount,
    unread: normalizedUnreadCount > 0,
  };
}

function virtualHiveConversation({ accountId = "", unreadCount = 0 } = {}) {
  const id = hiveConversationIdForAccount(accountId);
  if (!id) return null;
  const now = new Date().toISOString();
  const normalizedUnreadCount = Math.max(0, Math.round(Number(unreadCount) || 0));
  return {
    id,
    conversationId: id,
    kind: "hive",
    title: HIVE_CHAT_TITLE,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    lastMessagePreview: HIVE_CHAT_PREVIEW,
    messageCount: 0,
    unreadCount: normalizedUnreadCount,
    unread: normalizedUnreadCount > 0,
    virtual: true,
  };
}

function publicMessage(row, attachments = []) {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const message = {
    id: row.id,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.created_at),
    mode: row.mode || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    responseId: row.response_id || undefined,
  };
  if (attachments.length > 0) message.attachments = attachments;
  if (Object.keys(metadata).length > 0) message.metadata = metadata;
  return message;
}

function publicAttachment(row) {
  const attachment = {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type || undefined,
    kind: row.kind || undefined,
    source: row.source || undefined,
    size: Number(row.size_bytes || 0),
    sha256: row.sha256 || undefined,
    textExcerpt: row.text_excerpt || undefined,
    storageUri: row.storage_uri || undefined,
    createdAt: toIso(row.created_at),
  };
  if (typeof row.text_content === "string" && row.text_content.length > 0) {
    attachment.textContent = row.text_content;
  }
  return attachment;
}

function attachmentRowsForInsert({ attachments = [], accountId, conversationId, messageId, createdAt }) {
  return normalizeChatAttachments(attachments).map((attachment, index) => {
    const textContent = attachment.kind === "text" ? decodeTextDataUrl(attachment.dataUrl) : "";
    const hashInput = textContent || attachment.dataUrl;
    return {
      id: `att_${randomUUID()}`,
      accountId,
      conversationId,
      messageId,
      ordinal: index,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      source: attachment.source,
      sizeBytes: Math.max(0, Number(attachment.size || 0)),
      sha256: sha256(hashInput),
      textContent: textContent || null,
      textExcerpt: textContent ? textContent.slice(0, 500) : null,
      storageUri: null,
      createdAt,
      metadata: {},
    };
  });
}

async function insertChatAttachments(client, attachments = []) {
  if (attachments.length === 0) return [];

  const rows = [];
  for (const attachment of attachments) {
    const inserted = await client.query(
      `
        INSERT INTO chat_attachments (
          id,
          account_id,
          conversation_id,
          message_id,
          ordinal,
          name,
          mime_type,
          kind,
          source,
          size_bytes,
          sha256,
          text_content,
          text_excerpt,
          storage_uri,
          created_at,
          metadata_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16
        )
        RETURNING *
      `,
      [
        attachment.id,
        attachment.accountId,
        attachment.conversationId,
        attachment.messageId,
        attachment.ordinal,
        attachment.name,
        attachment.mimeType || "",
        attachment.kind || "file",
        attachment.source || "",
        attachment.sizeBytes,
        attachment.sha256,
        attachment.textContent,
        attachment.textExcerpt,
        attachment.storageUri,
        attachment.createdAt,
        jsonValue(attachment.metadata),
      ]
    );
    rows.push(inserted.rows[0]);
  }
  return rows;
}

async function unreadHiveMessageCount(accountId = "") {
  if (!useDatabase()) return 0;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return 0;
  const rows = await query(
    `
      SELECT count(*)::int AS count
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status = 'sent'
        AND read_at IS NULL
    `,
    [normalizedAccountId]
  );
  return Math.max(0, Number(rows.rows[0]?.count || 0));
}

export async function appendChatUserMessage({
  accountId = "",
  conversationId = "dev",
  conversationTitle = "",
  mode,
  provider,
  model,
  userMessage,
  userMessageId = "",
  userMetadata = {},
  conversationStatus = "active",
  attachments = [],
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });

  if (!useDatabase()) {
    return appendRuntimeChatTurn({
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
      mode,
      provider,
      model,
      userMessage,
      assistantMessage: "",
      userMessageId,
      userMetadata,
      assistantMetadata: { kind: "suppressed_ack" },
      attachments,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  }

  const now = new Date();
  const userId = typeof userMessageId === "string" && userMessageId.trim()
    ? userMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_user`;
  const status = conversationStatusForInsert(conversationStatus);
  const hive = isHiveConversation({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });
  const title = hive ? HIVE_CHAT_TITLE : cleanTitle(conversationTitle) || titleFromPrompt(userMessage);
  const preview = messagePreview(userMessage);

  return transaction(async (client) => {
    const existing = await client.query(
      "SELECT id, account_id FROM chat_conversations WHERE id = $1 FOR UPDATE",
      [normalizedConversationId]
    );
    const owner = existing.rows[0]?.account_id || "";
    if (existing.rows[0] && owner !== normalizedAccountId) {
      const error = new Error("chat_conversation_not_found");
      error.status = 404;
      throw error;
    }

    await client.query(
      `
        INSERT INTO chat_conversations (
          id, account_id, title, status, mode, created_at, updated_at,
          last_message_at, last_message_preview, message_count
        )
        VALUES ($1, $2, $3, $7, $4, $5, $5, $5, $6, 1)
        ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          status = EXCLUDED.status,
          title = CASE
            WHEN $8 = true THEN $9
            WHEN chat_conversations.title IS NULL
              OR chat_conversations.title = ''
              OR chat_conversations.title = 'New chat'
            THEN EXCLUDED.title
            ELSE chat_conversations.title
          END,
          mode = COALESCE(chat_conversations.mode, EXCLUDED.mode),
          updated_at = EXCLUDED.updated_at,
          last_message_at = EXCLUDED.last_message_at,
          last_message_preview = EXCLUDED.last_message_preview,
          message_count = chat_conversations.message_count + 1,
          deleted_at = NULL
      `,
      [normalizedConversationId, normalizedAccountId, title, mode || null, now, preview, status, hive, HIVE_CHAT_TITLE]
    );

    const userInsert = await client.query(
      `
        INSERT INTO chat_messages (
          id, conversation_id, account_id, role, body, mode, provider, model,
          created_at, metadata_json
        )
        VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          body = EXCLUDED.body,
          metadata_json = EXCLUDED.metadata_json
        RETURNING *
      `,
      [
        userId,
        normalizedConversationId,
        normalizedAccountId,
        String(userMessage || ""),
        mode || null,
        provider || null,
        model || null,
        now,
        jsonValue(userMetadata),
      ]
    );
    const attachmentRows = await insertChatAttachments(client, attachmentRowsForInsert({
      attachments,
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
      messageId: userId,
      createdAt: now,
    }));

    return {
      user: publicMessage(userInsert.rows[0], attachmentRows.map(publicAttachment)),
    };
  });
}

export async function listChatConversations({ accountId = "", limit = 30 } = {}) {
  if (!useDatabase()) return listRuntimeChatConversations({ accountId, limit });

  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), maxConversationLimit);
  const normalizedAccountId = safeAccountId(accountId);
  const hiveId = hiveConversationIdForAccount(normalizedAccountId);
  const hiveRow = hiveId
    ? await query("SELECT * FROM chat_conversations WHERE id = $1 AND account_id = $2 LIMIT 1", [
        hiveId,
        normalizedAccountId,
      ])
    : { rows: [] };
  const hiveUnreadCount = hiveId ? await unreadHiveMessageCount(normalizedAccountId) : 0;
  const hiveConversation =
    hiveRow.rows[0]?.status === "active"
      ? publicConversation(hiveRow.rows[0], { unreadCount: hiveUnreadCount })
      : hiveRow.rows[0]?.status === "hive_disabled"
        ? null
        : virtualHiveConversation({ accountId: normalizedAccountId, unreadCount: hiveUnreadCount });
  const rows = await query(
    `
      SELECT *
      FROM chat_conversations
      WHERE account_id = $1
        AND status = 'active'
        AND id <> $3
      ORDER BY updated_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, normalizedLimit, hiveId || "__no_hive__"]
  );
  return [
    ...(hiveConversation ? [hiveConversation] : []),
    ...rows.rows.map(publicConversation),
  ].slice(0, normalizedLimit);
}

export async function renameChatConversation({ accountId = "", conversationId = "", title = "" } = {}) {
  if (!useDatabase()) return renameRuntimeChatConversation({ accountId, conversationId, title });
  if (isHiveConversation({ accountId, conversationId })) {
    return { ok: false, status: 400, error: "hive_chat_cannot_be_renamed" };
  }

  const normalizedTitle = cleanTitle(title);
  if (!normalizedTitle) return { ok: false, status: 400, error: "chat_title_required" };

  const rows = await query(
    `
      UPDATE chat_conversations
      SET title = $3,
          updated_at = now()
      WHERE id = $1
        AND account_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [safeConversationId(conversationId), safeAccountId(accountId), normalizedTitle]
  );
  if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };

  return {
    ok: true,
    conversation: publicConversation(rows.rows[0]),
  };
}

export async function deleteChatConversation({ accountId = "", conversationId = "" } = {}) {
  if (!useDatabase()) return deleteRuntimeChatConversation({ accountId, conversationId });

  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (isHiveConversation({ accountId: normalizedAccountId, conversationId: normalizedConversationId })) {
    const now = new Date();
    const rows = await query(
      `
        INSERT INTO chat_conversations (
          id, account_id, title, status, mode, created_at, updated_at,
          deleted_at, last_message_preview, message_count
        )
        VALUES ($1, $2, $4, 'hive_disabled', $5, $3, $3, $3, '', 0)
        ON CONFLICT (id) DO UPDATE SET
          status = 'hive_disabled',
          title = $4,
          updated_at = $3,
          deleted_at = $3
        WHERE chat_conversations.account_id = $2
        RETURNING *
      `,
      [normalizedConversationId, normalizedAccountId, now, HIVE_CHAT_TITLE, HIVE_CHAT_MODE]
    );
    if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };
    return { ok: true, conversationId: normalizedConversationId, kind: "hive", disabled: true };
  }

  const rows = await query(
    `
      UPDATE chat_conversations
      SET status = 'deleted',
          deleted_at = now(),
          updated_at = now()
      WHERE id = $1
        AND account_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [normalizedConversationId, normalizedAccountId]
  );
  if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };

  return {
    ok: true,
    conversationId: rows.rows[0].id,
  };
}

export async function getHiveConversation({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const hiveId = hiveConversationIdForAccount(normalizedAccountId);
  if (!hiveId) return null;
  if (!useDatabase()) return virtualHiveConversation({ accountId: normalizedAccountId });

  const rows = await query("SELECT * FROM chat_conversations WHERE id = $1 AND account_id = $2 LIMIT 1", [
    hiveId,
    normalizedAccountId,
  ]);
  if (rows.rows[0]?.status === "hive_disabled") {
    return {
      ...virtualHiveConversation({ accountId: normalizedAccountId }),
      enabled: false,
      disabled: true,
      updatedAt: toIso(rows.rows[0].updated_at),
    };
  }
  const unreadCount = await unreadHiveMessageCount(normalizedAccountId);
  const conversation = rows.rows[0]
    ? publicConversation(rows.rows[0], { unreadCount })
    : virtualHiveConversation({ accountId: normalizedAccountId, unreadCount });
  return conversation ? { ...conversation, enabled: true, disabled: false } : null;
}

export async function markHiveConversationRead({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { ok: false, status: 401, error: "hive_chat_login_required" };
  if (!useDatabase()) return { ok: true, updated: 0, conversation: virtualHiveConversation({ accountId: normalizedAccountId }) };

  const updated = await query(
    `
      UPDATE board_manager_user_messages
      SET status = 'read',
          read_at = COALESCE(read_at, now())
      WHERE account_id = $1
        AND status = 'sent'
        AND read_at IS NULL
      RETURNING id
    `,
    [normalizedAccountId]
  );
  return {
    ok: true,
    updated: updated.rowCount || 0,
    conversation: await getHiveConversation({ accountId: normalizedAccountId }),
  };
}

export async function ensureHiveConversation({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const hiveId = hiveConversationIdForAccount(normalizedAccountId);
  if (!hiveId) return { ok: false, status: 401, error: "hive_chat_login_required" };
  if (!useDatabase()) return { ok: true, conversation: virtualHiveConversation({ accountId: normalizedAccountId }) };

  const existing = await query("SELECT * FROM chat_conversations WHERE id = $1 AND account_id = $2 LIMIT 1", [
    hiveId,
    normalizedAccountId,
  ]);
  if (existing.rows[0]?.status === "hive_disabled") {
    return { ok: false, status: 409, error: "hive_chat_disabled" };
  }
  if (existing.rows[0]?.status === "active") {
    return { ok: true, conversation: { ...publicConversation(existing.rows[0]), enabled: true, disabled: false } };
  }

  const now = new Date();
  const inserted = await query(
    `
      INSERT INTO chat_conversations (
        id, account_id, title, status, mode, created_at, updated_at,
        last_message_preview, message_count
      )
      VALUES ($1, $2, $4, 'active', $5, $3, $3, $6, 0)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `,
    [hiveId, normalizedAccountId, now, HIVE_CHAT_TITLE, HIVE_CHAT_MODE, HIVE_CHAT_PREVIEW]
  );
  if (!inserted.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };
  return {
    ok: true,
    conversation: { ...publicConversation(inserted.rows[0]), enabled: true, disabled: false },
  };
}

export async function enableHiveConversation({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const hiveId = hiveConversationIdForAccount(normalizedAccountId);
  if (!hiveId) return { ok: false, status: 401, error: "hive_chat_login_required" };
  if (!useDatabase()) return { ok: true, conversation: virtualHiveConversation({ accountId: normalizedAccountId }) };

  const now = new Date();
  const rows = await query(
    `
      INSERT INTO chat_conversations (
        id, account_id, title, status, mode, created_at, updated_at,
        last_message_preview, message_count
      )
      VALUES ($1, $2, $4, 'active', $5, $3, $3, $6, 0)
      ON CONFLICT (id) DO UPDATE SET
        status = 'active',
        title = $4,
        mode = COALESCE(chat_conversations.mode, $5),
        updated_at = $3,
        deleted_at = NULL
      WHERE chat_conversations.account_id = $2
      RETURNING *
    `,
    [hiveId, normalizedAccountId, now, HIVE_CHAT_TITLE, HIVE_CHAT_MODE, HIVE_CHAT_PREVIEW]
  );
  if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };
  return {
    ok: true,
    conversation: { ...publicConversation(rows.rows[0]), enabled: true, disabled: false },
  };
}
