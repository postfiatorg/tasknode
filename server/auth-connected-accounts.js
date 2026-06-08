import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  consumeOAuthState,
  createAccountSession,
  createOAuthState,
  getOrCreateProviderAccount,
  linkProviderToAccount,
  recordAuthEvent,
} from "./runtime-store.js";
import { appendUsageCredit } from "./repositories/chat-billing.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import {
  hostnameFromOrigin,
  oauthBasicCredentialPart,
  providerRedirectUri,
  publicOrigin,
} from "./auth-url-policy.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function provider({ id, label, kind, requiredEnv, note, enabled = false, status, actionRequired }) {
  const configured = hasAll(requiredEnv);
  return {
    id,
    label,
    kind,
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "configured") : "missing_config"),
    startPath: `/api/auth/start/${id}`,
    callbackPath: `/api/auth/callback/${id}`,
    actionRequired: configured
      ? (actionRequired || "Implement callback handling, account merge rules, and launch review before enabling this provider")
      : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function telegramWidgetDomain() {
  return hostnameFromOrigin(
    process.env.TELEGRAM_AUTH_WIDGET_DOMAIN ||
    process.env.TELEGRAM_WIDGET_DOMAIN ||
    ""
  );
}

function telegramDomainCheck(requestMeta = {}) {
  const expected = telegramWidgetDomain();
  const actual = hostnameFromOrigin(publicOrigin(requestMeta));
  if (!expected) {
    return {
      ok: false,
      error: "telegram_widget_domain_missing",
      message: "Telegram Login Widget needs a BotFather domain before it can be shown.",
      actionRequired:
        "Set TELEGRAM_AUTH_WIDGET_DOMAIN to the domain configured with BotFather /setdomain.",
    };
  }
  if (!actual) {
    return {
      ok: false,
      error: "auth_redirect_origin_missing",
      message: "Telegram login needs a Task Node origin.",
      actionRequired:
        "Configure TASKNODE_PUBLIC_URL or call the start route from the deployed app origin.",
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      error: "telegram_widget_domain_mismatch",
      message:
        `Telegram Login Widget is configured for ${expected}, but this app is running at ${actual}.`,
      actionRequired:
        "Open Task Node on the configured Telegram widget domain or update BotFather /setdomain and TELEGRAM_AUTH_WIDGET_DOMAIN together.",
    };
  }
  return { ok: true, actual, expected };
}

function safeRedirectPath(value) {
  const raw = String(value || "/").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.slice(0, 200);
}

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function maskEmail(email = "") {
  const text = String(email || "").trim().toLowerCase();
  const atIndex = text.lastIndexOf("@");
  if (atIndex <= 0) return "that email";
  const local = text.slice(0, atIndex);
  const domain = text.slice(atIndex + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.min(Math.max(local.length - 1, 1), 5))}@${domain}`;
}

function telegramBotUsername() {
  return String(process.env.TELEGRAM_AUTH_BOT_USERNAME || "")
    .replace(/^@/, "")
    .trim();
}

function telegramAuthorizeUrl(requestMeta = {}, stateId = "") {
  const origin = publicOrigin(requestMeta);
  if (!origin) return `/api/auth/telegram/authorize?state=${encodeURIComponent(stateId)}`;
  const url = new URL("/api/auth/telegram/authorize", origin);
  url.searchParams.set("state", stateId);
  return url.toString();
}

function telegramCallbackUrl(requestMeta = {}, stateId = "") {
  const origin = publicOrigin(requestMeta);
  const path = `/api/auth/callback/telegram?state=${encodeURIComponent(stateId)}`;
  if (!origin) return path;
  return new URL(path, origin).toString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function selectGithubEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const sorted = [...emails]
    .filter((item) => item?.email)
    .sort((left, right) => {
      const leftScore = (left.verified ? 2 : 0) + (left.primary ? 1 : 0);
      const rightScore = (right.verified ? 2 : 0) + (right.primary ? 1 : 0);
      return rightScore - leftScore;
    });
  const best = sorted[0];
  if (!best?.email) return null;
  return {
    email: best.email,
    verified: best.verified === true,
    primary: best.primary === true,
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGithubToken({ code, state, redirectUri }) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        state,
        redirect_uri: redirectUri,
      }),
    }
  );
  if (!response.ok || body?.error || !body?.access_token) {
    const error = new Error(body?.error_description || "GitHub token exchange failed.");
    error.status = 502;
    throw error;
  }
  return body.access_token;
}

async function fetchGithubUser(accessToken) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://api.github.com/user",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    }
  );
  if (!response.ok || !body?.id) {
    const error = new Error("GitHub user fetch failed.");
    error.status = 502;
    throw error;
  }
  return body;
}

async function fetchGithubEmails(accessToken) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://api.github.com/user/emails",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    }
  );
  if (!response.ok || !Array.isArray(body)) return [];
  return body;
}

async function fetchDiscordToken({ code, redirectUri }) {
  const credentials = Buffer.from(
    `${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`
  ).toString("base64");
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  const { response, body } = await fetchJsonWithTimeout(
    "https://discord.com/api/oauth2/token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );
  if (!response.ok || body?.error || !body?.access_token) {
    const error = new Error(body?.error_description || body?.error || "Discord token exchange failed.");
    error.status = 502;
    throw error;
  }
  return body.access_token;
}

async function fetchDiscordUser(accessToken) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://discord.com/api/v10/users/@me",
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    }
  );
  if (!response.ok || !body?.id) {
    const error = new Error("Discord user fetch failed.");
    error.status = 502;
    throw error;
  }
  return body;
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function xOauthScopes() {
  return String(process.env.X_OAUTH_SCOPES || "users.read tweet.read")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .join(" ");
}

function createXCodeChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function xEndpointList(envKey, primary, fallback) {
  const configured = String(process.env[envKey] || "").trim();
  if (configured) return [configured];
  return [primary, fallback].filter(Boolean);
}

function xOauthClientType() {
  const value = String(process.env.X_OAUTH_CLIENT_TYPE || "confidential").trim().toLowerCase();
  return value === "public" ? "public" : "confidential";
}

function xTokenError(body, fallbackMessage) {
  const message = body?.error_description || body?.error || fallbackMessage;
  const error = new Error(message);
  error.status = 502;
  error.code =
    body?.error === "unauthorized_client" && /authorization header/i.test(message)
      ? "x_client_credentials_rejected"
      : "x_callback_failed";
  if (error.code === "x_client_credentials_rejected") {
    error.message = "X rejected the OAuth2 Client ID/Secret for this app.";
  }
  return error;
}

async function fetchXToken({ code, redirectUri, codeVerifier }) {
  const clientType = xOauthClientType();
  const credentials = Buffer.from(
    `${oauthBasicCredentialPart(process.env.X_CLIENT_ID)}:${oauthBasicCredentialPart(process.env.X_CLIENT_SECRET)}`
  ).toString("base64");
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("code_verifier", codeVerifier);
  if (clientType === "public") form.set("client_id", process.env.X_CLIENT_ID);

  let lastBody = null;
  for (const endpoint of xEndpointList("X_TOKEN_URL", "https://api.x.com/2/oauth2/token", "https://api.twitter.com/2/oauth2/token")) {
    const { response, body } = await fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(clientType === "confidential" ? { Authorization: `Basic ${credentials}` } : {}),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    lastBody = body;
    if (response.ok && !body?.error && body?.access_token) return body.access_token;
  }

  throw xTokenError(lastBody, "X token exchange failed.");
}

async function fetchXUser(accessToken) {
  let lastBody = null;
  for (const endpoint of xEndpointList("X_USER_URL", "https://api.x.com/2/users/me", "https://api.twitter.com/2/users/me")) {
    const url = new URL(endpoint);
    url.searchParams.set("user.fields", "profile_image_url,verified,verified_type");
    const { response, body } = await fetchJsonWithTimeout(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    });
    lastBody = body;
    if (response.ok && body?.data?.id) return body.data;
  }

  throw xTokenError(lastBody, "X user fetch failed.");
}

function readScalar(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").trim();
}

function authError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function timingSafeHexEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function verifyTelegramLoginPayload(rawPayload, botToken, options = {}) {
  const token = String(botToken || "").trim();
  if (!token) throw authError("Telegram auth is not configured.", "telegram_auth_not_configured", 503);
  const hash = readScalar(rawPayload?.hash).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw authError("Missing or invalid Telegram auth hash.", "telegram_auth_hash_invalid");
  }
  const data = {};
  for (const key of ["id", "first_name", "last_name", "username", "photo_url", "auth_date"]) {
    const value = readScalar(rawPayload?.[key]);
    if (value) data[key] = value;
  }
  if (!/^\d+$/.test(data.id || "")) {
    throw authError("Missing or invalid Telegram user id.", "telegram_auth_user_invalid");
  }
  if (!/^\d+$/.test(data.auth_date || "")) {
    throw authError("Missing or invalid Telegram auth date.", "telegram_auth_date_invalid");
  }
  const dataCheckString = Object.keys(data).sort().map((key) => `${key}=${data[key]}`).join("\n");
  const secretKey = createHash("sha256").update(token).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeHexEqual(hash, expected)) {
    throw authError("Telegram auth signature failed.", "telegram_auth_signature_invalid", 401);
  }
  const maxAuthAgeSec = Number.isFinite(Number(options.maxAuthAgeSec))
    ? Number(options.maxAuthAgeSec)
    : 900;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (maxAuthAgeSec > 0 && Math.abs(nowMs - Number(data.auth_date) * 1000) > maxAuthAgeSec * 1000) {
    throw authError("Telegram auth payload is expired.", "telegram_auth_expired", 401);
  }
  return {
    id: data.id,
    username: data.username || "",
    firstName: data.first_name || "",
    lastName: data.last_name || "",
    photoUrl: data.photo_url || "",
    authDate: Number(data.auth_date),
  };
}

function telegramDisplayName(profile) {
  const username = readScalar(profile?.username);
  if (username) return username;
  const fullName = [profile?.firstName, profile?.lastName].map(readScalar).filter(Boolean).join(" ").trim();
  return fullName || `telegram:${readScalar(profile?.id)}`;
}

const initialProviderCreditProviders = new Set(["github", "x", "telegram", "discord"]);

function initialProviderCreditUsd() {
  const amount = Number(process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD || 5);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(Math.min(amount, 100).toFixed(2));
}

async function grantInitialProviderCredit(account, providerId) {
  const normalizedProvider = String(providerId || "").trim().toLowerCase();
  if (!account?.id || !initialProviderCreditProviders.has(normalizedProvider)) return null;
  const amountUsd = initialProviderCreditUsd();
  if (amountUsd <= 0) return null;
  return appendUsageCredit({
    accountId: account.id,
    amountUsd,
    source: "initial_provider_credit",
    note: `Initial Task Node chat credit for ${normalizedProvider} account login.`,
    createdBy: "system",
    uniqueKey: `initial_provider_credit:${account.id}`,
  });
}

function oauthAction(providerId, suffix, linked = false) {
  if (suffix === "start") return linked ? `${providerId}_account_link_start` : `${providerId}_auth_start`;
  if (suffix === "callback") return `${providerId}_auth_callback`;
  if (suffix === "link") return `${providerId}_account_link`;
  return `${providerId}_${suffix}`;
}

function recordOAuthSuccessObservability({
  accountId = "",
  providerId = "",
  providerUserId = "",
  username = "",
  stateRow = {},
  created = {},
  assurance = "",
  initialCredit = null,
  emailInfo = null,
  metadata = {},
} = {}) {
  const linked = Boolean(stateRow?.linkAccountId);
  const common = {
    accountId,
    provider: providerId,
    providerUserId,
    sessionId: created?.sessionId || "",
    sourceSurface: "auth",
    sourceRoute: "server/auth-connected-accounts.js::completeProviderAuth",
  };
  const events = [
    recordUserObservabilityEvent({
      ...common,
      eventType: "user.provider.linked",
      resultStatus: linked ? "linked" : "verified",
      reasonCode: linked ? "oauth_linked" : "oauth_verified",
      metadata: {
        linked,
        assurance,
        usernamePresent: Boolean(username),
        emailVerified: emailInfo?.verified === true,
        initialCreditUsd: initialCredit?.idempotentReplay ? 0 : Number(initialCredit?.amountUsd || 0),
        initialCreditIdempotentReplay: Boolean(initialCredit?.idempotentReplay),
        metadataKeys: Object.keys(metadata || {}).sort(),
      },
    }),
    recordUserObservabilityEvent({
      ...common,
      eventType: "user.session.started",
      resultStatus: "started",
      reasonCode: providerId,
      metadata: {
        provider: providerId,
        assurance,
        linkedProviderLogin: linked,
      },
    }),
  ];
  if (providerId === "telegram") {
    events.push(recordUserObservabilityEvent({
      ...common,
      eventType: "user.telegram.linked",
      resultStatus: linked ? "linked" : "verified",
      reasonCode: linked ? "oauth_linked" : "oauth_verified",
      metadata: {
        linked,
        usernamePresent: Boolean(username),
      },
    }));
  }
  Promise.allSettled(events).catch(() => {});
}

async function completeProviderAuth({
  providerId,
  label,
  stateRow,
  providerUserId,
  username = "",
  displayName = "",
  profileUrl = "",
  emailInfo = null,
  assurance = "medium",
  metadata = {},
} = {}) {
  const linkedResult = stateRow.linkAccountId
    ? linkProviderToAccount({ accountId: stateRow.linkAccountId, provider: providerId, providerUserId, username, displayName, profileUrl, emailInfo })
    : null;
  if (linkedResult && !linkedResult.ok) {
    const conflict = linkedResult.error === "provider_identity_conflict" || linkedResult.error === "provider_email_conflict";
    recordAuthEvent({
      accountId: stateRow.linkAccountId,
      eventType: `${providerId}_oauth_link_failed`,
      provider: providerId,
      email: emailInfo?.email ? maskEmail(emailInfo.email) : "",
      decision: linkedResult.error,
      metadata: { username, providerUserId, ...metadata },
    });
    return actionResponse({
      status: conflict ? 409 : 400,
      error: linkedResult.error,
      action: oauthAction(providerId, "link"),
      message: conflict ? `That ${label} identity is already linked to another Task Node account.` : `${label} could not be linked to this Task Node account.`,
      actionRequired: conflict ? "Sign in with the existing linked account or contact support before attempting an account merge." : `Start ${label} linking again from Settings.`,
    });
  }
  const account = linkedResult?.account || getOrCreateProviderAccount({ provider: providerId, providerUserId, username, displayName, profileUrl, emailInfo });
  if (!account?.id) {
    return actionResponse({
      status: 500,
      error: "provider_account_not_created",
      action: oauthAction(providerId, "callback"),
      message: `${label} login could not create or resume a Task Node account.`,
      actionRequired: `Start ${label} login again. If the problem repeats, inspect the account identity store.`,
    });
  }
  const initialCredit = await grantInitialProviderCredit(account, providerId);
  const created = createAccountSession(account, { provider: providerId, assurance });
  recordAuthEvent({
    accountId: account.id,
    eventType: stateRow.linkAccountId ? `${providerId}_oauth_linked` : `${providerId}_oauth_verified`,
    provider: providerId,
    email: emailInfo?.email ? maskEmail(emailInfo.email) : "",
    decision: "session_issued",
    metadata: {
      username,
      providerUserId,
      emailVerified: emailInfo?.verified === true,
      initialCreditUsd: initialCredit?.idempotentReplay ? 0 : Number(initialCredit?.amountUsd || 0),
      initialCreditIdempotentReplay: Boolean(initialCredit?.idempotentReplay),
      ...metadata,
    },
  });
  recordOAuthSuccessObservability({
    accountId: account.id,
    providerId,
    providerUserId,
    username,
    stateRow,
    created,
    assurance,
    initialCredit,
    emailInfo,
    metadata,
  });
  return {
    status: 302,
    sessionId: created.sessionId,
    clearOAuthState: { provider: providerId },
    redirectLocation: safeRedirectPath(stateRow.redirectPath || "/"),
    body: {
      ok: true,
      action: oauthAction(providerId, "callback"),
      message: stateRow.linkAccountId ? `${label} linked.` : `Signed in with ${label}.`,
      session: created.session,
      initialCredit: initialCredit
        ? { amountUsd: Number(initialCredit.amountUsd || 0), alreadyRecorded: Boolean(initialCredit.idempotentReplay) }
        : null,
    },
  };
}

export function oauthAuthProviders() {
  return [
    provider({
      id: "telegram",
      label: "Telegram",
      kind: "telegram_login",
      requiredEnv: ["TELEGRAM_AUTH_BOT_TOKEN", "TELEGRAM_AUTH_BOT_USERNAME", "TELEGRAM_AUTH_WIDGET_DOMAIN"],
      enabled: true,
      actionRequired: "Configure the Telegram Login Widget bot username and BotFather domain for this Task Node deployment.",
      note: "Preferred mobile account-link path. Telegram signed login is verified server-side before account creation or linking.",
    }),
    provider({
      id: "discord",
      label: "Discord",
      kind: "oauth",
      requiredEnv: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
      enabled: true,
      actionRequired: "Configure the Discord OAuth App callback URL to /api/auth/callback/discord for this Task Node deployment.",
      note: "Required for Discord chat continuity and validated messaging. Discord OAuth login and account linking are wired through the shared connected-account boundary.",
    }),
    provider({
      id: "x",
      label: "X",
      kind: "oauth",
      requiredEnv: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
      enabled: true,
      actionRequired: "Configure the X App callback URL to /api/auth/callback/x for this Task Node deployment.",
      note: "Useful for pseudonymous identity and public profile continuity. X OAuth2 PKCE login and account linking are wired through the shared connected-account boundary.",
    }),
    provider({
      id: "github",
      label: "GitHub",
      kind: "oauth",
      requiredEnv: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      enabled: true,
      actionRequired: "Configure the GitHub OAuth App callback URL to /api/auth/callback/github for this Task Node deployment.",
      note: "Required for GitHub-based account continuity. Exact GitHub identity resumes the same Task Node account.",
    }),
  ];
}

function oauthProviderById(providerId) {
  return oauthAuthProviders().find((providerItem) => providerItem.id === providerId) || null;
}

function unconfiguredProviderResponse(providerItem) {
  return {
    status: 409,
    body: {
      ok: false,
      error: "auth_provider_not_configured",
      provider: providerItem.id,
      message: `${providerItem.label} is not configured for this environment.`,
      actionRequired: providerItem.actionRequired,
    },
  };
}

export function oauthAuthStart(providerId, requestMeta = {}) {
  const providerItem = oauthProviderById(providerId);
  if (!providerItem) {
    return { status: 404, body: { ok: false, error: "unknown_auth_provider", provider: providerId, message: "Unknown auth provider." } };
  }
  if (!providerItem.configured) return unconfiguredProviderResponse(providerItem);
  if (providerItem.id === "github") return startGithubAuth(requestMeta);
  if (providerItem.id === "discord") return startDiscordAuth(requestMeta);
  if (providerItem.id === "x") return startXAuth(requestMeta);
  if (providerItem.id === "telegram") return startTelegramAuth(requestMeta);
  return {
    status: 503,
    body: {
      ok: false,
      error: "auth_provider_disabled",
      provider: providerItem.id,
      message: `${providerItem.label} auth is configured but disabled until callback handling and account merge rules are implemented.`,
      actionRequired: providerItem.actionRequired,
    },
  };
}

function startGithubAuth(requestMeta = {}) {
  const redirectUri = providerRedirectUri("github", requestMeta);
  if (!redirectUri) {
    return actionResponse({ status: 409, error: "auth_redirect_origin_missing", action: "github_auth_start", message: "GitHub login needs a public Task Node origin.", actionRequired: "Configure TASKNODE_PUBLIC_URL or call the start route from the deployed app origin." });
  }
  const stateRow = createOAuthState({ provider: "github", redirectPath: safeRedirectPath(requestMeta.redirectPath), redirectUri, linkAccountId: requestMeta.session?.accountId || "", expiresInSeconds: 600 });
  const linkingAccount = Boolean(requestMeta.session?.accountId);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "user:email");
  authorizeUrl.searchParams.set("state", stateRow.id);
  authorizeUrl.searchParams.set("allow_signup", "true");
  return oauthStartResponse({ providerId: "github", stateRow, linkingAccount, redirectUrl: authorizeUrl.toString(), redirectUri });
}

function startDiscordAuth(requestMeta = {}) {
  const redirectUri = providerRedirectUri("discord", requestMeta, "DISCORD_REDIRECT_URI");
  if (!redirectUri) {
    return actionResponse({ status: 409, error: "auth_redirect_origin_missing", action: "discord_auth_start", message: "Discord login needs a Task Node origin.", actionRequired: "Configure TASKNODE_PUBLIC_URL or call the start route from the deployed app origin." });
  }
  const stateRow = createOAuthState({ provider: "discord", redirectPath: safeRedirectPath(requestMeta.redirectPath), redirectUri, linkAccountId: requestMeta.session?.accountId || "", expiresInSeconds: 600 });
  const linkingAccount = Boolean(requestMeta.session?.accountId);
  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "identify email");
  authorizeUrl.searchParams.set("state", stateRow.id);
  authorizeUrl.searchParams.set("prompt", "consent");
  return oauthStartResponse({ providerId: "discord", stateRow, linkingAccount, redirectUrl: authorizeUrl.toString(), redirectUri });
}

function startXAuth(requestMeta = {}) {
  const redirectUri = providerRedirectUri("x", requestMeta, "X_REDIRECT_URI");
  if (!redirectUri) {
    return actionResponse({ status: 409, error: "auth_redirect_origin_missing", action: "x_auth_start", message: "X login needs a Task Node origin.", actionRequired: "Configure TASKNODE_PUBLIC_URL or call the start route from the deployed app origin." });
  }
  const codeVerifier = base64Url(randomBytes(32));
  const stateRow = createOAuthState({
    provider: "x",
    redirectPath: safeRedirectPath(requestMeta.redirectPath),
    redirectUri,
    linkAccountId: requestMeta.session?.accountId || "",
    expiresInSeconds: 600,
    metadata: { codeVerifier },
  });
  const linkingAccount = Boolean(requestMeta.session?.accountId);
  const authorizeUrl = new URL(String(process.env.X_AUTHORIZE_URL || "https://x.com/i/oauth2/authorize"));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", process.env.X_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", xOauthScopes());
  authorizeUrl.searchParams.set("state", stateRow.id);
  authorizeUrl.searchParams.set("code_challenge", createXCodeChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return oauthStartResponse({ providerId: "x", stateRow, linkingAccount, redirectUrl: authorizeUrl.toString(), redirectUri });
}

function startTelegramAuth(requestMeta = {}) {
  const domainCheck = telegramDomainCheck(requestMeta);
  if (!domainCheck.ok) {
    return actionResponse({
      status: 409,
      error: domainCheck.error,
      action: "telegram_auth_start",
      message: domainCheck.message,
      actionRequired: domainCheck.actionRequired,
    });
  }
  const stateRow = createOAuthState({ provider: "telegram", redirectPath: safeRedirectPath(requestMeta.redirectPath), redirectUri: "", linkAccountId: requestMeta.session?.accountId || "", expiresInSeconds: 600 });
  const linkingAccount = Boolean(requestMeta.session?.accountId);
  return oauthStartResponse({
    providerId: "telegram",
    stateRow,
    linkingAccount,
    redirectUrl: telegramAuthorizeUrl(requestMeta, stateRow.id),
    redirectUri: telegramCallbackUrl(requestMeta, stateRow.id),
  });
}

function oauthStartResponse({ providerId, stateRow, linkingAccount, redirectUrl, redirectUri }) {
  return {
    status: 200,
    oauthState: { provider: providerId, value: stateRow.id, maxAgeSeconds: 600 },
    body: {
      ok: true,
      action: oauthAction(providerId, "start", linkingAccount),
      provider: providerId,
      mode: linkingAccount ? "account_link" : "sign_in",
      redirectUrl,
      redirectUri,
      expiresAt: stateRow.expiresAt,
    },
  };
}

export async function oauthAuthCallback(providerId, query = {}, requestMeta = {}) {
  const providerItem = oauthProviderById(providerId);
  if (!providerItem) {
    return { status: 404, body: { ok: false, error: "unknown_auth_provider", provider: providerId, message: "Unknown auth provider." } };
  }
  if (!providerItem.configured) return unconfiguredProviderResponse(providerItem);
  if (providerItem.id === "github") return completeGithubCallback(query, requestMeta);
  if (providerItem.id === "discord") return completeDiscordCallback(query, requestMeta);
  if (providerItem.id === "x") return completeXCallback(query, requestMeta);
  if (providerItem.id === "telegram") return completeTelegramCallback(query, requestMeta);
  return { status: 501, body: { ok: false, error: "auth_callback_not_implemented", provider: providerItem.id, message: `${providerItem.label} callback handling is not implemented yet.`, actionRequired: "Implement callback verification, account merge rules, and session issuance before enabling login." } };
}

function consumeCallbackState(providerId, query, requestMeta) {
  const stateId = String(query?.state || "").trim();
  const callbackCookieState = String(requestMeta.oauthState || "").trim();
  if (!stateId || !callbackCookieState || stateId !== callbackCookieState) return null;
  return consumeOAuthState({ provider: providerId, stateId });
}

function invalidOAuthState(providerId, label) {
  return actionResponse({ status: 400, error: "oauth_state_invalid", action: `${providerId}_auth_callback`, message: `${label} login state is invalid or expired.`, actionRequired: `Start ${label} login again from the Task Node login modal or Settings.` });
}

async function completeGithubCallback(query = {}, requestMeta = {}) {
  const code = String(query?.code || "").trim();
  if (query?.error) return actionResponse({ status: 400, error: "github_auth_denied", action: "github_auth_callback", message: String(query.error_description || query.error || "GitHub authorization failed."), actionRequired: "Start GitHub login again if you intended to authorize Task Node." });
  if (!code) return invalidOAuthState("github", "GitHub");
  const stateRow = consumeCallbackState("github", query, requestMeta);
  if (!stateRow) return invalidOAuthState("github", "GitHub");
  try {
    const accessToken = await fetchGithubToken({ code, state: String(query.state || ""), redirectUri: stateRow.redirectUri });
    const [profile, emails] = await Promise.all([fetchGithubUser(accessToken), fetchGithubEmails(accessToken)]);
    return completeProviderAuth({ providerId: "github", label: "GitHub", stateRow, providerUserId: String(profile.id), username: profile.login || "", displayName: profile.name || profile.login || "GitHub", profileUrl: profile.html_url || "", emailInfo: selectGithubEmail(emails) });
  } catch (error) {
    recordAuthEvent({ eventType: "github_oauth_failed", provider: "github", decision: error?.message || "github_callback_failed" });
    return actionResponse({ status: error?.status || 502, error: "github_callback_failed", action: "github_auth_callback", message: "GitHub login could not be completed.", actionRequired: error?.message || "Check GitHub OAuth app callback configuration and retry." });
  }
}

async function completeDiscordCallback(query = {}, requestMeta = {}) {
  const code = String(query?.code || "").trim();
  if (query?.error) return actionResponse({ status: 400, error: "discord_auth_denied", action: "discord_auth_callback", message: String(query.error_description || query.error || "Discord authorization failed."), actionRequired: "Start Discord login again if you intended to authorize Task Node." });
  if (!code) return invalidOAuthState("discord", "Discord");
  const stateRow = consumeCallbackState("discord", query, requestMeta);
  if (!stateRow) return invalidOAuthState("discord", "Discord");
  try {
    const accessToken = await fetchDiscordToken({ code, redirectUri: stateRow.redirectUri });
    const profile = await fetchDiscordUser(accessToken);
    const emailInfo = profile.email ? { email: profile.email, verified: profile.verified === true, primary: true } : null;
    return completeProviderAuth({ providerId: "discord", label: "Discord", stateRow, providerUserId: String(profile.id), username: profile.username || "", displayName: profile.global_name || profile.username || "Discord", profileUrl: `https://discord.com/users/${profile.id}`, emailInfo, metadata: { globalName: profile.global_name || "" } });
  } catch (error) {
    recordAuthEvent({ eventType: "discord_oauth_failed", provider: "discord", decision: error?.message || "discord_callback_failed" });
    return actionResponse({ status: error?.status || 502, error: error?.code || "discord_callback_failed", action: "discord_auth_callback", message: "Discord login could not be completed.", actionRequired: error?.message || "Check Discord OAuth app callback configuration and retry." });
  }
}

async function completeXCallback(query = {}, requestMeta = {}) {
  const code = String(query?.code || "").trim();
  if (query?.error) return actionResponse({ status: 400, error: "x_auth_denied", action: "x_auth_callback", message: String(query.error_description || query.error || "X authorization failed."), actionRequired: "Start X login again if you intended to authorize Task Node." });
  if (!code) return invalidOAuthState("x", "X");
  const stateRow = consumeCallbackState("x", query, requestMeta);
  if (!stateRow) return invalidOAuthState("x", "X");
  const codeVerifier = String(stateRow.metadata?.codeVerifier || "").trim();
  if (!codeVerifier) return invalidOAuthState("x", "X");
  try {
    const accessToken = await fetchXToken({ code, redirectUri: stateRow.redirectUri, codeVerifier });
    const profile = await fetchXUser(accessToken);
    const username = String(profile.username || "").trim();
    return completeProviderAuth({
      providerId: "x",
      label: "X",
      stateRow,
      providerUserId: String(profile.id),
      username,
      displayName: String(profile.name || username || "X").trim(),
      profileUrl: username ? `https://x.com/${encodeURIComponent(username)}` : "",
      emailInfo: null,
      metadata: {
        verified: profile.verified === true,
        verifiedType: profile.verified_type || "",
        profileImageUrl: profile.profile_image_url || "",
      },
    });
  } catch (error) {
    recordAuthEvent({ eventType: "x_oauth_failed", provider: "x", decision: error?.message || "x_callback_failed" });
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || "x_callback_failed",
      action: "x_auth_callback",
      message: "X login could not be completed.",
      actionRequired:
        error?.code === "x_client_credentials_rejected"
          ? "Copy the OAuth 2.0 Client ID and Client Secret from the same X App into X_CLIENT_ID and X_CLIENT_SECRET, then restart the Task Node API. App IDs and API keys are not the OAuth2 Client Secret."
          : error?.message || "Check X OAuth app callback configuration and retry.",
    });
  }
}

async function completeTelegramCallback(query = {}, requestMeta = {}) {
  const stateRow = consumeCallbackState("telegram", query, requestMeta);
  if (!stateRow) return invalidOAuthState("telegram", "Telegram");
  try {
    const profile = verifyTelegramLoginPayload(query, process.env.TELEGRAM_AUTH_BOT_TOKEN, {
      maxAuthAgeSec: Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 900),
    });
    const displayName = telegramDisplayName(profile);
    return completeProviderAuth({ providerId: "telegram", label: "Telegram", stateRow, providerUserId: String(profile.id), username: profile.username || displayName, displayName, profileUrl: profile.username ? `https://t.me/${profile.username}` : "", emailInfo: null, metadata: { authDate: profile.authDate, photoUrl: profile.photoUrl || "" } });
  } catch (error) {
    recordAuthEvent({ eventType: "telegram_oauth_failed", provider: "telegram", decision: error?.code || error?.message || "telegram_callback_failed" });
    return actionResponse({ status: error?.status || 401, error: error?.code || "telegram_callback_failed", action: "telegram_auth_callback", message: "Telegram login could not be completed.", actionRequired: error?.message || "Start Telegram login again and authorize the same Telegram account." });
  }
}

function invalidTelegramAuthorizeStateResponse() {
  return {
    status: 400,
    body: telegramAuthorizeErrorHtml({
      title: "Telegram Sign In Expired",
      message: "Telegram login state is invalid or expired.",
      actionRequired: "Start Telegram sign in again from Task Node Settings or the login dialog.",
    }),
  };
}

export function authTelegramAuthorize(query = {}, requestMeta = {}) {
  const stateId = readScalar(query?.state);
  const callbackCookieState = String(requestMeta.oauthState || "").trim();
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(stateId)) {
    return { status: 400, body: "Invalid Telegram auth state." };
  }
  if (!callbackCookieState || stateId !== callbackCookieState || !consumeOAuthState({ provider: "telegram", stateId, peek: true })) {
    return invalidTelegramAuthorizeStateResponse();
  }
  const botUsername = telegramBotUsername();
  if (!botUsername || !process.env.TELEGRAM_AUTH_BOT_TOKEN) {
    return { status: 503, body: "Telegram auth is not configured." };
  }
  const domainCheck = telegramDomainCheck(requestMeta);
  if (!domainCheck.ok) {
    return {
      status: 409,
      body: telegramAuthorizeErrorHtml({
        title: "Telegram Domain Mismatch",
        message: domainCheck.message,
        actionRequired: domainCheck.actionRequired,
      }),
    };
  }
  const callbackUrl = telegramCallbackUrl(requestMeta, stateId);
  const botDeepLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(`tasknode_${stateId}`)}`;
  return {
    status: 200,
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Task Node Telegram Sign In</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f6f2; color: #151512; }
    main { width: min(520px, calc(100vw - 32px)); padding: 36px 30px; background: #fff; border: 1px solid #e5e1d8; border-radius: 8px; box-shadow: 0 18px 54px rgba(0,0,0,.08); }
    h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0 0 16px; color: #5f5b52; font-size: 15px; line-height: 1.55; }
    .step { margin-top: 14px; padding: 14px 16px; border: 1px solid #ece8df; border-radius: 8px; background: #fbfaf7; }
    .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 6px; color: #fff; background: #111; text-decoration: none; font-weight: 650; }
    .telegram-widget { min-height: 46px; margin-top: 14px; }
    .muted { margin-top: 18px; font-size: 13px; color: #777267; }
  </style>
</head>
<body>
  <main>
    <h1>Telegram Sign In</h1>
    <p>Authorize Telegram to sign in or connect this Telegram identity to your current Task Node account.</p>
    <div class="step">
      <p>Open the Task Node Telegram bot if you want bot-side messaging continuity.</p>
      <a class="button" href="${escapeHtml(botDeepLink)}" target="_blank" rel="noopener noreferrer">Open Telegram bot</a>
    </div>
    <div class="step">
      <p>Then authorize the same Telegram account.</p>
      <div class="telegram-widget">
        <script async src="https://telegram.org/js/telegram-widget.js?22"
          data-telegram-login="${escapeHtml(botUsername)}"
          data-size="large"
          data-userpic="false"
          data-auth-url="${escapeHtml(callbackUrl)}"
          data-request-access="write"></script>
      </div>
    </div>
    <p class="muted">The server verifies Telegram's signed payload before issuing or linking an account session.</p>
  </main>
</body>
</html>`,
  };
}

function telegramAuthorizeErrorHtml({ title, message, actionRequired }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f6f2; color: #151512; }
    main { width: min(540px, calc(100vw - 32px)); padding: 34px 30px; background: #fff; border: 1px solid #e5e1d8; border-radius: 8px; box-shadow: 0 18px 54px rgba(0,0,0,.08); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.18; letter-spacing: 0; }
    p { margin: 0 0 14px; color: #5f5b52; font-size: 15px; line-height: 1.55; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f2eee7; border-radius: 4px; padding: 2px 4px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>${escapeHtml(actionRequired)}</p>
    <p>After updating the domain, restart the Task Node API process and start Telegram linking again.</p>
  </main>
</body>
</html>`;
}

export function telegramAuthHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' https://telegram.org",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "frame-src https://oauth.telegram.org https://telegram.org",
      "connect-src 'self' https://telegram.org https://oauth.telegram.org",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://oauth.telegram.org https://telegram.org",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
