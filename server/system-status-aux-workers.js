import { databaseEnabled, query } from "./db/pool.js";
import {
  jobsEffectiveEmbeddingModel,
  jobsEmbeddingDimensions,
  jobsEmbeddingModel,
  jobsEmbeddingProvider,
} from "./embedding-provider.js";
import {
  countsFromRows,
  boolEnv,
  hour,
  intEnv,
  iso,
  item,
  mergeStatus,
  minute,
  oldestAgeMs,
  optionalQuery,
  runFreshness,
} from "./system-status-base.js";
import {
  recentFailureStatus,
  recentFailureWindowMs,
} from "./system-status-readers.js";
import {
  PROFILE_NFT_DAILY_SCOPE,
  evaluateDailyProfileNftWorkerState,
  profileNftGenerationGated,
  profileNftMaxAttempts,
  profileNftStaleRunningMs,
} from "./system-status-profile-nft.js";

export async function memoryQueueItem({
  tables,
  id,
  title,
  description,
  jobTable,
  entryKind = "",
  resultTable = "chat_memory_entries",
  owner = "worker process",
  enabled = true,
  trigger,
  cadence,
  nowMs,
}) {
  const [latest, counts, oldestDue] = await Promise.all([
    optionalQuery(
      tables,
      [resultTable],
      entryKind
        ? `SELECT id, created_at AS completed_at
             FROM ${resultTable}
            WHERE kind = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        : `SELECT id, completed_at, created_at
             FROM ${resultTable}
            WHERE status = 'completed'
            ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT 1`,
      entryKind ? [entryKind] : []
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM ${jobTable}
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT min(COALESCE(next_attempt_at, updated_at, created_at)) AS oldest_due
         FROM ${jobTable}
        WHERE status IN ('pending', 'processing')
          AND COALESCE(next_attempt_at, updated_at, created_at) <= now()`
    ),
  ]);
  const row = latest.rows[0] || null;
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({ enabled, lastSuccessAt: row?.completed_at || row?.created_at, nowMs });
  const recentFailed = counts.rows.reduce((sum, row) => sum + Number(row.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed jobs");
  const oldest = iso(oldestDue.rows[0]?.oldest_due);
  if (oldest && oldestAgeMs(oldest, nowMs) > 30 * minute) status = { status: "critical", label: "Queue stale" };
  return item({
    id,
    category: "memory",
    title,
    description,
    owner,
    trigger,
    cadence,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.created_at,
    lastSuccessAt: row?.completed_at || row?.created_at,
    counts: queueCounts,
    details: [row?.id && `latest=${row.id}`, oldest && `oldestDue=${oldest}`],
  });
}

export async function jobsPgvectorCorpusItem(tables) {
  const retrievalEnabled = process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED !== "false" &&
    process.env.TASKNODE_CHAT_SPIRIT_ENABLED !== "false";
  const expectedProvider = jobsEmbeddingProvider();
  const expectedModel = jobsEffectiveEmbeddingModel({
    provider: expectedProvider,
    model: jobsEmbeddingModel(),
  });
  const expectedDimensions = jobsEmbeddingDimensions();
  const tableReady = tables.get("jobs_corpus_sources") === true && tables.get("jobs_corpus_chunks") === true;
  const extensionResult = await optionalQuery(
    tables,
    [],
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed"
  );
  const [sourceResult, chunkResult] = await Promise.all([
    optionalQuery(
      tables,
      ["jobs_corpus_sources"],
      `SELECT count(*)::int AS sources,
              max(updated_at) AS last_source_at,
              max(raw_size_bytes)::int AS raw_size_bytes
         FROM jobs_corpus_sources`
    ),
    optionalQuery(
      tables,
      ["jobs_corpus_chunks"],
      `SELECT count(*)::int AS chunks,
              count(*) FILTER (
                WHERE embedding_model = $1
                  AND embedding_dimensions = $2
              )::int AS expected_chunks,
              count(DISTINCT embedding_model)::int AS embedding_models,
              max(updated_at) AS last_chunk_at,
              string_agg(DISTINCT embedding_model, ', ' ORDER BY embedding_model) AS models
         FROM jobs_corpus_chunks`,
      [expectedModel, expectedDimensions]
    ),
  ]);
  const source = sourceResult.rows[0] || {};
  const chunks = chunkResult.rows[0] || {};
  const vectorInstalled = extensionResult.rows[0]?.vector_installed === true;
  const sourceCount = Number(source.sources || 0);
  const chunkCount = Number(chunks.chunks || 0);
  const expectedChunkCount = Number(chunks.expected_chunks || 0);
  let status = { status: "unknown", label: "No corpus status" };
  if (!retrievalEnabled) status = { status: "disabled", label: "Disabled" };
  else if (!databaseEnabled()) status = { status: "unknown", label: "Database disabled" };
  else if (!vectorInstalled) status = { status: "critical", label: "PGVector missing" };
  else if (!tableReady) status = { status: "critical", label: "Corpus tables missing" };
  else if (sourceCount === 0 || chunkCount === 0) status = { status: "warning", label: "Corpus empty" };
  else if (expectedChunkCount === 0) status = { status: "warning", label: "Embedding model mismatch" };
  else status = { status: "ok", label: "Corpus ready" };
  const lastUpdated = chunks.last_chunk_at || source.last_source_at || null;
  return item({
    id: "jobs_pgvector_corpus",
    category: "memory",
    title: "Jobs PGVector Corpus",
    description: "Postgres pgvector corpus used for Jobs-style chat retrieval context.",
    owner: "app process and Postgres",
    trigger: "chat request retrieval and operator ingestion",
    cadence: "request-time plus operator ingest",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: lastUpdated,
    lastSuccessAt: status.status === "ok" ? lastUpdated : null,
    counts: {
      sources: sourceCount,
      chunks: chunkCount,
      expected_model_chunks: expectedChunkCount,
      embedding_models: Number(chunks.embedding_models || 0),
    },
    details: [
      `pgvector=${vectorInstalled ? "installed" : "missing"}`,
      `expectedModel=${expectedModel}`,
      `expectedDimensions=${expectedDimensions}`,
      `provider=${expectedProvider}`,
      chunks.models && `models=${chunks.models}`,
      source.raw_size_bytes && `rawSizeBytes=${source.raw_size_bytes}`,
    ],
  });
}

export function dailyAirdropDebtStaleThresholds(env = process.env) {
  // Mirror the daily airdrop worker's own stale thresholds: fresh in-flight rows
  // (running scoring, processing_pre_submit issuance) are normal payout-tick state,
  // not debt; only rows older than the worker would itself reclaim count as debt.
  return {
    scoringStaleMinutes: intEnv(env.TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES, 45, { min: 1 }),
    preSubmitStaleMinutes: intEnv(env.TASKNODE_DAILY_AIRDROP_PRE_SUBMIT_STALE_MINUTES, 30, { min: 1 }),
  };
}

// Parameters: $1 scoring stale minutes, $2 pre-submit stale minutes.
// Exported so smokes can assert the same predicate the status row uses.
export const DAILY_AIRDROP_DEBT_SUMMARY_SQL = `WITH issuance_debt AS (
         SELECT 'issuance' AS kind,
                i.account_id,
                i.run_date,
                i.run_id,
                i.id AS issuance_id,
                i.amount_pft::numeric AS amount_pft,
                i.recipient_wallet,
                CASE
                  WHEN i.status = 'failed'
                   AND COALESCE(i.tx_hash, '') = ''
                   AND i.submitted_at IS NULL THEN 'failed_before_submit'
                  WHEN i.status = 'processing'
                   AND i.submission_attempted_at IS NULL THEN 'processing_pre_submit'
                  WHEN i.status = 'processing' THEN 'submit_unknown'
                  ELSE i.status
                END AS status,
                i.error_message,
                i.updated_at
           FROM profile_daily_airdrop_issuances i
          WHERE i.status IN ('pending', 'failed', 'failed_before_submit', 'submitting', 'submit_unknown')
             OR (
               i.status IN ('processing', 'processing_pre_submit')
               AND (
                 i.submission_attempted_at IS NOT NULL
                 OR i.updated_at < now() - ($2::integer * interval '1 minute')
               )
             )
             OR (
               i.status = 'submitted'
               AND (COALESCE(i.tx_hash, '') = '' OR i.submitted_at IS NULL)
             )
       ),
       scoring_debt AS (
         SELECT 'scoring' AS kind,
                r.account_id,
                r.run_date,
                r.id AS run_id,
                '' AS issuance_id,
                r.daily_airdrop_pft::numeric AS amount_pft,
                COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
                r.status,
                r.error_message,
                r.updated_at
           FROM profile_daily_airdrop_runs r
          WHERE r.run_mode = 'production'
            AND (
              r.status = 'failed'
              OR (
                r.status = 'running'
                AND r.updated_at < now() - ($1::integer * interval '1 minute')
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_runs complete
               WHERE complete.account_id = r.account_id
                 AND complete.run_date = r.run_date
                 AND complete.run_mode = 'production'
                 AND complete.status = 'completed'
            )
       ),
       missing_issuance_debt AS (
         SELECT 'issuance_missing' AS kind,
                r.account_id,
                r.run_date,
                r.id AS run_id,
                '' AS issuance_id,
                r.daily_airdrop_pft::numeric AS amount_pft,
                COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
                'missing_issuance' AS status,
                r.error_message,
                r.updated_at
           FROM profile_daily_airdrop_runs r
          WHERE r.run_mode = 'production'
            AND r.status = 'completed'
            AND r.daily_airdrop_pft > 0
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_issuances i
               WHERE i.run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_issuances submitted
               WHERE submitted.account_id = r.account_id
                 AND submitted.run_date = r.run_date
                 AND submitted.status = 'submitted'
            )
       ),
       debt AS (
         SELECT *,
                CASE
                  WHEN kind = 'issuance' AND status IN ('failed_before_submit', 'pending') THEN 'retry_issuance'
                  WHEN kind = 'issuance' AND status IN ('submitting', 'submit_unknown') THEN 'reconcile_before_retry'
                  WHEN kind = 'issuance' AND status = 'processing_pre_submit' THEN 'wait_or_reclaim_pre_submit'
                  WHEN kind = 'scoring' AND status = 'running' THEN 'wait_or_reclaim_stale_scoring'
                  WHEN kind = 'scoring' AND status = 'failed' THEN 'retry_scoring'
                  WHEN kind = 'issuance_missing' AND recipient_wallet <> '' THEN 'retry_issuance'
                  ELSE 'inspect'
                END AS next_action
           FROM (
             SELECT * FROM issuance_debt
             UNION ALL
             SELECT * FROM scoring_debt
             UNION ALL
             SELECT * FROM missing_issuance_debt
           ) all_debt
       )
       SELECT count(*)::int AS unresolved_count,
              count(*) FILTER (WHERE kind = 'issuance')::int AS issuance_debt_count,
              count(*) FILTER (WHERE kind = 'scoring')::int AS scoring_debt_count,
              count(*) FILTER (WHERE kind = 'issuance_missing')::int AS missing_issuance_count,
              count(*) FILTER (WHERE next_action = 'retry_issuance')::int AS retryable_issuance_count,
              count(*) FILTER (WHERE next_action = 'reconcile_before_retry')::int AS reconcile_count,
              count(*) FILTER (WHERE next_action IN ('wait_or_reclaim_pre_submit', 'wait_or_reclaim_stale_scoring'))::int AS blocked_count,
              COALESCE(sum(amount_pft) FILTER (WHERE next_action = 'retry_issuance'), 0)::text AS retryable_pft,
              min(updated_at) AS oldest_unresolved_at,
              (array_agg(account_id ORDER BY updated_at ASC, run_id ASC))[1] AS oldest_account_id,
              (array_agg(run_id ORDER BY updated_at ASC, run_id ASC))[1] AS oldest_run_id,
              max(error_message) FILTER (WHERE COALESCE(error_message, '') <> '') AS last_error
         FROM debt`;

export async function dailyAirdropItem(tables, nowMs) {
  const { scoringStaleMinutes, preSubmitStaleMinutes } = dailyAirdropDebtStaleThresholds();
  const [latest, runCounts, issuanceCounts, debtSummary] = await Promise.all([
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs", "board_manager_runs"],
      `SELECT id, run_date, run_mode, status, completed_at, updated_at, source
         FROM (
           SELECT id, run_date, run_mode, status, completed_at, updated_at, 'score' AS source
             FROM profile_daily_airdrop_runs
           UNION ALL
           SELECT id, NULL::date AS run_date, 'worker' AS run_mode, status, completed_at, updated_at, 'worker' AS source
             FROM board_manager_runs
            WHERE manager_id = 'daily_airdrop_worker'
              AND selected_action = 'daily_airdrop'
         ) latest
        ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs"],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM profile_daily_airdrop_runs
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_issuances"],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM profile_daily_airdrop_issuances
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs", "profile_daily_airdrop_issuances"],
      DAILY_AIRDROP_DEBT_SUMMARY_SQL,
      [scoringStaleMinutes, preSubmitStaleMinutes]
    ),
  ]);
  const row = latest.rows[0] || null;
  const debt = debtSummary.rows[0] || {};
  const unresolvedDebt = Number(debt.unresolved_count || 0);
  const reconcileDebt = Number(debt.reconcile_count || 0);
  const blockedDebt = Number(debt.blocked_count || 0);
  const counts = {
    ...Object.fromEntries(Object.entries(countsFromRows(runCounts.rows)).map(([key, value]) => [`runs_${key}`, value])),
    ...Object.fromEntries(Object.entries(countsFromRows(issuanceCounts.rows)).map(([key, value]) => [`issuances_${key}`, value])),
    debt_unresolved: unresolvedDebt,
    debt_issuance: Number(debt.issuance_debt_count || 0),
    debt_scoring: Number(debt.scoring_debt_count || 0),
    debt_missing_issuance: Number(debt.missing_issuance_count || 0),
    debt_retryable_issuance: Number(debt.retryable_issuance_count || 0),
    debt_reconcile: reconcileDebt,
    debt_blocked: blockedDebt,
  };
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED),
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    warningAfterMs: 26 * hour,
    staleAfterMs: 48 * hour,
    nowMs,
  });
  if (row?.status === "failed" && Date.parse(row.updated_at || row.completed_at || "") > nowMs - recentFailureWindowMs) {
    status = { status: "critical", label: "Recent run failed" };
  }
  const recentFailed = [...runCounts.rows, ...issuanceCounts.rows]
    .reduce((sum, failedRow) => sum + Number(failedRow.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed records");
  if (unresolvedDebt > 0) {
    status = mergeStatus(status, {
      status: reconcileDebt > 0 || blockedDebt > 0 ? "critical" : "warning",
      label: reconcileDebt > 0 ? "Airdrop reconciliation needed" : "Airdrop debt unresolved",
    });
  }
  return item({
    id: "daily_airdrop_worker",
    category: "memory",
    title: "Daily Airdrop Worker",
    description: "Scores eligible accounts and optionally issues the daily PFT airdrop.",
    owner: "worker process",
    trigger: "daily interval timer",
    cadence: `${intEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_INTERVAL_MS, hour, { min: minute })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.updated_at,
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    staleAfterMs: 48 * hour,
    counts,
    lastError: debt.last_error || "",
    details: [
      row?.id && `latest=${row.id}`,
      row?.source && `source=${row.source}`,
      row?.run_date && `runDate=${row.run_date}`,
      row?.run_mode && `mode=${row.run_mode}`,
      unresolvedDebt > 0 && `unresolvedDebt=${unresolvedDebt}`,
      Number(debt.missing_issuance_count || 0) > 0 && `missingIssuance=${debt.missing_issuance_count}`,
      Number(debt.retryable_issuance_count || 0) > 0 && `retryableIssuance=${debt.retryable_issuance_count} retryablePft=${debt.retryable_pft}`,
      reconcileDebt > 0 && `reconcileRequired=${reconcileDebt}`,
      blockedDebt > 0 && `blockedOrStale=${blockedDebt}`,
      debt.oldest_unresolved_at && `oldestDebt=${iso(debt.oldest_unresolved_at)}`,
      debt.oldest_account_id && `oldestDebtAccount=${debt.oldest_account_id}`,
      debt.oldest_run_id && `oldestDebtRun=${debt.oldest_run_id}`,
    ],
  });
}

export async function dailyProfileNftItem(tables, nowMs) {
  const enabled = boolEnv(process.env.TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED);
  const maxAttempts = profileNftMaxAttempts(process.env);
  const staleRunningMs = profileNftStaleRunningMs(process.env);

  let awardsQueryOk = true;
  let awardsQueryError = "";
  let heartbeatQueryOk = true;
  let latest = { rows: [] };
  let countsResult = { rows: [] };
  let latestSuccess = { rows: [] };
  let attemptCounts = { rows: [] };
  let heartbeat = null;
  let lease = null;

  const awardsTableReady = databaseEnabled() && tables.get("profile_nft_daily_awards") === true;
  if (!databaseEnabled()) {
    awardsQueryOk = true; // treated as no-data disabled path below if !enabled
  } else if (!awardsTableReady) {
    awardsQueryOk = false;
    awardsQueryError = "profile_nft_daily_awards table missing";
  } else {
    try {
      latest = await query(
        `SELECT id, run_date, account_id, wallet_address, profile_nft_id, status, completed_at, updated_at, created_at, error, attempt_count, started_at
           FROM profile_nft_daily_awards
          ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
          LIMIT 1`
      );
      countsResult = await query(
        `SELECT status,
                count(*)::int AS count,
                count(*) FILTER (
                WHERE status IN ('failed', 'failed_permanent', 'retry_wait')
                  AND updated_at > now() - ($1 * interval '1 millisecond')
              )::int AS recent_failed,
                min(started_at) FILTER (WHERE status = 'running') AS oldest_running_at
           FROM profile_nft_daily_awards
          GROUP BY status`,
        [recentFailureWindowMs]
      );
      latestSuccess = await query(
        `SELECT max(completed_at) AS latest_success_at
           FROM profile_nft_daily_awards
          WHERE status = 'generated'`
      );
      attemptCounts = await query(
        `SELECT
            count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            count(*) FILTER (WHERE status = 'running')::int AS running_count,
            count(*) FILTER (
              WHERE status = 'retry_wait'
                 OR (status = 'failed' AND attempt_count < $1)
            )::int AS retryable_failed_count,
            count(*) FILTER (
              WHERE status = 'failed_permanent'
                 OR (status = 'failed' AND attempt_count >= $1)
            )::int AS permanent_failed_count
           FROM profile_nft_daily_awards`,
        [maxAttempts]
      );
    } catch (error) {
      awardsQueryOk = false;
      awardsQueryError = error?.message || String(error || "profile_nft_daily_awards query failed");
    }
  }

  // Optional exact Ghash heartbeat table only (worker_key PK). Missing table is not a failure.
  try {
    if (databaseEnabled() && tables.get("profile_nft_daily_worker_heartbeats") === true) {
      const hb = await query(
        `SELECT
            worker_key,
            last_tick_started_at,
            last_tick_finished_at,
            last_success_at,
            last_error_code,
            last_error_message,
            retryable_count,
            permanent_count,
            current_retry_award_id,
            next_retry_at,
            candidate_count,
            generation_gated
          FROM profile_nft_daily_worker_heartbeats
         WHERE worker_key = $1
         LIMIT 1`,
        [PROFILE_NFT_DAILY_SCOPE]
      );
      heartbeat = hb.rows[0] || null;
    }
    if (databaseEnabled() && tables.get("board_manager_leases") === true) {
      const leaseResult = await query(
        `SELECT status, manager_id, owner_instance, heartbeat_at, expires_at, updated_at
           FROM board_manager_leases
          WHERE scope = $1
          ORDER BY updated_at DESC
          LIMIT 1`,
        [PROFILE_NFT_DAILY_SCOPE]
      );
      lease = leaseResult.rows[0] || null;
    }
  } catch (_error) {
    heartbeatQueryOk = false;
  }

  const row = latest.rows[0] || null;
  const counts = countsFromRows(countsResult.rows);
  const recentFailed = countsResult.rows.reduce((sum, countRow) => sum + Number(countRow.recent_failed || 0), 0);
  const oldestRunningAt = countsResult.rows
    .map((countRow) => iso(countRow.oldest_running_at))
    .filter(Boolean)
    .sort()[0] || null;
  const attemptRow = attemptCounts.rows[0] || {};
  const evaluated = evaluateDailyProfileNftWorkerState({
    nowMs,
    env: process.env,
    enabled,
    generationGated: profileNftGenerationGated(process.env, heartbeat),
    awardsQueryOk,
    awardsQueryError,
    heartbeatQueryOk,
    heartbeat,
    lease,
    counts,
    latestAward: row,
    latestSuccessAt: latestSuccess.rows[0]?.latest_success_at || null,
    oldestRunningAt,
    permanentFailedCount: Number(attemptRow.permanent_failed_count || 0),
    retryableFailedCount: Number(attemptRow.retryable_failed_count || 0),
    pendingCount: Number(attemptRow.pending_count || counts.pending || 0),
    runningCount: Number(attemptRow.running_count || counts.running || 0),
    recentFailedCount: recentFailed,
    maxAttempts,
    staleRunningMs,
  });

  return item({
    id: evaluated.id,
    category: evaluated.category,
    title: evaluated.title,
    description: evaluated.description,
    owner: evaluated.owner,
    trigger: evaluated.trigger,
    cadence: evaluated.cadence,
    status: evaluated.status,
    statusLabel: evaluated.statusLabel,
    state: evaluated.workerState,
    reason: evaluated.reason,
    lastRunAt: evaluated.lastRunAt,
    lastSuccessAt: evaluated.lastSuccessAt,
    nextRunAt: evaluated.nextRetryAt || null,
    staleAfterMs: evaluated.staleAfterMs,
    counts: evaluated.counts,
    lastError: evaluated.lastError,
    details: [
      ...(evaluated.details || []),
      evaluated.lastTickAt && `lastTick=${evaluated.lastTickAt}`,
      evaluated.lastTickStartedAt && `lastTickStarted=${evaluated.lastTickStartedAt}`,
      evaluated.lastTickEndedAt && `lastTickEnded=${evaluated.lastTickEndedAt}`,
      evaluated.lastErrorCode && `errorCode=${evaluated.lastErrorCode}`,
      `enabled=${evaluated.enabled}`,
      `generationGated=${evaluated.generationGated}`,
      `retryableFailed=${evaluated.counts.retryableFailed || 0}`,
      `permanentFailed=${evaluated.counts.permanentFailed || 0}`,
      `staleRunning=${evaluated.counts.staleRunning || 0}`,
      evaluated.candidateCount != null && `candidateCount=${evaluated.candidateCount}`,
      evaluated.currentRetryAwardId && `currentRetryAwardId=${evaluated.currentRetryAwardId}`,
      evaluated.nextRetryAt && `nextRetryAt=${evaluated.nextRetryAt}`,
      lease?.status && `lease=${lease.status}`,
      row?.id && `latestAward=${row.id} ${row.status || ""}`.trim(),
      `state=${evaluated.workerState}`,
      evaluated.reason && `reason=${evaluated.reason}`,
    ],
  });
}
