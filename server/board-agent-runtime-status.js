import { randomUUID } from "node:crypto";
import { query } from "./db/pool.js";
import { boardAgentIdentity } from "./board-agent-context.js";
import { readAgentRound } from "./board-agent-rounds.js";

export async function publishAgentRuntimeStatus({ state, roundId = "" }) {
  if (!["ready", "busy", "unavailable"].includes(state)) throw Object.assign(new Error("board_agent_runtime_state_invalid"), { status: 400 });
  const identity = boardAgentIdentity();
  const round = roundId ? await readAgentRound(roundId) : null;
  for (const board of identity.boards) {
    const lines = [`Kimi K3 · ${identity.actor}`, `Board: ${board}`, `Terminal: ${state}`];
    if (round) {
      lines.push(`Round: ${round.id} (${round.state})`);
      for (const duty of round.duties_json.filter((item) => item.board_id === board)) {
        lines.push(`${duty.type}${duty.task_id ? ` ${duty.task_id}` : ""}: ${round.results_json[duty.id]?.outcome || "pending"}`);
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
  return { ok: true, boards: identity.boards.length, state };
}
