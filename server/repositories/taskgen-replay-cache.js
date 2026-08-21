import { createHash } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

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

function jsonValue(value = {}) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function useDatabase() {
  return databaseEnabled();
}

export function buildTaskgenReplayKey(identity = {}) {
  return `taskgen_${sha256({
    schema: "pf.taskgen.replay_key.v1",
    request_id: safeText(identity.request_id || identity.requestId, 180),
    request_bundle_cid: safeText(identity.request_bundle_cid || identity.requestBundleCid, 240),
    request_bundle_digest: safeText(identity.request_bundle_digest || identity.requestBundleDigest, 180),
    source_payload_digest: safeText(identity.source_payload_digest || identity.sourcePayloadDigest, 180),
    input_packet_digest: safeText(identity.input_packet_digest || identity.inputPacketDigest, 180),
    prompt_version: safeText(identity.prompt_version || identity.promptVersion, 120),
    prompt_digest: safeText(identity.prompt_digest || identity.promptDigest, 180),
    model: safeText(identity.model, 160),
    task_class: safeText(identity.task_class || identity.taskClass, 80),
    reward_policy_version: safeText(identity.reward_policy_version || identity.rewardPolicyVersion, 120),
    deadline_policy_version: safeText(identity.deadline_policy_version || identity.deadlinePolicyVersion, 120),
  }).slice(0, 48)}`;
}

export function hasGeneratedTaskgenReplay(replay = {}) {
  const item = safeObject(replay);
  return Boolean(
    safeText(item.replayKey || item.replay_key, 180) &&
      safeText(item.taskId || item.task_id, 180) &&
      Object.keys(safeObject(item.taskgenOutput || item.taskgen_output_json)).length > 0
  );
}

export function hasPublishedTaskgenReplay(replay = {}) {
  const item = safeObject(replay);
  return Boolean(
    hasGeneratedTaskgenReplay(item) &&
      safeText(item.status, 80) === "published" &&
      safeText(item.offerCid || item.offer_cid, 240) &&
      safeText(item.offerTxHash || item.offer_tx_hash, 180)
  );
}

function replayRow(row = {}) {
  if (!row?.replay_key) return null;
  return {
    replayKey: row.replay_key,
    status: row.status || "",
    requestId: row.request_id || "",
    requestBundleCid: row.request_bundle_cid || "",
    requestBundleDigest: row.request_bundle_digest || "",
    sourcePayloadDigest: row.source_payload_digest || "",
    inputPacketDigest: row.input_packet_digest || "",
    promptVersion: row.prompt_version || "",
    promptDigest: row.prompt_digest || "",
    model: row.model || "",
    taskClass: row.task_class || "",
    rewardPolicyVersion: row.reward_policy_version || "",
    deadlinePolicyVersion: row.deadline_policy_version || "",
    taskId: row.task_id || "",
    subjectWallet: row.subject_wallet || "",
    offerCid: row.offer_cid || "",
    offerDigest: row.offer_digest || "",
    offerTxHash: row.offer_tx_hash || "",
    taskgenOutput: safeObject(row.taskgen_output_json),
    taskgenMetadata: safeObject(row.taskgen_metadata_json),
    offerPayload: safeObject(row.offer_payload_json),
    replayIdentity: safeObject(row.replay_identity_json),
    generatedAt: row.generated_at ? row.generated_at.toISOString?.() || String(row.generated_at) : null,
    publishedAt: row.published_at ? row.published_at.toISOString?.() || String(row.published_at) : null,
    lastError: row.last_error || "",
  };
}

export async function getTaskgenReplay(replayKey = "") {
  if (!useDatabase()) return null;
  const normalized = safeText(replayKey, 180);
  if (!normalized) return null;
  const result = await query("SELECT * FROM taskgen_replay_cache WHERE replay_key = $1 LIMIT 1", [normalized]);
  return replayRow(result.rows[0]);
}

export async function recordTaskgenReplayGenerated({
  replayKey = "",
  identity = {},
  taskId = "",
  subjectWallet = "",
  taskgenOutput = {},
  taskgenMetadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedKey = safeText(replayKey, 180);
  if (!normalizedKey) return { ok: false, skipped: true, reason: "replay_key_missing" };
  const result = await query(
    `
      INSERT INTO taskgen_replay_cache (
        replay_key,
        status,
        request_id,
        request_bundle_cid,
        request_bundle_digest,
        source_payload_digest,
        input_packet_digest,
        prompt_version,
        prompt_digest,
        model,
        task_class,
        reward_policy_version,
        deadline_policy_version,
        task_id,
        subject_wallet,
        taskgen_output_json,
        taskgen_metadata_json,
        replay_identity_json,
        generated_at,
        last_error
      )
      VALUES (
        $1, 'generated', $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, now(), ''
      )
      ON CONFLICT (replay_key) DO UPDATE SET
        request_id = COALESCE(NULLIF(EXCLUDED.request_id, ''), taskgen_replay_cache.request_id),
        request_bundle_cid = COALESCE(NULLIF(EXCLUDED.request_bundle_cid, ''), taskgen_replay_cache.request_bundle_cid),
        request_bundle_digest = COALESCE(NULLIF(EXCLUDED.request_bundle_digest, ''), taskgen_replay_cache.request_bundle_digest),
        source_payload_digest = COALESCE(NULLIF(EXCLUDED.source_payload_digest, ''), taskgen_replay_cache.source_payload_digest),
        input_packet_digest = COALESCE(NULLIF(EXCLUDED.input_packet_digest, ''), taskgen_replay_cache.input_packet_digest),
        prompt_version = COALESCE(NULLIF(EXCLUDED.prompt_version, ''), taskgen_replay_cache.prompt_version),
        prompt_digest = COALESCE(NULLIF(EXCLUDED.prompt_digest, ''), taskgen_replay_cache.prompt_digest),
        model = COALESCE(NULLIF(EXCLUDED.model, ''), taskgen_replay_cache.model),
        task_class = COALESCE(NULLIF(EXCLUDED.task_class, ''), taskgen_replay_cache.task_class),
        reward_policy_version = COALESCE(NULLIF(EXCLUDED.reward_policy_version, ''), taskgen_replay_cache.reward_policy_version),
        deadline_policy_version = COALESCE(NULLIF(EXCLUDED.deadline_policy_version, ''), taskgen_replay_cache.deadline_policy_version),
        task_id = CASE
          WHEN taskgen_replay_cache.status = 'published' THEN taskgen_replay_cache.task_id
          ELSE COALESCE(NULLIF(EXCLUDED.task_id, ''), taskgen_replay_cache.task_id)
        END,
        subject_wallet = CASE
          WHEN taskgen_replay_cache.status = 'published' THEN taskgen_replay_cache.subject_wallet
          ELSE COALESCE(NULLIF(EXCLUDED.subject_wallet, ''), taskgen_replay_cache.subject_wallet)
        END,
        taskgen_output_json = CASE
          WHEN taskgen_replay_cache.status = 'published' THEN taskgen_replay_cache.taskgen_output_json
          WHEN EXCLUDED.taskgen_output_json <> '{}'::jsonb THEN EXCLUDED.taskgen_output_json
          WHEN taskgen_replay_cache.taskgen_output_json = '{}'::jsonb THEN EXCLUDED.taskgen_output_json
          ELSE taskgen_replay_cache.taskgen_output_json
        END,
        taskgen_metadata_json = taskgen_replay_cache.taskgen_metadata_json || EXCLUDED.taskgen_metadata_json,
        replay_identity_json = taskgen_replay_cache.replay_identity_json || EXCLUDED.replay_identity_json,
        status = CASE
          WHEN taskgen_replay_cache.status = 'published' THEN 'published'
          ELSE 'generated'
        END,
        generated_at = CASE
          WHEN taskgen_replay_cache.status = 'published' THEN taskgen_replay_cache.generated_at
          ELSE now()
        END,
        last_error = '',
        updated_at = now()
      RETURNING *
    `,
    [
      normalizedKey,
      safeText(identity.request_id || identity.requestId, 180),
      safeText(identity.request_bundle_cid || identity.requestBundleCid, 240),
      safeText(identity.request_bundle_digest || identity.requestBundleDigest, 180),
      safeText(identity.source_payload_digest || identity.sourcePayloadDigest, 180),
      safeText(identity.input_packet_digest || identity.inputPacketDigest, 180),
      safeText(identity.prompt_version || identity.promptVersion, 120),
      safeText(identity.prompt_digest || identity.promptDigest, 180),
      safeText(identity.model, 160),
      safeText(identity.task_class || identity.taskClass, 80),
      safeText(identity.reward_policy_version || identity.rewardPolicyVersion, 120),
      safeText(identity.deadline_policy_version || identity.deadlinePolicyVersion, 120),
      safeText(taskId, 180),
      safeText(subjectWallet, 120),
      jsonValue(taskgenOutput),
      jsonValue(taskgenMetadata),
      jsonValue(identity),
    ]
  );
  return { ok: true, replay: replayRow(result.rows[0]) };
}

export async function recordTaskgenReplayPublished({
  replayKey = "",
  identity = {},
  taskId = "",
  subjectWallet = "",
  offerCid = "",
  offerDigest = "",
  offerTxHash = "",
  taskgenOutput = {},
  taskgenMetadata = {},
  offerPayload = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedKey = safeText(replayKey, 180);
  if (!normalizedKey) return { ok: false, skipped: true, reason: "replay_key_missing" };
  const result = await query(
    `
      INSERT INTO taskgen_replay_cache (
        replay_key,
        status,
        request_id,
        request_bundle_cid,
        request_bundle_digest,
        source_payload_digest,
        input_packet_digest,
        prompt_version,
        prompt_digest,
        model,
        task_class,
        reward_policy_version,
        deadline_policy_version,
        task_id,
        subject_wallet,
        offer_cid,
        offer_digest,
        offer_tx_hash,
        taskgen_output_json,
        taskgen_metadata_json,
        offer_payload_json,
        replay_identity_json,
        generated_at,
        published_at,
        last_error
      )
      VALUES (
        $1, 'published', $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17,
        $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, now(), now(), ''
      )
      ON CONFLICT (replay_key) DO UPDATE SET
        status = 'published',
        task_id = COALESCE(NULLIF(taskgen_replay_cache.task_id, ''), EXCLUDED.task_id),
        subject_wallet = COALESCE(NULLIF(taskgen_replay_cache.subject_wallet, ''), EXCLUDED.subject_wallet),
        offer_cid = COALESCE(NULLIF(taskgen_replay_cache.offer_cid, ''), EXCLUDED.offer_cid),
        offer_digest = COALESCE(NULLIF(taskgen_replay_cache.offer_digest, ''), EXCLUDED.offer_digest),
        offer_tx_hash = COALESCE(NULLIF(taskgen_replay_cache.offer_tx_hash, ''), EXCLUDED.offer_tx_hash),
        taskgen_output_json = CASE
          WHEN taskgen_replay_cache.taskgen_output_json = '{}'::jsonb THEN EXCLUDED.taskgen_output_json
          ELSE taskgen_replay_cache.taskgen_output_json
        END,
        taskgen_metadata_json = taskgen_replay_cache.taskgen_metadata_json || EXCLUDED.taskgen_metadata_json,
        offer_payload_json = CASE
          WHEN taskgen_replay_cache.offer_payload_json = '{}'::jsonb THEN EXCLUDED.offer_payload_json
          ELSE taskgen_replay_cache.offer_payload_json
        END,
        replay_identity_json = taskgen_replay_cache.replay_identity_json || EXCLUDED.replay_identity_json,
        published_at = COALESCE(taskgen_replay_cache.published_at, now()),
        last_error = '',
        updated_at = now()
      RETURNING *
    `,
    [
      normalizedKey,
      safeText(identity.request_id || identity.requestId, 180),
      safeText(identity.request_bundle_cid || identity.requestBundleCid, 240),
      safeText(identity.request_bundle_digest || identity.requestBundleDigest, 180),
      safeText(identity.source_payload_digest || identity.sourcePayloadDigest, 180),
      safeText(identity.input_packet_digest || identity.inputPacketDigest, 180),
      safeText(identity.prompt_version || identity.promptVersion, 120),
      safeText(identity.prompt_digest || identity.promptDigest, 180),
      safeText(identity.model, 160),
      safeText(identity.task_class || identity.taskClass, 80),
      safeText(identity.reward_policy_version || identity.rewardPolicyVersion, 120),
      safeText(identity.deadline_policy_version || identity.deadlinePolicyVersion, 120),
      safeText(taskId, 180),
      safeText(subjectWallet, 120),
      safeText(offerCid, 240),
      safeText(offerDigest, 180),
      safeText(offerTxHash, 180),
      jsonValue(taskgenOutput),
      jsonValue(taskgenMetadata),
      jsonValue(offerPayload),
      jsonValue(identity),
    ]
  );
  return { ok: true, replay: replayRow(result.rows[0]) };
}

export async function markTaskgenReplayFailed({ replayKey = "", error = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedKey = safeText(replayKey, 180);
  if (!normalizedKey) return { ok: false, skipped: true, reason: "replay_key_missing" };
  const result = await query(
    `
      UPDATE taskgen_replay_cache
      SET status = CASE WHEN status = 'published' THEN 'published' ELSE 'failed' END,
          last_error = $2,
          updated_at = now()
      WHERE replay_key = $1
      RETURNING *
    `,
    [normalizedKey, safeText(error, 1000)]
  );
  return { ok: true, updated: result.rowCount || 0, replay: replayRow(result.rows[0]) };
}

export async function findPublishedTaskgenOfferByTaskId({ taskId = "", requestId = "" } = {}) {
  if (!useDatabase()) return null;
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return null;
  const result = await query(
    `
      SELECT task_id, source_cid, source_tx_hash, payload_json, occurred_at
      FROM task_events
      WHERE task_id = $1
        AND event_type = 'pf.task.offer.v1'
        AND ($2::text = '' OR payload_json->>'request_id' = $2)
      ORDER BY occurred_at ASC, id ASC
      LIMIT 1
    `,
    [normalizedTaskId, safeText(requestId, 180)]
  );
  const row = result.rows[0];
  if (!row?.task_id) return null;
  return {
    taskId: row.task_id,
    subjectWallet: safeText(row.payload_json?.subject_wallet, 120),
    offerPayload: safeObject(row.payload_json),
    offerCid: row.source_cid || "",
    offerDigest: "",
    txHash: row.source_tx_hash || "",
    occurredAt: row.occurred_at ? row.occurred_at.toISOString?.() || String(row.occurred_at) : null,
    replayed: true,
    recoveredFromTaskEvents: true,
  };
}
