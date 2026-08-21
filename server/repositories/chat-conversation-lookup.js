import { listChatConversations as listRuntimeChatConversations } from "../runtime-store.js";
import { databaseEnabled, query } from "../db/pool.js";

const maxConversationLimit = 100;
const safeAccountId = (accountId = "") => String(accountId || "").trim().slice(0, 160);
const safeConversationId = (conversationId = "dev") =>
  String(conversationId || "dev").trim().slice(0, 180) || "dev";

export async function chatConversationExistsForAccount({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedAccountId || !normalizedConversationId) return false;
  if (!databaseEnabled()) {
    return listRuntimeChatConversations({ accountId: normalizedAccountId, limit: maxConversationLimit })
      .some((conversation) => (conversation.conversationId || conversation.id) === normalizedConversationId);
  }

  const rows = await query(
    `
      SELECT 1
      FROM chat_conversations
      WHERE id = $1
        AND account_id = $2
        AND status = 'active'
      LIMIT 1
    `,
    [normalizedConversationId, normalizedAccountId]
  );
  return Boolean(rows.rows[0]);
}
