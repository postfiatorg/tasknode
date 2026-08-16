import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRouteRateLimit, sharedRateLimitStartupIssues } from "./rate-limit.js";
import { readValidatedJson as readJson } from "./request-validation.js";
import * as trustedProxy from "./trusted-proxy.js";
import {
  isProductionEnvironment,
  moneySeedStartupIssues,
  productionOriginIssues,
} from "./production-guards.js";
import {
  offchainTaskLifecycleDualWriteEnabled,
  offchainTaskLifecycleEnabled,
} from "./offchain-task-lifecycle.js";
import { devAuthStatus } from "./product-contracts.js";
import {
  runtimeStoreStatus,
  sessionCookieName,
  sessionTtlSeconds,
} from "./runtime-store.js";
import { assertDurableRuntimeAuthority } from "./repositories/runtime-authority.js";
import { routeBodyPolicyForRequest, routePolicyForPath, routePolicyRateLimitExtra } from "./route-policies.js";
import { routeAuthenticationFailure } from "./route-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
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

export function securityHeaders() {
  const pfdocsFrameOrigin = (() => {
    try {
      const origin = new URL(String(process.env.PFDOCS_PUBLIC_ORIGIN || "")).origin;
      return /^https:\/\//i.test(origin) ? origin : "";
    } catch {
      return "";
    }
  })();
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
      "connect-src 'self' https://traffic.postfiat.org https://us.posthog.com https://*.posthog.com wss://relay.primal.net wss://nos.lol wss://relay.damus.io",
      `frame-src 'self'${pfdocsFrameOrigin ? ` ${pfdocsFrameOrigin}` : ""}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

export function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
    ...headers,
  });
  res.end(text);
}

export function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

export function runtimeConfig() {
  const taskLifecycleOffchain = offchainTaskLifecycleEnabled();
  const taskLifecycleDualWrite = offchainTaskLifecycleDualWriteEnabled();
  const collaborationFlag = (name) => process.env[name] === "true" || (
    process.env[name] !== "false" && environment !== "production"
  );
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
    walletUnlockIdleLockMinutes: process.env.TASKNODE_WALLET_UNLOCK_IDLE_LOCK_MINUTES || "",
    collaboration: {
      docsEnabled: collaborationFlag("TASKNODE_DOCS_ENABLED"),
      teamEnabled: collaborationFlag("TASKNODE_TEAM_ENABLED"),
      messagesEnabled: collaborationFlag("TASKNODE_MESSAGES_ENABLED"),
      pfdocsEditorEnabled: collaborationFlag("TASKNODE_PFDOCS_EDITOR_ENABLED"),
      docsOdvEnabled: collaborationFlag("TASKNODE_DOCS_ODV_ENABLED"),
      pfdocsOrigin: process.env.PFDOCS_PUBLIC_ORIGIN || process.env.VITE_PFDOCS_ORIGIN || "",
      pfdocsBridgePath: process.env.PFDOCS_TASKNODE_BRIDGE_PATH || "/tasknode/",
      nostrOptional: true,
    },
    taskLifecycle: {
      offchainEnabled: taskLifecycleOffchain,
      dualWrite: taskLifecycleDualWrite,
      directOffchain: taskLifecycleOffchain && !taskLifecycleDualWrite,
      writeSource: taskLifecycleOffchain
        ? taskLifecycleDualWrite
          ? "direct_write+pftl_pointer"
          : "direct_write"
        : "pftl_pointer",
    },
  };
}

export function runtimeConfigScript(res) {
  const script = `window.__TASKNODE_CONFIG__ = ${JSON.stringify(runtimeConfig())};\n`;
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  res.end(script);
}

export function cookieValue(req, name) {
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

function secureCookie(req) { return trustedProxy.requestIsSecure(req); }

export function requestIp(req) { return trustedProxy.clientIp(req); }

function rateLimitKey(req, route, session = null, extra = "") {
  return [
    route,
    session?.accountId || "signed_out",
    requestIp(req) || "unknown_ip",
    String(extra || "").slice(0, 120),
  ].join(":");
}

export async function enforceRateLimit(req, res, { route, session = null, extra = "", limit, windowMs }) {
  const result = await checkRouteRateLimit({
    key: rateLimitKey(req, route, session, extra),
    route,
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

export async function enforceRoutePolicy(req, url, res, session) {
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

  if (policy.rateLimit && await enforceRateLimit(req, res, {
      route: policy.id,
      session,
      extra: routePolicyRateLimitExtra(policy, url.pathname),
      limit: policy.rateLimit.limit,
      windowMs: policy.rateLimit.windowMs,
    })) {
    return true;
  }

  const authenticationFailure = routeAuthenticationFailure({
    policy,
    session,
    headers: req.headers,
  });
  if (authenticationFailure) {
    json(res, authenticationFailure.status, {
      ok: false,
      route: policy.id,
      error: authenticationFailure.error,
      message: authenticationFailure.message,
    });
    return true;
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const bodyContract = routeBodyPolicyForRequest(policy, req.method, url.pathname);
    if (!bodyContract) {
      json(res, 500, {
        ok: false,
        route: policy.id,
        error: "request_body_contract_missing",
        message: "This mutation route is not safely configured.",
      });
      return true;
    }
    try {
      await readJson(req, bodyContract.maxBytes, bodyContract.schema);
    } catch (error) {
      json(res, error?.status || 400, {
        ok: false,
        route: policy.id,
        error: error?.message || "request_body_invalid",
        field: error?.field || undefined,
        message: "The request body does not match this route's contract.",
      });
      return true;
    }
  }

  return false;
}

export function sessionCookie(req, sessionId) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds}${secure}`;
}

export function expiredSessionCookie(req) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export function requestOrigin(req) { return trustedProxy.requestOriginFromBoundary(req); }

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

export function assertStartupSecurity() {
  const publicOrigin = configuredPublicOrigin();
  if (!isPublicOrigin(publicOrigin)) return;

  const devAuth = devAuthStatus();
  if (devAuth.enabled) {
    throw new Error(
      "refusing_public_startup_with_dev_auth_enabled: set TASKNODE_ENV=production and TASKNODE_DEV_AUTH_ENABLED=false"
    );
  }

  const store = runtimeStoreStatus();
  assertDurableRuntimeAuthority();
  const durableStoreDeclared = process.env.TASKNODE_RUNTIME_STORE_DURABLE === "true";
  if (
    (!store.explicit || store.ephemeralDefault || !durableStoreDeclared) &&
    process.env.TASKNODE_ALLOW_PUBLIC_EPHEMERAL_STORE !== "true"
  ) {
    throw new Error(
      "refusing_public_startup_with_ephemeral_runtime_store: configure durable auth/account storage and TASKNODE_RUNTIME_STORE_DURABLE=true, or set an explicit reviewed override"
    );
  }

  const originIssues = productionOriginIssues();
  if (originIssues.length > 0) {
    const summary = originIssues.map((issue) => issue.code).join(",");
    if (isProductionEnvironment()) {
      throw new Error(
        `refusing_public_startup_with_origin_mismatch: ${summary}. ${originIssues.map((issue) => issue.detail).join("; ")}`
      );
    }
    for (const issue of originIssues) {
      console.warn(`[startup] origin config mismatch: ${issue.code}: ${issue.detail}`);
    }
  }

  for (const issue of moneySeedStartupIssues()) {
    console.warn(`[startup] money seed config: ${issue.code}: ${issue.detail}`);
  }

  const rateLimitIssues = sharedRateLimitStartupIssues();
  if (rateLimitIssues.length > 0) {
    throw new Error(`refusing_public_startup_without_shared_rate_limits: ${rateLimitIssues.map((issue) => issue.code).join(",")}`);
  }

  const proxyConfig = trustedProxy.trustedProxyConfig();
  if (proxyConfig.invalid.length > 0) {
    throw new Error(`refusing_public_startup_with_invalid_trusted_proxy_cidrs: ${proxyConfig.invalid.join(",")}`);
  }
  if (isProductionEnvironment() && proxyConfig.cidrs.length === 0) {
    throw new Error("refusing_public_startup_without_trusted_proxy_cidrs: set TASKNODE_TRUSTED_PROXY_CIDRS to the immediate reverse-proxy network(s)");
  }
}

function isInsideDist(filePath) {
  const relative = path.relative(distDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStaticAssetRequest(pathname = "") {
  if (pathname.startsWith("/assets/")) return true;
  return Boolean(path.extname(pathname));
}

function staticNotFound(res, pathname = "") {
  res.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  res.end(JSON.stringify({
    ok: false,
    error: "static_asset_not_found",
    path: pathname,
  }));
}

export async function serveStatic(url, res) {
  const requestPath = url.pathname;
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(distDir, relative));

  if (!isInsideDist(filePath) || !existsSync(filePath)) {
    if (!isInsideDist(filePath) || isStaticAssetRequest(url.pathname)) {
      staticNotFound(res, url.pathname);
      return;
    }

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
