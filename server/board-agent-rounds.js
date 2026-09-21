import { createHash, randomUUID } from "node:crypto";
import { query } from "./db/pool.js";
import { assertBoardAgentScope, boardAgentIdentity } from "./board-agent-context.js";
import { computeBoardDuties } from "../scripts/bm/lib.mjs";

export function dutyId(duty) {
  const identity = [duty.type, duty.board_id, duty.task_id || ""];
  if (duty.escalation_id) identity.push(duty.escalation_id);
  if (Array.isArray(duty.candidate_ids)) identity.push([...duty.candidate_ids].sort());
  if (duty.staleness) identity.push(duty.staleness.lastActivityAt, duty.staleness.cancellationEligible);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
}

export async function openAgentRound(boards, { computeDuties = computeBoardDuties } = {}) {
  boards.forEach(assertBoardAgentScope);
  const actor = boardAgentIdentity().actor;
  const pending = await query("SELECT * FROM board_agent_rounds WHERE actor=$1 AND state='pending' ORDER BY created_at LIMIT 1 FOR UPDATE", [actor]);
  if (pending.rows[0]) { pending.rows[0].board_ids.forEach(assertBoardAgentScope); return pending.rows[0]; }
  const snapshot = await computeDuties(boards);
  const duties = snapshot.duties.map((duty) => ({ ...duty, id: dutyId(duty) }));
  if (!duties.length) return { id: "", state: "quiet", duties_json: [], results_json: {} };
  const recent = await query("SELECT * FROM board_agent_rounds WHERE actor=$1 AND state='complete' AND completed_at>now()-interval '15 minutes' ORDER BY completed_at DESC LIMIT 1", [actor]);
  if (recent.rows[0] && JSON.stringify(recent.rows[0].duties_json.map((item) => item.id).sort()) === JSON.stringify(duties.map((item) => item.id).sort())) return { id: "", state: "backoff", duties_json: duties, results_json: {} };
  const result = await query(`INSERT INTO board_agent_rounds (id,actor,board_ids,duties_json,state,completed_at)
    VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,CASE WHEN $5='complete' THEN now() ELSE NULL END) RETURNING *`,
  [`round_${randomUUID()}`, actor, JSON.stringify(boards), JSON.stringify(duties), duties.length ? "pending" : "complete"]);
  return result.rows[0];
}

export async function readAgentRound(id) {
  const result = await query("SELECT * FROM board_agent_rounds WHERE id=$1 AND actor=$2", [id, boardAgentIdentity().actor]);
  if (!result.rows[0]) throw Object.assign(new Error("board_agent_round_not_found"), { status: 404 });
  result.rows[0].board_ids.forEach(assertBoardAgentScope);
  return result.rows[0];
}

export const DUTY_OUTCOMES = ["completed", "blocked", "deferred", "not_served"];
export const ROUTING_DISPOSITIONS = ["routed", "investigation_routed", "not_served"];
export const ROUTING_REASON_CODES = ["no_badge_fit", "source_unavailable", "budget_exhausted", "capacity_taken_this_round", "restricted_board", "contributor_declined_recently", "other"];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// A routing duty answers for every eligible candidate it was given. Prose alone
// cannot close it: each candidate is routed (backed by an executed task_create
// audit in this round) or carries a coded reason. Zero routed candidates is
// "not_served", never "completed".
export function validateRoutingDispositions(duty, raw) {
  const candidateIds = Array.isArray(duty.candidate_ids) ? duty.candidate_ids : [];
  let list = raw;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { throw bad("board_agent_dispositions_invalid_json"); } }
  if (list === undefined && !candidateIds.length) list = [];
  if (!Array.isArray(list)) throw bad(`board_agent_dispositions_required: routing_due needs --dispositions '[{"account_id":"…","disposition":"routed|investigation_routed|not_served","task_id":"…","reason_code":"${ROUTING_REASON_CODES.join("|")}","reason":"…"}]' covering every candidate: ${candidateIds.join(", ")}`);
  const seen = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object" || typeof item.account_id !== "string" || !candidateIds.includes(item.account_id)) throw bad(`board_agent_disposition_unknown_candidate:${item?.account_id || ""}`);
    if (seen.has(item.account_id)) throw bad(`board_agent_disposition_duplicate:${item.account_id}`);
    if (!ROUTING_DISPOSITIONS.includes(item.disposition)) throw bad(`board_agent_disposition_invalid:${item.account_id}`);
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (reason.length > 2000) throw bad(`board_agent_disposition_reason_too_long:${item.account_id}`);
    const entry = { account_id: item.account_id, disposition: item.disposition, reason };
    if (item.disposition === "not_served") {
      if (!ROUTING_REASON_CODES.includes(item.reason_code)) throw bad(`board_agent_disposition_reason_code_required:${item.account_id}:${ROUTING_REASON_CODES.join("|")}`);
      if (item.reason_code === "other" && reason.length < 40) throw bad(`board_agent_disposition_reason_too_short:${item.account_id}`);
      entry.reason_code = item.reason_code;
    } else {
      if (typeof item.task_id !== "string" || !item.task_id.trim()) throw bad(`board_agent_disposition_task_id_required:${item.account_id}`);
      entry.task_id = item.task_id.trim();
    }
    seen.set(item.account_id, entry);
  }
  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length) throw bad(`board_agent_dispositions_incomplete: missing ${missing.join(", ")}`);
  return [...seen.values()];
}

export function validateDutyResult(round, result) {
  const duty = round.duties_json.find((item) => item.id === result.dutyId);
  if (!duty || !DUTY_OUTCOMES.includes(result.outcome)) throw Object.assign(new Error("board_agent_duty_result_invalid"), { status: 400 });
  if (typeof result.reason !== "string" || result.reason.trim().length < 12 || result.reason.length > 8000) throw Object.assign(new Error("board_agent_duty_reason_required"), { status: 400 });
  if (result.outcome === "not_served" && duty.type !== "routing_due") throw bad("board_agent_not_served_only_for_routing");
  return duty;
}

export function routingOutcome(dispositions, reported) {
  const routed = dispositions.filter((item) => item.disposition !== "not_served");
  if (!routed.length) {
    if (reported === "completed") throw Object.assign(new Error("board_agent_routing_not_completed: no candidate was routed; record not_served with a reason_code per candidate"), { status: 409 });
    return dispositions.length ? "not_served" : reported;
  }
  return reported === "completed" ? "completed" : reported;
}

export async function recordDutyResult(input, { computeDuties = computeBoardDuties } = {}) {
  const round = await readAgentRound(input.roundId);
  const duty = validateDutyResult(round, input);
  if (round.state !== "pending") return round;
  let outcome = input.outcome;
  let dispositions = null;
  if (duty.type === "routing_due") {
    dispositions = validateRoutingDispositions(duty, input.dispositions);
    outcome = routingOutcome(dispositions, input.outcome);
    // Every routed candidate needs an executed task_create audit for that
    // account from this actor in this round. Prose never proves an assignment.
    for (const item of dispositions.filter((entry) => entry.disposition !== "not_served")) {
      const proof = await query(`SELECT id FROM bm_audit_log WHERE actor=$1 AND board_id=$2
        AND created_at >= $3 AND command='task_create' AND result_json->>'executed'='true' AND args_json->>'accountId'=$4
        ORDER BY created_at DESC LIMIT 1`, [round.actor, duty.board_id, round.created_at, item.account_id]);
      if (!proof.rows.length) throw Object.assign(new Error(`board_agent_routing_unproven:${item.account_id}: no executed task_create audit for this account in this round`), { status: 409 });
    }
  } else if (input.outcome === "completed") {
    const current = await computeDuties(round.board_ids);
    if (current.duties.some((item) => dutyId(item) === duty.id)) throw Object.assign(new Error("board_agent_duty_not_completed"), { status: 409 });
  }
  const entry = { outcome, reason: input.reason.trim(), recordedAt: new Date().toISOString() };
  if (dispositions) {
    entry.reported_outcome = input.outcome;
    entry.dispositions = dispositions;
    entry.routed_count = dispositions.filter((item) => item.disposition !== "not_served").length;
    entry.not_served_count = dispositions.length - entry.routed_count;
  }
  const results = { ...round.results_json, [duty.id]: entry };
  const complete = round.duties_json.every((item) => Boolean(results[item.id]));
  const row = await query(`UPDATE board_agent_rounds SET results_json=$2::jsonb,state=$3,
    completed_at=CASE WHEN $3='complete' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
  [round.id, JSON.stringify(results), complete ? "complete" : "pending"]);
  return row.rows[0];
}
