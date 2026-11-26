import assert from "node:assert/strict";
import test from "node:test";
import { recoverDailyAirdropDebt } from "../server/profile-daily-airdrop-recovery.js";

test("recovery defaults to read-only; execution requires exact unchanged preview and no holds", async () => {
  const run = { id: "run", account_id: "account", run_date: "2026-07-10", run_mode: "production", status: "completed",
    daily_airdrop_pft: 15, input_snapshot: { airdrop_recipient: { wallet_address: "fixture-wallet-1234" } } };
  const issuance = { id: "issue", status: "failed_before_submit", account_id: "account", recipient_wallet: "fixture-wallet-1234",
    amount_drops: "15000000", attempt_count: 5 };
  let sends = 0, blacklisted = false, indexed = false;
  const dependencies = { read: async sql => {
    assert.ok(sql.trim().startsWith("SELECT"), "preview must not write or sign");
    if (sql.includes("row_to_json")) return { rows: [{ run, issuance, handle: "fixture" }] };
    if (sql.includes("account_blacklist")) return { rows: blacklisted ? [{ id: "block" }] : [] };
    if (sql.includes("pftl_pointer_memos")) return { rows: indexed ? [{ tx_hash: "paid" }] : [] };
    return { rows: [] };
  }, issue: async args => {
    sends++; assert.equal(args.runId, "run"); assert.ok(args.expectedRecoveryDigest);
    return { issuance: { status: "submitted", txHash: "receipt", ledgerIndex: 1 } };
  } };
  const preview = await recoverDailyAirdropDebt({ runId: "run" }, dependencies);
  assert.equal(sends, 0); assert.equal(preview.payable, true);
  assert.equal(preview.recipient, "fixtu…1234");
  await assert.rejects(recoverDailyAirdropDebt({ runId: "run", execute: true }, dependencies), /preview_changed/);
  run.daily_airdrop_pft = 16;
  await assert.rejects(recoverDailyAirdropDebt({ runId: "run", execute: true, expectedDigest: preview.previewDigest }, dependencies), /preview_changed/);
  run.daily_airdrop_pft = 15;
  for (const hold of ["blacklist", "indexed", "attempted"]) {
    blacklisted = hold === "blacklist"; indexed = hold === "indexed";
    issuance.submission_attempted_at = hold === "attempted" ? "2026-07-10" : null;
    assert.equal((await recoverDailyAirdropDebt({ runId: "run", execute: true, expectedDigest: preview.previewDigest }, dependencies)).paid, false);
  }
  blacklisted = false; indexed = false; issuance.submission_attempted_at = null;
  assert.equal((await recoverDailyAirdropDebt({ runId: "run", execute: true, expectedDigest: preview.previewDigest }, dependencies)).paid, true);
  assert.equal(sends, 1);
});
