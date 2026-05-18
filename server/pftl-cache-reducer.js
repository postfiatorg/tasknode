import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { Wallet } from "xrpl";
import { fetchContextIpfsJson } from "./context-ipfs.js";
import { saveContextHistoryProjection } from "./repositories/context.js";
import { importTaskReplayReceipt } from "./repositories/tasks.js";
import { databaseEnabled, query, transaction } from "./db/pool.js";

const ENCRYPTION_SUITE = "ENC_X25519_XCHACHA20P1305";
const TEXT_DECODER = new TextDecoder();
const TASK_POINTER_KINDS = ["TASK", "TASK_UPDATE", "TASK_SUBMISSION", "REWARD"];

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function safeJson(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function safeError(error) {
  return normalizeText(error?.code || error?.message || error || "pftl_cache_reducer_error").slice(0, 1000);
}

function sha256Hex(value) {
  const data = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value || {});
  return createHash("sha256").update(data).digest("hex");
}

function base64ToBytes(value) {
  return Buffer.from(String(value || ""), "base64");
}

function bytesToBase64(value) {
  return Buffer.from(value).toString("base64");
}

function configuredSeed(env = process.env) {
  return normalizeText(
    env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

export async function tasknodeServiceIdentityFromEnv(env = process.env) {
  const seed = configuredSeed(env);
  if (!seed) return null;
  await sodium.ready;
  const seedBytes = createHash("sha256").update(seed, "utf8").digest();
  const keypair = sodium.crypto_box_seed_keypair(seedBytes);
  let walletAddress = "";
  try {
    walletAddress = Wallet.fromSeed(seed).classicAddress;
  } catch {
    walletAddress = "";
  }
  return {
    role: "task_node_service",
    walletAddress,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyBase64: bytesToBase64(keypair.publicKey),
    recipientId: sha256Hex(Buffer.from(keypair.publicKey)),
  };
}

export async function decryptTasknodeServicePayload({ blob, env = process.env } = {}) {
  if (!blob || typeof blob !== "object") throw new Error("task_payload_missing");
  if (blob.enc !== ENCRYPTION_SUITE) {
    throw new Error(`task_payload_unsupported_encryption:${blob.enc || "missing"}`);
  }
  const identity = await tasknodeServiceIdentityFromEnv(env);
  if (!identity?.privateKey) throw new Error("tasknode_service_decryption_seed_missing");

  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => {
    return normalizeText(entry?.recipient_id).toLowerCase() === identity.recipientId;
  });
  if (!shard) throw new Error("tasknode_service_recipient_missing");

  await sodium.ready;
  const fileKey = sodium.crypto_box_open_easy(
    base64ToBytes(shard.encrypted_file_key),
    base64ToBytes(shard.wrap_nonce),
    base64ToBytes(shard.ephemeral_pubkey),
    identity.privateKey
  );
  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64ToBytes(blob.ciphertext),
    null,
    base64ToBytes(blob.nonce),
    fileKey
  );
  if (blob.content_hash) {
    const digest = sha256Hex(Buffer.from(plaintextBytes));
    if (digest !== normalizeText(blob.content_hash).toLowerCase()) {
      throw new Error("task_payload_content_hash_mismatch");
    }
  }
  const plaintext = TEXT_DECODER.decode(plaintextBytes);
  return JSON.parse(plaintext);
}

export async function claimPftlReducerEvents({ limit = 10 } = {}) {
  if (!databaseEnabled()) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE pftl_cache_reducer_events
        SET status = 'pending',
            available_at = now(),
            last_error = COALESCE(last_error, 'processing_timeout'),
            updated_at = now()
        WHERE status = 'processing'
          AND updated_at < now() - INTERVAL '10 minutes'
      `
    );
    const result = await client.query(
      `
        UPDATE pftl_cache_reducer_events
        SET status = 'processing',
            attempts = attempts + 1,
            updated_at = now()
        WHERE id IN (
          SELECT id
          FROM pftl_cache_reducer_events
          WHERE status = 'pending'
            AND available_at <= now()
          ORDER BY available_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `,
      [cappedLimit]
    );
    return result.rows;
  });
}

export async function markPftlReducerEventCompleted({ id, metadata = {} } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  await query(
    `
      UPDATE pftl_cache_reducer_events
      SET status = 'completed',
          processed_at = now(),
          last_error = NULL,
          payload_json = payload_json || $2::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [id, { result: safeJson(metadata) }]
  );
  return { ok: true };
}

export async function markPftlReducerEventFailed({
  id,
  attempts = 0,
  error,
  maxAttempts = 5,
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const retry = Number(attempts || 0) < maxAttempts;
  const delaySeconds = Math.min(900, Math.max(15, Number(attempts || 1) * 30));
  await query(
    `
      UPDATE pftl_cache_reducer_events
      SET status = $2,
          available_at = CASE
            WHEN $2 = 'pending' THEN now() + ($3 * INTERVAL '1 second')
            ELSE available_at
          END,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      id,
      retry ? "pending" : "failed",
      delaySeconds,
      safeError(error),
    ]
  );
  return { ok: true, retry };
}

async function pointerMemoForReducerEvent(event) {
  const result = await query(
    `
      SELECT
        pm.*,
        t.ledger_index AS tx_ledger_index,
        t.close_time,
        t.account AS account_address,
        t.destination AS destination_address,
        wt.direction
      FROM pftl_pointer_memos pm
      LEFT JOIN pftl_transactions t ON t.tx_hash = pm.tx_hash
      LEFT JOIN pftl_wallet_transactions wt
        ON wt.tx_hash = pm.tx_hash
       AND wt.wallet_address = $2
      WHERE pm.tx_hash = $1
        AND pm.wallet_address = $2
        AND ($3::integer IS NULL OR pm.memo_index = $3)
        AND ($4::text = '' OR pm.cid = $4)
      ORDER BY pm.memo_index ASC
      LIMIT 1
    `,
    [
      event.tx_hash,
      event.wallet_address,
      event.memo_index === null || event.memo_index === undefined ? null : Number(event.memo_index),
      normalizeText(event.cid),
    ]
  );
  return result.rows[0] || null;
}

function contextSnapshotFromPointer({ event, pointer }) {
  const decoded = safeJson(pointer.decoded_json);
  return {
    source: "pftl_cache.context_pointer",
    walletAddress: event.wallet_address,
    contextRevisions: [
      {
        id: pointer.context_id || decoded.contextId || `pftl:${pointer.tx_hash}:${pointer.memo_index}`,
        cid: pointer.cid,
        context_id: pointer.context_id || decoded.contextId || null,
        tx_hash: pointer.tx_hash,
        tx_timestamp: pointer.close_time || null,
        ledger_index: pointer.tx_ledger_index || event.ledger_index || null,
        memo_index: pointer.memo_index || 0,
        context_version: pointer.schema_version || decoded.schema || null,
        schema: pointer.schema_version || decoded.schema || null,
        flags: decoded.flags || 0,
        kind: decoded.kind || null,
        kindLabel: pointer.pointer_kind || decoded.kindLabel || "CONTEXT",
        account: pointer.account_address || null,
        destination: pointer.destination_address || null,
        direction: pointer.direction || "cached",
        source: "pftl_cache.context_pointer",
      },
    ],
    tasks: [],
    taskEvents: [],
    taskSubmissions: [],
  };
}

async function reduceContextPointer(event) {
  if (!event.account_id) throw new Error("context_reducer_account_id_missing");
  const pointer = await pointerMemoForReducerEvent(event);
  if (!pointer?.cid) throw new Error("context_pointer_missing");
  const saved = await saveContextHistoryProjection({
    accountId: event.account_id,
    projection: contextSnapshotFromPointer({ event, pointer }),
  });
  if (!saved.ok) throw new Error(saved.error || "context_pointer_save_failed");
  return {
    contextPointer: pointer.cid,
    historyPointerCount: saved.history?.pointerCount || 0,
  };
}

async function taskPointerRows({ walletAddress, taskId }) {
  const result = await query(
    `
      SELECT
        pm.*,
        t.ledger_index AS tx_ledger_index,
        t.close_time,
        t.account AS account_address,
        t.destination AS destination_address,
        wt.direction
      FROM pftl_pointer_memos pm
      LEFT JOIN pftl_transactions t ON t.tx_hash = pm.tx_hash
      LEFT JOIN pftl_wallet_transactions wt
        ON wt.tx_hash = pm.tx_hash
       AND wt.wallet_address = $1
      WHERE pm.wallet_address = $1
        AND pm.task_id = $2
        AND pm.cid IS NOT NULL
        AND pm.decode_error IS NULL
      ORDER BY
        t.ledger_index ASC NULLS LAST,
        t.close_time ASC NULLS LAST,
        pm.tx_hash ASC,
        pm.memo_index ASC
    `,
    [walletAddress, taskId]
  );
  return result.rows;
}

async function candidateTaskPointerRows({ walletAddress, taskId = "", seedCid = "" }) {
  const result = await query(
    `
      SELECT
        pm.*,
        t.ledger_index AS tx_ledger_index,
        t.close_time,
        t.account AS account_address,
        t.destination AS destination_address,
        wt.direction
      FROM pftl_pointer_memos pm
      LEFT JOIN pftl_transactions t ON t.tx_hash = pm.tx_hash
      LEFT JOIN pftl_wallet_transactions wt
        ON wt.tx_hash = pm.tx_hash
       AND wt.wallet_address = $1
      WHERE pm.wallet_address = $1
        AND pm.cid IS NOT NULL
        AND pm.decode_error IS NULL
        AND pm.pointer_kind = ANY($4)
        AND (
          pm.task_id = $2
          OR pm.task_id IS NULL
          OR ($3::text <> '' AND pm.cid = $3)
        )
      ORDER BY
        t.ledger_index ASC NULLS LAST,
        t.close_time ASC NULLS LAST,
        pm.tx_hash ASC,
        pm.memo_index ASC
      LIMIT 500
    `,
    [walletAddress, taskId, seedCid, TASK_POINTER_KINDS]
  );
  return result.rows;
}

function pointerEventFromRow(row) {
  const decoded = safeJson(row.decoded_json);
  return {
    cid: row.cid,
    kind: row.pointer_kind || decoded.kindLabel || "",
    task_id: row.task_id || decoded.taskId || "",
    tx_hash: row.tx_hash,
    ledger_index: row.tx_ledger_index,
    memo_index: row.memo_index,
    source: "pftl_cache.task_pointer",
  };
}

async function hydrateTaskPointerRow(row, { fetchIpfsJson = fetchContextIpfsJson, env = process.env } = {}) {
  const pointer = pointerEventFromRow(row);
  const fetched = await fetchIpfsJson({ cid: pointer.cid });
  if (!fetched?.ok) throw new Error(fetched?.error || "task_ipfs_fetch_failed");
  const payload = await decryptTasknodeServicePayload({ blob: fetched.payload, env });
  return {
    pointer,
    payload,
    tx_hash: row.tx_hash,
  };
}

function statusFromTaskUpdate(payload = {}) {
  const transition = normalizeText(payload.transition);
  if (transition === "accepted") return "accepted";
  if (transition === "refused") return "refused";
  if (transition === "rejected") return "rejected";
  if (transition === "expired") return "expired";
  if (transition === "cancelled") return "cancelled";
  if (transition === "verification_requested") return "verification_requested";
  return "";
}

function reduceHydratedTaskEvents(hydratedEvents) {
  const projections = new Map();
  const offerPayloads = new Map();

  function getProjection(taskId) {
    if (!projections.has(taskId)) {
      projections.set(taskId, {
        task_id: taskId,
        status: "unknown",
        title: "",
        description: "",
        task_kind: "",
        reward_offer_pft: "",
        reward_actual_pft: "",
        request_bundle_cid: "",
        events: [],
      });
    }
    return projections.get(taskId);
  }

  for (const hydrated of hydratedEvents) {
    const payload = safeJson(hydrated.payload);
    const pointer = safeJson(hydrated.pointer);
    const schema = normalizeText(payload.schema);
    const taskId = normalizeText(payload.task_id || pointer.task_id);
    if (!taskId || schema === "pf.task.request.v1") continue;
    const projection = getProjection(taskId);
    projection.events.push({
      schema,
      kind: pointer.kind,
      tx_hash: hydrated.tx_hash,
      cid: pointer.cid,
      event_digest: sha256Hex(payload),
    });

    if (schema === "pf.task.offer.v1") {
      offerPayloads.set(taskId, payload);
      projection.status = "proposed";
      projection.title = normalizeText(payload.title);
      projection.description = normalizeText(payload.description);
      projection.task_kind = normalizeText(payload.task_kind);
      projection.reward_offer_pft = normalizeText(payload.reward_offer?.amount_estimate_pft);
      projection.request_bundle_cid = normalizeText(payload.generation?.request_bundle_cid);
    } else if (schema === "pf.task.update.v1") {
      projection.status = statusFromTaskUpdate(payload) || projection.status;
    } else if (schema === "pf.task.submission.v1") {
      projection.status = payload.phase === "verification_response"
        ? "verification_response_submitted"
        : "submitted";
    } else if (schema === "pf.task.verification_response.v1") {
      projection.status = "verification_response_submitted";
    } else if (schema === "pf.reward.v1") {
      projection.status = "rewarded";
      projection.reward_actual_pft = normalizeText(payload.reward_pft);
    }
  }

  return { projections, offerPayloads };
}

function receiptForProjection({
  projection,
  offerPayload,
  hydratedEvents,
  accountId,
  walletAddress,
  sourceEvent,
}) {
  const taskId = projection.task_id;
  const relevantEvents = hydratedEvents.filter((event) => {
    return normalizeText(event.payload?.task_id || event.pointer?.task_id) === taskId;
  });
  const lastEvent = relevantEvents[relevantEvents.length - 1] || {};
  return {
    run_id: `pftl_cache_reducer_${sourceEvent.id}`,
    task_id: taskId,
    fixture: {
      account_id: accountId,
      request_id: offerPayload?.request_id || "",
    },
    wallets: [
      { role: "user", address: offerPayload?.subject_wallet || walletAddress },
      { role: "task_authority", address: offerPayload?.authority_wallet || "" },
      { role: "allocation_reward", address: offerPayload?.allocation_wallet || "" },
    ],
    cids: {
      request_bundle: projection.request_bundle_cid || "",
      context_doc: Array.isArray(offerPayload?.context_refs) ? offerPayload.context_refs[0]?.cid || "" : "",
      last_event: lastEvent.pointer?.cid || "",
    },
    txs: {
      last_event: { tx_hash: lastEvent.tx_hash || sourceEvent.tx_hash },
    },
    generated_task: offerPayload
      ? {
        title: offerPayload.title || projection.title,
        description: offerPayload.description || projection.description,
        task_kind: offerPayload.task_kind || projection.task_kind,
        reward_offer: offerPayload.reward_offer || {},
        submission_requirement: offerPayload.submission_requirement || {},
        verification_policy: offerPayload.verification_policy || {},
        deadline: {
          accept_by: offerPayload.accept_by || null,
          deadline_at: offerPayload.deadline_at || null,
        },
      }
      : {
        title: projection.title,
        description: projection.description,
        task_kind: projection.task_kind,
        reward_offer: {},
        submission_requirement: {},
        verification_policy: {},
        deadline: {},
      },
    projection: {
      [taskId]: projection,
    },
    hydrated_events: relevantEvents.map((event) => ({
      schema: event.payload?.schema || "",
      task_id: event.payload?.task_id || event.pointer?.task_id || taskId,
      tx_hash: event.tx_hash,
      cid: event.pointer?.cid || "",
      event_digest: sha256Hex(event.payload),
      pointer: event.pointer,
      payload: safeJson(event.payload),
    })),
  };
}

async function reduceTaskProjection(event, { fetchIpfsJson = fetchContextIpfsJson, env = process.env } = {}) {
  if (!event.account_id) throw new Error("task_reducer_account_id_missing");
  const seedPointer = await pointerMemoForReducerEvent(event);
  if (!seedPointer?.cid) throw new Error("task_pointer_missing");

  let taskId = normalizeText(event.task_id || seedPointer.task_id || safeJson(seedPointer.decoded_json).taskId);
  let seedHydrated = null;
  if (!taskId) {
    seedHydrated = await hydrateTaskPointerRow(seedPointer, { fetchIpfsJson, env });
    taskId = normalizeText(seedHydrated.payload?.task_id || seedHydrated.pointer?.task_id);
    if (!taskId && normalizeText(seedHydrated.payload?.schema) === "pf.task.request.v1") {
      return {
        skipped: true,
        reason: "task_request_pointer_without_task_id",
        cid: seedPointer.cid,
        txHash: event.tx_hash,
      };
    }
  }
  if (!taskId) throw new Error("task_reducer_task_id_missing");

  const rows = event.task_id
    ? await taskPointerRows({
      walletAddress: event.wallet_address,
      taskId,
    })
    : await candidateTaskPointerRows({
      walletAddress: event.wallet_address,
      taskId,
      seedCid: seedPointer.cid,
    });
  if (rows.length === 0) throw new Error("task_pointer_rows_missing");

  const hydratedEvents = [];
  const hydratedByCid = new Map();
  if (seedHydrated?.pointer?.cid) hydratedByCid.set(seedHydrated.pointer.cid, seedHydrated);
  for (const row of rows) {
    const existing = hydratedByCid.get(row.cid);
    const hydrated = existing || await hydrateTaskPointerRow(row, { fetchIpfsJson, env });
    hydratedByCid.set(row.cid, hydrated);
    const hydratedTaskId = normalizeText(hydrated.payload?.task_id || hydrated.pointer?.task_id || row.task_id);
    if (hydratedTaskId !== taskId) continue;
    hydratedEvents.push(hydrated);
  }

  const { projections, offerPayloads } = reduceHydratedTaskEvents(hydratedEvents);
  if (projections.size === 0) throw new Error("task_projection_empty");

  const imported = [];
  for (const projection of projections.values()) {
    const receipt = receiptForProjection({
      projection,
      offerPayload: offerPayloads.get(projection.task_id),
      hydratedEvents,
      accountId: event.account_id,
      walletAddress: event.wallet_address,
      sourceEvent: event,
    });
    imported.push(await importTaskReplayReceipt(receipt, {
      source: "pftl_cache_reducer",
      sourceRef: `reducer_event:${event.id}`,
    }));
  }

  return {
    taskId,
    hydratedEventCount: hydratedEvents.length,
    importedTaskCount: imported.length,
    statuses: imported.map((item) => ({
      taskId: item.taskId,
      status: item.status,
    })),
  };
}

export async function processPftlReducerEvent(event, options = {}) {
  const kind = normalizeText(event.reducer_kind);
  if (kind === "wallet_balance_refresh") {
    return {
      walletAddress: event.wallet_address,
      note: "Balance is read live/cache-first by the wallet API; this reducer marks the invalidation event complete.",
    };
  }
  if (kind === "context_pointer_hydrate") return reduceContextPointer(event);
  if (kind === "task_projection_replay") return reduceTaskProjection(event, options);
  throw new Error(`unknown_pftl_reducer_kind:${kind || "missing"}`);
}

export async function runPftlCacheReducerOnce({
  batchLimit = 10,
  maxAttempts = 5,
  logger = console,
  ...options
} = {}) {
  const events = await claimPftlReducerEvents({ limit: batchLimit });
  let completed = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const result = await processPftlReducerEvent(event, options);
      await markPftlReducerEventCompleted({ id: event.id, metadata: result });
      completed += 1;
    } catch (error) {
      await markPftlReducerEventFailed({
        id: event.id,
        attempts: event.attempts,
        error,
        maxAttempts,
      });
      failed += 1;
      logger.warn?.("pftl_cache_reducer_event_failed", {
        id: event.id,
        kind: event.reducer_kind,
        error: safeError(error),
      });
    }
  }

  return {
    ok: true,
    claimed: events.length,
    completed,
    failed,
  };
}

export function startPftlCacheReducerWorker({
  enabled = process.env.PFTL_CACHE_REDUCER_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.PFTL_CACHE_REDUCER_WORKER_INTERVAL_MS || 10000),
  batchLimit = Number(process.env.PFTL_CACHE_REDUCER_BATCH_LIMIT || 10),
  logger = console,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 10000, 2000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 10, 1), 100);
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await runPftlCacheReducerOnce({ batchLimit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("pftl_cache_reducer_tick_failed", { error: safeError(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, safeInterval);
  timer.unref?.();
  runOnce().catch((error) => {
    logger.warn?.("pftl_cache_reducer_initial_tick_failed", { error: safeError(error) });
  });

  return {
    started: true,
    stop: () => clearInterval(timer),
  };
}
