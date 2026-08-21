import { usageSummary } from "./repositories/chat-billing.js";
import {
  cancelContextRewriteJob,
  contextRewriteStatus,
  createContextRewriteJob,
  getContextRewriteArtifact,
  getContextRewriteAssistantMessage,
  getContextRewriteJob,
} from "./repositories/context-rewrite.js";
import {
  contextRewriteEstimateUsd,
  contextRewriteProviderConfigured,
  contextRewriteModels,
} from "./context-rewrite-provider.js";

function response(status, payload = {}) {
  return {
    status,
    body: {
      ok: status >= 200 && status < 300,
      ...payload,
    },
  };
}

function safeText(value = "", max = 12000) {
  return String(value || "").trim().slice(0, max);
}

function estimatePayload() {
  const models = contextRewriteModels();
  return {
    billingModel: "usage_based",
    currency: "USD",
    estimatedUsd: contextRewriteEstimateUsd(),
    scorerRuns: {
      glm: Number(process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL || 3),
      deepseek: Number(process.env.CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL || 3),
    },
    webSearches: 2,
    rewriteRuns: {
      draft: 1,
      polish: 1,
      total: 2,
    },
    finalRewriteRuns: 2,
    models,
    policy: "This is an estimate only. Final billing is based on provider usage returned after execution.",
    requiresConfirmation: true,
    warning: "Context Rewrite runs multiple model calls and web research. The charge may be higher than other tool calls.",
  };
}

function publicUsage(summary = {}) {
  return {
    billingModel: "usage_based",
    currency: "USD",
    currentSpendUsd: summary.currentSpendUsd || 0,
    currentCreditUsd: summary.currentCreditUsd || 0,
    availableCreditUsd: summary.availableCreditUsd || 0,
    ledgerEntryCount: summary.ledgerEntryCount || 0,
  };
}

async function createJob({ readJson, req, session }) {
  if (req.method !== "POST") {
    return response(405, {
      error: "context_rewrite_method_not_allowed",
      action: "context_rewrite_create",
      message: "Context Rewrite jobs require POST.",
    });
  }
  if (!session?.accountId) {
    return response(401, {
      error: "context_rewrite_login_required",
      action: "context_rewrite_create",
      message: "Sign in before starting Context Rewrite.",
    });
  }
  const status = contextRewriteStatus();
  if (!status.enabled) {
    return response(409, {
      error: "context_rewrite_database_required",
      action: "context_rewrite_create",
      message: "Context Rewrite requires the Postgres-backed task node database.",
      actionRequired: "Run the database migrations and enable TASKNODE_DATABASE_ENABLED.",
      status,
    });
  }
  if (!contextRewriteProviderConfigured()) {
    return response(409, {
      error: "context_rewrite_provider_not_configured",
      action: "context_rewrite_create",
      message: "Context Rewrite requires Ambient provider configuration.",
      actionRequired: "Configure AMBIENT_API_KEY or enable the mock provider for local smoke tests.",
      estimate: estimatePayload(),
    });
  }

  const payload = await readJson(req, 1_200_000);
  const instructionText = safeText(payload?.message || payload?.instruction || payload?.instructions || "", 12000);
  const conversationId = safeText(payload?.conversationId || "dev", 180) || "dev";
  if (!instructionText) {
    return response(400, {
      error: "context_rewrite_instruction_required",
      action: "context_rewrite_create",
      message: "Context Rewrite requires rewrite instructions.",
      actionRequired: "Describe what the full rewrite should preserve, change, or optimize for.",
      estimate: estimatePayload(),
    });
  }

  const estimate = estimatePayload();
  const usage = await usageSummary({ accountId: session.accountId, conversationId });
  if (Number(usage.availableCreditUsd || 0) < Number(estimate.estimatedUsd || 0)) {
    return response(402, {
      error: "context_rewrite_credit_required",
      action: "context_rewrite_create",
      message: "Available chat credit is too low for Context Rewrite.",
      actionRequired: "Top up the account balance before starting this multi-call rewrite.",
      estimate,
      usage: publicUsage(usage),
    });
  }

  const created = await createContextRewriteJob({
    accountId: session.accountId,
    conversationId,
    instructionText,
    estimateCostUsd: estimate.estimatedUsd,
  });
  return response(202, {
    action: "context_rewrite_create",
    message: "Context Rewrite queued. This can take a while; check back in this tab.",
    estimate,
    usage: publicUsage(usage),
    ...created,
  });
}

async function readJob({ session, url }) {
  if (!session?.accountId) {
    return response(401, {
      error: "context_rewrite_login_required",
      message: "Sign in before reading Context Rewrite jobs.",
    });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = decodeURIComponent(parts[4] || "");
  const job = await getContextRewriteJob({ accountId: session.accountId, jobId });
  if (!job) {
    return response(404, {
      error: "context_rewrite_job_not_found",
      message: "Context Rewrite job not found.",
    });
  }
  const assistant = job.assistantMessageId
    ? await getContextRewriteAssistantMessage({ accountId: session.accountId, messageId: job.assistantMessageId })
    : null;
  return response(200, {
    action: "context_rewrite_read",
    job,
    assistant,
  });
}

async function readArtifact({ session, url }) {
  if (!session?.accountId) {
    return response(401, {
      error: "context_rewrite_login_required",
      message: "Sign in before reading Context Rewrite artifacts.",
    });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = decodeURIComponent(parts[4] || "");
  const artifact = await getContextRewriteArtifact({ accountId: session.accountId, jobId });
  if (!artifact) {
    return response(404, {
      error: "context_rewrite_artifact_not_found",
      message: "Context Rewrite artifact not found.",
    });
  }
  return response(200, {
    action: "context_rewrite_artifact",
    artifact,
  });
}

async function cancelJob({ req, session, url }) {
  if (req.method !== "POST") {
    return response(405, {
      error: "context_rewrite_method_not_allowed",
      message: "Context Rewrite cancel requires POST.",
    });
  }
  if (!session?.accountId) {
    return response(401, {
      error: "context_rewrite_login_required",
      message: "Sign in before cancelling Context Rewrite jobs.",
    });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = decodeURIComponent(parts[4] || "");
  const job = await cancelContextRewriteJob({ accountId: session.accountId, jobId });
  if (!job) {
    return response(404, {
      error: "context_rewrite_job_not_found",
      message: "Context Rewrite job not found.",
    });
  }
  return response(200, {
    action: "context_rewrite_cancel",
    message: "Context Rewrite cancelled.",
    job,
  });
}

export async function handleContextRewriteRoute({ json, readJson, req, res, session, url }) {
  if (url.pathname === "/api/context/rewrite/jobs") {
    const result = await createJob({ readJson, req, session });
    json(res, result.status, result.body);
    return true;
  }

  if (!url.pathname.startsWith("/api/context/rewrite/jobs/")) return false;

  const parts = url.pathname.split("/").filter(Boolean);
  const action = parts[5] || "";
  let result;
  if (action === "artifact") {
    result = await readArtifact({ session, url });
  } else if (action === "cancel") {
    result = await cancelJob({ req, session, url });
  } else if (req.method === "GET") {
    result = await readJob({ session, url });
  } else {
    result = response(405, {
      error: "context_rewrite_method_not_allowed",
      message: "Unsupported Context Rewrite job method.",
    });
  }
  json(res, result.status, result.body);
  return true;
}
