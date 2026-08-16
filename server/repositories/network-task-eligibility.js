import { databaseEnabled, query } from "../db/pool.js";
import {
  compactCandidate,
  compactNetworkTaskContent,
  groupNetworkTaskContentText,
  isCompletedNetworkTask,
  isOutstandingNetworkTask,
  isStoppedNetworkTask,
  numeric,
  safeArray,
  safeObject,
  safeText,
  toIso,
} from "./network-tasks-utils.js";
import {
  getNetworkTaskCapacityMetrics,
  listNetworkTaskCapacityBlockers,
} from "./network-task-capacity.js";
import { networkBadgeProjectionForAccount } from "./network-badges.js";
import { recordNetworkTaskCapacityEvent } from "./user-observability.js";

export function useDatabase() { return databaseEnabled(); }

export async function getNetworkTaskContentSnapshot({
  completedLimit = 5,
  outstandingLimit = 25,
  pendingLimit = 10,
  stoppedLimit = 10,
} = {}) {
  const normalizedCompletedLimit = Math.min(Math.max(Number(completedLimit || 5), 1), 25);
  const normalizedOutstandingLimit = Math.min(Math.max(Number(outstandingLimit || 25), 1), 100);
  const normalizedPendingLimit = Math.min(Math.max(Number(pendingLimit || 10), 0), 50);
  const normalizedStoppedLimit = Math.min(Math.max(Number(stoppedLimit || 10), 0), 50);
  if (!useDatabase()) {
    return {
      schema: "pf.hive.network_task_content_snapshot.v1",
      generatedAt: new Date().toISOString(),
      completed: [],
      outstanding: [],
      stopped: [],
      pendingGeneration: [],
      counts: { completed: 0, outstanding: 0, stopped: 0, pendingGeneration: 0 },
      text: "NETWORK TASK CONTENT SNAPSHOT\n\nCompleted Network Tasks (0)\nNone\n\nOutstanding Network Tasks (0)\nNone\n\nStopped Network Tasks (0)\nNone\n\nPending Network Task Generation (0)\nNone",
    };
  }

  const taskResult = await query(
    `
      SELECT
        refs.project_id,
        refs.task_id,
        refs.request_id,
        refs.title AS ref_title,
        refs.state AS ref_state,
        refs.assignee_wallet,
        refs.reward_pft AS ref_reward_pft,
        refs.created_at AS ref_created_at,
        refs.updated_at AS ref_updated_at,
        p.status,
        p.title,
        p.description,
        p.task_kind,
        p.reward_offer_pft,
        p.reward_actual_pft,
        p.submission_requirement_text,
        p.subject_wallet,
        p.metadata_json,
        p.created_at,
        p.updated_at,
        alloc.id AS allocation_id,
        alloc.allocation_status,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        alloc.allocation_reason_summary,
        alloc.project_need_summary,
        alloc.updated_at AS allocation_updated_at,
        job.id AS generation_job_id,
        job.status AS generation_job_status,
        job.task_class,
        job.source_payload_json,
        job.updated_at AS job_updated_at,
        (
          SELECT e.payload_json
	          FROM task_events e
	          WHERE e.task_id = refs.task_id
	            AND e.event_type = 'pf.reward.v1'
	          ORDER BY e.occurred_at DESC, e.id DESC
	          LIMIT 1
	        ) AS reward_outcome_payload,
        (
          SELECT e.payload_json
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type = 'pf.task.update.v1'
            AND (
              e.payload_json->>'transition' IN ('refused', 'cancelled', 'rejected')
              OR e.payload_json->>'status_after' IN ('refused', 'cancelled', 'rejected')
            )
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS stop_payload,
        (
          SELECT e.payload_json
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type = 'pf.task.update.v1'
            AND (
              e.payload_json->>'transition' = 'verification_requested'
              OR e.payload_json->>'status_after' = 'verification_requested'
            )
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS verification_request_payload
      FROM network_project_task_refs refs
      LEFT JOIN task_projections p
        ON p.task_id = refs.task_id
      LEFT JOIN network_task_generation_jobs job
        ON (
          (refs.task_id <> '' AND job.task_id = refs.task_id)
          OR (refs.request_id <> '' AND job.request_id = refs.request_id)
        )
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      WHERE refs.source = 'network_task_generation'
      ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at, refs.created_at) DESC,
               refs.id DESC
      LIMIT $1
    `,
    [normalizedCompletedLimit + normalizedOutstandingLimit + normalizedStoppedLimit + 50]
  );
  const tasks = taskResult.rows.map(compactNetworkTaskContent);
  const completed = tasks.filter(isCompletedNetworkTask).slice(0, normalizedCompletedLimit);
  const outstanding = tasks.filter(isOutstandingNetworkTask).slice(0, normalizedOutstandingLimit);
  const stopped = tasks.filter(isStoppedNetworkTask).slice(0, normalizedStoppedLimit);
  const pendingResult = normalizedPendingLimit > 0
    ? await query(
        `
          SELECT
            job.project_id,
            job.request_id,
            job.id AS generation_job_id,
            job.status AS generation_job_status,
            job.task_id,
            job.task_class,
            job.reward_min_pft AS reward_offer_pft,
            job.source_payload_json,
            job.created_at AS job_created_at,
            job.updated_at AS job_updated_at,
            alloc.id AS allocation_id,
            alloc.allocation_status,
            alloc.candidate_account_id,
            alloc.candidate_wallet_address,
            alloc.allocation_reason_summary,
            alloc.project_need_summary,
            alloc.created_at AS allocation_created_at,
            alloc.updated_at AS allocation_updated_at
          FROM network_task_generation_jobs job
          LEFT JOIN network_task_allocations alloc
            ON alloc.id = job.allocation_id
          WHERE job.status IN ('queued', 'running', 'generated', 'link_failed')
            AND NOT EXISTS (
              SELECT 1
              FROM network_project_task_refs refs
              WHERE refs.request_id = job.request_id
                 OR refs.task_id = job.task_id
            )
          ORDER BY job.updated_at DESC, job.created_at DESC, job.id DESC
          LIMIT $1
        `,
        [normalizedPendingLimit]
      )
    : { rows: [] };
  const pendingGeneration = pendingResult.rows.map((row) => ({
    ...compactNetworkTaskContent(row),
    state: safeText(row.generation_job_status || row.allocation_status || "queued", 80).toLowerCase(),
  }));
  const text = [
    "NETWORK TASK CONTENT SNAPSHOT",
    "",
    `Completed window: last ${normalizedCompletedLimit} rewarded Network Tasks`,
    groupNetworkTaskContentText("Completed Network Tasks", completed),
    "",
    groupNetworkTaskContentText("Outstanding Network Tasks", outstanding),
    "",
    groupNetworkTaskContentText("Stopped Network Tasks", stopped),
    "",
    groupNetworkTaskContentText("Pending Network Task Generation", pendingGeneration),
  ].join("\n");
  return {
    schema: "pf.hive.network_task_content_snapshot.v1",
    generatedAt: new Date().toISOString(),
    completed,
    outstanding,
    stopped,
    pendingGeneration,
    counts: {
      completed: completed.length,
      outstanding: outstanding.length,
      stopped: stopped.length,
      pendingGeneration: pendingGeneration.length,
    },
    text,
  };
}
// Intentionally does NOT filter candidates by Network Task capacity:
// - resolveCandidate() must still find an explicitly targeted busy candidate
//   so the executor can raise the precise `network_task_candidate_at_capacity`
//   error (instead of a misleading `network_task_candidate_not_eligible`);
// - the Board Manager source packet needs busy candidates visible, annotated
//   with their blockers via boardActionPressure.candidateCapacity.
// Capacity is enforced by listNetworkTaskCapacityBlockers (the shared
// predicate) at the executor hook, eligibility, and pressure call sites.
export async function listEligibleNetworkTaskCandidates({ limit = 12 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      WITH latest_profiles AS (
        SELECT DISTINCT ON (account_id)
          id AS profile_id,
          account_id,
          source_packet_digest,
          output_json,
          output_text,
          completed_at,
          created_at
        FROM network_task_profiles
        WHERE status = 'completed'
          AND superseded_at IS NULL
          AND account_id <> ''
        ORDER BY account_id, completed_at DESC NULLS LAST, created_at DESC, id DESC
      )
      SELECT lp.*,
             wallet.wallet_address
      FROM latest_profiles lp
      JOIN LATERAL (
        SELECT wallet_address
        FROM pftl_sync_wallets
        WHERE account_id = lp.account_id
          AND role = 'user'
          AND status = 'active'
          AND wallet_address <> ''
        ORDER BY priority DESC, last_hot_sync_at DESC NULLS LAST, wallet_address ASC
        LIMIT 1
      ) wallet ON true
      ORDER BY lp.completed_at DESC NULLS LAST, lp.created_at DESC, lp.account_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 12), 1), 50)]
  );
  return result.rows.map(compactCandidate);
}

export function eligibilityGate(id, label, status, detail, action = "") {
  return {
    id,
    label,
    status,
    detail: safeText(detail, 500),
    action: safeText(action, 180),
  };
}

export async function getNetworkTaskEligibility({
  accountId = "",
  walletAddress = "",
  recordCapacityEvent = true,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWalletAddress = safeText(walletAddress, 120);
  const base = {
    schema: "pf.task_node.network_task_eligibility.v1",
    canRequestManually: false,
    manualRequestCopy: "Request task creates personal task proposals. Network Tasks are routed by Hive Board Manager when an active project needs a candidate.",
    policy: {
      requiresSignedInAccount: true,
      requiresLinkedPftWallet: true,
      requiresActivePftlWalletSync: true,
      requiresCompletedNetworkDiagnosticReport: true,
      capacityConsumedByOutstandingOrPendingNetworkTasks: true,
      capacityBlocksUntilTaskReachesTerminalState: true,
      capacityIgnoresTaskClass: true,
      delinkedWalletTasksDoNotBlockCurrentWallet: true,
      personalTasksDoNotBlockNetworkTasks: true,
      requiresNetworkTaskOperatingBadge: true,
      boardManagerSelectsWhenProjectNeedsWork: true,
    },
    status: "setup_required",
    label: "Network task setup required",
    summary: "Network Tasks are routed by Hive Board Manager after your wallet and routing profile are ready.",
    nextAction: "Sign in, link a PFT wallet, and generate your Network Diagnostic Report.",
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
    profile: { status: "missing" },
    wallet: {
      linked: Boolean(normalizedWalletAddress),
      synced: false,
    },
    capacity: {
      available: false,
      blockers: [],
    },
    badgeEligibility: {
      status: "unknown",
      verifiedBadgeIds: [],
      defaultBadge: "",
      allowedWorkTypes: [],
      rewardCaps: {},
      source: "",
      hasNonAnonOperatingBadge: false,
      summary: "",
    },
    gates: [],
  };

  if (!normalizedAccountId) {
    return {
      ...base,
      status: "sign_in_required",
      label: "Sign in required",
      summary: "Sign in before Task Node can build a Network Task routing profile.",
      nextAction: "Sign in with GitHub, email, Telegram, or X.",
      gates: [
        eligibilityGate("account", "Signed-in account", "action_required", "Network Task routing is account-scoped.", "Sign in"),
      ],
    };
  }

  if (!useDatabase()) {
    return {
      ...base,
      status: "unavailable",
      label: "Network task routing unavailable",
      summary: "The database is not configured, so Task Node cannot inspect Network Task eligibility.",
      nextAction: "Run with Postgres enabled.",
      gates: [
        eligibilityGate("database", "Routing database", "blocked", "Network Task routing needs Postgres."),
      ],
    };
  }

  const [profileResult, jobResult, walletResult, blockerResult, capacityMetricsResult, badgeProjectionResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM network_task_profiles
        WHERE account_id = $1
          AND status = 'completed'
          AND superseded_at IS NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `,
      [normalizedAccountId]
    ),
    query(
      `
        SELECT id, status, last_error, created_at, updated_at
        FROM network_task_profile_jobs
        WHERE account_id = $1
          AND status IN ('pending', 'processing', 'failed')
        ORDER BY
          CASE status WHEN 'processing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
          updated_at DESC,
          id DESC
        LIMIT 1
      `,
      [normalizedAccountId]
    ),
    normalizedWalletAddress
      ? query(
        `
          SELECT wallet_address, last_hot_sync_at, last_archive_sync_at AS last_full_sync_at, status
          FROM pftl_sync_wallets
          WHERE account_id = $1
            AND wallet_address = $2
            AND role = 'user'
            AND status = 'active'
          ORDER BY priority DESC, last_hot_sync_at DESC NULLS LAST, wallet_address ASC
          LIMIT 1
        `,
        [normalizedAccountId, normalizedWalletAddress]
      )
      : Promise.resolve({ rows: [] }),
    // Canonical capacity predicate shared with the Board Manager executor
    // hook and boardActionPressure.candidateCapacity.
    listNetworkTaskCapacityBlockers({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
      limit: 8,
    }),
    getNetworkTaskCapacityMetrics({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
    }),
    networkBadgeProjectionForAccount({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
    }).catch((error) => ({
      error: safeText(error?.message || "network_badge_projection_failed", 240),
    })),
  ]);

  const profile = profileResult.rows[0] || null;
  const job = jobResult.rows[0] || null;
  const wallet = walletResult.rows[0] || null;
  const blockers = blockerResult;
  const capacityMetrics = capacityMetricsResult;
  const badgeProjection = badgeProjectionResult?.schema ? badgeProjectionResult : null;
  const badgeProjectionError = safeText(badgeProjectionResult?.error || "", 240);
  const badgeIds = safeArray(badgeProjection?.verifiedBadgeIds).map((badgeId) => safeText(badgeId, 80)).filter(Boolean);
  const badgeEligible = badgeIds.length > 0;
  const badgeLabels = safeArray(badgeProjection?.verifiedBadges)
    .map((badge) => safeText(badge.label || badge.badgeId, 120))
    .filter(Boolean);
  const badgeEligibility = {
    schema: "pf.task_node.network_task_badge_eligibility_summary.v1",
    catalogVersion: safeText(badgeProjection?.catalogVersion || "", 80),
    status: badgeEligible ? "available" : "missing",
    verifiedBadgeIds: badgeIds,
    verifiedBadges: safeArray(badgeProjection?.verifiedBadges).map((badge) => ({
      badgeId: safeText(badge.badgeId, 80),
      label: safeText(badge.label, 120),
      symbolKey: safeText(badge.symbolKey, 80),
      maxPayoutPft: numeric(badge.maxPayoutPft, 0),
      allowedWorkTypes: safeArray(badge.allowedWorkTypes).map((workType) => safeText(workType, 120)).filter(Boolean),
    })).filter((badge) => badge.badgeId),
    defaultBadge: safeText(badgeProjection?.defaultBadge || "", 80),
    allowedWorkTypes: safeArray(badgeProjection?.allowedWorkTypes).map((workType) => safeText(workType, 120)).filter(Boolean),
    rewardCaps: safeObject(badgeProjection?.rewardCaps),
    source: safeText(badgeProjection?.source || "", 80),
    hasNonAnonOperatingBadge: badgeIds.length > 0,
    error: badgeProjectionError,
    summary: badgeProjectionError
      ? "Task Node could not project Network Task badge state."
      : !badgeEligible
        ? "No verified Network Task operating badge was found."
        : `Verified Network Task lanes: ${badgeLabels.join(", ")}.`,
  };
  const profileStatus = profile
    ? "completed"
    : ["pending", "processing"].includes(job?.status)
      ? job.status
      : job?.status === "failed"
        ? "failed"
        : "missing";
  const walletSynced = Boolean(wallet?.wallet_address);
  const gates = [
    eligibilityGate(
      "wallet",
      "Linked PFT wallet",
      normalizedWalletAddress ? "complete" : "action_required",
      normalizedWalletAddress
        ? "A PFT wallet is linked to this account."
        : "Network Tasks need a linked wallet because offers and rewards are wallet-bound.",
      normalizedWalletAddress ? "" : "Create or link a wallet"
    ),
    eligibilityGate(
      "wallet_sync",
      "Wallet indexed by Task Node",
      normalizedWalletAddress && walletSynced ? "complete" : normalizedWalletAddress ? "pending" : "blocked",
      walletSynced
        ? "The linked wallet is active in the PFTL sync cache."
        : normalizedWalletAddress
          ? "Task Node has not indexed the linked wallet as an active user wallet yet."
          : "Link a wallet before wallet indexing can complete.",
      walletSynced ? "" : "Refresh wallet/task sync"
    ),
    eligibilityGate(
      "routing_profile",
      "Network Diagnostic Report",
      profile ? "complete" : ["pending", "processing"].includes(profileStatus) ? "pending" : "action_required",
      profile
        ? "A completed compact routing profile exists for Board Manager."
        : ["pending", "processing"].includes(profileStatus)
          ? "The routing profile job is queued or processing."
          : "Board Manager needs the generated routing profile before it can pick this account.",
      profile ? "" : "Open Memory and refresh the Network Diagnostic Report"
    ),
    eligibilityGate(
      "operating_badge",
      "Network Task operating badge",
      badgeEligible ? "complete" : "action_required",
      badgeEligibility.summary,
      badgeEligible ? "" : "Open Profile and qualify a routing badge"
    ),
    eligibilityGate(
      "capacity",
      "Network Task capacity",
      !badgeEligible || blockers.length ? "blocked" : "complete",
      !badgeEligible
        ? "Network Task capacity is blocked until this account has a verified operating badge."
        : blockers.length
        ? "An outstanding or pending Network Task is already consuming this account's Network Task capacity."
        : "No active Network Task capacity blocker was found for this account.",
      !badgeEligible
        ? "Open Profile and qualify a routing badge"
        : blockers.length
          ? "Finish, refuse, or wait for the active Network Task to close"
          : ""
    ),
    eligibilityGate(
      "board_routing",
      "Hive Board Manager routing",
      profile && walletSynced && badgeEligible && !blockers.length ? "waiting" : "blocked",
      "Network Tasks are generated by Board Manager when an active project needs work; personal proposed tasks do not block eligibility.",
    ),
  ];

  const ready = Boolean(profile && normalizedWalletAddress && walletSynced && badgeEligible && blockers.length === 0);
  const status = !normalizedWalletAddress
    ? "setup_required"
    : !walletSynced
      ? "wallet_sync_pending"
      : profileStatus === "pending" || profileStatus === "processing"
        ? "profile_pending"
        : profileStatus === "failed"
          ? "profile_failed"
          : !profile
            ? "profile_required"
            : !badgeEligible
              ? "badge_required"
              : blockers.length
              ? "at_capacity"
              : "available_for_routing";
  const labelByStatus = {
    setup_required: "Link wallet for Network Tasks",
    wallet_sync_pending: "Wallet sync required",
    profile_pending: "Routing profile processing",
    profile_failed: "Routing profile failed",
    profile_required: "Network profile required",
    badge_required: "Network Task badge required",
    at_capacity: "Network Task capacity busy",
    available_for_routing: "Eligible for Board Manager routing",
  };
  const nextActionByStatus = {
    setup_required: "Create or link a wallet.",
    wallet_sync_pending: "Open Wallet or Tasks and refresh after the wallet sync catches up.",
    profile_pending: "Wait for the memory worker to finish the Network Diagnostic Report.",
    profile_failed: "Open Memory and refresh the Network Diagnostic Report.",
    profile_required: "Open Memory and refresh the Network Diagnostic Report.",
    badge_required: "Open Profile and qualify at least one routing badge.",
    at_capacity: "Finish or close the active Network Task before another Network Task can be routed.",
    available_for_routing: "No manual request is needed. Hive Board Manager can route a Network Task when a project needs work.",
  };

  const eligibility = {
    ...base,
    status,
    label: labelByStatus[status] || base.label,
    summary: ready
      ? "This account is routable for Network Tasks. Board Manager still chooses when an active project needs this profile."
      : "Network Task routing needs a linked wallet, active wallet sync, a completed Network Diagnostic Report, a verified operating badge, and free Network Task capacity.",
    nextAction: nextActionByStatus[status] || base.nextAction,
    profile: {
      status: profileStatus,
      id: profile?.id || "",
      completedAt: toIso(profile?.completed_at),
      jobId: job?.id || "",
      jobStatus: job?.status || "",
      lastError: safeText(job?.last_error || "", 500),
    },
    wallet: {
      linked: Boolean(normalizedWalletAddress),
      synced: walletSynced,
      lastHotSyncAt: toIso(wallet?.last_hot_sync_at),
      lastFullSyncAt: toIso(wallet?.last_full_sync_at),
    },
    capacity: {
      available: badgeEligible && !blockers.length,
      blockers,
      metrics: capacityMetrics,
      badgeBlocked: !badgeEligible,
    },
    badgeEligibility,
    gates,
  };
  if (recordCapacityEvent !== false) {
    await recordNetworkTaskCapacityEvent({ eligibility, metrics: capacityMetrics }).catch(() => {});
  }
  return eligibility;
}
export async function projectById(projectId = "") {
  const result = await query(
    `
      SELECT *
      FROM network_projects
      WHERE id = $1
        AND status = 'active'
      LIMIT 1
    `,
    [safeText(projectId, 180)]
  );
  return result.rows[0] || null;
}

export async function currentProjectProductDoc(projectId = "") {
  const result = await query(
    `
      SELECT *
      FROM network_project_product_docs
      WHERE project_id = $1
        AND status = 'current'
        AND superseded_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [safeText(projectId, 180)]
  );
  return result.rows[0] || null;
}

// Single eligibility predicate shared by the routing pool and the task
// creation engine. Both surfaces MUST agree; when a candidate is refused,
// the reason names exactly which rule failed:
//   - account_unresolved: no account id given or derivable from the wallet
//   - no_verified_badge: the sybil gate — no verified, unrevoked badge
//   - wallet_unresolved: no current linked wallet, explicit wallet, or
//     active sync wallet to deliver the offer to
export async function explainNetworkTaskCandidateEligibility({
  accountId = "",
  explicitWallet = "",
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) return { eligible: false, reason: "account_unresolved" };

  const badge = await query(
    `SELECT badge_id FROM account_network_badges
     WHERE account_id = $1 AND status = 'verified' AND revoked_at IS NULL
     LIMIT 1`,
    [normalizedAccount]
  );
  if (!badge.rows[0]) return { eligible: false, reason: "no_verified_badge" };

  let walletAddress = "";
  const mirror = await query(
    `SELECT wallet_address FROM account_linked_wallets WHERE account_id = $1 AND status = 'linked' LIMIT 1`,
    [normalizedAccount]
  );
  walletAddress = safeText(mirror.rows[0]?.wallet_address, 120);
  if (!walletAddress) walletAddress = safeText(explicitWallet, 120);
  if (!walletAddress) {
    const sync = await query(
      `SELECT wallet_address FROM pftl_sync_wallets
       WHERE account_id = $1 AND role = 'user' AND status = 'active' AND wallet_address <> ''
       ORDER BY priority DESC, last_hot_sync_at DESC NULLS LAST LIMIT 1`,
      [normalizedAccount]
    );
    walletAddress = safeText(sync.rows[0]?.wallet_address, 120);
  }
  if (!walletAddress) return { eligible: false, reason: "wallet_unresolved" };
  return { eligible: true, reason: "", accountId: normalizedAccount, walletAddress, badgeId: badge.rows[0].badge_id };
}

export async function resolveCandidate({ decision = {} } = {}) {
  const payload = safeObject(decision.payload);
  const networkTask = safeObject(payload.network_task || payload.networkTask);
  const contributor = safeObject(payload.contributor);
  const explicitAccountId = safeText(
    networkTask.candidate_account_id ||
      networkTask.candidateAccountId ||
      contributor.account_id ||
      contributor.accountId ||
      (decision.target_type === "account" ? decision.target_id : ""),
    180
  );
  const explicitWallet = safeText(
    networkTask.candidate_wallet_address ||
      networkTask.candidateWalletAddress ||
      contributor.wallet_address ||
      contributor.walletAddress,
    120
  );
  if (!explicitAccountId && !explicitWallet) return null;

  // Eligibility is badge-based (the actual sybil gate), not membership in
  // the legacy network_task_profiles table — that table was populated by
  // the retired hive pipeline and rots. Wallet resolution prefers the
  // durable linked-wallet mirror so offers land where the user looks.
  let accountId = explicitAccountId;
  if (!accountId && explicitWallet) {
    const byMirror = await query(
      `SELECT account_id FROM account_linked_wallets WHERE wallet_address = $1 AND status = 'linked' LIMIT 1`,
      [explicitWallet]
    );
    accountId = safeText(byMirror.rows[0]?.account_id, 180);
    if (!accountId) {
      const byHistory = await query(
        `SELECT account_id FROM task_projections
         WHERE subject_wallet = $1 AND account_id <> ''
         ORDER BY last_event_at DESC LIMIT 1`,
        [explicitWallet]
      );
      accountId = safeText(byHistory.rows[0]?.account_id, 180);
    }
  }
  const verdict = await explainNetworkTaskCandidateEligibility({
    accountId,
    explicitWallet,
  });
  if (!verdict.eligible) {
    const error = new Error(`network_task_candidate_not_eligible:${verdict.reason}`);
    error.status = 422;
    error.reason = verdict.reason;
    throw error;
  }
  const walletAddress = verdict.walletAddress;

  // Optional enrichment from the legacy profile table when present.
  const profile = await query(
    `SELECT id, source_packet_digest, output_text, output_json, completed_at
     FROM network_task_profiles
     WHERE account_id = $1 AND status = 'completed' AND superseded_at IS NULL
     ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const profileRow = profile.rows[0] || {};
  return {
    accountId,
    walletAddress,
    profileId: safeText(profileRow.id, 180),
    profileDigest: safeText(profileRow.source_packet_digest, 180),
    profileText: safeText(profileRow.output_text, 5000),
    profileOutput: profileRow.output_json && typeof profileRow.output_json === "object" ? profileRow.output_json : {},
    completedAt: profileRow.completed_at || null,
  };
}
