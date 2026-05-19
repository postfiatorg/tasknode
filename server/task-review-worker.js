import { createHash } from "node:crypto";
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

const TASK_POINTER_SCHEMA = 1;
const VERIFICATION_PROMPT_PATH = "task_engine/verification_request_v1.md";
const VERIFICATION_PROMPT_VERSION = "verification_request_v1";
const REWARD_PROMPT_PATH = "task_engine/reward_scoring_v1.md";
const REWARD_PROMPT_VERSION = "reward_scoring_v1";
const PFT_DROPS_PER_PFT = 1_000_000;

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
  const parsed = Number(process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS || 60);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 60, 60), 3600);
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
  if (Number.isFinite(offer) && offer > 0) return Math.min(parsed, offer);
  return parsed;
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

async function fetchUrlExcerpt(url = "") {
  const value = safeText(url, 1000);
  if (!value) return null;
  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(value, {
      headers: { "user-agent": "TaskNodeOfficialTaskReview/0.1" },
      signal: controller.signal,
    });
    const text = await response.text();
    clearTimeout(timerId);
    return {
      status: response.ok ? "extracted" : "http_error",
      url: value,
      http_status: response.status,
      excerpt: safeText(text.replace(/\s+/g, " "), 6000),
    };
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
  amountDrops = "1",
}) {
  const encryptedPayload = await encryptTasknodePayload({
    plaintext: stableJson(payload),
    recipientPublicKeys: [tasknodeKey.publicKey],
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

async function syncTaskWallets({ accountId, subjectWallet, authorityWallet, allocationWallet = "" }) {
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
  const reduced = await runPftlCacheReducerOnce({ batchLimit: 40, logger: console });
  return { syncs, reduced };
}

function scheduleTaskWalletSync({ accountId, subjectWallet, authorityWallet, allocationWallet = "", taskId, phase, logger = console }) {
  setTimeout(() => {
    syncTaskWallets({ accountId, subjectWallet, authorityWallet, allocationWallet })
      .then((sync) => {
        logger.info?.("task_review_projection_refresh_finished", {
          taskId,
          phase,
          syncs: Array.isArray(sync?.syncs) ? sync.syncs.length : 0,
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

async function processSubmittedTask(row, { logger = console } = {}) {
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
  const published = await publishAuthorityPointer({
    payload,
    contentKind: "TASK_UPDATE",
    destination: row.subject_wallet,
    kind: "TASK_UPDATE",
    signerWallet: authorityWallet,
    tasknodeKey,
  });
  await markWorkerPublished({
    taskId: row.task_id,
    workerName: "verification_request",
    published,
  });
  const sync = scheduleTaskWalletSync({
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    authorityWallet: authorityWallet.classicAddress,
    taskId: row.task_id,
    phase: "verification_request",
    logger,
  });
  logger.info?.("task_verification_request_published", {
    taskId: row.task_id,
    txHash: published.txHash,
    cid: published.cid,
  });
  return { ok: true, taskId: row.task_id, published, sync };
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

async function processVerificationResponse(row, { logger = console } = {}) {
  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
  const authorityWallet = walletFromSeed(authoritySeed(), "task_authority_seed_missing");
  const rewardWallet = walletFromSeed(rewardSeed(), "task_reward_seed_missing");
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
  const now = new Date().toISOString();
  const decisionPayload = {
    schema: "pf.task.reward_decision.v1",
    protocol: "tasknode.pftl",
    created_at: now,
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    task_id: row.task_id,
    event_id: `evt_${sha256({ taskId: row.task_id, score }).slice(0, 24)}`,
    actor_wallet: authorityWallet.classicAddress,
    subject_wallet: row.subject_wallet,
    authority_wallet: authorityWallet.classicAddress,
    allocation_wallet: rewardWallet.classicAddress,
    status_after: "reward_decided",
    score,
    generation: scoring.metadata,
  };
  const decision = await publishAuthorityPointer({
    payload: decisionPayload,
    contentKind: "TASK_UPDATE",
    destination: row.subject_wallet,
    kind: "TASK_UPDATE",
    signerWallet: authorityWallet,
    tasknodeKey,
  });
  let reward = null;
  const rewardPft = Number(score.reward_pft);
  if (Number.isFinite(rewardPft) && rewardPft > 0) {
    const rewardPayload = {
      schema: "pf.reward.v1",
      reward_history_schema: 1,
      protocol: "tasknode.pftl",
      created_at: new Date().toISOString(),
      chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
      task_id: row.task_id,
      event_id: `evt_${sha256({ taskId: row.task_id, rewardPft, score }).slice(0, 24)}`,
      actor_wallet: rewardWallet.classicAddress,
      subject_wallet: row.subject_wallet,
      authority_wallet: authorityWallet.classicAddress,
      allocation_wallet: rewardWallet.classicAddress,
      recipient_wallet_address: row.subject_wallet,
      reward_pft: rewardPft.toFixed(2),
      reward_tier: "task_engine_live",
      reward_score: score,
      reward_summary: score.reason,
      task_history: {
        task: taskOffer,
        submission: initialSubmission,
        verification_request: verificationRequest,
        verification_response: verificationResponse,
        reward_decision: decisionPayload,
      },
    };
    reward = await publishAuthorityPointer({
      payload: rewardPayload,
      contentKind: "REWARD",
      destination: row.subject_wallet,
      kind: "REWARD",
      signerWallet: rewardWallet,
      tasknodeKey,
      amountDrops: pftToDrops(rewardPft),
    });
  }
  await markWorkerPublished({
    taskId: row.task_id,
    workerName: "reward_scoring",
    published: {
      txHash: reward?.txHash || decision.txHash,
      cid: reward?.cid || decision.cid,
    },
  });
  const sync = scheduleTaskWalletSync({
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    authorityWallet: authorityWallet.classicAddress,
    allocationWallet: rewardWallet.classicAddress,
    taskId: row.task_id,
    phase: "reward_scoring",
    logger,
  });
  logger.info?.("task_reward_decision_published", {
    taskId: row.task_id,
    decisionTxHash: decision.txHash,
    rewardTxHash: reward?.txHash || "",
    rewardPft: score.reward_pft,
  });
  return { ok: true, taskId: row.task_id, decision, reward, sync };
}

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
  if (timer || !enabled) return { started: false, reason: timer ? "already_started" : "disabled" };
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
