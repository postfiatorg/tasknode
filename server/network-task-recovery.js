import { databaseEnabled, query } from "./db/pool.js";
import { processTaskReviewQueueOnce } from "./task-review-worker.js";
import { syncNetworkTaskProjection } from "./repositories/network-tasks.js";

const ACTIVE_TASK_STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function workerState(metadata = {}, workerName = "") {
  return safeObject(safeObject(metadata).workers?.[workerName]);
}

function boolString(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function compactEvidenceEvent(event = {}) {
  if (!event || typeof event !== "object") return null;
  const payload = safeObject(event.payload_json);
  if (!event.source_cid && !event.source_tx_hash && !payload.schema) return null;
  return {
    schema: safeText(event.event_type || payload.schema, 120),
    eventId: safeText(payload.event_id, 180),
    phase: safeText(payload.phase, 120),
    sourceCid: safeText(event.source_cid, 240),
    sourceTxHash: safeText(event.source_tx_hash, 180),
    digest: safeText(event.event_digest, 180),
    occurredAt: toIso(event.occurred_at),
    evidenceRefCount: Array.isArray(payload.evidence_refs) ? payload.evidence_refs.length : 0,
  };
}

function nextRecoveryAction(row = {}) {
  const status = safeText(row.status || row.ref_state || row.allocation_status, 80).toLowerCase();
  const metadata = safeObject(row.metadata_json);
  const verificationWorker = workerState(metadata, "verification_request");
  const rewardWorker = workerState(metadata, "reward_scoring");
  const baseGuard = {
    recoverySignsUserAcceptance: false,
    recoverySubmitsUserEvidence: false,
    acceptancePolicy: "accept/refuse/cancel remain user-signed task updates",
    submissionPolicy: "initial and verification evidence remain user-signed task submissions",
  };

  if (status === "proposed") {
    return {
      state: "proposed",
      nextAction: "await_user_accept_or_refuse",
      workerName: "",
      willPublish: false,
      duplicateGuard: baseGuard,
      operatorNote: "Task offer exists. Recovery does not accept or refuse on behalf of the user.",
    };
  }
  if (status === "accepted") {
    return {
      state: "accepted",
      nextAction: "await_user_evidence",
      workerName: "",
      willPublish: false,
      duplicateGuard: baseGuard,
      operatorNote: "Accepted task is recovered as user-owned work in progress. No duplicate acceptance or evidence submission is emitted.",
    };
  }
  if (status === "submitted") {
    const alreadyPublished = boolString(verificationWorker.published);
    return {
      state: "submitted",
      nextAction: alreadyPublished ? "await_verification_request_projection" : "resume_verification_request_worker",
      workerName: "verification_request",
      willPublish: !alreadyPublished,
      duplicateGuard: {
        ...baseGuard,
        workerPublished: alreadyPublished,
        workerClaimedAt: safeText(verificationWorker.claimed_at, 80),
        workerPublishedAt: safeText(verificationWorker.published_at, 80),
        workerPolicy: "verification_request publishes only when the worker metadata is not already published",
      },
      operatorNote: alreadyPublished
        ? "Verification request was already published; recovery waits for PFTL projection instead of publishing a duplicate."
        : "Initial evidence is persisted; task review worker may resume verification request generation.",
    };
  }
  if (status === "verification_requested") {
    return {
      state: "verification_requested",
      nextAction: "await_user_verification_evidence",
      workerName: "",
      willPublish: false,
      duplicateGuard: baseGuard,
      operatorNote: "Follow-up verification ask exists. Recovery waits for the user's verification response.",
    };
  }
  if (status === "verification_response_submitted") {
    const alreadyPublished = boolString(rewardWorker.published);
    return {
      state: "verification_response_submitted",
      nextAction: alreadyPublished ? "await_reward_projection" : "resume_reward_scoring_worker",
      workerName: "reward_scoring",
      willPublish: !alreadyPublished,
      duplicateGuard: {
        ...baseGuard,
        workerPublished: alreadyPublished,
        workerClaimedAt: safeText(rewardWorker.claimed_at, 80),
        workerPublishedAt: safeText(rewardWorker.published_at, 80),
        workerPolicy: "reward_scoring publishes only when the reward worker metadata is not already published",
      },
      operatorNote: alreadyPublished
        ? "Reward decision was already published; recovery waits for PFTL projection instead of scoring again."
        : "Verification response is persisted; reward scoring worker may resume review.",
    };
  }
  if (status === "reward_decided") {
    return {
      state: "reward_decided",
      nextAction: "await_reward_payment_or_projection",
      workerName: "",
      willPublish: false,
      duplicateGuard: {
        ...baseGuard,
        rewardPolicy: "recovery does not create an extra reward outcome from an intermediate reward projection",
      },
      operatorNote: "Reward decision is indexed. Recovery waits for payment/projection catch-up rather than issuing another reward.",
    };
  }

  return {
    state: status || "unknown",
    nextAction: "ignore_non_active_state",
    workerName: "",
    willPublish: false,
    duplicateGuard: baseGuard,
    operatorNote: "State is outside the active Network Task recovery set.",
  };
}

async function listActiveNetworkTaskRecoveryRows({ limit = 50, projectId = "" } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 50), 1), 250);
  const normalizedProjectId = safeText(projectId, 180);
  const result = await query(
    `
      SELECT
        refs.id AS ref_id,
        refs.project_id,
        refs.task_id,
        refs.request_id,
        refs.state AS ref_state,
        refs.source AS ref_source,
        refs.updated_at AS ref_updated_at,
        p.account_id,
        p.subject_wallet,
        p.authority_wallet,
        p.allocation_wallet,
        p.status,
        p.title,
        p.description,
        p.reward_offer_pft,
        p.reward_actual_pft,
        p.last_event_tx_hash,
        p.last_event_cid,
        p.last_event_at,
        p.metadata_json,
        p.updated_at AS projection_updated_at,
        alloc.id AS allocation_id,
        alloc.allocation_status,
        alloc.candidate_account_id,
        alloc.candidate_wallet_address,
        job.id AS generation_job_id,
        job.status AS generation_job_status,
        (
          SELECT to_jsonb(e)
          FROM task_events e
          WHERE e.task_id = refs.task_id
            AND e.event_type IN ('pf.task.submission.v1', 'pf.task.verification_response.v1')
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT 1
        ) AS latest_evidence_event
      FROM network_project_task_refs refs
      JOIN task_projections p
        ON p.task_id = refs.task_id
      LEFT JOIN network_task_generation_jobs job
        ON (
          (refs.task_id <> '' AND job.task_id = refs.task_id)
          OR (refs.request_id <> '' AND job.request_id = refs.request_id)
        )
      LEFT JOIN network_task_allocations alloc
        ON alloc.id = job.allocation_id
           OR (alloc.generated_task_id <> '' AND alloc.generated_task_id = refs.task_id)
      WHERE refs.task_id <> ''
        AND refs.source = 'network_task_generation'
        AND p.status = ANY($1::text[])
        AND ($3::text = '' OR refs.project_id = $3)
      ORDER BY p.updated_at ASC, refs.id ASC
      LIMIT $2
    `,
    [ACTIVE_TASK_STATUSES, safeLimit, normalizedProjectId]
  );
  return result.rows;
}

function compactRecoveryTask(row = {}, sync = {}) {
  const action = nextRecoveryAction(row);
  const evidence = compactEvidenceEvent(row.latest_evidence_event);
  return {
    taskId: safeText(row.task_id, 180),
    projectId: safeText(row.project_id, 180),
    requestId: safeText(row.request_id, 180),
    allocationId: safeText(row.allocation_id, 180),
    generationJobId: safeText(row.generation_job_id, 180),
    title: safeText(row.title || "Untitled Network Task", 240),
    state: action.state,
    nextAction: action.nextAction,
    workerName: action.workerName,
    willPublish: action.willPublish,
    operatorNote: action.operatorNote,
    duplicateGuard: action.duplicateGuard,
    latestEvidence: evidence,
    projection: {
      status: safeText(row.status, 80),
      updatedAt: toIso(row.projection_updated_at),
      lastEventTxHash: safeText(row.last_event_tx_hash, 180),
      lastEventCid: safeText(row.last_event_cid, 240),
      lastEventAt: toIso(row.last_event_at),
    },
    mirror: {
      refStateBefore: safeText(row.ref_state, 80),
      allocationStatusBefore: safeText(row.allocation_status, 80),
      syncOk: Boolean(sync.ok),
      syncedState: safeText(sync.status, 80),
      syncedAllocationStatus: safeText(sync.allocationStatus, 80),
      taskRefsUpdated: Number(sync.taskRefsUpdated || 0),
      allocationsUpdated: Number(sync.allocationsUpdated || 0),
    },
  };
}

export function formatNetworkTaskRecoveryLogs(result = {}) {
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  const lines = [
    `network_task_recovery checked=${Number(result.checked || 0)} recovered=${tasks.length} execute_review_queue=${result.executeReviewQueue ? "true" : "false"}`,
  ];
  for (const task of tasks) {
    const evidence = task.latestEvidence?.sourceCid
      ? ` evidence_cid=${task.latestEvidence.sourceCid} evidence_tx=${task.latestEvidence.sourceTxHash || "none"}`
      : " evidence_cid=none";
    lines.push(
      [
        `network_task_recovered task_id=${task.taskId}`,
        `project=${task.projectId || "none"}`,
        `state=${task.state}`,
        `next=${task.nextAction}`,
        `worker=${task.workerName || "none"}`,
        `will_publish=${task.willPublish ? "true" : "false"}`,
        `mirror=${task.mirror.refStateBefore || "unknown"}->${task.mirror.syncedState || task.state}`,
        evidence.trim(),
      ].join(" ")
    );
  }
  if (result.reviewQueue) {
    lines.push(`task_review_queue claimed=${result.reviewQueue.claimed || 0}`);
  }
  return lines.join("\n");
}

export async function recoverNetworkTasksOnce({
  limit = 50,
  projectId = "",
  executeReviewQueue = false,
  logger = console,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured", tasks: [] };
  }
  const rows = await listActiveNetworkTaskRecoveryRows({ limit, projectId });
  const tasks = [];
  for (const row of rows) {
    let sync = { ok: false, reason: "sync_not_attempted" };
    try {
      sync = await syncNetworkTaskProjection({ taskId: row.task_id });
    } catch (error) {
      sync = { ok: false, error: safeText(error?.message || error, 1000) };
    }
    tasks.push(compactRecoveryTask(row, sync));
  }

  const shouldRunReviewQueue = executeReviewQueue && tasks.some((task) => (
    task.nextAction === "resume_verification_request_worker" ||
    task.nextAction === "resume_reward_scoring_worker"
  ));
  const reviewQueue = shouldRunReviewQueue
    ? await processTaskReviewQueueOnce({ limit: Math.min(Math.max(tasks.length, 1), 3), logger })
    : null;
  const result = {
    ok: true,
    checked: rows.length,
    projectId: safeText(projectId, 180),
    tasks,
    executeReviewQueue,
    reviewQueue,
  };
  logger.info?.(formatNetworkTaskRecoveryLogs(result));
  return result;
}
