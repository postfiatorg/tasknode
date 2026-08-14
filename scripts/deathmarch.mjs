#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import sodium from "libsodium-wrappers";
import pg from "pg";

import { fetchHistoricalAccountTransactions, extractPftPointerEvents } from "../server/context-history-rpc.js";
import { fetchContextIpfsJson } from "../server/context-ipfs.js";
import { fetchAndDecryptTasknodePayload } from "../server/task-payloads.js";
import { AMBIENT_MODELS, ambientChatCompletion, ambientConfigured } from "../server/ambient-inference.js";

const { Pool } = pg;

const DEFAULT_WALLET = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const DEFAULT_STATE_PATH = ".deathmarch-state.json";
const DEFAULT_SEED_FILE = "deathmarchseed.txt";
const DEFAULT_AMBIENT_MODEL = AMBIENT_MODELS.structured;
const DEFAULT_AMBIENT_TIMEOUT_MS = 20000;
const DEFAULT_DISCORD_TIMEOUT_MS = 10000;
const CLASSIFIER_FAILURE_CATEGORY = "classification unavailable";
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

function compactWhitespace(value = "") {
  return safeText(value, 4000).replace(/\s+/g, " ").trim();
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function boolFlag(value) {
  if (value === true) return true;
  const text = safeText(value, 40).toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
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

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error(timeoutCode);
      error.code = timeoutCode;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    file: "",
    wallet: process.env.DEATHMARCH_WALLET || DEFAULT_WALLET,
    statePath: process.env.DEATHMARCH_STATE_PATH || DEFAULT_STATE_PATH,
    seedFile: process.env.DEATHMARCH_SEED_FILE || DEFAULT_SEED_FILE,
    seedFileExplicit: Boolean(process.env.DEATHMARCH_SEED_FILE),
    anonymity: process.env.DEATHMARCH_ANONYMITY_LEVEL || "3",
    dryRun: false,
    noState: false,
    markExisting: false,
    poll: false,
    once: false,
    limit: process.env.DEATHMARCH_ACCOUNT_TX_LIMIT || "100",
    maxPages: process.env.DEATHMARCH_ACCOUNT_TX_MAX_PAGES || "1",
    processLimit: process.env.DEATHMARCH_PROCESS_LIMIT || "25",
    intervalMs: process.env.DEATHMARCH_POLL_INTERVAL_MS || "60000",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || "";
    if (arg === "--file") args.file = next();
    else if (arg === "--wallet") args.wallet = next();
    else if (arg === "--state") args.statePath = next();
    else if (arg === "--seed-file") {
      args.seedFile = next();
      args.seedFileExplicit = true;
    }
    else if (arg === "--anonymity" || arg === "--level") args.anonymity = next();
    else if (arg === "--limit") args.limit = next();
    else if (arg === "--max-pages") args.maxPages = next();
    else if (arg === "--process-limit") args.processLimit = next();
    else if (arg === "--interval-ms") args.intervalMs = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-state") args.noState = true;
    else if (arg === "--mark-existing") args.markExisting = true;
    else if (arg === "--poll") args.poll = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!args.file && !arg.startsWith("-")) args.file = arg;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Deathmarch local Discord harness",
    "",
    "Usage:",
    "  npm run deathmarch -- --once --dry-run",
    "  npm run deathmarch -- --poll",
    "  npm run deathmarch -- --once --mark-existing",
    "  npm run deathmarch -- --file ./task-events.json --anonymity 2",
    "  npm run deathmarch -- --poll --seed-file ./deathmarchseed.txt",
    "",
    "Required env:",
    "  AMBIENT_API_KEY",
    "  DEATHMARCH_DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DEATHMARCH_DISCORD_CHANNEL_ID",
    "",
    "Optional env:",
    `  DEATHMARCH_WALLET=${DEFAULT_WALLET}`,
    `  DEATHMARCH_SEED_FILE=${DEFAULT_SEED_FILE}`,
    `  DEATHMARCH_AMBIENT_MODEL=${DEFAULT_AMBIENT_MODEL}`,
    `  DEATHMARCH_STATE_PATH=${DEFAULT_STATE_PATH}`,
    "  DEATHMARCH_DATABASE_URL=postgres://...  # optional direct-write task_events feed",
    "  DEATHMARCH_DATABASE_EVENTS_ENABLED=false  # disable database feed",
  ].join("\n");
}

function seedEnvAlreadyConfigured(env = process.env) {
  return Boolean(safeText(
    env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      "",
    5000
  ));
}

function configuredUserMnemonic(env = process.env) {
  return safeText(env.DEATHMARCH_USER_MNEMONIC || env.TASKNODE_USER_MNEMONIC || "", 10000)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function looksLikeTaskNodeMnemonic(value = "") {
  const normalized = safeText(value, 10000).toLowerCase().replace(/\s+/g, " ");
  return Boolean(normalized && validateMnemonic(normalized, wordlist));
}

function base64ToBytes(value) {
  return Buffer.from(String(value || ""), "base64");
}

function bytesToBase64(value) {
  return Buffer.from(value).toString("base64");
}

async function userKeypairFromMnemonic(mnemonic = "") {
  const normalized = safeText(mnemonic, 10000).toLowerCase().replace(/\s+/g, " ");
  if (!looksLikeTaskNodeMnemonic(normalized)) throw new Error("deathmarch_user_mnemonic_invalid");
  await sodium.ready;
  const seedBytes = createHash("sha256").update(mnemonicToSeedSync(normalized)).digest();
  return sodium.crypto_box_seed_keypair(seedBytes);
}

async function recipientIdForPublicKey(publicKeyBytes) {
  return createHash("sha256").update(Buffer.from(publicKeyBytes)).digest("hex");
}

export async function tasknodePublicKeyFromUserMnemonic(mnemonic = "") {
  const keypair = await userKeypairFromMnemonic(mnemonic);
  return bytesToBase64(keypair.publicKey);
}

export async function decryptTasknodeUserMnemonicPayload({ blob, mnemonic = "" } = {}) {
  if (!blob || typeof blob !== "object") throw new Error("task_payload_missing");
  if (blob.enc !== "ENC_X25519_XCHACHA20P1305") {
    throw new Error(`task_payload_unsupported_encryption:${blob.enc || "missing"}`);
  }
  const keypair = await userKeypairFromMnemonic(mnemonic);
  const recipientId = await recipientIdForPublicKey(keypair.publicKey);
  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => {
    return safeText(entry?.recipient_id, 200).toLowerCase() === recipientId;
  });
  if (!shard) throw new Error("tasknode_user_recipient_missing");

  await sodium.ready;
  const fileKey = sodium.crypto_box_open_easy(
    base64ToBytes(shard.encrypted_file_key),
    base64ToBytes(shard.wrap_nonce),
    base64ToBytes(shard.ephemeral_pubkey),
    keypair.privateKey
  );
  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64ToBytes(blob.ciphertext),
    null,
    base64ToBytes(blob.nonce),
    fileKey
  );
  if (blob.content_hash) {
    const digest = createHash("sha256").update(Buffer.from(plaintextBytes)).digest("hex");
    if (digest !== safeText(blob.content_hash, 120).toLowerCase()) {
      throw new Error("task_payload_content_hash_mismatch");
    }
  }
  return JSON.parse(Buffer.from(plaintextBytes).toString("utf8"));
}

function seedFileCandidatePaths(seedFile, explicitSeedFile) {
  const configuredFile = safeText(seedFile, 2000);
  if (!configuredFile) return [];
  const firstPath = path.isAbsolute(configuredFile)
    ? configuredFile
    : path.resolve(process.cwd(), configuredFile);
  if (explicitSeedFile || path.basename(configuredFile) !== DEFAULT_SEED_FILE) return [firstPath];
  return [firstPath, path.resolve(process.cwd(), "..", DEFAULT_SEED_FILE)];
}

export async function deathmarchEnvWithSeedFile({
  env = process.env,
  seedFile = DEFAULT_SEED_FILE,
  explicitSeedFile = false,
} = {}) {
  const serviceSeedConfigured = seedEnvAlreadyConfigured(env);
  const candidates = seedFileCandidatePaths(seedFile, explicitSeedFile);
  if (!candidates.length) return env;

  let fileText = null;
  let loadedPath = "";
  for (const candidatePath of candidates) {
    try {
      fileText = await fs.readFile(candidatePath, "utf8");
      loadedPath = candidatePath;
      break;
    } catch {
      fileText = null;
    }
  }
  if (fileText === null) {
    if (explicitSeedFile) {
      throw new Error(`deathmarch_seed_file_missing:${safeText(seedFile, 2000)}`);
    }
    return env;
  }

  const seed = safeText(fileText, 5000);
  if (!seed) {
    if (explicitSeedFile) throw new Error(`deathmarch_seed_file_empty:${loadedPath || safeText(seedFile, 2000)}`);
    return env;
  }
  if (looksLikeTaskNodeMnemonic(seed)) {
    return { ...env, DEATHMARCH_USER_MNEMONIC: configuredUserMnemonic(env) || seed };
  }
  if (serviceSeedConfigured) return env;
  return { ...env, TASKNODE_SERVICE_SEED: seed };
}

async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
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
    row.event_type ||
      row.eventType ||
      row.schema ||
      payload.schema ||
      pointer.schema ||
      "",
    180
  );
  const txHash = safeText(
    row.source_tx_hash ||
      row.sourceTxHash ||
      row.tx_hash ||
      row.txHash ||
      pointer.txHash ||
      pointer.tx_hash ||
      "",
    180
  ).toUpperCase();
  const cid = safeText(row.source_cid || row.sourceCid || row.cid || pointer.cid || "", 240);
  const taskId = safeText(
    row.task_id ||
      row.taskId ||
      payload.task_id ||
      payload.taskId ||
      pointer.taskId ||
      pointer.task_id ||
      "",
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

async function loadEventsFromFile(filePath) {
  const value = await readJsonFile(filePath);
  return fileEventsFromValue(value).map(normalizeEvent).filter(isTaskEvent);
}

async function fetchAndDecryptDeathmarchPayload({ cid, env = process.env } = {}) {
  try {
    return await fetchAndDecryptTasknodePayload({ cid, env });
  } catch (serviceError) {
    const mnemonic = configuredUserMnemonic(env);
    if (!mnemonic) throw serviceError;
    try {
      const fetched = await fetchContextIpfsJson({ cid });
      if (!fetched?.ok) throw new Error(fetched?.error || "task_ipfs_fetch_failed");
      const payload = await decryptTasknodeUserMnemonicPayload({ blob: fetched.payload, mnemonic });
      return {
        cid: fetched.cid || cid,
        gateway: fetched.gateway || "",
        payload,
      };
    } catch (userError) {
      const error = new Error(`task_payload_decrypt_failed:service=${serviceError?.message || serviceError}:user=${userError?.message || userError}`);
      error.serviceError = serviceError;
      error.userError = userError;
      throw error;
    }
  }
}

function isTaskEvent(event = {}) {
  const schema = safeText(event.schema || event.payload?.schema, 120);
  if (schema === "pf.daily_airdrop.v1") return false;
  if (schema === "pf.task.reward_decision.v1") return false;
  if (TASK_SCHEMAS.has(schema)) return true;
  const pointerKind = safeText(event.pointerKind || event.pointer?.kindLabel || "", 120).toUpperCase();
  if (pointerKind === "REWARD") return false;
  return TASK_KIND_LABELS.has(pointerKind);
}

async function loadEventsFromWallet({
  wallet,
  limit,
  maxPages,
  env = process.env,
} = {}) {
  const history = await fetchHistoricalAccountTransactions({
    walletAddress: wallet,
    limit,
    maxPages,
    env,
  });
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
  return safeArray(rows).map(normalizeEvent).filter(isTaskEvent);
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

function eventTextBlob(event = {}) {
  const payload = safeObject(event.payload);
  return [
    event.raw?.title,
    payload.title,
    payload.description,
    payload.objective,
    payload.summary,
    payload.request_text,
    payload.user_request,
    payload.prompt,
    payload.submission_requirement?.criteria,
    payload.submission_requirement?.description,
    payload.verification_ask,
    payload.verification_request?.verification_ask,
    payload.response_text,
    payload.response,
    payload.reward_summary,
    payload.score?.reason,
    payload.score?.user_feedback,
    safeArray(payload.evidence_items).map((item) => `${item?.type || ""} ${item?.text || item?.summary || ""}`).join(" "),
  ].filter(Boolean).join("\n");
}

function compactEvidenceItemDetail(item = {}) {
  const evidence = safeObject(item);
  const file = safeObject(evidence.file);
  const artifactType = safeText(evidence.artifact_type || evidence.type || "evidence", 80);
  const fileName = safeText(file.name || evidence.file_name || "", 180);
  const body = compactWhitespace(
    evidence.text ||
      evidence.summary ||
      evidence.value ||
      file.description ||
      file.text ||
      evidence.notes ||
      ""
  ).slice(0, 360);
  const label = fileName ? `${artifactType} ${fileName}` : artifactType;
  if (!body) return label;
  return `${label}: ${body}`;
}

function compactEvidenceDetail(payload = {}) {
  const responseText = compactWhitespace(payload.response_text || payload.response || "").slice(0, 700);
  if (responseText) return responseText;
  const items = safeArray(payload.evidence_items)
    .map(compactEvidenceItemDetail)
    .filter(Boolean)
    .slice(0, 2);
  if (items.length) return items.join(" | ").slice(0, 900);
  const evidence = safeObject(payload.evidence || payload.submission);
  const nestedItems = safeArray(evidence.evidence_items)
    .map(compactEvidenceItemDetail)
    .filter(Boolean)
    .slice(0, 2);
  if (nestedItems.length) return nestedItems.join(" | ").slice(0, 900);
  return compactWhitespace(
    evidence.value ||
      evidence.text ||
      evidence.summary ||
      evidence.notes ||
      safeObject(evidence.file).description ||
      safeObject(evidence.file).text ||
      ""
  ).slice(0, 700);
}

function formatPftAmount(value = "") {
  const text = safeText(value, 80);
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return `${text} PFT`;
  return `${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })} PFT`;
}

function compactRewardDetail(payload = {}, actionKind = "") {
  const score = safeObject(payload.score || payload.reward_score);
  const amount = formatPftAmount(
    payload.reward_pft ||
      payload.economic_reward_pft ||
      payload.reward_actual_pft ||
      payload.reward_paid ||
      score.reward_pft ||
      ""
  );
  const carrierDrops = safeText(payload.carrier_amount_drops || payload.carrier_drops || "", 80);
  const decision = compactWhitespace(
    payload.reward_tier ||
      payload.reward_decision ||
      score.decision ||
      ""
  ).replace(/_/g, " ");
  const evidenceQuality = safeText(payload.evidence_quality || score.evidence_quality || "", 40);
  const reason = compactWhitespace(
    payload.reward_summary ||
      payload.summary ||
      score.user_feedback ||
      score.reason ||
      ""
  ).slice(0, 360);
  const kind = safeText(actionKind, 160).toLowerCase();
  if (!amount && !decision && !evidenceQuality && !reason) return "";
  if (kind === "reward_outcome") {
    const amountText = amount || "reward outcome";
    const carrierText = carrierDrops && Number(carrierDrops) > 0
      ? " The transaction is a one-drop carrier for a zero-PFT outcome."
      : "";
    const prefix = `Recorded terminal reward outcome: ${amountText}.${carrierText}`;
    return [prefix, reason].filter(Boolean).join(" ");
  }
  const parts = [];
  if (decision) parts.push(`outcome ${decision}`);
  if (amount) parts.push(`amount ${amount}`);
  if (evidenceQuality) parts.push(`evidence quality ${evidenceQuality}/100`);
  const prefix = parts.length ? `Recorded reward ${parts.join(", ")}.` : "Recorded reward outcome.";
  return [prefix, reason].filter(Boolean).join(" ");
}

function publicPayloadFields(event = {}) {
  const payload = safeObject(event.payload);
  const evidenceSummary = safeArray(payload.evidence_items).map((item, index) => ({
    index: index + 1,
    type: item?.type || item?.artifact_type || "",
    text: compactEvidenceItemDetail(item),
  })).slice(0, 5);
  return {
    schema: event.schema || payload.schema,
    action_kind: event.actionKind,
    task_id: event.taskId,
    title: payload.title || event.raw?.title || "",
    description: payload.description || "",
    transition: payload.transition || payload.status_after || payload.status || "",
    phase: payload.phase || "",
    request_text: payload.request_text || payload.request?.request_text || "",
    user_detail_text: payload.user_detail_text || payload.request?.user_detail_text || "",
    requested_task_kind: payload.requested_task_kind || payload.request?.requested_task_kind || "",
    request_bundle_summary: payload.request_bundle?.summary || payload.recent_chat?.summary || "",
    reward_pft: payload.reward_pft || payload.economic_reward_pft || payload.reward_actual_pft || payload.score?.reward_pft || "",
    reward_outcome: payload.reward_tier || payload.reward_decision || payload.score?.decision || "",
    carrier_amount_drops: payload.carrier_amount_drops || "",
    reward_detail: compactRewardDetail(payload, event.actionKind),
    reward_summary: payload.reward_summary || payload.summary || payload.score?.user_feedback || payload.score?.reason || "",
    verification_ask: payload.verification_ask || payload.verification_request?.verification_ask || "",
    response_text: payload.response_text || payload.response || "",
    submission_detail: compactEvidenceDetail(payload),
    evidence_summary: evidenceSummary,
    payload_error: payload.payload_error || "",
  };
}

function deathmarchActionLabel(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  if (kind === "task_request") return "Task requested";
  if (kind === "task_offer") return "Task proposed";
  if (kind === "initial_verification" || kind === "task_submission") return "Evidence submitted";
  if (kind === "verification_response") return "Verification response submitted";
  if (kind === "reward_outcome") return "Reward outcome";
  if (kind.startsWith("task_update_")) {
    const transition = kind.replace(/^task_update_/, "").replace(/_/g, " ");
    if (transition === "accepted") return "Task accepted";
    if (transition === "refused") return "Task refused";
    if (transition === "cancelled" || transition === "canceled") return "Task cancelled";
    if (transition === "verification requested") return "Verification requested";
    if (transition === "reward decided") return "Reward outcome pending";
    if (transition === "rewarded") return "Task rewarded";
    return `Task updated: ${transition}`;
  }
  if (kind === "task_update") return "Task updated";
  return "Task activity";
}

function stripGeneratedDiscordNoise(summary = "", txHash = "") {
  let text = safeText(summary, 1200)
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const tx = safeText(txHash, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (tx) {
    text = text.replace(new RegExp(`\\btx\\s*:\\s*${tx}\\b`, "gi"), "");
    text = text.replace(new RegExp(`\\btransaction(?:\\s+hash)?\\s*:?\\s*${tx}\\b`, "gi"), "");
    text = text.replace(new RegExp(`\\b${tx}\\b`, "g"), "");
  }
  text = text
    .replace(/\b(?:green\s*\/\s*yellow\s*\/\s*red|red\s*\/\s*yellow\s*\/\s*green)\s+(?:visibility\s+)?(?:model|framework|rubric)\b/gi, "public visibility rules")
    .replace(/\b(?:green,\s*yellow,\s*and\s*red|red,\s*yellow,\s*and\s*green)\s+(?:visibility\s+)?(?:model|framework|rubric)\b/gi, "public visibility rules")
    .replace(/\bvisibility model\b/gi, "public visibility rules")
    .replace(/\breward decision\b/gi, "reward outcome");
  return compactWhitespace(text).replace(/\s+([.,;:!?])/g, "$1").slice(0, 360);
}

function isSubmissionAction(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  return ["initial_verification", "task_submission", "verification_response"].includes(kind);
}

function isGenericSubmissionSummary(summary = "") {
  const text = compactWhitespace(summary).toLowerCase();
  if (!text) return true;
  return [
    "a new task was submitted",
    "task was submitted",
    "evidence was submitted",
    "initial verification",
    "verification response was submitted",
    "now in initial verification",
    "awaiting review",
  ].some((phrase) => text.includes(phrase));
}

function submissionSummaryWithDetail({ summary = "", actionKind = "", payload = {} } = {}) {
  if (!isSubmissionAction(actionKind)) return summary;
  const detail = compactWhitespace(payload.submission_detail || "").slice(0, 420);
  if (!detail) return summary;
  if (!isGenericSubmissionSummary(summary)) return summary;
  if (safeText(actionKind, 160).toLowerCase() === "verification_response") {
    return `Submitted verification response: ${detail}`;
  }
  return `Submitted evidence: ${detail}`;
}

function isRewardAction(actionKind = "") {
  const kind = safeText(actionKind, 160).toLowerCase();
  return kind === "reward_outcome";
}

function isGenericRewardSummary(summary = "") {
  const text = compactWhitespace(summary).toLowerCase();
  if (!text) return true;
  return [
    "reward was paid",
    "reward paid",
    "reward outcome",
    "reward was recorded",
    "task was rewarded",
    "rewarded the task",
    "scored the submitted evidence",
  ].some((phrase) => text.includes(phrase));
}

function rewardSummaryWithDetail({ summary = "", actionKind = "", payload = {} } = {}) {
  if (!isRewardAction(actionKind)) return summary;
  const detail = compactWhitespace(payload.reward_detail || "").slice(0, 520);
  if (!detail) return summary;
  if (isGenericRewardSummary(summary)) return detail;
  if (detail.includes(" PFT") && !summary.includes(" PFT")) return detail;
  return summary;
}

export function formatDeathmarchDiscordMessage({ summary = "", event = {} } = {}) {
  const txHash = safeText(event.tx_hash || event.txHash, 220).toUpperCase();
  if (!txHash) throw new Error("deathmarch_tx_hash_missing");
  const actionLabel = deathmarchActionLabel(event.action_kind || event.actionKind);
  const payload = safeObject(event.event);
  const title = compactWhitespace(payload.title || event.title || "").slice(0, 140);
  const taskId = safeText(event.task_id || event.taskId || payload.task_id, 180);
  const cleanedSummary = rewardSummaryWithDetail({
    summary: submissionSummaryWithDetail({
      summary: stripGeneratedDiscordNoise(summary, txHash),
      actionKind: event.action_kind || event.actionKind,
      payload,
    }),
    actionKind: event.action_kind || event.actionKind,
    payload,
  });
  const fallbackSummary = taskId
    ? `${actionLabel.toLowerCase()} for task ${taskId}.`
    : `${actionLabel.toLowerCase()}.`;
  const lines = [
    `**${actionLabel}**`,
    title ? `**${title}**` : "",
    cleanedSummary || fallbackSummary,
    taskId ? `Task: \`${taskId}\`` : "",
    `tx: ${txHash}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function safeClassificationCategory(value = "") {
  return safeText(value || "confidential task", 120) || "confidential task";
}

function safeClassifierFallback() {
  return {
    level: 3,
    category: CLASSIFIER_FAILURE_CATEGORY,
    sensitive_entities: [],
    sensitive_strategy_details: [],
  };
}

function parseClassifierJson(content = "") {
  const parsed = JSON.parse(safeText(content, 2000));
  const object = safeObject(parsed);
  const level = clampInteger(object.level, 0, 1, 3);
  if (!level) throw new Error("deathmarch_classifier_level_invalid");
  const sensitiveEntities = safeArray(object.sensitive_entities)
    .slice(0, 16)
    .map((entry) => {
      const entity = safeObject(entry);
      const kind = safeText(entity.kind, 40).toLowerCase();
      const name = compactWhitespace(entity.name).slice(0, 160);
      if (!name || !["client", "investor"].includes(kind)) return null;
      return { kind, name };
    })
    .filter(Boolean)
    .filter((entity, index, entities) => {
      return entities.findIndex((candidate) => {
        return candidate.kind === entity.kind && candidate.name.toLowerCase() === entity.name.toLowerCase();
      }) === index;
    });
  const sensitiveStrategyDetails = safeArray(object.sensitive_strategy_details)
    .slice(0, 8)
    .map((value) => compactWhitespace(value).slice(0, 600))
    .filter((value) => value.length >= 12)
    .filter((value, index, values) => {
      return values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index;
    });
  return {
    level,
    category: safeClassificationCategory(object.category || "classified task"),
    sensitive_entities: sensitiveEntities,
    sensitive_strategy_details: sensitiveStrategyDetails,
  };
}

function deathmarchClassifierPrompt() {
  return [
    "You classify Task Node Death March event disclosure risk.",
    "Return strict JSON only: {\"level\":1|2|3,\"category\":\"short category without names\",\"sensitive_entities\":[{\"kind\":\"client\"|\"investor\",\"name\":\"exact name from event\"}],\"sensitive_strategy_details\":[\"smallest exact confidential substring from event\"]}.",
    "",
    "Level 1: the event contains exact proprietary strategy or intellectual-property mechanics that should not be public, such as formulas, algorithm steps, signal definitions, portfolio construction rules, execution logic, confidential research methods, or similarly concrete secret know-how.",
    "Do not use level 1 for a general topic, task direction, industry, instrument, ticker, product area, public documentation, ordinary business work, or a generic request to develop a strategy. The event must contain concrete proprietary mechanics.",
    "For level 1, copy only the smallest exact substrings containing the secret mechanics into sensitive_strategy_details. Do not copy an entire title, description, or evidence item when a narrower phrase or sentence isolates the secret. Non-secret context must remain publishable.",
    "Level 2: the event contains the specific proper name of an external client/customer or investor, but no level-1 strategy detail. List each exact client or investor name in sensitive_entities so it can be removed before summarization.",
    "Level 3: everything else. Ordinary client work without a client name, fundraising without a named investor, legal/team/partner/protocol/product/open-source work, public organization names, contributor names, and project names are level 3.",
    "",
    "sensitive_entities must contain only explicit proper-name identifiers for clients/customers or investors. Never include generic roles, project names, team members, vendors, protocols, or organizations that are not identified as a client/customer or investor.",
    "When uncertain, choose level 3. Redact only the three requested classes: exact client names, exact investor names, and exact proprietary strategy/IP details.",
  ].join("\n");
}

export async function classifyEventAnonymity({
  event,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!ambientConfigured(env)) return safeClassifierFallback();
  const requestBody = {
    model: env.DEATHMARCH_AMBIENT_CLASSIFY_MODEL || env.DEATHMARCH_AMBIENT_MODEL || DEFAULT_AMBIENT_MODEL,
    messages: [
      { role: "system", content: deathmarchClassifierPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Classify this event for Death March Discord disclosure.",
          event_text: eventTextBlob(event),
        }, null, 2),
      },
    ],
    temperature: 0,
    max_tokens: 1200,
  };
  try {
    const result = await ambientChatCompletion({ env, fetchImpl, body: requestBody, capability: "strict_json", timeoutMs: clampInteger(
      env.DEATHMARCH_AMBIENT_TIMEOUT_MS,
      DEFAULT_AMBIENT_TIMEOUT_MS,
      1000,
      120000
    ) });
    const content = safeText(result.text, 2000);
    if (!content) return safeClassifierFallback();
    return parseClassifierJson(content);
  } catch {
    return safeClassifierFallback();
  }
}

function effectiveAnonymityLevel({ globalFloor = 3, classifiedLevel = 3 } = {}) {
  return Math.min(
    clampInteger(globalFloor, 3, 1, 3),
    clampInteger(classifiedLevel, 1, 1, 3)
  );
}

export function sanitizeEventForAnonymity(event = {}, anonymity = 3, classification = {}) {
  const level = clampInteger(anonymity, 3, 1, 3);
  const sensitiveEntities = safeArray(classification.sensitive_entities);
  const sensitiveStrategyDetails = safeArray(classification.sensitive_strategy_details);
  const redactionPattern = (value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped.replace(/\s+/g, "\\s+"), "gi");
  };
  const redactProtectedText = (value) => {
    if (typeof value === "string") {
      const withoutStrategyDetails = sensitiveStrategyDetails.reduce((text, detail) => {
        const protectedDetail = compactWhitespace(detail).slice(0, 600);
        if (protectedDetail.length < 12) return text;
        return text.replace(redactionPattern(protectedDetail), "[redacted strategy detail]");
      }, value);
      return sensitiveEntities.reduce((text, entry) => {
        const entity = safeObject(entry);
        const kind = safeText(entity.kind, 40).toLowerCase();
        const name = compactWhitespace(entity.name).slice(0, 160);
        if (!name || !["client", "investor"].includes(kind)) return text;
        return text.replace(redactionPattern(name), `[redacted ${kind}]`);
      }, withoutStrategyDetails);
    }
    if (Array.isArray(value)) return value.map(redactProtectedText);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactProtectedText(entry)]));
    }
    return value;
  };
  const category = safeClassificationCategory(redactProtectedText(
    classification.category || event.category || "classified task"
  ));
  const txHash = event.txHash;
  const base = {
    anonymity_level: level,
    tx_hash: txHash,
    cid: event.cid,
    task_id: event.taskId,
    action_kind: event.actionKind,
    occurred_at: event.occurredAt,
  };
  const redactedEvent = redactProtectedText(publicPayloadFields(event));
  if (level === 1 && sensitiveStrategyDetails.length === 0) {
    return {
      level,
      category,
      disclosure_policy: "strategy detail classification lacked safe spans; directional fallback applied",
      directional_category: category,
      public_instruction:
        "The classifier did not provide safe redaction spans. Give only a broad directional category.",
    };
  }
  if (level === 1) {
    return {
      ...base,
      category,
      disclosure_policy: "only exact proprietary strategy or IP spans and protected names were redacted",
      public_instruction:
        "Protected names and exact strategy details have already been replaced. Summarize the remaining context and do not reconstruct redacted text.",
      redacted_entity_kinds: [...new Set(sensitiveEntities.map((entry) => safeText(entry?.kind, 40)).filter(Boolean))],
      redacted_strategy_detail_count: sensitiveStrategyDetails.length,
      event: redactedEvent,
    };
  }
  if (level === 2) {
    return {
      ...base,
      category,
      disclosure_policy: "specific client and investor names redacted; other packet details allowed",
      public_instruction:
        "Client and investor names have already been replaced. Summarize the remaining details and do not reconstruct or guess any redacted name.",
      redacted_entity_kinds: [...new Set(sensitiveEntities.map((entry) => safeText(entry?.kind, 40)).filter(Boolean))],
      event: redactedEvent,
    };
  }
  return {
    ...base,
    category,
    disclosure_policy: sensitiveEntities.length
      ? "specific client and investor names redacted; other packet details allowed"
      : "no client names, investor names, or exact proprietary strategy details identified",
    public_instruction: sensitiveEntities.length
      ? "Client and investor names have already been replaced. Do not reconstruct or guess them."
      : "Summarize the event normally without inventing private details.",
    event: redactedEvent,
  };
}

function formatEventForAnonymity(event = {}, sanitized = {}) {
  if (clampInteger(sanitized.anonymity_level || sanitized.level, 3, 1, 3) !== 1) return sanitized;
  return {
    ...sanitized,
    tx_hash: event.txHash,
    cid: event.cid,
    task_id: event.taskId,
    action_kind: event.actionKind,
    occurred_at: event.occurredAt,
  };
}

async function readPrompt() {
  const currentFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(currentFile), "..");
  return fs.readFile(path.join(repoRoot, "prompts/non_production/deathmarch_local/deathmarch_summary_v1.md"), "utf8");
}

export async function callDeepSeekSummary({
  event,
  anonymity,
  classification = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!ambientConfigured(env)) throw new Error("ambient_api_key_missing");
  const prompt = await readPrompt();
  const classified = classification || await classifyEventAnonymity({ event, env, fetchImpl });
  const level = effectiveAnonymityLevel({
    globalFloor: anonymity,
    classifiedLevel: classified.level,
  });
  const sanitized = sanitizeEventForAnonymity(event, level, classified);
  const formatEvent = formatEventForAnonymity(event, sanitized);
  const requestBody = {
    model: env.DEATHMARCH_AMBIENT_MODEL || DEFAULT_AMBIENT_MODEL,
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Write the Death March Discord update for this task event.",
          event: sanitized,
        }, null, 2),
      },
    ],
    temperature: 0.2,
  };
  if (safeText(env.DEATHMARCH_AMBIENT_MAX_TOKENS, 40)) {
    requestBody.max_tokens = clampInteger(
      env.DEATHMARCH_AMBIENT_MAX_TOKENS,
      4000,
      128,
      12000
    );
  }
  const result = await ambientChatCompletion({ env, fetchImpl, body: requestBody, capability: "reasoning_text", timeoutMs: clampInteger(
    env.DEATHMARCH_AMBIENT_TIMEOUT_MS,
    DEFAULT_AMBIENT_TIMEOUT_MS,
    1000,
    120000
  ) });
  const content = safeText(result.text, 2000);
  if (!content) {
    const choice = safeObject(result.body?.choices?.[0]);
    const message = safeObject(choice.message);
    const detail = [
      choice.finish_reason ? `finish_reason=${safeText(choice.finish_reason, 80)}` : "",
      message.reasoning_content ? `reasoning_tokens_only=${safeText(message.reasoning_content, 10000).length}` : "",
    ].filter(Boolean).join(",");
    if (env.DEATHMARCH_DETERMINISTIC_FALLBACK !== "false") {
      return formatDeathmarchDiscordMessage({ summary: "", event: formatEvent });
    }
    throw new Error(`ambient_api_error:empty_response${detail ? `:${detail}` : ""}`);
  }
  return formatDeathmarchDiscordMessage({ summary: content, event: formatEvent });
}

export async function postToDiscord({
  content,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const message = safeText(content, 1900);
  if (!message) throw new Error("discord_message_empty");
  const timeoutMs = clampInteger(
    env.DEATHMARCH_DISCORD_TIMEOUT_MS,
    DEFAULT_DISCORD_TIMEOUT_MS,
    1000,
    60000
  );
  const webhookUrl = safeText(env.DEATHMARCH_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL, 2000);
  if (webhookUrl) {
    const response = await fetchWithTimeout(fetchImpl, webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [] },
      }),
    }, timeoutMs, "discord_webhook_timeout");
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`discord_webhook_error:${response.status}:${safeText(text, 300)}`);
    }
    return { ok: true, transport: "webhook" };
  }

  const token = safeText(env.DISCORD_BOT_TOKEN || env.DEATHMARCH_DISCORD_BOT_TOKEN, 4000);
  const channelId = safeText(
    env.DEATHMARCH_DISCORD_CHANNEL_ID || env.DEATHMARCH_CHANNEL_ID || env.DISCORD_CHANNEL_ID,
    120
  );
  if (!token || !channelId) throw new Error("discord_destination_missing");
  const response = await fetchWithTimeout(fetchImpl, `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bot ${token}`,
    },
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: [] },
    }),
  }, timeoutMs, "discord_bot_timeout");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`discord_bot_error:${response.status}:${safeText(text, 300)}`);
  }
  return { ok: true, transport: "bot", channelId };
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      seen: safeObject(parsed.seen),
      updatedAt: safeText(parsed.updatedAt, 80),
    };
  } catch {
    return { seen: {}, updatedAt: "" };
  }
}

async function writeState(statePath, state) {
  await fs.writeFile(statePath, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

export async function processDeathmarchEvents({
  events,
  anonymity = 3,
  dryRun = false,
  statePath = DEFAULT_STATE_PATH,
  noState = false,
  markExisting = false,
  processLimit = 25,
  env = process.env,
  fetchImpl = fetch,
  stdout = console.log,
} = {}) {
  const state = noState ? { seen: {} } : await readState(statePath);
  let candidates = events
    .filter(isTaskEvent)
    .filter((event) => noState || !state.seen[event.eventKey]);
  if (!markExisting) {
    candidates = candidates.slice(0, clampInteger(processLimit, 25, 1, 200));
  }
  const results = [];
  if (markExisting) {
    for (const event of candidates) {
      state.seen[event.eventKey] = {
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        markedAt: new Date().toISOString(),
        discord: { ok: false, transport: "not_posted_mark_existing" },
      };
      results.push({ ok: true, marked: true, eventKey: event.eventKey });
    }
    if (!noState) await writeState(statePath, state);
    return { ok: true, checked: events.length, marked: results.length, posted: 0, results };
  }
  for (const event of candidates) {
    try {
      const classification = await classifyEventAnonymity({ event, env, fetchImpl });
      const summary = await callDeepSeekSummary({ event, anonymity, classification, env, fetchImpl });
      if (dryRun) {
        stdout(summary);
        results.push({ ok: true, dryRun: true, eventKey: event.eventKey, summary });
        continue;
      }
      const discord = await postToDiscord({ content: summary, env, fetchImpl });
      state.seen[event.eventKey] = {
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        postedAt: new Date().toISOString(),
        discord,
      };
      if (!noState) await writeState(statePath, state);
      results.push({ ok: true, eventKey: event.eventKey, discord });
    } catch (error) {
      const failure = {
        ok: false,
        eventKey: event.eventKey,
        txHash: event.txHash,
        cid: event.cid,
        taskId: event.taskId,
        actionKind: event.actionKind,
        error: safeErrorCode(error),
      };
      if (dryRun) stdout(`deathmarch_event_error:${failure.error}`);
      results.push(failure);
    }
  }
  const failed = results.filter((result) => result.ok === false).length;
  const posted = results.filter((result) => result.ok === true && !result.dryRun).length;
  return { ok: failed === 0, checked: events.length, posted, failed, results };
}

async function runOnce(args) {
  const env = await deathmarchEnvWithSeedFile({
    seedFile: args.seedFile,
    explicitSeedFile: args.seedFileExplicit,
  });
  const events = args.file
    ? await loadEventsFromFile(args.file)
    : mergeDeathmarchEvents(
      await loadEventsFromWallet({
        wallet: args.wallet,
        limit: clampInteger(args.limit, 100, 20, 400),
        maxPages: clampInteger(args.maxPages, 1, 1, 30),
        env,
      }),
      await loadEventsFromDatabase({
        wallet: args.wallet,
        limit: clampInteger(args.limit, 100, 20, 400),
        env,
      })
    );
  return processDeathmarchEvents({
    events,
    anonymity: args.anonymity,
    dryRun: args.dryRun,
    statePath: args.statePath,
    noState: args.noState,
    markExisting: args.markExisting,
    processLimit: args.processLimit,
    env,
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.poll) {
    const intervalMs = clampInteger(args.intervalMs, 60000, 5000, 3_600_000);
    while (true) {
      try {
        const result = await runOnce(args);
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      } catch (error) {
        console.error(`deathmarch_error:${error?.message || error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const result = await runOnce(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
