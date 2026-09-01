#!/usr/bin/env node

import { closePool, databaseEnabled, query } from "../server/db/pool.js";

if (!databaseEnabled()) throw new Error("wallet_account_isolation_audit_database_required");

try {
  const [duplicates, syncMismatches] = await Promise.all([
    query(
      `SELECT wallet_address, count(*)::integer AS active_owner_count,
              array_agg(account_id ORDER BY account_id) AS account_ids
         FROM account_linked_wallets
        WHERE status = 'linked'
        GROUP BY wallet_address
       HAVING count(*) > 1
        ORDER BY wallet_address`
    ),
    query(
      `SELECT links.wallet_address,
              links.account_id AS linked_account_id,
              sync.account_id AS sync_account_id,
              sync.status AS sync_status
         FROM account_linked_wallets links
         JOIN pftl_sync_wallets sync ON sync.wallet_address = links.wallet_address
        WHERE links.status = 'linked'
          AND sync.account_id <> links.account_id
        ORDER BY links.wallet_address`
    ),
  ]);
  const report = {
    ok: duplicates.rowCount === 0 && syncMismatches.rowCount === 0,
    duplicateActiveWallets: duplicates.rows,
    syncAccountMismatches: syncMismatches.rows,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await closePool();
}
