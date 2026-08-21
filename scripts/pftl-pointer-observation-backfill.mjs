import { closePool, query } from "../server/db/pool.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function intArg(name, fallback) {
  const parsed = Number(argValue(name, ""));
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

const limit = intArg("limit", 5000);

try {
  const result = await query(
    `
      WITH candidates AS (
        SELECT
          wt.wallet_address,
          pm.tx_hash,
          pm.memo_index,
          COALESCE(sw.account_id, '') AS account_id,
          COALESCE(sw.role, '') AS wallet_role,
          wt.direction,
          pm.pointer_kind,
          pm.cid,
          pm.task_id,
          pm.request_id,
          pm.context_id,
          pm.thread_id
        FROM pftl_wallet_transactions wt
        JOIN pftl_pointer_memos pm ON pm.tx_hash = wt.tx_hash
        LEFT JOIN pftl_sync_wallets sw ON sw.wallet_address = wt.wallet_address
        WHERE NOT EXISTS (
          SELECT 1
          FROM pftl_pointer_observations existing
          WHERE existing.wallet_address = wt.wallet_address
            AND existing.tx_hash = pm.tx_hash
            AND existing.memo_index = pm.memo_index
        )
        ORDER BY wt.ledger_index DESC NULLS LAST, wt.close_time DESC NULLS LAST, wt.tx_hash DESC
        LIMIT $1
      )
      INSERT INTO pftl_pointer_observations (
        wallet_address,
        tx_hash,
        memo_index,
        account_id,
        wallet_role,
        direction,
        pointer_kind,
        cid,
        task_id,
        request_id,
        context_id,
        thread_id,
        source
      )
      SELECT
        wallet_address,
        tx_hash,
        memo_index,
        account_id,
        wallet_role,
        direction,
        pointer_kind,
        cid,
        task_id,
        request_id,
        context_id,
        thread_id,
        'pftl_pointer_observation_backfill'
      FROM candidates
      ON CONFLICT (wallet_address, tx_hash, memo_index)
      DO UPDATE SET
        account_id = COALESCE(NULLIF(EXCLUDED.account_id, ''), pftl_pointer_observations.account_id),
        wallet_role = COALESCE(NULLIF(EXCLUDED.wallet_role, ''), pftl_pointer_observations.wallet_role),
        direction = COALESCE(EXCLUDED.direction, pftl_pointer_observations.direction),
        pointer_kind = COALESCE(EXCLUDED.pointer_kind, pftl_pointer_observations.pointer_kind),
        cid = COALESCE(EXCLUDED.cid, pftl_pointer_observations.cid),
        task_id = COALESCE(EXCLUDED.task_id, pftl_pointer_observations.task_id),
        request_id = COALESCE(EXCLUDED.request_id, pftl_pointer_observations.request_id),
        context_id = COALESCE(EXCLUDED.context_id, pftl_pointer_observations.context_id),
        thread_id = COALESCE(EXCLUDED.thread_id, pftl_pointer_observations.thread_id),
        source = EXCLUDED.source,
        updated_at = now()
      RETURNING wallet_address, tx_hash, memo_index
    `,
    [limit]
  );

  const remaining = await query(
    `
      SELECT count(*)::int AS count
      FROM pftl_wallet_transactions wt
      JOIN pftl_pointer_memos pm ON pm.tx_hash = wt.tx_hash
      WHERE NOT EXISTS (
        SELECT 1
        FROM pftl_pointer_observations existing
        WHERE existing.wallet_address = wt.wallet_address
          AND existing.tx_hash = pm.tx_hash
          AND existing.memo_index = pm.memo_index
      )
    `
  );

  const orphanPointers = await query(
    `
      SELECT count(*)::int AS count
      FROM pftl_pointer_memos pm
      WHERE NOT EXISTS (
        SELECT 1
        FROM pftl_wallet_transactions wt
        WHERE wt.tx_hash = pm.tx_hash
      )
    `
  );

  console.log(JSON.stringify({
    ok: true,
    insertedOrUpdated: result.rowCount,
    remaining: Number(remaining.rows[0]?.count || 0),
    pointerMemosWithoutWalletObservationSource: Number(orphanPointers.rows[0]?.count || 0),
  }, null, 2));
} finally {
  await closePool();
}
