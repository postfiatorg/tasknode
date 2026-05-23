import { createHash } from "node:crypto";

const taskClasses = new Set(["network", "alpha"]);
export const activeAllocationStatuses = [
  "candidate",
  "queued",
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
];
const allocationStatuses = new Set([
  ...activeAllocationStatuses,
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "rewarded",
  "completed",
  "failed",
]);

export function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

export function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

export function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

export function networkTaskRewardPolicy() {
  const minPft = Math.max(0, numeric(process.env.TASKNODE_NETWORK_TASK_REWARD_MIN_PFT, 10000));
  const maxPft = Math.max(minPft || 10000, numeric(process.env.TASKNODE_NETWORK_TASK_REWARD_MAX_PFT, 50000));
  return { minPft: minPft || 10000, maxPft: maxPft || 50000 };
}

export function normalizeNetworkTaskRewardBand({ min = 10000, max = 50000 } = {}) {
  const policy = networkTaskRewardPolicy();
  const normalizedMin = Math.min(policy.maxPft, Math.max(policy.minPft, numeric(min, policy.minPft)));
  const normalizedMax = Math.min(policy.maxPft, Math.max(normalizedMin, numeric(max, policy.maxPft)));
  return { min: normalizedMin, max: normalizedMax };
}

export function allocationStatusForTaskStatus(status = "") {
  const normalized = safeText(status, 80).toLowerCase();
  if (allocationStatuses.has(normalized)) return normalized;
  if (normalized === "unknown") return "failed";
  return "accepted";
}

export function taskClass(value = "") {
  const normalized = safeText(value, 40).toLowerCase();
  return taskClasses.has(normalized) ? normalized : "network";
}

export function rewardBand({ min = 10000, max = 50000 } = {}) {
  return normalizeNetworkTaskRewardBand({ min, max });
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function oneLine(value = "", max = 320) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function truncateWithEllipsis(value = "", max = 700) {
  const text = oneLine(value, max + 80);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

export function compactProject(row = {}) {
  return {
    id: safeText(row.id, 180),
    type: safeText(row.type, 80),
    title: safeText(row.title, 180),
    summary: safeText(row.summary, 900),
    objective: safeText(row.objective, 1200),
    phase: safeText(row.phase_label, 120),
    priority: Number(row.priority || 0),
  };
}

export function compactProductDoc(row = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: safeText(row.title, 180),
    summary: safeText(row.summary, 1200),
    projectStatus: safeText(row.project_status, 1800),
    keyPoints: safeArray(row.key_points_json).map((item) => safeText(item, 700)).filter(Boolean),
    blockedOrUnclear: safeArray(row.blocked_or_unclear_json).map((item) => safeText(item, 700)).filter(Boolean),
    nextActions: safeArray(row.next_actions_json).map((item) => safeText(item, 700)).filter(Boolean),
    completedAt: toIso(row.created_at),
  };
}

export function compactCandidate(row = {}) {
  return {
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.wallet_address, 120),
    profileId: safeText(row.profile_id || row.id, 180),
    profileDigest: safeText(row.source_packet_digest, 180),
    profileText: safeText(row.output_text, 5000),
    profileOutput: safeObject(row.output_json),
    completedAt: toIso(row.completed_at),
  };
}

export function compactNetworkTaskContent(row = {}) {
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask || row.generated_task_json);
  const sourcePayload = safeObject(row.source_payload_json);
  const sourceNetworkTask = safeObject(sourcePayload.networkTask || sourcePayload.network_task);
  const networkTask = { ...sourceNetworkTask, ...safeObject(generatedTask.network_task) };
  const rewardDecision = safeObject(row.reward_decision_payload);
  const rewardScore = safeObject(rewardDecision.score || rewardDecision.reward_score);
  const stopPayload = safeObject(row.stop_payload);
  const verificationPayload = safeObject(row.verification_request_payload);
  const verificationRequest = safeObject(verificationPayload.verification_request);
  const status = safeText(row.status || row.ref_state || row.allocation_status || row.generation_job_status, 80).toLowerCase();
  const rewardOffer = numeric(row.reward_offer_pft || row.ref_reward_pft || generatedTask?.reward_offer?.amount_estimate_pft, 0);
  const rewardActual = numeric(row.reward_actual_pft, 0);
  const steps = safeArray(generatedTask.steps).map((step) => safeText(step, 500)).filter(Boolean).slice(0, 5);
  const submissionRequirement = safeText(
    row.submission_requirement_text ||
      generatedTask?.submission_requirement?.criteria ||
      generatedTask?.submission_requirement?.description ||
      "",
    1000
  );
  const rewardSummary = safeText(
    rewardScore.user_feedback || rewardScore.reason || rewardDecision.reward_summary ||
      rewardDecision.user_feedback || rewardDecision.reason || "",
    1200
  );
  const stopSummary = safeText(
    stopPayload.reason || stopPayload.refusal_reason || stopPayload.refusalReason || stopPayload.note || "",
    800
  );
  const verificationAsk = safeText(
    verificationPayload.verification_ask || verificationRequest.verification_ask || verificationRequest.ask || "",
    1000
  );

  return {
    projectId: safeText(row.project_id || networkTask.project_id, 180),
    taskClass: taskClass(row.task_class || generatedTask.task_class || networkTask.task_class),
    taskId: safeText(row.task_id || row.generated_task_id, 180),
    requestId: safeText(row.request_id, 180),
    allocationId: safeText(row.allocation_id || networkTask.allocation_id, 180),
    generationJobId: safeText(row.generation_job_id || networkTask.generation_job_id, 180),
    state: status || "unknown",
    generationJobStatus: safeText(row.generation_job_status, 80),
    title: safeText(row.title || generatedTask.title || row.ref_title, 240),
    description: safeText(row.description || generatedTask.description || row.project_need_summary, 1600),
    steps,
    submissionRequirement,
    rewardOfferPft: rewardOffer,
    rewardActualPft: rewardActual,
    rewardSummary,
    stopSummary,
    verificationAsk,
    projectNeedSummary: safeText(row.project_need_summary || networkTask.projectNeedSummary || networkTask.project_need_summary, 1000),
    routingReason: safeText(row.allocation_reason_summary || networkTask.routingReason || networkTask.routing_reason, 1000),
    candidateAccountId: safeText(row.candidate_account_id, 180),
    candidateWalletAddress: safeText(row.candidate_wallet_address || row.assignee_wallet || row.subject_wallet, 120),
    updatedAt: toIso(row.updated_at || row.ref_updated_at || row.job_updated_at || row.allocation_updated_at),
    createdAt: toIso(row.created_at || row.ref_created_at || row.job_created_at || row.allocation_created_at),
  };
}

export function isCompletedNetworkTask(task = {}) {
  return task.state === "rewarded";
}

export function isOutstandingNetworkTask(task = {}) {
  return [
    "candidate",
    "queued",
    "running",
    "generated",
    "link_failed",
    "proposed",
    "accepted",
    "submitted",
    "verification_requested",
    "verification_response_submitted",
    "reward_decided",
  ].includes(task.state);
}

function networkTaskLine(task = {}) {
  const lines = [`- ${task.title || task.taskId || task.requestId || "Untitled Network Task"}`, `  State: ${task.state || "unknown"}`];
  if (task.projectId) lines.push(`  Project: ${task.projectId}`);
  if (task.taskId) lines.push(`  Task ID: ${task.taskId}`);
  if (task.requestId) lines.push(`  Request ID: ${task.requestId}`);
  if (task.description) lines.push(`  Description: ${truncateWithEllipsis(task.description, 520)}`);
  if (task.steps?.length) lines.push(`  Steps: ${task.steps.map((step) => truncateWithEllipsis(step, 180)).join(" | ")}`);
  if (task.submissionRequirement) lines.push(`  Submission: ${truncateWithEllipsis(task.submissionRequirement, 360)}`);
  if (task.rewardActualPft > 0) lines.push(`  Reward: ${task.rewardActualPft} PFT paid`);
  else if (task.rewardOfferPft > 0) lines.push(`  Reward: ${task.rewardOfferPft} PFT offered`);
  if (task.rewardSummary) lines.push(`  Outcome: ${truncateWithEllipsis(task.rewardSummary, 520)}`);
  if (task.stopSummary) lines.push(`  Close reason: ${truncateWithEllipsis(task.stopSummary, 360)}`);
  if (task.verificationAsk && task.state === "verification_requested") {
    lines.push(`  Current verification ask: ${truncateWithEllipsis(task.verificationAsk, 360)}`);
  }
  if (task.projectNeedSummary && !task.description) lines.push(`  Project need: ${truncateWithEllipsis(task.projectNeedSummary, 420)}`);
  if (task.updatedAt) lines.push(`  Updated: ${task.updatedAt}`);
  return lines.join("\n");
}

export function groupNetworkTaskContentText(title = "", tasks = []) {
  return [`${title} (${tasks.length})`, tasks.length ? tasks.map(networkTaskLine).join("\n") : "None"].join("\n");
}
