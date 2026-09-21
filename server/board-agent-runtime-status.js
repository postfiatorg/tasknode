import { randomUUID } from "node:crypto";
import { query } from "./db/pool.js";
import { boardAgentIdentity } from "./board-agent-context.js";
import { readAgentRound } from "./board-agent-rounds.js";
import { allocationHealthLines, readAllocationHealth } from "./allocation-health.js";
import { normalizeOperatorActions, sourceDescriptorsForBoard } from "./board-sources.js";

async function boardSourceKeys(boardId) {
  const row = (await query("SELECT metadata_json FROM network_projects WHERE id=$1", [boardId])).rows[0];
  return sourceDescriptorsForBoard(row || {}).filter((item) => !item.unresolved).map((item) => `${item.kind}:${item.reference}`);
}

const invalid = () => Object.assign(new Error("board_agent_runtime_state_invalid"), { status: 400 });

// Duties the supervisor has seen blocked/deferred in consecutive processed
// rounds. Validated shape only; the feed names the stalled task and phase so a
// processed round is never mistaken for a resolved task.
export function parseRecurringBlockers(raw = "") {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(parsed) || parsed.length > 50) throw invalid();
  return parsed.map((item) => {
    const text = (value, max = 180) => { if (value === undefined || value === "") return ""; if (typeof value !== "string" || value.length > max) throw invalid(); return value; };
    const rounds = Number(item?.rounds);
    if (!Number.isSafeInteger(rounds) || rounds < 1 || !text(item.type) || !text(item.board_id)) throw invalid();
    const unserved = item.unserved === undefined ? 0 : Number(item.unserved);
    if (!Number.isSafeInteger(unserved) || unserved < 0) throw invalid();
    return { type: text(item.type), board_id: text(item.board_id), task_id: text(item.task_id), rounds, unserved, reason_code: text(item.reason_code, 60) };
  });
}

export async function publishAgentRuntimeStatus({ state, roundId = "", attempts = 0, nextRetryAt = "", recurring = "" }) {
  if (!["ready", "busy", "unavailable", "cooldown"].includes(state) || !Number.isSafeInteger(attempts) || attempts < 0 ||
      (nextRetryAt && !Number.isFinite(Date.parse(nextRetryAt)))) throw invalid();
  const stalled = parseRecurringBlockers(recurring);
  const identity = boardAgentIdentity();
  const round = roundId ? await readAgentRound(roundId) : null;
  let health = null;
  try { health = await readAllocationHealth({ boardIds: identity.boards }); } catch (error) { health = { error: error.message }; }
  for (const board of identity.boards) {
    const lines = [`Kimi K3 · ${identity.actor}`, `Board: ${board}`, `Terminal: ${state}`];
    if (health?.aggregate) lines.push(...allocationHealthLines(health, board));
    const boardRow = (await query("SELECT metadata_json->'operator_actions' AS actions FROM network_projects WHERE id=$1", [board])).rows[0];
    const openActions = normalizeOperatorActions(boardRow?.actions).filter((item) => !item.resolved_at);
    if (openActions.length) lines.push(`Operator actions open: ${openActions.map((item) => `${item.id} (${item.owner}, since ${item.since ? String(item.since).slice(0, 10) : "?"}) ${item.description.slice(0, 120)}`).join(" | ")}`);
    const sourceRows = (await query("SELECT source_key,status,fetched_at,error FROM board_source_snapshots WHERE source_key = ANY($1::text[])", [await boardSourceKeys(board)])).rows;
    const degraded = sourceRows.filter((row) => row.status !== "fresh");
    if (degraded.length) lines.push(`Sources degraded: ${degraded.map((row) => `${row.source_key}=${row.status}${row.error ? ` (${String(row.error).slice(0, 80)})` : ""}`).join(", ")}`);
    if (attempts >= 3) lines.push(`Recovery: ${attempts} deliveries without durable progress; next ready-terminal probe ${nextRetryAt || "pending"}`);
    const boardStalled = stalled.filter((item) => item.board_id === board && item.type !== "routing_due");
    const routingStalled = stalled.find((item) => item.board_id === board && item.type === "routing_due");
    if (boardStalled.length) lines.push(`Stalled: ${boardStalled.length} dut${boardStalled.length === 1 ? "y" : "ies"} blocked across consecutive rounds without task progress; escalated to the manager and ALERTS.log`);
    if (routingStalled) lines.push(`Routing stalled: ${routingStalled.unserved} eligible contributor(s) unserved for ${routingStalled.rounds} consecutive rounds${routingStalled.reason_code ? ` (${routingStalled.reason_code})` : ""}; escalated`);
    if (round) {
      lines.push(`Round: ${round.id} (${round.state})`);
      for (const duty of round.duties_json.filter((item) => item.board_id === board)) {
        const stall = boardStalled.find((item) => item.type === duty.type && item.task_id === (duty.task_id || ""));
        lines.push(`${duty.type}${duty.task_id ? ` ${duty.task_id}` : ""}: ${round.results_json[duty.id]?.outcome || "pending"}${stall ? ` (no progress for ${stall.rounds} rounds)` : ""}`);
      }
    }
    // Publish an explicit operational projection. Raw panes, tool responses and
    // secret-shaped text are never inputs to this public feed.
    const content = lines.join("\n");
    const previous = await query("SELECT content FROM board_manager_transcripts WHERE board_id=$1 ORDER BY seq DESC LIMIT 1", [board]);
    if (previous.rows[0]?.content === content) continue;
    await query(`INSERT INTO board_manager_transcripts(id,board_id,session_name,seq,content)
      VALUES($1,$2,$3,(SELECT coalesce(max(seq),0)+1 FROM board_manager_transcripts WHERE board_id=$2),$4)`, [`bmt_${randomUUID()}`, board, identity.actor, content]);
    await query("DELETE FROM board_manager_transcripts WHERE board_id=$1 AND seq<(SELECT coalesce(max(seq),0)-2000 FROM board_manager_transcripts WHERE board_id=$1)", [board]);
  }
  return { ok: true, boards: identity.boards.length, state, allocation_health: health?.aggregate ? { observedAt: health.observedAt, aggregate: health.aggregate, evaluation: health.evaluation, boards: health.boards } : null };
}
