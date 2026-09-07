import { query } from "./db/pool.js";
import { assertBoardAgentScope } from "./board-agent-context.js";
import { boardForTask } from "./repositories/bm-decisions.js";
import { boardTaskStaleness } from "./board-task-policy.js";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const textPresent = (value) => typeof value === "string" && value.trim().length > 0;

export function hasReadableEvidence(payload) {
  const source = object(payload);
  const evidence = object(source.evidence || source.submission || source.response);
  const items = [...(Array.isArray(source.evidence_items) ? source.evidence_items : []),
    ...(Array.isArray(evidence.evidence_items) ? evidence.evidence_items : []),
    ...(Array.isArray(evidence.items) ? evidence.items : []), source, evidence];
  return items.some((item) => {
    const entry = object(item), file = object(entry.file);
    return [entry.value, entry.text, entry.evidence_text, entry.response_text, entry.submission_text,
      entry.summary, entry.public_summary, entry.response_summary, entry.url, entry.notes,
      file.text, file.description].some(textPresent);
  });
}

export async function boardTaskDetail(taskId) {
  const boardId = await boardForTask(taskId);
  if (!boardId) throw Object.assign(new Error("board_task_not_found"), { status: 404 });
  assertBoardAgentScope(boardId);
  const found = await query(`SELECT task_id,account_id,subject_wallet,status,title,description,
    submission_type,submission_requirement_text,reward_offer_pft,reward_actual_pft,created_at,last_event_at,
    (SELECT max(e.occurred_at) FROM task_events e WHERE e.task_id=task_projections.task_id
      AND e.account_id=task_projections.account_id) AS last_contact_at
    FROM task_projections WHERE task_id=$1`, [taskId]);
  const task = found.rows[0];
  if (!task) throw Object.assign(new Error("board_task_not_found"), { status: 404 });
  const result = await query(`SELECT id,event_type,occurred_at,source_tx_hash,source_cid,payload_json
    FROM task_events WHERE task_id=$1 AND account_id=$2
      AND event_type=ANY($3::text[]) ORDER BY occurred_at DESC,id DESC LIMIT 201`,
  [taskId, task.account_id, ["pf.task.submission.v1", "pf.task.verification_response.v1", "pf.task.update.v1", "pf.reward.v1"]]);
  const rows = result.rows.slice(0, 200);
  const latest = (type) => rows.find((event) => event.event_type === type) || null;
  const submission = latest("pf.task.submission.v1");
  const verificationResponse = latest("pf.task.verification_response.v1");
  const submissionReadable = hasReadableEvidence(submission?.payload_json);
  const verificationReadable = hasReadableEvidence(verificationResponse?.payload_json);
  return {
    board_id: boardId,
    task,
    staleness: boardTaskStaleness({ ...task, has_submission: Boolean(submission || verificationResponse) }),
    submission,
    verification_response: verificationResponse,
    evidence_state: {
      submission: submissionReadable ? "available" : "unavailable",
      verification_response: verificationReadable ? "available" : "unavailable",
      review_ready: submissionReadable && verificationReadable,
    },
    events: rows.reverse(),
    history_truncated: result.rows.length > 200,
  };
}

export async function requireBoardEvidence(taskId, { review = false } = {}) {
  const detail = await boardTaskDetail(taskId);
  if (detail.evidence_state.submission !== "available" || (review && !detail.evidence_state.review_ready)) {
    throw Object.assign(new Error("board_task_evidence_unavailable: record this duty as blocked; missing evidence access must not become a rejection or another verification request"), { status: 409 });
  }
  return detail;
}
