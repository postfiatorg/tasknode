import { decisionsAvailable, fetchCorbanuDecision, startCorbanuDecision } from "./corbanu-decisions.js";
import { createDecisionJob, getDecisionJob, updateDecisionJob } from "./repositories/decisions.js";

const terminal = status => ["completed", "failed"].includes(status);
const error = (message, status) => Object.assign(new Error(message), { status });
const publicResult = ({ record: _record, ...result }) => result;

export function createDecisionRouteHandler(overrides = {}) {
  const deps = { decisionsAvailable, fetchCorbanuDecision, startCorbanuDecision, createDecisionJob, getDecisionJob, updateDecisionJob, ...overrides };
  async function start(local, accountId) {
    if (local.record.gateway_job_id || terminal(local.job.status)) return local;
    try {
      const remote = await deps.startCorbanuDecision({ accountId, requestId: local.record.request_id, input: local.record.input });
      const updated = await sync(local, remote.body, accountId);
      return { ...updated, user: local.user };
    } catch (failure) {
      // The remote create is idempotent. Retry its exact saved input/ID after a
      // lost response, including when the user returns after a browser reload.
      if (Number(failure.status || 502) >= 500 || failure.status === 429) {
        return { ...local, message: "Connecting to Corbanu. This request is saved and will reconnect automatically." };
      }
      return { ...await deps.updateDecisionJob({ accountId, jobId: local.job.id,
        remote: { status: "failed", stage: "starting", error: failure.message || "Decision could not start." } }), user: local.user };
    }
  }
  async function sync(local, remote, accountId) {
    let markdown = "";
    if (remote.status === "completed") {
      const result = await deps.fetchCorbanuDecision({ accountId, gatewayJobId: remote.id, artifact: "result" });
      markdown = result.body.markdown;
    }
    return deps.updateDecisionJob({ accountId, jobId: local.job.id, remote, markdown });
  }
  return async function handleDecisionRoute({ json, readJson, req, res, session, url }) {
    const root = "/api/decisions/jobs";
    if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      const accountId = session?.accountId;
      if (!accountId) throw error("decision_login_required", 401);
      if (url.pathname === root) {
        if (req.method !== "POST") throw error("decision_method_not_allowed", 405);
        if (!deps.decisionsAvailable({ accountId })) throw error("Decisions is temporarily unavailable.", 503);
        const body = await readJson(req, 256 * 1024);
        const { input, conversationId, requestId, includeContext = true } = body;
        if (Object.keys(body).some(key => !["input", "conversationId", "requestId", "includeContext"].includes(key))
          || typeof input !== "string" || !input.trim() || input.length > 60_000
          || typeof conversationId !== "string" || !conversationId.trim() || conversationId.length > 180
          || typeof requestId !== "string" || !requestId || requestId.length > 180
          || [...requestId].some(c => !"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:".includes(c))
          || typeof includeContext !== "boolean") throw error("decision_invalid_request", 400);
        const local = await deps.createDecisionJob({ accountId, conversationId: conversationId.trim(), input: input.trim(), requestId, includeContext });
        const started = await start(local, accountId);
        json(res, 202, { ok: true, ...publicResult(started) });
        return true;
      }
      if (req.method !== "GET") throw error("decision_method_not_allowed", 405);
      const parts = url.pathname.slice(root.length + 1).split("/");
      if (parts.length > 2 || !parts[0] || (parts.length === 2 && !["pdf", "packet"].includes(parts[1]))) throw error("decision_not_found", 404);
      const jobId = decodeURIComponent(parts[0]), artifact = parts[1] || "";
      let local = await deps.getDecisionJob({ accountId, jobId });
      if (!local) throw error("decision_not_found", 404);
      if (artifact) {
        if (!local.job.gatewayJobId) throw error("decision_not_ready", 409);
        const result = await deps.fetchCorbanuDecision({ accountId, gatewayJobId: local.job.gatewayJobId, artifact });
        const extension = artifact === "pdf" ? "pdf" : "json";
        res.setHeader("Content-Type", artifact === "pdf" ? "application/pdf" : "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="decision-${encodeURIComponent(jobId)}.${extension}"`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.writeHead(200);
        res.end(artifact === "pdf" ? result.body : JSON.stringify(result.body));
        return true;
      }
      if (!local.job.gatewayJobId) local = await start(local, accountId);
      else if (!terminal(local.job.status)) {
        const remote = await deps.fetchCorbanuDecision({ accountId, gatewayJobId: local.job.gatewayJobId });
        local = await sync(local, remote.body, accountId);
      }
      json(res, 200, { ok: true, ...publicResult(local) });
    } catch (failure) {
      json(res, Number(failure.status || 502), { ok: false, error: failure.message || "decision_request_failed", message: failure.message || "Decision status is temporarily unavailable." });
    }
    return true;
  };
}

export const handleDecisionRoute = createDecisionRouteHandler();
