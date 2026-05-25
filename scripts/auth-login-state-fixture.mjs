import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TASKNODE_STORE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), "tasknode-auth-fixture-")),
  "runtime-store.json"
);
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "auth-login-state-fixture-secret";
process.env.TASKNODE_EMAIL_DEV_DELIVERY = "true";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";
process.env.TASKNODE_PUBLIC_URL = "http://localhost:5174";
process.env.TELEGRAM_AUTH_BOT_TOKEN = "123456:tasknode-telegram-secret";
process.env.TELEGRAM_AUTH_BOT_USERNAME = "TaskNodeFixtureBot";
process.env.TELEGRAM_AUTH_WIDGET_DOMAIN = "localhost";
process.env.DISCORD_CLIENT_ID = "discord-fixture-client";
process.env.DISCORD_CLIENT_SECRET = "discord-fixture-secret";
process.env.X_CLIENT_ID = "x-fixture-client";
process.env.X_CLIENT_SECRET = "x-fixture-secret";

const product = await import("../server/product-contracts.js");
const runtime = await import("../server/runtime-store.js");

const {
  authCallback,
  authEmailStart,
  authEmailVerify,
  authProviders,
  authStart,
  authTelegramAuthorize,
} = product;
const {
  checkHiveHandleAvailability,
  destroySession,
  getAccountIdentityProfile,
  getSession,
  setAccountAliasVisibility,
  setAccountHiveHandle,
} = runtime;

const origin = "http://localhost:5174";
const logs = [];

function record(name, payload = {}) {
  logs.push({ name, ...payload });
}

function assertOk(condition, message) {
  assert.equal(Boolean(condition), true, message);
}

function signedTelegramPayload(fields, token = process.env.TELEGRAM_AUTH_BOT_TOKEN) {
  const payload = Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
      .map(([key, value]) => [key, String(value)])
  );
  const dataCheckString = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join("\n");
  const secretKey = createHash("sha256").update(token).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return { ...payload, hash };
}

function linkedProviderIds(session) {
  return (session?.linkedProviders || []).map((provider) => provider?.id).filter(Boolean).sort();
}

function stateFromStart(result) {
  assert.equal(result.status, 200);
  assertOk(result.oauthState?.value, "OAuth start should produce a state cookie value");
  assertOk(result.body?.redirectUrl, "OAuth start should produce a redirect URL");
  return result.oauthState.value;
}

function installDiscordFetchMock() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target === "https://discord.com/api/oauth2/token") {
      return new Response(JSON.stringify({ access_token: "discord-fixture-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target === "https://discord.com/api/v10/users/@me") {
      return new Response(JSON.stringify({
        id: "246813579",
        username: "discord_fixture",
        global_name: "Discord Fixture",
        email: "fixture-discord@example.com",
        verified: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

function installXFetchMock() {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://api.x.com/2/oauth2/token") {
      const body = new URLSearchParams(String(options.body || ""));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "x-oauth-code");
      assert.equal(body.get("redirect_uri"), `${origin}/api/auth/callback/x`);
      assert.equal(body.has("client_id"), false);
      assertOk(body.get("code_verifier"), "X token exchange should include the PKCE verifier");
      assertOk(String(options.headers?.Authorization || "").startsWith("Basic "), "X token exchange should use client credentials");
      return new Response(JSON.stringify({ access_token: "x-fixture-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.startsWith("https://api.x.com/2/users/me?")) {
      return new Response(JSON.stringify({
        data: {
          id: "1357924680",
          username: "x_fixture",
          name: "X Fixture",
          profile_image_url: "https://x.example/avatar.jpg",
          verified: false,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url, options);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

const providers = authProviders();
record("providers.ready", {
  enabled: providers
    .filter((provider) => provider.enabled)
    .map((provider) => provider.id)
    .sort(),
});
assertOk(providers.find((provider) => provider.id === "email")?.enabled, "email provider should be enabled");
assertOk(providers.find((provider) => provider.id === "telegram")?.enabled, "telegram provider should be enabled");
assertOk(providers.find((provider) => provider.id === "discord")?.enabled, "discord provider should be enabled");
assertOk(providers.find((provider) => provider.id === "x")?.enabled, "x provider should be enabled");

const emailStart = await authEmailStart({ email: "Fixture.User@example.com" }, "POST", {
  ip: "127.0.0.1",
  userAgent: "auth-login-state-fixture",
});
assert.equal(emailStart.status, 200);
const { challengeId, delivery } = emailStart.body;
record("email.challenge_started", {
  challengeId,
  deliveryMode: delivery.mode,
});

const invalidEmail = authEmailVerify({ challengeId, code: "00000000" }, "POST");
assert.equal(invalidEmail.status, 400);
assert.equal(invalidEmail.body.error, "email_code_invalid");
record("email.invalid_code_rejected", {
  status: invalidEmail.status,
  error: invalidEmail.body.error,
});

const emailVerified = authEmailVerify({ challengeId, code: delivery.devCode }, "POST");
assert.equal(emailVerified.status, 200);
assertOk(emailVerified.sessionId, "email verification should issue a session id");
const emailSession = emailVerified.body.session;
record("email.success", {
  accountId: emailSession.accountId,
  linkedProviders: linkedProviderIds(emailSession),
});

const telegramStart = authStart("telegram", { origin, redirectPath: "/settings", session: null });
const telegramState = stateFromStart(telegramStart);
assertOk(telegramStart.body.redirectUrl.includes("/api/auth/telegram/authorize"), "telegram start should use authorize page");
const telegramAuthorize = authTelegramAuthorize({ state: telegramState }, { origin, oauthState: telegramState });
assert.equal(telegramAuthorize.status, 200);
assertOk(String(telegramAuthorize.body).includes("data-telegram-login=\"TaskNodeFixtureBot\""), "telegram authorize should render configured bot username");
const telegramAuthorizeStale = authTelegramAuthorize({ state: telegramState }, { origin, oauthState: "different-state" });
assert.equal(telegramAuthorizeStale.status, 400);
assertOk(String(telegramAuthorizeStale.body).includes("Telegram Sign In Expired"), "telegram authorize should reject stale oauth cookie");
const telegramPayload = signedTelegramPayload({
  id: "987654321",
  first_name: "Telegram",
  last_name: "Fixture",
  username: "telegram_fixture",
  auth_date: Math.floor(Date.now() / 1000),
});
const telegramCallback = await authCallback("telegram", { ...telegramPayload, state: telegramState }, {
  origin,
  oauthState: telegramState,
});
assert.equal(telegramCallback.status, 302);
assertOk(telegramCallback.sessionId, "telegram callback should issue a session id");
record("telegram.success", {
  accountId: telegramCallback.body.session.accountId,
  linkedProviders: linkedProviderIds(telegramCallback.body.session),
});

const telegramReconnectStart = authStart("telegram", { origin, redirectPath: "/", session: null });
const telegramReconnectState = stateFromStart(telegramReconnectStart);
const telegramReconnect = await authCallback("telegram", {
  ...signedTelegramPayload({
    id: "987654321",
    first_name: "Telegram",
    username: "telegram_fixture",
    auth_date: Math.floor(Date.now() / 1000),
  }),
  state: telegramReconnectState,
}, {
  origin,
  oauthState: telegramReconnectState,
});
assert.equal(telegramReconnect.status, 302);
assert.equal(telegramReconnect.body.session.accountId, telegramCallback.body.session.accountId);
record("telegram.reconnect_same_account", {
  accountId: telegramReconnect.body.session.accountId,
});

const telegramInvalidStart = authStart("telegram", { origin, redirectPath: "/", session: null });
const telegramInvalidState = stateFromStart(telegramInvalidStart);
const telegramInvalid = await authCallback("telegram", {
  ...signedTelegramPayload({
    id: "111111111",
    first_name: "Invalid",
    auth_date: Math.floor(Date.now() / 1000),
  }),
  hash: "0".repeat(64),
  state: telegramInvalidState,
}, {
  origin,
  oauthState: telegramInvalidState,
});
assert.equal(telegramInvalid.status, 401);
assert.equal(telegramInvalid.body.error, "telegram_auth_signature_invalid");
record("telegram.invalid_signature_rejected", {
  status: telegramInvalid.status,
  error: telegramInvalid.body.error,
});

const telegramExpiredStart = authStart("telegram", { origin, redirectPath: "/", session: null });
const telegramExpiredState = stateFromStart(telegramExpiredStart);
const telegramExpired = await authCallback("telegram", {
  ...signedTelegramPayload({
    id: "222222222",
    first_name: "Expired",
    auth_date: Math.floor(Date.now() / 1000) - 3600,
  }),
  state: telegramExpiredState,
}, {
  origin,
  oauthState: telegramExpiredState,
});
assert.equal(telegramExpired.status, 401);
assert.equal(telegramExpired.body.error, "telegram_auth_expired");
record("telegram.expired_payload_rejected", {
  status: telegramExpired.status,
  error: telegramExpired.body.error,
});

const telegramLinkStart = authStart("telegram", { origin, redirectPath: "/settings", session: emailSession });
const telegramLinkState = stateFromStart(telegramLinkStart);
assert.equal(telegramLinkStart.body.mode, "account_link");
const telegramLinked = await authCallback("telegram", {
  ...signedTelegramPayload({
    id: "333333333",
    first_name: "Linked",
    username: "linked_telegram_fixture",
    auth_date: Math.floor(Date.now() / 1000),
  }),
  state: telegramLinkState,
}, {
  origin,
  oauthState: telegramLinkState,
});
assert.equal(telegramLinked.status, 302);
assert.equal(telegramLinked.body.session.accountId, emailSession.accountId);
assertOk(linkedProviderIds(telegramLinked.body.session).includes("telegram"), "email account should link telegram");
record("telegram.linked_to_email_account", {
  accountId: telegramLinked.body.session.accountId,
  linkedProviders: linkedProviderIds(telegramLinked.body.session),
});

const restoreFetch = installDiscordFetchMock();
try {
  const discordStart = authStart("discord", { origin, redirectPath: "/settings", session: telegramLinked.body.session });
  const discordState = stateFromStart(discordStart);
  assert.equal(discordStart.body.mode, "account_link");
  const discordLinked = await authCallback("discord", { code: "discord-oauth-code", state: discordState }, {
    origin,
    oauthState: discordState,
  });
  assert.equal(discordLinked.status, 302);
  assert.equal(discordLinked.body.session.accountId, emailSession.accountId);
  assertOk(linkedProviderIds(discordLinked.body.session).includes("discord"), "email account should link discord");
  record("discord.linked_to_email_account", {
    accountId: discordLinked.body.session.accountId,
    linkedProviders: linkedProviderIds(discordLinked.body.session),
  });
} finally {
  restoreFetch();
}

const restoreXFetch = installXFetchMock();
let xLinkedSession = null;
try {
  const xStart = authStart("x", { origin, redirectPath: "/settings", session: telegramLinked.body.session });
  const xState = stateFromStart(xStart);
  const xAuthorizeUrl = new URL(xStart.body.redirectUrl);
  assert.equal(xAuthorizeUrl.origin + xAuthorizeUrl.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(xAuthorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(xAuthorizeUrl.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/x`);
  assert.equal(xAuthorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assertOk(xAuthorizeUrl.searchParams.get("code_challenge"), "X auth start should include a PKCE challenge");
  const xLinked = await authCallback("x", { code: "x-oauth-code", state: xState }, {
    origin,
    oauthState: xState,
  });
  assert.equal(xLinked.status, 302);
  assert.equal(xLinked.body.session.accountId, emailSession.accountId);
  assertOk(linkedProviderIds(xLinked.body.session).includes("x"), "email account should link x");
  xLinkedSession = xLinked.body.session;
  record("x.linked_to_email_account", {
    accountId: xLinked.body.session.accountId,
    linkedProviders: linkedProviderIds(xLinked.body.session),
  });
} finally {
  restoreXFetch();
}

const staleState = await authCallback("telegram", { ...telegramPayload, state: "stale-state" }, {
  origin,
  oauthState: "different-state",
});
assert.equal(staleState.status, 400);
assert.equal(staleState.body.error, "oauth_state_invalid");
record("oauth.stale_state_rejected", {
  status: staleState.status,
  error: staleState.body.error,
});

const identityBefore = getAccountIdentityProfile({ accountId: emailSession.accountId });
const xAliasBefore = identityBefore.aliases.find((alias) => alias.provider === "x");
assert.equal(identityBefore.handleRequired, true);
assertOk(xAliasBefore, "linked X should be present as a private alias");
assert.equal(xAliasBefore.visibility, "private");
const handleAvailability = checkHiveHandleAvailability({
  accountId: emailSession.accountId,
  handle: "x_fixture",
});
assert.equal(handleAvailability.available, true);
const handleSaved = setAccountHiveHandle({
  accountId: emailSession.accountId,
  handle: "x_fixture",
  displayName: "Fixture Pseudonym",
});
assert.equal(handleSaved.ok, true);
assert.equal(handleSaved.identityProfile.hiveHandle, "x_fixture");
const aliasPublished = setAccountAliasVisibility({
  accountId: emailSession.accountId,
  provider: "x",
  visibility: "public",
  discloseHandle: true,
  discloseVerifiedBadge: true,
});
assert.equal(aliasPublished.ok, true);
assert.equal(aliasPublished.identityProfile.publicAliases[0]?.handle, "x_fixture");
assert.equal(getSession(emailVerified.sessionId)?.identityProfile?.hiveHandle, "x_fixture");
assert.equal(getSession(xLinkedSession?.id)?.identityProfile?.publicAliases[0]?.handle, "x_fixture");
record("identity.namespace_saved", {
  accountId: emailSession.accountId,
  handle: handleSaved.identityProfile.hiveHandle,
  publicAliases: aliasPublished.identityProfile.publicAliases.length,
});

assert.equal(Boolean(getSession(emailVerified.sessionId)), true);
assert.equal(destroySession(emailVerified.sessionId), true);
assert.equal(getSession(emailVerified.sessionId), null);
record("logout.session_destroyed", {
  sessionId: emailVerified.sessionId,
  sessionAfterLogout: null,
});

record("summary.discovered_prior_failures", {
  failures: [
    "Telegram and Discord appeared in Connected accounts, but the backend returned disabled/not implemented responses.",
    "X appeared as configured, but /api/auth/start/x returned auth_provider_disabled.",
    "Telegram readiness only checked the bot token; the Login Widget also requires a bot username and an authorize page.",
    "Email-only accounts could not attach Telegram, Discord, or X identities for later validated messaging.",
    "No deterministic fixture covered invalid auth, stale OAuth state, PKCE provider callbacks, reconnect, and logout behavior for these providers.",
  ],
});

for (const entry of logs) {
  console.log(`${entry.name} ${JSON.stringify(Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "name")
  ))}`);
}
console.log(`auth_login_state_fixture_passed transitions=${logs.length}`);
