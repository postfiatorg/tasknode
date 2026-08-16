import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  clearLegacyEthereumDepositsAfterMigration,
  getEthereumDepositAccount as getRuntimeDepositAccount,
  getOrCreateEthereumDepositAccount as getOrCreateRuntimeDepositAccount,
  legacyEthereumDepositSnapshotForMigration,
  retireEthereumDepositAccount as retireRuntimeDepositAccount,
  updateEthereumDepositSync as updateRuntimeDepositSync,
} from "../runtime-store.js";

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function depositFromRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    chainId: Number(row.chain_id || 1),
    network: row.network || "Ethereum mainnet",
    address: row.address,
    addressKey: row.address_key,
    derivationIndex: Number(row.derivation_index),
    derivationPath: row.derivation_path || "",
    assets: jsonArray(row.assets_json),
    status: row.status || "active",
    custody: row.custody || "tasknode_deposit_only",
    withdrawalsEnabled: row.withdrawals_enabled === true,
    sweepStatus: row.sweep_status || "deferred",
    observedBalances: jsonObject(row.observed_balances_json),
    pendingBalances: jsonObject(row.pending_balances_json),
    creditedBalances: jsonObject(row.credited_balances_json),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    lastSyncStatus: row.last_sync_status || "not_synced",
    lastSyncError: row.last_sync_error || "",
    lastSyncBlockTag: row.last_sync_block_tag || "",
    lastCreditedLedgerIds: jsonArray(row.last_credited_ledger_ids_json),
    retireReason: row.retire_reason || "",
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const columns = `id, account_id, chain_id, network, address, address_key,
  derivation_index, derivation_path, assets_json, status, custody,
  withdrawals_enabled, sweep_status, observed_balances_json,
  pending_balances_json, credited_balances_json, last_sync_at,
  last_sync_status, last_sync_error, last_sync_block_tag,
  last_credited_ledger_ids_json, retire_reason, retired_at, created_at, updated_at`;

export async function getEthereumDepositAccount({ accountId = "" } = {}) {
  if (!databaseEnabled()) return getRuntimeDepositAccount({ accountId });
  const normalized = String(accountId || "").trim().slice(0, 160);
  if (!normalized) return null;
  const result = await query(
    `SELECT ${columns} FROM ethereum_deposit_accounts
      WHERE account_id = $1 AND retired_at IS NULL LIMIT 1`,
    [normalized]
  );
  return depositFromRow(result.rows[0]);
}

export async function retireEthereumDepositAccount({ accountId = "", reason = "operator_retired", status = "retired" } = {}) {
  if (!databaseEnabled()) return retireRuntimeDepositAccount({ accountId, reason, status });
  const normalized = String(accountId || "").trim().slice(0, 160);
  if (!normalized) return { ok: false, status: 401, error: "deposit_login_required" };
  const result = await query(
    `UPDATE ethereum_deposit_accounts SET status = $2, retire_reason = $3,
       retired_at = now(), updated_at = now()
      WHERE account_id = $1 AND retired_at IS NULL RETURNING ${columns}`,
    [normalized, String(status || "retired"), String(reason || "operator_retired")]
  );
  if (!result.rows[0]) return { ok: false, status: 404, error: "deposit_account_not_found" };
  const account = depositFromRow(result.rows[0]);
  return { ok: true, account, retiredAt: account.retiredAt };
}

export async function getOrCreateEthereumDepositAccount(options = {}) {
  if (!databaseEnabled()) return getOrCreateRuntimeDepositAccount(options);
  const accountId = String(options.accountId || "").trim().slice(0, 160);
  if (!accountId) return { ok: false, status: 401, error: "deposit_login_required" };
  if (typeof options.deriveAddress !== "function") return { ok: false, status: 409, error: "deposit_deriver_unavailable" };
  const startIndex = Math.max(0, Number(options.startIndex) || 0);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ethereum-deposit:${accountId}`]);
    const current = await client.query(
      `SELECT ${columns} FROM ethereum_deposit_accounts
        WHERE account_id = $1 AND retired_at IS NULL FOR UPDATE`,
      [accountId]
    );
    const existing = depositFromRow(current.rows[0]);
    if (existing?.address && existing.derivationIndex >= startIndex) return { ok: true, account: existing, created: false };
    if (existing?.address) {
      await client.query(
        `UPDATE ethereum_deposit_accounts SET status = 'retired_reserved_index',
         retire_reason = $2, retired_at = now(), updated_at = now() WHERE id = $1`,
        [existing.id, `derivation_index_below_start:${startIndex}`]
      );
    }
    const allocator = await client.query(
      "SELECT next_derivation_index FROM ethereum_deposit_allocator WHERE singleton = true FOR UPDATE"
    );
    let candidate = Math.max(startIndex, Number(allocator.rows[0]?.next_derivation_index || 0));
    for (let offset = 0; offset < 1000; offset += 1, candidate += 1) {
      let derived;
      try { derived = options.deriveAddress(candidate); } catch { return { ok: false, status: 409, error: "deposit_address_derivation_failed" }; }
      const address = String(derived?.address || "").trim();
      if (!address) continue;
      const occupied = await client.query(
        "SELECT 1 FROM ethereum_deposit_accounts WHERE address_key = $1 OR derivation_index = $2 LIMIT 1",
        [address.toLowerCase(), candidate]
      );
      if (occupied.rows[0]) continue;
      const inserted = await client.query(
        `INSERT INTO ethereum_deposit_accounts (
           id, account_id, chain_id, network, address, address_key,
           derivation_index, derivation_path, assets_json, status, custody
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'active', $10)
         RETURNING ${columns}`,
        [
          `ethdep_${randomUUID()}`, accountId, Number(options.chainId || 1),
          String(options.network || "Ethereum mainnet"), address, address.toLowerCase(), candidate,
          String(derived?.derivationPath || ""), JSON.stringify(jsonArray(options.assets)),
          String(options.custody || "tasknode_deposit_only"),
        ]
      );
      await client.query(
        "UPDATE ethereum_deposit_allocator SET next_derivation_index = $1, updated_at = now() WHERE singleton = true",
        [candidate + 1]
      );
      return { ok: true, account: depositFromRow(inserted.rows[0]), created: true };
    }
    return { ok: false, status: 500, error: "deposit_address_allocation_failed" };
  });
}

export async function updateEthereumDepositSync(options = {}) {
  if (!databaseEnabled()) return updateRuntimeDepositSync(options);
  const accountId = String(options.accountId || "").trim().slice(0, 160);
  if (!accountId) return null;
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT ${columns} FROM ethereum_deposit_accounts
        WHERE account_id = $1 AND retired_at IS NULL FOR UPDATE`,
      [accountId]
    );
    const existing = depositFromRow(result.rows[0]);
    if (!existing) return null;
    const ledgerIds = [...new Set([
      ...existing.lastCreditedLedgerIds,
      ...jsonArray(options.creditedEntries).map((entry) => entry?.id).filter(Boolean),
    ])].slice(-50);
    const updated = await client.query(
      `UPDATE ethereum_deposit_accounts SET
         observed_balances_json = $2::jsonb, pending_balances_json = $3::jsonb,
         credited_balances_json = $4::jsonb, last_sync_at = now(),
         last_sync_status = $5, last_sync_error = $6,
         last_sync_block_tag = $7, last_credited_ledger_ids_json = $8::jsonb,
         updated_at = now() WHERE id = $1 RETURNING ${columns}`,
      [
        existing.id,
        JSON.stringify({ ...existing.observedBalances, ...jsonObject(options.observedBalances) }),
        JSON.stringify({ ...existing.pendingBalances, ...jsonObject(options.pendingBalances) }),
        JSON.stringify({ ...existing.creditedBalances, ...jsonObject(options.creditedBalances) }),
        String(options.syncStatus || "ready"), String(options.syncError || ""),
        String(options.blockTag || existing.lastSyncBlockTag || ""), JSON.stringify(ledgerIds),
      ]
    );
    return depositFromRow(updated.rows[0]);
  });
}

function legacyRecord(account = {}, { retired = false } = {}) {
  const createdAt = account.createdAt || new Date().toISOString();
  return [
    account.id || `ethdep_${randomUUID()}`, account.accountId || "", Number(account.chainId || 1),
    account.network || "Ethereum mainnet", account.address || "", String(account.address || "").toLowerCase(),
    Number(account.derivationIndex || 0), account.derivationPath || "", JSON.stringify(jsonArray(account.assets)),
    retired ? (account.status || "retired") : (account.status || "active"), account.custody || "tasknode_deposit_only",
    account.withdrawalsEnabled === true, account.sweepStatus || "deferred", JSON.stringify(jsonObject(account.observedBalances)),
    JSON.stringify(jsonObject(account.pendingBalances)), JSON.stringify(jsonObject(account.creditedBalances)), account.lastSyncAt || null,
    account.lastSyncStatus || "not_synced", account.lastSyncError || "", account.lastSyncBlockTag || "",
    JSON.stringify(jsonArray(account.lastCreditedLedgerIds)), account.retireReason || "",
    retired ? (account.retiredAt || createdAt) : null, createdAt, account.updatedAt || createdAt,
  ];
}

export async function migrateLegacyEthereumDeposits() {
  if (!databaseEnabled()) return { migrated: false, adapter: "runtime", count: 0 };
  const snapshot = legacyEthereumDepositSnapshotForMigration();
  const result = await transaction(async (client) => {
    const name = "ethereum_deposits_to_postgres_v1";
    const marker = await client.query("SELECT record_count FROM runtime_state_migrations WHERE name = $1 FOR UPDATE", [name]);
    if (marker.rows[0]) return { migrated: false, adapter: "postgres", count: Number(marker.rows[0].record_count || 0) };
    const records = [
      ...Object.values(snapshot.active || {}).map((account) => ({ account, retired: false })),
      ...jsonArray(snapshot.retired).map((account) => ({ account, retired: true })),
    ].filter(({ account }) => account?.accountId && account?.address);
    let count = 0;
    for (const record of records) {
      await client.query(
        `INSERT INTO ethereum_deposit_accounts (
           id, account_id, chain_id, network, address, address_key, derivation_index,
           derivation_path, assets_json, status, custody, withdrawals_enabled, sweep_status,
           observed_balances_json, pending_balances_json, credited_balances_json, last_sync_at,
           last_sync_status, last_sync_error, last_sync_block_tag, last_credited_ledger_ids_json,
           retire_reason, retired_at, created_at, updated_at
         ) VALUES (${Array.from({ length: 25 }, (_, index) => `$${index + 1}`).join(", ")})
         ON CONFLICT (address) DO NOTHING`,
        legacyRecord(record.account, record)
      );
      count += 1;
    }
    const highest = Math.max(Number(snapshot.cursor || 0), ...records.map(({ account }) => Number(account.derivationIndex || 0) + 1), 0);
    await client.query(
      `UPDATE ethereum_deposit_allocator SET next_derivation_index = GREATEST(next_derivation_index, $1), updated_at = now()
        WHERE singleton = true`,
      [highest]
    );
    await client.query(
      "INSERT INTO runtime_state_migrations (name, record_count, metadata_json) VALUES ($1, $2, $3::jsonb)",
      [name, count, JSON.stringify({ source: "runtime-store.ethereumDepositAccounts", schemaVersion: 1 })]
    );
    return { migrated: true, adapter: "postgres", count };
  });
  clearLegacyEthereumDepositsAfterMigration();
  return result;
}

export function ethereumDepositStorageStatus() {
  return { adapter: databaseEnabled() ? "postgres" : "runtime" };
}
