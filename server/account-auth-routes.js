import { readValidatedJson as readJson } from "./request-validation.js";
import {
  accountAddIntentCookie,
  accountAddIntentCookieName,
  accountSetCookie,
  accountSetCookieName,
  cookieValue,
  expiredAccountAddIntentCookie,
  expiredAccountSetCookie,
  expiredSessionCookie,
  json,
  requestIp,
  sessionCookie,
} from "./server-http-boundary.js";
import { responseHeadersForAuthResult } from "./auth-oauth-http.js";
import {
  passwordChange,
  passwordDisable,
  passwordEnableStart,
  passwordEnableVerify,
  passwordLogin,
  passwordResetStart,
  passwordResetVerify,
  passwordStatus,
} from "./account-password-auth.js";
import {
  accountAddStart,
  accountList,
  accountLogoutAll,
  accountLogoutCurrent,
  accountRemove,
  accountSwitch,
  registerAuthenticatedAccountSet,
} from "./account-switching.js";
import { consumeAddAccountIntent, getAddAccountIntent } from "./repositories/auth-challenges.js";
import { resolveDeviceAccountSet } from "./repositories/device-account-sets.js";

function appendCookies(headers = {}, cookies = []) {
  const existing = headers["set-cookie"]
    ? Array.isArray(headers["set-cookie"])
      ? headers["set-cookie"]
      : [headers["set-cookie"]]
    : [];
  const combined = [...existing, ...cookies.filter(Boolean)];
  if (combined.length === 1) headers["set-cookie"] = combined[0];
  if (combined.length > 1) headers["set-cookie"] = combined;
  return headers;
}

export async function authResultHeaders(req, result, { clearAccountAddIntent = false } = {}) {
  const headers = responseHeadersForAuthResult(req, result);
  const cookies = [];
  if (result.sessionId && result.body?.session?.accountId) {
    const accountSet = await registerAuthenticatedAccountSet({
      accountId: result.body.session.accountId,
      accountSetToken: cookieValue(req, accountSetCookieName),
      sessionId: result.sessionId,
      metadata: { userAgent: String(req.headers["user-agent"] || "").slice(0, 240) },
    });
    if (accountSet?.token) cookies.push(accountSetCookie(req, accountSet.token));
  }
  if (clearAccountAddIntent) {
    const intentId = cookieValue(req, accountAddIntentCookieName);
    if (intentId) await consumeAddAccountIntent(intentId);
    cookies.push(expiredAccountAddIntentCookie(req));
  }
  return appendCookies(headers, cookies);
}

export async function currentAuthIntent(req) {
  const intentId = cookieValue(req, accountAddIntentCookieName);
  if (!intentId) return "";
  const [intent, set] = await Promise.all([
    getAddAccountIntent(intentId),
    resolveDeviceAccountSet({ token: cookieValue(req, accountSetCookieName) }),
  ]);
  return intent?.kind === "add_account" && intent.setId && intent.setId === set?.setId
    ? "add_account"
    : "";
}

export async function handleAccountAuthRoutes({ req, res, url, session, sessionId } = {}) {
  if (url.pathname === "/api/auth/password") {
    const result = await passwordLogin(await readJson(req, 4096));
    json(res, result.status, result.body, await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) }));
    return true;
  }
  if (url.pathname === "/api/auth/password/reset/start") {
    const result = await passwordResetStart(await readJson(req, 4096), { ip: requestIp(req), userAgent: req.headers["user-agent"] || "" });
    json(res, result.status, result.body);
    return true;
  }
  if (url.pathname === "/api/auth/password/reset/verify") {
    const result = await passwordResetVerify(await readJson(req, 4096));
    json(res, result.status, result.body, await authResultHeaders(req, result, { clearAccountAddIntent: Boolean(result.sessionId) }));
    return true;
  }
  if (url.pathname === "/api/account/password") {
    const result = await passwordStatus(session);
    json(res, result.status, result.body);
    return true;
  }
  if (url.pathname === "/api/account/password/enable/start") {
    const result = await passwordEnableStart(await readJson(req, 1024), session);
    json(res, result.status, result.body);
    return true;
  }
  if (url.pathname === "/api/account/password/enable/verify") {
    const result = await passwordEnableVerify(await readJson(req, 4096), session);
    json(res, result.status, result.body, await authResultHeaders(req, result));
    return true;
  }
  if (url.pathname === "/api/account/password/change") {
    const result = await passwordChange(await readJson(req, 4096), session);
    json(res, result.status, result.body, await authResultHeaders(req, result));
    return true;
  }
  if (url.pathname === "/api/account/password/disable") {
    const result = await passwordDisable(await readJson(req, 2048), session);
    json(res, result.status, result.body, await authResultHeaders(req, result));
    return true;
  }
  if (url.pathname === "/api/auth/logout") {
    const result = await accountLogoutCurrent({ accountSetToken: cookieValue(req, accountSetCookieName), session, sessionId });
    const cookies = result.sessionId
      ? [sessionCookie(req, result.sessionId), accountSetCookie(req, result.accountSetToken)]
      : [expiredSessionCookie(req), expiredAccountSetCookie(req)];
    json(res, result.status, { ...result.body, action: "auth_logout" }, { "set-cookie": cookies });
    return true;
  }
  if (url.pathname === "/api/auth/logout-all") {
    const result = await accountLogoutAll({ accountSetToken: cookieValue(req, accountSetCookieName), session, sessionId });
    json(res, result.status, result.body, { "set-cookie": [expiredSessionCookie(req), expiredAccountSetCookie(req), expiredAccountAddIntentCookie(req)] });
    return true;
  }
  if (url.pathname === "/api/auth/accounts") {
    const result = await accountList({ accountSetToken: cookieValue(req, accountSetCookieName), session, sessionId });
    json(res, result.status, result.body, result.accountSetToken ? { "set-cookie": accountSetCookie(req, result.accountSetToken) } : {});
    return true;
  }
  if (url.pathname === "/api/auth/accounts/add/start") {
    const result = await accountAddStart({ accountSetToken: cookieValue(req, accountSetCookieName), session, sessionId });
    const cookies = [
      result.accountSetToken ? accountSetCookie(req, result.accountSetToken) : "",
      result.accountAddIntentId ? accountAddIntentCookie(req, result.accountAddIntentId) : "",
    ].filter(Boolean);
    json(res, result.status, result.body, cookies.length ? { "set-cookie": cookies } : {});
    return true;
  }
  if (url.pathname === "/api/auth/accounts/add/cancel") {
    const intentId = cookieValue(req, accountAddIntentCookieName);
    if (intentId) await consumeAddAccountIntent(intentId);
    json(res, 200, { ok: true, message: "Add-account login cancelled." }, { "set-cookie": expiredAccountAddIntentCookie(req) });
    return true;
  }
  if (url.pathname === "/api/auth/accounts/switch") {
    const result = await accountSwitch({
      accountSetToken: cookieValue(req, accountSetCookieName),
      payload: await readJson(req, 2048),
      session,
      sessionId,
    });
    const cookies = result.sessionId ? [sessionCookie(req, result.sessionId), accountSetCookie(req, result.accountSetToken)] : [];
    json(res, result.status, result.body, cookies.length ? { "set-cookie": cookies } : {});
    return true;
  }
  if (url.pathname === "/api/auth/accounts/remove") {
    const result = await accountRemove({ accountSetToken: cookieValue(req, accountSetCookieName), payload: await readJson(req, 2048), session });
    json(res, result.status, result.body);
    return true;
  }
  return false;
}
