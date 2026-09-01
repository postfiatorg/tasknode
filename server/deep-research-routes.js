import {
  cancelCorbanuDeepResearch,
  deepResearchAvailable,
  fetchCorbanuDeepResearch,
  fetchCorbanuDeepResearchResult,
  startCorbanuDeepResearch,
} from "./corbanu-deep-research.js";
import {
  attachDeepResearchGatewayJob,
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
  if (!deepResearchAvailable({ accountId: session.accountId })) {
    return response(403, {
      error: "deep_research_not_enabled",
      message: "Deep Research is currently available to the operator canary only.",
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
    });
  } catch (error) {
    return response(Number(error?.status || 500), {
      error: error?.message || "deep_research_create_failed",
    });
  }
  if (local.job.gatewayJobId) {
    return response(202, { action: "deep_research_create", ...local });
  }

  try {
    const started = await startCorbanuDeepResearch({
      accountId: session.accountId,
      requestId,
      question,
      title,
    });
    const updated = await attachDeepResearchGatewayJob({
      accountId: session.accountId,
      jobId: local.job.id,
      gatewayJobId: started.body?.id,
      status: started.body?.status,
      stage: started.body?.stage || "queued",
    });
    return response(202, {
      action: "deep_research_create",
      message: "Deep Research queued. You can leave and return to this chat.",
      user: local.user,
      assistant: updated?.assistant || local.assistant,
      job: updated?.job || local.job,
      privacy: started.body?.corbanu,
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
      message: "Deep Research could not be started. Retrying the same request is safe.",
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
    const remote = await fetchCorbanuDeepResearch({
      accountId: session.accountId,
      gatewayJobId: local.job.gatewayJobId,
    });
    const status = normalizedStatus(remote.body?.status);
    let result = {};
    if (status === "completed") {
      const artifact = await fetchCorbanuDeepResearchResult({
        accountId: session.accountId,
        gatewayJobId: local.job.gatewayJobId,
      });
      result = artifact.body?.result || {};
    }
    const updated = await updateDeepResearchJob({
      accountId: session.accountId,
      jobId,
      status,
      stage: remote.body?.stage || status,
      usage: remote.body?.usage || {},
      progress: remote.body?.progress || {},
      result,
      error: remote.body?.error?.detail || "",
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
