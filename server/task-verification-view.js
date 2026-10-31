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

export function currentVerificationRequest(timeline = []) {
  const rows = Array.isArray(timeline) ? timeline : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index];
    const payload = safeObject(event?.rawPayload);
    const transition = safeText(payload.transition || payload.status, 80);
    const isVerificationRequest =
      event?.schema === "pf.task.verification_request.v1" ||
      (event?.schema === "pf.task.update.v1" && transition === "verification_requested");
    if (!isVerificationRequest) continue;
    const request = safeObject(payload.verification_request);
    const ask = safeText(payload.verification_ask || request.verification_ask || request.ask, 4000);
    if (!ask) return null;
    return {
      ask,
      body: ask,
      type: safeText(payload.verification_type || request.verification_type, 120),
      assessment: safeText(request.assessment || payload.assessment, 120),
      reason: safeText(payload.reason || request.reason, 1000),
      eventId: safeText(payload.event_id, 180),
      createdAt: toIso(payload.created_at),
    };
  }
  return null;
}

const DEFAULT_VERIFICATION_REQUEST_STALL_SECONDS = 3600;
const STALLED_FAILURE_COUNT = 3;
const AWAITING_AGENT_ERROR = "awaiting_agent_verification_request";

function errorCode(error = "") {
  if (!error) return "";
  return /^[a-z0-9_]{1,120}$/.test(error) ? error : "verification_request_failed";
}

export function verificationRequestStallSeconds(env = process.env) {
  const parsed = Number(env.TASKNODE_VERIFICATION_REQUEST_STALL_SECONDS || DEFAULT_VERIFICATION_REQUEST_STALL_SECONDS);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_VERIFICATION_REQUEST_STALL_SECONDS, 300), 7 * 86_400);
}

// After initial evidence both evidence gates close and the verification
// request comes from a background worker that retries failures indefinitely.
// Without this, a failing or waiting worker looked the same as a request that
// was about to appear: `currentVerificationRequest` empty and no action (#347).
// Only error codes are exposed; provider error text stays in worker metadata.
export function verificationRequestStatus({
  status = "",
  submittedAt = null,
  worker = {},
  nowMs = Date.now(),
  stallSeconds = verificationRequestStallSeconds(),
} = {}) {
  if (safeText(status, 80) !== "submitted") return null;
  const state = safeObject(worker);
  const lastError = safeText(state.last_error, 1000);
  const awaitingAgent = lastError === AWAITING_AGENT_ERROR;
  const failureCount = Math.max(0, Number(state.retry_count) || 0);
  const submittedMs = Date.parse(toIso(submittedAt) || "");
  const overdue = Number.isFinite(submittedMs) && nowMs - submittedMs > stallSeconds * 1000;
  const phase = state.published === "true"
    ? "published"
    : state.processing === "true"
      ? "processing"
      : awaitingAgent
        ? "awaiting_agent"
        : lastError
          ? "retrying"
          : "queued";
  const stalled = phase !== "published" && (overdue || failureCount >= STALLED_FAILURE_COUNT);
  let message = "Task Node is generating the verification request for this submission.";
  if (phase === "published") {
    message = "The verification request was published and will appear once the task refreshes.";
  } else if (stalled) {
    message =
      "The verification request is overdue. The submitted evidence is recorded; do not resubmit or cancel the task. Report the task ID to Task Node operators if this persists.";
  } else if (phase === "awaiting_agent") {
    message = "This task is waiting for its board manager to write the verification request.";
  } else if (phase === "retrying") {
    message = "Generating the verification request failed and will be retried automatically.";
  }
  return {
    phase,
    stalled,
    failureCount,
    lastErrorCode: errorCode(phase === "published" || awaitingAgent ? "" : lastError),
    retryAfter: toIso(state.retry_after) || null,
    submittedAt: toIso(submittedAt),
    message,
  };
}
