// The Wanted list (operator decision, 2026-11-25).
//
// Each board carries a list of specific things Post Fiat needs, each with a
// link to where the need came from. The board manager may only create a
// network task from an open Wanted item, and an item has at most one live
// task. An item's state is derived from the tasks created for it, so there is
// no second copy of task status to drift:
//
//   open         no live task; ready to hand out
//   in_progress  a task is being generated, offered, worked on or reviewed
//   done         a task for it was rewarded
//   rewrite      refused or cancelled twice since it was last revised; the
//                manager must rewrite it (wanted edit) or drop it
//   dropped      removed by the operator or the manager, with a reason
import { randomUUID } from "node:crypto";
import { query } from "./db/pool.js";

export const WANTED_REFUSALS_BEFORE_REWRITE = 2;

const LIVE_ALLOCATION = ["candidate", "queued", "proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted", "reward_decided"];
const LIVE_TASK = ["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted", "reward_decided"];
const STOPPED_TASK = ["refused", "rejected", "cancelled", "expired", "rerouted", "failed"];

const text = (value, max = 4000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const bad = (message, status = 422) => Object.assign(new Error(message), { status });

function validUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// One row per task attempt for each item: generation state, task state and owner.
async function attemptsFor(items, queryImpl) {
  const runIds = items.flatMap((item) => Array.isArray(item.run_ids) ? item.run_ids : []);
  if (!runIds.length) return new Map();
  const result = await queryImpl(
    `SELECT i.created_by_run_id AS run_id, i.created_at, a.allocation_status, a.generated_task_id AS task_id,
            a.candidate_account_id AS account_id, tp.status AS task_status, tp.title, tp.last_event_at
       FROM network_task_intents i
       LEFT JOIN network_task_allocations a ON a.id = i.allocation_id
       LEFT JOIN task_projections tp ON tp.task_id = a.generated_task_id AND a.generated_task_id <> ''
      WHERE i.created_by_run_id = ANY($1::text[])`,
    [runIds]
  );
  const byRun = new Map();
  for (const row of result.rows) byRun.set(row.run_id, row);
  return byRun;
}

export function wantedState(item = {}, attempts = []) {
  if (item.status === "dropped") return { state: "dropped", refusals: 0, liveTask: null, doneTask: null };
  const revisedAt = new Date(item.revised_at || item.created_at || 0).getTime();
  let liveTask = null;
  let doneTask = null;
  let refusals = 0;
  for (const attempt of attempts) {
    const taskStatus = String(attempt.task_status || "").toLowerCase();
    const allocation = String(attempt.allocation_status || "").toLowerCase();
    if (taskStatus === "rewarded" || allocation === "rewarded") { doneTask = attempt; continue; }
    if (LIVE_TASK.includes(taskStatus) || (!taskStatus && LIVE_ALLOCATION.includes(allocation))) { liveTask = attempt; continue; }
    if (STOPPED_TASK.includes(taskStatus) || STOPPED_TASK.includes(allocation)) {
      if (new Date(attempt.created_at || 0).getTime() >= revisedAt) refusals += 1;
    }
  }
  const state = doneTask ? "done" : liveTask ? "in_progress" : refusals >= WANTED_REFUSALS_BEFORE_REWRITE ? "rewrite" : "open";
  return { state, refusals, liveTask, doneTask };
}

function publicItem(item, attempts) {
  const derived = wantedState(item, attempts);
  const task = derived.liveTask || derived.doneTask;
  return {
    id: item.id,
    boardId: item.board_id,
    title: item.title,
    why: item.why,
    sourceUrl: item.source_url,
    workType: item.work_type,
    rewardPft: Number(item.reward_pft || 0),
    preferredAccountId: item.preferred_account_id || "",
    state: derived.state,
    refusals: derived.refusals,
    taskId: task?.task_id || "",
    taskStatus: task?.task_status || task?.allocation_status || "",
    ownerAccountId: task?.account_id || "",
    droppedReason: item.dropped_reason || "",
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export async function listWantedItems(boardIds = [], { includeDropped = false, queryImpl = query } = {}) {
  const ids = [...new Set((Array.isArray(boardIds) ? boardIds : [boardIds]).map((id) => text(id, 180)).filter(Boolean))];
  if (!ids.length) return [];
  const result = await queryImpl(
    `SELECT * FROM board_wanted_items
      WHERE board_id = ANY($1::text[]) ${includeDropped ? "" : "AND status <> 'dropped'"}
      ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  const byRun = await attemptsFor(result.rows, queryImpl);
  return result.rows.map((item) => publicItem(item, (item.run_ids || []).map((runId) => byRun.get(runId)).filter(Boolean)));
}

export async function getWantedItem(id, { queryImpl = query } = {}) {
  const result = await queryImpl(`SELECT * FROM board_wanted_items WHERE id = $1`, [text(id, 180)]);
  const item = result.rows[0];
  if (!item) return null;
  const byRun = await attemptsFor([item], queryImpl);
  return publicItem(item, (item.run_ids || []).map((runId) => byRun.get(runId)).filter(Boolean));
}

export async function addWantedItem({ boardId, title, why, sourceUrl, workType = "", rewardPft = 0, preferredAccountId = "", createdBy = "", id = "" }, { queryImpl = query } = {}) {
  if (!text(boardId, 180) || !text(title, 300) || !text(why)) throw bad("wanted_item_requires_board_title_why");
  if (!validUrl(sourceUrl)) throw bad("wanted_item_requires_source_link: every item links to where the need came from");
  const reward = Number(rewardPft) || 0;
  if (reward < 0) throw bad("wanted_item_reward_invalid");
  const result = await queryImpl(
    `INSERT INTO board_wanted_items (id, board_id, title, why, source_url, work_type, reward_pft, preferred_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [text(id, 180) || `wanted_${randomUUID().replace(/-/g, "").slice(0, 20)}`, text(boardId, 180), text(title, 300), text(why), String(sourceUrl).trim(), text(workType, 80), reward, text(preferredAccountId, 180), text(createdBy, 180)]
  );
  return result.rows[0] ? getWantedItem(result.rows[0].id, { queryImpl }) : null;
}

// A rewrite resets the refusal count: only refusals after the revision count.
export async function reviseWantedItem({ id, title = "", why = "", sourceUrl = "", workType = "", rewardPft, preferredAccountId }, { queryImpl = query } = {}) {
  if (sourceUrl && !validUrl(sourceUrl)) throw bad("wanted_item_requires_source_link");
  const result = await queryImpl(
    `UPDATE board_wanted_items
        SET title = COALESCE(NULLIF($2,''), title),
            why = COALESCE(NULLIF($3,''), why),
            source_url = COALESCE(NULLIF($4,''), source_url),
            work_type = COALESCE(NULLIF($5,''), work_type),
            reward_pft = COALESCE($6, reward_pft),
            preferred_account_id = COALESCE($7, preferred_account_id),
            revised_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [text(id, 180), text(title, 300), text(why), String(sourceUrl || "").trim(), text(workType, 80),
      rewardPft === undefined || rewardPft === "" ? null : Number(rewardPft), preferredAccountId === undefined ? null : text(preferredAccountId, 180)]
  );
  if (!result.rows[0]) throw bad("wanted_item_not_found_or_dropped", 404);
  return getWantedItem(id, { queryImpl });
}

export async function dropWantedItem({ id, reason }, { queryImpl = query } = {}) {
  if (text(reason).length < 8) throw bad("wanted_drop_requires_reason");
  const result = await queryImpl(
    `UPDATE board_wanted_items SET status = 'dropped', dropped_reason = $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [text(id, 180), text(reason, 1000)]
  );
  if (!result.rows[0]) throw bad("wanted_item_not_found", 404);
  return getWantedItem(id, { queryImpl });
}

// Called before a task is created: the item must be on this board and open.
export async function assertWantedItemOpen({ wantedId, boardId }, { queryImpl = query } = {}) {
  if (!text(wantedId, 180)) {
    throw bad("wanted_item_required: every network task comes from an open Wanted item. Pass --wanted <id> (see `bm wanted <board>`).");
  }
  const item = await getWantedItem(wantedId, { queryImpl });
  if (!item) throw bad(`wanted_item_not_found:${wantedId}`, 404);
  if (item.boardId !== boardId) throw bad(`wanted_item_on_other_board: ${wantedId} belongs to ${item.boardId}`);
  if (item.state === "in_progress") throw bad(`wanted_item_taken: ${wantedId} already has a live task (${item.taskId || "being generated"}); one item, one person`, 409);
  if (item.state === "done") throw bad(`wanted_item_done: ${wantedId} was already delivered`, 409);
  if (item.state === "dropped") throw bad(`wanted_item_dropped: ${wantedId}`, 409);
  if (item.state === "rewrite") throw bad(`wanted_item_needs_rewrite: ${wantedId} was refused ${item.refusals} times; rewrite it with \`bm wanted edit\` or drop it with \`bm wanted drop\` before routing it again`, 409);
  return item;
}

export async function attachWantedRun({ wantedId, runId }, { queryImpl = query } = {}) {
  if (!text(wantedId, 180) || !text(runId, 180)) return;
  await queryImpl(
    `UPDATE board_wanted_items
        SET run_ids = CASE WHEN run_ids ? $2 THEN run_ids ELSE run_ids || to_jsonb($2::text) END,
            updated_at = now()
      WHERE id = $1`,
    [text(wantedId, 180), text(runId, 180)]
  );
}

// The task text carries the reason it exists.
export function wantedTaskNeed(item, need = "") {
  const extra = text(need, 6000);
  return [
    `${item.title}.`,
    `Why this matters: ${item.why}`,
    `Source: ${item.sourceUrl}`,
    extra ? `Details: ${extra}` : "",
  ].filter(Boolean).join("\n");
}
