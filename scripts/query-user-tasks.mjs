import { closePool, query } from "../server/db/pool.js";
import {
  getAccountIdentityProfile,
  getLinkedWallet,
  listPublicAccountWalletIdentities,
} from "../server/runtime-store.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] || fallback;
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log([
    "Usage: node scripts/query-user-tasks.mjs --handle <hive_handle>",
    "       node scripts/query-user-tasks.mjs --account-id <account_id>",
    "       node scripts/query-user-tasks.mjs --wallet <classic_address>",
    "",
    "Read-only operator diagnostic for task request -> generation -> projection state.",
    "Run in production with:",
    "  fly ssh console -a tasknodeofficial-dev --process-group app -C 'node scripts/query-user-tasks.mjs --handle goodalexander'",
  ].join("\n"));
}

function normalizeHandle(value = "") {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function rowValue(row = {}, key = "") {
  return row && Object.hasOwn(row, key) ? row[key] : "";
}

function matchIdentity(handle = "") {
  const needle = normalizeHandle(handle);
  if (!needle) return [];
  return listPublicAccountWalletIdentities().filter((identity) => {
    const aliases = Array.isArray(identity.publicAliases) ? identity.publicAliases : [];
    const values = [
      identity.accountId,
      identity.walletAddress,
      identity.displayName,
      identity.hiveHandle,
      identity.publicDisplayName,
      ...aliases.flatMap((alias) => [alias.handle, alias.label, alias.provider]),
    ];
    return values.some((value) => normalizeHandle(value).includes(needle));
  });
}

async function safeQuery(sql, params = []) {
  try {
    const result = await query(sql, params);
    return result.rows;
  } catch (error) {
    return [{ error: error?.message || String(error) }];
  }
}

function summarize({ requestRows = [], projectionRows = [], reducerRows = [] } = {}) {
  const latestRequest = requestRows.find((row) => !row.error) || null;
  const generatedTaskId = normalizeText(latestRequest?.generated_task_id, 180);
  const projected = generatedTaskId
    ? projectionRows.find((row) => row.task_id === generatedTaskId)
    : projectionRows.find((row) => !row.error) || null;
  const failedReducers = reducerRows.filter((row) => row.status === "failed");
  const pendingReducers = reducerRows.filter((row) => row.status === "pending" || row.status === "processing");

  return {
    latestRequestId: latestRequest?.request_id || "",
    latestRequestStatus: latestRequest?.status || "",
    generatedTaskId,
    generatedTitle: latestRequest?.generated_title || "",
    visibleProjection: Boolean(projected?.task_id),
    projectionStatus: projected?.status || "",
    projectionTitle: projected?.title || "",
    pendingReducerCount: pendingReducers.length,
    failedReducerCount: failedReducers.length,
    lastError: latestRequest?.last_error || failedReducers[0]?.last_error || "",
  };
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    usage();
    return;
  }

  const handle = argValue("handle");
  let accountId = normalizeText(argValue("account-id"), 180);
  let walletAddress = normalizeText(argValue("wallet"), 120);
  const limit = Math.min(Math.max(Number(argValue("limit", "12")) || 12, 1), 50);

  const matches = accountId || walletAddress ? [] : matchIdentity(handle);
  if (!accountId && matches.length === 1) accountId = matches[0].accountId;
  if (!walletAddress && matches.length === 1) walletAddress = matches[0].walletAddress;

  if (accountId && !walletAddress) {
    walletAddress = getLinkedWallet({ accountId }).address || "";
  }

  if (!accountId && !walletAddress) {
    console.error(JSON.stringify({
      ok: false,
      error: "user_task_query_identity_not_resolved",
      handle: handle || "",
      matches,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const params = [accountId, walletAddress, limit];
  const [requestRows, projectionRows, pointerRows, reducerRows, syncRows] = await Promise.all([
    safeQuery(
      `
        SELECT
          request_id,
          account_id,
          subject_wallet,
          source,
          source_conversation_title,
          requested_task_kind,
          status,
          generated_task_id,
          metadata_json #>> '{workerResult,generatedTask,title}' AS generated_title,
          request_bundle_cid,
          request_event_cid,
          request_tx_hash,
          metadata_json #>> '{workerResult,offerCid}' AS offer_cid,
          metadata_json #>> '{workerResult,offerTxHash}' AS offer_tx_hash,
          worker_attempt_count,
          worker_claimed_at,
          worker_completed_at,
          last_error,
          created_at,
          updated_at
        FROM task_requests
        WHERE ($1::text <> '' AND account_id = $1)
           OR ($2::text <> '' AND subject_wallet = $2)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $3
      `,
      params
    ),
    safeQuery(
      `
        SELECT
          task_id,
          account_id,
          subject_wallet,
          request_id,
          status,
          title,
          task_kind,
          reward_offer_pft::text AS reward_offer_pft,
          last_event_tx_hash,
          last_event_cid,
          last_event_at,
          updated_at
        FROM task_projections
        WHERE ($1::text <> '' AND account_id = $1)
           OR ($2::text <> '' AND subject_wallet = $2)
        ORDER BY updated_at DESC
        LIMIT $3
      `,
      params
    ),
    safeQuery(
      `
        SELECT
          wallet_address,
          account_id,
          pointer_kind,
          task_id,
          tx_hash,
          memo_index,
          cid,
          updated_at
        FROM pftl_pointer_observations
        WHERE ($1::text <> '' AND account_id = $1)
           OR ($2::text <> '' AND wallet_address = $2)
        ORDER BY updated_at DESC
        LIMIT $3
      `,
      params
    ),
    safeQuery(
      `
        SELECT
          id,
          wallet_address,
          account_id,
          reducer_kind,
          pointer_kind,
          task_id,
          tx_hash,
          cid,
          status,
          attempts,
          last_error,
          created_at,
          updated_at
        FROM pftl_cache_reducer_events
        WHERE ($1::text <> '' AND account_id = $1)
           OR ($2::text <> '' AND wallet_address = $2)
        ORDER BY updated_at DESC
        LIMIT $3
      `,
      params
    ),
    safeQuery(
      `
        SELECT
          id,
          account_id,
          wallet_address,
          source,
          source_ref,
          status,
          task_count,
          pointer_event_count,
          error,
          created_at
        FROM pftl_task_sync_runs
        WHERE ($1::text <> '' AND account_id = $1)
           OR ($2::text <> '' AND wallet_address = $2)
        ORDER BY created_at DESC
        LIMIT $3
      `,
      params
    ),
  ]);

  const result = {
    ok: true,
    selector: {
      handle: handle || "",
      accountId,
      walletAddress,
      identityMatches: matches,
      identityProfile: accountId ? getAccountIdentityProfile({ accountId }) : null,
    },
    summary: summarize({ requestRows, projectionRows, reducerRows }),
    taskRequests: requestRows,
    taskProjections: projectionRows,
    pointerObservations: pointerRows,
    reducerEvents: reducerRows,
    syncRuns: syncRows,
  };

  console.log(JSON.stringify(result, null, 2));

  const latestRequestId = rowValue(requestRows[0], "request_id");
  const latestProjectionId = rowValue(projectionRows[0], "task_id");
  if (latestRequestId && !latestProjectionId && !result.summary.visibleProjection) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
