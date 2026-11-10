// Independent exactly-once evidence for plan 06 criterion 2 (concurrent retry
// and crash safety). Unlike scripts/airdrop-payment-guard.test.mjs, which races
// promises inside one process, every claim/marker below runs in its own OS
// process, and the crash phases die by SIGKILL at the documented points. The
// assertions only ever read database state and the real exported issuance API;
// no ledger write path is exercised. Requires TASKNODE_DIAG_TEST_DATABASE_URL
// pointing at an isolated local 127.0.0.1 *_test database.
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Wallet } from "xrpl";

const CHILD = new URL("./airdrop-exactly-once-child.mjs", import.meta.url);

function databaseUrl(schema) {
  const url = new URL(process.env.TASKNODE_DIAG_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.href;
}

async function withSchema(t, run) {
  const url = new URL(process.env.TASKNODE_DIAG_TEST_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.pathname.endsWith("_test"));
  const schema = `crash_${process.pid}_${t.name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}`.toLowerCase();
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const seed = Wallet.generate().seed;
  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl(schema),
    TASKNODE_DATABASE_ENABLED: "true",
    TASKNODE_DAILY_AIRDROP_SEED: seed,
  };
  // pool.js memoizes one pool per process and reads DATABASE_URL at first use;
  // closePool() in the finally block below resets it for the next schema.
  process.env.DATABASE_URL = childEnv.DATABASE_URL;
  process.env.TASKNODE_DATABASE_ENABLED = "true";
  process.env.TASKNODE_DAILY_AIRDROP_SEED = seed;
  let closePool = async () => {};
  try {
    const imported = await import("../server/db/pool.js");
    const query = imported.query;
    closePool = imported.closePool;
    for (const file of ["019_profile_daily_airdrop.sql", "020_profile_daily_airdrop_issuance.sql", "057_profile_daily_airdrop_remediation.sql"]) {
      await query(await readFile(new URL(`../server/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    await query(`CREATE TABLE account_blacklist(id text, account_id text, status text, wallet_addresses text[])`);
    await query(`CREATE TABLE pftl_pointer_memos(tx_hash text, context_id text, cid text, pointer_kind text, decoded_json jsonb)`);
    await query(`CREATE TABLE pftl_transactions(
      tx_hash text, tx_type text DEFAULT 'Payment', ledger_index integer, close_time timestamptz,
      account text, destination text, tx_json jsonb, meta_json jsonb, validated boolean,
      transaction_result text, updated_at timestamptz DEFAULT now())`);
    const result = await run({ query, closePool, admin, schema, childEnv });
    return result;
  } finally {
    await closePool().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

function runChild(childEnv, args) {
  return new Promise((resolve) => {
    const child = spawnProcess(args, childEnv);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("exit", (code, signal) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      let parsed = null;
      try { parsed = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { parsed = null; }
      resolve({ code, signal, stdout, parsed });
    });
  });
}

function spawnProcess(args, childEnv) {
  return spawn(process.execPath, [fileURLToPath(CHILD), ...args], {
    env: { ...childEnv, DATABASE_URL: childEnv.DATABASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function seedDebt(query, { accountId, runId, amountPft = 15 }) {
  await query(`INSERT INTO profile_daily_airdrop_runs(id,account_id,run_date,run_mode,status,daily_airdrop_pft,input_snapshot)
    VALUES ($1,$2,'2026-11-10','production','completed',$3,$4)`,
    [runId, accountId, amountPft, JSON.stringify({ airdrop_recipient: { wallet_address: `recipient-${runId}` } })]);
}

const syncWalletsFresh = async () => ({ staleForDemote: false });

test("eight OS processes race one debt: exactly one claim wins and one issuance row exists", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    await seedDebt(query, { accountId: "race-account", runId: "race-run" });
    const children = await Promise.all(Array.from({ length: 8 }, () =>
      runChild(childEnv, ["claim", "race-account", "race-run"])));
    const winners = children.filter((c) => c.parsed?.ok);
    const losers = children.filter((c) => !c.parsed?.ok);
    assert.equal(winners.length, 1, `exactly one claim wins: ${JSON.stringify(children.map((c) => c.parsed || { crashed: c.signal }))}`);
    assert.equal(losers.length, 7, "all other processes lose the race");
    assert.ok(losers.every((c) => /daily_airdrop_issuance_claim_failed|daily_airdrop_issuance_blocked|duplicate key|unique constraint/i.test(c.parsed?.error || c.stdout)),
      `losers must fail on the atomic claim fence, got ${JSON.stringify(losers.map((c) => c.parsed?.error))}`);
    const rows = (await query("SELECT id,status,attempt_count FROM profile_daily_airdrop_issuances")).rows;
    assert.equal(rows.length, 1, "exactly one issuance row was ever created");
    assert.equal(rows[0].status, "processing_pre_submit");
    assert.equal(rows[0].attempt_count, 1, "the race produced exactly one attempt");
    assert.equal(rows[0].id, winners[0].parsed.claim.issuanceId);
  });
});

test("four OS processes race the pre-broadcast marker: exactly one authorization wins", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    await seedDebt(query, { accountId: "marker-account", runId: "marker-run" });
    const first = await runChild(childEnv, ["claim", "marker-account", "marker-run"]);
    const issuanceId = first.parsed.claim.issuanceId;
    const races = await Promise.all(Array.from({ length: 4 }, () =>
      runChild(childEnv, ["marker-race", "marker-account", "marker-run", issuanceId, String(first.parsed.claim.attemptCount), "race-hash"])));
    const marked = races.filter((c) => c.parsed?.ok);
    const fenced = races.filter((c) => !c.parsed?.ok);
    assert.equal(marked.length, 1, `exactly one marker transition wins: ${JSON.stringify(races.map((c) => c.parsed))}`);
    assert.ok(fenced.every((c) => /submit_claim_failed/i.test(c.parsed?.error || "")),
      `losing markers must be fenced: ${JSON.stringify(fenced.map((c) => c.parsed?.error))}`);
    const row = (await query("SELECT status,signed_tx_hash,submission_attempted_at FROM profile_daily_airdrop_issuances WHERE id=$1", [issuanceId])).rows[0];
    assert.equal(row.status, "submitting");
    assert.equal(row.signed_tx_hash, "race-hash");
    assert.ok(row.submission_attempted_at, "the durable marker is present before any broadcast");
  });
});

test("SIGKILL after claim, before marker: stale recovery reclaims once and the dead attempt can never submit", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    const { claimDailyAirdropIssuanceForPublish: claim, markIssuanceSubmitting: submit,
      recoverStaleDailyAirdropIssuances: recover, listRetryableDailyAirdropIssuances: retryable,
      reconcileDailyAirdropIssuance: reconcile } =
      await import("../server/profile-daily-airdrop-issuance.js");
    await seedDebt(query, { accountId: "crash1-account", runId: "crash1-run" });
    const crashed = await runChild(childEnv, ["claim-crash", "crash1-account", "crash1-run"]);
    assert.equal(crashed.signal, "SIGKILL", "child really died by SIGKILL");
    let row = (await query("SELECT status,attempt_count,submission_attempted_at,signed_tx_hash FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.status, "processing_pre_submit", "committed claim survives the crash");
    assert.equal(row.submission_attempted_at, null);
    assert.equal(row.signed_tx_hash, "");
    await query("UPDATE profile_daily_airdrop_issuances SET updated_at=now()-interval '2 hours'");
    const reclaimed = await recover({ preSubmitStaleMinutes: 30, submittingStaleMinutes: 30 });
    assert.equal(reclaimed.preSubmit.length, 1, "the dead claim is reclaimed exactly once");
    assert.equal(reclaimed.submitting.length, 0);
    row = (await query("SELECT status FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.status, "failed_before_submit", "reclaimed as retryable, never as payable evidence");
    const queued = await retryable({ runDate: "2026-11-10" });
    assert.equal(queued.length, 1);
    // Retry worker claims a fresh attempt; the dead attempt is fenced out.
    const second = (await claim({ accountId: "crash1-account", runId: "crash1-run" })).issuance;
    assert.equal(second.attempt_count, 2);
    await assert.rejects(submit({ issuanceId: second.id, signedTxHash: "dead-attempt-hash", attemptCount: 1 }),
      /submit_claim_failed/, "the dead attempt number can no longer authorize a broadcast");
    // The live attempt marks, the payment lands, and reconciliation settles once.
    await submit({ issuanceId: second.id, signedTxHash: "crash1-live-hash", attemptCount: 2, cid: "cid-crash1", digest: "digest-crash1" });
    const notFound = await reconcile({ issuanceId: second.id }, { syncWallets: syncWalletsFresh });
    assert.equal(notFound.found, false, "no ledger row yet: nothing settles");
    await query(`INSERT INTO pftl_transactions(tx_hash,account,destination,ledger_index,tx_json,meta_json,validated,transaction_result)
      VALUES ('crash1-live-hash', $1, $2, 7930000, '{"Amount":"15000000"}', '{"delivered_amount":"15000000"}', true, 'tesSUCCESS')`,
      [second.source_wallet, second.recipient_wallet]);
    const settled = await reconcile({ issuanceId: second.id }, { syncWallets: syncWalletsFresh });
    assert.equal(settled.found, true);
    assert.equal(settled.issuance.status, "submitted");
    assert.equal((await reconcile({ issuanceId: second.id }, { syncWallets: syncWalletsFresh })).alreadySubmitted, true,
      "second reconciliation cannot pay or settle again");
    const again = await claim({ accountId: "crash1-account", runId: "crash1-run" });
    assert.equal(again.alreadySubmitted, true, "any later worker sees already-submitted, never a new payment");
    const rows = (await query("SELECT count(*)::int n, sum(CASE WHEN status='submitted' THEN 1 ELSE 0 END)::int submitted FROM profile_daily_airdrop_issuances")).rows[0];
    assert.deepEqual(rows, { n: 1, submitted: 1 }, "one issuance row, settled once");
  });
});

test("SIGKILL after durable marker, before broadcast outcome: no blind retry, only validated exact delivery settles", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    const { claimDailyAirdropIssuanceForPublish: claim, recoverStaleDailyAirdropIssuances: recover,
      listRetryableDailyAirdropIssuances: retryable, reconcileDailyAirdropIssuance: reconcile } =
      await import("../server/profile-daily-airdrop-issuance.js");
    await seedDebt(query, { accountId: "crash2-account", runId: "crash2-run" });
    const crashed = await runChild(childEnv, ["claim-marker-crash", "crash2-account", "crash2-run"]);
    assert.equal(crashed.signal, "SIGKILL", "child really died by SIGKILL");
    let row = (await query("SELECT status,signed_tx_hash,source_cid,payload_digest FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.status, "submitting", "durable marker survived the crash");
    const signedHash = row.signed_tx_hash;
    assert.ok(signedHash && row.source_cid && row.payload_digest, "signed hash, CID and digest are durable");
    await query("UPDATE profile_daily_airdrop_issuances SET updated_at=now()-interval '2 hours'");
    const reclaimed = await recover({ preSubmitStaleMinutes: 30, submittingStaleMinutes: 30 });
    assert.equal(reclaimed.preSubmit.length, 0, "a marked submission is never demoted to retryable");
    assert.deepEqual(reclaimed.submitting.map((r) => r.status), ["submit_unknown"],
      "crashed submission becomes submit_unknown, which only reconciliation can settle");
    row = (await query("SELECT status FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.status, "submit_unknown");
    assert.equal((await retryable({ runDate: "2026-11-10" })).length, 0, "never listed as retryable");
    await assert.rejects(claim({ accountId: "crash2-account", runId: "crash2-run" }),
      /issuance_blocked:submit_unknown/, "concurrent retry claim is refused");
    const noLedger = await reconcile({ runId: "crash2-run", allowDemote: true, forceDemoteStaleSync: true }, { syncWallets: syncWalletsFresh });
    assert.equal(noLedger.found, false);
    assert.equal(noLedger.demoted, false, "even forced demote cannot authorize a second payment");
    assert.equal(noLedger.demoteBlocked, true);
    // A validated payment with the wrong delivered amount must not settle it.
    await query(`INSERT INTO pftl_transactions(tx_hash,account,destination,ledger_index,tx_json,meta_json,validated,transaction_result)
      VALUES ($1,$2,$3,7930001,'{"Amount":"15000000"}','{"delivered_amount":"1"}',true,'tesSUCCESS')`,
      [signedHash, (await query("SELECT source_wallet s FROM profile_daily_airdrop_issuances")).rows[0].s,
        (await query("SELECT recipient_wallet r FROM profile_daily_airdrop_issuances")).rows[0].r]);
    const partial = await reconcile({ runId: "crash2-run" }, { syncWallets: syncWalletsFresh });
    assert.equal(partial.found, false, "partial delivery never settles a debt");
    // Exact validated delivery by the signed hash settles exactly once.
    await query("UPDATE pftl_transactions SET meta_json='{\"delivered_amount\":\"15000000\"}'");
    const settled = await reconcile({ runId: "crash2-run" }, { syncWallets: syncWalletsFresh });
    assert.equal(settled.found, true);
    assert.equal(settled.issuance.status, "submitted");
    assert.equal(settled.txHash, signedHash);
    assert.equal((await reconcile({ runId: "crash2-run" }, { syncWallets: syncWalletsFresh })).alreadySubmitted, true);
    const rows = (await query("SELECT count(*)::int n FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(rows.n, 1, "no second issuance was ever created");
    const validatedPayments = (await query("SELECT count(*)::int n FROM pftl_transactions WHERE validated AND transaction_result='tesSUCCESS'")).rows[0].n;
    assert.equal(validatedPayments, 1, "exactly one payment exists for this debt");
  });
});

test("ambiguous broadcast outcome (submit_unknown) reconciles once with no duplicate payment", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    const { claimDailyAirdropIssuanceForPublish: claim, reconcileDailyAirdropIssuance: reconcile,
      listRetryableDailyAirdropIssuances: retryable } =
      await import("../server/profile-daily-airdrop-issuance.js");
    await seedDebt(query, { accountId: "ambig-account", runId: "ambig-run" });
    const first = await runChild(childEnv, ["claim-marker-unknown", "ambig-account", "ambig-run"]);
    assert.equal(first.parsed.ok, true);
    const issuanceId = first.parsed.issuanceId;
    let row = (await query("SELECT status,signed_tx_hash FROM profile_daily_airdrop_issuances WHERE id=$1", [issuanceId])).rows[0];
    assert.equal(row.status, "submit_unknown");
    assert.ok(row.signed_tx_hash);
    assert.equal((await retryable({ runDate: "2026-11-10" })).length, 0, "ambiguous outcome is never blindly retryable");
    await assert.rejects(claim({ accountId: "ambig-account", runId: "ambig-run" }), /issuance_blocked:submit_unknown/);
    const miss = await reconcile({ runId: "ambig-run", allowDemote: true }, { syncWallets: async () => ({ staleForDemote: true }) });
    assert.equal(miss.demoted, false, "stale cache cannot demote an ambiguous submission to payable");
    assert.equal(miss.demoteBlocked, true);
    await query(`INSERT INTO pftl_transactions(tx_hash,account,destination,ledger_index,tx_json,meta_json,validated,transaction_result)
      VALUES ($1,$2,$3,7930002,'{"DeliverMax":"15000000"}','{"delivered_amount":"15000000"}',true,'tesSUCCESS')`,
      [row.signed_tx_hash,
        (await query("SELECT source_wallet s FROM profile_daily_airdrop_issuances WHERE id=$1", [issuanceId])).rows[0].s,
        (await query("SELECT recipient_wallet r FROM profile_daily_airdrop_issuances WHERE id=$1", [issuanceId])).rows[0].r]);
    const settled = await reconcile({ runId: "ambig-run" }, { syncWallets: syncWalletsFresh });
    assert.equal(settled.found, true, "validated exact DeliverMax delivery settles the ambiguous outcome");
    assert.equal(settled.issuance.status, "submitted");
    assert.equal((await reconcile({ runId: "ambig-run" }, { syncWallets: syncWalletsFresh })).alreadySubmitted, true);
    assert.equal((await claim({ accountId: "ambig-account", runId: "ambig-run" })).alreadySubmitted, true);
    row = (await query("SELECT count(*)::int n FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.n, 1);
  });
});

test("pre-submit failure is retryable and the attempt-count fence survives process restarts", async (t) => {
  await withSchema(t, async ({ query, childEnv }) => {
    await seedDebt(query, { accountId: "fence-account", runId: "fence-run" });
    const first = await runChild(childEnv, ["claim-fail-before-submit", "fence-account", "fence-run"]);
    assert.equal(first.parsed.ok, true);
    const row = (await query("SELECT id,status,attempt_count FROM profile_daily_airdrop_issuances")).rows[0];
    assert.equal(row.status, "failed_before_submit");
    assert.equal(row.attempt_count, 1);
    const second = await runChild(childEnv, ["claim-fail-before-submit", "fence-account", "fence-run"]);
    assert.equal(second.parsed.ok, true);
    const after = (await query("SELECT status,attempt_count FROM profile_daily_airdrop_issuances WHERE id=$1", [row.id])).rows[0];
    assert.equal(after.attempt_count, 2, "each retry attempt is counted exactly once");
    assert.equal((await query("SELECT count(*)::int n FROM profile_daily_airdrop_issuances")).rows[0].n, 1,
      "retries reuse the same issuance row: no duplicate obligation can be created");
  });
});
