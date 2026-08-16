import { pinContextIpfsJson } from "./context-ipfs.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { query, transaction } from "./db/pool.js";
import { applyOffchainTaskTransition } from "./offchain-task-lifecycle.js";
import { encryptTasknodePayload } from "./task-payloads.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";
import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";
import {
  TASK_POINTER_SCHEMA,
  parseJsonObject,
  safeObject,
  safeText,
  sha256,
  stableJson,
  taskReviewRetryDelayMs,
  workerClaimStaleSeconds,
} from "./task-review-core.js";

export async function callOpenAiJson({ promptPath, promptVersion, responseFormat, input, modelEnv = "TASKNODE_TASK_REVIEW_MODEL" }) {
  const systemPrompt = loadPrompt(promptPath);
  const model = safeText(process.env[modelEnv] || AMBIENT_MODELS.structured, 120);
  const startedAt = Date.now();
  const timeoutMs = Math.max(5000, Number(process.env.TASKNODE_TASK_REVIEW_PROVIDER_TIMEOUT_MS || 45000));
  try {
    const result = await ambientChatCompletion({
      capability: "strict_json",
      timeoutMs,
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Use this task packet and return only valid JSON.\n\n${stableJson(input)}`,
          },
        ],
        response_format: responseFormat,
        reasoning: { effort: "high" },
      },
    });
    const body = result.body;
    const output = parseJsonObject(body?.choices?.[0]?.message?.content || "");
    return {
      output,
      metadata: {
        provider: "ambient",
        model,
        prompt_version: promptVersion,
        prompt_digest: promptDigest(systemPrompt),
        input_packet_digest: sha256(input),
        output_digest: sha256(output),
        latency_ms: Date.now() - startedAt,
        parse_status: "ok",
        provider_response_id: body.id || "",
      },
    };
  } catch (error) {
    if (error?.code === "ambient_timeout") throw new Error("task_review_ambient_timeout");
    throw error;
  }
}

export async function publishAuthorityPointer({
  payload,
  contentKind = "TASK_UPDATE",
  destination,
  kind = "TASK_UPDATE",
  signerWallet,
  tasknodeKey,
  accountId = "",
  amountDrops = "1",
}) {
  let stage = "payload_preparation";
  try {
    const recipientPublicKeys = await taskPayloadRecipientPublicKeys({
      tasknodeKey,
      accountId,
      walletAddress: payload.subject_wallet || destination,
    });
    const encryptedPayload = await encryptTasknodePayload({
      plaintext: stableJson(payload),
      recipientPublicKeys,
    });
    stage = "ipfs_pin";
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
    stage = "transaction_prepare";
    const prepared = await preparePftPointerTransaction({
      account: signerWallet.classicAddress,
      destination,
      pointerMemo,
      amountDrops,
    });
    const signed = signerWallet.sign(prepared.txJson);
    stage = "transaction_submit";
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
  } catch (error) {
    if (error && typeof error === "object" && typeof error.submissionAttempted !== "boolean") {
      error.submissionAttempted = stage === "transaction_submit";
      error.submissionStage = stage;
    }
    throw error;
  }
}

export async function syncTaskWallets({
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

export async function claimSubmittedTasks({ limit = 1 } = {}) {
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

export async function claimVerificationResponses({ limit = 1 } = {}) {
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
              AND NOT (
                pub.status = 'retry_wait'
                AND COALESCE(NULLIF(pub.metadata_json->>'retry_after', '')::timestamptz, '-infinity'::timestamptz) <= now()
              )
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

export async function clearWorkerClaim({ taskId, workerName, error = "" }) {
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

export async function markWorkerPublished({ taskId, workerName, published = {} }) {
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

export async function acquireReviewPublicationLock({ taskId, workerName, metadata = {} } = {}) {
  const result = await query(
    `
      INSERT INTO task_review_publications (
        task_id, worker_name, status, metadata_json, reserved_at, updated_at
      )
      VALUES ($1, $2, 'reserved', $3::jsonb, now(), now())
      ON CONFLICT (task_id, worker_name) DO UPDATE
      SET status = 'reserved',
          error = '',
          metadata_json = task_review_publications.metadata_json || EXCLUDED.metadata_json,
          reserved_at = now(),
          updated_at = now()
      WHERE task_review_publications.status = 'retry_wait'
        AND COALESCE(
              NULLIF(task_review_publications.metadata_json->>'retry_after', '')::timestamptz,
              '-infinity'::timestamptz
            ) <= now()
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

export async function markReviewPublicationPublished({ taskId, workerName, published = {}, metadata = {} } = {}) {
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

export async function markReviewPublicationError({ taskId, workerName, error = "", metadata = {} } = {}) {
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

export async function markReviewPublicationRetryWait({ taskId, workerName, error = "", metadata = {} } = {}) {
  return transaction(async (client) => {
    const current = await client.query(
      `
        SELECT metadata_json
        FROM task_review_publications
        WHERE task_id = $1 AND worker_name = $2
        FOR UPDATE
      `,
      [taskId, workerName]
    );
    if (!current.rows[0]) return null;
    const currentMetadata = safeObject(current.rows[0].metadata_json);
    const retryCount = Math.max(0, Number(currentMetadata.retry_count) || 0) + 1;
    const retryAfter = new Date(Date.now() + taskReviewRetryDelayMs(retryCount - 1)).toISOString();
    const nextMetadata = {
      ...currentMetadata,
      ...safeObject(metadata),
      retry_count: retryCount,
      retry_after: retryAfter,
      submission_attempted: false,
    };
    await client.query(
      `
        UPDATE task_review_publications
        SET status = 'retry_wait',
            error = $3,
            metadata_json = $4::jsonb,
            updated_at = now()
        WHERE task_id = $1 AND worker_name = $2
      `,
      [taskId, workerName, safeText(error, 1000), JSON.stringify(nextMetadata)]
    );
    return { retryCount, retryAfter };
  });
}

export async function releaseReviewPublicationLock({ taskId, workerName } = {}) {
  await query(
    `
      DELETE FROM task_review_publications
      WHERE task_id = $1 AND worker_name = $2 AND status = 'reserved'
    `,
    [taskId, workerName]
  );
}

export function publicationLockPublishedRef(lockRow = {}) {
  const txHash = safeText(lockRow?.source_tx_hash, 120);
  const cid = safeText(lockRow?.source_cid, 240);
  if (!txHash && !cid) return null;
  return { txHash, cid };
}

export function directWritePublishedRef(recorded = {}, extra = {}) {
  const event = safeObject(recorded.event);
  return {
    txHash: safeText(event.sourceTxHash, 240),
    cid: safeText(event.sourceCid, 240),
    digest: event.eventDigest ? `sha256:${event.eventDigest}` : "",
    ...safeObject(extra),
  };
}

export async function directWriteReviewTransition({
  row = {},
  transition = "",
  payload = {},
  metadata = {},
  sourceTxHash = "",
  sourceCid = "",
} = {}) {
  return applyOffchainTaskTransition({
    accountId: row.account_id,
    walletAddress: row.subject_wallet,
    task: row,
    transition,
    payload: {
      offchainPayload: payload,
      sourceTxHash,
      sourceCid,
      cid: sourceCid,
    },
    metadata: {
      source: "task_review_worker",
      ...safeObject(metadata),
    },
  });
}
