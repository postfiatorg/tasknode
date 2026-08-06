import { databaseEnabled, query } from "./db/pool.js";
import { DETERMINISTIC_BOARD_IDS, isDeterministicBoardId } from "./board-config.js";

// Public read-only view of board-manager terminal transcripts (Gate F).
// Hive Brain renders this stream; it is the network's audit view of each
// board agent's reasoning. Rows are secret-scrubbed at ingest.
export async function handleBmTranscriptRoute({ json, req, res, url }) {
  if (url.pathname !== "/api/hive/bm-transcript" || req.method !== "GET") return false;
  if (!databaseEnabled()) {
    json(res, 503, { ok: false, error: "database_not_configured" });
    return true;
  }
  const boardId = String(url.searchParams.get("board") || "").trim();
  if (!isDeterministicBoardId(boardId)) {
    json(res, 400, { ok: false, error: "unknown_board", boards: DETERMINISTIC_BOARD_IDS });
    return true;
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 1)));
  const result = await query(
    `SELECT id, board_id, session_name, seq, content, captured_at
     FROM board_manager_transcripts
     WHERE board_id = $1
     ORDER BY seq DESC
     LIMIT $2`,
    [boardId, limit]
  );
  json(res, 200, { ok: true, boardId, snapshots: result.rows });
  return true;
}
