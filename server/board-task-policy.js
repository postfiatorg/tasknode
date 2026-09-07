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

export function routingDuty(board, contributors, openCount) {
  const candidates = boardRoutingCandidates(board, contributors);
  if (!candidates.length) return null;
  return {
    priority: 4,
    type: "routing_due",
    board_id: board.id,
    candidate_ids: candidates.map((member) => member.account_id).sort(),
    candidates,
    open_count: openCount,
    detail: `${candidates.length} eligible contributor(s) have free capacity. This board has ${openCount} proposed or accepted tasks; there is no fixed three-task board ceiling. Review the listed contributors and route grounded, badge-matched work using the board sources. Check current per-account capacity, board assignment restrictions, and reward budgets before each assignment. If a contributor cannot be served, record the specific reason; do not report quiet while eligible contributors remain. Candidates: ${candidates.map((member) => `${member.account_id} @${member.public_handle || "unknown"} badges=${member.badges.join("/")} free_slots=${member.free_slots} wallet=${member.delivery_wallet}`).join("; ")}.`,
  };
}
