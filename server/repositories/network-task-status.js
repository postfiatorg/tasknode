import { databaseEnabled, query } from "../db/pool.js";

const allocationStates = new Set([
  "candidate",
  "queued",
  "running",
  "generated",
  "published",
  "link_failed",
  "failed",
  "expired",
  "rerouted",
]);

const taskStates = new Set([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "rewarded",
  "refused",
  "cancelled",
]);

const activeRewardGuardStatuses = new Set([
  "submitting",
  "submitted",
  "submit_unknown",
  "duplicate_guarded",
  "duplicate",
]);

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function boolValue(value) {
  return value === true || safeText(value, 20).toLowerCase() === "true";
}

function normalizeStatus(value = "") {
  return safeText(value, 80).toLowerCase();
}

function projectionFromRow(row = {}) {
  return {
    task_id: row.task_id,
    task_kind: row.task_kind || row.projected_task_kind,
    status: row.status || row.task_status || row.projected_status || row.state,
    reward_offer_pft: row.reward_offer_pft || row.projected_reward_offer_pft,
    reward_actual_pft: row.reward_actual_pft || row.projected_reward_actual_pft,
    event_count: row.event_count || row.projected_event_count,
    last_event_tx_hash: row.last_event_tx_hash || row.projected_last_event_tx_hash,
    last_event_cid: row.last_event_cid || row.projected_last_event_cid,
    metadata_json: row.metadata_json || row.projection_metadata_json,
  };
}

function allocationFromRow(row = {}) {
  return {
    id: row.allocation_id,
    allocation_status: row.allocation_status,
    generated_task_id: row.allocation_generated_task_id,
    task_request_id: row.allocation_task_request_id,
    metadata_json: row.allocation_metadata_json,
  };
}

function generationJobFromRow(row = {}) {
  return {
    id: row.generation_job_id || row.job_id,
    status: row.generation_job_status || row.job_status || row.status,
    task_id: row.generation_job_task_id || row.job_task_id,
    request_id: row.generation_job_request_id || row.job_request_id,
    offer_cid: row.generation_job_offer_cid || row.job_offer_cid,
    offer_tx_hash: row.generation_job_offer_tx_hash || row.job_offer_tx_hash,
    last_error: row.generation_job_last_error || row.job_last_error,
    metadata_json: row.generation_job_metadata_json,
  };
}

function eventTypes(events = []) {
  return new Set(safeArray(events).map((event) => normalizeStatus(event.event_type || event.type)).filter(Boolean));
}

function deriveAllocationState({ projection = {}, allocation = {}, generationJob = {} } = {}) {
  const jobStatus = normalizeStatus(generationJob.status);
  if (allocationStates.has(jobStatus)) return jobStatus;
  const allocationStatus = normalizeStatus(allocation.allocation_status || allocation.status);
  if (["candidate", "queued", "expired", "rerouted", "failed"].includes(allocationStatus)) return allocationStatus;
  if (["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted", "reward_decided", "refused", "rejected", "cancelled", "rewarded", "completed"].includes(allocationStatus)) {
    return "published";
  }
  if (safeText(projection.task_id || generationJob.task_id || allocation.generated_task_id, 180)) return "published";
  return "candidate";
}

function deriveTaskState({ projection = {}, allocation = {}, generationJob = {} } = {}) {
  const status = normalizeStatus(projection.status || allocation.task_status || allocation.allocation_status);
  if (taskStates.has(status)) return status;
  if (status === "rejected") return "refused";
  if (status === "expired" || status === "failed") return "cancelled";
  if (status === "completed") return "rewarded";
  if (status === "reward_decided") return "verification_response_submitted";
  const jobStatus = normalizeStatus(generationJob.status);
  if (["generated", "published", "link_failed"].includes(jobStatus)) return "proposed";
  return "proposed";
}

function rewardGuardStatus(projection = {}) {
  const metadata = safeObject(projection.metadata_json);
  return normalizeStatus(safeObject(metadata.reward_payment_guard).status);
}

function hasRewardEvent(events = [], projection = {}) {
  if (eventTypes(events).has("pf.reward.v1")) return true;
  const status = normalizeStatus(projection.status);
  return status === "rewarded" && (
    safeText(projection.last_event_tx_hash, 180) ||
    safeText(projection.last_event_cid, 240) ||
    numeric(projection.event_count, 0) > 0
  );
}

function deriveRewardMovement({ projection = {}, events = [] } = {}) {
  const guardStatus = rewardGuardStatus(projection);
  if (activeRewardGuardStatuses.has(guardStatus)) return "duplicate_guarded";
  const status = normalizeStatus(projection.status);
  const rewardActual = numeric(projection.reward_actual_pft, 0);
  if (status === "rewarded" || hasRewardEvent(events, projection)) {
    return rewardActual > 0 ? "paid_positive" : "closed_zero";
  }
  if (["reward_decided", "verification_response_submitted"].includes(status)) return "pending";
  return "none";
}

function deriveRepairReason({ allocationState = "", taskState = "", rewardMovement = "", projection = {}, generationJob = {} } = {}) {
  if (allocationState === "link_failed") return "link_failed";
  if (allocationState === "failed" && !safeText(projection.task_id, 180)) return "generation_failed";
  if (taskState === "rewarded" && !safeText(projection.last_event_tx_hash, 180) && !safeText(projection.last_event_cid, 240)) {
    return "missing_reward_pointer";
  }
  if (rewardMovement === "pending" && normalizeStatus(generationJob.status) === "link_failed") return "link_failed";
  return "";
}

export function deriveNetworkTaskStatusPacket({
  projection = {},
  allocation = {},
  generationJob = {},
  events = [],
} = {}) {
  const normalizedProjection = projectionFromRow(projection);
  const normalizedAllocation = allocationFromRow(allocation);
  const normalizedJob = generationJobFromRow(generationJob);
  const allocationState = deriveAllocationState({
    projection: normalizedProjection,
    allocation: normalizedAllocation,
    generationJob: normalizedJob,
  });
  const taskState = deriveTaskState({
    projection: normalizedProjection,
    allocation: normalizedAllocation,
    generationJob: normalizedJob,
  });
  const rewardMovement = deriveRewardMovement({
    projection: normalizedProjection,
    events,
  });
  const repairReason = deriveRepairReason({
    allocationState,
    taskState,
    rewardMovement,
    projection: normalizedProjection,
    generationJob: normalizedJob,
  });
  return {
    schema: "pf.task_node.network_task_status_packet.v1",
    allocationState: allocationStates.has(allocationState) ? allocationState : "candidate",
    taskState: taskStates.has(taskState) ? taskState : "proposed",
    rewardMovement,
    repairRequired: Boolean(repairReason),
    repairReason,
  };
}

export function deriveNetworkTaskStatusPacketFromRow(row = {}) {
  return deriveNetworkTaskStatusPacket({
    projection: projectionFromRow(row),
    allocation: allocationFromRow(row),
    generationJob: generationJobFromRow(row),
    events: safeArray(row.events || row.task_events),
  });
}

export function packetNeedsReview(packet = {}) {
  const rewardMovement = safeText(packet.rewardMovement, 80);
  return boolValue(packet.repairRequired) ||
    rewardMovement === "paid_positive" ||
    rewardMovement === "closed_zero" ||
    rewardMovement === "duplicate_guarded";
}

export async function listNetworkTaskStatusPackets({
  taskIds = [],
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  const ids = Array.from(new Set(safeArray(taskIds).map((taskId) => safeText(taskId, 180)).filter(Boolean)));
  if (!databaseReady || !ids.length) return new Map();
  const result = await queryImpl(
    `
      SELECT projection.*,
             refs.project_id,
             refs.source AS project_ref_source,
             alloc.id AS allocation_id,
             alloc.allocation_status,
             alloc.generated_task_id AS allocation_generated_task_id,
             alloc.task_request_id AS allocation_task_request_id,
             job.id AS generation_job_id,
             job.status AS generation_job_status,
             job.task_id AS generation_job_task_id,
             job.request_id AS generation_job_request_id,
             job.offer_cid AS generation_job_offer_cid,
             job.offer_tx_hash AS generation_job_offer_tx_hash,
             job.last_error AS generation_job_last_error
      FROM task_projections projection
      LEFT JOIN LATERAL (
        SELECT refs.project_id,
               refs.source,
               refs.metadata_json
        FROM network_project_task_refs refs
        WHERE refs.task_id = projection.task_id
        ORDER BY (refs.source = 'network_task_generation') DESC,
                 refs.updated_at DESC NULLS LAST,
                 refs.id DESC
        LIMIT 1
      ) refs ON true
      LEFT JOIN LATERAL (
        SELECT job.*
        FROM network_task_generation_jobs job
        WHERE job.task_id = projection.task_id
           OR (projection.request_id <> '' AND job.request_id = projection.request_id)
           OR (refs.metadata_json->>'generation_job_id' <> '' AND job.id = refs.metadata_json->>'generation_job_id')
        ORDER BY (job.task_id = projection.task_id) DESC,
                 job.updated_at DESC NULLS LAST,
                 job.id DESC
        LIMIT 1
      ) job ON true
      LEFT JOIN LATERAL (
        SELECT alloc.*
        FROM network_task_allocations alloc
        WHERE alloc.generated_task_id = projection.task_id
           OR (projection.request_id <> '' AND alloc.task_request_id = projection.request_id)
           OR (job.allocation_id <> '' AND alloc.id = job.allocation_id)
        ORDER BY (alloc.generated_task_id = projection.task_id) DESC,
                 alloc.updated_at DESC NULLS LAST,
                 alloc.id DESC
        LIMIT 1
      ) alloc ON true
      WHERE projection.task_id = ANY($1::text[])
    `,
    [ids]
  );
  const packets = new Map();
  for (const row of result.rows) {
    packets.set(safeText(row.task_id, 180), deriveNetworkTaskStatusPacketFromRow(row));
  }
  return packets;
}
