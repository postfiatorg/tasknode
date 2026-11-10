import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";

process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";
const { tableMap } = await import("../server/system-status-base.js");
const { closePool } = await import("../server/db/pool.js");
const { networkAllocationHealthItem, hiveBoardSecretaryMemoItem } = await import("../server/system-status-task-workers.js");
const { hiveBoardSecretaryCadenceSeconds, hiveBoardSecretaryScanStatus } = await import("../server/hive-board-secretary-status.js");
const { reconcileDailyAirdropIssuance } = await import("../server/profile-daily-airdrop-issuance.js");
after(closePool);

const nowMs = Date.parse("2026-11-10T02:00:00Z");
const scanAt = new Date(nowMs - 50 * 60_000).toISOString();
const lease = { status: "released", metadata_json: { secretary_scan: { ok: true, completedAt: scanAt, scanned: 7, completed: 0, failed: 0 } } };

test("allocation status actually calls its reader after discovering existing tables", async (t) => {
  t.mock.method(pg.Pool.prototype, "query", async (_sql, [tables]) => ({ rows: tables.map(table_name => ({ table_name, exists: true })) }));
  const tables = await tableMap();
  let reads = 0;
  const result = await networkAllocationHealthItem(tables, nowMs, { readHealth: async () => {
    reads += 1;
    return { aggregate: { executed_creates_24h: 3 }, evaluation: { status: "ok", label: "3 created" } };
  } });
  assert.equal(reads, 1);
  assert.equal(result.counts.executed_creates_24h, 3);
  const failed = await networkAllocationHealthItem(tables, nowMs, { readHealth: async () => { throw new Error("private connection details"); } });
  assert.equal(failed.status, "unknown");
  assert.equal(failed.lastError, "allocation_health_query_failed");
  assert.doesNotMatch(JSON.stringify(failed), /private connection/);
});

test("secretary uses the hourly scan even when an unchanged memo is months old", async (t) => {
  delete process.env.TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS;
  t.mock.method(pg.Pool.prototype, "query", async (sql) => {
    if (sql.includes("FROM board_manager_leases")) return { rows: [lease] };
    if (sql.includes("SELECT id, project_id")) return { rows: [{ id: "memo", project_id: "board", generated_at: "2026-07-24T00:00:00Z" }] };
    if (sql.includes("FROM network_projects")) return { rows: [{ count: 7 }] };
    return { rows: [] };
  });
  const result = await hiveBoardSecretaryMemoItem(new Map(["board_manager_leases", "hive_board_secretary_memos", "network_projects"].map(x => [x, true])), nowMs);
  assert.equal(result.status, "ok");
  assert.equal(result.statusLabel, "Boards checked");
  assert.equal(result.cadence, "3600s");
  assert.equal(result.lastSuccessAt, scanAt);
  assert.ok(result.details.some(x => x.includes("2026-07-24")));
});

test("secretary reports missing, failed and overdue scans honestly", () => {
  const options = { enabled: true, nowMs, cadenceSeconds: hiveBoardSecretaryCadenceSeconds({}) };
  assert.equal(hiveBoardSecretaryScanStatus({ ...options }).status, "unknown");
  assert.equal(hiveBoardSecretaryScanStatus({ ...options, lease, nowMs: nowMs + 2 * 3600_000 }).status, "critical");
  assert.equal(hiveBoardSecretaryScanStatus({ ...options, lease: { ...lease, metadata_json: { secretary_scan: { ok: false, completedAt: scanAt } } } }).status, "warning");
  assert.equal(hiveBoardSecretaryScanStatus({ ...options, enabled: false, lease }).status, "disabled");
  assert.equal(hiveBoardSecretaryScanStatus({ ...options, lease: { status: "active", claimed_at: scanAt } }).label, "Scanning boards");
});

for (const [label, stale, force] of [["fresh but incomplete history", false, false], ["stale sync", true, false], ["forced stale sync", true, true]]) {
  test(`airdrop keeps uncertain payment blocked after cache miss: ${label}`, async (t) => {
    const writes = [];
    t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
      if (sql.includes("SELECT i.*")) return { rows: [{ id: "issue", run_id: "run", status: "submit_unknown", amount_drops: "15000000" }] };
      if (sql.includes("FROM pftl_transactions")) {
        assert.match(sql, /t.validated = true/);
        assert.match(sql, /t.transaction_result = 'tesSUCCESS'/);
        assert.match(sql, /delivered_amount/);
        return { rows: [] };
      }
      if (sql.includes("UPDATE profile_daily_airdrop_issuances")) { writes.push({ sql, params }); return { rows: [] }; }
      throw new Error(`Unexpected query ${sql}`);
    });
    const result = await reconcileDailyAirdropIssuance({ runId: "run", allowDemote: true, forceDemoteStaleSync: force }, {
      syncWallets: async () => ({ staleForDemote: stale }),
    });
    assert.equal(result.demoted, false);
    assert.equal(result.demoteBlocked, true);
    assert.equal(result.issuance.status, "submit_unknown");
    assert.equal(writes.length, 1);
    assert.doesNotMatch(writes[0].sql, /SET status|failed_before_submit/);
    assert.equal(JSON.parse(writes[0].params[1]).status, stale && !force ? "demote_blocked_stale_sync" : "demote_blocked_unproven_nonpayment");
  });
}

test("PostgreSQL: cache miss never frees guard; only validated exact delivery settles it", {
  skip: !process.env.TASKNODE_DIAG_TEST_DATABASE_URL,
}, async (t) => {
  const url = new URL(process.env.TASKNODE_DIAG_TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test"), "isolated local test database required");
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  const { readFile } = await import("node:fs/promises");
  try {
    await client.query("BEGIN");
    for (const file of ["019_profile_daily_airdrop.sql", "020_profile_daily_airdrop_issuance.sql", "057_profile_daily_airdrop_remediation.sql"]) {
      await client.query(await readFile(new URL(`../server/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    // Only the cache columns read by reconciliation are needed for this fixture.
    await client.query(`CREATE TEMP TABLE pftl_transactions (
      tx_hash text, tx_type text DEFAULT 'Payment', ledger_index integer, close_time timestamptz, account text,
      destination text, tx_json jsonb, meta_json jsonb, validated boolean,
      transaction_result text, updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE pftl_pointer_memos (
      tx_hash text, cid text, context_id text, pointer_kind text, decoded_json jsonb);
      INSERT INTO profile_daily_airdrop_runs (id, account_id, run_date, run_mode, status)
      VALUES ('run', 'account', '2026-11-10', 'production', 'completed');
      INSERT INTO profile_daily_airdrop_issuances
      (id, account_id, run_id, run_date, source_wallet, recipient_wallet, amount_pft, amount_drops, status, signed_tx_hash)
      VALUES ('issue', 'account', 'run', '2026-11-10', 'source', 'recipient', 15, '15000000', 'submit_unknown', 'hash');`);
    t.mock.method(pg.Pool.prototype, "query", (sql, params) => client.query(sql, params));
    const dependencies = { syncWallets: async () => ({ staleForDemote: false }) };
    const invoke = () => reconcileDailyAirdropIssuance({ runId: "run", allowDemote: true, forceDemoteStaleSync: true }, dependencies);
    assert.equal((await invoke()).demoted, false);
    await client.query(`INSERT INTO pftl_transactions
      (tx_hash, account, destination, tx_json, meta_json, validated, transaction_result)
      VALUES ('hash','source','recipient','{"Amount":"15000000"}', '{"delivered_amount":"15000000"}',false,'tesSUCCESS')`);
    assert.equal((await invoke()).found, false, "provisional result stays guarded");
    await client.query("UPDATE pftl_transactions SET validated=true, transaction_result='tecUNFUNDED_PAYMENT'");
    assert.equal((await invoke()).found, false, "failed payment is not marked paid");
    await client.query(`UPDATE pftl_transactions SET transaction_result='tesSUCCESS', meta_json='{"delivered_amount":"1"}'`);
    assert.equal((await invoke()).found, false, "partial delivery is not marked paid");
    await client.query(`UPDATE pftl_transactions SET meta_json='{}'`);
    assert.equal((await invoke()).found, false, "missing delivery proof stays guarded");
    const guarded = await client.query("SELECT status, signed_tx_hash FROM profile_daily_airdrop_issuances WHERE id='issue'");
    assert.deepEqual(guarded.rows[0], { status: "submit_unknown", signed_tx_hash: "hash" });
    await client.query(`UPDATE pftl_transactions SET meta_json='{"delivered_amount":"15000000"}'`);
    await client.query(`UPDATE pftl_transactions SET tx_hash='unrelated';
      INSERT INTO pftl_pointer_memos (tx_hash, cid, context_id) VALUES ('unrelated','','')`);
    assert.equal((await invoke()).found, false, "blank CID cannot match an unrelated payment");
    await client.query("UPDATE pftl_transactions SET tx_hash='hash'");
    const settled = await invoke();
    assert.equal(settled.found, true);
    assert.equal(settled.issuance.status, "submitted");
    assert.equal((await invoke()).alreadySubmitted, true, "reconciliation replays the settled issuance");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
