import { randomUUID } from "node:crypto";
import { databaseEnabled } from "../db/pool.js";
import { query } from "../db/pool.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function uniqueWalletAddresses(wallets = []) {
  return Array.from(
    new Set(
      wallets
        .map((wallet) => String(wallet?.address || wallet || "").trim())
        .filter(Boolean)
    )
  );
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDailyAirdropRun(row = null) {
  if (!row) return null;
  const inputSnapshot = row.input_snapshot || row.inputSnapshot || {};
  const outputJson = row.output_json || row.outputJson || {};
  return {
    id: row.id || "",
    accountId: row.account_id || row.accountId || "",
    runDate: row.run_date ? dateOnly(row.run_date) : "",
    runMode: row.run_mode || row.runMode || "dry_run",
    isCanonical: Boolean(row.is_canonical || row.isCanonical),
    status: row.status || "",
    dailyAirdropPft: Number(row.daily_airdrop_pft || row.dailyAirdropPft || 0),
    retentionValueScore: Number(row.retention_value_score || row.retentionValueScore || 0),
    whatRaisedToday: safeText(row.what_raised_today || row.whatRaisedToday, 1000),
    whatKeptItLower: safeText(row.what_kept_it_lower || row.whatKeptItLower, 1000),
    toImproveTomorrow: safeText(row.to_improve_tomorrow || row.toImproveTomorrow, 1000),
    eligibilityStatus: row.eligibility_status || row.eligibilityStatus || "ineligible",
    eligibilityReason: row.eligibility_reason || row.eligibilityReason || "",
    reasoningText: safeText(row.reasoning_text || row.reasoningText, 2500),
    actualAirdropPft7d: Number(row.actual_airdrop_pft_7d || row.actualAirdropPft7d || 0),
    maxPossibleAirdropPft7d: Number(row.max_possible_airdrop_pft_7d || row.maxPossibleAirdropPft7d || 0),
    alignmentScore7d: Number(row.alignment_score_7d || row.alignmentScore7d || 0),
    inputHash: row.input_hash || row.inputHash || "",
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || row.promptVersion || "",
    promptDigest: row.prompt_digest || row.promptDigest || "",
    recipientWallet: inputSnapshot?.airdrop_recipient || null,
    rewardTotals: inputSnapshot?.reward_totals || null,
    lookback: inputSnapshot?.lookback || null,
    output: outputJson,
    issuance: row.issuance_id ? {
      id: row.issuance_id,
      status: row.issuance_status || "",
      sourceWallet: row.issuance_source_wallet || "",
      recipientWallet: row.issuance_recipient_wallet || "",
      amountPft: Number(row.issuance_amount_pft || 0),
      sourceCid: row.issuance_source_cid || "",
      txHash: row.issuance_tx_hash || "",
      ledgerIndex: row.issuance_ledger_index || null,
      payloadDigest: row.issuance_payload_digest || "",
      submittedAt: toIso(row.issuance_submitted_at),
      completedAt: toIso(row.issuance_completed_at),
    } : null,
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
    completedAt: toIso(row.completed_at || row.completedAt),
  };
}

function emptyRewardHistory({ range = "28d" } = {}) {
  return {
    range,
    points: [],
    totals: {
      rewardPft: 0,
      taskCount: 0,
    },
    firstRewardAt: null,
    lastRewardAt: null,
  };
}

function rangeDays(range = "28d") {
  if (range === "7d") return 7;
  if (range === "90d") return 90;
  return 28;
}

export async function resolveDailyAirdropRecipientWallet({
  accountId,
  candidateWallets = [],
  activeWalletAddress = "",
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("daily_airdrop_account_required");
  const walletAddresses = uniqueWalletAddresses(candidateWallets);
  const normalizedActiveWallet = safeText(activeWalletAddress, 120);
  if (walletAddresses.length === 0) {
    return {
      wallet_address: "",
      selection_status: "none",
      task_count: 0,
      rewarded_task_count: 0,
      reward_paid_pft: 0,
      last_task_at: null,
      candidate_wallet_count: 0,
    };
  }

  const result = await query(
    `WITH candidates AS (
       SELECT unnest($2::text[]) AS wallet_address
     ),
     ranked AS (
       SELECT c.wallet_address,
              COUNT(p.task_id)::integer AS task_count,
              COUNT(p.task_id) FILTER (WHERE p.reward_actual_pft > 0)::integer AS rewarded_task_count,
              COALESCE(SUM(p.reward_actual_pft), 0)::numeric AS reward_paid_pft,
              MAX(p.updated_at) AS last_task_at,
              CASE WHEN c.wallet_address = $3 THEN 1 ELSE 0 END AS active_rank
         FROM candidates c
         LEFT JOIN task_projections p
           ON p.account_id = $1
          AND p.subject_wallet = c.wallet_address
        GROUP BY c.wallet_address
     )
     SELECT wallet_address,
            task_count,
            rewarded_task_count,
            reward_paid_pft::text AS reward_paid_pft,
            last_task_at,
            active_rank
       FROM ranked
      ORDER BY task_count DESC,
               rewarded_task_count DESC,
               reward_paid_pft DESC,
               last_task_at DESC NULLS LAST,
               active_rank DESC,
               wallet_address ASC
      LIMIT 1`,
    [normalizedAccount, walletAddresses, normalizedActiveWallet]
  );
  const row = result.rows[0] || null;
  if (!row?.wallet_address) {
    return {
      wallet_address: "",
      selection_status: "none",
      task_count: 0,
      rewarded_task_count: 0,
      reward_paid_pft: 0,
      last_task_at: null,
      candidate_wallet_count: walletAddresses.length,
    };
  }
  const taskCount = Number(row.task_count || 0);
  const activeSelected = row.wallet_address === normalizedActiveWallet;
  return {
    wallet_address: row.wallet_address,
    selection_status: "selected",
    selected_active_wallet: activeSelected,
    task_count: taskCount,
    rewarded_task_count: Number(row.rewarded_task_count || 0),
    reward_paid_pft: Number(row.reward_paid_pft || 0),
    last_task_at: row.last_task_at ? new Date(row.last_task_at).toISOString() : null,
    candidate_wallet_count: walletAddresses.length,
  };
}

export async function resolveDailyAirdropWalletCloud({ accountId } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount || !databaseEnabled()) {
    return {
      accountId: normalizedAccount,
      activeWalletAddress: "",
      wallets: [],
      source: "pftl_sync_wallets",
    };
  }
  const result = await query(
    `SELECT wallet_address,
            status,
            role,
            priority,
            metadata_json,
            created_at,
            updated_at,
            last_hot_sync_at,
            last_archive_sync_at
       FROM pftl_sync_wallets
      WHERE account_id = $1
        AND role = 'user'
        AND wallet_address <> ''
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
               priority ASC,
               updated_at DESC,
               wallet_address ASC`,
    [normalizedAccount]
  );
  const activeRows = result.rows.filter((row) => row.status === "active");
  const activeWalletAddress = activeRows[0]?.wallet_address || "";
  const wallets = result.rows.map((row) => {
    const status = row.status === "active" ? "linked" : "historical";
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    return {
      address: safeText(row.wallet_address, 120),
      status,
      sources: [
        "pftl_sync_wallets",
        row.status === "active" ? "active_sync_wallet" : "historical_sync_wallet",
        metadata.reason ? `reason:${safeText(metadata.reason, 80)}` : "",
        metadata.inactiveReason ? `inactive:${safeText(metadata.inactiveReason, 80)}` : "",
      ].filter(Boolean),
      linkedAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      lastHotSyncAt: toIso(row.last_hot_sync_at),
      lastArchiveSyncAt: toIso(row.last_archive_sync_at),
    };
  });
  return {
    accountId: normalizedAccount,
    activeWalletAddress,
    wallets,
    source: "pftl_sync_wallets",
  };
}

export async function getLatestDailyAirdropRun({ accountId } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount || !databaseEnabled()) return null;
  const result = await query(
    `SELECT r.*,
            i.id AS issuance_id,
            i.status AS issuance_status,
            i.source_wallet AS issuance_source_wallet,
            i.recipient_wallet AS issuance_recipient_wallet,
            i.amount_pft::text AS issuance_amount_pft,
            i.source_cid AS issuance_source_cid,
            i.tx_hash AS issuance_tx_hash,
            i.ledger_index AS issuance_ledger_index,
            i.payload_digest AS issuance_payload_digest,
            i.submitted_at AS issuance_submitted_at,
            i.completed_at AS issuance_completed_at
       FROM profile_daily_airdrop_runs r
       LEFT JOIN profile_daily_airdrop_issuances i
         ON i.run_id = r.id
      WHERE r.account_id = $1
        AND r.status = 'completed'
      ORDER BY COALESCE(i.submitted_at, r.completed_at) DESC NULLS LAST,
               r.updated_at DESC,
               r.created_at DESC
      LIMIT 1`,
    [normalizedAccount]
  );
  return normalizeDailyAirdropRun(result.rows[0] || null);
}

export async function getProfileRewardHistory({ accountId, range = "28d" } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  const normalizedRange = ["7d", "28d", "90d"].includes(range) ? range : "28d";
  if (!normalizedAccount || !databaseEnabled()) return emptyRewardHistory({ range: normalizedRange });

  const days = rangeDays(normalizedRange);
  const result = await query(
    `WITH bounds AS (
       SELECT
         (timezone('UTC', now())::date - (($2::integer - 1) * interval '1 day'))::date AS start_day,
         timezone('UTC', now())::date AS end_day
     ),
     days AS (
       SELECT generate_series(start_day, end_day, interval '1 day')::date AS day
         FROM bounds
     ),
     reward_events AS (
       SELECT DISTINCT ON (task_id)
              task_id,
              occurred_at,
              source_tx_hash,
              source_cid
         FROM task_events
        WHERE account_id = $1
          AND event_type = 'pf.reward.v1'
        ORDER BY task_id, occurred_at DESC
     ),
     rewards AS (
       SELECT timezone('UTC', COALESCE(r.occurred_at, p.last_event_at, p.updated_at))::date AS day,
              SUM(p.reward_actual_pft)::numeric AS reward_pft,
              COUNT(p.task_id)::integer AS task_count,
              MAX(COALESCE(r.occurred_at, p.last_event_at, p.updated_at)) AS last_reward_at
         FROM task_projections p
         LEFT JOIN reward_events r ON r.task_id = p.task_id
        WHERE p.account_id = $1
          AND p.reward_actual_pft > 0
          AND timezone('UTC', COALESCE(r.occurred_at, p.last_event_at, p.updated_at))::date
              BETWEEN (SELECT start_day FROM bounds) AND (SELECT end_day FROM bounds)
        GROUP BY 1
     ),
     airdrops AS (
       SELECT timezone('UTC', COALESCE(submitted_at, completed_at, updated_at))::date AS day,
              SUM(amount_pft)::numeric AS airdrop_pft,
              COUNT(id)::integer AS airdrop_count,
              MAX(COALESCE(submitted_at, completed_at, updated_at)) AS last_airdrop_at
         FROM profile_daily_airdrop_issuances
        WHERE account_id = $1
          AND status = 'submitted'
          AND timezone('UTC', COALESCE(submitted_at, completed_at, updated_at))::date
              BETWEEN (SELECT start_day FROM bounds) AND (SELECT end_day FROM bounds)
        GROUP BY 1
     )
     SELECT d.day::text AS day,
            COALESCE(r.reward_pft, 0)::text AS reward_pft,
            COALESCE(r.task_count, 0)::integer AS task_count,
            r.last_reward_at,
            COALESCE(a.airdrop_pft, 0)::text AS airdrop_pft,
            COALESCE(a.airdrop_count, 0)::integer AS airdrop_count,
            a.last_airdrop_at
       FROM days d
       LEFT JOIN rewards r ON r.day = d.day
       LEFT JOIN airdrops a ON a.day = d.day
      ORDER BY d.day ASC`,
    [normalizedAccount, days]
  );

  const points = result.rows.map((row) => ({
    date: row.day,
    total: Number(row.reward_pft || 0) + Number(row.airdrop_pft || 0),
    rewardPft: Number(row.reward_pft || 0),
    airdropPft: Number(row.airdrop_pft || 0),
    taskCount: Number(row.task_count || 0),
    airdropCount: Number(row.airdrop_count || 0),
    lastRewardAt: toIso(row.last_reward_at),
    lastAirdropAt: toIso(row.last_airdrop_at),
  }));
  const rewardPft = points.reduce((sum, point) => sum + Number(point.rewardPft || 0), 0);
  const airdropPft = points.reduce((sum, point) => sum + Number(point.airdropPft || 0), 0);
  const totalPft = rewardPft + airdropPft;
  const taskCount = points.reduce((sum, point) => sum + Number(point.taskCount || 0), 0);
  const airdropCount = points.reduce((sum, point) => sum + Number(point.airdropCount || 0), 0);
  const nonZero = points.filter((point) => Number(point.total || 0) > 0 || Number(point.taskCount || 0) > 0 || Number(point.airdropCount || 0) > 0);
  return {
    range: normalizedRange,
    points,
    totals: {
      rewardPft: Number(rewardPft.toFixed(6)),
      airdropPft: Number(airdropPft.toFixed(6)),
      totalPft: Number(totalPft.toFixed(6)),
      taskCount,
      airdropCount,
    },
    firstRewardAt: nonZero[0]?.date || null,
    lastRewardAt:
      nonZero[nonZero.length - 1]?.lastAirdropAt ||
      nonZero[nonZero.length - 1]?.lastRewardAt ||
      nonZero[nonZero.length - 1]?.date ||
      null,
  };
}

export async function listDailyAirdropCandidateAccounts({
  runDate = dateOnly(),
  lookbackDays = 7,
  limit = 10,
} = {}) {
  if (!databaseEnabled()) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const safeLookbackDays = Math.min(Math.max(Number(lookbackDays) || 7, 1), 30);
  const result = await query(
    `WITH bounds AS (
       SELECT
         $1::date AS run_day,
         (($1::date + interval '1 day') AT TIME ZONE 'UTC')::timestamptz AS run_day_end,
         (($1::date + interval '1 day' - ($2::integer * interval '1 day')) AT TIME ZONE 'UTC')::timestamptz AS lookback_start
     ),
     reward_events AS (
       SELECT DISTINCT ON (task_id)
              task_id,
              occurred_at
         FROM task_events
        WHERE event_type = 'pf.reward.v1'
        ORDER BY task_id, occurred_at DESC
     ),
     eligible_accounts AS (
       SELECT p.account_id,
              COUNT(p.task_id)::integer AS rewarded_task_count,
              COALESCE(SUM(p.reward_actual_pft), 0)::numeric AS reward_actual_pft,
              MAX(COALESCE(r.occurred_at, p.last_event_at, p.updated_at)) AS last_reward_at
         FROM task_projections p
         LEFT JOIN reward_events r ON r.task_id = p.task_id
         CROSS JOIN bounds b
        WHERE p.account_id <> ''
          AND p.reward_actual_pft > 0
          AND COALESCE(r.occurred_at, p.last_event_at, p.updated_at) >= b.lookback_start
          AND COALESCE(r.occurred_at, p.last_event_at, p.updated_at) < b.run_day_end
        GROUP BY p.account_id
     )
     SELECT e.account_id,
            e.rewarded_task_count,
            e.reward_actual_pft::text AS reward_actual_pft,
            e.last_reward_at
       FROM eligible_accounts e
       CROSS JOIN bounds b
      WHERE NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_issuances i
               WHERE i.account_id = e.account_id
                 AND i.run_date = b.run_day
                 AND i.status IN ('pending', 'processing', 'submitted', 'failed')
            )
        AND EXISTS (
              SELECT 1
                FROM pftl_sync_wallets sw
               WHERE sw.account_id = e.account_id
                 AND sw.status = 'active'
                 AND sw.role = 'user'
            )
        AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_runs r
               WHERE r.account_id = e.account_id
                 AND r.run_date = b.run_day
                 AND r.run_mode = 'production'
                 AND r.status IN ('running', 'completed')
            )
      ORDER BY e.last_reward_at DESC NULLS LAST, e.reward_actual_pft DESC, e.account_id ASC
      LIMIT $3`,
    [dateOnly(runDate), safeLookbackDays, safeLimit]
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    rewardedTaskCount: Number(row.rewarded_task_count || 0),
    rewardActualPft: Number(row.reward_actual_pft || 0),
    lastRewardAt: toIso(row.last_reward_at),
  }));
}

export async function createDailyAirdropRun({
  id = `airdrop_${randomUUID()}`,
  accountId,
  runDate = dateOnly(),
  runMode = "dry_run",
  scenarioId = "",
  isCanonical = false,
  status = "pending",
  inputHash = "",
  inputSnapshot = {},
  provider = "",
  model = "",
  promptVersion = "",
  promptDigest = "",
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("daily_airdrop_account_required");
  const result = await query(
    `INSERT INTO profile_daily_airdrop_runs (
       id, account_id, run_date, run_mode, scenario_id, is_canonical, status,
       input_hash, input_snapshot, provider, model, prompt_version, prompt_digest
     )
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
     RETURNING *`,
    [
      id,
      normalizedAccount,
      runDate,
      runMode,
      safeText(scenarioId, 240),
      Boolean(isCanonical),
      status,
      safeText(inputHash, 200),
      JSON.stringify(inputSnapshot || {}),
      safeText(provider, 80),
      safeText(model, 160),
      safeText(promptVersion, 120),
      safeText(promptDigest, 120),
    ]
  );
  return result.rows[0] || null;
}

export async function completeDailyAirdropRun({
  id,
  output = {},
  dailyAirdropPft = 0,
  retentionValueScore = 0,
  whatRaisedToday = "",
  whatKeptItLower = "",
  toImproveTomorrow = "",
  eligibilityStatus = "ineligible",
  eligibilityReason = null,
  reasoningText = "",
  actualAirdropPft7d = 0,
  maxPossibleAirdropPft7d = 70000,
  alignmentScore7d = 0,
} = {}) {
  const result = await query(
    `UPDATE profile_daily_airdrop_runs
        SET status = 'completed',
            daily_airdrop_pft = $2,
            retention_value_score = $3,
            what_raised_today = $4,
            what_kept_it_lower = $5,
            to_improve_tomorrow = $6,
            eligibility_status = $7,
            eligibility_reason = $8,
            reasoning_text = $9,
            actual_airdrop_pft_7d = $10,
            max_possible_airdrop_pft_7d = $11,
            alignment_score_7d = $12,
            output_json = $13::jsonb,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      safeText(id, 120),
      Number(dailyAirdropPft || 0),
      Number(retentionValueScore || 0),
      safeText(whatRaisedToday, 1000),
      safeText(whatKeptItLower, 1000),
      safeText(toImproveTomorrow, 1000),
      eligibilityStatus === "eligible" ? "eligible" : "ineligible",
      eligibilityReason ? safeText(eligibilityReason, 300) : null,
      safeText(reasoningText, 2500),
      Number(actualAirdropPft7d || 0),
      Number(maxPossibleAirdropPft7d || 0),
      Number(alignmentScore7d || 0),
      JSON.stringify(output || {}),
    ]
  );
  return result.rows[0] || null;
}

export async function failDailyAirdropRun({ id, errorMessage = "" } = {}) {
  const result = await query(
    `UPDATE profile_daily_airdrop_runs
        SET status = 'failed',
            error_message = $2,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1
      RETURNING *`,
    [safeText(id, 120), safeText(errorMessage, 1200)]
  );
  return result.rows[0] || null;
}

export async function recentDailyAirdropRunWindow({
  accountId,
  from,
  to,
  includeDryRunId = "",
  includeDryRunAmount = 0,
  includeDryRunMaxPft = 0,
} = {}) {
  const result = await query(
    `SELECT COALESCE(SUM(daily_airdrop_pft), 0)::numeric AS amount,
            COALESCE(SUM(COALESCE(NULLIF(input_snapshot->'daily_airdrop_policy'->>'max_daily_pft', '')::numeric, 10000)), 0)::numeric AS max_possible
       FROM profile_daily_airdrop_runs
      WHERE account_id = $1
        AND status = 'completed'
        AND run_mode = 'production'
        AND run_date >= $2::date
        AND run_date <= $3::date`,
    [safeText(accountId, 180), dateOnly(from), dateOnly(to)]
  );
  const productionAmount = Number(result.rows[0]?.amount || 0);
  const productionMaxPossible = Number(result.rows[0]?.max_possible || 0);
  const dryRunAmount = includeDryRunId ? Number(includeDryRunAmount || 0) : 0;
  const dryRunMaxPossible = includeDryRunId ? Number(includeDryRunMaxPft || 0) : 0;
  return {
    actualAirdropPft: productionAmount + dryRunAmount,
    maxPossibleAirdropPft: productionMaxPossible + dryRunMaxPossible,
  };
}
