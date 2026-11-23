const WITHDRAW_SERVICE = (process.env.L1_WITHDRAW_SERVICE_URL || "http://127.0.0.1:18084").replace(/\/$/, "");
const UNAVAILABLE = "Solana withdrawals are not available yet";

export async function handleWithdrawal({ req, res, json, readJson, fail, suffix, bridgeProxyUrl, bridgePathPrefix, proxyToken, proxyOrigin, withdrawViaRelay, solana, solanaOrigin }) {
  // PFUSDC -> USDC. The holder burns from their own wallet; this only starts and reads the payout job.
  const path = solana ? suffix.slice("/solana".length) : suffix;
  const wReady = req.method === "GET" && path === "/withdrawals/readiness";
  const wJob = req.method === "GET" && /^\/withdrawals\/[0-9a-f]{96}$/.test(path);
  const wCreate = req.method === "POST" && path === "/withdrawals";
  if (solana && req.method === "GET" && /^\/withdrawals\/[^/]+$/.test(path) && !wReady && !wJob) {
    return fail(400, "invalid_withdrawal_request", "Invalid burn ID.");
  }
  if (!wReady && !wJob && !wCreate) return fail(404, "bridge_route_not_found", "Unknown bridge endpoint.");
  const unavailable = () => {
    if (!wReady) return fail(503, "solana_withdrawals_unavailable", UNAVAILABLE);
    json(res, 200, { ok: true, ready: false, message: UNAVAILABLE });
    return true;
  };
  if (solana && !withdrawViaRelay && !solanaOrigin) return unavailable();
  let body;
  if (wCreate) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return fail(403, "bridge_origin_required", "Same-origin request required."); }
    if (origin.host !== req.headers.host || req.headers["sec-fetch-site"] === "cross-site") return fail(403, "bridge_origin_mismatch", "Same-origin request required.");
    if (solana) {
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return fail(415, "invalid_media_type", "Send JSON.");
      if (req.headers["content-length"] === undefined) return fail(411, "length_required", "Content length is required.");
      if (Number(req.headers["content-length"]) > 256) return fail(413, "request_too_large", "Withdrawal request exceeds 256 bytes.");
    }
    try { body = await readJson(req, solana ? 256 : 4096); }
    catch { return fail(400, "invalid_withdrawal_request", "Invalid withdrawal request."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "burn_tx_id") || typeof body.burn_tx_id !== "string" || !/^[0-9a-f]{96}$/.test(body.burn_tx_id)) {
      return fail(400, "invalid_withdrawal_request", "Invalid withdrawal request.");
    }
  }
  try {
    // Through the relay on Fly; straight to the local payout service on the relay host.
    const localBase = solana ? solanaOrigin : WITHDRAW_SERVICE + "/api/bridge";
    const base = withdrawViaRelay ? String(bridgeProxyUrl).replace(/\/$/, "") + bridgePathPrefix : localBase;
    const response = await fetch(base + suffix, {
      method: req.method, redirect: "error", signal: AbortSignal.timeout(45000),
      headers: { Accept: "application/json", ...(withdrawViaRelay && proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}), ...(withdrawViaRelay && proxyOrigin ? { Origin: proxyOrigin } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (withdrawViaRelay && proxyToken && JSON.stringify(payload).includes(proxyToken)) throw new Error("Unsafe withdrawal response");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid withdrawal response");
    if (solana && wReady && (!response.ok || payload.ok !== true || typeof payload.ready !== "boolean")) return unavailable();
    json(res, response.status, payload);
    return true;
  } catch {
    if (solana && wReady) return unavailable();
    return fail(502, "withdrawal_service_unavailable", "Withdrawals are unavailable: the payout service is unreachable.");
  }
}
