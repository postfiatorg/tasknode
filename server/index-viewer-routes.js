/* Index viewer: wallet-gated research bundles hosted on static sites.
 *
 * A published bundle is encrypted once and served from a public static host,
 * so the bundle itself carries no access control. Task Node holds the content
 * key and hands it out only to an account with a linked wallet. The flow is:
 *
 *   1. GET  /index-auth/start   browser arrives with a session; we mint a
 *                               single-use code and bounce back to the site
 *   2. POST /api/index-viewer/exchange       code  -> viewer token
 *   3. POST /api/index-viewer/indices/:id/unlock  token -> content key
 *
 * The code is single use and short lived, and the token is scoped to one index
 * and one account, so a leaked token cannot open the rest of the catalog.
 */
import { getLinkedWallet } from "./repositories/account-wallets.js";
import {
  consumeCode,
  getIndex,
  issueCode,
  issueViewerToken,
  listIndices,
  resolveViewerToken,
} from "./repositories/index-viewer.js";

const TIER_ACTIVE_WALLET = "tasknode-active-wallet";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://agti.net",
  "https://www.agti.net",
  "https://agtico.github.io",
];

/* These endpoints are designed to be called cross-origin by a static site, so
 * they opt out of the same-origin mutation guard against a narrow allowlist.
 * That is safe here because neither exchange nor unlock trusts cookies: the
 * caller must present a single-use code or a scoped bearer token, so there is
 * no ambient authority for another site to ride on. */
export function allowedStaticOrigins(env = process.env) {
  const configured = String(env.INDEX_VIEWER_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function corsHeadersFor(req, env = process.env) {
  const origin = String(req.headers?.origin || "");
  if (!origin || !allowedStaticOrigins(env).includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** Only ever bounce back to an https origin the caller actually supplied. */
export function safeReturnTo(rawReturnTo = "") {
  const value = String(rawReturnTo || "").trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return null;
  }
  url.hash = "";
  return url;
}

export async function accountMeetsTier({ accountId = "", tier = TIER_ACTIVE_WALLET } = {}) {
  if (!accountId) return { ok: false, reason: "not_signed_in", walletAddress: "" };
  if (tier !== TIER_ACTIVE_WALLET) {
    // Unknown tiers fail closed rather than silently granting access.
    return { ok: false, reason: "unsupported_tier", walletAddress: "" };
  }
  const wallet = await getLinkedWallet({ accountId });
  const address = String(wallet?.address || wallet?.walletAddress || "");
  if (!address) return { ok: false, reason: "wallet_required", walletAddress: "" };
  return { ok: true, reason: "", walletAddress: address };
}

export async function handleIndexViewerRoute({ json, readJson, req, res, session, url } = {}) {
  if (!url.pathname.startsWith("/api/index-viewer/") && url.pathname !== "/index-auth/start") {
    return false;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const accountId = session?.accountId || "";
  const cors = corsHeadersFor(req) || {};

  if (req.method === "OPTIONS") {
    res.writeHead(corsHeadersFor(req) ? 204 : 403, { ...cors, "cache-control": "no-store" });
    res.end();
    return true;
  }
  // A browser mutation from outside the allowlist is refused outright rather
  // than answered without CORS headers, so the failure is legible.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = String(req.headers?.origin || "");
    if (origin && !corsHeadersFor(req)) {
      json(res, 403, { ok: false, error: "origin_not_allowed" }, cors);
      return true;
    }
  }

  // ---------------------------------------------------------------- catalog
  if (url.pathname === "/api/index-viewer/catalog") {
    json(res, 200, { ok: true, indices: await listIndices() }, cors);
    return true;
  }

  // ------------------------------------------------------------------ start
  if (url.pathname === "/index-auth/start") {
    const indexId = String(url.searchParams.get("index_id") || "").trim();
    const state = String(url.searchParams.get("state") || "").trim();
    const returnTo = safeReturnTo(url.searchParams.get("return_to"));
    if (!indexId || !returnTo) {
      json(res, 400, { ok: false, error: "index_id_and_return_to_required" }, cors);
      return true;
    }
    const index = await getIndex(indexId);
    if (!index) {
      json(res, 404, { ok: false, error: "index_not_found" }, cors);
      return true;
    }

    const eligibility = await accountMeetsTier({ accountId, tier: index.tier });
    if (!eligibility.ok) {
      // Send the visitor through the normal app login, then straight back here.
      const selfUrl = new URL(url.toString());
      const login = new URL("/", url.origin);
      login.searchParams.set("redirect", `${selfUrl.pathname}${selfUrl.search}`);
      login.searchParams.set("index_viewer_reason", eligibility.reason);
      res.writeHead(302, { location: login.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    }

    const { code } = await issueCode({
      indexId,
      accountId,
      returnOrigin: returnTo.origin,
    });
    returnTo.searchParams.set("index_viewer_code", code);
    returnTo.searchParams.set("index_id", indexId);
    if (state) returnTo.searchParams.set("state", state);
    res.writeHead(302, { location: returnTo.toString(), "cache-control": "no-store" });
    res.end();
    return true;
  }

  // --------------------------------------------------------------- exchange
  if (url.pathname === "/api/index-viewer/exchange") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" }, cors);
      return true;
    }
    const payload = await readJson(req, 4096);
    const indexId = String(payload?.index_id || "").trim();
    const code = String(payload?.code || "").trim();
    if (!indexId || !code) {
      json(res, 400, { ok: false, error: "code_and_index_id_required" }, cors);
      return true;
    }
    const claimed = await consumeCode({ code, indexId });
    if (!claimed) {
      json(res, 401, { ok: false, error: "code_invalid_or_expired" }, cors);
      return true;
    }
    const index = await getIndex(indexId);
    if (!index) {
      json(res, 404, { ok: false, error: "index_not_found" }, cors);
      return true;
    }
    // Re-check eligibility at exchange time: a wallet unlinked between the
    // redirect and the exchange must not still mint a token.
    const eligibility = await accountMeetsTier({ accountId: claimed.accountId, tier: index.tier });
    if (!eligibility.ok) {
      json(res, 403, { ok: false, error: eligibility.reason }, cors);
      return true;
    }
    const { token, expiresAt } = await issueViewerToken({
      indexId,
      accountId: claimed.accountId,
      walletAddress: eligibility.walletAddress,
    });
    json(res, 200, { ok: true, viewer_token: token, expires_at: expiresAt, index_id: indexId }, cors);
    return true;
  }

  // ----------------------------------------------------------------- unlock
  if (
    parts[0] === "api" &&
    parts[1] === "index-viewer" &&
    parts[2] === "indices" &&
    parts[3] &&
    parts[4] === "unlock"
  ) {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" }, cors);
      return true;
    }
    const indexId = decodeURIComponent(parts[3]);
    const token = bearerToken(req);
    if (!token) {
      json(res, 401, { ok: false, error: "viewer_token_required" }, cors);
      return true;
    }
    const grant = await resolveViewerToken({ token, indexId });
    if (!grant) {
      json(res, 401, { ok: false, error: "viewer_token_invalid_or_expired" }, cors);
      return true;
    }
    const index = await getIndex(indexId);
    if (!index) {
      json(res, 404, { ok: false, error: "index_not_found" }, cors);
      return true;
    }
    if (new Date(index.availableAt).getTime() > Date.now()) {
      json(res, 403, { ok: false, error: "index_not_yet_available" }, cors);
      return true;
    }
    const eligibility = await accountMeetsTier({ accountId: grant.accountId, tier: index.tier });
    if (!eligibility.ok) {
      json(res, 403, { ok: false, error: eligibility.reason }, cors);
      return true;
    }
    json(
      res,
      200,
      {
        ok: true,
        index_id: indexId,
        content_key: index.contentKey,
        content_url: index.contentUrl,
        content_hash: index.contentHash,
        title: index.title,
      },
      { ...cors, "cache-control": "no-store" }
    );
    return true;
  }

  return false;
}
