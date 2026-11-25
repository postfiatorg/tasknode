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

// Work comes from the Wanted list (operator decision, 2026-11-25).
//
// Every open item on an open board is a duty: hand it to the best-fit
// contributor with a free slot, or record why it cannot be routed. "Nothing to
// do" is not an answer while the list has open items. The item's preferred
// owner, when set, is offered first. An item refused twice must be rewritten
// or dropped before it is offered again.
export async function wantedDuties(board, contributors, { queryImpl, listItems } = {}) {
  if (!board) return [];
  const constraints = board.metadata_json?.routing_constraints || board.routing_constraints || {};
  if (constraints.routing_disabled === true || !boardOpenForNewWork(board.id)) return [];
  const list = listItems || (await import("./board-wanted.js")).listWantedItems;
  const items = await list([board.id], queryImpl ? { queryImpl } : {});
  const candidates = boardRoutingCandidates(board, contributors);
  const scope = boardWorkPolicy(board.id)?.workTypes || [];
  const duties = [];
  for (const item of items) {
    if (item.state === "rewrite") {
      duties.push({
        priority: 3,
        type: "wanted_rewrite",
        board_id: board.id,
        wanted_id: item.id,
        detail: `Wanted item ${item.id} "${item.title}" was refused or cancelled ${item.refusals} times. Work out why from the refusals, then rewrite it (bm wanted edit ${item.id} --title/--why/--source/--reward) or drop it (bm wanted drop ${item.id} --reason "..."). Completed when it is rewritten or dropped.`,
      });
      continue;
    }
    if (item.state !== "open" || !candidates.length) continue;
    const preferred = item.preferredAccountId ? candidates.find((member) => member.account_id === item.preferredAccountId) : null;
    const ordered = preferred ? [preferred, ...candidates.filter((member) => member !== preferred)] : candidates;
    duties.push({
      priority: 2,
      type: "wanted_open",
      board_id: board.id,
      wanted_id: item.id,
      candidate_ids: ordered.map((member) => member.account_id),
      candidates: ordered.map((member) => ({
        account_id: member.account_id,
        public_handle: member.public_handle || "",
        badges: member.badges || [],
        delivery_wallet: member.delivery_wallet || "",
        rewarded_tasks: member.rewarded_tasks || 0,
        free_slots: member.free_slots,
      })),
      detail: [
        `Wanted item ${item.id}: "${item.title}". Why: ${item.why} Source: ${item.sourceUrl}.`,
        preferred
          ? `Preferred owner: ${preferred.public_handle || preferred.account_id} (${preferred.account_id}, wallet ${preferred.delivery_wallet}). Give it to them.`
          : item.preferredAccountId
            ? `Its preferred owner ${item.preferredAccountId} has no free slot this round; pick the best other fit.`
            : `Pick the one contributor whose badges and track record fit it best.`,
        `Create its task: bm task create ${board.id} --wanted ${item.id} --account <id> --wallet <wallet> --need "<one or two plain sentences on what to do and the exact proof>"${item.workType ? ` --work-type ${item.workType}` : scope.length ? ` --work-type <one of ${scope.join(", ")}>` : ""}${item.rewardPft ? ` --reward-max ${item.rewardPft}` : ""} --execute.`,
        `Record completed once the task is created. If it truly cannot be routed now, record blocked with the specific reason. Deferring is not allowed.`,
      ].join(" "),
    });
  }
  return duties;
}
