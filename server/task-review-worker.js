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
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";

const TASK_POINTER_SCHEMA = 1;
const VERIFICATION_PROMPT_PATH = "task_engine/verification_request_v1.md";
const VERIFICATION_PROMPT_VERSION = "verification_request_v1";
const REWARD_PROMPT_PATH = "task_engine/reward_scoring_v1.md";
const REWARD_PROMPT_VERSION = "reward_scoring_v1";
const PFT_DROPS_PER_PFT = 1_000_000;
const REWARD_CARRIER_DROPS = "1";

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
  return safeText(
    env.TASKNODE_REWARD_SEED ||
      env.TASKNODE_ALLOCATION_SEED ||
      env.TASKNODE_AUTHORITY_SEED ||
      env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
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

async function resolveSafeEvidenceUrl(url = "") {
  const literal = isSafeEvidenceUrlLiteral(url);
  if (!literal.ok) return literal;
  const hostname = hostnameValue(literal.url.hostname);
  if (!isIP(hostname)) {
    try {
      const addresses = await lookup(hostname, { all: true });
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

async function fetchUrlExcerpt(url = "") {
  const value = safeText(url, 1000);
  if (!value) return null;
  const safety = await resolveSafeEvidenceUrl(value);
  if (!safety.ok) {
    return {
      status: "blocked",
      url: value,
      error: safety.reason || "evidence_url_not_allowed",
    };
  }
  let timerId = null;
  try {
    const controller = new AbortController();
    timerId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(safety.url.href, {
      headers: { "user-agent": "TaskNodeOfficialTaskReview/0.1" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        status: "redirect_not_followed",
        url: safety.url.href,
        http_status: response.status,
        location: safeText(response.headers.get("location") || "", 1000),
      };
    }
    const text = await response.text();
    return {
      status: response.ok ? "extracted" : "http_error",
      url: safety.url.href,
      http_status: response.status,
      excerpt: safeText(text.replace(/\s+/g, " "), 6000),
    };
  } catch (error) {
    return {
      status: "fetch_failed",
      url: value,
      error: safeText(error?.message || error, 500),
    };
  } finally {
    if (timerId) clearTimeout(timerId);
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
    } else {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}

function normalizeRewardScore(output = {}, offerPft = 0) {
  const decision = safeText(output.decision, 80);
  const rewardPft = decision === "reject" ? 0 : normalizeReward(output.reward_pft, offerPft);
  return {
    decision: rewardPft > 0 ? (decision === "partial_reward" ? "partial_reward" : "reward") : "reject",
    reward_pft: rewardPft.toFixed(2),
    completion: clampInteger(output.completion, 0),
    evidence_quality: clampInteger(output.evidence_quality, 0),
    reason: safeText(output.reason, 2000),
    user_feedback: safeText(output.user_feedback, 2000),
  };
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

  const publicationLock = await acquireReviewPublicationLock({
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

  let publicationAttempted = false;
  let reward = null;
  try {
    const [processedInitial, processedVerification] = await Promise.all([
      processedEvidenceFromPayload(initialSubmission),
      processedEvidenceFromPayload(verificationResponse),
    ]);
    const offerPft = Number(taskOffer?.reward_offer?.amount_estimate_pft || row.reward_offer_pft || 0);
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
      },
    });
    const score = normalizeRewardScore(scoring.output, offerPft);
    const {
      payload: rewardPayload,
      rewardAmountDrops,
      economicRewardPft,
    } = buildRewardOutcomePayload({
      row,
      score,
      scoringMetadata: scoring.metadata,
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
    };
    await markReviewPublicationPublished({
      taskId: row.task_id,
      workerName,
      published: publishedRef,
      metadata: {
        source: "published_by_worker",
        reward_tx_hash: reward.txHash,
        reward_cid: reward.cid,
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
    } else {
      await releaseReviewPublicationLock({ taskId: row.task_id, workerName }).catch(() => null);
    }
    throw error;
  }
}

export const taskReviewWorkerInternals = {
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
  buildRewardOutcomePayload,
};
