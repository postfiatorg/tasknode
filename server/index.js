import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState } from "./app-state.js";
import { fetchPftBalance } from "./pftl-balance.js";
import { fetchWalletTransactions } from "./pftl-transactions.js";
import {
  authCallback,
  authDevStart,
  authEmailStart,
  authEmailVerify,
  authProviders,
  authStart,
  chatEstimate,
  chatModes,
  chatSend,
  chatStreamStart,
  contextActionStart,
  contextActions,
  contextEditSave,
  contextHistoryRpcImport,
  contextIndexedHistoryImport,
  contextHistoryIpfsFetch,
  readiness,
  usageActionStart,
  usageActions,
  usageAdminCredit,
  walletActionStart,
  walletActions,
  walletLinkStart,
  walletLinkVerify,
} from "./product-contracts.js";
import { executeChatStream } from "./chat-router.js";
import {
  conversationIdForSession,
  destroySession,
  getChatMessages,
  getLinkedWallet,
  getSession,
  listChatConversations,
  sessionCookieName,
  sessionTtlSeconds,
  usageLedger,
} from "./runtime-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 8080);
const buildId = process.env.VITE_BUILD_ID || process.env.BUILD_ID || "dev";
const environment = process.env.TASKNODE_ENV || process.env.NODE_ENV || "development";

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

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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

function sessionCookie(req, sessionId) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds}${secure}`;
}

function expiredSessionCookie(req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function oauthStateCookieName(provider) {
  return `tasknode_oauth_state_${String(provider || "").replace(/[^a-z0-9_-]/gi, "_").toLowerCase()}`;
}

function oauthStateCookie(req, provider, value, maxAgeSeconds = 600) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${oauthStateCookieName(provider)}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${maxAgeSeconds}${secure}`;
}

function expiredOAuthStateCookie(req, provider) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${oauthStateCookieName(provider)}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0${secure}`;
}

function requestOrigin(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (secureCookie(req) ? "https" : "http");
  if (!host) return "";
  return `${proto}://${host}`;
}

function responseHeadersForAuthResult(req, result) {
  const headers = {};
  const cookies = [];

  if (result.sessionId) cookies.push(sessionCookie(req, result.sessionId));
  if (result.oauthState?.provider && result.oauthState?.value) {
    cookies.push(oauthStateCookie(
      req,
      result.oauthState.provider,
      result.oauthState.value,
      result.oauthState.maxAgeSeconds || 600
    ));
  }
  if (result.clearOAuthState?.provider) {
    cookies.push(expiredOAuthStateCookie(req, result.clearOAuthState.provider));
  }
  if (cookies.length === 1) headers["set-cookie"] = cookies[0];
  if (cookies.length > 1) headers["set-cookie"] = cookies;
  if (result.redirectLocation) headers.location = result.redirectLocation;

  return headers;
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
    });
    res.end(html);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": contentTypes.get(ext) || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
}

async function routeApi(req, url, res) {
  const session = currentSession(req);
  const state = appState(session);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/app-state") {
    json(res, 200, state);
    return true;
  }

  if (url.pathname === "/api/session") {
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
        ...headers,
      });
      res.end("");
    } else {
      json(res, result.status, result.body, headers);
    }
    return true;
  }

  if (url.pathname === "/api/readiness") {
    json(res, 200, readiness());
    return true;
  }

  if (url.pathname === "/api/tasks") {
    json(res, 200, state.tasks);
    return true;
  }

  if (url.pathname === "/api/chat/estimate") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    json(res, 200, chatEstimate(payload));
    return true;
  }

  if (url.pathname === "/api/chat/modes") {
    json(res, 200, { modes: chatModes() });
    return true;
  }

  if (url.pathname === "/api/chat/conversations") {
    json(res, 200, {
      conversations: listChatConversations({
        accountId: session?.accountId || "",
        limit: url.searchParams.get("limit") || 30,
      }),
    });
    return true;
  }

  if (url.pathname === "/api/chat/history") {
    const conversationId = conversationIdForSession(
      session,
      url.searchParams.get("conversationId") || ""
    );
    json(res, 200, { conversationId, messages: getChatMessages(conversationId) });
    return true;
  }

  if (url.pathname === "/api/chat/stream") {
    const payload = req.method === "POST" ? await readJson(req) : {};
    const conversationId = conversationIdForSession(session, payload?.conversationId || "");
    const started = chatStreamStart(
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
          costUsd: result.usage.costUsd,
          estimated: result.usage.estimated === true,
        },
        ledgerEntry: result.ledgerEntry,
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
    const payload = req.method === "POST" ? await readJson(req) : {};
    const conversationId = conversationIdForSession(session, payload?.conversationId || "");
    const result = await chatSend(
      { ...payload, accountId: session?.accountId || "", conversationId },
      req.method
    );
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/wallet") {
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
      force: url.searchParams.get("force") === "1",
      limit: url.searchParams.get("limit"),
      maxPages: url.searchParams.get("maxPages"),
    });
    json(res, result.status || (result.ok ? 200 : 502), result);
    return true;
  }

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
    const result = walletLinkVerify(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (
    url.pathname === "/api/wallet/unlock/start" ||
    url.pathname === "/api/wallet/delink" ||
    url.pathname === "/api/wallet/relink/start"
  ) {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = walletActionStart(url.pathname, req.method, session, payload);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context") {
    json(res, 200, state.context);
    return true;
  }

  if (url.pathname === "/api/context/history") {
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

  if (
    url.pathname === "/api/context/import/start" ||
    url.pathname === "/api/context/manifest/ink"
  ) {
    const result = contextActionStart(url.pathname, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/edit/save") {
    const payload = req.method === "POST" ? await readJson(req, 65536) : {};
    const result = contextEditSave(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/history/indexed") {
    const payload = req.method === "POST" ? await readJson(req, 262144) : {};
    const result = contextIndexedHistoryImport(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/context/history/rpc/import") {
    const payload = req.method === "POST" ? await readJson(req, 8192) : {};
    const result = await contextHistoryRpcImport(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage") {
    json(res, 200, state.usage);
    return true;
  }

  if (url.pathname === "/api/usage/actions") {
    json(res, 200, { actions: usageActions() });
    return true;
  }

  if (url.pathname === "/api/usage/top-up/start") {
    const result = usageActionStart(url.pathname, req.method);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage/credit/admin") {
    const payload = req.method === "POST" ? await readJson(req, 4096) : {};
    const result = usageAdminCredit(payload, req.method, req.headers.authorization || "");
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/usage/ledger") {
    const requestedConversationId = url.searchParams.get("conversationId") || "";
    const conversationId = requestedConversationId
      ? conversationIdForSession(session, requestedConversationId)
      : session
        ? conversationIdForSession(session)
        : "";
    json(res, 200, usageLedger({
      accountId: session?.accountId || "",
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

server.listen(port, "0.0.0.0", () => {
  console.log(`tasknodeofficial listening on :${port}`);
});
