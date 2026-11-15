import { boardOpenForNewWork, boardWorkPolicy } from "./board-work-policy.js";

const dayMs = 24 * 60 * 60 * 1000;

// Existing manager policy, shared by scheduling and guarded cancellation.
export function boardTaskStaleness(task, now = Date.now()) {
  const timestamps = [task.created_at, task.last_event_at, task.last_contact_at]
    .map((value) => value ? new Date(value).getTime() : NaN)
    .filter(Number.isFinite);
  const lastActivity = timestamps.length ? Math.max(...timestamps) : NaN;
  const ageDays = Number.isFinite(lastActivity) ? Math.max(0, (now - lastActivity) / dayMs) : 0;
  const status = String(task.status || "").toLowerCase();
  const hasSubmission = Boolean(task.has_submission);
  const cancellationEligible = !hasSubmission && (
    (status === "proposed" && ageDays >= 7) ||
    (status === "accepted" && ageDays >= 14)
  );
  const followUp = (status === "proposed" && ageDays >= 7) ||
    (status === "accepted" && ageDays >= 7) ||
    (status === "verification_requested" && ageDays >= 3);
  return {
    lastActivityAt: Number.isFinite(lastActivity) ? new Date(lastActivity).toISOString() : null,
    ageDays: Math.floor(ageDays),
    cancellationEligible,
    followUp,
  };
}

export function boardRoutingCandidates(board, contributors) {
  const constraints = board.metadata_json?.routing_constraints || board.routing_constraints || {};
  const handles = Array.isArray(constraints.assignable_handles)
    ? constraints.assignable_handles.map((handle) => String(handle).trim().toLowerCase())
    : [];
  return contributors.filter((member) => member.engine_verdict === "eligible" && member.free_slots > 0 &&
    (!handles.length || handles.includes(String(member.public_handle || "").toLowerCase())));
}

// An invitation, not an obligation. Idle contributors are not a defect and an
// empty board is a normal state: the manager routes only when it can name real
// work inside the board's scope, and otherwise defers. Closed boards and
// operator-issued boards never get one.
export function routingDuty(board, contributors, openCount) {
  const constraints = board.metadata_json?.routing_constraints || board.routing_constraints || {};
  if (constraints.routing_disabled === true) return null;
  if (!boardOpenForNewWork(board.id)) return null;
  const candidates = boardRoutingCandidates(board, contributors);
  if (!candidates.length) return null;
  const scope = boardWorkPolicy(board.id)?.workTypes || [];
  return {
    priority: 4,
    type: "routing_due",
    board_id: board.id,
    candidate_ids: candidates.map((member) => member.account_id).sort(),
    candidates,
    open_count: openCount,
    detail: `${candidates.length} contributor(s) have free capacity and this board has ${openCount} proposed or accepted tasks. Route a task only if you can name specific work inside this board's scope${scope.length ? ` (work types: ${scope.join(", ")})` : ""} that moves Task Node, NAVCoins, goodalexander or the L1. If there is none, record the duty as deferred. Never create a task to keep someone busy.`,
  };
}
