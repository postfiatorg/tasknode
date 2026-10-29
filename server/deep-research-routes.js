import {
  cancelCorbanuDeepResearch,
} from "./corbanu-deep-research.js";
import { chatResearchAccess, fetchChatResearch, startChatResearch } from "./chat-research-provider.js";
import { previewResearch } from "./research-preview.js";
import {
  attachDeepResearchGatewayJob,
  availableResearchCredit,
  createDeepResearchJob,
  getDeepResearchJob,
  updateDeepResearchJob,
} from "./repositories/deep-research.js";

function response(status, payload = {}) {
  return { status, body: { ok: status >= 200 && status < 300, ...payload } };
}

function text(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function normalizedStatus(value = "") {
  const status = text(value, 80).toLowerCase();
  if (status === "queued" || status === "starting") return "queued";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

async function create({ readJson, req, session }) {
  if (req.method !== "POST") return response(405, { error: "deep_research_method_not_allowed" });
  if (!session?.accountId) return response(401, { error: "deep_research_login_required" });
  const access = await chatResearchAccess({ accountId: session.accountId });
  if (!access.available) {
    return response(503, {
      error: "deep_research_unavailable",
      message: "Deep Research is temporarily unavailable.",
    });
  }
  const payload = await readJson(req, 128 * 1024);
  const question = text(payload?.question || payload?.message, 50_000);
  const title = text(payload?.title, 500);
  const conversationId = text(payload?.conversationId, 180);
  const requestId = text(payload?.requestId, 180);
  if (!question || !conversationId || !requestId) {
    return response(400, {
      error: "deep_research_input_required",
      message: "Deep Research requires a question, conversation, and request ID.",
    });
  }

  let local;
  try {
    local = await createDeepResearchJob({
      accountId: session.accountId,
      conversationId,
      question,
      title,
      requestId,
      provider: access.provider,
      maxCostUsd: payload.maxCostUsd,
      mode: payload.mode,
      routeToken: payload.routeToken,
    });
  } catch (error) {
    return response(Number(error?.status || 500), {
      error: error?.message || "deep_research_create_failed",
    });
  }
  if (local.job.gatewayJobId || ["completed", "failed", "cancelled"].includes(local.job.status)) {
    return response(202, { action: "deep_research_create", created: local.created, job: local.job, user: local.user, assistant: local.assistant });
  }

  try {
    const started = await startChatResearch({
      accountId: session.accountId,
      localJob: { ...local.job, mode: local.researchOptions?.mode, routeToken: local.researchOptions?.route_token },
      requestId,
      question,
      title,
    });
    const updated = await attachDeepResearchGatewayJob({
      accountId: session.accountId,
      jobId: local.job.id,
      gatewayJobId: started.id,
      status: local.job.provider === "goodalexander" && ["completed", "failed"].includes(started.status) ? "running" : started.status,
      stage: started.stage || "queued",
    });
    return response(202, {
      action: "deep_research_create",
      message: "Deep Research queued. You can leave and return to this chat.",
      user: local.user,
      assistant: updated?.assistant || local.assistant,
      job: updated?.job || local.job,
      privacy: started.corbanu,
    });
  } catch (error) {
    if (Number(error?.status || 500) < 500) {
      await updateDeepResearchJob({
        accountId: session.accountId,
        jobId: local.job.id,
        status: "failed",
        stage: "failed",
        error: error?.message || "Deep Research start failed.",
      });
    }
    return response(Number(error?.status || 502), {
      error: error?.message || "deep_research_start_failed",
      message: Number(error?.status) === 402 ? "Add credit in Settings → Billing. Research needs at least $0.50 available and enough for your maximum cost." : error.message === "route_preview_invalid" ? "Your research preview expired. Review the question and maximum again; no research was started." : "Deep Research could not be started. Retrying the same request is safe.",
      job: local.job,
      user: local.user,
      assistant: local.assistant,
    });
  }
}

async function refresh({ session, jobId }) {
  if (!session?.accountId) return response(401, { error: "deep_research_login_required" });
  const local = await getDeepResearchJob({ accountId: session.accountId, jobId });
  if (!local) return response(404, { error: "deep_research_job_not_found" });
  if (!local.job.gatewayJobId || ["completed", "failed", "cancelled"].includes(local.job.status)) {
    return response(200, local);
  }
  try {
    const remote = await fetchChatResearch({ accountId: session.accountId, job: local.job });
    const status = normalizedStatus(remote.status);
    const updated = await updateDeepResearchJob({
      accountId: session.accountId,
      jobId,
      status,
      stage: remote.stage || status,
      usage: remote.usage || {},
      progress: remote.progress || {},
      result: remote.result,
      error: remote.error || "",
    });
    return response(200, updated || local);
  } catch (error) {
    return response(Number(error?.status || 502), {
      error: error?.message || "deep_research_status_failed",
      message: "Deep Research status is temporarily unavailable.",
      ...local,
    });
  }
}

async function cancel({ req, session, jobId }) {
  if (req.method !== "POST") return response(405, { error: "deep_research_method_not_allowed" });
  if (!session?.accountId) return response(401, { error: "deep_research_login_required" });
  const local = await getDeepResearchJob({ accountId: session.accountId, jobId });
  if (!local) return response(404, { error: "deep_research_job_not_found" });
  if (local.job.provider === "goodalexander") {
    return response(409, { error: "deep_research_cannot_cancel", message: "This research job completes in the background and charges only incurred provider cost.", ...local });
  }
  if (!local.job.gatewayJobId) {
    const updated = await updateDeepResearchJob({
      accountId: session.accountId,
      jobId,
      status: "cancelled",
      stage: "cancelled",
    });
    return response(200, updated || local);
  }
  try {
    await cancelCorbanuDeepResearch({
      accountId: session.accountId,
      gatewayJobId: local.job.gatewayJobId,
    });
    const updated = await updateDeepResearchJob({
      accountId: session.accountId,
      jobId,
      status: "running",
      stage: "cancelling",
    });
    return response(202, updated || local);
  } catch (error) {
    return response(Number(error?.status || 502), {
      error: error?.message || "deep_research_cancel_failed",
      ...local,
    });
  }
}

export async function handleDeepResearchRoute({ json, readJson, req, res, session, url }) {
  if (url.pathname === "/api/deep-research/preview") {
    try {
      if (req.method !== "POST") throw Object.assign(new Error("deep_research_method_not_allowed"), { status: 405 });
      if (!session?.accountId) throw Object.assign(new Error("deep_research_login_required"), { status: 401 });
      const access = await chatResearchAccess({ accountId: session.accountId });
      if (!access.available || access.provider !== "goodalexander") throw Object.assign(new Error("research_preview_unavailable"), { status: 503 });
      const payload = await readJson(req, 128 * 1024);
      const preview = await previewResearch({ accountId: session.accountId, question: payload.question, mode: payload.mode });
      preview.availableCreditUsd = await availableResearchCredit(session.accountId);
      json(res, 200, { ok: true, preview }, { "cache-control": "no-store" });
    } catch (error) {
      json(res, error.status || 503, { ok: false, error: error.status ? error.message : "research_preview_unavailable",
        message: "Research preview is unavailable. No research has started; try again." }, { "cache-control": "no-store" });
    }
    return true;
  }
  if (url.pathname === "/api/deep-research/jobs") {
    const result = await create({ readJson, req, session });
    json(res, result.status, result.body);
    return true;
  }
  if (!url.pathname.startsWith("/api/deep-research/jobs/")) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = decodeURIComponent(parts[3] || "");
  const action = parts[4] || "";
  const result = action === "cancel"
    ? await cancel({ req, session, jobId })
    : req.method === "GET"
      ? await refresh({ session, jobId })
      : response(405, { error: "deep_research_method_not_allowed" });
  json(res, result.status, result.body);
  return true;
}
