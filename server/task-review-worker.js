import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Wallet } from "xrpl";
import { pinContextIpfsJson } from "./context-ipfs.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { query, transaction } from "./db/pool.js";
import { getTaskDetail } from "./repositories/tasks.js";
import { encryptTasknodePayload } from "./task-payloads.js";
import { moneySeedFromEnv } from "./production-guards.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";
import { signTaskTransition } from "./task-transition-signatures.js";

const TASK_POINTER_SCHEMA = 1;
const VERIFICATION_PROMPT_PATH = "task_engine/verification_request_v1.md";
const VERIFICATION_PROMPT_VERSION = "verification_request_v1";
const REWARD_PROMPT_PATH = "task_engine/reward_scoring_v1.md";
const REWARD_PROMPT_VERSION = "reward_scoring_v1";
const PFT_DROPS_PER_PFT = 1_000_000;
const REWARD_CARRIER_DROPS = "1";
const URL_EXCERPT_MAX_CHARS = 6000;
const URL_FETCH_TIMEOUT_MS = 8000;
const URL_REDIRECT_MAX_HOPS = 5;
const TASK_REVIEW_USER_AGENT = "TaskNodeOfficialTaskReview/0.1";

const verificationResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "task_verification_request",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assessment: { type: "string", enum: ["legitimate", "suspicious", "incomplete"] },
        verification_ask: { type: "string" },
        verification_type: { type: "string", enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"] },
        reason: { type: "string" },
      },
      required: ["assessment", "verification_ask", "verification_type", "reason"],
    },
  },
};

const rewardResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "task_reward_score",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: { type: "string", enum: ["reward", "partial_reward", "reject"] },
        reward_pft: { type: "string" },
        completion: { type: "integer", minimum: 0, maximum: 100 },
        evidence_quality: { type: "integer", minimum: 0, maximum: 100 },
        reason: { type: "string" },
        user_feedback: { type: "string" },
      },
      required: ["decision", "reward_pft", "completion", "evidence_quality", "reason", "user_feedback"],
    },
  },
};

let timer = null;

function workerClaimStaleSeconds() {
  const parsed = Number(process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS || 900);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 900, 300), 3600);
}

function taskReviewPublisherPermission({
  env = process.env,
  enabled = env.TASKNODE_TASK_REVIEW_WORKER_ENABLED === "true",
} = {}) {
  if (!enabled) return { enabled: false, reason: "disabled" };
  const tasknodeEnv = String(env.TASKNODE_ENV || env.NODE_ENV || "").trim().toLowerCase();
  if (tasknodeEnv === "production") return { enabled: true, reason: "production" };
  if (env.TASKNODE_TASK_REVIEW_ALLOW_NON_PRODUCTION === "true") {
    return { enabled: true, reason: "non_production_override" };
  }
  return { enabled: false, reason: "non_production_publisher_blocked" };
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function authoritySeed(env = process.env) {
  return safeText(
    env.TASKNODE_AUTHORITY_SEED ||
      env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

function rewardSeed(env = process.env) {
  return moneySeedFromEnv({
    env,
    primaryKeys: ["TASKNODE_REWARD_SEED"],
    fallbackKeys: [
      "TASKNODE_ALLOCATION_SEED",
      "TASKNODE_AUTHORITY_SEED",
      "TASKNODE_SERVICE_SEED",
      "TASKNODE_PFT_FAUCET_SEED",
      "FAUCET_SEED",
    ],
  }).seed;
}

function walletFromSeed(seed, code) {
  if (!seed) throw new Error(code);
  return Wallet.fromSeed(seed);
}

function parseJsonObject(text = "") {
  return JSON.parse(String(text || "").trim());
}

function clampInteger(value, fallback = 0, min = 0, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeReward(value, offerPft = 0) {
  const parsed = Number(value);
  const offer = Number(offerPft);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // The model-supplied reward is scored over untrusted user evidence. Only honor it
  // when a positive authority offer exists to clamp against; without a trusted upper
  // bound, fail closed to 0 rather than paying an unbounded model-chosen amount.
  if (Number.isFinite(offer) && offer > 0) return Math.min(parsed, offer);
  return 0;
}

function eventSchema(event = {}) {
  return safeText(event?.schema || safeObject(event?.rawPayload).schema, 120);
}

function latestRewardPaymentEvent(detail = {}) {
  const timeline = Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [];
  return timeline.filter((event) => eventSchema(event) === "pf.reward.v1").pop() || null;
}

function rewardPaymentGuard(metadata = {}) {
  return safeObject(metadata?.reward_payment_guard);
}

function rewardPaymentGuardStatus(guard = {}) {
  return safeText(guard.status, 80).toLowerCase();
}

function rewardPaymentGuardBlocksRetry(guard = {}) {
  return ["submitting", "submitted", "submit_unknown"].includes(rewardPaymentGuardStatus(guard));
}

function rewardPaymentGuardPayload({ taskId = "", rewardPayload = {}, rewardPft = 0 } = {}) {
  const now = new Date().toISOString();
  return {
    status: "submitting",
    task_id: safeText(taskId, 180),
    event_id: safeText(rewardPayload.event_id, 180),
    reward_pft: Number(rewardPft || 0).toFixed(2),
    payload_digest: sha256(rewardPayload),
    created_at: now,
    updated_at: now,
  };
}

async function claimRewardPaymentGuard({ taskId = "", rewardPayload = {}, rewardPft = 0 } = {}) {
  const guard = rewardPaymentGuardPayload({ taskId, rewardPayload, rewardPft });
  const result = await query(
    `
      UPDATE task_projections
      SET metadata_json = jsonb_set(
            COALESCE(metadata_json, '{}'::jsonb),
            '{reward_payment_guard}',
            $2::jsonb,
            true
          ),
          updated_at = now()
      WHERE task_id = $1
        AND (
          metadata_json->'reward_payment_guard' IS NULL
          OR COALESCE(metadata_json->'reward_payment_guard'->>'status', '') = ''
          OR lower(COALESCE(metadata_json->'reward_payment_guard'->>'status', '')) NOT IN (
            'submitting',
            'submitted',
            'submit_unknown'
          )
        )
      RETURNING metadata_json->'reward_payment_guard' AS guard
    `,
    [taskId, JSON.stringify(guard)]
  );
  if (result.rows[0]) return { claimed: true, guard: safeObject(result.rows[0].guard) };

  const existing = await query(
    "SELECT metadata_json->'reward_payment_guard' AS guard FROM task_projections WHERE task_id = $1 LIMIT 1",
    [taskId]
  );
  return { claimed: false, guard: safeObject(existing.rows[0]?.guard) };
}

async function updateRewardPaymentGuard({ taskId = "", patch = {} } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      "SELECT metadata_json->'reward_payment_guard' AS guard FROM task_projections WHERE task_id = $1 FOR UPDATE",
      [taskId]
    );
    const guard = safeObject(current.rows[0]?.guard);
    if (!current.rows[0] || !Object.keys(guard).length) return null;
    const next = {
      ...guard,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    await client.query(
      `
        UPDATE task_projections
        SET metadata_json = jsonb_set(
              COALESCE(metadata_json, '{}'::jsonb),
              '{reward_payment_guard}',
              $2::jsonb,
              true
            ),
            updated_at = now()
        WHERE task_id = $1
      `,
      [taskId, JSON.stringify(next)]
    );
    return next;
  });
}

async function markRewardPaymentSubmitted({ taskId = "", reward = {} } = {}) {
  return updateRewardPaymentGuard({
    taskId,
    patch: {
      status: "submitted",
      submitted_at: new Date().toISOString(),
      tx_hash: safeText(reward.txHash, 120),
      cid: safeText(reward.cid, 240),
    },
  });
}

async function markRewardPaymentSubmitUnknown({ taskId = "", error = "" } = {}) {
  return updateRewardPaymentGuard({
    taskId,
    patch: {
      status: "submit_unknown",
      last_error: safeText(error, 1000),
    },
  });
}

function pftToDrops(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return String(Math.round(parsed * PFT_DROPS_PER_PFT));
}

function eventPayloads(detail = {}) {
  return (Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [])
    .map((event) => safeObject(event?.rawPayload))
    .filter((payload) => payload.schema);
}

function timelineEvents(detail = {}) {
  return Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [];
}

function eventRawPayload(event = {}) {
  return safeObject(event?.rawPayload || event?.payload || event?.payloadJson);
}

function timelineEventPublishedRef(event = {}) {
  return {
    txHash: safeText(event.txHash || event.sourceTxHash || event.tx_hash || "", 120),
    cid: safeText(event.cid || event.sourceCid || event.source_cid || "", 240),
  };
}

function isVerificationRequestPayload(payload = {}) {
  return (
    payload.schema === "pf.task.verification_request.v1" ||
    (
      payload.schema === "pf.task.update.v1" &&
      safeText(payload.transition || payload.status_after || payload.status, 80) === "verification_requested"
    )
  );
}

function isRewardReviewPayload(payload = {}) {
  return payload.schema === "pf.reward.v1";
}

function latestTimelineEvent(detail = {}, predicate = () => false) {
  const events = timelineEvents(detail);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(eventRawPayload(event))) return event;
  }
  return null;
}

function existingVerificationRequestEvent(detail = {}) {
  return latestTimelineEvent(detail, isVerificationRequestPayload);
}

function existingRewardReviewEvent(detail = {}) {
  return latestTimelineEvent(detail, isRewardReviewPayload);
}

function latestPayloadBySchema(payloads = [], schemas = []) {
  const wanted = new Set(schemas);
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    if (wanted.has(payloads[index]?.schema)) return payloads[index];
  }
  return null;
}

function latestVerificationRequestPayload(payloads = []) {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (payload?.schema === "pf.task.verification_request.v1") return payload;
    if (
      payload?.schema === "pf.task.update.v1" &&
      safeText(payload.transition || payload.status, 80) === "verification_requested"
    ) {
      return payload;
    }
  }
  return null;
}

function hostnameValue(value = "") {
  return safeText(value, 260).toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(address = "") {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address = "") {
  const normalized = hostnameValue(address);
  if (!normalized || normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("ff")) return true;
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

function isPrivateIpAddress(address = "") {
  const family = isIP(hostnameValue(address));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

export function isSafeEvidenceUrlLiteral(url = "") {
  try {
    const parsed = new URL(safeText(url, 1000));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, reason: "unsupported_protocol" };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: "credentials_not_allowed" };
    }
    const hostname = hostnameValue(parsed.hostname);
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { ok: false, reason: "localhost_not_allowed" };
    }
    if (isIP(hostname) && isPrivateIpAddress(hostname)) {
      return { ok: false, reason: "private_ip_not_allowed" };
    }
    return { ok: true, url: parsed };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

async function resolveSafeEvidenceUrl(url = "", { lookupFn = lookup } = {}) {
  const literal = isSafeEvidenceUrlLiteral(url);
  if (!literal.ok) return literal;
  const hostname = hostnameValue(literal.url.hostname);
  if (!isIP(hostname)) {
    try {
      const addresses = await lookupFn(hostname, { all: true });
      if (!addresses.length) return { ok: false, reason: "dns_no_addresses" };
      if (addresses.some((entry) => isPrivateIpAddress(entry.address))) {
        return { ok: false, reason: "dns_private_ip_not_allowed" };
      }
    } catch {
      return { ok: false, reason: "dns_lookup_failed" };
    }
  }
  return literal;
}

function headerValue(headers, name) {
  const getter = headers?.get;
  return typeof getter === "function" ? safeText(getter.call(headers, name) || "", 2000) : "";
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codepoint = Number.parseInt(hex, 16);
      return Number.isFinite(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
    })
    .replace(/&#(\d+);/g, (_match, decimal) => {
      const codepoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
    });
}

function collapseWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripHtmlToText(html = "") {
  const withoutBoilerplate = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav\s*>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header\s*>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer\s*>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form\s*>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeHtmlEntities(withoutBoilerplate));
}

function extractHtmlTitle(html = "") {
  const raw = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "";
  return safeText(collapseWhitespace(decodeHtmlEntities(raw.replace(/<[^>]+>/g, " "))), 300);
}

function isHtmlResponse(response, text = "") {
  const contentType = headerValue(response?.headers, "content-type").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) return true;
  if (contentType) return false;
  return /^\s*<!doctype html\b/i.test(text) || /^\s*<html\b/i.test(text);
}

async function fetchOnceWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...options,
      headers: {
        "user-agent": TASK_REVIEW_USER_AGENT,
        ...(options.headers || {}),
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timerId);
  }
}

async function fetchWithSafeRedirects(url = "", {
  fetchImpl = fetch,
  lookupFn = lookup,
  maxRedirects = URL_REDIRECT_MAX_HOPS,
} = {}) {
  const value = safeText(url, 1000);
  let safety = await resolveSafeEvidenceUrl(value, { lookupFn });
  if (!safety.ok) {
    return {
      status: "blocked",
      url: value,
      error: safety.reason || "evidence_url_not_allowed",
    };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchOnceWithTimeout(fetchImpl, safety.url.href);
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location) {
        return {
          status: "redirect_not_followed",
          url: safety.url.href,
          http_status: response.status,
          location: "",
        };
      }
      if (hop >= maxRedirects) {
        return {
          status: "too_many_redirects",
          url: safety.url.href,
          http_status: response.status,
          location,
        };
      }
      const redirectTarget = new URL(location, safety.url.href).href;
      const nextSafety = await resolveSafeEvidenceUrl(redirectTarget, { lookupFn });
      if (!nextSafety.ok) {
        return {
          status: "blocked",
          url: redirectTarget,
          http_status: response.status,
          error: nextSafety.reason || "evidence_url_not_allowed",
        };
      }
      safety = nextSafety;
      continue;
    }
    return {
      status: "fetched",
      url: safety.url.href,
      response,
    };
  }

  return {
    status: "too_many_redirects",
    url: safety.url.href,
  };
}

async function responseExcerpt({ response, url, sourceUrl = "" } = {}) {
  const text = await response.text();
  const html = isHtmlResponse(response, text);
  const title = html ? extractHtmlTitle(text) : "";
  const excerpt = html
    ? safeText(stripHtmlToText(text), URL_EXCERPT_MAX_CHARS)
    : safeText(text, URL_EXCERPT_MAX_CHARS);
  return {
    status: response.ok ? "extracted" : "http_error",
    url,
    ...(sourceUrl && sourceUrl !== url ? { source_url: sourceUrl } : {}),
    http_status: response.status,
    title,
    excerpt,
  };
}

function parseGistUrl(url = "") {
  try {
    const parsed = new URL(safeText(url, 1000));
    if (hostnameValue(parsed.hostname) !== "gist.github.com") return null;
    const [user, id] = parsed.pathname.split("/").filter(Boolean);
    if (!user || !id) return null;
    return { user, id };
  } catch {
    return null;
  }
}

async function gistApiExcerpt({ id, sourceUrl, fetchImpl, lookupFn }) {
  const apiUrl = `https://api.github.com/gists/${encodeURIComponent(id)}`;
  const fetched = await fetchWithSafeRedirects(apiUrl, { fetchImpl, lookupFn });
  if (fetched.status !== "fetched") return fetched;
  const bodyText = await fetched.response.text();
  if (!fetched.response.ok) {
    return {
      status: "http_error",
      url: fetched.url,
      source_url: sourceUrl,
      http_status: fetched.response.status,
      title: "",
      excerpt: safeText(bodyText, URL_EXCERPT_MAX_CHARS),
    };
  }
  try {
    const body = JSON.parse(bodyText);
    const files = Object.values(safeObject(body.files));
    const excerpt = files
      .map((file) => {
        const filename = safeText(file?.filename || "gist-file", 160);
        const content = safeText(file?.content || "", URL_EXCERPT_MAX_CHARS);
        return content ? `# ${filename}\n${content}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    return {
      status: "extracted",
      url: fetched.url,
      source_url: sourceUrl,
      http_status: fetched.response.status,
      title: safeText(body.description || `GitHub Gist ${id}`, 300),
      excerpt: safeText(excerpt, URL_EXCERPT_MAX_CHARS),
    };
  } catch (error) {
    return {
      status: "fetch_failed",
      url: fetched.url,
      source_url: sourceUrl,
      error: `gist_api_parse_failed:${safeText(error?.message || error, 300)}`,
    };
  }
}

async function fetchGistExcerpt({ sourceUrl, gist, fetchImpl, lookupFn }) {
  const rawUrl = `https://gist.githubusercontent.com/${encodeURIComponent(gist.user)}/${encodeURIComponent(gist.id)}/raw`;
  const fetched = await fetchWithSafeRedirects(rawUrl, { fetchImpl, lookupFn });
  if (fetched.status === "fetched") {
    if (fetched.response.ok) {
      const rawResult = await responseExcerpt({ response: fetched.response, url: fetched.url, sourceUrl });
      return {
        ...rawResult,
        title: rawResult.title || `GitHub Gist ${gist.user}/${gist.id}`,
      };
    }
    return gistApiExcerpt({ id: gist.id, sourceUrl, fetchImpl, lookupFn });
  }
  if (fetched.status === "http_error" || fetched.status === "fetch_failed") {
    return gistApiExcerpt({ id: gist.id, sourceUrl, fetchImpl, lookupFn });
  }
  return fetched;
}

export async function fetchUrlExcerpt(url = "", { fetchImpl = fetch, lookupFn = lookup } = {}) {
  const value = safeText(url, 1000);
  if (!value) return null;
  const gist = parseGistUrl(value);
  try {
    if (gist) {
      return await fetchGistExcerpt({ sourceUrl: value, gist, fetchImpl, lookupFn });
    }
    const fetched = await fetchWithSafeRedirects(value, { fetchImpl, lookupFn });
    if (fetched.status !== "fetched") return fetched;
    return responseExcerpt({ response: fetched.response, url: fetched.url });
  } catch (error) {
    return {
      status: "fetch_failed",
      url: value,
      error: safeText(error?.message || error, 500),
    };
  }
}

async function processedEvidenceFromPayload(payload = {}) {
  const evidence = safeObject(payload.evidence || payload.submission || payload.response);
  const evidenceItems = Array.isArray(payload.evidence_items)
    ? payload.evidence_items
    : Array.isArray(evidence.evidence_items)
      ? evidence.evidence_items
      : [];
  const items = evidenceItems.length > 0 ? evidenceItems : [evidence];
  const artifacts = [];
  for (const item of items.slice(0, 2)) {
    const artifactType = safeText(item?.artifact_type || payload.artifact_type || payload.evidence_type || "text", 80);
    const value = safeText(item?.value || "", 120000);
    artifacts.push({
      artifact_type: artifactType || "text",
      status: item?.file?.processing?.status || "provided",
      source: {
        file_name: item?.file?.name || "",
        mime_type: item?.file?.mime_type || "",
        size: item?.file?.size || null,
        sha256: item?.file?.sha256 || "",
        url: artifactType === "url" ? value : "",
      },
      excerpt: safeText(item?.file?.description || item?.file?.text || value || item?.notes || payload.response_text, 6000),
      processing: safeObject(item?.file?.processing),
    });
    if (artifactType === "url") {
      const fetched = await fetchUrlExcerpt(value);
      if (fetched) artifacts.push({ artifact_type: "url", ...fetched });
    }
  }
  return {
    schema: "tasknode.processed_evidence.v1",
    artifacts,
  };
}

function artifactUrl(artifact = {}) {
  return safeText(artifact.url || artifact.source_url || safeObject(artifact.source).url || "", 1000);
}

function artifactLabel(artifact = {}, fallback = "Evidence artifact") {
  const source = safeObject(artifact.source);
  const url = artifactUrl(artifact);
  if (artifact.title) return safeText(artifact.title, 240);
  if (source.file_name) return safeText(source.file_name, 240);
  if (url) {
    try {
      const parsed = new URL(url);
      return safeText(parsed.hostname, 240);
    } catch {
      return safeText(url, 240);
    }
  }
  return fallback;
}

function classifyProcessedEvidenceArtifact(artifact = {}, {
  phase = "",
  fetchedUrls = new Set(),
} = {}) {
  const type = safeText(artifact.artifact_type || artifact.artifactType || "text", 80) || "text";
  const status = safeText(artifact.status, 80);
  const url = artifactUrl(artifact);
  const digestInput = url || artifact.excerpt || artifactLabel(artifact);
  if (url && fetchedUrls.has(url) && status === "provided") return null;
  if (url) {
    const verified = status === "extracted" || artifact.ok === true;
    const failed = ["blocked", "fetch_failed", "http_error", "too_many_redirects", "redirect_not_followed"].includes(status) || artifact.ok === false;
    return {
      phase,
      artifact_type: type,
      resolver: type === "github_commit" ? "github_commit" : "safe_url",
      status: verified ? "verified" : failed ? "unverified" : "self_attested",
      label: artifactLabel(artifact, "URL evidence"),
      url,
      value_digest: digestInput ? `sha256:${sha256(digestInput)}` : "",
      reason: verified
        ? "Public URL content was fetched through the SSRF-safe evidence resolver."
        : failed
          ? safeText(artifact.error || `URL evidence could not be independently fetched (${status || "unknown"}).`, 300)
          : "URL was submitted but no resolver result was available in processed evidence.",
    };
  }
  return {
    phase,
    artifact_type: type,
    resolver: "text_or_file_claim",
    status: "self_attested",
    label: artifactLabel(artifact, type === "file" ? "File evidence" : "Text evidence"),
    value_digest: digestInput ? `sha256:${sha256(digestInput)}` : "",
    reason: "Evidence was submitted as text/file material without an independently resolvable public artifact.",
  };
}

function buildRewardEvidenceEvaluationContext({ initial = {}, verification = {} } = {}) {
  const groups = [
    ["initial_submission", initial],
    ["verification_response", verification],
  ];
  const artifactVerdicts = [];
  for (const [phase, packet] of groups) {
    const artifacts = safeArray(safeObject(packet).artifacts).slice(0, 12);
    const fetchedUrls = new Set(
      artifacts
        .filter((artifact) => artifactUrl(artifact) && artifact.status && artifact.status !== "provided")
        .map(artifactUrl)
    );
    for (const artifact of artifacts) {
      const verdict = classifyProcessedEvidenceArtifact(artifact, { phase, fetchedUrls });
      if (verdict) artifactVerdicts.push(verdict);
    }
  }
  const counts = artifactVerdicts.reduce(
    (acc, verdict) => {
      if (verdict.status === "verified") acc.verified += 1;
      else if (verdict.status === "unverified") acc.unverified += 1;
      else acc.self_attested += 1;
      return acc;
    },
    { verified: 0, self_attested: 0, unverified: 0 }
  );
  const summary = `${counts.verified} verified public artifact(s), ${counts.self_attested} self-attested claim(s), ${counts.unverified} unverified artifact(s).`;
  return {
    schema: "tasknode.reward_evidence_evaluation_context.v1",
    lifecycle_boundary: "advisory_context_only_no_reward_rule_change",
    summary,
    counts,
    artifact_verdicts: artifactVerdicts.slice(0, 24),
    scoring_guidance: [
      "Verified public artifacts can support completion when they match the task contract.",
      "Self-attested claims are useful context but should not be treated as independently proven.",
      "Unverified external-action claims should lower evidence confidence unless other evidence corroborates them.",
    ],
  };
}

function collectEvidenceText(value, {
  maxChars = 30000,
  maxDepth = 6,
} = {}) {
  const parts = [];
  let used = 0;
  const visit = (node, depth = 0) => {
    if (used >= maxChars || depth > maxDepth || node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const text = safeText(node, Math.max(0, maxChars - used));
      if (text) {
        parts.push(text);
        used += text.length + 1;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, item] of Object.entries(node).slice(0, 80)) {
        if (used >= maxChars) break;
        const keyText = safeText(key, 120);
        if (keyText) {
          parts.push(keyText);
          used += keyText.length + 1;
        }
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return safeText(parts.join("\n"), maxChars);
}

function evidencePayloadHasScreenshot(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.slice(0, 50).some((item) => evidencePayloadHasScreenshot(item, depth + 1));
  if (typeof value !== "object") return false;
  const object = safeObject(value);
  const typeText = [
    object.artifact_type,
    object.artifactType,
    object.evidence_type,
    object.evidenceType,
    object.verification_type,
    object.verificationType,
    object.type,
  ]
    .map((item) => safeText(item, 120).toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (/\b(screenshot|screen\s*shot|image|photo)\b/.test(typeText)) return true;
  const source = safeObject(object.source);
  const file = safeObject(object.file);
  const mime = safeText(object.mime_type || object.mimeType || source.mime_type || source.mimeType || file.mime_type || file.mimeType, 160).toLowerCase();
  if (mime.startsWith("image/")) return true;
  const fileName = safeText(object.file_name || object.fileName || object.filename || object.name || source.file_name || file.name, 500).toLowerCase();
  if (/\.(png|jpe?g|webp|gif|heic)$/i.test(fileName)) return true;
  return Object.values(object).slice(0, 80).some((item) => evidencePayloadHasScreenshot(item, depth + 1));
}

function normalizeBooleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const text = safeText(value, 80).toLowerCase();
  return ["true", "1", "yes", "required", "require", "on"].includes(text);
}

function splitConfigList(value = "") {
  return safeText(value, 4000)
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDiscordMessageLink(value = "") {
  const match = safeText(value, 1000).match(
    /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})/i
  );
  if (!match) return null;
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
    url: safeText(match[0], 500),
  };
}

function discordEvidencePolicy(env = process.env) {
  return {
    allowedGuildIds: splitConfigList(env.TASKNODE_DISCORD_ALLOWED_GUILD_IDS || env.TASKNODE_DISCORD_ANNOUNCEMENT_GUILD_IDS),
    allowedChannelIds: splitConfigList(env.TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS || env.TASKNODE_DISCORD_ANNOUNCEMENT_CHANNEL_IDS),
    botToken: safeText(env.TASKNODE_DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN, 4000),
    requireResolvableMessage: normalizeBooleanFlag(env.TASKNODE_DISCORD_REQUIRE_RESOLVABLE_MESSAGE),
  };
}

function discordAnnouncementEvidenceStatus({
  initialSubmission = {},
  verificationResponse = {},
  processedInitial = {},
  processedVerification = {},
} = {}) {
  const packets = [verificationResponse, initialSubmission, processedVerification, processedInitial];
  const text = collectEvidenceText(packets);
  const discordMessage = parseDiscordMessageLink(text);
  if (discordMessage) {
    return {
      ok: true,
      evidence_type: "discord_message_link",
      evidence_ref: discordMessage.url,
      discord_message: discordMessage,
      reason: "Discord message link evidence was provided.",
    };
  }
  const messageId =
    text.match(/\bdiscord\b[\s\S]{0,80}\b(?:message|msg)?\s*(?:id|link)?\s*[:#-]?\s*(\d{15,25})\b/i) ||
    text.match(/\b(?:message|msg)\s*id\s*[:#-]?\s*(\d{15,25})\b[\s\S]{0,80}\bdiscord\b/i);
  if (messageId?.[1]) {
    return {
      ok: true,
      evidence_type: "discord_message_id",
      evidence_ref: safeText(messageId[1], 80),
      discord_message: {
        guildId: "",
        channelId: "",
        messageId: safeText(messageId[1], 80),
        url: "",
      },
      reason: "Discord message id evidence was provided.",
    };
  }
  const hasScreenshot = packets.some((packet) => evidencePayloadHasScreenshot(packet));
  if (hasScreenshot && /\bdiscord\b/i.test(text)) {
    return {
      ok: true,
      evidence_type: "discord_announcement_screenshot",
      evidence_ref: "screenshot_or_image_artifact",
      discord_message: null,
      reason: "Screenshot or image evidence was provided with Discord announcement context.",
    };
  }
  return {
    ok: false,
    evidence_type: "",
    evidence_ref: "",
    reason: hasScreenshot
      ? "Screenshot or image evidence was present, but it was not tied to a Discord announcement."
      : "Missing Discord message link, Discord message id, or Discord-labeled announcement screenshot evidence.",
  };
}

async function resolveDiscordAnnouncementEvidenceStatus(input = {}, {
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const status = discordAnnouncementEvidenceStatus(input);
  if (!status.ok) return status;
  const policy = discordEvidencePolicy(env);
  const message = safeObject(status.discord_message);
  const channelId = safeText(message.channelId, 80);
  const guildId = safeText(message.guildId, 80);
  const messageId = safeText(message.messageId, 80);

  if (channelId && policy.allowedChannelIds.length && !policy.allowedChannelIds.includes(channelId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "rejected",
        reason: "channel_not_allowed",
        channelId,
      },
      reason: "Discord message link points to a channel that is not in the approved announcement channel allowlist.",
    };
  }
  if (guildId && policy.allowedGuildIds.length && !policy.allowedGuildIds.includes(guildId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "rejected",
        reason: "guild_not_allowed",
        guildId,
      },
      reason: "Discord message link points to a guild that is not in the approved announcement guild allowlist.",
    };
  }

  if (policy.requireResolvableMessage && (!channelId || !messageId)) {
    return {
      ...status,
      ok: false,
      discord_validation: {
        status: "unresolved",
        reason: "message_link_required_for_resolution",
      },
      reason: "Discord evidence must include a message link with channel id so the bot can resolve it.",
    };
  }

  if (policy.botToken && channelId && messageId) {
    try {
      const response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
        headers: {
          authorization: `Bot ${policy.botToken}`,
          "user-agent": TASK_REVIEW_USER_AGENT,
        },
      });
      if (!response.ok) {
        return {
          ...status,
          ok: false,
          discord_validation: {
            status: "unverified",
            reason: `discord_api_http_${response.status}`,
            channelId,
            messageId,
          },
          reason: `Discord bot could not verify the announcement message (HTTP ${response.status}).`,
        };
      }
      return {
        ...status,
        discord_validation: {
          status: "verified",
          reason: "discord_api_message_exists",
          channelId,
          messageId,
        },
        reason: "Discord announcement message link was verified by the configured Discord bot.",
      };
    } catch (error) {
      return {
        ...status,
        ok: false,
        discord_validation: {
          status: "unverified",
          reason: "discord_api_fetch_failed",
          channelId,
          messageId,
          error: safeText(error?.message || error, 300),
        },
        reason: "Discord bot could not verify the announcement message.",
      };
    }
  }

  return {
    ...status,
    discord_validation: {
      status: channelId && messageId ? "syntactic" : "self_attested",
      reason: channelId && messageId
        ? "message_link_shape_valid_without_bot_resolution"
        : "no_resolvable_message_link_available",
    },
  };
}

async function callOpenAiJson({ promptPath, promptVersion, responseFormat, input, modelEnv = "TASKNODE_TASK_REVIEW_MODEL" }) {
  const apiKey = safeText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("openai_api_key_missing");
  const systemPrompt = loadPrompt(promptPath);
  const model = safeText(process.env[modelEnv] || process.env.TASKNODE_TASKGEN_MODEL || "chat-latest", 120);
  const startedAt = Date.now();
  const timeoutMs = Math.max(5000, Number(process.env.TASKNODE_TASK_REVIEW_PROVIDER_TIMEOUT_MS || 45000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Use this task packet and return only valid JSON.\n\n${stableJson(input)}`,
          },
        ],
        response_format: responseFormat,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`task_review_openai_http_${response.status}:${bodyText.slice(0, 500)}`);
    const body = JSON.parse(bodyText);
    const output = parseJsonObject(body?.choices?.[0]?.message?.content || "");
    return {
      output,
      metadata: {
        provider: "frontier",
        model,
        prompt_version: promptVersion,
        prompt_digest: promptDigest(systemPrompt),
        input_packet_digest: sha256(input),
        output_digest: sha256(output),
        latency_ms: Date.now() - startedAt,
        parse_status: "ok",
        openai_response_id: body.id || "",
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("task_review_openai_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function publishAuthorityPointer({
  payload,
  contentKind = "TASK_UPDATE",
  destination,
  kind = "TASK_UPDATE",
  signerWallet,
  tasknodeKey,
  accountId = "",
  amountDrops = "1",
}) {
  const recipientPublicKeys = await taskPayloadRecipientPublicKeys({
    tasknodeKey,
    accountId,
    walletAddress: payload.subject_wallet || destination,
  });
  const encryptedPayload = await encryptTasknodePayload({
    plaintext: stableJson(payload),
    recipientPublicKeys,
  });
  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-${payload.schema.replace(/\./g, "-")}-${sha256(`${payload.task_id}:${payload.event_id}`).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: contentKind,
      schema: payload.schema,
      task_id: payload.task_id,
      subject_wallet: payload.subject_wallet,
    },
  });
  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind,
    schema: TASK_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
    taskId: payload.task_id,
  });
  const prepared = await preparePftPointerTransaction({
    account: signerWallet.classicAddress,
    destination,
    pointerMemo,
    amountDrops,
  });
  const signed = signerWallet.sign(prepared.txJson);
  const submitted = await submitSignedPftTransaction({
    signedTxBlob: signed.tx_blob,
    expectedAccount: signerWallet.classicAddress,
  });
  return {
    cid: pin.cid,
    digest: `sha256:${pin.sha256}`,
    txHash: submitted.txHash,
    ledgerIndex: submitted.ledgerIndex,
    engineResult: submitted.engineResult,
  };
}

async function syncTaskWallets({
  accountId,
  subjectWallet,
  authorityWallet,
  allocationWallet = "",
  taskId = "",
  txHash = "",
}) {
  const syncs = await Promise.all([
    authorityWallet
      ? syncPftlWalletTransactions({
        walletAddress: authorityWallet,
        accountId,
        role: "task_authority",
        limit: 120,
        maxPages: 1,
        syncKind: "task_review_authority",
      })
      : null,
    allocationWallet
      ? syncPftlWalletTransactions({
        walletAddress: allocationWallet,
        accountId,
        role: "allocation_reward",
        limit: 120,
        maxPages: 1,
        syncKind: "task_review_allocation",
      })
      : null,
    subjectWallet
      ? syncPftlWalletTransactions({
        walletAddress: subjectWallet,
        accountId,
        role: "user",
        limit: 120,
        maxPages: 1,
        syncKind: "task_review_subject",
      })
      : null,
  ]);
  const targeted = taskId || txHash
    ? await runPftlCacheReducerOnce({ batchLimit: 12, logger: console, taskId, txHash })
    : { claimed: 0 };
  const reduced = targeted.claimed > 0
    ? targeted
    : await runPftlCacheReducerOnce({ batchLimit: 40, logger: console });
  return { syncs, reduced, targeted: Boolean(targeted.claimed > 0) };
}

function scheduleTaskWalletSync({
  accountId,
  subjectWallet,
  authorityWallet,
  allocationWallet = "",
  taskId,
  txHash = "",
  phase,
  logger = console,
}) {
  setTimeout(() => {
    syncTaskWallets({ accountId, subjectWallet, authorityWallet, allocationWallet, taskId, txHash })
      .then((sync) => {
        logger.info?.("task_review_projection_refresh_finished", {
          taskId,
          phase,
          syncs: Array.isArray(sync?.syncs) ? sync.syncs.length : 0,
          targeted: Boolean(sync?.targeted),
        });
      })
      .catch((error) => {
        logger.warn?.("task_review_projection_refresh_failed", {
          taskId,
          phase,
          error: safeText(error?.message || error, 1000),
        });
      });
  }, 0);
  return {
    scheduled: true,
    source: "async_projection_refresh",
  };
}

async function claimSubmittedTasks({ limit = 1 } = {}) {
  const staleSeconds = workerClaimStaleSeconds();
  return transaction(async (client) => {
    const result = await client.query(
      `
        SELECT *
        FROM task_projections
        WHERE status = 'submitted'
          AND COALESCE(metadata_json->'workers'->'verification_request'->>'published', '') <> 'true'
          AND NOT EXISTS (
            SELECT 1
            FROM task_review_publications pub
            WHERE pub.task_id = task_projections.task_id
              AND pub.worker_name = 'verification_request'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_events existing
            WHERE existing.task_id = task_projections.task_id
              AND (
                existing.event_type = 'pf.reward.v1'
                OR (
                  existing.event_type = 'pf.task.update.v1'
                  AND (
                    existing.payload_json->>'transition' = 'verification_requested'
                    OR existing.payload_json->>'status_after' = 'verification_requested'
                  )
                )
                OR existing.event_type = 'pf.task.verification_request.v1'
              )
          )
          AND (
            COALESCE(metadata_json->'workers'->'verification_request'->>'processing', '') <> 'true'
            OR NULLIF(metadata_json->'workers'->'verification_request'->>'claimed_at', '')::timestamptz
                 < now() - ($1::int * interval '1 second')
          )
        ORDER BY updated_at ASC, task_id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      [staleSeconds, Math.min(Math.max(Number(limit) || 1, 1), 3)]
    );
    for (const row of result.rows) {
      await client.query(
        `
          UPDATE task_projections
          SET metadata_json = jsonb_set(
                jsonb_set(metadata_json, '{workers}', COALESCE(metadata_json->'workers', '{}'::jsonb), true),
                '{workers,verification_request}',
                $2::jsonb,
                true
              ),
              updated_at = now()
          WHERE task_id = $1
        `,
        [
          row.task_id,
          JSON.stringify({
            processing: "true",
            claimed_at: new Date().toISOString(),
            published: "false",
          }),
        ]
      );
    }
    return result.rows;
  });
}

async function claimVerificationResponses({ limit = 1 } = {}) {
  const staleSeconds = workerClaimStaleSeconds();
  return transaction(async (client) => {
    const result = await client.query(
      `
        SELECT *
        FROM task_projections
        WHERE status = 'verification_response_submitted'
          AND COALESCE(metadata_json->'workers'->'reward_scoring'->>'published', '') <> 'true'
          AND NOT EXISTS (
            SELECT 1
            FROM task_review_publications pub
            WHERE pub.task_id = task_projections.task_id
              AND pub.worker_name = 'reward_scoring'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_events existing
            WHERE existing.task_id = task_projections.task_id
              AND existing.event_type = 'pf.reward.v1'
          )
          AND (
            COALESCE(metadata_json->'workers'->'reward_scoring'->>'processing', '') <> 'true'
            OR NULLIF(metadata_json->'workers'->'reward_scoring'->>'claimed_at', '')::timestamptz
                 < now() - ($1::int * interval '1 second')
          )
        ORDER BY updated_at ASC, task_id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      [staleSeconds, Math.min(Math.max(Number(limit) || 1, 1), 3)]
    );
    for (const row of result.rows) {
      await client.query(
        `
          UPDATE task_projections
          SET metadata_json = jsonb_set(
                jsonb_set(metadata_json, '{workers}', COALESCE(metadata_json->'workers', '{}'::jsonb), true),
                '{workers,reward_scoring}',
                $2::jsonb,
                true
              ),
              updated_at = now()
          WHERE task_id = $1
        `,
        [
          row.task_id,
          JSON.stringify({
            processing: "true",
            claimed_at: new Date().toISOString(),
            published: "false",
          }),
        ]
      );
    }
    return result.rows;
  });
}

async function clearWorkerClaim({ taskId, workerName, error = "" }) {
  await query(
    `
      UPDATE task_projections
      SET metadata_json = jsonb_set(
            jsonb_set(metadata_json, '{workers}', COALESCE(metadata_json->'workers', '{}'::jsonb), true),
            $2::text[],
            $3::jsonb,
            true
          ),
          updated_at = now()
      WHERE task_id = $1
    `,
    [
      taskId,
      ["workers", workerName],
      JSON.stringify({
        processing: "false",
        last_error: safeText(error, 1000),
        updated_at: new Date().toISOString(),
      }),
    ]
  );
}

async function markWorkerPublished({ taskId, workerName, published = {} }) {
  await query(
    `
      UPDATE task_projections
      SET metadata_json = jsonb_set(
            jsonb_set(metadata_json, '{workers}', COALESCE(metadata_json->'workers', '{}'::jsonb), true),
            $2::text[],
            $3::jsonb,
            true
          ),
          updated_at = now()
      WHERE task_id = $1
    `,
    [
      taskId,
      ["workers", workerName],
      JSON.stringify({
        processing: "false",
        published: "true",
        published_at: new Date().toISOString(),
        tx_hash: safeText(published.txHash, 120),
        cid: safeText(published.cid, 240),
      }),
    ]
  );
}

async function acquireReviewPublicationLock({ taskId, workerName, metadata = {} } = {}) {
  const result = await query(
    `
      INSERT INTO task_review_publications (
        task_id, worker_name, status, metadata_json, reserved_at, updated_at
      )
      VALUES ($1, $2, 'reserved', $3::jsonb, now(), now())
      ON CONFLICT (task_id, worker_name) DO NOTHING
      RETURNING task_id, worker_name, status, source_tx_hash, source_cid, metadata_json
    `,
    [taskId, workerName, JSON.stringify(safeObject(metadata))]
  );
  if (result.rows[0]) return { acquired: true, row: result.rows[0] };
  const existing = await query(
    `
      SELECT task_id, worker_name, status, source_tx_hash, source_cid, metadata_json, reserved_at, published_at, updated_at
      FROM task_review_publications
      WHERE task_id = $1 AND worker_name = $2
      LIMIT 1
    `,
    [taskId, workerName]
  );
  return { acquired: false, row: existing.rows[0] || null };
}

async function markReviewPublicationPublished({ taskId, workerName, published = {}, metadata = {} } = {}) {
  await query(
    `
      UPDATE task_review_publications
      SET status = 'published',
          source_tx_hash = $3,
          source_cid = $4,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
          forensic_cid = CASE WHEN $6::text <> '' THEN $6 ELSE forensic_cid END,
          forensic_digest = CASE WHEN $7::text <> '' THEN $7 ELSE forensic_digest END,
          signature_json = CASE WHEN $8::jsonb <> '{}'::jsonb THEN $8::jsonb ELSE signature_json END,
          published_at = now(),
          updated_at = now()
      WHERE task_id = $1 AND worker_name = $2
    `,
    [
      taskId,
      workerName,
      safeText(published.txHash, 120),
      safeText(published.cid, 240),
      JSON.stringify(safeObject(metadata)),
      safeText(published.forensicCid, 240),
      safeText(published.forensicDigest, 180),
      JSON.stringify(safeObject(published.signature)),
    ]
  );
}

async function markReviewPublicationError({ taskId, workerName, error = "", metadata = {} } = {}) {
  await query(
    `
      UPDATE task_review_publications
      SET status = 'error',
          error = $3,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE task_id = $1 AND worker_name = $2
    `,
    [taskId, workerName, safeText(error, 1000), JSON.stringify(safeObject(metadata))]
  );
}

async function releaseReviewPublicationLock({ taskId, workerName } = {}) {
  await query(
    `
      DELETE FROM task_review_publications
      WHERE task_id = $1 AND worker_name = $2 AND status = 'reserved'
    `,
    [taskId, workerName]
  );
}

function publicationLockPublishedRef(lockRow = {}) {
  const txHash = safeText(lockRow?.source_tx_hash, 120);
  const cid = safeText(lockRow?.source_cid, 240);
  if (!txHash && !cid) return null;
  return { txHash, cid };
}

async function finalizeWorkerPublish({
  taskId,
  workerName,
  published = {},
  expectedStatuses = [],
  accountId = "",
  subjectWallet = "",
  authorityWallet = "",
  allocationWallet = "",
  phase = "",
  logger = console,
}) {
  await syncTaskWallets({
    accountId,
    subjectWallet,
    authorityWallet,
    allocationWallet,
    taskId,
    txHash: published.txHash,
  });
  await markWorkerPublished({ taskId, workerName, published });
  const statusResult = await query(
    "SELECT status FROM task_projections WHERE task_id = $1 LIMIT 1",
    [taskId]
  );
  const status = safeText(statusResult.rows[0]?.status, 80).toLowerCase();
  const expected = expectedStatuses.map((value) => safeText(value, 80).toLowerCase()).filter(Boolean);
  if (expected.includes(status)) {
    logger.info?.("task_worker_publish_confirmed", { taskId, workerName, phase, status });
    return { ok: true, status };
  }

  logger.warn?.("task_worker_publish_projection_lag", {
    taskId,
    workerName,
    phase,
    status,
    expectedStatuses: expected,
  });
  return { ok: false, status, expectedStatuses: expected };
}

async function processSubmittedTask(row, { logger = console } = {}) {
  const workerName = "verification_request";
  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
  const authorityWallet = walletFromSeed(authoritySeed(), "task_authority_seed_missing");
  const detail = await getTaskDetail({
    accountId: row.account_id,
    walletAddress: row.subject_wallet,
    taskId: row.task_id,
  });
  const payloads = eventPayloads(detail);
  const taskOffer = latestPayloadBySchema(payloads, ["pf.task.offer.v1"]);
  const initialSubmission = latestPayloadBySchema(payloads, ["pf.task.submission.v1"]);
  if (!taskOffer || !initialSubmission) throw new Error("task_review_missing_offer_or_submission");
  const existingVerificationRequest = existingVerificationRequestEvent(detail);
  const existingRewardReview = existingRewardReviewEvent(detail);
  const existingReviewEvent = existingVerificationRequest || existingRewardReview;
  if (existingReviewEvent) {
    const publishedRef = timelineEventPublishedRef(existingReviewEvent);
    await markWorkerPublished({
      taskId: row.task_id,
      workerName: "verification_request",
      published: publishedRef,
    });
    logger.info?.("task_verification_request_already_published", {
      taskId: row.task_id,
      txHash: publishedRef.txHash,
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_already_published" };
  }

  const publicationLock = await acquireReviewPublicationLock({
    taskId: row.task_id,
    workerName,
    metadata: {
      phase: "verification_request",
      subject_wallet: row.subject_wallet,
      submission_cid: initialSubmission.cid || "",
    },
  });
  if (!publicationLock.acquired) {
    const publishedRef = publicationLockPublishedRef(publicationLock.row);
    if (publishedRef) {
      await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
    }
    logger.info?.("task_verification_request_publication_lock_exists", {
      taskId: row.task_id,
      status: publicationLock.row?.status || "",
      txHash: publishedRef?.txHash || "",
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_publication_lock_exists" };
  }

  let publicationAttempted = false;
  try {
    const processedEvidence = await processedEvidenceFromPayload(initialSubmission);
    const verification = await callOpenAiJson({
      promptPath: VERIFICATION_PROMPT_PATH,
      promptVersion: VERIFICATION_PROMPT_VERSION,
      responseFormat: verificationResponseFormat,
      input: {
        task_offer: taskOffer,
        initial_submission: initialSubmission,
        processed_evidence: processedEvidence,
        context: {},
      },
    });
    const now = new Date().toISOString();
    const verificationRequest = {
      assessment: safeText(verification.output.assessment, 80),
      verification_ask: safeText(verification.output.verification_ask, 4000),
      verification_type: safeText(verification.output.verification_type, 80),
      reason: safeText(verification.output.reason, 1000),
    };
    const payload = {
      schema: "pf.task.update.v1",
      protocol: "tasknode.pftl",
      created_at: now,
      chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
      task_id: row.task_id,
      event_id: `evt_${sha256({ taskId: row.task_id, verificationRequest }).slice(0, 24)}`,
      actor_wallet: authorityWallet.classicAddress,
      subject_wallet: row.subject_wallet,
      authority_wallet: authorityWallet.classicAddress,
      allocation_wallet: row.allocation_wallet || "",
      transition: "verification_requested",
      status_after: "verification_requested",
      verification_request: verificationRequest,
      verification_ask: verificationRequest.verification_ask,
      verification_type: verificationRequest.verification_type,
      submission_cid: initialSubmission.cid || "",
      generation: verification.metadata,
    };
    const prePublishDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const preExistingVerificationRequest = existingVerificationRequestEvent(prePublishDetail);
    const preExistingRewardReview = existingRewardReviewEvent(prePublishDetail);
    const preExistingReviewEvent = preExistingVerificationRequest || preExistingRewardReview;
    if (preExistingReviewEvent) {
      const publishedRef = timelineEventPublishedRef(preExistingReviewEvent);
      await markReviewPublicationPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
        metadata: { source: "existing_indexed_event" },
      });
      await markWorkerPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
      });
      logger.info?.("task_verification_request_publish_skipped_existing_event", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "verification_request_already_indexed_before_publish" };
    }
    publicationAttempted = true;
    const published = await publishAuthorityPointer({
      payload,
      contentKind: "TASK_UPDATE",
      destination: row.subject_wallet,
      kind: "TASK_UPDATE",
      signerWallet: authorityWallet,
      tasknodeKey,
      accountId: row.account_id,
    });
    await markReviewPublicationPublished({
      taskId: row.task_id,
      workerName,
      published,
      metadata: { source: "published_by_worker" },
    });
    await finalizeWorkerPublish({
      taskId: row.task_id,
      workerName,
      published,
      expectedStatuses: ["verification_requested"],
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      phase: "verification_request",
      logger,
    });
    scheduleTaskWalletSync({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      taskId: row.task_id,
      txHash: published.txHash,
      phase: "verification_request",
      logger,
    });
    logger.info?.("task_verification_request_published", {
      taskId: row.task_id,
      txHash: published.txHash,
      cid: published.cid,
    });
    return { ok: true, taskId: row.task_id, published };
  } catch (error) {
    if (publicationAttempted) {
      await markReviewPublicationError({
        taskId: row.task_id,
        workerName,
        error: error?.message || String(error),
        metadata: { publication_attempted: true },
      }).catch(() => null);
    } else if (publicationLock?.acquired) {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}

function normalizeRewardScore(output = {}, offerPft = 0, { badgeRewardCapPft = 0 } = {}) {
  const decision = safeText(output.decision, 80);
  const cap = Number(badgeRewardCapPft);
  const offer = Number(offerPft);
  const trustedUpperBound =
    Number.isFinite(cap) && cap > 0 && Number.isFinite(offer) && offer > 0
      ? Math.min(offer, cap)
      : offer;
  const rewardPft = decision === "reject" ? 0 : normalizeReward(output.reward_pft, trustedUpperBound);
  return {
    decision: rewardPft > 0 ? (decision === "partial_reward" ? "partial_reward" : "reward") : "reject",
    reward_pft: rewardPft.toFixed(2),
    badge_reward_cap_pft: Number.isFinite(cap) && cap > 0 ? cap.toFixed(2) : "",
    badge_cap_applied: Number.isFinite(cap) && cap > 0 && Number.isFinite(offer) && offer > cap,
    completion: clampInteger(output.completion, 0),
    evidence_quality: clampInteger(output.evidence_quality, 0),
    reason: safeText(output.reason, 2000),
    user_feedback: safeText(output.user_feedback, 2000),
  };
}

async function networkTaskRewardBadgePolicy(row = {}) {
  const taskId = safeText(row.task_id, 180);
  const requestId = safeText(row.request_id, 180);
  if (!taskId && !requestId) return {};
  const result = await query(
    `
      SELECT source_payload_json
      FROM network_task_generation_jobs
      WHERE ($1::text <> '' AND task_id = $1)
         OR ($2::text <> '' AND request_id = $2)
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [taskId, requestId]
  );
  const source = safeObject(result.rows[0]?.source_payload_json);
  const networkTask = safeObject(source.networkTask || source.network_task);
  const policy = safeObject(source.policy);
  const badgeRewardCapPft = Number(
    networkTask.badgeRewardCapPft ||
      networkTask.badge_reward_cap_pft ||
      policy.badgeRewardCapPft ||
      policy.badge_reward_cap_pft ||
      policy.badgeEligibilityDecision?.badge_reward_cap_pft ||
      policy.badge_eligibility_decision?.badge_reward_cap_pft ||
      0
  );
  return {
    requiredBadgeId: safeText(networkTask.requiredBadgeId || networkTask.required_badge_id || policy.required_badge_id, 80),
    operatingBadgeId: safeText(networkTask.operatingBadgeId || networkTask.operating_badge_id || policy.operating_badge_id, 80),
    badgeWorkType: safeText(networkTask.badgeWorkType || networkTask.badge_work_type || policy.badge_work_type, 120),
    badgeRewardCapPft: Number.isFinite(badgeRewardCapPft) && badgeRewardCapPft > 0 ? badgeRewardCapPft : 0,
    discordEvidenceRequired: normalizeBooleanFlag(
      networkTask.discordEvidenceRequired ??
        networkTask.discord_evidence_required ??
        policy.discordEvidenceRequired ??
        policy.discord_evidence_required ??
        false
    ),
  };
}

async function publishDiscordEvidenceVerificationRequest({
  row = {},
  taskOffer = {},
  initialSubmission = {},
  verificationResponse = {},
  discordEvidence = {},
  authorityWallet,
  tasknodeKey,
  logger = console,
} = {}) {
  const taskId = safeText(row.task_id, 180);
  const verificationResponseRef = safeText(verificationResponse.cid || verificationResponse.source_cid || sha256(verificationResponse), 240);
  const workerName = `discord_evidence_request_${sha256(`${taskId}:${verificationResponseRef}`).slice(0, 16)}`;
  const publicationLock = await acquireReviewPublicationLock({
    taskId,
    workerName,
    metadata: {
      phase: "discord_evidence_request",
      subject_wallet: row.subject_wallet,
      verification_response_cid: verificationResponse.cid || "",
      reason: discordEvidence.reason || "",
    },
  });
  if (!publicationLock.acquired) {
    const publishedRef = publicationLockPublishedRef(publicationLock.row);
    logger.info?.("task_discord_evidence_request_lock_exists", {
      taskId,
      status: publicationLock.row?.status || "",
      txHash: publishedRef?.txHash || "",
    });
    return { ok: true, skipped: true, reason: "discord_evidence_request_lock_exists", published: publishedRef };
  }

  let publicationAttempted = false;
  try {
    const now = new Date().toISOString();
    const verificationRequest = {
      assessment: "incomplete",
      verification_ask:
        "Please submit Discord announcement proof for this Network Task: provide a Discord message link/id from an approved Post Fiat channel, or a screenshot/image showing the announcement and the public work artifact. Reward scoring will continue after this required evidence is present.",
      verification_type: "mixed",
      reason: safeText(discordEvidence.reason || "Missing required Discord announcement evidence.", 1000),
    };
    const payload = {
      schema: "pf.task.update.v1",
      protocol: "tasknode.pftl",
      created_at: now,
      chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
      task_id: taskId,
      event_id: `evt_${sha256({ taskId, verificationResponseRef, verificationRequest }).slice(0, 24)}`,
      actor_wallet: authorityWallet.classicAddress,
      subject_wallet: row.subject_wallet,
      authority_wallet: authorityWallet.classicAddress,
      allocation_wallet: row.allocation_wallet || "",
      transition: "verification_requested",
      status_after: "verification_requested",
      verification_request: verificationRequest,
      verification_ask: verificationRequest.verification_ask,
      verification_type: verificationRequest.verification_type,
      submission_cid: initialSubmission.cid || "",
      verification_response_cid: verificationResponse.cid || "",
      blocking_requirement: "discord_announcement_evidence",
      task_history: {
        task: taskOffer,
        submission: initialSubmission,
        verification_response: verificationResponse,
      },
      generation: {
        provider: "deterministic",
        model: "task-review-worker",
        prompt_version: "discord_announcement_evidence_required",
        input_packet_digest: sha256({ taskOffer, initialSubmission, verificationResponse }),
        output_digest: sha256(verificationRequest),
        parse_status: "ok",
      },
    };
    publicationAttempted = true;
    const published = await publishAuthorityPointer({
      payload,
      contentKind: "TASK_UPDATE",
      destination: row.subject_wallet,
      kind: "TASK_UPDATE",
      signerWallet: authorityWallet,
      tasknodeKey,
      accountId: row.account_id,
    });
    await markReviewPublicationPublished({
      taskId,
      workerName,
      published,
      metadata: {
        source: "published_by_worker",
        terminal_schema: "pf.task.update.v1",
        blocking_requirement: "discord_announcement_evidence",
      },
    });
    await finalizeWorkerPublish({
      taskId,
      workerName,
      published,
      expectedStatuses: ["verification_requested"],
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      phase: "discord_evidence_request",
      logger,
    });
    scheduleTaskWalletSync({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      taskId,
      txHash: published.txHash,
      phase: "discord_evidence_request",
      logger,
    });
    logger.info?.("task_discord_evidence_request_published", {
      taskId,
      txHash: published.txHash,
      cid: published.cid,
    });
    return { ok: true, published };
  } catch (error) {
    if (publicationAttempted) {
      await markReviewPublicationError({
        taskId,
        workerName,
        error: error?.message || String(error),
        metadata: { publication_attempted: true },
      }).catch(() => null);
    } else {
      await releaseReviewPublicationLock({ taskId, workerName }).catch(() => null);
    }
    throw error;
  }
}

function buildRewardOutcomePayload({
  row = {},
  score = {},
  scoringMetadata = {},
  taskOffer = {},
  initialSubmission = {},
  verificationRequest = {},
  verificationResponse = {},
  authorityWalletAddress = "",
  rewardWalletAddress = "",
  createdAt = new Date().toISOString(),
} = {}) {
  const rewardPft = Number(score.reward_pft);
  const economicRewardPft = Number.isFinite(rewardPft) && rewardPft > 0 ? rewardPft : 0;
  const rewardAmountDrops = economicRewardPft > 0 ? pftToDrops(economicRewardPft) : REWARD_CARRIER_DROPS;
  const carrierAmountDrops = economicRewardPft > 0 ? "0" : REWARD_CARRIER_DROPS;
  const payload = {
    schema: "pf.reward.v1",
    reward_history_schema: 2,
    protocol: "tasknode.pftl",
    created_at: createdAt,
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    task_id: row.task_id,
    event_id: `evt_${sha256({ taskId: row.task_id, rewardPft: economicRewardPft, score }).slice(0, 24)}`,
    actor_wallet: rewardWalletAddress,
    subject_wallet: row.subject_wallet,
    authority_wallet: authorityWalletAddress,
    allocation_wallet: rewardWalletAddress,
    recipient_wallet_address: row.subject_wallet,
    reward_pft: economicRewardPft.toFixed(2),
    economic_reward_pft: economicRewardPft.toFixed(2),
    transaction_amount_drops: rewardAmountDrops,
    carrier_amount_drops: carrierAmountDrops,
    reward_tier: "task_engine_live",
    reward_decision: score.decision,
    reward_score: score,
    reward_summary: score.reason,
    generation: scoringMetadata,
    task_history: {
      task: taskOffer,
      submission: initialSubmission,
      verification_request: verificationRequest,
      verification_response: verificationResponse,
    },
  };
  return { payload, rewardAmountDrops, economicRewardPft };
}

function compactTimelineForensics(detail = {}) {
  return timelineEvents(detail).map((event, index) => ({
    index: index + 1,
    schema: safeText(event.schema || event.rawPayload?.schema, 160),
    tx_hash: safeText(event.txHash, 160),
    cid: safeText(event.cid, 240),
    event_digest: safeText(event.eventDigest, 240),
    write_source: safeText(event.writeSource, 80),
    signature: event.signature
      ? {
          role: safeText(event.signature.role, 80),
          signer_wallet: safeText(event.signature.signer_wallet || event.signature.address, 180),
          payload_digest: safeText(event.signature.payload_digest, 180),
          verified: event.signature.verification?.verified === true,
          reason: safeText(event.signature.verification?.reason, 120),
        }
      : null,
  }));
}

function compactTransitionSignature(signature = {}) {
  return {
    schema: safeText(signature.schema, 120),
    role: safeText(signature.role, 80),
    task_id: safeText(signature.task_id, 180),
    transition: safeText(signature.transition, 120),
    signer_wallet: safeText(signature.signer_wallet, 180),
    public_key: safeText(signature.public_key, 180),
    payload_digest: safeText(signature.payload_digest, 180),
    signature: safeText(signature.signature, 260),
    signed_at: safeText(signature.signed_at, 80),
    algorithm: safeText(signature.algorithm, 120),
  };
}

function attachRewardForensics({
  detail = {},
  rewardPayload = {},
  rewardSignature = {},
  scoringMetadata = {},
} = {}) {
  const unsignedRewardDigest = `sha256:${sha256(rewardPayload)}`;
  const timeline = compactTimelineForensics(detail);
  const transitionSignatures = [
    ...timeline.map((event) => event.signature).filter(Boolean),
    compactTransitionSignature(rewardSignature),
  ].filter((signature) => signature?.payload_digest);
  const forensicEnvelope = {
    schema: "pf.reward.forensics.v1",
    version: 1,
    task_id: safeText(rewardPayload.task_id, 180),
    created_at: new Date().toISOString(),
    anchoring: {
      mode: "single_reward_payload_cid",
      description: "This pf.reward.v1 payload is the consolidated forensic document; its encrypted IPFS CID is carried by the reward transaction pointer memo.",
    },
    unsigned_reward_payload_digest: unsignedRewardDigest,
    task_history_digest: `sha256:${sha256(rewardPayload.task_history || {})}`,
    scoring_digest: `sha256:${sha256(rewardPayload.reward_score || {})}`,
    scoring_metadata_digest: `sha256:${sha256(scoringMetadata || {})}`,
    timeline,
    transition_signatures: transitionSignatures,
    integrity: {
      timeline_event_count: timeline.length,
      signed_transition_count: transitionSignatures.length,
      actor_signed_transition_count: transitionSignatures.filter((signature) => signature.role === "actor").length,
      pf_signed_transition_count: transitionSignatures.filter((signature) => signature.role !== "actor").length,
      ipfs_write_policy: "reward_time_only",
    },
  };
  return {
    ...rewardPayload,
    reward_forensics: forensicEnvelope,
    transition_signatures: transitionSignatures,
  };
}

async function processVerificationResponse(row, { logger = console } = {}) {
  const workerName = "reward_scoring";
  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
  const authorityWallet = walletFromSeed(authoritySeed(), "task_authority_seed_missing");
  const rewardWallet = walletFromSeed(rewardSeed(), "task_reward_seed_missing");
  await syncTaskWallets({
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    authorityWallet: authorityWallet.classicAddress,
    allocationWallet: rewardWallet.classicAddress,
  });
  const detail = await getTaskDetail({
    accountId: row.account_id,
    walletAddress: row.subject_wallet,
    taskId: row.task_id,
  });
  const payloads = eventPayloads(detail);
  const taskOffer = latestPayloadBySchema(payloads, ["pf.task.offer.v1"]);
  const initialSubmission = latestPayloadBySchema(payloads, ["pf.task.submission.v1"]);
  const verificationRequest = latestVerificationRequestPayload(payloads);
  const verificationResponse = latestPayloadBySchema(payloads, ["pf.task.verification_response.v1"]);
  if (!taskOffer || !initialSubmission || !verificationResponse) {
    throw new Error("task_scoring_missing_required_events");
  }
  const existingRewardReview = existingRewardReviewEvent(detail);
  if (existingRewardReview) {
    const publishedRef = timelineEventPublishedRef(existingRewardReview);
    await markWorkerPublished({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
    });
    logger.info?.("task_reward_scoring_already_published", {
      taskId: row.task_id,
      txHash: publishedRef.txHash,
    });
    return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_scoring_already_published" };
  }

  const existingPaymentGuard = rewardPaymentGuard(row.metadata_json);
  if (rewardPaymentGuardBlocksRetry(existingPaymentGuard)) {
    await syncTaskWallets({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      allocationWallet: rewardWallet.classicAddress,
    });
    const refreshedDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const refreshedRewardReview = existingRewardReviewEvent(refreshedDetail);
    if (refreshedRewardReview) {
      const publishedRef = timelineEventPublishedRef(refreshedRewardReview);
      await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
      logger.info?.("task_reward_already_indexed_after_guard_sync", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_already_indexed_after_guard_sync" };
    }
    throw new Error(`task_reward_payment_guard_active:${rewardPaymentGuardStatus(existingPaymentGuard) || "unknown"}`);
  }

  let publicationLock = null;
  let publicationAttempted = false;
  let reward = null;
  try {
    const [processedInitial, processedVerification] = await Promise.all([
      processedEvidenceFromPayload(initialSubmission),
      processedEvidenceFromPayload(verificationResponse),
    ]);
    const evidenceEvaluation = buildRewardEvidenceEvaluationContext({
      initial: processedInitial,
      verification: processedVerification,
    });
    const offerPft = Number(taskOffer?.reward_offer?.amount_estimate_pft || row.reward_offer_pft || 0);
    const badgePolicy = await networkTaskRewardBadgePolicy(row).catch(() => ({}));
    const discordEvidence = await resolveDiscordAnnouncementEvidenceStatus({
      initialSubmission,
      verificationResponse,
      processedInitial,
      processedVerification,
    });
    if (badgePolicy.discordEvidenceRequired && !discordEvidence.ok) {
      const blocked = await publishDiscordEvidenceVerificationRequest({
        row,
        taskOffer,
        initialSubmission,
        verificationResponse,
        discordEvidence,
        authorityWallet,
        tasknodeKey,
        logger,
      });
      await clearWorkerClaim({
        taskId: row.task_id,
        workerName,
        error: "discord_announcement_evidence_missing",
      }).catch(() => null);
      return {
        ok: true,
        taskId: row.task_id,
        blocked: true,
        reason: "discord_announcement_evidence_missing",
        published: blocked.published,
      };
    }

    publicationLock = await acquireReviewPublicationLock({
      taskId: row.task_id,
      workerName,
      metadata: {
        phase: "reward_scoring",
        subject_wallet: row.subject_wallet,
        verification_response_cid: verificationResponse.cid || "",
      },
    });
    if (!publicationLock.acquired) {
      const publishedRef = publicationLockPublishedRef(publicationLock.row);
      if (publishedRef) {
        await markWorkerPublished({ taskId: row.task_id, workerName, published: publishedRef });
      }
      logger.info?.("task_reward_scoring_publication_lock_exists", {
        taskId: row.task_id,
        status: publicationLock.row?.status || "",
        txHash: publishedRef?.txHash || "",
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_scoring_publication_lock_exists" };
    }

    const scoring = await callOpenAiJson({
      promptPath: REWARD_PROMPT_PATH,
      promptVersion: REWARD_PROMPT_VERSION,
      responseFormat: rewardResponseFormat,
      input: {
        task_offer: taskOffer,
        initial_submission: initialSubmission,
        verification_request: verificationRequest,
        verification_response: verificationResponse,
        processed_evidence: {
          initial: processedInitial,
          verification: processedVerification,
        },
        evidence_evaluation: evidenceEvaluation,
      },
    });
    const score = {
      ...normalizeRewardScore(scoring.output, offerPft, badgePolicy),
      discord_announcement_evidence_required: badgePolicy.discordEvidenceRequired,
      discord_announcement_evidence_ok: discordEvidence.ok,
      discord_announcement_evidence_type: discordEvidence.evidence_type,
      discord_announcement_evidence_ref: discordEvidence.evidence_ref,
    };
    const rewardScoringMetadata = {
      ...scoring.metadata,
      discord_announcement_evidence: discordEvidence,
    };
    const {
      payload: baseRewardPayload,
      rewardAmountDrops,
      economicRewardPft,
    } = buildRewardOutcomePayload({
      row,
      score,
      scoringMetadata: rewardScoringMetadata,
      taskOffer,
      initialSubmission,
      verificationRequest,
      verificationResponse,
      authorityWalletAddress: authorityWallet.classicAddress,
      rewardWalletAddress: rewardWallet.classicAddress,
    });
    const prePublishDetail = await getTaskDetail({
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      taskId: row.task_id,
    });
    const preExistingRewardReview = existingRewardReviewEvent(prePublishDetail);
    if (preExistingRewardReview) {
      const publishedRef = timelineEventPublishedRef(preExistingRewardReview);
      await markReviewPublicationPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
        metadata: { source: "existing_indexed_event" },
      });
      await markWorkerPublished({
        taskId: row.task_id,
        workerName,
        published: publishedRef,
      });
      logger.info?.("task_reward_scoring_publish_skipped_existing_event", {
        taskId: row.task_id,
        txHash: publishedRef.txHash,
      });
      return { ok: true, taskId: row.task_id, skipped: true, reason: "reward_already_indexed_before_publish" };
    }

    const rewardSignature = signTaskTransition({
      payload: baseRewardPayload,
      signerWallet: rewardWallet,
      role: "pf_reward_authority",
      transition: "rewarded",
    });
    const rewardPayload = attachRewardForensics({
      detail: prePublishDetail,
      rewardPayload: baseRewardPayload,
      rewardSignature,
      scoringMetadata: rewardScoringMetadata,
    });
    const rewardForensicDigest = `sha256:${sha256(rewardPayload.reward_forensics || {})}`;

    const paymentGuard = await claimRewardPaymentGuard({
      taskId: row.task_id,
      rewardPayload,
      rewardPft: economicRewardPft,
    });
    if (!paymentGuard.claimed) {
      throw new Error(`task_reward_payment_guard_active:${rewardPaymentGuardStatus(paymentGuard.guard) || "unknown"}`);
    }

    publicationAttempted = true;
    reward = await publishAuthorityPointer({
      payload: rewardPayload,
      contentKind: "REWARD",
      destination: row.subject_wallet,
      kind: "REWARD",
      signerWallet: rewardWallet,
      tasknodeKey,
      accountId: row.account_id,
      amountDrops: rewardAmountDrops,
    });
    await markRewardPaymentSubmitted({ taskId: row.task_id, reward });
    const publishedRef = {
      txHash: reward.txHash,
      cid: reward.cid,
      forensicCid: reward.cid,
      forensicDigest: rewardForensicDigest,
      signature: rewardSignature,
    };
    await markReviewPublicationPublished({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
      metadata: {
        source: "published_by_worker",
        reward_tx_hash: reward.txHash,
        reward_cid: reward.cid,
        forensic_cid: reward.cid,
        forensic_digest: rewardForensicDigest,
        reward_signature_digest: rewardSignature.payload_digest,
        reward_pft: score.reward_pft,
        economic_reward_pft: economicRewardPft.toFixed(2),
        transaction_amount_drops: rewardAmountDrops,
        carrier_amount_drops: rewardPayload.carrier_amount_drops,
        terminal_schema: "pf.reward.v1",
      },
    });
    await finalizeWorkerPublish({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
      expectedStatuses: ["rewarded"],
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      allocationWallet: rewardWallet.classicAddress,
      phase: "reward_scoring",
      logger,
    });
    scheduleTaskWalletSync({
      accountId: row.account_id,
      subjectWallet: row.subject_wallet,
      authorityWallet: authorityWallet.classicAddress,
      allocationWallet: rewardWallet.classicAddress,
      taskId: row.task_id,
      txHash: publishedRef.txHash,
      phase: "reward_scoring",
      logger,
    });
    logger.info?.("task_reward_outcome_published", {
      taskId: row.task_id,
      rewardTxHash: reward.txHash,
      rewardPft: score.reward_pft,
      amountDrops: rewardAmountDrops,
    });
    return { ok: true, taskId: row.task_id, reward };
  } catch (error) {
    if (publicationAttempted) {
      await markReviewPublicationError({
        taskId: row.task_id,
        workerName,
        error: error?.message || String(error),
        metadata: {
          publication_attempted: true,
          reward_tx_hash: reward?.txHash || "",
          reward_cid: reward?.cid || "",
        },
      }).catch(() => null);
      await markRewardPaymentSubmitUnknown({
        taskId: row.task_id,
        error: error?.message || error,
      }).catch(() => null);
    } else if (publicationLock?.acquired) {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}

export const taskReviewWorkerInternals = {
  buildRewardEvidenceEvaluationContext,
  latestRewardPaymentEvent,
  normalizeReward,
  rewardPaymentGuardBlocksRetry,
  rewardPaymentGuardPayload,
  rewardPaymentGuardStatus,
};

export async function processTaskReviewQueueOnce({ limit = 1, logger = console } = {}) {
  const results = [];
  const submitted = await claimSubmittedTasks({ limit });
  for (const row of submitted) {
    try {
      results.push(await processSubmittedTask(row, { logger }));
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await clearWorkerClaim({ taskId: row.task_id, workerName: "verification_request", error: message }).catch(() => null);
      logger.warn?.("task_verification_request_failed", { taskId: row.task_id, error: message });
      results.push({ ok: false, taskId: row.task_id, phase: "verification_request", error: message });
    }
  }

  const responses = await claimVerificationResponses({ limit });
  for (const row of responses) {
    try {
      results.push(await processVerificationResponse(row, { logger }));
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await clearWorkerClaim({ taskId: row.task_id, workerName: "reward_scoring", error: message }).catch(() => null);
      logger.warn?.("task_reward_scoring_failed", { taskId: row.task_id, error: message });
      results.push({ ok: false, taskId: row.task_id, phase: "reward_scoring", error: message });
    }
  }
  return { ok: true, claimed: submitted.length + responses.length, results };
}

export function startTaskReviewWorker({
  enabled = process.env.TASKNODE_TASK_REVIEW_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS || 20000),
  batchLimit = Number(process.env.TASKNODE_TASK_REVIEW_WORKER_BATCH_LIMIT || 1),
  logger = console,
} = {}) {
  const permission = taskReviewPublisherPermission({ enabled });
  if (timer || !permission.enabled) {
    const reason = timer ? "already_started" : permission.reason;
    if (!timer && enabled && reason === "non_production_publisher_blocked") {
      logger.warn?.("task_review_worker_not_started", {
        reason,
        tasknodeEnv: process.env.TASKNODE_ENV || process.env.NODE_ENV || "",
        appName: process.env.TASKNODE_APP_NAME || "",
      });
    }
    return { started: false, reason };
  }
  const safeInterval = Math.min(Math.max(intervalMs || 20000, 5000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 3);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await processTaskReviewQueueOnce({ limit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("task_review_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(runOnce, safeInterval);
  runOnce();
  return { started: true, intervalMs: safeInterval, batchLimit: safeBatch };
}

export const taskReviewWorkerInternalsForTests = {
  workerClaimStaleSeconds,
  existingVerificationRequestEvent,
  existingRewardReviewEvent,
  isVerificationRequestPayload,
  isRewardReviewPayload,
  taskReviewPublisherPermission,
  timelineEventPublishedRef,
  attachRewardForensics,
  buildRewardEvidenceEvaluationContext,
  buildRewardOutcomePayload,
  collectEvidenceText,
  discordAnnouncementEvidenceStatus,
  discordEvidencePolicy,
  evidencePayloadHasScreenshot,
  parseDiscordMessageLink,
  resolveDiscordAnnouncementEvidenceStatus,
  normalizeRewardScore,
};
