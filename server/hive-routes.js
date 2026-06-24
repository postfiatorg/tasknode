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
import { getHiveProjectsDocument, getPublicHiveTaskDetail } from "./repositories/hive-projects.js";
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
import {
  getCachedHiveRead,
  hiveReadResponseIsCacheSafe,
} from "./hive-route-cache.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { agentOriginForWalletSession, metadataWithMachineAgentOrigin } from "./agent-origin.js";
import {
  checkAgentRateLimitBucket,
  resetAgentRateLimitBucketsForTests,
} from "./repositories/agent-rate-limits.js";
import { recordAgentHiveChatWorkJournal } from "./repositories/orc-work-journal.js";

const maxHiveAttachmentTextLength = 12_000;
const maxHiveAttachmentExcerptLength = 800;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function agentHiveChatRateLimitConfig() {
  return {
    max: Math.min(Math.max(Number(process.env.TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_MAX || 6), 1), 100),
    windowMs: Math.min(
      Math.max(Number(process.env.TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_WINDOW_MS || 60_000), 1000),
      60 * 60 * 1000
    ),
  };
}

async function checkAgentHiveChatRateLimit(agentOrigin = null, now = Date.now()) {
  if (!agentOrigin?.agent) return { ok: true };
  const key = safeText(
    agentOrigin.walletAddress || agentOrigin.accountId || agentOrigin.agentHandle || "unknown_agent",
    180
  );
  const config = agentHiveChatRateLimitConfig();
  return checkAgentRateLimitBucket({
    action: "hive_chat",
    agentKey: key,
    limit: config.max,
    windowMs: config.windowMs,
    now,
  });
}

export function resetAgentHiveChatRateLimitForTests() {
  resetAgentRateLimitBucketsForTests();
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

async function recordHiveObservabilityEvent({
  eventType = "",
  accountId = "",
  walletAddress = "",
  conversationId = "",
  resultStatus = "",
  reasonCode = "",
  sourceRoute = "",
  metadata = {},
  metrics = {},
} = {}) {
  if (!eventType || !accountId) return;
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    walletAddress,
    walletScope: walletAddress ? "active" : "",
    conversationId,
    sourceSurface: "hive",
    sourceRoute: sourceRoute || "server/hive-routes.js",
    resultStatus,
    reasonCode,
    metadata,
    metrics,
  }).catch(() => {});
}

async function saveHiveChatMessage({
  getLinkedWallet,
  payload,
  session,
  sourceRoute = "server/hive-routes.js::/api/hive/context",
  agentOrigin = null,
} = {}) {
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
  const trustedAgentMetadata = agentOrigin
    ? metadataWithMachineAgentOrigin(payload, agentOrigin)
    : metadataWithMachineAgentOrigin({}, null);
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
      ...trustedAgentMetadata,
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
  await recordHiveObservabilityEvent({
    eventType: "user.hive.context_submitted",
    accountId: session.accountId,
    walletAddress: linkedWallet?.address || "",
    conversationId: sourceConversationId,
    resultStatus: "submitted",
    sourceRoute,
    metadata: {
      entryId: entry.id,
      sourceConversationTitlePresent: Boolean(sourceConversationTitle),
      walletValidated: Boolean(linkedWallet?.address),
      secretaryQueued: secretary?.queued === true,
      senderType: trustedAgentMetadata.senderType || "",
      agentHandle: trustedAgentMetadata.agentOrigin?.agentHandle || "",
    },
    metrics: {
      bodyCharacterCount: body.length,
      attachmentCount: attachments.length,
    },
  });
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
        requestingUser: {
          accountId: session.accountId,
          displayName:
            identityProfile.displayName ||
            (identityProfile.hiveHandle ? `@${identityProfile.hiveHandle}` : "") ||
            session.displayName ||
            "",
          hiveHandle: identityProfile.hiveHandle || session.hiveHandle || "",
          walletAddress: linkedWallet?.address || "",
          publicDisplayName: identityProfile.publicDisplayName || session.publicDisplayName || "",
          primaryProvider: session.primaryProvider || "",
          aliases: identityProfile.aliases || session.linkedProviders || [],
          identityProfile,
        },
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
          ...trustedAgentMetadata,
          kind: "hive_input",
          hiveContextEntryId: entry.id,
        },
        assistantMetadata: {
          kind: "hive_immediate_response",
          hiveContextEntryId: entry.id,
          sourcePacketDigest: immediate.sourcePacketDigest,
          accountLiveStateDigest: immediate.accountLiveStateDigest,
          accountLiveStateSnapshotAt: immediate.accountLiveStateSnapshotAt,
          accountLiveStateStatus: immediate.accountLiveStateStatus,
          boardManagerSourcePacketDigest: immediate.boardManagerSourcePacketDigest,
          boardManagerSecretaryPacketId: immediate.boardManagerSecretaryPacketId,
          boardManagerSecretaryPacketDigest: immediate.boardManagerSecretaryPacketDigest,
          boardManagerSecretaryPacketCurrentForSource: immediate.boardManagerSecretaryPacketCurrentForSource,
        },
        runMetadata: {
          kind: "hive_immediate_response",
          hiveContextEntryId: entry.id,
          sourcePacketDigest: immediate.sourcePacketDigest,
          accountLiveStateDigest: immediate.accountLiveStateDigest,
          accountLiveStateSnapshotAt: immediate.accountLiveStateSnapshotAt,
          accountLiveStateStatus: immediate.accountLiveStateStatus,
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
            ...trustedAgentMetadata,
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

  const orcWorkJournal = agentOrigin
    ? await recordAgentHiveChatWorkJournal({
        agentOrigin,
        accountId: session.accountId,
        conversationId: sourceConversationId,
        hiveContextEntryId: entry.id,
        chatMessageId: chatTurn?.user?.id || "",
        messageCharacterCount: body.length,
      }).catch((error) => ({
        ok: false,
        error: error?.message || "orc_work_journal_failed",
      }))
    : null;

  return {
    ok: true,
    message: "Saved to Hive Context. Hive may respond here if useful.",
    entry,
    chatHistoryWarning,
    immediateResponseWarning,
    user: chatTurn?.user || null,
    assistant: chatTurn?.assistant || null,
    orcWorkJournal,
    context: await getHiveContextDocument({ limit: 120 }),
    secretary: await getHiveSecretaryState(),
    boardManager: {
      feed: await getBoardManagerAgentFeed({ limit: 20 }),
      messages: await getBoardManagerUserMessages({ accountId: session.accountId, limit: 12 }),
    },
  };
}

export async function handleHiveRoute({ getLinkedWallet, json, readJson, req, res, session, url }) {
  if (!["/api/hive/context", "/api/hive/projects", "/api/hive/task-detail", "/api/hive/chat"].includes(url.pathname)) return false;

  if (url.pathname === "/api/hive/projects") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "hive_projects_method_not_allowed",
        message: "Hive projects supports GET.",
      });
      return true;
    }
    const body = await getCachedHiveRead({
      cacheKey: "hive_projects:v1",
      compute: async () => ({
        ok: true,
        document: await getHiveProjectsDocument(),
      }),
      isSafe: (value) => hiveReadResponseIsCacheSafe({
        pathname: url.pathname,
        session,
        value,
      }),
    });
    await recordHiveObservabilityEvent({
      eventType: "user.hive.project_viewed",
      accountId: session?.accountId || "",
      resultStatus: "viewed",
      sourceRoute: "server/hive-routes.js::/api/hive/projects",
      metrics: {
        projectCount: Array.isArray(body?.document?.projects) ? body.document.projects.length : 0,
      },
    });
    json(res, 200, body);
    return true;
  }

  if (url.pathname === "/api/hive/task-detail") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "hive_task_detail_method_not_allowed",
        message: "Hive task detail supports GET.",
      });
      return true;
    }
    const result = await getPublicHiveTaskDetail({ taskId: url.searchParams.get("taskId") || "" });
    json(res, result.ok ? 200 : result.status || 400, result);
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
      await recordHiveObservabilityEvent({
        eventType: "user.hive.board_message_read",
        accountId: session.accountId,
        conversationId: hiveConversationIdForAccount(session.accountId),
        resultStatus: result.ok ? "read" : "failed",
        reasonCode: result.ok ? "" : result.error || "hive_chat_read_failed",
        sourceRoute: "server/hive-routes.js::/api/hive/chat",
      });
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
    const payload = await readJson(req, 8 * 1024 * 1024);
    const hasMessage = Boolean(safeText(payload?.body || payload?.message || "", 24_000));
    const hasAttachments = Array.isArray(payload?.attachments) && payload.attachments.length > 0;
    if (!hasMessage && !hasAttachments) {
      const result = await enableHiveConversation({ accountId: session.accountId });
      json(res, result.ok ? 200 : result.status || 400, result);
      return true;
    }
    const linkedWallet = linkedWalletForSession({ getLinkedWallet, session });
    const agentOrigin = agentOriginForWalletSession(session, payload, linkedWallet?.address || "");
    const rateLimit = await checkAgentHiveChatRateLimit(agentOrigin);
    if (!rateLimit.ok) {
      json(res, 429, {
        ok: false,
        error: "agent_hive_chat_rate_limited",
        message: "Agent Hive chat is rate limited. Retry after the indicated window.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return true;
    }
    const body = await saveHiveChatMessage({
      getLinkedWallet,
      payload,
      session,
      sourceRoute: "server/hive-routes.js::/api/hive/chat",
      agentOrigin,
    });
    json(res, 200, body);
    return true;
  }

  if (req.method === "GET") {
    const accountId = session?.accountId || "";
    const includeAgentLogs = Boolean(accountId) && url.searchParams.get("agentLogs") === "full";
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
    const limit = url.searchParams.get("limit") || 120;
    const computeBody = async () => ({
      ok: true,
      context: await getHiveContextDocument({ limit }),
      secretary: await getHiveSecretaryState(),
      boardManager: {
        feed: await getBoardManagerAgentFeed({
          limit: includeAgentLogs ? 12 : 20,
          includeDetails: includeAgentLogs,
        }),
        logMode: includeAgentLogs ? "full" : "summary",
        logsAvailable: Boolean(accountId),
        messages: accountId ? await getBoardManagerUserMessages({ accountId, limit: 12 }) : [],
      },
    });
    const body = accountId
      ? await computeBody()
      : await getCachedHiveRead({
          cacheKey: `hive_context:v1:limit=${safeText(limit, 20)}`,
          compute: computeBody,
          isSafe: (value) => hiveReadResponseIsCacheSafe({
            pathname: url.pathname,
            session,
            value,
          }),
        });
    json(res, 200, body);
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
  const body = await saveHiveChatMessage({
    getLinkedWallet,
    payload,
    session,
    sourceRoute: "server/hive-routes.js::/api/hive/context",
    agentOrigin: null,
  });
  json(res, 200, body);
  return true;
}
