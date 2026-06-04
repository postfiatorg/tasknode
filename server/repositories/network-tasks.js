import { databaseEnabled, query, transaction } from "../db/pool.js";
import { resolveBoardManagerFollowupsForTaskState } from "./board-manager-state.js";
import { enqueueNetworkTaskRewardFollowup } from "./network-task-reward-followup.js";
import {
  activeAllocationStatuses, allocationStatusForTaskStatus, compactCandidate, compactNetworkTaskContent,
  compactProductDoc, compactProject, digestJson, groupNetworkTaskContentText, isCompletedNetworkTask,
  isOutstandingNetworkTask, isStoppedNetworkTask, jsonValue, numeric, rewardBand, safeObject, safeText,
  taskClass, toIso,
} from "./network-tasks-utils.js";

export { networkTaskRewardPolicy, normalizeNetworkTaskRewardBand } from "./network-tasks-utils.js";
function useDatabase() { return databaseEnabled(); }

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

function eligibilityGate(id, label, status, detail, action = "") {
  return {
    id,
    label,
    status,
    detail: safeText(detail, 500),
    action: safeText(action, 180),
  };
}

function eligibilityBlocker(row = {}) {
  return {
    source: safeText(row.source || "network_task_allocation", 80),
    projectId: safeText(row.project_id || row.projectId, 180),
    taskId: safeText(row.task_id || row.taskId, 180),
    requestId: safeText(row.request_id || row.requestId, 180),
    allocationId: safeText(row.allocation_id || row.allocationId || row.id, 180),
    generationJobId: safeText(row.generation_job_id || row.generationJobId, 180),
    title: safeText(row.title || row.ref_title || row.project_need_summary || row.projectNeedSummary || "Active Network Task", 240),
    state: safeText(row.state || row.status || row.allocation_status || row.generation_job_status, 80),
    updatedAt: toIso(row.updated_at || row.allocation_updated_at || row.job_updated_at),
  };
}

export async function getNetworkTaskEligibility({ accountId = "", walletAddress = "" } = {}) {
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
      personalTasksDoNotBlockNetworkTasks: true,
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

  const [profileResult, jobResult, walletResult, blockerResult] = await Promise.all([
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
          SELECT wallet_address, last_hot_sync_at, last_full_sync_at, status
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
    query(
      `
        SELECT
          'active_network_task_capacity' AS source,
          alloc.id AS allocation_id,
          alloc.project_id,
          alloc.allocation_status,
          alloc.project_need_summary,
          alloc.updated_at AS allocation_updated_at,
          job.id AS generation_job_id,
          job.status AS generation_job_status,
          job.request_id,
          job.task_id,
          job.updated_at AS job_updated_at,
          refs.title AS ref_title,
          p.title,
          COALESCE(p.status, refs.state, job.status, alloc.allocation_status) AS state,
          COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at) AS updated_at
        FROM network_task_allocations alloc
        LEFT JOIN network_task_generation_jobs job
          ON job.allocation_id = alloc.id
        LEFT JOIN network_project_task_refs refs
          ON (
            (job.task_id <> '' AND refs.task_id = job.task_id)
            OR (job.request_id <> '' AND refs.request_id = job.request_id)
          )
        LEFT JOIN task_projections p
          ON p.task_id = COALESCE(NULLIF(job.task_id, ''), refs.task_id)
        WHERE alloc.allocation_status = ANY($1::text[])
          AND ($2::text = '' OR alloc.candidate_account_id = $2)
          AND ($3::text = '' OR alloc.candidate_wallet_address = $3)
          AND alloc.created_at > now() - interval '24 hours'
        ORDER BY COALESCE(p.updated_at, refs.updated_at, job.updated_at, alloc.updated_at) DESC,
                 alloc.id DESC
        LIMIT 8
      `,
      [activeAllocationStatuses, normalizedAccountId, normalizedWalletAddress]
    ),
  ]);

  const profile = profileResult.rows[0] || null;
  const job = jobResult.rows[0] || null;
  const wallet = walletResult.rows[0] || null;
  const blockers = blockerResult.rows.map(eligibilityBlocker);
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
      "capacity",
      "Network Task capacity",
      blockers.length ? "blocked" : "complete",
      blockers.length
        ? "An outstanding or pending Network Task is already consuming this account's Network Task capacity."
        : "No active Network Task capacity blocker was found for this account.",
      blockers.length ? "Finish, refuse, or wait for the active Network Task to close" : ""
    ),
    eligibilityGate(
      "board_routing",
      "Hive Board Manager routing",
      profile && walletSynced && !blockers.length ? "waiting" : "blocked",
      "Network Tasks are generated by Board Manager when an active project needs work; personal proposed tasks do not block eligibility.",
    ),
  ];

  const ready = Boolean(profile && normalizedWalletAddress && walletSynced && blockers.length === 0);
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
            : blockers.length
              ? "at_capacity"
              : "available_for_routing";
  const labelByStatus = {
    setup_required: "Link wallet for Network Tasks",
    wallet_sync_pending: "Wallet sync required",
    profile_pending: "Routing profile processing",
    profile_failed: "Routing profile failed",
    profile_required: "Network profile required",
    at_capacity: "Network Task capacity busy",
    available_for_routing: "Eligible for Board Manager routing",
  };
  const nextActionByStatus = {
    setup_required: "Create or link a wallet.",
    wallet_sync_pending: "Open Wallet or Tasks and refresh after the wallet sync catches up.",
    profile_pending: "Wait for the memory worker to finish the Network Diagnostic Report.",
    profile_failed: "Open Memory and refresh the Network Diagnostic Report.",
    profile_required: "Open Memory and refresh the Network Diagnostic Report.",
    at_capacity: "Finish or close the active Network Task before another Network Task can be routed.",
    available_for_routing: "No manual request is needed. Hive Board Manager can route a Network Task when a project needs work.",
  };

  return {
    ...base,
    status,
    label: labelByStatus[status] || base.label,
    summary: ready
      ? "This account is routable for Network Tasks. Board Manager still chooses when an active project needs this profile."
      : "Network Task routing needs a linked wallet, active wallet sync, a completed Network Diagnostic Report, and free Network Task capacity.",
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
      available: !blockers.length,
      blockers,
    },
    gates,
  };
}
async function projectById(projectId = "") {
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

async function currentProjectProductDoc(projectId = "") {
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

async function resolveCandidate({ decision = {} } = {}) {
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
  const candidates = await listEligibleNetworkTaskCandidates({ limit: 20 });
  const explicit = candidates.find((candidate) => (
    (!explicitAccountId || candidate.accountId === explicitAccountId) &&
    (!explicitWallet || candidate.walletAddress === explicitWallet)
  ));
  if (explicit) return explicit;
  const error = new Error("network_task_candidate_not_eligible");
  error.status = 422;
  throw error;
}

async function activeAllocationCount({ accountId = "", walletAddress = "", taskClass = "" } = {}) {
  const result = await query(
    `
      SELECT count(*)::int AS count
      FROM network_task_allocations
      WHERE allocation_status = ANY($1::text[])
        AND ($2::text = '' OR candidate_account_id = $2)
        AND ($3::text = '' OR candidate_wallet_address = $3)
        AND ($4::text = '' OR task_class = $4)
        AND created_at > now() - interval '24 hours'
    `,
    [activeAllocationStatuses, safeText(accountId, 180), safeText(walletAddress, 120), safeText(taskClass, 40)]
  );
  return Number(result.rows[0]?.count || 0);
}

function sourcePacketText(source = {}) {
  const project = source.project || {};
  const candidate = source.candidate || {};
  const networkTask = source.networkTask || {};
  return [
    "NETWORK TASK GENERATION SOURCE",
    "",
    `Project: ${project.title || project.id}`,
    `Project ID: ${project.id}`,
    `Project type: ${project.type}`,
    `Task class: ${networkTask.taskClass}`,
    `Reward band: ${networkTask.rewardMinPft} to ${networkTask.rewardMaxPft} PFT`,
    "",
    "Project need",
    networkTask.projectNeedSummary || source.decision?.reason || "",
    "",
    "Routing rationale",
    networkTask.allocationReasonSummary || source.decision?.reason || "",
    "",
    "Candidate",
    `Account: ${candidate.accountId}`,
    `Wallet: ${candidate.walletAddress}`,
    candidate.profileText || "No Network Diagnostic Report text available.",
  ].join("\n");
}

function normalizedIntentText(value = "") {
  return safeText(value, 2400)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|and|for|with|that|this|from|into|onto|about|please|task|work)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function intentStatusForAllocationStatus(status = "", canonicalStatus = "") {
  const normalized = safeText(status, 80).toLowerCase();
  const canonical = safeText(canonicalStatus, 80).toLowerCase();
  if (canonical === "rewarded" || normalized === "rewarded") return "rewarded";
  if (["completed", "reward_decided"].includes(normalized) || canonical === "completed") return "completed";
  if (["refused", "cancelled", "expired", "rerouted"].includes(normalized)) return "stopped";
  if (normalized === "rejected" || canonical === "rejected") return "rejected";
  if (normalized === "failed") return "failed";
  if (["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted"].includes(normalized)) {
    return "active";
  }
  return normalized || "active";
}

export async function enqueueNetworkTaskGenerationFromBoardDecision({
  runId = "",
  decision = {},
  sourcePacket = {},
} = {}) {
  if (!useDatabase()) return { executed: false, reason: "database_not_configured" };
  const projectId = safeText(decision.target_id || decision.payload?.project?.id, 180);
  if (!projectId) throw new Error("network_task_project_required");
  const project = await projectById(projectId);
  if (!project?.id) throw new Error("network_task_project_not_found");
  const candidate = await resolveCandidate({ decision });
  if (!candidate?.accountId || !candidate?.walletAddress) {
    throw new Error("network_task_candidate_required");
  }
  const payload = safeObject(decision.payload);
  const networkTask = safeObject(payload.network_task || payload.networkTask);
  const normalizedTaskClass = taskClass(
    networkTask.task_class ||
      networkTask.taskClass ||
      (payload.project?.type === "alpha_generation" || project.type === "alpha_generation" ? "alpha" : "network")
  );
  const band = rewardBand({
    min: networkTask.reward_min_pft ?? networkTask.rewardMinPft,
    max: networkTask.reward_max_pft ?? networkTask.rewardMaxPft,
  });
  const projectNeedSummary = safeText(networkTask.project_need_summary || networkTask.projectNeedSummary || payload.summary || decision.reason, 2400);
  const allocationReasonSummary = safeText(networkTask.allocation_reason_summary || networkTask.routing_reason || networkTask.routingReason || decision.reason, 1800);
  const cadenceReason = safeText(networkTask.cadence_reason || networkTask.cadenceReason || "board_manager_initiated", 600);
  const acceptWindowHours = Math.max(1, Number(networkTask.accept_window_hours || networkTask.acceptWindowHours || 24));
  const normalizedNeedHash = digestJson({ need: normalizedIntentText(projectNeedSummary) || normalizedIntentText(allocationReasonSummary) });
  const semanticIntentDigest = digestJson({
    action: "initiate_network_task",
    projectId,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    taskClass: normalizedTaskClass,
    normalizedNeedHash,
    rewardMinPft: band.min,
    rewardMaxPft: band.max,
  });
  const intentSemanticKey = `network_task_intent:${semanticIntentDigest}`;
  const idempotencyKey = `network_task:${semanticIntentDigest}`;
  const existingIntent = await query(
    `
      SELECT
        intent.*,
        job.status AS job_status,
        job.request_id,
        job.request_bundle_cid,
        job.task_id,
        alloc.allocation_status
      FROM network_task_intents intent
      LEFT JOIN network_task_generation_jobs job
        ON job.id = intent.generation_job_id
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = intent.allocation_id
      WHERE intent.semantic_key = $1
        AND intent.status NOT IN ('failed', 'stale')
        AND intent.expires_at > now()
      ORDER BY intent.updated_at DESC, intent.id DESC
      LIMIT 1
    `,
    [intentSemanticKey]
  );
  if (existingIntent.rows[0]) {
    const row = existingIntent.rows[0];
    return {
      executed: true,
      idempotent: true,
      suppressed: true,
      reason: "network_task_semantic_intent_exists",
      intentId: row.id || "",
      allocationId: row.allocation_id || "",
      jobId: row.generation_job_id || "",
      projectId,
      taskClass: normalizedTaskClass,
      candidateAccountId: candidate.accountId,
      candidateWalletAddress: candidate.walletAddress,
      rewardBandPft: [band.min, band.max],
      requestId: row.request_id || "",
      requestBundleCid: row.request_bundle_cid || "",
      taskId: row.task_id || "",
      status: row.job_status || row.allocation_status || row.status || "",
      idempotencyKey,
      intentSemanticKey,
    };
  }
  const existing = await query(
    `
      SELECT
        job.id AS job_id,
        job.status AS job_status,
        job.request_id,
        job.request_bundle_cid,
        job.task_id,
        alloc.id AS allocation_id,
        alloc.allocation_status
      FROM network_task_generation_jobs job
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
      WHERE job.idempotency_key = $1
      LIMIT 1
    `,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      executed: true,
      idempotent: true,
      allocationId: row.allocation_id || "",
      jobId: row.job_id || "",
      projectId,
      taskClass: normalizedTaskClass,
      candidateAccountId: candidate.accountId,
      candidateWalletAddress: candidate.walletAddress,
      rewardBandPft: [band.min, band.max],
      requestId: row.request_id || "",
      requestBundleCid: row.request_bundle_cid || "",
      taskId: row.task_id || "",
      status: row.job_status || row.allocation_status || "",
      idempotencyKey,
      intentSemanticKey,
    };
  }
  const activeCount = await activeAllocationCount({
    accountId: candidate.accountId,
    walletAddress: candidate.walletAddress,
    taskClass: normalizedTaskClass,
  });
  if (activeCount > 0 && !networkTask.allow_over_capacity) {
    throw new Error("network_task_candidate_at_capacity");
  }
  const productDoc = await currentProjectProductDoc(projectId);
  const idSuffix = idempotencyKey.replace(/^network_task:/, "").slice(0, 32);
  const intentId = `netintent_${idSuffix}`;
  const allocationId = `netalloc_${idSuffix}`;
  const jobId = `nettaskjob_${idSuffix}`;
  const expiresAt = new Date(Date.now() + acceptWindowHours * 60 * 60 * 1000);
  const sourceJson = {
    schema: "pf.hive.network_task_generation_source.v1",
    generated_at: new Date().toISOString(),
    board_manager_run_id: safeText(runId, 180),
    board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
    decision: {
      action: decision.action,
      target_type: decision.target_type,
      target_id: decision.target_id,
      reason: decision.reason,
      confidence: decision.confidence,
      summary: payload.summary,
      next_steps: payload.next_steps,
    },
    project: compactProject(project),
    project_document: compactProductDoc(productDoc),
    candidate,
      networkTask: {
        taskClass: normalizedTaskClass,
        projectNeedSummary,
        allocationReasonSummary,
        cadenceReason,
        rewardMinPft: band.min,
        rewardMaxPft: band.max,
        acceptWindowHours,
      },
    policy: {
      taskLifecycle: "normal_pftl_task_engine",
      supportedEvidence: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
      rewardBandPft: [band.min, band.max],
      boardManagerDoesNotAuthorTaskText: true,
    },
  };
  const sourceDigest = digestJson(sourceJson);
  const sourceText = sourcePacketText(sourceJson);
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO network_task_intents (
          id,
          semantic_key,
          project_id,
          task_class,
          candidate_account_id,
          candidate_wallet_address,
          normalized_need_hash,
          project_need_summary,
          routing_reason_summary,
          reward_min_pft,
          reward_max_pft,
          status,
          allocation_id,
          generation_job_id,
          source_state_digest,
          created_by_run_id,
          metadata_json,
          expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          'queued', $12, $13, $14, $15, $16::jsonb, now() + interval '14 days'
        )
        ON CONFLICT (semantic_key) WHERE semantic_key <> '' DO UPDATE SET
          status = 'queued',
          allocation_id = EXCLUDED.allocation_id,
          generation_job_id = EXCLUDED.generation_job_id,
          request_id = '',
          task_id = '',
          source_state_digest = EXCLUDED.source_state_digest,
          created_by_run_id = EXCLUDED.created_by_run_id,
          metadata_json = network_task_intents.metadata_json || EXCLUDED.metadata_json,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `,
      [
        intentId,
        intentSemanticKey,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        normalizedNeedHash,
        projectNeedSummary,
        allocationReasonSummary,
        band.min,
        band.max,
        allocationId,
        jobId,
        sourceDigest,
        safeText(runId, 180),
        jsonValue({
          board_manager_run_id: safeText(runId, 180),
          board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
          idempotency_key: idempotencyKey,
        }),
      ]
    );
    await client.query(
      `
        INSERT INTO network_task_allocations (
          id,
          idempotency_key,
          project_id,
          task_class,
          allocation_status,
          candidate_account_id,
          candidate_wallet_address,
          candidate_profile_id,
          candidate_profile_digest,
          allocation_reason_summary,
          project_need_summary,
          reward_min_pft,
          reward_max_pft,
          cadence_policy_json,
          metadata_json,
          expires_at
        )
        VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
        ON CONFLICT (id) DO UPDATE SET
          allocation_status = 'queued',
          task_request_id = '',
          generated_task_id = '',
          candidate_account_id = EXCLUDED.candidate_account_id,
          candidate_wallet_address = EXCLUDED.candidate_wallet_address,
          candidate_profile_id = EXCLUDED.candidate_profile_id,
          candidate_profile_digest = EXCLUDED.candidate_profile_digest,
          allocation_reason_summary = EXCLUDED.allocation_reason_summary,
          project_need_summary = EXCLUDED.project_need_summary,
          reward_min_pft = EXCLUDED.reward_min_pft,
          reward_max_pft = EXCLUDED.reward_max_pft,
          cadence_policy_json = EXCLUDED.cadence_policy_json,
          metadata_json = network_task_allocations.metadata_json || EXCLUDED.metadata_json,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `,
      [
        allocationId,
        idempotencyKey,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        candidate.profileId,
        candidate.profileDigest,
        sourceJson.networkTask.allocationReasonSummary,
        sourceJson.networkTask.projectNeedSummary,
        band.min,
        band.max,
        jsonValue({
          cadence_reason: sourceJson.networkTask.cadenceReason,
          active_allocation_count_24h: activeCount,
          accept_window_hours: sourceJson.networkTask.acceptWindowHours,
        }),
        jsonValue({
          board_manager_run_id: safeText(runId, 180),
          board_manager_reason: decision.reason,
          board_manager_source_digest: safeText(sourcePacket.sourcePacketDigest, 180),
          source_payload_digest: sourceDigest,
          idempotency_key: idempotencyKey,
        }),
        expiresAt.toISOString(),
      ]
    );
    await client.query(
      `
        INSERT INTO network_task_generation_jobs (
          id,
          idempotency_key,
          allocation_id,
          project_id,
          task_class,
          candidate_account_id,
          candidate_wallet_address,
          reward_min_pft,
          reward_max_pft,
          status,
          trigger,
          board_manager_run_id,
          prompt_version,
          source_payload_digest,
          source_payload_json,
          source_payload_text
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', 'board_manager', $10, 'taskgen_network_v1', $11, $12::jsonb, $13)
        ON CONFLICT (id) DO UPDATE SET
          status = 'queued',
          candidate_account_id = EXCLUDED.candidate_account_id,
          candidate_wallet_address = EXCLUDED.candidate_wallet_address,
          reward_min_pft = EXCLUDED.reward_min_pft,
          reward_max_pft = EXCLUDED.reward_max_pft,
          request_id = '',
          request_bundle_cid = '',
          generated_task_payload = '{}'::jsonb,
          task_id = '',
          offer_cid = '',
          offer_tx_hash = '',
          trigger = EXCLUDED.trigger,
          board_manager_run_id = EXCLUDED.board_manager_run_id,
          prompt_version = EXCLUDED.prompt_version,
          source_payload_digest = EXCLUDED.source_payload_digest,
          source_payload_json = EXCLUDED.source_payload_json,
          source_payload_text = EXCLUDED.source_payload_text,
          next_attempt_at = now(),
          locked_at = NULL,
          last_error = '',
          updated_at = now()
      `,
      [
        jobId,
        idempotencyKey,
        allocationId,
        projectId,
        normalizedTaskClass,
        candidate.accountId,
        candidate.walletAddress,
        band.min,
        band.max,
        safeText(runId, 180),
        sourceDigest,
        jsonValue(sourceJson),
        sourceText,
      ]
    );
  });
  return {
    executed: true,
    intentId,
    allocationId,
    jobId,
    projectId,
    taskClass: normalizedTaskClass,
    candidateAccountId: candidate.accountId,
    candidateWalletAddress: candidate.walletAddress,
    rewardBandPft: [band.min, band.max],
    sourcePayloadDigest: sourceDigest,
    idempotencyKey,
    intentSemanticKey,
  };
}

export async function claimNetworkTaskGenerationJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      WITH next_jobs AS (
        SELECT id
        FROM network_task_generation_jobs
        WHERE status = 'queued'
          AND next_attempt_at <= now()
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE network_task_generation_jobs job
      SET status = 'running',
          locked_at = now(),
          attempt_count = job.attempt_count + 1,
          last_error = '',
          updated_at = now()
      FROM next_jobs
      WHERE job.id = next_jobs.id
      RETURNING job.*
    `,
    [Math.min(Math.max(Number(limit || 1), 1), 5)]
  );
  return result.rows;
}

export async function markNetworkTaskGenerationJobGenerated({
  jobId = "",
  requestId = "",
  requestBundleCid = "",
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'generated',
          request_id = $2,
          request_bundle_cid = $3,
          generated_task_payload = COALESCE(generated_task_payload, '{}'::jsonb) || $4::jsonb,
          locked_at = NULL,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), safeText(requestId, 180), safeText(requestBundleCid, 240), jsonValue(metadata)]
  );
  const row = result.rows[0];
  if (row?.allocation_id) {
    await query(
      `
        UPDATE network_task_allocations
        SET allocation_status = 'queued',
            task_request_id = $2,
            metadata_json = metadata_json || $3::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [
        row.allocation_id,
        safeText(requestId, 180),
        jsonValue({ request_bundle_cid: safeText(requestBundleCid, 240) }),
      ]
    );
    await query(
      `
        UPDATE network_task_intents
        SET status = 'generated',
            request_id = $2,
            updated_at = now(),
            metadata_json = metadata_json || $3::jsonb
        WHERE generation_job_id = $1
           OR allocation_id = $4
      `,
      [
        row.id,
        safeText(requestId, 180),
        jsonValue({ request_bundle_cid: safeText(requestBundleCid, 240) }),
        row.allocation_id,
      ]
    );
  }
  return { ok: true, job: row || null };
}

export async function markNetworkTaskGenerationJobFailed({ jobId = "", error = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const message = safeText(error, 1000);
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'queued' END,
          next_attempt_at = CASE WHEN attempt_count >= 3 THEN now() ELSE now() + interval '60 seconds' END,
          locked_at = NULL,
          last_error = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(jobId, 180), message]
  );
  const row = result.rows[0];
  if (row?.allocation_id && row.status === "failed") {
    await query(
      `
        UPDATE network_task_allocations
        SET allocation_status = 'failed',
            metadata_json = metadata_json || $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [row.allocation_id, jsonValue({ last_error: message })]
    );
    await query(
      `
        UPDATE network_task_intents
        SET status = 'failed',
            metadata_json = metadata_json || $2::jsonb,
            updated_at = now()
        WHERE generation_job_id = $1
           OR allocation_id = $3
      `,
      [row.id, jsonValue({ last_error: message }), row.allocation_id]
    );
  }
  return { ok: true, job: row || null };
}

export async function markNetworkTaskOfferLinkFailed({ requestId = "", taskId = "", error = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'link_failed',
          task_id = COALESCE(NULLIF($2, ''), task_id),
          last_error = $3,
          next_attempt_at = now() + interval '60 seconds',
          locked_at = NULL,
          updated_at = now()
      WHERE request_id = $1
        AND status IN ('generated', 'published', 'link_failed')
      RETURNING *
    `,
    [safeText(requestId, 180), safeText(taskId, 180), safeText(error, 1000)]
  );
  return { ok: true, updated: result.rowCount || 0, job: result.rows[0] || null };
}

export async function completeNetworkTaskOfferFromTaskRequest({
  requestId = "",
  taskId = "",
  subjectWallet = "",
  offerCid = "",
  offerTxHash = "",
  generatedTask = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true };
  const request = safeText(requestId, 180);
  if (!request) return { ok: false, skipped: true, reason: "request_id_missing" };
  const result = await query(
    `
      UPDATE network_task_generation_jobs
      SET status = 'published',
          task_id = $2,
          offer_cid = $3,
          offer_tx_hash = $4,
          generated_task_payload = COALESCE(generated_task_payload, '{}'::jsonb) || $5::jsonb,
          locked_at = NULL,
          updated_at = now()
      WHERE request_id = $1
      RETURNING *
    `,
    [
      request,
      safeText(taskId, 180),
      safeText(offerCid, 240),
      safeText(offerTxHash, 180),
      jsonValue({ generated_task: generatedTask }),
    ]
  );
  const job = result.rows[0];
  if (!job?.id) return { ok: true, skipped: true, reason: "network_task_job_not_found" };
  await query(
    `
      UPDATE network_task_intents
      SET status = 'published',
          request_id = $2,
          task_id = $3,
          updated_at = now(),
          metadata_json = metadata_json || $4::jsonb
      WHERE generation_job_id = $1
         OR allocation_id = $5
    `,
    [
      job.id,
      request,
      safeText(taskId, 180),
      jsonValue({ offer_cid: safeText(offerCid, 240), offer_tx_hash: safeText(offerTxHash, 180) }),
      job.allocation_id,
    ]
  );
  const title = safeText(generatedTask.title, 240) || safeText(taskId, 180);
  const reward = numeric(generatedTask?.reward_offer?.amount_estimate_pft, numeric(job.reward_min_pft, 0));
  await query(
    `
      UPDATE network_task_allocations
      SET allocation_status = 'proposed',
          task_request_id = $2,
          generated_task_id = $3,
          updated_at = now(),
          metadata_json = metadata_json || $4::jsonb
      WHERE id = $1
    `,
    [
      job.allocation_id,
      request,
      safeText(taskId, 180),
      jsonValue({ offer_cid: safeText(offerCid, 240), offer_tx_hash: safeText(offerTxHash, 180) }),
    ]
  );
  await query(
    `
      INSERT INTO network_project_task_refs (
        id,
        project_id,
        task_id,
        request_id,
        title,
        state,
        assignee_wallet,
        reward_pft,
        source,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7, 'network_task_generation', $8::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        state = EXCLUDED.state,
        assignee_wallet = EXCLUDED.assignee_wallet,
        reward_pft = EXCLUDED.reward_pft,
        metadata_json = network_project_task_refs.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [
      `nettaskref_${safeText(taskId, 160)}`,
      job.project_id,
      safeText(taskId, 180),
      request,
      title,
      safeText(subjectWallet || job.candidate_wallet_address, 120),
      reward,
      jsonValue({
        allocation_id: job.allocation_id,
        generation_job_id: job.id,
        task_class: job.task_class,
        offer_cid: safeText(offerCid, 240),
        offer_tx_hash: safeText(offerTxHash, 180),
      }),
    ]
  );
  await query(
    `
      UPDATE network_projects
      SET task_count = (
            SELECT count(*)::int
            FROM network_project_task_refs
            WHERE project_id = $1
          ),
          pft_routed = (
            SELECT COALESCE(sum(reward_pft), 0)
            FROM network_project_task_refs
            WHERE project_id = $1
          ),
          updated_at = now()
      WHERE id = $1
    `,
    [job.project_id]
  );
  return { ok: true, jobId: job.id, allocationId: job.allocation_id, projectId: job.project_id };
}

export async function repairNetworkTaskOfferLinks({ limit = 5 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      SELECT
        job.id AS job_id,
        job.request_id,
        COALESCE(NULLIF(job.task_id, ''), req.generated_task_id) AS task_id,
        req.subject_wallet,
        COALESCE(req.metadata_json #>> '{workerResult,offerCid}', '') AS offer_cid,
        COALESCE(req.metadata_json #>> '{workerResult,offerTxHash}', '') AS offer_tx_hash,
        COALESCE(req.metadata_json #> '{workerResult,generatedTask}', '{}'::jsonb) AS generated_task
      FROM network_task_generation_jobs job
      JOIN task_requests req
        ON req.request_id = job.request_id
      WHERE job.status IN ('generated', 'link_failed')
        AND job.request_id <> ''
        AND req.generated_task_id <> ''
        AND job.next_attempt_at <= now()
      ORDER BY job.updated_at ASC, job.id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 5), 1), 25)]
  );
  const repaired = [];
  for (const row of result.rows) {
    try {
      repaired.push(await completeNetworkTaskOfferFromTaskRequest({
        requestId: row.request_id,
        taskId: row.task_id,
        subjectWallet: row.subject_wallet,
        offerCid: row.offer_cid,
        offerTxHash: row.offer_tx_hash,
        generatedTask: safeObject(row.generated_task),
      }));
    } catch (error) {
      await markNetworkTaskOfferLinkFailed({
        requestId: row.request_id,
        taskId: row.task_id,
        error: error?.message || String(error),
      }).catch(() => null);
      repaired.push({ ok: false, requestId: row.request_id, taskId: row.task_id, error: error?.message || String(error) });
    }
  }
  return { ok: true, checked: result.rows.length, repaired };
}

export async function syncNetworkTaskProjection({ taskId = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return { ok: false, skipped: true, reason: "task_id_missing" };

  const projectionResult = await query(
    `
      SELECT task_id, account_id, status, title, subject_wallet, reward_offer_pft, reward_actual_pft,
             last_event_tx_hash, last_event_cid, last_event_at, updated_at
      FROM task_projections
      WHERE task_id = $1
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  const projection = projectionResult.rows[0];
  if (!projection?.task_id) return { ok: false, skipped: true, reason: "task_projection_missing", taskId: normalizedTaskId };

  const canonicalStatus = safeText(projection.status || "unknown", 80).toLowerCase() || "unknown";
  const allocationStatus = allocationStatusForTaskStatus(canonicalStatus);
  const rewardPft = canonicalStatus === "rewarded"
    ? numeric(projection.reward_actual_pft, 0)
    : numeric(projection.reward_offer_pft, 0);

  const refResult = await query(
    `
      UPDATE network_project_task_refs refs
      SET state = $2,
          title = COALESCE(NULLIF($3, ''), refs.title),
          assignee_wallet = COALESCE(NULLIF($4, ''), refs.assignee_wallet),
          reward_pft = $5,
          metadata_json = refs.metadata_json || $6::jsonb,
          updated_at = now()
      WHERE refs.task_id = $1
      RETURNING refs.id, refs.project_id, refs.task_id, refs.state
    `,
    [
      normalizedTaskId,
      canonicalStatus,
      safeText(projection.title, 240),
      safeText(projection.subject_wallet, 120),
      rewardPft,
      jsonValue({
        source_of_truth: "task_projections",
        task_projection_status: canonicalStatus,
        task_projection_updated_at: toIso(projection.updated_at),
        task_projection_last_event_at: toIso(projection.last_event_at),
        last_event_tx_hash: safeText(projection.last_event_tx_hash, 180),
        last_event_cid: safeText(projection.last_event_cid, 180),
      }),
    ]
  );

  const allocationResult = await query(
    `
      UPDATE network_task_allocations alloc
      SET allocation_status = $2,
          metadata_json = alloc.metadata_json || $3::jsonb,
          updated_at = now()
      WHERE alloc.generated_task_id = $1
      RETURNING alloc.id, alloc.project_id, alloc.generated_task_id, alloc.allocation_status
    `,
    [
      normalizedTaskId,
      allocationStatus,
      jsonValue({
        source_of_truth: "task_projections",
        task_projection_status: canonicalStatus,
        task_projection_updated_at: toIso(projection.updated_at),
        task_projection_last_event_at: toIso(projection.last_event_at),
      }),
    ]
  );
  if (allocationResult.rows.length > 0) {
    await query(
      `
        UPDATE network_task_intents
        SET status = $2,
            task_id = $1,
            updated_at = now(),
            metadata_json = metadata_json || $3::jsonb
        WHERE allocation_id = ANY($4::text[])
           OR task_id = $1
      `,
      [
        normalizedTaskId,
        intentStatusForAllocationStatus(allocationStatus, canonicalStatus),
        jsonValue({ task_projection_status: canonicalStatus }),
        allocationResult.rows.map((row) => row.id),
      ]
    );
  }

  const projectIds = Array.from(new Set([
    ...refResult.rows.map((row) => row.project_id).filter(Boolean),
    ...allocationResult.rows.map((row) => row.project_id).filter(Boolean),
  ]));
  for (const projectId of projectIds) {
    await query(
      `
        UPDATE network_projects
        SET task_count = (
              SELECT count(*)::int
              FROM network_project_task_refs
              WHERE project_id = $1
            ),
            pft_routed = (
              SELECT COALESCE(sum(reward_pft), 0)
              FROM network_project_task_refs
              WHERE project_id = $1
            ),
            updated_at = now()
        WHERE id = $1
      `,
      [projectId]
    );
  }
  const boardManagerFollowup = canonicalStatus === "rewarded"
    ? await enqueueNetworkTaskRewardFollowup({
      taskId: normalizedTaskId,
      projectIds,
      projection,
      rewardPft,
    }).catch((error) => ({
      ok: false,
      queued: false,
      error: error?.message || String(error),
    }))
    : { ok: true, queued: false, skipped: true, reason: "status_not_rewarded" };
  const boardManagerFollowupsResolved = await resolveBoardManagerFollowupsForTaskState({
    accountId: safeText(projection.account_id, 180),
    projectIds,
    taskId: normalizedTaskId,
    allocationIds: allocationResult.rows.map((row) => row.id).filter(Boolean),
    status: canonicalStatus,
    reason: "network_task_projection_sync",
  }).catch((error) => ({
    ok: false,
    updated: 0,
    error: error?.message || String(error),
  }));

  return {
    ok: true,
    taskId: normalizedTaskId,
    status: canonicalStatus,
    allocationStatus,
    taskRefsUpdated: refResult.rowCount || 0,
    allocationsUpdated: allocationResult.rowCount || 0,
    projectIds,
    boardManagerFollowup,
    boardManagerFollowupsResolved,
  };
}

export async function syncNetworkTaskProjections({ limit = 100 } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      SELECT DISTINCT refs.task_id
      FROM network_project_task_refs refs
      JOIN task_projections projections
        ON projections.task_id = refs.task_id
      WHERE refs.task_id <> ''
        AND refs.state IS DISTINCT FROM projections.status
      ORDER BY refs.task_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 100), 1), 500)]
  );
  const synced = [];
  for (const row of result.rows) {
    synced.push(await syncNetworkTaskProjection({ taskId: row.task_id }));
  }
  return {
    ok: true,
    checked: result.rows.length,
    synced,
  };
}
