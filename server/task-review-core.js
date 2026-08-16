import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { query, transaction } from "./db/pool.js";
import { moneySeedFromEnv } from "./production-guards.js";

export const TASK_POINTER_SCHEMA = 1;
export const VERIFICATION_PROMPT_PATH = "task_engine/verification_request_v1.md";
export const VERIFICATION_PROMPT_VERSION = "verification_request_v1";
export const REWARD_PROMPT_PATH = "task_engine/reward_scoring_v1.md";
export const REWARD_PROMPT_VERSION = "reward_scoring_v1";
export const PFT_DROPS_PER_PFT = 1_000_000;
export const REWARD_CARRIER_DROPS = "1";
export const URL_EXCERPT_MAX_CHARS = 6000;
export const GIST_EXCERPT_MAX_CHARS = 30_000;
export const GIST_MAX_FILES = 50;
export const URL_FETCH_TIMEOUT_MS = 8000;
export const URL_REDIRECT_MAX_HOPS = 5;
export const TASK_REVIEW_USER_AGENT = "TaskNodeOfficialTaskReview/0.1";
export const TASK_REVIEW_RETRY_BASE_MS = 60_000;
export const TASK_REVIEW_RETRY_MAX_MS = 15 * 60_000;

export const verificationResponseFormat = {
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

export const rewardResponseFormat = {
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

export function workerClaimStaleSeconds() {
  const parsed = Number(process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS || 900);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 900, 300), 3600);
}

export function taskReviewPublisherPermission({
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

export function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

export function authoritySeed(env = process.env) {
  return safeText(
    env.TASKNODE_AUTHORITY_SEED ||
      env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

export function rewardSeed(env = process.env) {
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

export function walletFromSeed(seed, code) {
  if (!seed) throw new Error(code);
  return Wallet.fromSeed(seed);
}

export function parseJsonObject(text = "") {
  return JSON.parse(String(text || "").trim());
}

export function clampInteger(value, fallback = 0, min = 0, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeReward(value, offerPft = 0) {
  const parsed = Number(value);
  const offer = Number(offerPft);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // The model-supplied reward is scored over untrusted user evidence. Only honor it
  // when a positive authority offer exists to clamp against; without a trusted upper
  // bound, fail closed to 0 rather than paying an unbounded model-chosen amount.
  if (Number.isFinite(offer) && offer > 0) return Math.min(parsed, offer);
  return 0;
}

export function eventSchema(event = {}) {
  return safeText(event?.schema || safeObject(event?.rawPayload).schema, 120);
}

export function latestRewardPaymentEvent(detail = {}) {
  const timeline = Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [];
  return timeline.filter((event) => eventSchema(event) === "pf.reward.v1").pop() || null;
}

export function rewardPaymentGuard(metadata = {}) {
  return safeObject(metadata?.reward_payment_guard);
}

export function rewardPaymentGuardStatus(guard = {}) {
  return safeText(guard.status, 80).toLowerCase();
}

export function rewardPaymentGuardBlocksRetry(guard = {}) {
  return ["submitting", "submitted", "submit_unknown"].includes(rewardPaymentGuardStatus(guard));
}

export function rewardPaymentGuardCanSkipPreflightSync(guard = {}) {
  return rewardPaymentGuardStatus(guard) === "retry_wait";
}

export function submissionDefinitelyNotAttempted(error) {
  return error?.submissionAttempted === false;
}

export function taskReviewRetryDelayMs(retryCount = 0) {
  const boundedCount = Math.min(Math.max(Number(retryCount) || 0, 0), 10);
  return Math.min(TASK_REVIEW_RETRY_BASE_MS * (2 ** boundedCount), TASK_REVIEW_RETRY_MAX_MS);
}

export function rewardPaymentGuardPayload({ taskId = "", rewardPayload = {}, rewardPft = 0 } = {}) {
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

export async function claimRewardPaymentGuard({ taskId = "", rewardPayload = {}, rewardPft = 0 } = {}) {
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

export async function updateRewardPaymentGuard({ taskId = "", patch = {} } = {}) {
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

export async function markRewardPaymentSubmitted({ taskId = "", reward = {} } = {}) {
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

export async function markRewardPaymentSubmitUnknown({ taskId = "", error = "" } = {}) {
  return updateRewardPaymentGuard({
    taskId,
    patch: {
      status: "submit_unknown",
      last_error: safeText(error, 1000),
    },
  });
}

export async function markRewardPaymentRetryWait({ taskId = "", error = "", retryAfter = "" } = {}) {
  return updateRewardPaymentGuard({
    taskId,
    patch: {
      status: "retry_wait",
      last_error: safeText(error, 1000),
      retry_after: safeText(retryAfter, 80),
    },
  });
}

export function pftToDrops(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return String(Math.round(parsed * PFT_DROPS_PER_PFT));
}

export function eventPayloads(detail = {}) {
  return (Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [])
    .map((event) => safeObject(event?.rawPayload))
    .filter((payload) => payload.schema);
}

export function timelineEvents(detail = {}) {
  return Array.isArray(detail?.forensics?.timeline) ? detail.forensics.timeline : [];
}

export function eventRawPayload(event = {}) {
  return safeObject(event?.rawPayload || event?.payload || event?.payloadJson);
}

export function timelineEventPublishedRef(event = {}) {
  return {
    txHash: safeText(event.txHash || event.sourceTxHash || event.tx_hash || "", 120),
    cid: safeText(event.cid || event.sourceCid || event.source_cid || "", 240),
  };
}

export function isVerificationRequestPayload(payload = {}) {
  return (
    payload.schema === "pf.task.verification_request.v1" ||
    (
      payload.schema === "pf.task.update.v1" &&
      safeText(payload.transition || payload.status_after || payload.status, 80) === "verification_requested"
    )
  );
}

export function isRewardReviewPayload(payload = {}) {
  return payload.schema === "pf.reward.v1";
}

export function latestTimelineEvent(detail = {}, predicate = () => false) {
  const events = timelineEvents(detail);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(eventRawPayload(event))) return event;
  }
  return null;
}

export function existingVerificationRequestEvent(detail = {}) {
  return latestTimelineEvent(detail, isVerificationRequestPayload);
}

export function existingRewardReviewEvent(detail = {}) {
  return latestTimelineEvent(detail, isRewardReviewPayload);
}

export function latestPayloadBySchema(payloads = [], schemas = []) {
  const wanted = new Set(schemas);
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    if (wanted.has(payloads[index]?.schema)) return payloads[index];
  }
  return null;
}

export function latestVerificationRequestPayload(payloads = []) {
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

export function isInitialSubmissionPayload(payload = {}) {
  if (payload?.schema !== "pf.task.submission.v1") return false;
  const transition = safeText(payload.transition || payload.status_after || payload.status, 80);
  if (transition === "verification_response_submitted") return false;
  return safeText(payload.phase, 80) !== "verification_response";
}

export function latestInitialSubmissionPayload(payloads = []) {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    if (isInitialSubmissionPayload(payloads[index])) return payloads[index];
  }
  return null;
}

export function isVerificationResponsePayload(payload = {}) {
  if (payload?.schema === "pf.task.verification_response.v1") return true;
  const transition = safeText(payload.transition || payload.status_after || payload.status, 80);
  if (transition === "verification_response_submitted") return true;
  return payload?.schema === "pf.task.submission.v1" && safeText(payload.phase, 80) === "verification_response";
}

export function latestVerificationResponsePayload(payloads = []) {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    if (isVerificationResponsePayload(payloads[index])) return payloads[index];
  }
  return null;
}
