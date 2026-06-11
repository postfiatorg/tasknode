import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { reconcileDailyAirdropIssuance } from "../server/profile-daily-airdrop-issuance.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "../server/pftl-pointer.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

// Keep the in-reconcile wallet sync offline and deterministic: disable the WSS
// history path (it does not use the injected fetch) and point the RPC path at a
// closed local port so the injected offline fetch is the only transport.
process.env.PFTL_HISTORY_WSS_URL = "";
process.env.PFTL_HISTORY_WSS_URL_FALLBACKS = "";
process.env.PFTL_WSS_URL_FALLBACKS = "";
process.env.PFTL_HISTORY_RPC_URL = "http://127.0.0.1:9/offline-smoke";
process.env.PFTL_HISTORY_RPC_URL_FALLBACKS = "";
process.env.PFTL_RPC_URL_FALLBACKS = "";

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_reconcile_${suffix}`;
const runId = `airdrop_reconcile_run_${suffix}`;
const issuanceId = `airdrop_reconcile_issue_${suffix}`;
const txHash = `AIRDROP_RECONCILE_TX_${suffix}`;
const sourceWallet = Wallet.generate().classicAddress;
const recipientWallet = Wallet.generate().classicAddress;
const sourceCid = `bafyairdropreconcile${suffix}`;
const demoteAccountId = `acct_airdrop_demote_${suffix}`;
const demoteRunId = `airdrop_demote_run_${suffix}`;
const demoteIssuanceId = `airdrop_demote_issue_${suffix}`;
const demoteSourceWallet = Wallet.generate().classicAddress;
const demoteRecipientWallet = Wallet.generate().classicAddress;

// The reconcile path syncs both wallets before trusting the cache; keep the smoke
// offline and deterministic by injecting a failing fetch (watermarks stay as seeded).
const offlineFetch = async () => {
  throw new Error("reconcile_smoke_offline");
};

async function cleanup() {
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = ANY($1::text[])", [
    [issuanceId, demoteIssuanceId],
  ]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = ANY($1::text[])", [[runId, demoteRunId]]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = ANY($1::text[])", [
    [sourceWallet, recipientWallet, demoteSourceWallet, demoteRecipientWallet],
  ]);
}

async function setWalletHotSync({ wallets, lastHotSyncAtSql }) {
  await query(
    `UPDATE pftl_sync_wallets
        SET last_hot_sync_at = ${lastHotSyncAtSql},
            updated_at = now()
      WHERE wallet_address = ANY($1::text[])`,
    [wallets]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("profile daily airdrop reconcile smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score, what_raised_today,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         completed_at
       )
       VALUES (
         $1, $2, '2026-01-16'::date, 'production', true, 'completed',
         15, 90, 'reconcile smoke', 'sha256:reconcile-smoke',
         $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
       )`,
      [
        runId,
        accountId,
        JSON.stringify({ airdrop_recipient: { wallet_address: recipientWallet } }),
      ]
    );
    await query(
      `INSERT INTO profile_daily_airdrop_issuances (
         id, account_id, run_id, run_date, source_wallet, recipient_wallet,
         amount_pft, amount_drops, status, source_cid, signed_tx_hash,
         attempt_count, submission_attempted_at, updated_at
       )
       VALUES (
         $1, $2, $3, '2026-01-16'::date, $4, $5,
         15, '15000000', 'submit_unknown', $6, $7,
         1, now() - interval '5 minutes', now() - interval '5 minutes'
       )`,
      [issuanceId, accountId, runId, sourceWallet, recipientWallet, sourceCid, txHash]
    );

    const pointer = buildPftPointerMemo({
      cid: sourceCid,
      kind: "REWARD",
      schema: 1,
      flags: POINTER_FLAGS.encrypted,
      contextId: runId,
    });
    await query(
      `INSERT INTO pftl_transactions (
         tx_hash, ledger_index, tx_type, validated, account, destination,
         transaction_result, close_time, tx_json, meta_json
       )
       VALUES (
         $1, 987654, 'Payment', true, $2, $3,
         'tesSUCCESS', now(), $4::jsonb, $5::jsonb
       )`,
      [
        txHash,
        sourceWallet,
        recipientWallet,
        JSON.stringify({
          TransactionType: "Payment",
          Account: sourceWallet,
          Destination: recipientWallet,
          Amount: "15000000",
          hash: txHash,
        }),
        JSON.stringify({ TransactionResult: "tesSUCCESS" }),
      ]
    );
    await query(
      `INSERT INTO pftl_pointer_memos (
         tx_hash, memo_index, wallet_address, memo_type, memo_format,
         pointer_kind, schema_version, cid, context_id, memo_data_hex,
         decoded_json
       )
       VALUES ($1, 0, $2, $3, $4, 'REWARD', '1', $5, $6, $7, $8::jsonb)`,
      [
        txHash,
        recipientWallet,
        pointer.memoTypeHex,
        pointer.memoFormatHex,
        sourceCid,
        runId,
        pointer.memoDataHex,
        JSON.stringify(pointer.payload),
      ]
    );

    const result = await reconcileDailyAirdropIssuance({ runId, fetchImpl: offlineFetch });
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.txHash, txHash);
    assert.equal(result.issuance.status, "submitted");
    assert.equal(result.issuance.txHash, txHash);
    assert.ok(result.syncWatermarks, "reconcile result must expose both wallet sync watermarks");

    // Demote guard: a submit_unknown row with no cached tx must not be demoted while
    // either wallet's hot-sync watermark predates the submission attempt.
    await query(
      `INSERT INTO profile_daily_airdrop_runs (
         id, account_id, run_date, run_mode, is_canonical, status,
         daily_airdrop_pft, retention_value_score, what_raised_today,
         input_hash, input_snapshot, provider, model, prompt_version, prompt_digest,
         completed_at
       )
       VALUES (
         $1, $2, '2026-01-16'::date, 'production', true, 'completed',
         15, 90, 'demote smoke', 'sha256:demote-smoke',
         $3::jsonb, 'smoke', 'smoke', 'daily_airdrop_v1', 'sha256:prompt', now()
       )`,
      [
        demoteRunId,
        demoteAccountId,
        JSON.stringify({ airdrop_recipient: { wallet_address: demoteRecipientWallet } }),
      ]
    );
    async function resetDemoteIssuance() {
      await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = $1", [demoteIssuanceId]);
      await query(
        `INSERT INTO profile_daily_airdrop_issuances (
           id, account_id, run_id, run_date, source_wallet, recipient_wallet,
           amount_pft, amount_drops, status, signed_tx_hash,
           attempt_count, submission_attempted_at, updated_at
         )
         VALUES (
           $1, $2, $3, '2026-01-16'::date, $4, $5,
           15, '15000000', 'submit_unknown', $6,
           1, now() - interval '5 minutes', now() - interval '5 minutes'
         )`,
        [demoteIssuanceId, demoteAccountId, demoteRunId, demoteSourceWallet, demoteRecipientWallet, `SIGNED_${suffix}`]
      );
    }

    await resetDemoteIssuance();
    // Stale: the offline sync registers the wallets but cannot advance last_hot_sync_at,
    // so both watermarks predate submission_attempted_at.
    const blocked = await reconcileDailyAirdropIssuance({
      runId: demoteRunId,
      allowDemote: true,
      fetchImpl: offlineFetch,
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.found, false);
    assert.equal(Boolean(blocked.demoted), false);
    assert.equal(blocked.demoteBlocked, true);
    assert.equal(blocked.demoteBlockedReason, "daily_airdrop_demote_blocked_stale_sync");
    assert.equal(blocked.issuance.status, "submit_unknown");
    assert.equal(blocked.syncWatermarks.staleForDemote, true);
    assert.equal(blocked.reconciliation.status, "demote_blocked_stale_sync");
    assert.ok(blocked.reconciliation.syncWatermarks, "reconciliation_json must record sync watermarks");
    const blockedRow = await query(
      "SELECT status, reconciliation_json FROM profile_daily_airdrop_issuances WHERE id = $1",
      [demoteIssuanceId]
    );
    assert.equal(blockedRow.rows[0].status, "submit_unknown");
    assert.equal(blockedRow.rows[0].reconciliation_json.status, "demote_blocked_stale_sync");
    assert.ok(blockedRow.rows[0].reconciliation_json.syncWatermarks);

    // Fresh: once both watermarks are newer than the submission attempt, --allow-demote works.
    await setWalletHotSync({
      wallets: [demoteSourceWallet, demoteRecipientWallet],
      lastHotSyncAtSql: "now()",
    });
    const demotedFresh = await reconcileDailyAirdropIssuance({
      runId: demoteRunId,
      allowDemote: true,
      fetchImpl: offlineFetch,
    });
    assert.equal(demotedFresh.demoted, true);
    assert.equal(demotedFresh.issuance.status, "failed_before_submit");
    assert.equal(demotedFresh.syncWatermarks.staleForDemote, false);

    // Force flag: a stale watermark can be overridden only with the explicit force flag.
    await resetDemoteIssuance();
    await setWalletHotSync({
      wallets: [demoteSourceWallet, demoteRecipientWallet],
      lastHotSyncAtSql: "now() - interval '1 hour'",
    });
    const demotedForced = await reconcileDailyAirdropIssuance({
      runId: demoteRunId,
      allowDemote: true,
      forceDemoteStaleSync: true,
      fetchImpl: offlineFetch,
    });
    assert.equal(demotedForced.demoted, true);
    assert.equal(demotedForced.issuance.status, "failed_before_submit");
    assert.equal(demotedForced.syncWatermarks.staleForDemote, true);
    assert.equal(demotedForced.reconciliation.forcedDemoteWithStaleSync, true);

    console.log("profile daily airdrop reconcile smoke ok");
  } finally {
    await cleanup().catch(() => null);
    await closePool().catch(() => null);
  }
}

main().catch(async (error) => {
  await cleanup().catch(() => null);
  await closePool().catch(() => null);
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
