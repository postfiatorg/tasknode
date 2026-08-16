#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeAuthenticationFailure, supportedRouteAuthModes, validateRouteAuthPolicy } from "../server/route-auth.js";
import { apiRoutePolicies, routePolicyForPath } from "../server/route-policies.js";

const registeredRouteHandlerFiles = [
  "../server/index.js",
  "../server/task-routes.js",
  "../server/tasknode-terminal-routes.js",
  "../server/account-routes.js",
  "../server/context-edit-actions.js",
  "../server/context-rewrite-actions.js",
  "../server/profile-routes.js",
  "../server/memory-routes.js",
  "../server/i-ching-routes.js",
  "../server/collaboration-routes.js",
  "../server/directory-routes.js",
  "../server/hive-routes.js",
  "../server/capability-profile-routes.js",
  "../server/network-badge-admin-routes.js",
  "../server/board-admin-routes.js",
  "../server/bm-transcript-routes.js",
  "../server/system-status.js",
  "../server/telegram-bot.js",
  "../server/pftl-cache-route.js",
];

for (const policy of apiRoutePolicies) validateRouteAuthPolicy(policy);

const literalApiPaths = new Set();
for (const relativeFile of registeredRouteHandlerFiles) {
  const source = readFileSync(new URL(relativeFile, import.meta.url), "utf8");
  for (const match of source.matchAll(/["'`](\/api\/[A-Za-z0-9_./:-]+)["'`]/g)) {
    const pathname = match[1];
    if (!pathname.includes(":") && !pathname.endsWith("/")) literalApiPaths.add(pathname);
  }
}
for (const pathname of literalApiPaths) {
  assert.ok(routePolicyForPath(pathname), `registered API path is missing a central auth policy: ${pathname}`);
}
assert.ok(literalApiPaths.size > 130, "registered API route scan must not silently shrink");

const sessionPolicy = { id: "private_data", auth: "session" };
assert.deepEqual(routeAuthenticationFailure({ policy: sessionPolicy }), {
  status: 401,
  error: "private_data_login_required",
  message: "Sign in before using this route.",
});
assert.equal(routeAuthenticationFailure({ policy: sessionPolicy, session: { accountId: "acct_1" } }), null);

const customSessionPolicy = {
  id: "collaboration_challenge",
  auth: "session",
  unauthenticatedError: "collaboration_login_required",
};
assert.equal(routeAuthenticationFailure({ policy: customSessionPolicy })?.error, "collaboration_login_required");

for (const auth of ["bearer", "admin_bearer"]) {
  const policy = { id: `${auth}_route`, auth };
  assert.equal(routeAuthenticationFailure({ policy })?.status, 401);
  assert.equal(routeAuthenticationFailure({ policy, headers: { authorization: "Basic nope" } })?.status, 401);
  assert.equal(routeAuthenticationFailure({ policy, headers: { authorization: "Bearer token" } }), null);
}

const webhookPolicy = { id: "telegram_bot_webhook", auth: "webhook_secret" };
assert.equal(routeAuthenticationFailure({ policy: webhookPolicy })?.status, 401);
assert.equal(
  routeAuthenticationFailure({ policy: webhookPolicy, headers: { "x-telegram-bot-api-secret-token": "present" } }),
  null
);

for (const auth of ["none", "optional", "handler", "oauth_state"]) {
  assert.equal(routeAuthenticationFailure({ policy: { id: `${auth}_route`, auth } }), null);
}

assert.throws(() => validateRouteAuthPolicy({ id: "bad", auth: "mystery" }), /unsupported_route_auth_mode/);

console.log(`route auth policy smoke ok: ${apiRoutePolicies.length} policies cover ${literalApiPaths.size} registered literal paths and ${supportedRouteAuthModes().length} modes`);
