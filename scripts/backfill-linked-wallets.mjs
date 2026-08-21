// Backfill account_linked_wallets (migration 103) from the runtime store.
// MUST run on the Fly app machine (the only machine with the durable
// runtime-store volume):
//
//   fly ssh console -a tasknodeofficial-dev -C "sh -lc 'cd /app && node scripts/backfill-linked-wallets.mjs'"

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const store = await import("../server/runtime-store.js");
const { query, closePool, databaseEnabled } = await import("../server/db/pool.js");

if (!databaseEnabled()) {
  console.error("database not enabled");
  process.exit(1);
}

// The store keeps accountWallets keyed by account id; expose via the public
// accounts listing if available, else walk known accounts from the DB.
const accountIds = new Set();
try {
  const rows = await query(
    `SELECT DISTINCT account_id FROM task_projections WHERE account_id <> ''
     UNION SELECT DISTINCT account_id FROM account_network_badges`
  );
  for (const row of rows.rows) accountIds.add(row.account_id);
} catch (error) {
  console.error("account enumeration failed:", error.message);
  process.exit(1);
}

let mirrored = 0;
for (const accountId of accountIds) {
  const wallet = store.getLinkedWallet({ accountId });
  if (wallet?.status === "linked" && wallet.address) {
    await query(
      `INSERT INTO account_linked_wallets (account_id, wallet_address, status, linked_at, updated_at)
       VALUES ($1, $2, 'linked', NULL, now())
       ON CONFLICT (account_id) DO UPDATE SET
         wallet_address = EXCLUDED.wallet_address, status = 'linked', updated_at = now()`,
      [accountId, wallet.address]
    );
    mirrored += 1;
  }
}
console.log(`backfilled ${mirrored} linked wallets from ${accountIds.size} accounts`);
await closePool();
