import { closePool, query } from "../server/db/pool.js";
import { runPftlCacheReducerOnce } from "../server/pftl-cache-reducer.js";

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

const id = argValue("id");
const reducerKind = argValue("kind");
const taskId = argValue("task-id");
const contextId = argValue("context-id");
const accountId = argValue("account-id");
const walletAddress = argValue("wallet");
const lastError = argValue("last-error");
const limit = intArg("limit", 50);
const reducerLoops = intArg("reducer-loops", 4);
const apply = hasFlag("apply");

if (!id && !reducerKind && !taskId && !contextId && !accountId && !walletAddress && !lastError) {
  console.error("Usage: node scripts/pftl-reducer-requeue.mjs --id <event_id> [--apply]");
  process.exit(2);
}

try {
  const candidates = await query(
    `
      SELECT id, reducer_kind, status, attempts, account_id, wallet_address, task_id, context_id, tx_hash, cid, last_error
      FROM pftl_cache_reducer_events
      WHERE status = 'failed'
        AND ($1::bigint IS NULL OR id = $1)
        AND ($2::text = '' OR reducer_kind = $2)
        AND ($3::text = '' OR task_id = $3)
        AND ($4::text = '' OR context_id = $4)
        AND ($5::text = '' OR account_id = $5)
        AND ($6::text = '' OR wallet_address = $6)
        AND ($7::text = '' OR last_error = $7)
      ORDER BY updated_at DESC, id DESC
      LIMIT $8
    `,
    [
      id ? Number(id) : null,
      reducerKind,
      taskId,
      contextId,
      accountId,
      walletAddress,
      lastError,
      limit,
    ]
  );

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      candidateCount: candidates.rows.length,
      candidates: candidates.rows,
      next: "Re-run with --apply to mark these reducer rows pending and process them.",
    }, null, 2));
    process.exit(0);
  }

  const candidateIds = candidates.rows.map((row) => Number(row.id)).filter(Number.isFinite);
  const requeued = candidateIds.length
    ? await query(
      `
        UPDATE pftl_cache_reducer_events
        SET status = 'pending',
            available_at = now(),
            last_error = NULL,
            updated_at = now()
        WHERE id = ANY($1::bigint[])
        RETURNING id
      `,
      [candidateIds]
    )
    : { rowCount: 0 };

  const reducerRuns = [];
  for (let index = 0; index < reducerLoops; index += 1) {
    const result = await runPftlCacheReducerOnce({ batchLimit: 50, maxAttempts: 8, logger: console });
    reducerRuns.push(result);
    if (!result.claimed) break;
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: false,
    candidateCount: candidates.rows.length,
    requeued: requeued.rowCount,
    reducerRuns,
  }, null, 2));
} finally {
  await closePool();
}
