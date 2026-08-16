import { randomUUID } from "node:crypto";
import { normalizeContextHistoryProjection } from "./context-history.js";
import { CONTEXT_DOCUMENT_MAX_CHARS } from "../shared/context-budget.js";

export function createRuntimeChatContextStore({ state, saveState, safeId, contextHistorySnapshotKey, storePath } = {}) {
  function conversationMessages(conversationId) {
    if (!state.conversations[conversationId]) state.conversations[conversationId] = [];
    return state.conversations[conversationId];
  }

  function chatTitleFromPrompt(prompt) {
    const title = String(prompt || "").trim().replace(/\s+/g, " ").slice(0, 64);
    return title || "New chat";
  }

  function chatTitleFromUserInput(title) {
    return String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  function messagePreview(message) {
    return String(message?.body || message?.text || message?.content || "").trim().replace(/\s+/g, " ").slice(0, 140);
  }

  function inferAccountIdFromConversationId(conversationId) {
    const text = String(conversationId || "");
    if (!text.startsWith("account_")) return "";
    const scopedId = text.slice("account_".length);
    return Object.keys(state.accounts || {})
      .sort((left, right) => right.length - left.length)
      .find((accountId) => scopedId.startsWith(`${safeId(accountId, "account")}_`)) || "";
  }

  function ensureConversationMeta(conversationId, accountId = "") {
    const messages = conversationMessages(conversationId);
    const existing = state.conversationMeta[conversationId] || {};
    const firstUser = messages.find((message) => message?.role === "user");
    const lastMessage = messages[messages.length - 1] || null;
    const createdAt = existing.createdAt || firstUser?.createdAt || lastMessage?.createdAt || new Date().toISOString();
    const updatedAt = existing.updatedAt || lastMessage?.createdAt || createdAt;
    const inferredAccountId = accountId || existing.accountId || inferAccountIdFromConversationId(conversationId);
    state.conversationMeta[conversationId] = {
      id: conversationId,
      conversationId,
      accountId: inferredAccountId,
      title: existing.title || chatTitleFromPrompt(firstUser?.body || ""),
      createdAt,
      updatedAt,
      lastMessageAt: existing.lastMessageAt || lastMessage?.createdAt || updatedAt,
      lastMessagePreview: existing.lastMessagePreview || messagePreview(lastMessage),
      messageCount: messages.length,
    };
    return state.conversationMeta[conversationId];
  }

  function conversationIdForSession(session = null, requestedId = "") {
    const hasRequestedId = typeof requestedId === "string" && requestedId.trim().length > 0;
    const requested = safeId(requestedId, "default");
    if (!session?.accountId) return hasRequestedId ? requested : "dev";
    const accountId = safeId(session.accountId, "account");
    const accountPrefix = `account_${accountId}_`;
    if (hasRequestedId && requested.startsWith(accountPrefix)) return requested.slice(0, 160);
    return `account_${accountId}_${requested}`.slice(0, 160);
  }

  function getChatMessages(conversationId = "dev") {
    return conversationMessages(conversationId).slice(-30);
  }

  function listChatConversations({ accountId = "", limit = 30 } = {}) {
    const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
    const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
    return Object.keys(state.conversations)
      .map((conversationId) => ensureConversationMeta(
        conversationId,
        normalizedAccountId && conversationId.startsWith(`account_${normalizedAccountId}_`) ? normalizedAccountId : ""
      ))
      .filter((meta) => meta.messageCount && (normalizedAccountId
        ? meta.accountId === normalizedAccountId
        : !meta.accountId && !String(meta.conversationId || "").startsWith("account_")))
      .sort((left, right) => (
        (Date.parse(right.updatedAt || right.lastMessageAt || "") || 0)
        - (Date.parse(left.updatedAt || left.lastMessageAt || "") || 0)
      ))
      .slice(0, normalizedLimit)
      .map((meta) => ({
        id: meta.id,
        conversationId: meta.conversationId,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastMessageAt: meta.lastMessageAt,
        lastMessagePreview: meta.lastMessagePreview,
        messageCount: meta.messageCount,
      }));
  }

  function chatConversationMutationTarget({ accountId = "", conversationId = "" } = {}) {
    const id = String(conversationId || "").trim();
    if (!id || !state.conversations[id]) return { ok: false, status: 404, error: "chat_conversation_not_found" };
    const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
    const accountPrefix = normalizedAccountId ? `account_${normalizedAccountId}_` : "";
    const meta = ensureConversationMeta(id, normalizedAccountId && id.startsWith(accountPrefix) ? normalizedAccountId : "");
    const ownerAccountId = meta.accountId || inferAccountIdFromConversationId(id) || "";
    if ((normalizedAccountId && ownerAccountId !== normalizedAccountId)
      || (!normalizedAccountId && (ownerAccountId || id.startsWith("account_")))) {
      return { ok: false, status: 404, error: "chat_conversation_not_found" };
    }
    return { ok: true, id, meta };
  }

  function renameChatConversation({ accountId = "", conversationId = "", title = "" } = {}) {
    const target = chatConversationMutationTarget({ accountId, conversationId });
    if (!target.ok) return target;
    const normalizedTitle = chatTitleFromUserInput(title);
    if (!normalizedTitle) return { ok: false, status: 400, error: "chat_title_required" };
    const now = new Date().toISOString();
    state.conversationMeta[target.id] = { ...target.meta, title: normalizedTitle, updatedAt: now };
    saveState();
    return { ok: true, conversation: { id: target.id, conversationId: target.id, title: normalizedTitle, updatedAt: now } };
  }

  function deleteChatConversation({ accountId = "", conversationId = "" } = {}) {
    const target = chatConversationMutationTarget({ accountId, conversationId });
    if (!target.ok) return target;
    delete state.conversations[target.id];
    delete state.conversationMeta[target.id];
    saveState();
    return { ok: true, conversationId: target.id, deleted: true };
  }

  function appendChatTurn({
    accountId = "", conversationId = "dev", mode, provider, model, responseId,
    userMessage, assistantMessage, userMessageId = "", assistantMessageId = "",
    userMetadata = {}, assistantMetadata = {}, usage,
  }) {
    const now = new Date().toISOString();
    const messages = conversationMessages(conversationId);
    const userId = typeof userMessageId === "string" && userMessageId.trim()
      ? userMessageId.trim().slice(0, 180) : `msg_${randomUUID()}_user`;
    const assistantId = typeof assistantMessageId === "string" && assistantMessageId.trim()
      ? assistantMessageId.trim().slice(0, 180) : `msg_${randomUUID()}_assistant`;
    const userMeta = userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata);
    const assistantMeta = assistantMetadata && typeof assistantMetadata === "object" && !Array.isArray(assistantMetadata);
    messages.push(Object.assign({ id: userId, role: "user", body: userMessage, createdAt: now, mode }, userMeta ? { metadata: userMetadata } : {}));
    messages.push(Object.assign(
      { id: assistantId, role: "assistant", body: assistantMessage, createdAt: now, mode, provider, model, responseId },
      assistantMeta ? { metadata: assistantMetadata } : {}
    ));
    const existingMeta = ensureConversationMeta(conversationId, accountId);
    state.conversationMeta[conversationId] = {
      ...existingMeta,
      accountId,
      title: existingMeta.title && existingMeta.title !== "New chat" ? existingMeta.title : chatTitleFromPrompt(userMessage),
      updatedAt: now,
      lastMessageAt: now,
      lastMessagePreview: messagePreview(assistantMessage) || messagePreview(userMessage),
      messageCount: messages.length,
    };
    const costUsd = Number(usage?.costUsd || 0);
    if (costUsd > 0) {
      state.ledgerEntries.push({
        id: `ledger_${randomUUID()}`, kind: "chat_debit", accountId, conversationId, provider, model, mode, responseId,
        amountUsd: Number(costUsd.toFixed(6)), inputTokens: usage?.inputTokens || 0,
        promptCacheHitTokens: usage?.promptCacheHitTokens || 0, promptCacheMissTokens: usage?.promptCacheMissTokens || 0,
        cacheUsageReported: usage?.cacheUsageReported === true, cacheSavingsUsd: usage?.cacheSavingsUsd || 0,
        costSource: usage?.costSource || "", outputTokens: usage?.outputTokens || 0,
        totalTokens: usage?.totalTokens || 0, webSearchCalls: usage?.webSearchCalls || 0,
        toolCostUsd: usage?.toolCostUsd || 0, createdAt: now,
      });
    }
    saveState();
    return {
      user: messages[messages.length - 2],
      assistant: messages[messages.length - 1],
      ledgerEntry: costUsd > 0 ? state.ledgerEntries[state.ledgerEntries.length - 1] : null,
    };
  }

  function appendUsageCredit({ accountId = "dev", amountUsd, source = "admin_credit", note = "", createdBy = "system", uniqueKey = "", metadata = {} }) {
    const normalizedUniqueKey = typeof uniqueKey === "string" ? uniqueKey.trim().slice(0, 180) : "";
    if (normalizedUniqueKey) {
      const existing = state.ledgerEntries.find((entry) => entry.kind === "account_credit" && entry.uniqueKey === normalizedUniqueKey);
      if (existing) return { ...existing, idempotentReplay: true };
    }
    const entry = {
      id: `ledger_${randomUUID()}_credit`, kind: "account_credit", accountId, source,
      amountUsd: Number(Number(amountUsd).toFixed(6)), note, createdBy, createdAt: new Date().toISOString(),
    };
    if (normalizedUniqueKey) entry.uniqueKey = normalizedUniqueKey;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) entry.metadata = metadata;
    state.ledgerEntries.push(entry);
    saveState();
    return entry;
  }

  function ledgerEntriesForScope({ accountId, conversationId } = {}) {
    return state.ledgerEntries.filter((entry) => (
      (accountId && entry.accountId === accountId)
      || (conversationId && entry.conversationId === conversationId)
      || (!accountId && !conversationId)
    ));
  }

  function usageSummary(scope = {}) {
    const entries = ledgerEntriesForScope(scope);
    const currentSpendUsd = entries.reduce((total, entry) => entry.kind === "chat_debit" ? total + Number(entry.amountUsd || 0) : total, 0);
    const currentCreditUsd = entries.reduce((total, entry) => ["account_credit", "reward_credit", "refund_credit"].includes(entry.kind) ? total + Number(entry.amountUsd || 0) : total, 0);
    return {
      currentSpendUsd: Number(currentSpendUsd.toFixed(6)),
      currentCreditUsd: Number(currentCreditUsd.toFixed(6)),
      availableCreditUsd: Number(Math.max(0, currentCreditUsd - currentSpendUsd).toFixed(6)),
      ledgerEntryCount: entries.length,
      storePath,
      durable: !storePath.startsWith("/tmp/"),
    };
  }

  function usageLedger({ accountId, conversationId, limit = 50 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (!accountId && !conversationId) {
      return { billingModel: "usage_based", currency: "USD", accountId: null, conversationId: null, currentSpendUsd: 0, currentCreditUsd: 0, availableCreditUsd: 0, ledgerEntryCount: 0, durable: !storePath.startsWith("/tmp/"), entries: [] };
    }
    const filteredEntries = ledgerEntriesForScope({ accountId, conversationId });
    const summary = usageSummary({ accountId, conversationId });
    return {
      billingModel: "usage_based", currency: "USD", accountId: accountId || null,
      conversationId: conversationId || null, currentSpendUsd: summary.currentSpendUsd,
      currentCreditUsd: summary.currentCreditUsd, availableCreditUsd: summary.availableCreditUsd,
      ledgerEntryCount: filteredEntries.length, durable: summary.durable,
      entries: filteredEntries.slice(-normalizedLimit).reverse(),
    };
  }

  function defaultContextBody() {
    return ["# Task Node Context", "", "## Current Focus", "", "## Preferences", "", "## Active Projects", "", "## Notes"].join("\n");
  }

  function getContextDocument({ accountId = "" } = {}) {
    const normalizedAccountId = safeId(accountId, "account");
    const canEdit = Boolean(accountId);
    const key = canEdit ? normalizedAccountId : "signed_out";
    const existing = state.contextDocuments[key];
    if (existing) return { ...existing, canEdit, savePath: "/api/context/edit/save" };
    const now = new Date().toISOString();
    return { id: `ctx_${key}`, accountId: canEdit ? normalizedAccountId : null, title: "Task Node Context", body: defaultContextBody(), revision: 0, createdAt: now, updatedAt: now, canEdit, savePath: "/api/context/edit/save" };
  }

  function saveContextDocument({ accountId = "", title = "", body = "" } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "context_login_required" };
    const normalizedAccountId = safeId(accountId, "account");
    const existing = state.contextDocuments[normalizedAccountId];
    const now = new Date().toISOString();
    const document = {
      id: existing?.id || `ctx_${normalizedAccountId}`, accountId: normalizedAccountId,
      title: String(title || "Task Node Context").trim().replace(/\s+/g, " ").slice(0, 120) || "Task Node Context",
      body: String(body || "").slice(0, CONTEXT_DOCUMENT_MAX_CHARS), revision: Number(existing?.revision || 0) + 1,
      createdAt: existing?.createdAt || now, updatedAt: now,
    };
    state.contextDocuments[normalizedAccountId] = document;
    saveState();
    return { ok: true, document: { ...document, canEdit: true, savePath: "/api/context/edit/save" } };
  }

  function emptyContextHistory({ accountId = "", walletAddress = "", canHydrate = false } = {}) {
    const normalizedAccountId = accountId ? safeId(accountId, "account") : null;
    const normalizedWalletAddress = walletAddress ? String(walletAddress).trim() : null;
    const key = normalizedAccountId && normalizedWalletAddress
      ? contextHistorySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress })
      : normalizedAccountId || "signed_out";
    return {
      id: `ctx_history_${key}`, accountId: normalizedAccountId, source: "pftl_cache_context_projection",
      revision: 0, projectedAt: null, walletAddress: normalizedWalletAddress, pointerCount: 0,
      contextUpdateCount: 0, taskEventCount: 0, latestContextPointer: null, contextUpdates: [], taskEvents: [],
      hydration: { plaintextHydrated: false, requiresWalletUnlock: true, ipfsFetchReady: true, fetchPath: "/api/context/history/ipfs/:cid", note: "No cached PFTL context pointers are available for this wallet yet. Background sync projects context pointers from cached wallet transactions." },
      sync: { source: "runtime_store", status: normalizedWalletAddress ? "syncing" : "ready", archiveComplete: false, lastHotSyncAt: null, lastArchiveSyncAt: null, lastError: null },
      canHydrate: Boolean(canHydrate && normalizedWalletAddress),
    };
  }

  function getContextHistory({ accountId = "", walletAddress = "" } = {}) {
    const hasAccount = Boolean(accountId);
    const normalizedAccountId = hasAccount ? safeId(accountId, "account") : "";
    const normalizedWalletAddress = walletAddress ? String(walletAddress).trim() : "";
    const snapshotKey = hasAccount && normalizedWalletAddress ? contextHistorySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress }) : "";
    const existing = snapshotKey ? state.contextHistorySnapshots[snapshotKey] : null;
    if (existing) {
      return {
        ...existing, walletAddress: existing.walletAddress || normalizedWalletAddress, canHydrate: true,
        sync: existing.sync || { source: "runtime_store", status: "ready", archiveComplete: false, lastHotSyncAt: null, lastArchiveSyncAt: null, lastError: null },
      };
    }
    return emptyContextHistory({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress, canHydrate: hasAccount && Boolean(normalizedWalletAddress) });
  }

  function saveContextHistoryProjection({ accountId = "", projection = {}, snapshot = {} } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "context_login_required" };
    const normalizedAccountId = safeId(accountId, "account");
    const normalized = normalizeContextHistoryProjection(projection && typeof projection === "object" && Object.keys(projection).length ? projection : snapshot);
    const normalizedWalletAddress = normalized.walletAddress ? String(normalized.walletAddress).trim() : "";
    if (!normalizedWalletAddress) return { ok: false, status: 409, error: "context_history_wallet_required" };
    const snapshotKey = contextHistorySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress });
    const existing = state.contextHistorySnapshots[snapshotKey];
    const now = new Date().toISOString();
    const document = {
      id: existing?.id || `ctx_history_${snapshotKey}`, accountId: normalizedAccountId, source: normalized.source,
      revision: Number(existing?.revision || 0) + 1, projectedAt: now, normalizedAt: normalized.normalizedAt,
      walletAddress: normalizedWalletAddress, pointerCount: normalized.pointerCount,
      contextUpdateCount: normalized.contextUpdateCount, taskEventCount: normalized.taskEventCount,
      latestContextPointer: normalized.latestContextPointer, contextUpdates: normalized.contextUpdates.slice(0, 50),
      taskEvents: normalized.taskEvents.slice(0, 200), hydration: normalized.hydration,
      sync: { source: "runtime_store", status: "ready", archiveComplete: false, lastHotSyncAt: now, lastArchiveSyncAt: null, lastError: null },
    };
    state.contextHistorySnapshots[snapshotKey] = document;
    if (state.contextHistorySnapshots[normalizedAccountId]?.walletAddress === normalizedWalletAddress) delete state.contextHistorySnapshots[normalizedAccountId];
    saveState();
    return { ok: true, history: { ...document, canHydrate: true } };
  }

  return {
    appendChatTurn, appendUsageCredit, conversationIdForSession, deleteChatConversation,
    getChatMessages, getContextDocument, getContextHistory, listChatConversations,
    renameChatConversation, saveContextDocument, saveContextHistoryProjection, usageLedger, usageSummary,
  };
}
