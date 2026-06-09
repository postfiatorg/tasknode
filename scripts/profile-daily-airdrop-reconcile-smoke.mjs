import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { reconcileDailyAirdropIssuance } from "../server/profile-daily-airdrop-issuance.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "../server/pftl-pointer.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const accountId = `acct_airdrop_reconcile_${suffix}`;
const runId = `airdrop_reconcile_run_${suffix}`;
const issuanceId = `airdrop_reconcile_issue_${suffix}`;
const txHash = `AIRDROP_RECONCILE_TX_${suffix}`;
const sourceWallet = Wallet.generate().classicAddress;
const recipientWallet = Wallet.generate().classicAddress;
const sourceCid = `bafyairdropreconcile${suffix}`;

async function cleanup() {
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = $1", [txHash]);
  await query("DELETE FROM profile_daily_airdrop_issuances WHERE id = $1", [issuanceId]);
  await query("DELETE FROM profile_daily_airdrop_runs WHERE id = $1", [runId]);
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

    const result = await reconcileDailyAirdropIssuance({ runId });
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.txHash, txHash);
    assert.equal(result.issuance.status, "submitted");
    assert.equal(result.issuance.txHash, txHash);

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
