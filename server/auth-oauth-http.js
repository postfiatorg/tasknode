import { sessionCookieName, sessionTtlSeconds } from "./runtime-store.js";

function secureCookie(req) {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    (process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "").startsWith("https://")
  );
}

function sessionCookie(req, sessionId) {
  const secure = secureCookie(req) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlSeconds}${secure}`;
}

export function oauthStateCookieName(provider) {
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

export function responseHeadersForAuthResult(req, result) {
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
