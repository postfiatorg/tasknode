import fs from "node:fs/promises";
import pg from "pg";

import { fetchHistoricalAccountTransactions, extractPftPointerEvents } from "../server/context-history-rpc.js";
import { fetchContextIpfsJson } from "../server/context-ipfs.js";
import { fetchAndDecryptTasknodePayload } from "../server/task-payloads.js";
import {
  configuredDeathmarchUserMnemonic,
  decryptTasknodeUserMnemonicPayload,
} from "./deathmarch-identity.mjs";

const { Pool } = pg;

const TASK_KIND_LABELS = new Set(["TASK", "TASK_UPDATE", "TASK_SUBMISSION", "REWARD"]);
const TASK_SCHEMAS = new Set([
  "pf.task.request.v1",
  "pf.task.offer.v1",
  "pf.task.update.v1",
  "pf.task.submission.v1",
  "pf.task.verification_response.v1",
  "pf.reward.v1",
]);
let deathmarchDbPool = null;

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function safeErrorCode(error) {
  return safeText(error?.code || error?.message || error?.name || "deathmarch_error", 240)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .slice(0, 240);
}

function deathmarchDatabaseUrl(env = process.env) {
  return safeText(env.DEATHMARCH_DATABASE_URL || env.DATABASE_URL || "", 4000);
}

function databaseEventsEnabled(env = process.env) {
  return env.DEATHMARCH_DATABASE_EVENTS_ENABLED !== "false" && Boolean(deathmarchDatabaseUrl(env));
}

export function observeDeathmarchDatabasePool(pool, { logger = console } = {}) {
  if (!pool || typeof pool.on !== "function") {
    throw new Error("deathmarch_database_pool_invalid");
  }
  pool.on("error", (error) => {
    try {
      logger.error?.(`deathmarch_database_pool_error:${safeErrorCode(error)}`);
    } catch {
      // A logger failure must never turn a recoverable idle-client error into a process crash.
    }
  });
  return pool;
}

async function deathmarchDatabaseQuery(text, params = [], env = process.env) {
  const connectionString = deathmarchDatabaseUrl(env);
  if (!connectionString) throw new Error("deathmarch_database_url_missing");
  if (!deathmarchDbPool) {
    deathmarchDbPool = observeDeathmarchDatabasePool(new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: clampInteger(env.DEATHMARCH_DATABASE_CONNECTION_TIMEOUT_MS, 5000, 500, 60000),
      idleTimeoutMillis: clampInteger(env.DEATHMARCH_DATABASE_IDLE_TIMEOUT_MS, 30000, 1000, 300000),
      query_timeout: clampInteger(env.DEATHMARCH_DATABASE_QUERY_TIMEOUT_MS, 10000, 500, 120000),
      application_name: "tasknodeofficial:deathmarch",
    }));
  }
  return deathmarchDbPool.query(text, params);
}

function normalizeActionKind({ schema = "", payload = {}, pointer = {} } = {}) {
  const normalizedSchema = safeText(schema || payload.schema || payload.event_type, 160);
  const phase = safeText(payload.phase, 120);
  const transition = safeText(payload.transition || payload.status_after || payload.status, 120);
  const kind = safeText(pointer.kindLabel || pointer.kind || payload.kind, 120).toUpperCase();
  if (normalizedSchema === "pf.task.request.v1") return "task_request";
  if (normalizedSchema === "pf.task.offer.v1") return "task_offer";
  if (normalizedSchema === "pf.task.update.v1") return transition ? `task_update_${transition}` : "task_update";
  if (normalizedSchema === "pf.task.submission.v1" && phase === "verification_response") return "verification_response";
  if (normalizedSchema === "pf.task.submission.v1") return "initial_verification";
  if (normalizedSchema === "pf.task.verification_response.v1") return "verification_response";
  if (normalizedSchema === "pf.reward.v1") return "reward_outcome";
  if (kind === "TASK_SUBMISSION") return "task_submission";
  if (kind === "TASK_UPDATE") return "task_update";
  return "task_pointer";
}

function normalizeEvent(input = {}) {
  const row = safeObject(input);
  const payload = safeObject(row.payload || row.rawPayload || row.payload_json || row.payloadJson);
  const pointer = safeObject(row.pointer || row.pointer_json || row.pointerJson);
  const schema = safeText(
    row.event_type || row.eventType || row.schema || payload.schema || pointer.schema || "",
    180
  );
  const txHash = safeText(
    row.source_tx_hash || row.sourceTxHash || row.tx_hash || row.txHash || pointer.txHash || pointer.tx_hash || "",
    180
  ).toUpperCase();
  const cid = safeText(row.source_cid || row.sourceCid || row.cid || pointer.cid || "", 240);
  const taskId = safeText(
    row.task_id || row.taskId || payload.task_id || payload.taskId || pointer.taskId || pointer.task_id || "",
    180
  );
  const normalized = {
    schema,
    actionKind: normalizeActionKind({ schema, payload, pointer }),
    taskId,
    txHash,
    cid,
    memoIndex: row.memo_index ?? row.memoIndex ?? pointer.memoIndex ?? pointer.memo_index ?? 0,
    occurredAt: safeText(row.occurred_at || row.occurredAt || row.created_at || row.createdAt || pointer.createdAt || "", 80),
    pointerKind: safeText(row.pointer_kind || row.pointerKind || pointer.kindLabel || pointer.kind || "", 80),
    payload,
    pointer,
    raw: row,
  };
  normalized.eventKey = [
    normalized.txHash || "no_tx",
    normalized.memoIndex,
    normalized.cid || "no_cid",
    normalized.schema || normalized.actionKind,
  ].join(":");
  return normalized;
}

function fileEventsFromValue(value) {
  if (Array.isArray(value)) return value.flatMap(fileEventsFromValue);
  const object = safeObject(value);
  if (Array.isArray(object.traced_events)) return object.traced_events;
  if (Array.isArray(object.reward_events)) return object.reward_events;
  if (Array.isArray(object.events)) return object.events;
  if (Array.isArray(object.samples)) return object.samples.flatMap((sample) => {
    return safeArray(sample.reward_events).map((event) => ({
      ...event,
      task_id: event.task_id || sample.task_id,
      title: sample.title,
      project_id: sample.project_id,
    }));
  });
  return [object];
}

export function isDeathmarchTaskEvent(event = {}) {
  const schema = safeText(event.schema || event.payload?.schema, 120);
  if (schema === "pf.daily_airdrop.v1") return false;
  if (schema === "pf.task.reward_decision.v1") return false;
  if (TASK_SCHEMAS.has(schema)) return true;
  const pointerKind = safeText(event.pointerKind || event.pointer?.kindLabel || "", 120).toUpperCase();
  if (pointerKind === "REWARD") return false;
  return TASK_KIND_LABELS.has(pointerKind);
}

async function loadEventsFromFile(filePath) {
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  return fileEventsFromValue(value).map(normalizeEvent).filter(isDeathmarchTaskEvent);
}

async function fetchAndDecryptDeathmarchPayload({ cid, env = process.env } = {}) {
  try {
    return await fetchAndDecryptTasknodePayload({ cid, env });
  } catch (serviceError) {
    const mnemonic = configuredDeathmarchUserMnemonic(env);
    if (!mnemonic) throw serviceError;
    try {
      const fetched = await fetchContextIpfsJson({ cid });
      if (!fetched?.ok) throw new Error(fetched?.error || "task_ipfs_fetch_failed");
      const payload = await decryptTasknodeUserMnemonicPayload({ blob: fetched.payload, mnemonic });
      return { cid: fetched.cid || cid, gateway: fetched.gateway || "", payload };
    } catch (userError) {
      const error = new Error(`task_payload_decrypt_failed:service=${serviceError?.message || serviceError}:user=${userError?.message || userError}`);
      error.serviceError = serviceError;
      error.userError = userError;
      throw error;
    }
  }
}

async function loadEventsFromWallet({ wallet, limit, maxPages, env = process.env } = {}) {
  const history = await fetchHistoricalAccountTransactions({ walletAddress: wallet, limit, maxPages, env });
  const pointers = extractPftPointerEvents(history.transactions, wallet)
    .filter((pointer) => TASK_KIND_LABELS.has(safeText(pointer.kindLabel, 80).toUpperCase()));
  const events = [];
  for (const pointer of pointers) {
    let payload = {};
    let payloadError = "";
    try {
      const decrypted = await fetchAndDecryptDeathmarchPayload({ cid: pointer.cid, env });
      payload = safeObject(decrypted.payload);
    } catch (error) {
      payloadError = error?.message || String(error);
    }
    events.push(normalizeEvent({
      schema: payload.schema || "",
      task_id: payload.task_id || pointer.taskId || "",
      source_tx_hash: pointer.txHash,
      source_cid: pointer.cid,
      memo_index: pointer.memoIndex,
      occurred_at: pointer.createdAt,
      pointer_kind: pointer.kindLabel,
      pointer,
      payload: payloadError ? { schema: payload.schema || "", task_id: pointer.taskId || "", payload_error: payloadError } : payload,
    }));
  }
  return events.sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt || "") || 0;
    const rightTime = Date.parse(right.occurredAt || "") || 0;
    return leftTime - rightTime;
  });
}

export function databaseRowsToDeathmarchEvents(rows = []) {
  return safeArray(rows).map(normalizeEvent).filter(isDeathmarchTaskEvent);
}

async function loadEventsFromDatabase({
  wallet,
  limit,
  env = process.env,
  queryImpl = deathmarchDatabaseQuery,
} = {}) {
  if (!databaseEventsEnabled(env)) return [];
  const boundedLimit = clampInteger(limit, 100, 20, 400);
  const walletAddress = safeText(wallet, 120);
  const eventTypes = Array.from(TASK_SCHEMAS);
  const result = await queryImpl(
    `SELECT *
       FROM (
         SELECT event_type,
                task_id,
                source_tx_hash,
                source_cid,
                occurred_at,
                wallet_address,
                payload_json,
                pointer_json
           FROM task_events
          WHERE event_type = ANY($1::text[])
            AND (
              $2::text = ''
              OR wallet_address = $2
              OR payload_json->>'wallet_address' = $2
              OR payload_json->>'subject_wallet' = $2
              OR payload_json->>'authority_wallet' = $2
            )
          ORDER BY occurred_at DESC, created_at DESC
          LIMIT $3
       ) recent
      ORDER BY occurred_at ASC`,
    [eventTypes, walletAddress, boundedLimit],
    env
  );
  return databaseRowsToDeathmarchEvents(result.rows);
}

function mergeDeathmarchEvents(...groups) {
  const byKey = new Map();
  for (const event of groups.flat()) {
    if (!event?.eventKey || byKey.has(event.eventKey)) continue;
    byKey.set(event.eventKey, event);
  }
  return Array.from(byKey.values()).sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt || "") || 0;
    const rightTime = Date.parse(right.occurredAt || "") || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return safeText(left.eventKey, 500).localeCompare(safeText(right.eventKey, 500));
  });
}

export async function loadDeathmarchEvents({
  file = "",
  wallet = "",
  limit = 100,
  maxPages = 1,
  env = process.env,
} = {}) {
  if (file) return loadEventsFromFile(file);
  const boundedLimit = clampInteger(limit, 100, 20, 400);
  return mergeDeathmarchEvents(
    await loadEventsFromWallet({
      wallet,
      limit: boundedLimit,
      maxPages: clampInteger(maxPages, 1, 1, 30),
      env,
    }),
    await loadEventsFromDatabase({ wallet, limit: boundedLimit, env })
  );
}
