import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { pinContextIpfsJson } from "./context-ipfs.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { query, transaction } from "./db/pool.js";
import { encryptTasknodePayload } from "./task-payloads.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";

const AIRDROP_POINTER_SCHEMA = 1;
const PFT_DROPS_PER_PFT = 1_000_000;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
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

function pftToDrops(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return String(Math.round(parsed * PFT_DROPS_PER_PFT));
}

function rewardSeed(env = process.env) {
  return safeText(
    env.TASKNODE_DAILY_AIRDROP_SEED ||
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

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeIssuance(row = null) {
  if (!row) return null;
  return {
    id: row.id || "",
    accountId: row.account_id || "",
    runId: row.run_id || "",
    runDate: row.run_date ? dateOnly(row.run_date) : "",
    sourceWallet: row.source_wallet || "",
    recipientWallet: row.recipient_wallet || "",
    amountPft: Number(row.amount_pft || 0),
    amountDrops: row.amount_drops || "",
    status: row.status || "",
    sourceCid: row.source_cid || "",
    txHash: row.tx_hash || "",
    ledgerIndex: row.ledger_index || null,
    payloadDigest: row.payload_digest || "",
    errorMessage: row.error_message || "",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function airdropPayload({ run, issuance, sourceWallet, recipientWallet, amountPft }) {
  const now = new Date().toISOString();
  return {
    schema: "pf.daily_airdrop.v1",
    protocol: "tasknode.pftl",
    created_at: now,
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    run_id: run.id,
    issuance_id: issuance.id,
    event_id: `evt_${sha256({ runId: run.id, recipientWallet, amountPft }).slice(0, 24)}`,
    account_id: run.account_id,
    actor_wallet: sourceWallet,
    authority_wallet: sourceWallet,
    allocation_wallet: sourceWallet,
    recipient_wallet_address: recipientWallet,
    reward_pft: Number(amountPft).toFixed(6),
    reward_tier: "daily_airdrop",
    reward_summary: run.what_raised_today || "",
    retention_value_score: Number(run.retention_value_score || 0),
    what_raised_today: run.what_raised_today || "",
    what_kept_it_lower: run.what_kept_it_lower || "",
    to_improve_tomorrow: run.to_improve_tomorrow || "",
    alignment_score_7d: Number(run.alignment_score_7d || 0),
    actual_airdrop_pft_7d: Number(run.actual_airdrop_pft_7d || 0),
    max_possible_airdrop_pft_7d: Number(run.max_possible_airdrop_pft_7d || 0),
    run_date: dateOnly(run.run_date),
    prompt_version: run.prompt_version || "",
    prompt_digest: run.prompt_digest || "",
    input_hash: run.input_hash || "",
  };
}

export async function claimDailyAirdropIssuanceForPublish({ accountId, runId = "" } = {}) {
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
    const amountPft = Number(run.daily_airdrop_pft || 0);
    if (!Number.isFinite(amountPft) || amountPft <= 0) throw new Error("daily_airdrop_amount_not_positive");
    const recipientWallet = safeText(run.input_snapshot?.airdrop_recipient?.wallet_address, 120);
    if (!recipientWallet) throw new Error("daily_airdrop_recipient_missing");

    const existing = await client.query(
      "SELECT * FROM profile_daily_airdrop_issuances WHERE run_id = $1 LIMIT 1 FOR UPDATE",
      [run.id]
    );
    if (existing.rows[0]?.status === "submitted") {
      return { run, issuance: existing.rows[0], rewardWallet, alreadySubmitted: true };
    }
    if (existing.rows[0]?.status === "processing") {
      throw new Error("daily_airdrop_issuance_in_progress");
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
      existing.rows[0]?.id || issuanceId,
      normalizedAccount,
      run.id,
      dateOnly(run.run_date),
      rewardWallet.classicAddress,
      recipientWallet,
      amountPft,
      pftToDrops(amountPft),
    ];
    const claimed = existing.rows[0]
      ? await client.query(
        `UPDATE profile_daily_airdrop_issuances
            SET source_wallet = $2,
                recipient_wallet = $3,
                amount_pft = $4,
                amount_drops = $5,
                status = 'processing',
                source_cid = '',
                tx_hash = '',
                ledger_index = NULL,
                payload_digest = '',
                error_message = NULL,
                submitted_at = NULL,
                completed_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND status IN ('pending', 'failed')
          RETURNING *`,
        [params[0], params[4], params[5], params[6], params[7]]
      )
      : await client.query(
        `INSERT INTO profile_daily_airdrop_issuances (
           id, account_id, run_id, run_date, source_wallet, recipient_wallet,
           amount_pft, amount_drops, status
         )
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, 'processing')
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
            error_message = NULL
      WHERE id = $1
      RETURNING *`,
    [issuanceId, cid, digest, txHash, ledgerIndex || null]
  );
  return normalizeIssuance(result.rows[0] || null);
}

export async function markDailyAirdropIssuancePublishFailure({
  issuanceId,
  error,
  submissionAttempted = false,
} = {}) {
  const message = safeText(error?.message || error || "daily_airdrop_issuance_failed", 1200);
  if (submissionAttempted) {
    await query(
      `UPDATE profile_daily_airdrop_issuances
          SET status = 'processing',
              error_message = $2,
              updated_at = now()
        WHERE id = $1
          AND status = 'processing'`,
      [issuanceId, message]
    );
    return;
  }
  await query(
    `UPDATE profile_daily_airdrop_issuances
        SET status = 'failed',
            error_message = $2,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1
        AND status = 'processing'`,
    [issuanceId, message]
  );
}

export async function issueLatestDailyAirdrop({ accountId, runId = "" } = {}) {
  const claim = await claimDailyAirdropIssuanceForPublish({ accountId, runId });
  if (claim.alreadySubmitted) {
    return {
      ok: true,
      alreadySubmitted: true,
      runId: claim.run.id,
      issuance: normalizeIssuance(claim.issuance),
    };
  }

  const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
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
    submissionAttempted = true;
    const submitted = await submitSignedPftTransaction({
      signedTxBlob: signed.tx_blob,
      expectedAccount: claim.rewardWallet.classicAddress,
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
