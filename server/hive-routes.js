import {
  appendChatTurn,
  appendChatUserMessage,
  enableHiveConversation,
  getHiveConversation,
  hiveConversationIdForAccount,
  markHiveConversationRead,
} from "./repositories/chat-billing.js";
import { scheduleHiveSecretaryQueue } from "./hive-secretary-worker.js";
import { getBoardManagerAgentFeed, getBoardManagerUserMessages } from "./repositories/board-manager.js";
import { getHiveProjectsDocument } from "./repositories/hive-projects.js";
import {
  enqueueHiveSecretaryJob,
  getHiveContextDocument,
  getHiveSecretaryState,
  markHiveContextEntriesWalletValidated,
  saveHiveContextEntry,
} from "./repositories/hive-context.js";
import { getAccountIdentityProfile } from "./runtime-store.js";
import { decodeTextDataUrl, normalizeChatAttachments } from "./chat-attachment-utils.js";
import { executeHiveImmediateResponse } from "./hive-immediate-response.js";

const maxHiveAttachmentTextLength = 12_000;
const maxHiveAttachmentExcerptLength = 800;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeAttachments(items = []) {
  return Array.isArray(items)
    ? items.slice(0, 4).map((item) => ({
        name: safeText(item?.name || "attachment", 160),
        mimeType: safeText(item?.mimeType || "", 120),
        size: Math.max(0, Number(item?.size || 0)),
        source: safeText(item?.source || "", 80),
        dataUrl: typeof item?.dataUrl === "string" ? item.dataUrl : undefined,
      }))
    : [];
}

function hiveContextAttachmentSummaries(items = []) {
  return normalizeChatAttachments(items).map((attachment) => {
    const textContent = attachment.kind === "text"
      ? safeText(decodeTextDataUrl(attachment.dataUrl), maxHiveAttachmentTextLength)
      : "";
    return {
      name: safeText(attachment.name || "attachment", 160),
      mimeType: safeText(attachment.mimeType || "", 120),
      size: Math.max(0, Number(attachment.size || 0)),
      source: safeText(attachment.source || "", 80),
      kind: safeText(attachment.kind || "file", 40),
      textContent: textContent || undefined,
      textExcerpt: textContent ? safeText(textContent, maxHiveAttachmentExcerptLength) : undefined,
    };
  });
}

function linkedWalletForSession({ getLinkedWallet, session }) {
  if (!session?.accountId || typeof getLinkedWallet !== "function") return null;
  try {
    const wallet = getLinkedWallet({ accountId: session.accountId });
    if (wallet?.status === "linked" && wallet?.address) return wallet;
  } catch {
    return null;
  }
  return null;
}

export async function handleHiveRoute({ getLinkedWallet, json, readJson, req, res, session, url }) {
  if (!["/api/hive/context", "/api/hive/projects", "/api/hive/chat"].includes(url.pathname)) return false;

  if (url.pathname === "/api/hive/projects") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "hive_projects_method_not_allowed",
        message: "Hive projects supports GET.",
      });
      return true;
    }
    json(res, 200, {
      ok: true,
      document: await getHiveProjectsDocument(),
    });
    return true;
  }

  if (url.pathname === "/api/hive/chat") {
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "hive_chat_login_required",
        message: "Sign in before enabling Hive chat.",
      });
      return true;
    }
    if (req.method === "GET") {
      json(res, 200, {
        ok: true,
        conversation: await getHiveConversation({ accountId: session.accountId }),
      });
      return true;
    }
    if (req.method === "PATCH") {
      const result = await markHiveConversationRead({ accountId: session.accountId });
      json(res, result.ok ? 200 : result.status || 400, result);
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "hive_chat_method_not_allowed",
        message: "Hive chat supports GET, POST, and PATCH.",
      });
      return true;
    }
    const result = await enableHiveConversation({ accountId: session.accountId });
    json(res, result.ok ? 200 : result.status || 400, result);
    return true;
  }

  if (req.method === "GET") {
    const accountId = session?.accountId || "";
    const linkedWallet = linkedWalletForSession({ getLinkedWallet, session });
    if (accountId && linkedWallet?.address) {
      const validated = await markHiveContextEntriesWalletValidated({
        accountId,
        walletAddress: linkedWallet.address,
      });
      if (validated.updated > 0) {
        const secretary = await enqueueHiveSecretaryJob({
          reason: "hive_context_wallet_validation",
          sourceEntryId: validated.entryIds?.[0] || "",
        });
        if (secretary?.queued) {
          scheduleHiveSecretaryQueue({ delayMs: 250 });
        }
      }
    }
    json(res, 200, {
      ok: true,
      context: await getHiveContextDocument({ limit: url.searchParams.get("limit") || 120 }),
      secretary: await getHiveSecretaryState(),
      boardManager: {
        feed: await getBoardManagerAgentFeed({ limit: 20 }),
        messages: accountId ? await getBoardManagerUserMessages({ accountId, limit: 12 }) : [],
      },
    });
    return true;
  }

  if (!session?.accountId) {
    json(res, 401, {
      ok: false,
      error: "hive_context_login_required",
      message: "Sign in before writing Hive Context.",
    });
    return true;
  }

  if (req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "hive_context_method_not_allowed",
      message: "Hive Context supports GET and POST.",
    });
    return true;
  }

  const payload = await readJson(req, 8 * 1024 * 1024);
  const body = safeText(payload?.body || payload?.message || "", 24_000);
  const sourceConversationId = safeText(
    payload?.conversationId || hiveConversationIdForAccount(session.accountId),
    180
  );
  const sourceConversationTitle = safeText(payload?.conversationTitle || "", 160);
  const attachments = safeAttachments(payload?.attachments || []);
  const hiveContextAttachments = hiveContextAttachmentSummaries(attachments);
  const linkedWallet = linkedWalletForSession({ getLinkedWallet, session });
  const identityProfile = getAccountIdentityProfile({ accountId: session.accountId }) || {};
  const entry = await saveHiveContextEntry({
    accountId: session.accountId,
    displayName:
      identityProfile.displayName ||
      (identityProfile.hiveHandle ? `@${identityProfile.hiveHandle}` : "") ||
      session.displayName ||
      session.primaryProvider ||
      session.accountId,
    body,
    sourceConversationId,
    sourceConversationTitle,
    walletAddress: linkedWallet?.address || "",
    walletValidated: Boolean(linkedWallet?.address),
    attachments: hiveContextAttachments,
    metadata: {
      kind: "hive_input",
      source: "user_chat",
      walletValidated: Boolean(linkedWallet?.address),
    },
  });
  const secretary = linkedWallet?.address
    ? await enqueueHiveSecretaryJob({
        reason: "hive_input",
        sourceEntryId: entry.id,
      })
    : await getHiveSecretaryState();
  if (secretary?.queued) {
    scheduleHiveSecretaryQueue({ delayMs: 250 });
  }
  let chatTurn = null;
  let chatHistoryWarning = "";
  let immediateResponseWarning = "";
  if (sourceConversationId) {
    try {
      const immediate = await executeHiveImmediateResponse({
        accountId: session.accountId,
        conversationId: sourceConversationId,
        message: body,
        attachments,
        sourceEntryId: entry.id,
      });
      chatTurn = await appendChatTurn({
        accountId: session.accountId,
        conversationId: sourceConversationId,
        mode: "Hive",
        provider: immediate.provider,
        model: immediate.model,
        responseId: immediate.responseId,
        userMessage: body,
        assistantMessage: immediate.text,
        userMessageId: safeText(payload?.userMessageId || "", 180),
        assistantMessageId: safeText(payload?.assistantMessageId || "", 180),
        conversationTitle: "Hive",
        userMetadata: {
          kind: "hive_input",
          hiveContextEntryId: entry.id,
        },
        assistantMetadata: {
          kind: "hive_immediate_response",
          hiveContextEntryId: entry.id,
          sourcePacketDigest: immediate.sourcePacketDigest,
          boardManagerSourcePacketDigest: immediate.boardManagerSourcePacketDigest,
          boardManagerSecretaryPacketId: immediate.boardManagerSecretaryPacketId,
          boardManagerSecretaryPacketDigest: immediate.boardManagerSecretaryPacketDigest,
          boardManagerSecretaryPacketCurrentForSource: immediate.boardManagerSecretaryPacketCurrentForSource,
        },
        runMetadata: {
          kind: "hive_immediate_response",
          hiveContextEntryId: entry.id,
          sourcePacketDigest: immediate.sourcePacketDigest,
          boardManagerSourcePacketDigest: immediate.boardManagerSourcePacketDigest,
          boardManagerSecretarySourceDigest: immediate.boardManagerSecretarySourceDigest,
          boardManagerSecretaryPacketId: immediate.boardManagerSecretaryPacketId,
          boardManagerSecretaryPacketDigest: immediate.boardManagerSecretaryPacketDigest,
          boardManagerSecretaryPacketCurrentForSource: immediate.boardManagerSecretaryPacketCurrentForSource,
          internalBilling: "system_paid",
          providerCostUsd: immediate.usage?.providerCostUsd || 0,
        },
        attachments,
        usage: {
          ...immediate.usage,
          costUsd: 0,
        },
      });
    } catch (error) {
      immediateResponseWarning = error?.message || "hive_immediate_response_failed";
      try {
        chatTurn = await appendChatUserMessage({
          accountId: session.accountId,
          conversationId: sourceConversationId,
          mode: "Hive",
          provider: "tasknode",
          model: "hive_context_store",
          userMessage: body,
          userMessageId: safeText(payload?.userMessageId || "", 180),
          conversationTitle: "Hive",
          userMetadata: {
            kind: "hive_input",
            hiveContextEntryId: entry.id,
          },
          attachments,
        });
      } catch (chatError) {
        chatHistoryWarning = chatError?.message || "chat_history_write_failed";
      }
    }
  }

  json(res, 200, {
    ok: true,
    message: "Saved to Hive Context. Hive may respond here if useful.",
    entry,
    chatHistoryWarning,
    immediateResponseWarning,
    user: chatTurn?.user || null,
    assistant: chatTurn?.assistant || null,
    context: await getHiveContextDocument({ limit: 120 }),
    secretary: await getHiveSecretaryState(),
    boardManager: {
      feed: await getBoardManagerAgentFeed({ limit: 20 }),
      messages: await getBoardManagerUserMessages({ accountId: session.accountId, limit: 12 }),
    },
  });
  return true;
}
