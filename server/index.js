import { installProcessHardening } from "./process-hardening.js";
import { startChatStreamHeartbeat } from "./chat-stream-heartbeat.js";
import { readValidatedJson as readJson } from "./request-validation.js";
import * as trustedProxy from "./trusted-proxy.js";
import {
  assertStartupSecurity,
  cookieValue,
  enforceRateLimit,
  enforceRoutePolicy,
  expiredSessionCookie,
  json,
  requestIp,
  requestOrigin,
  runtimeConfig,
  runtimeConfigScript,
  securityHeaders,
  serveStatic,
  writeSse,
} from "./server-http-boundary.js";
installProcessHardening();

const [
  { createServer },
  { getCachedAppState, invalidateCachedAppState },
  { legacyHostRedirectTarget },
  { fetchPftBalance },
  { handlePftlCacheRoute },
  { fetchWalletTransactions },
  {
    authCallback, authDevStart, authEmailStart, authEmailVerify, authProviders, authStart, authTelegramAuthorize, chatEstimateStart,
    chatModes, chatSend, chatStreamStart, contextActionStart, contextActions, contextEditSave,
    contextManifestInk, contextHistoryIpfsFetch, readiness, taskRequestIntentStart,
    usageActions, usageAdminCredit, usageTopUpStart, usageTopUpSync, userObservabilityClientEvent, walletActionStart, walletActions,
    walletLinkStart, walletLinkVerify,
  },
  { executeChatStream, logChatProviderError },
  { conversationIdForChatWrite, explicitConversationId },
  {
    conversationIdForSession,
    sessionCookieName,
  },
  { getSession },
  { migrateLegacyRuntimeAuthority },
  { getLinkedWallet },
  {
    deleteChatConversation,
    getChatMessages,
    listChatConversations,
    renameChatConversation,
    searchChatConversations,
    usageLedger,
  },
  { recordChatFailureObservability },
  { chatConversationExistsForAccount },
  { migrateDatabase },
  { observeApiRoute },
  { authWalletStart, authWalletVerify },
  { oauthStateCookieName, responseHeadersForAuthResult },
  { telegramAuthHeaders },
  { handleTaskReadRoute },
  { handleTaskNodeTerminalRoute },
  { handleAccountRoute },
  { contextEditProposalAction },
  { handleContextRewriteRoute },
  { handleDeepResearchRoute },
  { handleProfileRoute },
  { handleProfileNftImageRoute, handleProfileNftPfpRoute },
  { handleMemoryRoute },
  { handleIChingRoute },
  { handleCollaborationRoute },
  { handleDirectoryRoute },
  { handleHiveRoute },
  { handleCapabilityProfileRoute },
  { handleNetworkBadgeAdminRoute },
  { handleBoardAdminRoute },
  { handleBmFeedRoute },
  { handleSystemStatusRoute },
  { handleTelegramBotRoute },
  { walletSendPrepare, walletSendSubmit },
  { shouldStartBackgroundWorkers, shouldStartHttpServer, tasknodeProcessRole },
  { startRealtimeNotificationListener, subscribeRealtimeEvents },
  { agentOriginForWalletSession },
  { startBackgroundWorkerKeepalive },
  { authResultHeaders, currentAuthIntent, handleAccountAuthRoutes },
] = await Promise.all([
  import("node:http"),
  import("./app-state.js"),
  import("./production-guards.js"),
  import("./pftl-balance.js"),
  import("./pftl-cache-route.js"),
  import("./pftl-transactions.js"),
  import("./product-contracts.js"),
  import("./chat-router.js"),
  import("./chat-conversation-ids.js"),
  import("./runtime-store.js"),
  import("./repositories/auth-sessions.js"),
  import("./repositories/runtime-authority.js"),
  import("./repositories/account-wallets.js"),
  import("./repositories/chat-billing.js"),
  import("./repositories/user-observability.js"),
  import("./repositories/chat-conversation-lookup.js"),
  import("./db/migrate.js"),
  import("./route-observability.js"),
  import("./auth-wallet-login.js"),
  import("./auth-oauth-http.js"),
  import("./auth-connected-accounts.js"),
  import("./task-routes.js"),
  import("./tasknode-terminal-routes.js"),
  import("./account-routes.js"),
  import("./context-edit-actions.js"),
  import("./context-rewrite-actions.js"),
  import("./deep-research-routes.js"),
  import("./profile-routes.js"),
  import("./profile-nft-image-proxy.js"),
  import("./memory-routes.js"),
  import("./i-ching-routes.js"),
  import("./collaboration-routes.js"),
  import("./directory-routes.js"),
  import("./hive-routes.js"),
  import("./capability-profile-routes.js"),
  import("./network-badge-admin-routes.js"),
  import("./board-admin-routes.js"),
  import("./bm-transcript-routes.js"),
  import("./system-status.js"),
  import("./telegram-bot.js"),
  import("./wallet-send.js"),
  import("./process-role.js"),
  import("./app-realtime.js"),
  import("./agent-origin.js"),
  import("./background-worker-liveness.js"),
  import("./account-auth-routes.js"),
]);

const port = Number(process.env.PORT || 8080);
const buildId = process.env.VITE_BUILD_ID || process.env.BUILD_ID || "dev";
const environment = process.env.TASKNODE_ENV || process.env.NODE_ENV || "development";

function resolveChatWriteConversationId(session, requestedId = "") {
  return conversationIdForChatWrite({
    conversationIdForSession,
    existsForAccount: chatConversationExistsForAccount,
    requestedId,
    session,
  });
}

async function agentOriginForCurrentWalletSession(session = null, payload = {}) {
  const linkedWallet = session?.accountId ? await getLinkedWallet({ accountId: session.accountId }) : null;
  const walletAddress = linkedWallet?.status === "linked" ? linkedWallet.address || "" : "";
  return agentOriginForWalletSession(session, payload, walletAddress);
}

async function routeApi(req, url, res) {
  const sessionId = cookieValue(req, sessionCookieName);
  const session = await getSession(sessionId);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.once("finish", () => {
      if (res.statusCode < 400) invalidateCachedAppState(session);
    });
  }
  observeApiRoute({ req, res, url, session });
  let statePromise = null;
  const getState = () => {
    if (!statePromise) {
      const refreshTaskProjection = url.searchParams.get("taskProjectionRefresh") === "1";
      statePromise = getCachedAppState(session, { refreshTaskProjection });
    }
    return statePromise;
  };
  const parts = url.pathname.split("/").filter(Boolean);
  if (await enforceRoutePolicy(req, url, res, session)) return true;

  if (url.pathname === "/api/app-state") {
    json(res, 200, await getState());
    return true;
  }

  if (url.pathname === "/api/session") {
    const state = await getState();
    json(res, 200, state.session);
    return true;
  }

  if (url.pathname === "/api/user-observability/event") {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await userObservabilityClientEvent(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/auth/dev/start") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await authDevStart(payload, req.method);
    const headers = await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) });
    json(res, result.status, result.body, headers);
    return true;
  }

  if (url.pathname === "/api/auth/email/start") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await authEmailStart(payload, req.method, {
      ip: requestIp(req),
      userAgent: req.headers["user-agent"] || "",
    });
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/auth/email/verify") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await authEmailVerify(payload, req.method);
    const headers = await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) });
    json(res, result.status, result.body, headers);
    return true;
  }

  if (await handleAccountAuthRoutes({ req, res, url, session, sessionId })) return true;

  if (url.pathname === "/api/auth/wallet/start") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const address = String(payload?.address || "").trim();
    if (await enforceRateLimit(req, res, {
      route: "auth_wallet_start_address",
      session: null,
      extra: address || "missing_address",
      limit: 5,
      windowMs: 10 * 60_000,
    })) return true;
    const result = await authWalletStart(payload, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/auth/wallet/verify") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const address = String(payload?.address || "").trim();
    if (await enforceRateLimit(req, res, {
      route: "auth_wallet_verify_address",
      session: null,
      extra: address || "missing_address",
      limit: 10,
      windowMs: 10 * 60_000,
    })) return true;
    const result = await authWalletVerify(payload, req.method);
    const headers = await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) });
    json(res, result.status, result.body, headers);
    return true;
  }

  if (url.pathname === "/api/auth/providers") {
    json(res, 200, { providers: authProviders() });
    return true;
  }

  if (await handleTaskNodeTerminalRoute({
    json,
    readJson,
    req,
    res,
    url,
    origin: requestOrigin(req),
    responseHeadersForAuthResult,
  })) return true;

  if (url.pathname === "/api/auth/telegram/authorize") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "telegram_authorize_method_not_allowed", message: "Telegram authorization requires GET.", actionRequired: "Start Telegram auth again from Task Node." });
      return true;
    }

    const result = await authTelegramAuthorize(Object.fromEntries(url.searchParams.entries()), {
      origin: requestOrigin(req),
      oauthState: cookieValue(req, oauthStateCookieName("telegram")),
    });
    res.writeHead(result.status, telegramAuthHeaders());
    res.end(result.body);
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "start" && parts[3]) {
    const authIntent = await currentAuthIntent(req);
    const result = await authStart(parts[3], {
      origin: requestOrigin(req),
      redirectPath: url.searchParams.get("redirect") || "/",
      proof: url.searchParams.get("proof") || "",
      session: authIntent === "add_account" ? null : session,
      authIntent,
    });
    json(res, result.status, result.body, responseHeadersForAuthResult(req, result));
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "callback" && parts[3]) {
    const providerId = parts[3];
    const result = await authCallback(
      providerId,
      Object.fromEntries(url.searchParams.entries()),
      {
        origin: requestOrigin(req),
        oauthState: cookieValue(req, oauthStateCookieName(providerId)),
      }
    );
    const headers = await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) });
    if (result.status >= 300 && result.status < 400 && result.redirectLocation) {
      res.writeHead(result.status, {
        "cache-control": "no-store",
        ...securityHeaders(),
        ...headers,
      });
      res.end("");
    } else {
      json(res, result.status, result.body, headers);
    }
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[3] === "start") {
    const authIntent = await currentAuthIntent(req);
    const result = await authStart(parts[2], {
      origin: requestOrigin(req),
      redirectPath: url.searchParams.get("redirect") || "/",
      proof: url.searchParams.get("proof") || "",
      session: authIntent === "add_account" ? null : session,
      authIntent,
    });
    json(res, result.status, result.body, responseHeadersForAuthResult(req, result));
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[3] === "callback") {
    const providerId = parts[2];
    const result = await authCallback(
      providerId,
      Object.fromEntries(url.searchParams.entries()),
      {
        origin: requestOrigin(req),
        oauthState: cookieValue(req, oauthStateCookieName(providerId)),
      }
    );
    const headers = await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) });
    if (result.status >= 300 && result.status < 400 && result.redirectLocation) {
      res.writeHead(result.status, {
        "cache-control": "no-store",
        ...securityHeaders(),
        ...headers,
      });
      res.end("");
    } else {
      json(res, result.status, result.body, headers);
    }
    return true;
  }

  if (url.pathname === "/api/readiness") {
    json(res, 200, await readiness());
    return true;
  }

  if (await handleSystemStatusRoute({ json, res, url })) return true;

  if (await handleTaskReadRoute({ getLinkedWallet, json, readJson, req, res, session, url })) return true;

  if (await handleTelegramBotRoute({ json, readJson, req, res, url })) return true;

  if (url.pathname === "/api/chat/estimate") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    const result = await chatEstimateStart(payload, session?.accountId || "");
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/chat/modes") {
    json(res, 200, { modes: chatModes({ signedOut: !session?.accountId }) });
    return true;
  }

  if (url.pathname === "/api/chat/conversations") {
    json(res, 200, {
      conversations: session?.accountId
        ? await listChatConversations({
            accountId: session.accountId,
            limit: url.searchParams.get("limit") || 30,
          })
        : [],
    });
    return true;
  }

  if (url.pathname === "/api/chat/conversation") {
    if (req.method !== "PATCH" && req.method !== "DELETE") {
      json(res, 405, {
        ok: false,
        error: "chat_conversation_method_not_allowed",
        message: "Chat conversation updates require PATCH or DELETE.",
      });
      return true;
    }

    const payload = await readJson(req);
    const conversationId = explicitConversationId(payload?.conversationId || payload?.id || "");
    const action =
      req.method === "PATCH"
        ? await renameChatConversation({
            accountId: session?.accountId || "",
            conversationId,
            title: payload?.title || "",
          })
        : await deleteChatConversation({
            accountId: session?.accountId || "",
            conversationId,
          });

    json(res, action.ok ? 200 : action.status || 400, action);
    return true;
  }

  if (url.pathname === "/api/chat/history") {
    if (!session?.accountId) {
      json(res, 401, { ok: false, error: "chat_history_login_required", message: "Sign in before reading chat history." });
      return true;
    }
    const conversationId = explicitConversationId(url.searchParams.get("conversationId") || "") || conversationIdForSession(session);
    json(res, 200, {
      conversationId,
      messages: await getChatMessages({ accountId: session.accountId, conversationId }),
    });
    return true;
  }

  if (url.pathname === "/api/chat/search") {
    if (!session?.accountId) {
      json(res, 401, { ok: false, error: "chat_search_login_required", message: "Sign in before searching chats." });
      return true;
    }
    const searchQuery = String(url.searchParams.get("q") || "").trim();
    if (searchQuery.length < 2) {
      json(res, 200, { ok: true, query: searchQuery, results: [] });
      return true;
    }
    json(res, 200, {
      ok: true,
      query: searchQuery,
      results: await searchChatConversations({
        accountId: session.accountId,
        query: searchQuery,
        limit: url.searchParams.get("limit") || 20,
      }),
    });
    return true;
  }

  if (await handleMemoryRoute({ json, readJson, req, res, session, url })) return true;

  if (await handleIChingRoute({ json, readJson, req, res, session, url })) return true;

  if (await handleCollaborationRoute({ json, readJson, req, res, session, url })) return true;

  if (await handleAccountRoute({
    expiredSessionCookie: () => expiredSessionCookie(req),
    json,
    readJson,
    req,
    res,
    session,
    sessionId,
    url,
  })) return true;

  if (await handleProfileNftPfpRoute({ json, req, res, url })) return true;
  if (await handleProfileNftImageRoute({ json, req, res, url })) return true;

  if (await handleProfileRoute({ getState, json, readJson, req, res, session, url })) return true;

  if (await handleDirectoryRoute({ json, req, res, session, url })) return true;

  if (await handleCapabilityProfileRoute({ json, readJson, req, res, url })) return true;
  if (await handleNetworkBadgeAdminRoute({ json, readJson, req, res, url })) return true;
  if (await handleBoardAdminRoute({ json, readJson, req, res, url })) return true;
  if (await handleBmFeedRoute({ json, req, res, url })) return true;

  if (await handleHiveRoute({ getLinkedWallet, json, readJson, req, res, session, url })) return true;

  if (url.pathname === "/api/chat/stream") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await resolveChatWriteConversationId(session, payload?.conversationId || "");
    const started = await chatStreamStart(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method,
      { agentOrigin: await agentOriginForCurrentWalletSession(session, payload) }
    );

    if (!started.stream) {
      json(res, started.status, started.body);
      return true;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...securityHeaders(),
    });
    writeSse(res, "meta", started.body);

    const controller = new AbortController();
    const heartbeat = startChatStreamHeartbeat(res);
    res.on("close", () => {
      heartbeat.stop();
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await executeChatStream({
        ...started.chat,
        signal: controller.signal,
        onDelta: (delta) => writeSse(res, "delta", { delta }),
      });

      writeSse(res, "done", {
        ok: true,
        action: "chat_stream",
        message: "Chat response generated.",
        conversationId,
        mode: started.chat.mode,
        persona: result.persona || started.chat.persona,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        user: result.user,
        assistant: result.assistant,
        estimate: started.estimate,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          inputTokens: result.usage.inputTokens,
          promptCacheHitTokens: result.usage.promptCacheHitTokens || 0,
          promptCacheMissTokens: result.usage.promptCacheMissTokens || 0,
          promptCacheHitRate: result.usage.promptCacheHitRate || 0,
          cacheUsageReported: result.usage.cacheUsageReported === true,
          cacheSavingsUsd: result.usage.cacheSavingsUsd || 0,
          costSource: result.usage.costSource || "",
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          webSearchCalls: result.usage.webSearchCalls || 0,
          toolCostUsd: result.usage.toolCostUsd || 0,
          costUsd: result.usage.costUsd,
          estimated: result.usage.estimated === true,
        },
        ledgerEntry: result.ledgerEntry,
        contextStatus: result.contextStatus || started.chat.contextStatus,
      });
    } catch (error) {
      if (error?.status !== 499) {
        logChatProviderError(error, {
          action: "chat_stream",
          mode: started.chat.mode,
          provider: started.estimate?.provider,
          model: started.estimate?.model,
        });
        await recordChatFailureObservability({
          accountId: started.chat.accountId,
          conversationId,
          mode: started.chat.mode,
          provider: started.estimate?.provider,
          model: started.estimate?.model,
          status: error?.status || 502,
          error,
          sourceRoute: "server/index.js::/api/chat/stream",
        }).catch(() => {});
        writeSse(res, "error", {
          ok: false,
          error: error?.message || "chat_provider_error",
          action: "chat_stream",
          message:
            error?.status === 504
              ? "The chat provider timed out before returning a response."
              : "The chat provider could not complete this response.",
          actionRequired:
            "Retry with a shorter prompt, choose another configured mode, or check provider health.",
          estimate: started.estimate,
        });
      }
    } finally {
      heartbeat.stop();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return true;
  }

  if (url.pathname === "/api/chat/send") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await resolveChatWriteConversationId(session, payload?.conversationId || "");
    const result = await chatSend(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method,
      { agentOrigin: await agentOriginForCurrentWalletSession(session, payload) }
    );
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/tasks/request-intent") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await resolveChatWriteConversationId(session, payload?.conversationId || "");
    const result = await taskRequestIntentStart(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method
    );
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/wallet") {
    const state = await getState();
    json(res, 200, state.wallet);
    return true;
  }

  if (url.pathname === "/api/wallet/balance") {
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "wallet_login_required",
        message: "Sign in before reading a linked wallet balance.",
      });
      return true;
    }

    const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
    if (linkedWallet.status !== "linked" || !linkedWallet.address) {
      json(res, 409, {
        ok: false,
        error: "wallet_not_linked",
        message: "Link a PFT wallet before reading a balance.",
      });
      return true;
    }

    const result = await fetchPftBalance(linkedWallet.address, {
      force: url.searchParams.get("force") === "1",
    });
    json(res, result.status || (result.ok ? 200 : 502), result);
    return true;
  }

  if (url.pathname === "/api/wallet/transactions") {
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "wallet_login_required",
        message: "Sign in before reading linked wallet transactions.",
      });
      return true;
    }

    const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
    if (linkedWallet.status !== "linked" || !linkedWallet.address) {
      json(res, 409, {
        ok: false,
        error: "wallet_not_linked",
        message: "Link a PFT wallet before reading transactions.",
      });
      return true;
    }

    const result = await fetchWalletTransactions(linkedWallet.address, {
      accountId: session.accountId,
      force: url.searchParams.get("force") === "1",
      limit: url.searchParams.get("limit"),
    });
    json(res, result.status || (result.ok ? 200 : 502), result);
    return true;
  }

  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const linkedWallet = session?.accountId ? await getLinkedWallet({ accountId: session.accountId }) : null;
    const subscribed = subscribeRealtimeEvents({
      req,
      res,
      session,
      linkedWallet,
      headers: securityHeaders(),
    });
    if (!subscribed.ok) {
      json(res, subscribed.status || 401, {
        ok: false,
        error: subscribed.error || "realtime_events_unavailable",
      });
    }
    return true;
  }

  if (url.pathname === "/api/wallet/send/prepare") {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await walletSendPrepare(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/wallet/send/submit") {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await walletSendSubmit(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (await handlePftlCacheRoute({ url, res, session, json })) return true;

  if (url.pathname === "/api/wallet/actions") {
    json(res, 200, { actions: walletActions() });
    return true;
  }

  if (url.pathname === "/api/wallet/link/start") {
    const result = await walletLinkStart(req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/wallet/link/verify") {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await walletLinkVerify(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (
    url.pathname === "/api/wallet/create/start" ||
    url.pathname === "/api/wallet/initiation/retry" ||
    url.pathname === "/api/wallet/unlock/start" ||
    url.pathname === "/api/wallet/delink" ||
    url.pathname === "/api/wallet/relink/start"
  ) {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await walletActionStart(url.pathname, req.method, session, payload);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context") {
    const state = await getState();
    json(res, 200, state.context);
    return true;
  }

  if (url.pathname === "/api/context/history") {
    const state = await getState();
    json(res, 200, state.context.history);
    return true;
  }

  if (url.pathname.startsWith("/api/context/history/ipfs/")) {
    const cid = decodeURIComponent(url.pathname.slice("/api/context/history/ipfs/".length));
    const result = await contextHistoryIpfsFetch({ cid }, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/actions") {
    json(res, 200, { actions: contextActions() });
    return true;
  }

  if (url.pathname === "/api/context/import/start") {
    const result = contextActionStart(url.pathname, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/manifest/ink") {
    const payload = req.method === "POST" ? await readJson(req, 1_200_000) : {};
    const result = await contextManifestInk(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (await handleContextRewriteRoute({ json, readJson, req, res, session, url })) return true;
  if (await handleDeepResearchRoute({ json, readJson, req, res, session, url })) return true;

  if (url.pathname.startsWith("/api/context/edit/proposals/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const result = await contextEditProposalAction({ action: parts[5] || "", method: req.method, proposalId: decodeURIComponent(parts[4] || ""), session });
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/edit/save") {
    const payload = req.method === "POST" ? await readJson(req, 65536) : {};
    const result = await contextEditSave(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage") {
    const state = await getState();
    json(res, 200, state.usage);
    return true;
  }

  if (url.pathname === "/api/usage/actions") {
    json(res, 200, { actions: usageActions() });
    return true;
  }

  if (url.pathname === "/api/usage/top-up/start") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await usageTopUpStart(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage/top-up/sync") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await usageTopUpSync(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage/credit/admin") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = await usageAdminCredit(payload, req.method, req.headers.authorization || "");
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage/ledger") {
    if (!session?.accountId) {
      json(res, 401, { error: "usage_ledger_login_required" });
      return true;
    }
    const requestedConversationId = url.searchParams.get("conversationId") || "";
    const conversationId = requestedConversationId
      ? await resolveChatWriteConversationId(session, requestedConversationId)
      : conversationIdForSession(session);
    json(res, 200, await usageLedger({
      accountId: session.accountId,
      conversationId,
      limit: url.searchParams.get("limit") || 50,
    }));
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://tasknode.local");

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      service: "tasknodeofficial",
      environment,
      buildId,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  const legacyRedirect = legacyHostRedirectTarget({
    host: trustedProxy.requestHost(req),
    method: req.method,
    pathname: url.pathname,
    search: url.search,
  });
  if (legacyRedirect) {
    res.writeHead(301, { location: legacyRedirect, "cache-control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname === "/runtime-config.js") {
    runtimeConfigScript(res);
    return;
  }

  if (url.pathname === "/runtime-config.json") {
    json(res, 200, runtimeConfig());
    return;
  }

  routeApi(req, url, res)
    .then((handled) => {
      if (handled) return;
      if (url.pathname.startsWith("/api/")) {
        json(res, 404, { ok: false, error: "api_route_not_found" });
        return;
      }

      serveStatic(url, res).catch((error) => {
        json(res, 500, { ok: false, error: error?.message || "internal_error" });
      });
    })
    .catch((error) => {
      if (url.pathname.startsWith("/api/")) {
        console.warn("api_route_failed", {
          method: req.method,
          path: url.pathname,
          status: error?.status || 500,
          error: String(error?.message || error || "internal_error").slice(0, 1000),
        });
      }
      json(res, error?.status || 500, {
        ok: false,
        error: error?.message || "internal_error",
      });
    });
});

const processRole = tasknodeProcessRole();
const httpEnabled = shouldStartHttpServer(processRole);
const backgroundWorkersEnabled = shouldStartBackgroundWorkers(processRole);

if (backgroundWorkersEnabled) {
  throw new Error(`web_entry_rejects_worker_role:${processRole}. Use server/worker-entry.js for background workers.`);
}
if (!httpEnabled) {
  throw new Error(`web_entry_requires_web_role:${processRole}`);
}

if (httpEnabled) assertStartupSecurity();
try {
  await migrateDatabase();
  if (httpEnabled) await migrateLegacyRuntimeAuthority();
} catch (error) {
  if (process.env.TASKNODE_FLY_DEV_DATA_BRIDGE === "true") {
    throw new Error(
      "Fly dev data bridge is enabled but Postgres is unreachable. Rerun `npm run docker:dev:fly-data` or start the proxy with `npm run fly-dev:data:proxy`."
    );
  }
  throw error;
}
startBackgroundWorkerKeepalive();
if (httpEnabled) {
  startRealtimeNotificationListener().catch((error) => {
    console.warn("realtime_notification_listener_start_failed", { error: error?.message || String(error) });
  });
}

if (httpEnabled) {
  const bindHost = process.env.TASKNODE_BIND_HOST
    || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  server.listen(port, bindHost, () => {
    console.log(`tasknodeofficial listening on ${bindHost}:${port} role=${processRole}`);
  });
} else {
  console.log(`tasknodeofficial background process started role=${processRole}`);
}
