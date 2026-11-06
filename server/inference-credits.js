import { createHash } from "node:crypto";
import { cleanConfig, providerBaseUrl, vercelCredentialName } from "./inference-policy.js";

// 2026-11-06 incident: the Vercel AI Gateway team ran out of credits and every
// task request failed with inference_http_402 for ~6.5 hours while readiness
// still reported the gateway as configured. This module owns three things:
// how a credit outage is recognised, what users are told about it, and the
// gateway credit balance (GET /v1/credits) that readiness and the task
// generation workers consult. Key material never leaves this module: balances
// are reported by the name of the environment variable that holds the key.

export const TASK_GENERATION_UNAVAILABLE_MESSAGE = "task generation is temporarily unavailable";
export const TASK_GENERATION_UNAVAILABLE_CODE = "task_generation_temporarily_unavailable";

// Gateway error types that mean "no spendable credit". quota_for_entity_exceeded
// is a team/project/key budget; the others are an empty balance.
const CREDIT_ERROR_TYPES = new Set(["insufficient_funds", "insufficient_credits", "insufficient_quota", "quota_for_entity_exceeded"]);
const CREDIT_ERROR_MARKERS = ["inference_http_402", ...CREDIT_ERROR_TYPES];

function lower(value) {
  return String(value ?? "").toLowerCase();
}

export function isInferenceCreditErrorText(value = "") {
  const text = lower(value);
  return Boolean(text) && CREDIT_ERROR_MARKERS.some((marker) => text.includes(marker));
}

export function isInferenceCreditError(error) {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (Number(current.status || current.statusCode) === 402) return true;
    if (CREDIT_ERROR_TYPES.has(lower(current.providerErrorType))) return true;
    if ([current.code, current.causeCode, current.message].some(isInferenceCreditErrorText)) return true;
    current = current.cause;
  }
  return typeof error === "string" && isInferenceCreditErrorText(error);
}

// The raw code stays in task_requests.last_error, metadata_json and logs; only
// what is served to users is replaced.
export function publicTaskGenerationError(value = "") {
  return isInferenceCreditErrorText(value) ? TASK_GENERATION_UNAVAILABLE_MESSAGE : value;
}

function boundedNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = cleanConfig(value);
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export function gatewayCreditConfig(env = process.env) {
  return {
    lowBalanceThresholdUsd: boundedNumber(env.TASKNODE_GATEWAY_CREDIT_LOW_BALANCE_USD, 25, { min: 0, max: 1_000_000 }),
    cacheTtlMs: boundedNumber(env.TASKNODE_GATEWAY_CREDIT_CACHE_TTL_MS, 60_000, { min: 0, max: 3_600_000 }),
    timeoutMs: boundedNumber(env.TASKNODE_GATEWAY_CREDIT_TIMEOUT_MS, 5_000, { min: 250, max: 30_000 }),
    readinessWaitMs: boundedNumber(env.TASKNODE_GATEWAY_CREDIT_READINESS_WAIT_MS, 1_000, { min: 0, max: 5_000 }),
  };
}

function digest(value = "") {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16);
}

// Distinct credentials (by env var name) behind a set of gateway models.
export function gatewayCredentialsForModels(models = [], env = process.env) {
  const byName = new Map();
  for (const model of models) {
    const credential = vercelCredentialName(env, model);
    if (!credential) continue;
    if (!byName.has(credential)) byName.set(credential, { credential, models: [] });
    if (model && !byName.get(credential).models.includes(model)) byName.get(credential).models.push(model);
  }
  return [...byName.values()];
}

const cache = new Map();

export function resetGatewayCreditCache() {
  cache.clear();
}

async function fetchGatewayCredits({ env, fetchImpl, credential, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(`${providerBaseUrl("vercel", env)}/credits`, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${cleanConfig(env[credential])}` },
        signal: controller.signal,
      });
    } catch {
      throw Object.assign(new Error("gateway_credits_unreachable"), { code: controller.signal.aborted ? "gateway_credits_timeout" : "gateway_credits_unreachable" });
    }
    if (!response.ok) throw Object.assign(new Error("gateway_credits_http_error"), { code: `gateway_credits_http_${response.status}` });
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(new Error("gateway_credits_invalid_json"), { code: "gateway_credits_invalid_json" }); }
    const balanceUsd = Number(body?.balance);
    const totalUsedUsd = Number(body?.total_used);
    if (body?.balance === undefined || body?.balance === null || !Number.isFinite(balanceUsd)) {
      throw Object.assign(new Error("gateway_credits_invalid_response"), { code: "gateway_credits_invalid_response" });
    }
    return { balanceUsd, totalUsedUsd: Number.isFinite(totalUsedUsd) ? totalUsedUsd : null };
  } finally {
    clearTimeout(timer);
  }
}

function refresh(entry, { env, fetchImpl, credential, timeoutMs, now }) {
  if (entry.inflight) return entry.inflight;
  entry.inflight = fetchGatewayCredits({ env, fetchImpl, credential, timeoutMs })
    .then((value) => { Object.assign(entry, { value, error: "", fetchedAt: now(), checkedAt: now() }); })
    .catch((error) => { Object.assign(entry, { error: error?.code || "gateway_credits_unavailable", checkedAt: now() }); })
    .finally(() => { entry.inflight = null; });
  return entry.inflight;
}

function credentialSnapshot({ credential, models }, entry, config, now) {
  const value = entry?.value || null;
  const stale = !value || Boolean(entry.error) || now - entry.fetchedAt > config.cacheTtlMs;
  const balanceUsd = value ? Number(value.balanceUsd.toFixed(4)) : null;
  const status = !value ? "unknown"
    : balanceUsd <= 0 ? "exhausted"
      : balanceUsd < config.lowBalanceThresholdUsd ? "low"
        : "ok";
  return {
    credential,
    usedBy: ["task_generation"],
    models,
    status,
    balanceUsd,
    totalUsedUsd: value?.totalUsedUsd === null || value?.totalUsedUsd === undefined ? null : Number(value.totalUsedUsd.toFixed(4)),
    lowBalance: status === "low" || status === "exhausted",
    checkedAt: entry?.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
    balanceFetchedAt: entry?.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
    stale,
    error: entry?.error || "",
  };
}

const severity = { exhausted: 3, low: 2, unknown: 1, ok: 0 };

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function warningFor(credentials, config) {
  const low = credentials.filter((item) => item.lowBalance);
  if (low.length) {
    return low.map((item) => item.status === "exhausted"
      ? `AI Gateway credits are exhausted for ${item.credential} (balance ${money(item.balanceUsd)}); task generation is paused until credits are added.`
      : `AI Gateway credit balance is low for ${item.credential}: ${money(item.balanceUsd)} is below the ${money(config.lowBalanceThresholdUsd)} warning threshold.`).join(" ");
  }
  const unknown = credentials.filter((item) => item.status === "unknown");
  return unknown.length ? `AI Gateway credit balance is unavailable for ${unknown.map((item) => item.credential).join(", ")}.` : "";
}

// Never throws and never waits longer than maxWaitMs. With a warm cache it
// answers immediately and refreshes in the background.
export async function gatewayCreditStatus({
  env = process.env,
  fetchImpl = fetch,
  models = [],
  force = false,
  maxWaitMs,
  now = Date.now,
} = {}) {
  const config = gatewayCreditConfig(env);
  const wait = maxWaitMs === undefined ? config.readinessWaitMs : Math.max(0, Number(maxWaitMs) || 0);
  const credentials = gatewayCredentialsForModels(models, env);
  const base = {
    source: "vercel_ai_gateway:/v1/credits",
    lowBalanceThresholdUsd: config.lowBalanceThresholdUsd,
    cacheTtlMs: config.cacheTtlMs,
  };
  if (!credentials.length) {
    return { ...base, configured: false, status: "not_configured", lowBalance: false, balanceUsd: null, warning: "", credentials: [] };
  }
  const pending = [];
  for (const target of credentials) {
    let baseUrl = "";
    try { baseUrl = providerBaseUrl("vercel", env); } catch { baseUrl = ""; }
    const key = `${baseUrl}|${target.credential}|${digest(cleanConfig(env[target.credential]))}`;
    if (!cache.has(key)) cache.set(key, { value: null, error: "", fetchedAt: 0, checkedAt: 0, inflight: null });
    const entry = cache.get(key);
    target.entry = entry;
    // Failures are cached for the same TTL so an unreadable key is not
    // re-requested on every readiness call.
    const fresh = entry.checkedAt && now() - entry.checkedAt <= config.cacheTtlMs;
    if (force || !fresh) {
      const running = refresh(entry, { env, fetchImpl, credential: target.credential, timeoutMs: config.timeoutMs, now });
      if (force || !entry.checkedAt) pending.push(running);
    }
  }
  if (pending.length && wait > 0) {
    let timer;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => { timer = setTimeout(resolve, wait); }),
    ]);
    clearTimeout(timer);
  }
  const at = now();
  const snapshots = credentials.map((target) => credentialSnapshot(target, target.entry, config, at));
  const status = snapshots.reduce((worst, item) => (severity[item.status] > severity[worst] ? item.status : worst), "ok");
  const known = snapshots.filter((item) => item.balanceUsd !== null);
  return {
    ...base,
    configured: true,
    status,
    lowBalance: snapshots.some((item) => item.lowBalance),
    // The smallest balance is the one that stops task generation first.
    balanceUsd: known.length ? Math.min(...known.map((item) => item.balanceUsd)) : null,
    warning: warningFor(snapshots, config),
    credentials: snapshots,
  };
}

// In-process credit-outage breaker shared by the task generation workers.
// A 402 opens it; while open no task request is sent to the provider. The
// worker re-checks the gateway balance on a backoff and closes the breaker as
// soon as credits are back. When the balance cannot be read, one probe
// request is admitted per re-check instead.
const outage = { active: false, since: "", lastCode: "", trips: 0, lastTripAt: 0, lastCheckAt: 0 };

export function taskGenerationCreditOutageState() {
  return { ...outage };
}

export function resetTaskGenerationCreditOutage() {
  Object.assign(outage, { active: false, since: "", lastCode: "", trips: 0, lastTripAt: 0, lastCheckAt: 0 });
}

export function noteTaskGenerationCreditOutage(error, { now = Date.now() } = {}) {
  if (!outage.active) outage.since = new Date(now).toISOString();
  outage.active = true;
  outage.trips += 1;
  outage.lastTripAt = now;
  outage.lastCheckAt = now;
  outage.lastCode = String(error?.causeCode || error?.code || error?.message || "inference_http_402").slice(0, 120);
  return taskGenerationCreditOutageState();
}

export function noteTaskGenerationInferenceSuccess() {
  if (outage.trips || outage.active) resetTaskGenerationCreditOutage();
}

export function taskGenerationCreditRecheckMs(trips = 1, env = process.env) {
  const base = boundedNumber(env.TASKNODE_TASKGEN_CREDIT_RECHECK_MS, 60_000, { min: 0, max: 15 * 60_000 });
  const max = boundedNumber(env.TASKNODE_TASKGEN_CREDIT_RECHECK_MAX_MS, 15 * 60_000, { min: base, max: 60 * 60_000 });
  return Math.min(max, base * (2 ** Math.max(0, Math.min(6, Number(trips || 1) - 1))));
}

export async function taskGenerationCreditGate({ env = process.env, fetchImpl = fetch, models = [], now = Date.now } = {}) {
  if (!outage.active) return { open: true, active: false };
  const at = now();
  const recheckMs = taskGenerationCreditRecheckMs(outage.trips, env);
  if (at - outage.lastCheckAt < recheckMs) {
    return { open: false, active: true, reason: "credit_recheck_pending", since: outage.since, nextCheckAt: new Date(outage.lastCheckAt + recheckMs).toISOString() };
  }
  outage.lastCheckAt = at;
  const credits = await gatewayCreditStatus({ env, fetchImpl, models, force: true, maxWaitMs: gatewayCreditConfig(env).timeoutMs + 250, now });
  if (credits.credentials.some((item) => item.status === "exhausted" && !item.error)) {
    return { open: false, active: true, reason: "gateway_credits_exhausted", since: outage.since, credits };
  }
  if (credits.credentials.length && credits.credentials.every((item) => ["ok", "low"].includes(item.status) && !item.error)) {
    const since = outage.since;
    outage.active = false;
    return { open: true, active: false, recovered: true, since, credits };
  }
  return { open: true, active: true, probe: true, reason: "gateway_credits_unreadable", since: outage.since, credits };
}
