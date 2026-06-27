import { databaseEnabled, query } from "../db/pool.js";
import { activeAllocationStatuses, safeText, taskClass as normalizeTaskClass, toIso } from "./network-tasks-utils.js";

// Canonical Network Task capacity rule (single source of truth).
//
// A contributor is "at capacity" when any Network Task allocation for them is
// still live. Liveness is status-based, never created_at-window based: a
// multi-day accepted Network Task keeps blocking until it actually closes.
//
// The blocking allocation-status set is `activeAllocationStatuses`
// (candidate, queued, proposed, accepted, submitted, verification_requested,
// verification_response_submitted, reward_decided). This is the reconciled
// union with `isOutstandingNetworkTask`: that helper also lists the
// generation-job statuses running/generated/link_failed, but while a
// generation job is in any of those states its allocation row is still
// `queued` (or `proposed` once published), so allocation-status liveness
// already covers pending generation.
//
// `task_projections` is the truth for generated tasks. An allocation whose
// underlying task projection reached a terminal outcome never blocks, even if
// the allocation mirror row is stale (nothing else retires abandoned
// allocation rows; projection sync repairs them lazily, and the old 24h
// window was papering over rows it had not repaired yet).
export const terminalNetworkTaskProjectionStatuses = [
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "failed",
  "completed",
  "rewarded",
];

const pendingGenerationJobStatuses = ["queued", "running", "generated", "link_failed"];

function useDatabase() {
  return databaseEnabled();
}

function blockerKind(row = {}) {
  const taskId = safeText(row.task_id, 180);
  const jobStatus = safeText(row.generation_job_status, 80).toLowerCase();
  if (!taskId && pendingGenerationJobStatuses.includes(jobStatus)) return "generation_job";
  const state = safeText(row.state, 80).toLowerCase();
  if (state === "proposed") return "proposed_task";
  return "allocation";
}

function capacityBlocker(row = {}) {
  return {
    source: "active_network_task_capacity",
    kind: blockerKind(row),
    projectId: safeText(row.project_id, 180),
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    allocationId: safeText(row.allocation_id, 180),
    generationJobId: safeText(row.generation_job_id, 180),
    taskClass: normalizeTaskClass(row.task_class),
    title: safeText(row.title || row.ref_title || row.project_need_summary || "Active Network Task", 240),
    state: safeText(row.state || row.allocation_status, 80),
    allocationStatus: safeText(row.allocation_status, 80),
    taskProjectionStatus: safeText(row.task_projection_status, 80),
    rewardOfferPft: Number(row.reward_offer_pft || row.reward_max_pft || 0),
    acceptBy: toIso(row.accept_by),
    deadlineAt: toIso(row.deadline_at),
    accountId: safeText(row.candidate_account_id, 180),
    // "" means the blocker is account-scoped (candidate wallet not known yet).
    walletAddress: safeText(row.candidate_wallet_address, 120),
    createdAt: toIso(row.allocation_created_at),
    updatedAt: toIso(row.updated_at || row.allocation_updated_at),
  };
}

const capacityScopeSql = `
      alloc.allocation_status = ANY($1::text[])
      AND ($2::text = '' OR alloc.candidate_account_id = $2)
      AND (
        $3::text = ''
        OR alloc.candidate_wallet_address = $3
        OR (
          $2::text <> ''
          AND alloc.candidate_account_id = $2
          AND alloc.candidate_wallet_address = ''
        )
      )
      -- task_projections is the truth: terminal task outcomes never block,
      -- even when the allocation mirror row is stale.
      AND (p.status IS NULL OR lower(p.status) <> ALL($4::text[]))
      -- Wallet-bound blockers only count while that wallet is still an active
      -- linked user wallet. Old/delinked-wallet tasks stay auditable but do
      -- not consume current capacity. Account-scoped blockers always count.
      AND (
        alloc.candidate_wallet_address = ''
        OR EXISTS (
          SELECT 1
          FROM pftl_sync_wallets w
          WHERE w.wallet_address = alloc.candidate_wallet_address
            AND w.account_id = alloc.candidate_account_id
            AND w.role = 'user'
            AND w.status = 'active'
        )
      )
`;

// Canonical capacity predicate. Returns the live blockers that consume the
// contributor's Network Task capacity. Used by the Board Manager executor
// hook, getNetworkTaskEligibility, and boardActionPressure.candidateCapacity
// so all three surfaces give the same verdict.
//
// Cross-class blocking is explicit policy: an active allocation of any class
// (network or alpha) blocks new allocation for that wallet. Pass
// `sameClassOnly: true` plus `taskClass` only if a future policy needs the old
// class-scoped behavior (no deliberate-scoping evidence was found; the
// original scoping landed in an undocumented checkpoint commit).
export async function listNetworkTaskCapacityBlockers({
  accountId = "",
  walletAddress = "",
  sameClassOnly = false,
  taskClass = "",
  limit = 12,
} = {}) {
  if (!useDatabase()) return [];
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWalletAddress = safeText(walletAddress, 120);
  if (!normalizedAccountId && !normalizedWalletAddress) return [];
  const normalizedClass = sameClassOnly ? normalizeTaskClass(taskClass) : "";
  const result = await query(
    `
      SELECT
        alloc.id AS allocation_id,
        alloc.project_id,
        alloc.task_class,
        alloc.allocation_status,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.project_need_summary,
        alloc.created_at AS allocation_created_at,
        alloc.updated_at AS allocation_updated_at,
        job.id AS generation_job_id,
        job.status AS generation_job_status,
        COALESCE(NULLIF(alloc.task_request_id, ''), job.request_id, '') AS request_id,
        COALESCE(NULLIF(alloc.generated_task_id, ''), NULLIF(job.task_id, ''), refs.task_id, '') AS task_id,
        refs.title AS ref_title,
        p.title,
        p.status AS task_projection_status,
        p.reward_offer_pft,
        alloc.reward_max_pft,
        p.accept_by,
        p.deadline_at,
        COALESCE(p.status, refs.state, job.status, alloc.allocation_status) AS state,
        COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at) AS updated_at
      FROM network_task_allocations alloc
      LEFT JOIN LATERAL (
        SELECT id, status, request_id, task_id, updated_at
        FROM network_task_generation_jobs
        WHERE allocation_id = alloc.id
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) job ON true
      LEFT JOIN LATERAL (
        SELECT task_id, title, state, updated_at
        FROM network_project_task_refs refs
        WHERE (alloc.generated_task_id <> '' AND refs.task_id = alloc.generated_task_id)
           OR (COALESCE(job.task_id, '') <> '' AND refs.task_id = job.task_id)
           OR (COALESCE(job.request_id, '') <> '' AND refs.request_id = job.request_id)
        ORDER BY refs.updated_at DESC
        LIMIT 1
      ) refs ON true
      LEFT JOIN task_projections p
        ON p.task_id = COALESCE(NULLIF(alloc.generated_task_id, ''), NULLIF(job.task_id, ''), NULLIF(refs.task_id, ''))
      WHERE ${capacityScopeSql}
        AND ($5::text = '' OR alloc.task_class = $5)
      ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at) DESC,
               alloc.id DESC
      LIMIT $6
    `,
    [
      activeAllocationStatuses,
      normalizedAccountId,
      normalizedWalletAddress,
      terminalNetworkTaskProjectionStatuses,
      normalizedClass,
      Math.min(Math.max(Number(limit || 12), 1), 50),
    ]
  );
  return result.rows.map(capacityBlocker);
}

// Capacity metrics for observability events. Same liveness, projection-truth,
// and wallet-liveness rules as listNetworkTaskCapacityBlockers.
export async function getNetworkTaskCapacityMetrics({ accountId = "", walletAddress = "" } = {}) {
  const empty = {
    accountOutstandingCount: 0,
    walletOutstandingCount: 0,
    accountOnlyPendingCount: 0,
    accountPendingGenerationCount: 0,
    walletPendingGenerationCount: 0,
  };
  if (!useDatabase()) return empty;
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWalletAddress = safeText(walletAddress, 120);
  if (!normalizedAccountId && !normalizedWalletAddress) return empty;
  const result = await query(
    `
      SELECT
        count(*) FILTER (
          WHERE $2::text <> ''
            AND alloc.candidate_account_id = $2
        )::int AS account_outstanding_count,
        count(*) FILTER (
          WHERE $3::text <> ''
            AND alloc.candidate_wallet_address = $3
        )::int AS wallet_outstanding_count,
        count(*) FILTER (
          WHERE $2::text <> ''
            AND alloc.candidate_account_id = $2
            AND alloc.candidate_wallet_address = ''
        )::int AS account_only_pending_count,
        count(*) FILTER (
          WHERE $2::text <> ''
            AND alloc.candidate_account_id = $2
            AND job.status = ANY($5::text[])
        )::int AS account_pending_generation_count,
        count(*) FILTER (
          WHERE $3::text <> ''
            AND alloc.candidate_wallet_address = $3
            AND job.status = ANY($5::text[])
        )::int AS wallet_pending_generation_count
      FROM network_task_allocations alloc
      LEFT JOIN LATERAL (
        SELECT id, status, task_id
        FROM network_task_generation_jobs
        WHERE allocation_id = alloc.id
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) job ON true
      LEFT JOIN task_projections p
        ON p.task_id = COALESCE(NULLIF(alloc.generated_task_id, ''), NULLIF(job.task_id, ''))
      WHERE ${capacityScopeSql}
        AND (
          ($2::text <> '' AND alloc.candidate_account_id = $2)
          OR ($3::text <> '' AND alloc.candidate_wallet_address = $3)
        )
    `,
    [
      activeAllocationStatuses,
      normalizedAccountId,
      normalizedWalletAddress,
      terminalNetworkTaskProjectionStatuses,
      pendingGenerationJobStatuses,
    ]
  );
  const row = result.rows[0] || {};
  return {
    accountOutstandingCount: Number(row.account_outstanding_count || 0),
    walletOutstandingCount: Number(row.wallet_outstanding_count || 0),
    accountOnlyPendingCount: Number(row.account_only_pending_count || 0),
    accountPendingGenerationCount: Number(row.account_pending_generation_count || 0),
    walletPendingGenerationCount: Number(row.wallet_pending_generation_count || 0),
  };
}

// Per-candidate capacity checks for the Board Manager source packet. Each
// check carries the same canonical blockers so
// boardActionPressure.candidateCapacity agrees with the executor hook and
// getNetworkTaskEligibility.
export async function listNetworkTaskCandidateCapacityChecks(candidates = []) {
  const checks = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const accountId = safeText(candidate?.accountId || candidate?.account_id, 180);
    const walletAddress = safeText(candidate?.walletAddress || candidate?.wallet_address, 120);
    const blockers = accountId || walletAddress
      ? await listNetworkTaskCapacityBlockers({ accountId, walletAddress }).catch(() => [])
      : [];
    checks.push({
      accountId,
      walletAddress,
      availableForNetworkTask: blockers.length === 0,
      blockers,
    });
  }
  return checks;
}
