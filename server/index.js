import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState } from "./app-state.js";
import { startBackgroundWorkers } from "./background-workers.js";
import { fetchPftBalance } from "./pftl-balance.js";
import { handlePftlCacheRoute } from "./pftl-cache-route.js";
import { fetchWalletTransactions } from "./pftl-transactions.js";
import {
  authCallback, authDevStart, authEmailStart, authEmailVerify, authProviders, authStart, authTelegramAuthorize, chatEstimateStart,
  chatModes, chatSend, chatStreamStart, contextActionStart, contextActions, contextEditSave,
  contextManifestInk, contextHistoryIpfsFetch, devAuthStatus, readiness, taskRequestIntentStart,
  usageActions, usageAdminCredit, usageTopUpStart, usageTopUpSync, walletActionStart, walletActions,
  walletLinkStart, walletLinkVerify,
} from "./product-contracts.js";
import { executeChatStream } from "./chat-router.js";
import { conversationIdForChatWrite, explicitConversationId } from "./chat-conversation-ids.js";
import {
  conversationIdForSession,
  destroySession,
  getLinkedWallet,
  getSession,
  runtimeStoreStatus,
  sessionCookieName,
  sessionTtlSeconds,
} from "./runtime-store.js";
import {
  deleteChatConversation,
  getChatMessages,
  listChatConversations,
  renameChatConversation,
  usageLedger,
} from "./repositories/chat-billing.js";
import { chatConversationExistsForAccount } from "./repositories/chat-conversation-lookup.js";
import { migrateDatabase } from "./db/migrate.js";
import { checkRateLimit } from "./rate-limit.js";
import { routePolicyForPath, routePolicyRateLimitExtra } from "./route-policies.js";
import { oauthStateCookieName, responseHeadersForAuthResult } from "./auth-oauth-http.js";
import { telegramAuthHeaders } from "./auth-connected-accounts.js";
import { handleTaskReadRoute } from "./task-routes.js";
import { contextEditProposalAction } from "./context-edit-actions.js";
import { handleProfileRoute } from "./profile-routes.js";
import { handleMemoryRoute } from "./memory-routes.js";
import { handleHiveRoute } from "./hive-routes.js";
import { shouldStartBackgroundWorkers, shouldStartHttpServer, tasknodeProcessRole } from "./process-role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
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

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://traffic.postfiat.org https://us.posthog.com https://*.posthog.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
    ...headers,
  });
  res.end(text);
}

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

async function readJson(req, maxBytes = 16384) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const parseError = new Error("invalid_json");
    parseError.status = 400;
    throw parseError;
  }
}

function runtimeConfig() {
  return {
    appName: "tasknodeofficial",
    buildId,
    environment,
    siteOrigin: process.env.VITE_SITE_ORIGIN || process.env.TASKNODE_PUBLIC_URL || "",
    pftlExplorerUrl: process.env.VITE_PFTL_EXPLORER_URL || process.env.PFTL_EXPLORER_URL || "",
    pftlWssUrl: process.env.VITE_PFTL_WSS_URL || "",
    analyticsEnabled: process.env.VITE_ANALYTICS_ENABLED !== "false",
    posthogHost: process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_UI_HOST || "",
    posthogKeyPresent: Boolean(process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY),
  };
}

function runtimeConfigScript(res) {
  const script = `window.__TASKNODE_CONFIG__ = ${JSON.stringify(runtimeConfig())};\n`;
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  res.end(script);
}

function cookieValue(req, name) {
  const cookieHeader = req.headers.cookie || "";
  const pairs = cookieHeader.split(";").map((item) => item.trim()).filter(Boolean);

  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const key = pair.slice(0, index);
    if (key !== name) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1));
    } catch {
      return "";
    }
  }

  return "";
}

function currentSession(req) {
  return getSession(cookieValue(req, sessionCookieName));
}

function secureCookie(req) {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    (process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "").startsWith("https://")
  );
}

function requestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = forwarded || req.socket?.remoteAddress || "";
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

function rateLimitKey(req, route, session = null, extra = "") {
  return [
    route,
    session?.accountId || "signed_out",
    requestIp(req) || "unknown_ip",
    String(extra || "").slice(0, 120),
  ].join(":");
}

function enforceRateLimit(req, res, { route, session = null, extra = "", limit, windowMs }) {
  const result = checkRateLimit({
    key: rateLimitKey(req, route, session, extra),
    limit,
    windowMs,
  });
  if (result.allowed) return false;

  json(
    res,
    429,
    {
      ok: false,
      error: "rate_limited",
      route,
      message: "Too many requests. Try again after the retry window.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      "retry-after": String(result.retryAfterSeconds),
      "x-ratelimit-limit": String(result.limit),
      "x-ratelimit-remaining": String(result.remaining),
    }
  );
  return true;
}

function enforceRoutePolicy(req, url, res, session) {
  const policy = routePolicyForPath(url.pathname);
  if (!policy) return false;

  if (!policy.methods.includes(req.method)) {
    json(res, 405, {
      ok: false,
      error: `${policy.id}_method_not_allowed`,
      route: policy.id,
      allowedMethods: policy.methods,
      message: `${policy.id} accepts ${policy.methods.join(" or ")} requests.`,
    }, { allow: policy.methods.join(", ") });
    return true;
  }

  if (policy.rateLimit) {
    return enforceRateLimit(req, res, {
      route: policy.id,
      session,
      extra: routePolicyRateLimitExtra(policy, url.pathname),
      limit: policy.rateLimit.limit,
      windowMs: policy.rateLimit.windowMs,
    });
  }

  return false;
}

function sessionCookie(req, sessionId) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds}${secure}`;
}

function expiredSessionCookie(req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function requestOrigin(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (secureCookie(req) ? "https" : "http");
  if (!host) return "";
  return `${proto}://${host}`;
}

function isLocalHostname(hostname = "") {
  const normalized = String(hostname || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function configuredPublicOrigin() {
  return process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "";
}

function isPublicOrigin(value = "") {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function assertStartupSecurity() {
  const publicOrigin = configuredPublicOrigin();
  if (!isPublicOrigin(publicOrigin)) return;

  const devAuth = devAuthStatus();
  if (devAuth.enabled) {
    throw new Error(
      "refusing_public_startup_with_dev_auth_enabled: set TASKNODE_ENV=production and TASKNODE_DEV_AUTH_ENABLED=false"
    );
  }

  const store = runtimeStoreStatus();
  const durableStoreDeclared = process.env.TASKNODE_RUNTIME_STORE_DURABLE === "true";
  if (
    (!store.explicit || store.ephemeralDefault || !durableStoreDeclared) &&
    process.env.TASKNODE_ALLOW_PUBLIC_EPHEMERAL_STORE !== "true"
  ) {
    throw new Error(
      "refusing_public_startup_with_ephemeral_runtime_store: configure durable auth/account storage and TASKNODE_RUNTIME_STORE_DURABLE=true, or set an explicit reviewed override"
    );
  }
}

function isInsideDist(filePath) {
  const relative = path.relative(distDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function serveStatic(url, res) {
  const requestPath = url.pathname;
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(distDir, relative));

  if (!isInsideDist(filePath) || !existsSync(filePath)) {
    const fallback = path.join(distDir, "index.html");
    if (!existsSync(fallback)) {
      json(res, 404, { ok: false, error: "build_not_found" });
      return;
    }
    const html = await readFile(fallback);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...securityHeaders(),
    });
    res.end(html);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": contentTypes.get(ext) || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    ...securityHeaders(),
  });
  createReadStream(filePath).pipe(res);
}

async function routeApi(req, url, res) {
  const session = currentSession(req);
  let statePromise = null;
  const getState = () => {
    if (!statePromise) {
      const refreshTaskProjection = url.searchParams.get("taskProjectionRefresh") === "1";
      statePromise = appState(session, { refreshTaskProjection });
    }
    return statePromise;
  };
  const parts = url.pathname.split("/").filter(Boolean);
  if (enforceRoutePolicy(req, url, res, session)) return true;

  if (url.pathname === "/api/app-state") {
    json(res, 200, await getState());
    return true;
  }

  if (url.pathname === "/api/session") {
    const state = await getState();
    json(res, 200, state.session);
    return true;
  }

  if (url.pathname === "/api/auth/dev/start") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = authDevStart(payload, req.method);
    const headers = result.sessionId ? { "set-cookie": sessionCookie(req, result.sessionId) } : {};
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
    const result = authEmailVerify(payload, req.method);
    const headers = result.sessionId ? { "set-cookie": sessionCookie(req, result.sessionId) } : {};
    json(res, result.status, result.body, headers);
    return true;
  }

  if (url.pathname === "/api/auth/logout") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "auth_logout_method_not_allowed",
        message: "Logout requires POST.",
        actionRequired: "Send logout requests with POST.",
      });
      return true;
    }

    destroySession(cookieValue(req, sessionCookieName));
    json(
      res,
      200,
      {
        ok: true,
        action: "auth_logout",
        message: "Signed out.",
      },
      { "set-cookie": expiredSessionCookie(req) }
    );
    return true;
  }

  if (url.pathname === "/api/auth/providers") {
    json(res, 200, { providers: authProviders() });
    return true;
  }

  if (url.pathname === "/api/auth/telegram/authorize") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "telegram_authorize_method_not_allowed", message: "Telegram authorization requires GET.", actionRequired: "Start Telegram auth again from Task Node." });
      return true;
    }

    const result = authTelegramAuthorize(Object.fromEntries(url.searchParams.entries()), {
      origin: requestOrigin(req),
      oauthState: cookieValue(req, oauthStateCookieName("telegram")),
    });
    res.writeHead(result.status, telegramAuthHeaders());
    res.end(result.body);
    return true;
  }

  if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "start" && parts[3]) {
    const result = authStart(parts[3], {
      origin: requestOrigin(req),
      redirectPath: url.searchParams.get("redirect") || "/",
      session,
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
    const headers = responseHeadersForAuthResult(req, result);
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
    const result = authStart(parts[2], {
      origin: requestOrigin(req),
      redirectPath: url.searchParams.get("redirect") || "/",
      session,
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
    const headers = responseHeadersForAuthResult(req, result);
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

  if (await handleTaskReadRoute({ getLinkedWallet, json, readJson, req, res, session, url })) return true;

  if (url.pathname === "/api/chat/estimate") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    const result = await chatEstimateStart(payload, session?.accountId || "");
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/chat/modes") {
    json(res, 200, { modes: chatModes() });
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

  if (await handleMemoryRoute({ json, req, res, session, url })) return true;

  if (await handleProfileRoute({ getState, json, readJson, req, res, session, url })) return true;

  if (await handleHiveRoute({ getLinkedWallet, json, readJson, req, res, session, url })) return true;

  if (url.pathname === "/api/chat/stream") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await resolveChatWriteConversationId(session, payload?.conversationId || "");
    const started = await chatStreamStart(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method
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
    res.on("close", () => {
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
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return true;
  }

  if (url.pathname === "/api/chat/send") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = await resolveChatWriteConversationId(session, payload?.conversationId || "");
    const result = await chatSend(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method
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

    const linkedWallet = getLinkedWallet({ accountId: session.accountId });
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

    const linkedWallet = getLinkedWallet({ accountId: session.accountId });
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

  if (await handlePftlCacheRoute({ url, res, session, json })) return true;

  if (url.pathname === "/api/wallet/actions") {
    json(res, 200, { actions: walletActions() });
    return true;
  }

  if (url.pathname === "/api/wallet/link/start") {
    const result = walletLinkStart(req.method, session);
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
      json(res, error?.status || 500, {
        ok: false,
        error: error?.message || "internal_error",
      });
    });
});

const processRole = tasknodeProcessRole();
const httpEnabled = shouldStartHttpServer(processRole);
const backgroundWorkersEnabled = shouldStartBackgroundWorkers(processRole);

if (httpEnabled) assertStartupSecurity();
try {
  await migrateDatabase();
} catch (error) {
  if (process.env.TASKNODE_FLY_DEV_DATA_BRIDGE === "true") {
    throw new Error(
      "Fly dev data bridge is enabled but Postgres is unreachable. Rerun `npm run docker:dev:fly-data` or start the proxy with `npm run fly-dev:data:proxy`."
    );
  }
  throw error;
}
if (backgroundWorkersEnabled) startBackgroundWorkers();

if (httpEnabled) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`tasknodeofficial listening on :${port} role=${processRole}`);
  });
} else {
  console.log(`tasknodeofficial background process started role=${processRole}`);
}
