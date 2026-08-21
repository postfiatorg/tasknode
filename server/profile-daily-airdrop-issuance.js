import { Wallet } from "xrpl";
import { pinContextIpfsJson } from "./context-ipfs.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { query, transaction } from "./db/pool.js";
import { moneySeedFromEnv } from "./production-guards.js";
import { encryptTasknodePayload } from "./task-payloads.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";
import {
  dailyAirdropDate as dateOnly,
  dailyAirdropIssuanceRetryable,
  normalizeDailyAirdropIssuance as normalizeIssuance,
  normalizeDailyAirdropIssuanceStatus,
} from "./profile-daily-airdrop-issuance-state.js";
import {
  buildDailyAirdropPayload as airdropPayload,
  dailyAirdropDigest as sha256,
  dailyAirdropPftToDrops as pftToDrops,
  stableDailyAirdropJson as stableJson,
} from "./profile-daily-airdrop-payload.js";

export {
  dailyAirdropIssuanceBlocksRetry,
  dailyAirdropIssuanceRetryable,
  normalizeDailyAirdropIssuanceStatus,
} from "./profile-daily-airdrop-issuance-state.js";

const AIRDROP_POINTER_SCHEMA = 1;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function errorCode(error) {
  return safeText(
    error?.code ||
      error?.engineResult ||
      error?.status ||
      error?.message ||
      error ||
      "daily_airdrop_issuance_failed",
    160
  ).replace(/\s+/g, "_").toLowerCase();
}

function rewardSeed(env = process.env) {
  return moneySeedFromEnv({
    env,
    primaryKeys: ["TASKNODE_DAILY_AIRDROP_SEED"],
    fallbackKeys: [
      "TASKNODE_REWARD_SEED",
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

export async function claimDailyAirdropIssuanceForPublish({
  accountId,
  runId = "",
  allowDryRunPromotion = false,
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("daily_airdrop_account_required");
  const rewardWallet = walletFromSeed(rewardSeed(), "daily_airdrop_reward_seed_missing");
  return transaction(async (client) => {
    const runResult = await client.query(
      `SELECT *
         FROM profile_daily_airdrop_runs
        WHERE account_id = $1
          AND status = 'completed'
          AND ($2 = '' OR id = $2)
        ORDER BY completed_at DESC NULLS LAST,
                 updated_at DESC,
                 created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [normalizedAccount, safeText(runId, 120)]
    );
    const run = runResult.rows[0] || null;
    if (!run) throw new Error("daily_airdrop_completed_run_missing");
    if (run.run_mode !== "production" && !allowDryRunPromotion) {
      // Claiming force-promotes the run to production and pays it. Never silently
      // promote a dry_run (or other non-production) scoring run into a payout.
      throw new Error("daily_airdrop_dry_run_promotion_blocked");
    }
    const amountPft = Number(run.daily_airdrop_pft || 0);
    if (!Number.isFinite(amountPft) || amountPft <= 0) throw new Error("daily_airdrop_amount_not_positive");
    const recipientWallet = safeText(run.input_snapshot?.airdrop_recipient?.wallet_address, 120);
    if (!recipientWallet) throw new Error("daily_airdrop_recipient_missing");
    const submittedConflict = await client.query(
      `SELECT id
         FROM profile_daily_airdrop_issuances
        WHERE account_id = $1
          AND run_date = $2::date
          AND run_id <> $3
          AND status = 'submitted'
        LIMIT 1
        FOR UPDATE`,
      [normalizedAccount, dateOnly(run.run_date), run.id]
    );
    if (submittedConflict.rows[0]?.id) {
      throw new Error("daily_airdrop_account_day_already_submitted");
    }

    const existing = await client.query(
      "SELECT * FROM profile_daily_airdrop_issuances WHERE run_id = $1 LIMIT 1 FOR UPDATE",
      [run.id]
    );
    const existingIssuance = existing.rows[0] || null;
    const existingStatus = normalizeDailyAirdropIssuanceStatus(existingIssuance);
    if (existingStatus === "submitted") {
      return { run, issuance: existingIssuance, rewardWallet, alreadySubmitted: true };
    }
    if (existingIssuance && !dailyAirdropIssuanceRetryable(existingIssuance)) {
      throw new Error(`daily_airdrop_issuance_blocked:${existingStatus || "unknown"}`);
    }

    await client.query(
      `UPDATE profile_daily_airdrop_runs
          SET run_mode = 'production',
              is_canonical = true,
              updated_at = now()
        WHERE id = $1`,
      [run.id]
    );
    run.run_mode = "production";
    run.is_canonical = true;

    const issuanceId = `airdrop_issue_${sha256({ runId: run.id, recipientWallet, amountPft }).slice(0, 24)}`;
    const params = [
      existingIssuance?.id || issuanceId,
      normalizedAccount,
      run.id,
      dateOnly(run.run_date),
      rewardWallet.classicAddress,
      recipientWallet,
      amountPft,
      pftToDrops(amountPft),
    ];
    const claimed = existingIssuance
      ? await client.query(
        `UPDATE profile_daily_airdrop_issuances
            SET source_wallet = $2,
                recipient_wallet = $3,
                amount_pft = $4,
                amount_drops = $5,
                status = 'processing_pre_submit',
                source_cid = '',
                tx_hash = '',
                ledger_index = NULL,
                payload_digest = '',
                error_message = NULL,
                last_error_code = '',
                last_error_message = '',
                attempt_count = attempt_count + 1,
                last_attempt_at = now(),
                submission_attempted_at = NULL,
                signed_tx_hash = '',
                submitted_at = NULL,
                completed_at = NULL,
                reconciled_at = NULL,
                cancelled_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND (
              status IN ('pending', 'failed_before_submit')
              OR (
                status = 'failed'
                AND COALESCE(tx_hash, '') = ''
                AND submitted_at IS NULL
              )
            )
          RETURNING *`,
        [params[0], params[4], params[5], params[6], params[7]]
      )
      : await client.query(
        `INSERT INTO profile_daily_airdrop_issuances (
           id, account_id, run_id, run_date, source_wallet, recipient_wallet,
           amount_pft, amount_drops, status, attempt_count, last_attempt_at
         )
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, 'processing_pre_submit', 1, now())
         RETURNING *`,
        params
      );
    const issuance = claimed.rows[0] || null;
    if (!issuance) throw new Error("daily_airdrop_issuance_claim_failed");
    return { run, issuance, rewardWallet, alreadySubmitted: false };
  });
}

async function markIssuanceSubmitted({ issuanceId, cid, digest, txHash, ledgerIndex } = {}) {
  const result = await query(
    `UPDATE profile_daily_airdrop_issuances
        SET status = 'submitted',
            source_cid = $2,
            payload_digest = $3,
            tx_hash = $4,
            ledger_index = $5,
            updated_at = now(),
            submitted_at = now(),
            completed_at = now(),
            error_message = NULL,
            last_error_code = '',
            last_error_message = ''
      WHERE id = $1
      RETURNING *`,
    [issuanceId, cid, digest, txHash, ledgerIndex || null]
  );
  return normalizeIssuance(result.rows[0] || null);
}

async function markIssuanceSubmitting({ issuanceId, signedTxHash = "" } = {}) {
  const result = await query(
    `UPDATE profile_daily_airdrop_issuances
        SET status = 'submitting',
            submission_attempted_at = now(),
            signed_tx_hash = $2,
            error_message = NULL,
            last_error_code = '',
            last_error_message = '',
            updated_at = now()
      WHERE id = $1
        AND status = 'processing_pre_submit'
      RETURNING *`,
    [safeText(issuanceId, 120), safeText(signedTxHash, 120)]
  );
  const row = result.rows[0] || null;
  if (!row) throw new Error("daily_airdrop_issuance_submit_claim_failed");
  return normalizeIssuance(row);
}

export async function markDailyAirdropIssuancePublishFailure({
  issuanceId,
  error,
  submissionAttempted = false,
} = {}) {
  const message = safeText(error?.message || error || "daily_airdrop_issuance_failed", 1200);
  const code = errorCode(error);
  if (submissionAttempted) {
    await query(
      `UPDATE profile_daily_airdrop_issuances
          SET status = 'submit_unknown',
              error_message = $2,
              last_error_code = $3,
              last_error_message = $2,
              updated_at = now()
        WHERE id = $1
          AND status IN ('processing_pre_submit', 'submitting')`,
      [issuanceId, message, code]
    );
    return;
  }
  await query(
    `UPDATE profile_daily_airdrop_issuances
        SET status = 'failed_before_submit',
            error_message = $2,
            last_error_code = $3,
            last_error_message = $2,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1
        AND status = 'processing_pre_submit'`,
    [issuanceId, message, code]
  );
}

export async function recoverStaleDailyAirdropIssuances({
  preSubmitStaleMinutes = 30,
  submittingStaleMinutes = 30,
  limit = 100,
} = {}) {
  const safePreSubmit = Math.min(Math.max(Number(preSubmitStaleMinutes) || 30, 1), 24 * 60);
  const safeSubmitting = Math.min(Math.max(Number(submittingStaleMinutes) || 30, 1), 24 * 60);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const preSubmit = await query(
    `WITH stale AS (
       SELECT id
         FROM profile_daily_airdrop_issuances
        WHERE status IN ('processing_pre_submit', 'processing')
          AND submission_attempted_at IS NULL
          AND updated_at < now() - ($1::integer * interval '1 minute')
        ORDER BY updated_at ASC
        LIMIT $2
     )
     UPDATE profile_daily_airdrop_issuances i
        SET status = 'failed_before_submit',
            error_message = COALESCE(NULLIF(error_message, ''), 'daily_airdrop_stale_pre_submit_reclaimed'),
            last_error_code = 'daily_airdrop_stale_pre_submit_reclaimed',
            last_error_message = COALESCE(NULLIF(error_message, ''), 'daily_airdrop_stale_pre_submit_reclaimed'),
            completed_at = now(),
            updated_at = now()
       FROM stale
      WHERE i.id = stale.id
      RETURNING i.*`,
    [safePreSubmit, safeLimit]
  );
  const submitting = await query(
    `WITH stale AS (
       SELECT id
         FROM profile_daily_airdrop_issuances
        WHERE status IN ('submitting', 'processing')
          AND (submission_attempted_at IS NOT NULL OR status = 'submitting')
          AND updated_at < now() - ($1::integer * interval '1 minute')
        ORDER BY updated_at ASC
        LIMIT $2
     )
     UPDATE profile_daily_airdrop_issuances i
        SET status = 'submit_unknown',
            error_message = COALESCE(NULLIF(error_message, ''), 'daily_airdrop_stale_submit_unknown'),
            last_error_code = 'daily_airdrop_stale_submit_unknown',
            last_error_message = COALESCE(NULLIF(error_message, ''), 'daily_airdrop_stale_submit_unknown'),
            updated_at = now()
       FROM stale
      WHERE i.id = stale.id
      RETURNING i.*`,
    [safeSubmitting, safeLimit]
  );
  return {
    preSubmit: preSubmit.rows.map(normalizeIssuance),
    submitting: submitting.rows.map(normalizeIssuance),
  };
}

export async function listRetryableDailyAirdropIssuances({
  runDate = "",
  limit = 25,
  maxAttempts = 5,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeMaxAttempts = Math.min(Math.max(Number(maxAttempts) || 5, 1), 100);
  const result = await query(
    `SELECT i.*, r.daily_airdrop_pft::text AS run_daily_airdrop_pft
       FROM profile_daily_airdrop_issuances i
       JOIN profile_daily_airdrop_runs r ON r.id = i.run_id
      WHERE ($1::date IS NULL OR i.run_date = $1::date)
        AND (
          i.status IN ('pending', 'failed_before_submit')
          OR (
            i.status = 'failed'
            AND COALESCE(i.tx_hash, '') = ''
            AND i.submitted_at IS NULL
          )
        )
        AND COALESCE(i.attempt_count, 0) < $2
        AND r.status = 'completed'
        AND r.daily_airdrop_pft > 0
        AND NOT EXISTS (
          SELECT 1
            FROM profile_daily_airdrop_issuances submitted
           WHERE submitted.account_id = i.account_id
             AND submitted.run_date = i.run_date
             AND submitted.run_id <> i.run_id
             AND submitted.status = 'submitted'
        )
      ORDER BY i.run_date ASC, i.updated_at ASC, i.id ASC
      LIMIT $3`,
    [runDate ? dateOnly(runDate) : null, safeMaxAttempts, safeLimit]
  );
  return result.rows.map((row) => normalizeIssuance(row));
}

export async function listOrphanedDailyAirdropRuns({ runDate = "", limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await query(
    `SELECT r.id AS run_id,
            r.account_id,
            r.run_date,
            r.daily_airdrop_pft::text AS amount_pft,
            COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
            r.updated_at
       FROM profile_daily_airdrop_runs r
      WHERE ($1::date IS NULL OR r.run_date = $1::date)
        AND r.run_mode = 'production'
        AND r.status = 'completed'
        AND r.daily_airdrop_pft > 0
        AND NOT EXISTS (
          SELECT 1
            FROM profile_daily_airdrop_issuances i
           WHERE i.run_id = r.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM profile_daily_airdrop_issuances submitted
           WHERE submitted.account_id = r.account_id
             AND submitted.run_date = r.run_date
             AND submitted.status = 'submitted'
        )
      ORDER BY r.run_date ASC, r.updated_at ASC, r.id ASC
      LIMIT $2`,
    [runDate ? dateOnly(runDate) : null, safeLimit]
  );
  return result.rows.map((row) => ({
    runId: row.run_id,
    accountId: row.account_id,
    runDate: dateOnly(row.run_date),
    amountPft: Number(row.amount_pft || 0),
    recipientWallet: row.recipient_wallet || "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}

function dailyAirdropDebtRowStatus(row = {}) {
  // Scoring rows carry profile_daily_airdrop_runs statuses ('running'/'failed').
  // Issuance status normalization must not rewrite them (a failed scoring run is
  // not 'failed_before_submit'; its repair action is retry_scoring, not retry_issuance).
  if (safeText(row.kind, 80) === "scoring") return safeText(row.status, 80);
  return normalizeDailyAirdropIssuanceStatus(row);
}

function nextDebtAction(row = {}) {
  const kind = safeText(row.kind, 80);
  const status = dailyAirdropDebtRowStatus(row);
  if (kind === "scoring" && status === "running") return "wait_or_reclaim_stale_scoring";
  if (kind === "scoring" && status === "failed") return "retry_scoring";
  if (kind === "issuance_missing") {
    return safeText(row.recipient_wallet, 120) ? "retry_issuance" : "inspect";
  }
  if (status === "failed_before_submit" || status === "pending") return "retry_issuance";
  if (status === "processing_pre_submit") return "wait_or_reclaim_pre_submit";
  if (status === "submitting" || status === "submit_unknown") return "reconcile_before_retry";
  return "inspect";
}

export async function listDailyAirdropDebt({ sinceDate = "", limit = 200 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const result = await query(
    `WITH issuance_debt AS (
       SELECT 'issuance' AS kind,
              i.account_id,
              '' AS public_handle,
              i.run_date,
              i.run_id,
              i.id AS issuance_id,
              i.amount_pft::text AS amount_pft,
              i.recipient_wallet,
              CASE
                WHEN i.status = 'failed'
                 AND COALESCE(i.tx_hash, '') = ''
                 AND i.submitted_at IS NULL THEN 'failed_before_submit'
                WHEN i.status = 'processing'
                 AND i.submission_attempted_at IS NULL THEN 'processing_pre_submit'
                WHEN i.status = 'processing' THEN 'submit_unknown'
                ELSE i.status
              END AS status,
              i.error_message,
              i.last_error_code,
              i.last_error_message,
              i.attempt_count,
              i.last_attempt_at,
              i.submission_attempted_at,
              i.signed_tx_hash,
              i.tx_hash,
              i.source_cid,
              i.payload_digest,
              i.updated_at
         FROM profile_daily_airdrop_issuances i
        WHERE ($1::date IS NULL OR i.run_date >= $1::date)
          AND (
            i.status IN ('pending', 'processing', 'processing_pre_submit', 'failed', 'failed_before_submit', 'submitting', 'submit_unknown')
            OR (
              i.status = 'submitted'
              AND (COALESCE(i.tx_hash, '') = '' OR i.submitted_at IS NULL)
            )
          )
     ),
     scoring_debt AS (
       SELECT 'scoring' AS kind,
              r.account_id,
              '' AS public_handle,
              r.run_date,
              r.id AS run_id,
              '' AS issuance_id,
              r.daily_airdrop_pft::text AS amount_pft,
              COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
              r.status,
              r.error_message,
              r.error_message AS last_error_code,
              r.error_message AS last_error_message,
              0::integer AS attempt_count,
              NULL::timestamptz AS last_attempt_at,
              NULL::timestamptz AS submission_attempted_at,
              '' AS signed_tx_hash,
              '' AS tx_hash,
              '' AS source_cid,
              '' AS payload_digest,
              r.updated_at
         FROM profile_daily_airdrop_runs r
        WHERE ($1::date IS NULL OR r.run_date >= $1::date)
          AND r.run_mode = 'production'
          AND r.status IN ('running', 'failed')
          AND NOT EXISTS (
            SELECT 1
              FROM profile_daily_airdrop_runs complete
             WHERE complete.account_id = r.account_id
               AND complete.run_date = r.run_date
               AND complete.run_mode = 'production'
               AND complete.status = 'completed'
          )
     ),
     missing_issuance_debt AS (
       SELECT 'issuance_missing' AS kind,
              r.account_id,
              '' AS public_handle,
              r.run_date,
              r.id AS run_id,
              '' AS issuance_id,
              r.daily_airdrop_pft::text AS amount_pft,
              COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
              'missing_issuance' AS status,
              NULL::text AS error_message,
              '' AS last_error_code,
              '' AS last_error_message,
              0::integer AS attempt_count,
              NULL::timestamptz AS last_attempt_at,
              NULL::timestamptz AS submission_attempted_at,
              '' AS signed_tx_hash,
              '' AS tx_hash,
              '' AS source_cid,
              '' AS payload_digest,
              r.updated_at
         FROM profile_daily_airdrop_runs r
        WHERE ($1::date IS NULL OR r.run_date >= $1::date)
          AND r.run_mode = 'production'
          AND r.status = 'completed'
          AND r.daily_airdrop_pft > 0
          AND NOT EXISTS (
            SELECT 1
              FROM profile_daily_airdrop_issuances i
             WHERE i.run_id = r.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM profile_daily_airdrop_issuances submitted
             WHERE submitted.account_id = r.account_id
               AND submitted.run_date = r.run_date
               AND submitted.status = 'submitted'
          )
     )
     SELECT *
       FROM (
         SELECT * FROM issuance_debt
         UNION ALL
         SELECT * FROM scoring_debt
         UNION ALL
         SELECT * FROM missing_issuance_debt
       ) debt
      ORDER BY run_date DESC, updated_at ASC, account_id ASC
      LIMIT $2`,
    [sinceDate ? dateOnly(sinceDate) : null, safeLimit]
  );
  const accountIds = Array.from(new Set(result.rows.map((row) => safeText(row.account_id, 180)).filter(Boolean)));
  const publicHandles = new Map();
  if (accountIds.length > 0) {
    const handles = await query(
      `SELECT DISTINCT ON (account_id) account_id, public_handle
         FROM user_observability_events
        WHERE account_id = ANY($1::text[])
          AND public_handle <> ''
        ORDER BY account_id, occurred_at DESC, id DESC`,
      [accountIds]
    );
    for (const row of handles.rows) {
      publicHandles.set(row.account_id, row.public_handle || "");
    }
  }
  return result.rows.map((row) => {
    const status = dailyAirdropDebtRowStatus(row);
    return {
      kind: row.kind,
      accountId: row.account_id,
      publicHandle: publicHandles.get(row.account_id) || "",
      runDate: dateOnly(row.run_date),
      runId: row.run_id,
      issuanceId: row.issuance_id || "",
      amountPft: Number(row.amount_pft || 0),
      recipientWallet: row.recipient_wallet || "",
      status,
      retryable:
        (row.kind === "issuance" && dailyAirdropIssuanceRetryable(row)) ||
        (row.kind === "issuance_missing" && Boolean(safeText(row.recipient_wallet, 120))),
      lastError: row.last_error_message || row.error_message || "",
      lastErrorCode: row.last_error_code || "",
      attemptCount: Number(row.attempt_count || 0),
      lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
      submissionAttemptedAt: row.submission_attempted_at ? new Date(row.submission_attempted_at).toISOString() : null,
      signedTxHash: row.signed_tx_hash || "",
      txHash: row.tx_hash || "",
      sourceCid: row.source_cid || "",
      payloadDigest: row.payload_digest || "",
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      nextAction: nextDebtAction({ ...row, status }),
    };
  });
}

async function dailyAirdropReconcileSyncWatermarks({
  row,
  sourceWallet,
  recipientWallet,
  fetchImpl = fetch,
} = {}) {
  // Refresh the local PFTL transaction cache for both money-path wallets before
  // trusting a negative cache search. A stale cache must never justify demoting
  // submit_unknown back to a retryable state (that retry signs a second payment).
  await Promise.all([
    syncPftlWalletTransactions({
      walletAddress: sourceWallet,
      accountId: row.run_account_id || row.account_id,
      role: "daily_airdrop_reward",
      limit: 80,
      maxPages: 1,
      syncKind: "daily_airdrop_reconcile",
      fetchImpl,
    }),
    syncPftlWalletTransactions({
      walletAddress: recipientWallet,
      accountId: row.run_account_id || row.account_id,
      role: "user",
      limit: 80,
      maxPages: 1,
      syncKind: "daily_airdrop_reconcile",
      fetchImpl,
    }),
  ]).catch(() => null);
  await runPftlCacheReducerOnce({ batchLimit: 20 }).catch(() => null);
  const watermarkResult = await query(
    `SELECT wallet_address, last_hot_sync_at
       FROM pftl_sync_wallets
      WHERE wallet_address = ANY($1::text[])`,
    [[sourceWallet, recipientWallet].filter(Boolean)]
  );
  const byWallet = new Map(
    watermarkResult.rows.map((entry) => [entry.wallet_address, entry.last_hot_sync_at || null])
  );
  const submissionAttemptedAt = row.submission_attempted_at
    ? new Date(row.submission_attempted_at)
    : null;
  const toIso = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const walletWatermark = (walletAddress) => {
    const lastHotSyncAt = byWallet.get(walletAddress) || null;
    const syncedAt = lastHotSyncAt ? new Date(lastHotSyncAt) : null;
    const staleForDemote = Boolean(
      submissionAttemptedAt &&
      (!syncedAt || Number.isNaN(syncedAt.getTime()) || syncedAt.getTime() < submissionAttemptedAt.getTime())
    );
    return {
      walletAddress,
      lastHotSyncAt: toIso(lastHotSyncAt),
      staleForDemote,
    };
  };
  const source = walletWatermark(sourceWallet);
  const recipient = walletWatermark(recipientWallet);
  return {
    submissionAttemptedAt: toIso(submissionAttemptedAt),
    sourceWallet: source,
    recipientWallet: recipient,
    staleForDemote: source.staleForDemote || recipient.staleForDemote,
  };
}

export async function reconcileDailyAirdropIssuance({
  runId = "",
  issuanceId = "",
  allowDemote = false,
  forceDemoteStaleSync = false,
  fetchImpl = fetch,
} = {}) {
  const runFilter = safeText(runId, 120);
  const issueFilter = safeText(issuanceId, 120);
  if (!runFilter && !issueFilter) throw new Error("daily_airdrop_reconcile_target_required");
  const target = await query(
    `SELECT i.*, r.input_snapshot, r.account_id AS run_account_id
       FROM profile_daily_airdrop_issuances i
       JOIN profile_daily_airdrop_runs r ON r.id = i.run_id
      WHERE ($1::text = '' OR i.run_id = $1)
        AND ($2::text = '' OR i.id = $2)
      ORDER BY i.updated_at DESC
      LIMIT 1`,
    [runFilter, issueFilter]
  );
  const row = target.rows[0] || null;
  if (!row) throw new Error("daily_airdrop_issuance_missing");
  const status = normalizeDailyAirdropIssuanceStatus(row);
  if (status === "submitted") {
    return { ok: true, alreadySubmitted: true, issuance: normalizeIssuance(row) };
  }
  const amountDrops = safeText(row.amount_drops, 80);
  const sourceWallet = safeText(row.source_wallet, 120);
  const recipientWallet = safeText(row.recipient_wallet, 120);
  const syncWatermarks = await dailyAirdropReconcileSyncWatermarks({
    row,
    sourceWallet,
    recipientWallet,
    fetchImpl,
  });
  const match = await query(
    `SELECT t.tx_hash,
            t.ledger_index,
            t.close_time,
            t.account,
            t.destination,
            t.tx_json->>'Amount' AS amount_drops,
            pm.cid,
            pm.context_id,
            pm.pointer_kind,
            pm.decoded_json
       FROM pftl_transactions t
       LEFT JOIN pftl_pointer_memos pm ON pm.tx_hash = t.tx_hash
      WHERE t.account = $1
        AND t.destination = $2
        AND t.tx_json->>'Amount' = $3
        AND COALESCE(t.transaction_result, '') IN ('', 'tesSUCCESS')
        AND (
          t.tx_hash = $4
          OR t.tx_hash = $5
          OR pm.context_id = $6
          OR pm.cid = $7
        )
      ORDER BY t.ledger_index DESC NULLS LAST, t.updated_at DESC
      LIMIT 1`,
    [
      sourceWallet,
      recipientWallet,
      amountDrops,
      safeText(row.tx_hash, 120),
      safeText(row.signed_tx_hash, 120),
      safeText(row.run_id, 120),
      safeText(row.source_cid, 240),
    ]
  );
  const found = match.rows[0] || null;
  if (found?.tx_hash) {
    const updated = await markIssuanceSubmitted({
      issuanceId: row.id,
      cid: found.cid || row.source_cid || "",
      digest: row.payload_digest || "",
      txHash: found.tx_hash,
      ledgerIndex: found.ledger_index || null,
    });
    await query(
      `UPDATE profile_daily_airdrop_issuances
          SET reconciliation_json = $2::jsonb,
              reconciled_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        JSON.stringify({
          status: "found_submitted",
          checkedAt: new Date().toISOString(),
          txHash: found.tx_hash,
          ledgerIndex: found.ledger_index || null,
          cid: found.cid || "",
          syncWatermarks,
        }),
      ]
    );
    return { ok: true, found: true, issuance: updated, txHash: found.tx_hash, syncWatermarks };
  }
  const reconciliation = {
    status: "not_found",
    checkedAt: new Date().toISOString(),
    sourceWallet,
    recipientWallet,
    amountDrops,
    runId: row.run_id,
    issuanceId: row.id,
    syncWatermarks,
  };
  if (allowDemote && status === "submit_unknown" && syncWatermarks.staleForDemote && !forceDemoteStaleSync) {
    // The cached negative is not trustworthy: at least one wallet's hot-sync
    // watermark predates the submission attempt, so the payment may exist on
    // chain without being visible in the local cache yet. Refuse the demote;
    // operators can override with forceDemoteStaleSync after manual chain review.
    reconciliation.status = "demote_blocked_stale_sync";
    await query(
      `UPDATE profile_daily_airdrop_issuances
          SET reconciliation_json = $2::jsonb,
              reconciled_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(reconciliation)]
    );
    return {
      ok: true,
      found: false,
      demoted: false,
      demoteBlocked: true,
      demoteBlockedReason: "daily_airdrop_demote_blocked_stale_sync",
      status,
      issuance: normalizeIssuance(row),
      reconciliation,
      syncWatermarks,
    };
  }
  if (allowDemote && status === "submit_unknown") {
    reconciliation.forcedDemoteWithStaleSync = Boolean(forceDemoteStaleSync && syncWatermarks.staleForDemote);
    const demoted = await query(
      `UPDATE profile_daily_airdrop_issuances
          SET status = 'failed_before_submit',
              error_message = 'reconciliation_not_found_operator_demoted',
              last_error_code = 'reconciliation_not_found_operator_demoted',
              last_error_message = 'reconciliation_not_found_operator_demoted',
              reconciliation_json = $2::jsonb,
              reconciled_at = now(),
              updated_at = now()
        WHERE id = $1
          AND status = 'submit_unknown'
        RETURNING *`,
      [row.id, JSON.stringify(reconciliation)]
    );
    return {
      ok: true,
      found: false,
      demoted: true,
      issuance: normalizeIssuance(demoted.rows[0] || row),
      reconciliation,
      syncWatermarks,
    };
  }
  await query(
    `UPDATE profile_daily_airdrop_issuances
        SET reconciliation_json = $2::jsonb,
            reconciled_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [row.id, JSON.stringify(reconciliation)]
  );
  return { ok: true, found: false, status, issuance: normalizeIssuance(row), reconciliation, syncWatermarks };
}

export async function issueLatestDailyAirdrop({ accountId, runId = "", allowDryRunPromotion = false } = {}) {
  const claim = await claimDailyAirdropIssuanceForPublish({ accountId, runId, allowDryRunPromotion });
  if (claim.alreadySubmitted) {
    return {
      ok: true,
      alreadySubmitted: true,
      runId: claim.run.id,
      issuance: normalizeIssuance(claim.issuance),
    };
  }

  const amountPft = Number(claim.issuance.amount_pft || 0);
  const recipientWallet = claim.issuance.recipient_wallet;
  const payload = airdropPayload({
    run: claim.run,
    issuance: claim.issuance,
    sourceWallet: claim.rewardWallet.classicAddress,
    recipientWallet,
    amountPft,
  });

  let submissionAttempted = false;
  try {
    const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
    if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
    const recipientPublicKeys = await taskPayloadRecipientPublicKeys({
      tasknodeKey,
      accountId,
      walletAddress: recipientWallet,
    });
    const encryptedPayload = await encryptTasknodePayload({
      plaintext: stableJson(payload),
      recipientPublicKeys,
    });
    const pin = await pinContextIpfsJson({
      payload: encryptedPayload,
      name: `tasknode-pf-daily-airdrop-v1-${claim.run.id}`,
      keyvalues: {
        app: "tasknodeofficial",
        content_kind: "REWARD",
        schema: payload.schema,
        account_id: claim.run.account_id,
        run_id: claim.run.id,
        recipient_wallet: recipientWallet,
      },
    });
    const pointerMemo = buildPftPointerMemo({
      cid: pin.cid,
      kind: "REWARD",
      schema: AIRDROP_POINTER_SCHEMA,
      flags: POINTER_FLAGS.encrypted,
      contextId: claim.run.id,
    });
    const prepared = await preparePftPointerTransaction({
      account: claim.rewardWallet.classicAddress,
      destination: recipientWallet,
      pointerMemo,
      amountDrops: pftToDrops(amountPft),
    });
    const signed = claim.rewardWallet.sign(prepared.txJson);
    const signedTxHash = safeText(signed.hash || signed.tx_hash || "", 120);
    await markIssuanceSubmitting({
      issuanceId: claim.issuance.id,
      signedTxHash,
    });
    submissionAttempted = true;
    const submitted = await submitSignedPftTransaction({
      signedTxBlob: signed.tx_blob,
      expectedAccount: claim.rewardWallet.classicAddress,
      expectedDestination: recipientWallet,
      expectedAmountDrops: pftToDrops(amountPft),
    });
    const issuance = await markIssuanceSubmitted({
      issuanceId: claim.issuance.id,
      cid: pin.cid,
      digest: `sha256:${pin.sha256}`,
      txHash: submitted.txHash,
      ledgerIndex: submitted.ledgerIndex,
    });
    await Promise.all([
      syncPftlWalletTransactions({
        walletAddress: claim.rewardWallet.classicAddress,
        accountId: claim.run.account_id,
        role: "daily_airdrop_reward",
        limit: 80,
        maxPages: 1,
        syncKind: "daily_airdrop_issuance",
      }),
      syncPftlWalletTransactions({
        walletAddress: recipientWallet,
        accountId: claim.run.account_id,
        role: "user",
        limit: 80,
        maxPages: 1,
        syncKind: "daily_airdrop_issuance",
      }),
    ]).catch(() => null);
    await runPftlCacheReducerOnce({ batchLimit: 20 }).catch(() => null);
    await recordUserObservabilityEvent({
      eventType: "user.profile.daily_airdrop_issued",
      accountId: claim.run.account_id || accountId,
      walletAddress: recipientWallet,
      walletScope: "recipient_wallet",
      txHash: submitted.txHash || "",
      cid: pin.cid || "",
      sourceSurface: "profile",
      sourceRoute: "server/profile-daily-airdrop-issuance.js::issueLatestDailyAirdrop",
      resultStatus: "submitted",
      reasonCode: "daily_airdrop_issuance",
      metadata: {
        runId: claim.run.id,
        issuanceId: claim.issuance.id,
        sourceWallet: claim.rewardWallet.classicAddress,
        payloadDigest: `sha256:${pin.sha256}`,
        ledgerIndex: submitted.ledgerIndex || null,
        alreadySubmitted: false,
      },
      metrics: {
        amountPft,
      },
    }).catch(() => {});
    return {
      ok: true,
      alreadySubmitted: false,
      runId: claim.run.id,
      issuance,
      payload,
    };
  } catch (error) {
    await markDailyAirdropIssuancePublishFailure({
      issuanceId: claim.issuance.id,
      error,
      submissionAttempted,
    }).catch(() => null);
    throw error;
  }
}
