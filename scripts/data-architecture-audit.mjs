import { closePool, query } from "../server/db/pool.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function intArg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  const raw = inline ? inline.slice(prefix.length) : "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

async function scalar(sql, params = [], key = "count") {
  const result = await query(sql, params);
  return Number(result.rows[0]?.[key] || 0);
}

function pushIssue(list, issue) {
  list.push({
    severity: issue.severity || "p1",
    surface: issue.surface || "data",
    code: issue.code || "unknown_data_issue",
    ...issue,
  });
}

const limit = intArg("limit", 25);
const failOnP1 = hasFlag("fail-on-p1");

const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  p0: [],
  p1: [],
  counts: {},
};

try {
  const observationsTable = await query("SELECT to_regclass('public.pftl_pointer_observations') AS name");
  const hasObservations = Boolean(observationsTable.rows[0]?.name);
  report.counts.pointerObservationsTablePresent = hasObservations ? 1 : 0;
  if (!hasObservations) {
    pushIssue(report.p0, {
      severity: "p0",
      surface: "pftl_cache",
      code: "pointer_observations_table_missing",
      message: "pftl_pointer_observations is required so pointer memo facts are not treated as wallet-owned rows.",
    });
  }

  if (hasObservations) {
    const missingObservationCount = await scalar(
      `
        SELECT count(*)::int AS count
        FROM pftl_wallet_transactions wt
        JOIN pftl_pointer_memos pm ON pm.tx_hash = wt.tx_hash
        WHERE NOT EXISTS (
          SELECT 1
          FROM pftl_pointer_observations po
          WHERE po.wallet_address = wt.wallet_address
            AND po.tx_hash = pm.tx_hash
            AND po.memo_index = pm.memo_index
        )
      `
    );
    report.counts.pointerObservationMissing = missingObservationCount;
    if (missingObservationCount > 0) {
      pushIssue(report.p0, {
        severity: "p0",
        surface: "pftl_cache",
        code: "pointer_observations_missing",
        count: missingObservationCount,
        message: "Some wallet-observed pointer memos have no observation bridge row. Run npm run db:pftl-pointer-observation-backfill.",
      });
    }

    const orphanObservationCount = await scalar(
      `
        SELECT count(*)::int AS count
        FROM pftl_pointer_observations po
        WHERE NOT EXISTS (
          SELECT 1
          FROM pftl_pointer_memos pm
          WHERE pm.tx_hash = po.tx_hash
            AND pm.memo_index = po.memo_index
        )
      `
    );
    report.counts.pointerObservationOrphans = orphanObservationCount;
    if (orphanObservationCount > 0) {
      pushIssue(report.p0, {
        severity: "p0",
        surface: "pftl_cache",
        code: "pointer_observation_orphans",
        count: orphanObservationCount,
        message: "Observation rows exist without matching pointer memo facts.",
      });
    }
  }

  const reducerFailures = await query(
    `
      SELECT reducer_kind, COALESCE(last_error, '') AS last_error, count(*)::int AS count
      FROM pftl_cache_reducer_events
      WHERE status = 'failed'
        AND NOT (
          reducer_kind = 'task_projection_replay'
          AND COALESCE(task_id, '') = ''
          AND COALESCE(pointer_kind, '') IN ('TASK', 'TASK_UPDATE', 'TASK_SUBMISSION', 'REWARD')
        )
      GROUP BY reducer_kind, COALESCE(last_error, '')
      ORDER BY count(*) DESC, reducer_kind ASC
      LIMIT $1
    `,
    [limit]
  );
  report.counts.reducerFailed = reducerFailures.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  report.counts.reducerFailedNoTaskPointerIgnored = await scalar(
    `
      SELECT count(*)::int AS count
      FROM pftl_cache_reducer_events
      WHERE status = 'failed'
        AND reducer_kind = 'task_projection_replay'
        AND COALESCE(task_id, '') = ''
        AND COALESCE(pointer_kind, '') IN ('TASK', 'TASK_UPDATE', 'TASK_SUBMISSION', 'REWARD')
    `
  );
  if (report.counts.reducerFailed > 0) {
    pushIssue(report.p1, {
      severity: "p1",
      surface: "pftl_cache",
      code: "reducer_failed_events_present",
      count: report.counts.reducerFailed,
      examples: reducerFailures.rows,
      message: "Failed reducer rows exist. They may be legacy, but they need operator-visible repair and classification.",
    });
  }

  const taskProjectionDrift = await query(
    `
      WITH latest_event AS (
        SELECT DISTINCT ON (task_id)
          te.task_id,
          te.source_tx_hash,
          te.source_cid,
          te.payload_json,
          CASE
            WHEN te.payload_json->>'schema' = 'pf.task.offer.v1' THEN 'proposed'
            WHEN te.payload_json->>'schema' = 'pf.task.update.v1' THEN COALESCE(NULLIF(te.payload_json->>'transition', ''), 'unknown')
            WHEN te.payload_json->>'schema' = 'pf.task.submission.v1'
              THEN CASE
                WHEN te.payload_json->>'phase' = 'verification_response' THEN 'verification_response_submitted'
                ELSE 'submitted'
              END
            WHEN te.payload_json->>'schema' = 'pf.task.verification_response.v1' THEN 'verification_response_submitted'
            WHEN te.payload_json->>'schema' = 'pf.task.reward_decision.v1' THEN 'rewarded'
            WHEN te.payload_json->>'schema' = 'pf.reward.v1' THEN 'rewarded'
            ELSE 'unknown'
          END AS expected_status,
          te.occurred_at,
          tx.ledger_index,
          tx.close_time,
          COALESCE(pe.memo_index, pm.memo_index, 0) AS event_order
        FROM task_events te
        LEFT JOIN pftl_pointer_memos pm
          ON pm.tx_hash = te.source_tx_hash
         AND pm.cid = te.source_cid
        LEFT JOIN pftl_transactions tx ON tx.tx_hash = te.source_tx_hash
        LEFT JOIN pftl_task_pointer_events pe
          ON pe.task_id = te.task_id
         AND pe.source_tx_hash = te.source_tx_hash
         AND pe.source_cid = te.source_cid
        WHERE te.task_id LIKE 'task_%'
          AND te.payload_json->>'schema' <> 'pf.task.request.v1'
        ORDER BY
          te.task_id,
          tx.ledger_index DESC NULLS LAST,
          tx.close_time DESC NULLS LAST,
          event_order DESC,
          te.occurred_at DESC,
          te.source_tx_hash DESC
      ),
      event_counts AS (
        SELECT task_id, count(*)::int AS event_count
        FROM task_events
        WHERE task_id LIKE 'task_%'
          AND payload_json->>'schema' <> 'pf.task.request.v1'
        GROUP BY task_id
      )
      SELECT
        p.task_id,
        p.status AS projection_status,
        le.expected_status,
        p.event_count AS projection_event_count,
        COALESCE(ec.event_count, 0) AS actual_event_count,
        p.last_event_tx_hash,
        le.source_tx_hash AS latest_event_tx_hash,
        p.last_event_cid,
        le.source_cid AS latest_event_cid
      FROM task_projections p
      LEFT JOIN latest_event le ON le.task_id = p.task_id
      LEFT JOIN event_counts ec ON ec.task_id = p.task_id
      WHERE p.task_id LIKE 'task_%'
        AND p.source = 'pftl_cache_reducer'
        AND (
          le.task_id IS NULL
          OR p.status IS DISTINCT FROM le.expected_status
          OR p.event_count IS DISTINCT FROM COALESCE(ec.event_count, 0)
          OR p.last_event_tx_hash IS DISTINCT FROM le.source_tx_hash
          OR p.last_event_cid IS DISTINCT FROM le.source_cid
        )
      ORDER BY p.updated_at DESC
      LIMIT $1
    `,
    [limit]
  );
  report.counts.currentTaskProjectionDrift = taskProjectionDrift.rows.length;
  if (taskProjectionDrift.rows.length > 0) {
    pushIssue(report.p0, {
      severity: "p0",
      surface: "tasks",
      code: "current_task_projection_drift",
      count: taskProjectionDrift.rows.length,
      examples: taskProjectionDrift.rows,
      message: "Current app task projections disagree with normalized task_events.",
    });
  }

  const orphanTaskProjectionGarbage = await scalar(
    `
      SELECT count(*)::int AS count
      FROM task_projections
      WHERE source = 'pftl_cache_reducer'
        AND status = 'unknown'
        AND COALESCE(title, '') = ''
        AND COALESCE(description, '') = ''
        AND COALESCE(request_id, '') = ''
    `
  );
  report.counts.orphanTaskProjectionGarbage = orphanTaskProjectionGarbage;
  if (orphanTaskProjectionGarbage > 0) {
    pushIssue(report.p0, {
      severity: "p0",
      surface: "tasks",
      code: "orphan_task_projection_garbage",
      count: orphanTaskProjectionGarbage,
      message: "Blank unknown task projections exist. The reducer should not promote orphan or unrecognized task submissions into task_projections.",
    });
  }

  const knownTaskSkippedReducers = await query(
    `
      SELECT re.id, re.account_id, re.wallet_address, re.task_id, re.tx_hash, re.cid, re.payload_json->'result' AS result
      FROM pftl_cache_reducer_events re
      LEFT JOIN task_events te
        ON te.task_id = re.task_id
       AND te.source_tx_hash = re.tx_hash
       AND te.source_cid = re.cid
      WHERE re.reducer_kind = 'task_projection_replay'
        AND re.task_id LIKE 'task_%'
        AND re.status = 'completed'
        AND re.payload_json->'result'->>'skipped' = 'true'
        AND te.id IS NULL
      ORDER BY re.processed_at DESC NULLS LAST, re.id DESC
      LIMIT $1
    `,
    [limit]
  );
  report.counts.knownTaskSkippedReducers = knownTaskSkippedReducers.rows.length;
  if (knownTaskSkippedReducers.rows.length > 0) {
    pushIssue(report.p1, {
      severity: "p1",
      surface: "tasks",
      code: "known_task_reducer_skips_present",
      count: knownTaskSkippedReducers.rows.length,
      examples: knownTaskSkippedReducers.rows,
      message: "Known task reducer events were marked skipped. They should be reviewed and repaired if current.",
    });
  }

  const billingMismatchCount = await scalar(
    `
      WITH ledger AS (
        SELECT
          account_id,
          COALESCE(SUM(CASE WHEN kind = 'chat_debit' THEN amount_usd ELSE 0 END), 0) AS spend,
          COALESCE(SUM(CASE
            WHEN kind IN ('account_credit', 'top_up_credit', 'reward_credit', 'refund_credit') THEN amount_usd
            WHEN kind = 'admin_adjustment' AND amount_usd > 0 THEN amount_usd
            ELSE 0
          END), 0) AS credit,
          count(*)::int AS ledger_count
        FROM billing_ledger_entries
        GROUP BY account_id
      )
      SELECT count(*)::int AS count
      FROM billing_accounts b
      LEFT JOIN ledger l ON l.account_id = b.account_id
      WHERE b.current_spend_usd IS DISTINCT FROM COALESCE(l.spend, 0)
         OR b.current_credit_usd IS DISTINCT FROM COALESCE(l.credit, 0)
         OR b.ledger_entry_count IS DISTINCT FROM COALESCE(l.ledger_count, 0)
    `
  );
  report.counts.billingProjectionMismatch = billingMismatchCount;
  if (billingMismatchCount > 0) {
    pushIssue(report.p1, {
      severity: "p1",
      surface: "billing",
      code: "billing_projection_mismatch",
      count: billingMismatchCount,
      message: "billing_accounts does not match billing_ledger_entries for one or more accounts.",
    });
  }

  const stuckMemoryJobs = await scalar(
    `
      SELECT count(*)::int AS count
      FROM chat_memory_jobs
      WHERE status = 'processing'
        AND locked_at < now() - interval '10 minutes'
    `
  );
  const stuckDeepMemoryJobs = await scalar(
    `
      SELECT count(*)::int AS count
      FROM chat_deep_memory_jobs
      WHERE status = 'processing'
        AND locked_at < now() - interval '10 minutes'
    `
  );
  report.counts.stuckMemoryJobs = stuckMemoryJobs + stuckDeepMemoryJobs;
  if (report.counts.stuckMemoryJobs > 0) {
    pushIssue(report.p1, {
      severity: "p1",
      surface: "memory",
      code: "stuck_memory_jobs",
      count: report.counts.stuckMemoryJobs,
      message: "Async memory jobs are stuck in processing past the stale threshold.",
    });
  }

  report.ok = report.p0.length === 0 && (report.p1.length === 0 || !failOnP1);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await closePool();
}
