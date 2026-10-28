import { finishValidatorConnect, issueValidatorConnect, validatorConnectChallenge, validatorConnectStatus } from "./repositories/validator-connect.js";
import { dailyAgreement, fetchValidatorReports } from "./validator-identity.js";
import { invalidateCachedAppState } from "./app-state.js";

export async function handleValidatorConnectRoute({ json, readJson, req, res, session, url }) {
  if (!url.pathname.startsWith("/api/validators/connect")) return false;
  const reply = (status, body) => { json(res, status, body, { "cache-control": "no-store" }); return true; };
  try {
    const accountId = session?.accountId;
    if (url.pathname === "/api/validators/connect" && req.method === "POST") {
      if (!accountId) return reply(401, { ok: false, error: "sign_in_required" });
      return reply(201, { ok: true, ...await issueValidatorConnect(accountId) });
    }
    if (url.pathname === "/api/validators/connect/status" && req.method === "GET") {
      if (!accountId) return reply(401, { ok: false, error: "sign_in_required" });
      return reply(200, { ok: true, ...await validatorConnectStatus(accountId, url.searchParams.get("id")) });
    }
    if (url.pathname === "/api/validators/connect/challenge" && req.method === "POST") {
      const payload = await readJson(req, 1024);
      return reply(200, { ok: true, ...await validatorConnectChallenge(payload.token, accountId) });
    }
    if (url.pathname === "/api/validators/connect/complete" && req.method === "POST") {
      const payload = await readJson(req, 4096);
      const binding = await finishValidatorConnect({ token: payload.token, masterPublicKey: payload.master_public_key, signature: payload.signature, accountId });
      invalidateCachedAppState({ accountId: binding.account_id });
      let agreement = "unavailable";
      try {
        const uptime = dailyAgreement(await fetchValidatorReports(binding.master_public_key, binding.network));
        if (uptime.meanAgreement !== null) agreement = `${(uptime.meanAgreement * 100).toFixed(3)}%`;
      } catch { /* Binding succeeds even if history is temporarily unavailable. */ }
      return reply(200, { ok: true, binding, message: `Validator connected: ${binding.master_public_key} (${binding.network}), agreement ${agreement} over 30 days` });
    }
    return reply(405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    return reply(error.status || 503, { ok: false, error: error.status ? error.message : "validator_connect_unavailable" });
  }
}
