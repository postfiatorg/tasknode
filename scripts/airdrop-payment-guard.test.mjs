import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { Wallet } from "xrpl";
import { dailyAirdropHasSubmissionEvidence, assertDailyAirdropPaymentAllowed } from "../server/profile-daily-airdrop-guard.js";

test("submission evidence overrides a retryable label", () => {
  for (const field of ["submission_attempted_at", "submitted_at", "signed_tx_hash", "tx_hash"]) {
    assert.equal(dailyAirdropHasSubmissionEvidence({ status: "failed_before_submit", [field]: "present" }), true);
  }
  assert.equal(dailyAirdropHasSubmissionEvidence({ status: "failed_before_submit" }), false);
});

test("an explicit scoring-debt hold blocks payment before any database or signer work", async () => {
  await assert.rejects(assertDailyAirdropPaymentAllowed({ query: () => { throw new Error("must not query"); } },
    { run: { id: "held-run" } }, { TASKNODE_DAILY_AIRDROP_HELD_RUN_IDS: "other, held-run" }), /operator_held/);
});

test("PostgreSQL: concurrent claims, crash/reclaim fence, markers, index and blacklists", {
  skip: !process.env.TASKNODE_DIAG_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.TASKNODE_DIAG_TEST_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.pathname.endsWith("_test"));
  const schema = `guard_${process.pid}`;
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  process.env.TASKNODE_DATABASE_ENABLED = "true";
  process.env.TASKNODE_DAILY_AIRDROP_SEED = Wallet.generate().seed;
  const { query, closePool } = await import("../server/db/pool.js");
  const { claimDailyAirdropIssuanceForPublish: claim, markIssuanceSubmitting: submit,
    markDailyAirdropIssuancePublishFailure: fail, recoverStaleDailyAirdropIssuances: recover } =
    await import("../server/profile-daily-airdrop-issuance.js");
  try {
    for (const file of ["019_profile_daily_airdrop.sql", "020_profile_daily_airdrop_issuance.sql", "057_profile_daily_airdrop_remediation.sql"]) {
      await query(await readFile(new URL(`../server/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    await query(`CREATE TABLE account_blacklist(id text, account_id text, status text, wallet_addresses text[]);
      CREATE TABLE pftl_pointer_memos(tx_hash text, context_id text, cid text);
      INSERT INTO profile_daily_airdrop_runs(id,account_id,run_date,run_mode,status,daily_airdrop_pft,input_snapshot)
      VALUES ('guard-run','guard-account','2026-07-10','production','completed',15,
        '{"airdrop_recipient":{"wallet_address":"fixture-recipient"}}')`);
    const args = { accountId: "guard-account", runId: "guard-run" };
    const races = await Promise.allSettled(Array.from({ length: 5 }, () => claim(args)));
    assert.equal(races.filter(r => r.status === "fulfilled").length, 1, "one locked claim wins");
    const first = races.find(r => r.status === "fulfilled").value.issuance;
    await query("UPDATE profile_daily_airdrop_issuances SET updated_at=now()-interval '2 hours' WHERE id=$1", [first.id]);
    const locker = new pg.Client({ connectionString: url.href }); await locker.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM profile_daily_airdrop_issuances WHERE id=$1 FOR UPDATE", [first.id]);
    const reclaiming = recover();
    let waiting = false;
    for (let n = 0; n < 100 && !waiting; n++) {
      waiting = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%WITH stale AS%' AND pid<>pg_backend_pid()")).rowCount > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "reclaimer must race behind the locked submit transition");
    await locker.query("UPDATE profile_daily_airdrop_issuances SET status='submitting',submission_attempted_at=now(),signed_tx_hash='racing-hash',updated_at=now() WHERE id=$1", [first.id]);
    await locker.query("COMMIT"); await locker.end();
    assert.equal((await reclaiming).preSubmit.length, 0, "stale snapshot cannot demote a concurrent submit");
    await query("UPDATE profile_daily_airdrop_issuances SET status='processing_pre_submit',submission_attempted_at=NULL,signed_tx_hash='',updated_at=now()-interval '2 hours' WHERE id=$1", [first.id]);
    await recover();
    await assert.rejects(claim({ ...args, expectedRecoveryDigest: "outdated-preview" }), /recovery_preview_changed/);
    const second = (await claim(args)).issuance;
    assert.equal(second.attempt_count, first.attempt_count + 1);
    await assert.rejects(submit({ issuanceId: first.id, signedTxHash: "old", attemptCount: first.attempt_count }), /submit_claim_failed/);
    await fail({ issuanceId: first.id, error: "stale worker", attemptCount: first.attempt_count });
    assert.equal((await query("SELECT status FROM profile_daily_airdrop_issuances WHERE id=$1", [first.id])).rows[0].status, "processing_pre_submit");
    await query("INSERT INTO account_blacklist VALUES ('block','guard-account','active','{}')");
    await assert.rejects(submit({ issuanceId: second.id, signedTxHash: "new", attemptCount: second.attempt_count }), /blacklisted/);
    await query("DELETE FROM account_blacklist");
    await query("INSERT INTO pftl_pointer_memos VALUES ('indexed','guard-run','cid')");
    await assert.rejects(submit({ issuanceId: second.id, signedTxHash: "new", attemptCount: second.attempt_count }), /indexed_reward/);
    await query("DELETE FROM pftl_pointer_memos");
    const marked = await submit({ issuanceId: second.id, signedTxHash: "new", attemptCount: second.attempt_count, cid: "saved-cid", digest: "saved-digest" });
    assert.equal(marked.status, "submitting");
    assert.ok(marked.submissionAttemptedAt);
    assert.equal(marked.sourceCid, "saved-cid");
    await assert.rejects(claim(args), /issuance_blocked:submitting/);
    await query("UPDATE profile_daily_airdrop_issuances SET status='failed_before_submit'");
    await assert.rejects(claim(args), /submission_evidence_requires_reconciliation/);
    assert.equal((await query("SELECT signed_tx_hash FROM profile_daily_airdrop_issuances")).rows[0].signed_tx_hash, "new");
    await query("UPDATE profile_daily_airdrop_issuances SET status='submitted',submitted_at=now(),tx_hash='new'");
    assert.equal((await claim(args)).alreadySubmitted, true);
  } finally {
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
