import { query, transactionCommand, closePool } from "/app/server/db/pool.js";
import { idleEligibleContributors, computeBoardDuties } from "/app/scripts/bm/lib.mjs";
import { boardRoutingCandidates } from "/app/server/board-task-policy.js";
import { createHash } from "node:crypto";
const alias = id => "contributor_" + createHash("sha256").update("hive-audit-20260919:" + id).digest("hex").slice(0, 10);
try {
  const result = await transactionCommand(async () => {
    await query("SET TRANSACTION READ ONLY");
    const idle = await idleEligibleContributors();
    const boards = (await query("SELECT id,status,metadata_json FROM network_projects WHERE id=ANY($1::text[])", [["board_pf_terminal", "board_community_promotion", "board_postfiat_l1v2", "board_ai_l1_governance", "board_tasknode_fixes", "board_capital_markets"]])).rows;
    const duties = await computeBoardDuties(boards.map(b => b.id), { idleContributors: async () => idle });
    return {
      observedAt: new Date().toISOString(), readOnly: true,
      surfacedCandidateCount: idle.length,
      contributors: idle.map(m => ({ contributor: alias(m.account_id), freeSlots: m.free_slots, badges: m.badges })),
      boardCandidates: boards.map(b => ({ boardId: b.id, status: b.status, surfacedAllowed: boardRoutingCandidates(b, idle).length })),
      duties: duties.duties.map(d => ({ boardId: d.board_id, type: d.type, taskId: d.task_id || "", candidateCount: d.candidate_ids?.length || 0, staleness: d.staleness })),
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closePool(); }
