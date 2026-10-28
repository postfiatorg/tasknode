import { authenticateResearchKey, createResearchKey, getResearchJob, listResearchKeys, revokeResearchKey } from "./repositories/research-gateway.js";
import { bindValidator, hasValidatorBinding, issueValidatorChallenge, listValidatorBindings, revokeValidatorBinding } from "./repositories/validator-bindings.js";
import { dailyAgreement, fetchValidatorReports, validatorError } from "./validator-identity.js";
import { publicResearchJob, refreshResearchJob, submitResearchJob } from "./research-gateway.js";

export async function handleValidatorResearchRoute({ json, readJson, req, res, session, url }) {
  const path = url.pathname;
  if (!path.startsWith("/api/validators") && !path.startsWith("/api/research/")) return false;
  const reply = (status, body) => { json(res, status, body, { "cache-control": "no-store" }); return true; };
  try {
    const gateway = path.startsWith("/api/research/v1/");
    let identity;
    if (gateway) {
      const authorization = String(req.headers.authorization || "");
      identity = await authenticateResearchKey(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    } else {
      if (!session?.accountId) throw validatorError("sign_in_required", 401);
      identity = { accountId: session.accountId };
    }
    const { accountId } = identity;
    if (path === "/api/validators" && req.method === "GET") {
      const bindings = await listValidatorBindings(accountId);
      const enriched = await Promise.all(bindings.map(async (binding) => {
        try { return { ...binding, uptime: dailyAgreement(await fetchValidatorReports(binding.master_public_key, binding.network)) }; }
        catch { return { ...binding, uptime: null, uptimeError: "Validator history is temporarily unavailable." }; }
      }));
      const now = new Date();
      return reply(200, { ok: true, bindings: enriched, badge: bindings.length ? "Validator" : null,
        nextRewardDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() });
    }
    if (path === "/api/validators/challenge" && req.method === "POST") return reply(201, { ok: true, ...await issueValidatorChallenge(accountId) });
    if (path === "/api/validators/bind" && req.method === "POST") {
      const payload = await readJson(req, 8192);
      const binding = await bindValidator({ accountId, masterPublicKey: payload.master_public_key, signature: payload.signature, challenge: payload.challenge });
      return reply(201, { ok: true, binding, badge: "Validator" });
    }
    const parts = path.split("/").filter(Boolean);
    if (parts[1] === "validators" && parts.length === 3 && req.method === "DELETE") {
      return reply(200, { ok: await revokeValidatorBinding(accountId, parts[2]) });
    }
    if (path === "/api/research/keys") {
      if (req.method === "GET") return reply(200, { ok: true, keys: await listResearchKeys(accountId) });
      if (req.method === "POST") return reply(201, { ok: true, ...await createResearchKey(accountId, (await readJson(req, 4096)).name) });
    }
    if (parts[2] === "keys" && parts.length === 4 && req.method === "DELETE") return reply(200, { ok: await revokeResearchKey(accountId, parts[3]) });
    if (["v1", "ui"].includes(parts[2]) && parts[3] === "jobs") {
      if (!gateway && !(await hasValidatorBinding(accountId))) throw validatorError("validator_required", 403);
      if (parts.length === 4 && req.method === "POST") {
        const payload = await readJson(req, 24000);
        const row = await submitResearchJob(identity, payload, req.headers["idempotency-key"]);
        return reply(202, publicResearchJob(row));
      }
      if ([5, 6].includes(parts.length) && req.method === "GET") {
        if (parts.length === 6 && parts[5] !== "result") return reply(404, { ok: false, error: "not_found" });
        const row = await refreshResearchJob(await getResearchJob(accountId, parts[4]));
        if (parts[5] === "result") {
          if (row.status !== "completed" || !row.result_json) throw validatorError("research_result_not_ready", 409);
          return reply(200, { ...row.result_json, job_id: row.id });
        }
        return reply(200, publicResearchJob(row));
      }
    }
    return reply(404, { ok: false, error: "not_found" });
  } catch (error) {
    return reply(error.status || 503, { ok: false, error: error.status ? error.message : "validator_research_unavailable" });
  }
}
