import { handleWithdrawal } from './withdrawal-routes.js';
import { handleSolana } from './solana-bridge.js';
const ROOT = "/api/l1/bridge";
const ROUTE = "ethereum-mainnet-usdc-v1";
const FAUCET_SERVICE = (process.env.L1_FAUCET_SERVICE_URL || "http://127.0.0.1:18085").replace(/\/$/, "");
const JOB_FIELDS = new Set([
  "route_id", "source_chain_id", "deposit_tx_hash", "deposit_id", "pftl_recipient",
  "depositor", "amount_atoms", "idempotency_key", "route_profile_hash", "route_epoch", "route_binding",
]);

export async function handleBridgeRoutes({ req, res, url, session, json, readJson, proxyUrl, bridgeProxyUrl, proxyToken = "", proxyOrigin = "", bridgePathPrefix = "/api/bridge", withdrawViaRelay = false, solanaOrigin = null, env = process.env }) {
  if (!url.pathname.startsWith(`${ROOT}/`)) return false;
  res.setHeader("Cache-Control", "no-store");
  const fail = (status, code, message) => { json(res, status, { ok: false, ready: false, code, message }); return true; };
  if (!session?.accountId) return fail(401, "l1_login_required", "Sign in to use the bridge.");
  const suffix = url.pathname.slice(ROOT.length);
  if (suffix === "/faucet") {
    // Starter PFT for a new wallet. The account id is set here from the session, never by the browser;
    // on the relay host the caller is the authenticated Task Node server, which forwards it.
    if (req.method !== "POST") return fail(404, "bridge_route_not_found", "Unknown bridge endpoint.");
    const relayed = session.accountId === "relay-service";
    if (!relayed) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return fail(403, "bridge_origin_required", "Same-origin request required."); }
      if (origin.host !== req.headers.host || req.headers["sec-fetch-site"] === "cross-site") return fail(403, "bridge_origin_mismatch", "Same-origin request required.");
    }
    const body = await readJson(req, 4 * 1024);
    const allowed = relayed ? ["address", "account"] : ["address"];
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))
        || !/^pf[0-9a-f]{40}$/.test(body.address || "") || (relayed && !/^[A-Za-z0-9:_@.-]{1,128}$/.test(body.account || ""))) {
      return fail(400, "invalid_faucet_request", "Invalid starter PFT request.");
    }
    const account = relayed ? body.account : String(session.accountId).replace(/[^A-Za-z0-9:_@.-]/g, "_").slice(0, 128);
    try {
      const target = withdrawViaRelay ? `${String(bridgeProxyUrl).replace(/\/$/, "")}${bridgePathPrefix}/faucet` : `${FAUCET_SERVICE}/api/bridge/faucet`;
      const response = await fetch(target, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(withdrawViaRelay && proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}), ...(withdrawViaRelay && proxyOrigin ? { Origin: proxyOrigin } : {}) },
        body: JSON.stringify({ address: body.address, account }),
      });
      const payload = await response.json();
      if (withdrawViaRelay && proxyToken && JSON.stringify(payload).includes(proxyToken)) throw new Error("Unsafe faucet response");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid faucet response");
      json(res, response.status, payload);
      return true;
    } catch {
      return fail(502, "faucet_service_unavailable", "Starter PFT is unavailable right now.");
    }
  }
  const solana = suffix === "/solana/withdrawals" || suffix.startsWith("/solana/withdrawals/");
  if (solana || suffix === "/withdrawals" || suffix.startsWith("/withdrawals/")) {
    return handleWithdrawal({ req, res, json, readJson, fail, suffix, session, bridgeProxyUrl, bridgePathPrefix,
      proxyToken, proxyOrigin, withdrawViaRelay, solana, solanaOrigin, env });
  }
  if (suffix.startsWith("/solana/")) {
    return handleSolana({ req, res, json, readJson, fail, suffix, env, session, bridgeProxyUrl, proxyToken, proxyOrigin, withdrawViaRelay });
  }
  const isReadiness = req.method === "GET" && suffix === "/readiness";
  const isJob = req.method === "GET" && /^\/jobs\/0x[0-9a-f]{64}$/.test(suffix);
  const isCreate = req.method === "POST" && suffix === "/jobs";
  if (!isReadiness && !isJob && !isCreate) return fail(404, "bridge_route_not_found", "Unknown bridge endpoint.");
  if (isCreate) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return fail(403, "bridge_origin_required", "Same-origin request required."); }
    if (origin.host !== req.headers.host || req.headers["sec-fetch-site"] === "cross-site") {
      return fail(403, "bridge_origin_mismatch", "Same-origin request required.");
    }
  }
  const target = bridgeProxyUrl || proxyUrl;
  if (!target) return fail(503, "bridge_proxy_unconfigured", "Bridge blocked: wallet proxy is not configured.");
  try {
    const upstream = new URL(target);
    if (upstream.protocol === "ws:") upstream.protocol = "http:";
    if (upstream.protocol === "wss:") upstream.protocol = "https:";
    if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error("Invalid proxy URL");
    upstream.pathname = `${bridgePathPrefix}${suffix}`;
    upstream.search = isReadiness ? `?route=${ROUTE}` : "";
    upstream.hash = "";
    let body;
    if (isCreate) {
      body = await readJson(req, 16 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some((key) => !JOB_FIELDS.has(key))
          || body.route_id !== ROUTE || body.source_chain_id !== 1
          || !/^pf[0-9a-f]{40}$/.test(body.pftl_recipient || "")
          || !/^0x[0-9a-f]{64}$/.test(body.deposit_tx_hash || "")
          || !/^0x[0-9a-f]{64}$/.test(body.deposit_id || "")
          || !/^0x[0-9a-f]{40}$/.test(body.depositor || "")
          || !/^[1-9][0-9]{0,19}$/.test(body.amount_atoms || "")
          || !/^[0-9a-f]{96}$/.test(body.route_profile_hash || "")
          || !Number.isSafeInteger(body.route_epoch) || body.route_epoch < 1
          || !/^0x[0-9a-f]{64}$/.test(body.route_binding || "")
          || !/^[a-zA-Z0-9:_-]{1,128}$/.test(body.idempotency_key || "")) {
        return fail(400, "invalid_bridge_request", "Invalid bridge deposit request.");
      }
    }
    const response = await fetch(upstream, {
      method: req.method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json", ...(proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}), ...(proxyOrigin ? { Origin: proxyOrigin } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (proxyToken && JSON.stringify(payload).includes(proxyToken)) throw new Error("Unsafe bridge response");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid bridge response");
    json(res, response.status, payload);
    return true;
  } catch {
    return fail(502, "bridge_upstream_unavailable", "Bridge blocked: readiness or job service is unreachable.");
  }
}
