import { createHash, createHmac, randomUUID } from "node:crypto";

function clean(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function deepResearchConfig(env = process.env) {
  const baseUrl = clean(env.CORBANU_DEEP_RESEARCH_BASE_URL, 1000);
  const secret = clean(env.CORBANU_TASKNODE_INTEGRATION_SECRET, 10_000);
  const allowlist = new Set(
    String(env.TASKNODE_DEEP_RESEARCH_ACCOUNT_IDS || "")
      .split(",")
      .map(value => clean(value, 180))
      .filter(Boolean),
  );
  let normalizedBaseUrl = baseUrl;
  while (normalizedBaseUrl.endsWith("/")) normalizedBaseUrl = normalizedBaseUrl.slice(0, -1);
  return { baseUrl: normalizedBaseUrl, secret, allowlist };
}

export function deepResearchAvailable({ accountId = "", env = process.env } = {}) {
  const config = deepResearchConfig(env);
  return Boolean(config.baseUrl && config.secret && config.allowlist.has(clean(accountId, 180)));
}

export async function startCorbanuDeepResearch({
  accountId,
  requestId,
  question,
  title = "",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callCorbanu({
    accountId,
    requestId,
    path: "/internal/v1/deep-research",
    method: "POST",
    body: { question, title },
    env,
    fetchImpl,
  });
}

export async function fetchCorbanuDeepResearch({
  accountId,
  gatewayJobId,
  requestId = `status_${randomUUID()}`,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callCorbanu({
    accountId,
    requestId,
    path: `/internal/v1/deep-research/${encodeURIComponent(gatewayJobId)}`,
    method: "GET",
    env,
    fetchImpl,
  });
}

export async function fetchCorbanuDeepResearchResult({
  accountId,
  gatewayJobId,
  requestId = `result_${randomUUID()}`,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callCorbanu({
    accountId,
    requestId,
    path: `/internal/v1/deep-research/${encodeURIComponent(gatewayJobId)}/result`,
    method: "GET",
    env,
    fetchImpl,
  });
}

export async function cancelCorbanuDeepResearch({
  accountId,
  gatewayJobId,
  requestId = `cancel_${randomUUID()}`,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callCorbanu({
    accountId,
    requestId,
    path: `/internal/v1/deep-research/${encodeURIComponent(gatewayJobId)}/cancel`,
    method: "POST",
    env,
    fetchImpl,
  });
}

async function callCorbanu({
  accountId = "",
  requestId = "",
  path,
  method,
  body,
  env,
  fetchImpl,
}) {
  const config = deepResearchConfig(env);
  const subject = clean(accountId, 180);
  const correlationId = clean(requestId, 180);
  if (!config.baseUrl || !config.secret) {
    throw Object.assign(new Error("deep_research_unavailable"), { status: 503 });
  }
  if (!subject || !config.allowlist.has(subject)) {
    throw Object.assign(new Error("deep_research_not_enabled"), { status: 403 });
  }
  if (!correlationId) {
    throw Object.assign(new Error("deep_research_request_id_required"), { status: 400 });
  }
  const serialized = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(serialized).digest("hex");
  const canonical = [timestamp, correlationId, method, path, digest, subject].join("\n");
  const signature = createHmac("sha256", config.secret).update(canonical).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Corbanu-Subject": subject,
        "X-Corbanu-Request-Id": correlationId,
        "X-Corbanu-Timestamp": timestamp,
        "X-Corbanu-Signature": signature,
      },
      body: serialized || undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error("deep_research_invalid_response"), { status: 502 });
    }
    if (!response.ok) {
      const detail = clean(payload?.error?.detail || payload?.error?.type || payload?.message, 500);
      throw Object.assign(new Error(detail || "deep_research_request_failed"), {
        status: response.status,
        payload,
      });
    }
    return { status: response.status, body: payload };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("deep_research_timeout"), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
