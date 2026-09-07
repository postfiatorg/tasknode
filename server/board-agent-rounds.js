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

export function validateDutyResult(round, result) {
  const duty = round.duties_json.find((item) => item.id === result.dutyId);
  if (!duty || !["completed", "blocked", "deferred"].includes(result.outcome)) throw Object.assign(new Error("board_agent_duty_result_invalid"), { status: 400 });
  if (typeof result.reason !== "string" || result.reason.trim().length < 12 || result.reason.length > 8000) throw Object.assign(new Error("board_agent_duty_reason_required"), { status: 400 });
  return duty;
}

export async function recordDutyResult(input, { computeDuties = computeBoardDuties } = {}) {
  const round = await readAgentRound(input.roundId);
  const duty = validateDutyResult(round, input);
  if (round.state !== "pending") return round;
  if (input.outcome === "completed") {
    const current = await computeDuties(round.board_ids);
    const remains = current.duties.some((item) => duty.type === "routing_due"
      ? item.type === "routing_due" && item.board_id === duty.board_id
      : dutyId(item) === duty.id);
    if (remains) {
      // Routing can leave more capacity available. Require an actual successful
      // assignment from this actor/round; a journal entry never proves a duty.
      const proof = await query(`SELECT id FROM bm_audit_log WHERE actor=$1 AND board_id=$2
        AND created_at >= $3 AND command='task_create' AND result_json->>'executed'='true'
        ORDER BY created_at DESC LIMIT 1`, [round.actor, duty.board_id, round.created_at]);
      if (duty.type !== "routing_due" || !proof.rows.length) throw Object.assign(new Error("board_agent_duty_not_completed"), { status: 409 });
    }
  }
  const results = { ...round.results_json, [duty.id]: { outcome: input.outcome, reason: input.reason.trim(), recordedAt: new Date().toISOString() } };
  const complete = round.duties_json.every((item) => Boolean(results[item.id]));
  const row = await query(`UPDATE board_agent_rounds SET results_json=$2::jsonb,state=$3,
    completed_at=CASE WHEN $3='complete' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
  [round.id, JSON.stringify(results), complete ? "complete" : "pending"]);
  return row.rows[0];
}
