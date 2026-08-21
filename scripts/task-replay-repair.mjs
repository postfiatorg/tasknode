import { closePool, query } from "../server/db/pool.js";
import { runPftlCacheReducerOnce } from "../server/pftl-cache-reducer.js";
import { enqueuePftlReducerEventsForTransaction } from "../server/repositories/pftl-cache.js";

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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function intArg(name, fallback) {
  const parsed = Number(argValue(name, ""));
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

const taskId = argValue("task-id");
const accountId = argValue("account-id");
const walletAddress = argValue("wallet");
const apply = hasFlag("apply");
const limit = intArg("limit", 200);
const reducerLoops = intArg("reducer-loops", 6);

if (!taskId && !accountId && !walletAddress) {
  console.error("Usage: node scripts/task-replay-repair.mjs --task-id <task_id> [--apply]");
  process.exit(2);
}

try {
  const candidates = await query(
    `
      SELECT DISTINCT
        po.wallet_address,
        po.account_id,
        po.tx_hash,
        t.ledger_index,
        t.transaction_result
      FROM pftl_pointer_observations po
      JOIN pftl_pointer_memos pm
        ON pm.tx_hash = po.tx_hash
       AND pm.memo_index = po.memo_index
      LEFT JOIN pftl_transactions t ON t.tx_hash = po.tx_hash
      WHERE ($1::text = '' OR po.task_id = $1 OR pm.task_id = $1)
        AND ($2::text = '' OR po.account_id = $2)
        AND ($3::text = '' OR po.wallet_address = $3)
        AND pm.cid IS NOT NULL
        AND pm.decode_error IS NULL
        AND pm.pointer_kind IN ('TASK', 'TASK_UPDATE', 'TASK_SUBMISSION', 'REWARD')
      ORDER BY t.ledger_index ASC NULLS LAST, po.tx_hash ASC, po.wallet_address ASC
      LIMIT $4
    `,
    [taskId, accountId, walletAddress, limit]
  );

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      taskId,
      accountId,
      walletAddress,
      candidateCount: candidates.rows.length,
      candidates: candidates.rows,
      next: "Re-run with --apply to enqueue reducer events and run projection replay.",
    }, null, 2));
    process.exit(0);
  }

  const requeued = await query(
    `
      UPDATE pftl_cache_reducer_events
      SET status = 'pending',
          available_at = now(),
          last_error = NULL,
          updated_at = now()
      WHERE reducer_kind = 'task_projection_replay'
        AND ($1::text = '' OR task_id = $1)
        AND ($2::text = '' OR account_id = $2)
        AND ($3::text = '' OR wallet_address = $3)
      RETURNING id
    `,
    [taskId, accountId, walletAddress]
  );

  let inserted = 0;
  for (const row of candidates.rows) {
    const enqueued = await enqueuePftlReducerEventsForTransaction({
      walletAddress: row.wallet_address,
      accountId: row.account_id,
      txHash: row.tx_hash,
      ledgerIndex: row.ledger_index,
      transactionResult: row.transaction_result || "tesSUCCESS",
      source: "task_replay_repair",
    });
    inserted += Number(enqueued.inserted || 0);
  }

  const reducerRuns = [];
  for (let index = 0; index < reducerLoops; index += 1) {
    const result = await runPftlCacheReducerOnce({ batchLimit: 50, maxAttempts: 8, logger: console });
    reducerRuns.push(result);
    if (!result.claimed) break;
  }

  const projection = taskId
    ? await query(
      `
        SELECT task_id, status, event_count, last_event_tx_hash, last_event_cid, updated_at
        FROM task_projections
        WHERE task_id = $1
        LIMIT 1
      `,
      [taskId]
    )
    : { rows: [] };

  console.log(JSON.stringify({
    ok: true,
    dryRun: false,
    taskId,
    accountId,
    walletAddress,
    candidateCount: candidates.rows.length,
    requeuedExistingEvents: requeued.rowCount,
    insertedReducerEvents: inserted,
    reducerRuns,
    projection: projection.rows[0] || null,
  }, null, 2));
} finally {
  await closePool();
}
