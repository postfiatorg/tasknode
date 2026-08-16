#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("ethereum_deposit_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-ethereum-deposit-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const legacyAccount = `acct_ethdep_legacy_${suffix}`;
const legacyIndex = 1_000_000_000 + Math.floor(Date.now() / 1000);
const addressForIndex = (index) => `0x${BigInt(index).toString(16).padStart(40, "0")}`;
const deriveAddress = (index) => ({ address: addressForIndex(index), derivationPath: `m/44'/60'/0'/0/${index}` });
const runtime = await import("../server/runtime-store.js");
runtime.getOrCreateEthereumDepositAccount({
  accountId: legacyAccount,
  deriveAddress,
  assets: ["ETH", "USDC"],
  startIndex: legacyIndex,
});
runtime.updateEthereumDepositSync({
  accountId: legacyAccount,
  observedBalances: { USDC: { raw: "25000000", amount: "25" } },
  creditedBalances: { USDC: { raw: "25000000", amount: "25" } },
  syncStatus: "ready",
  blockTag: "safe",
});

delete process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { closePool, query } = await import("../server/db/pool.js");
const {
  ethereumDepositStorageStatus,
  getEthereumDepositAccount,
  getOrCreateEthereumDepositAccount,
  migrateLegacyEthereumDeposits,
  retireEthereumDepositAccount,
  updateEthereumDepositSync,
} = await import("../server/repositories/ethereum-deposit-accounts.js");

const firstAccount = `acct_ethdep_first_${suffix}`;
const secondAccount = `acct_ethdep_second_${suffix}`;
try {
  assert.equal(ethereumDepositStorageStatus().adapter, "postgres");
  await query("DELETE FROM runtime_state_migrations WHERE name = 'ethereum_deposits_to_postgres_v1'");
  const migrated = await migrateLegacyEthereumDeposits();
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.count, 1);
  const legacy = await getEthereumDepositAccount({ accountId: legacyAccount });
  assert.equal(legacy.creditedBalances.USDC.amount, "25");
  assert.equal(runtime.legacyEthereumDepositSnapshotForMigration().active[legacyAccount], undefined, "legacy JSON clears only after the transaction commits");
  assert.equal((await migrateLegacyEthereumDeposits()).migrated, false, "the import marker makes startup idempotent");

  const [first, second] = await Promise.all([
    getOrCreateEthereumDepositAccount({ accountId: firstAccount, deriveAddress, assets: ["USDC"], startIndex: legacyIndex + 1 }),
    getOrCreateEthereumDepositAccount({ accountId: secondAccount, deriveAddress, assets: ["USDC"], startIndex: legacyIndex + 1 }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.account.address, second.account.address, "concurrent accounts must receive distinct addresses");
  assert.notEqual(first.account.derivationIndex, second.account.derivationIndex);
  const replay = await getOrCreateEthereumDepositAccount({ accountId: firstAccount, deriveAddress, assets: ["USDC"], startIndex: legacyIndex + 1 });
  assert.equal(replay.created, false);
  assert.equal(replay.account.address, first.account.address);

  await Promise.all([
    updateEthereumDepositSync({ accountId: firstAccount, observedBalances: { USDC: { raw: "1" } }, creditedEntries: [{ id: "ledger_a" }] }),
    updateEthereumDepositSync({ accountId: firstAccount, pendingBalances: { USDC: { raw: "2" } }, creditedEntries: [{ id: "ledger_b" }] }),
  ]);
  const synced = await getEthereumDepositAccount({ accountId: firstAccount });
  assert.equal(synced.observedBalances.USDC.raw, "1");
  assert.equal(synced.pendingBalances.USDC.raw, "2");
  assert.deepEqual(new Set(synced.lastCreditedLedgerIds), new Set(["ledger_a", "ledger_b"]));
  assert.equal((await retireEthereumDepositAccount({ accountId: secondAccount, reason: "smoke" })).ok, true);
  assert.equal(await getEthereumDepositAccount({ accountId: secondAccount }), null);
  console.log("ethereum deposit repository smoke ok: lossless import, serialized allocation, durable sync, retirement");
} finally {
  await query("DELETE FROM ethereum_deposit_accounts WHERE account_id = ANY($1::text[])", [[legacyAccount, firstAccount, secondAccount]]).catch(() => {});
  await query("DELETE FROM runtime_state_migrations WHERE name = 'ethereum_deposits_to_postgres_v1'").catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
