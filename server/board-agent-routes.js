import { createHash } from "node:crypto";
import { query, transactionCommand } from "./db/pool.js";
import { validateJsonDocument } from "./request-validation.js";
import { withBoardAgent } from "./board-agent-context.js";
import { dispatchBoardAgent } from "./board-agent-dispatch.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function executeBoardAgentCommand({ token, payload }, { dispatch = dispatchBoardAgent } = {}) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) throw Object.assign(new Error("board_agent_credential_required"), { status: 401 });
  validateJsonDocument(payload, { allowUnknown: false, required: ["requestKey", "argv"], properties: {
    requestKey: { type: "string", minLength: 1, maxLength: 180 },
    argv: { type: "array", maxItems: 80, items: { type: "string", maxLength: 32_000 } },
  } });
  const credential = await query(`SELECT id,actor,board_ids FROM board_agent_credentials
    WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [digest(token)]);
  const row = credential.rows[0];
  if (!row) throw Object.assign(new Error("board_agent_credential_invalid"), { status: 401 });
  const context = { actor: row.actor, boards: row.board_ids, credentialId: row.id };
  if (["boards", "board", "digest", "history", "duties", "hive-inbox", "user", "round-status"].includes(payload.argv[0]) ||
      (payload.argv[0] === "task" && payload.argv[1] === "detail")) {
    return { ok: true, result: await withBoardAgent(context, () => dispatch(payload.argv)) };
  }
  const inputDigest = digest(JSON.stringify(payload.argv));
  return transactionCommand(async () => withBoardAgent({ actor: row.actor, boards: row.board_ids, credentialId: row.id }, async () => {
    // Serializes the actor's commands, including opening or acknowledging a round.
    // Nested domain writes and the immutable receipt share this transaction.
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`board-agent:${row.actor}`]);
    const inserted = await query(`INSERT INTO board_agent_commands (credential_id,request_key,input_digest,command)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING request_key`, [row.id, payload.requestKey, inputDigest, payload.argv[0] || ""]);
    if (!inserted.rows.length) {
      const receipt = await query("SELECT input_digest,result_json FROM board_agent_commands WHERE credential_id=$1 AND request_key=$2", [row.id, payload.requestKey]);
      if (receipt.rows[0]?.input_digest !== inputDigest) throw Object.assign(new Error("board_agent_command_conflict"), { status: 409 });
      return { ok: true, replayed: true, result: receipt.rows[0].result_json };
    }
    const result = await dispatch(payload.argv);
    await query("UPDATE board_agent_commands SET result_json=$3::jsonb,completed_at=now() WHERE credential_id=$1 AND request_key=$2", [row.id, payload.requestKey, JSON.stringify(result ?? null)]);
    return { ok: true, replayed: false, result };
  }));
}

export async function handleBoardAgentRoute({ req, res, url, readJson, json }) {
  if (url.pathname !== "/api/agent/board/command") return false;
  if (req.method !== "POST") { json(res, 405, { ok: false, error: "method_not_allowed" }); return true; }
  const authorization = String(req.headers.authorization || "").trim();
  const space = authorization.indexOf(" ");
  const token = authorization.slice(0, space).toLowerCase() === "bearer" ? authorization.slice(space + 1).trim() : "";
  try {
    const result = await executeBoardAgentCommand({ token, payload: await readJson(req, 128 * 1024) });
    json(res, 200, result);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error("board_agent_command_failed", { error: error.message });
    json(res, status, { ok: false, error: status >= 500 ? "board_agent_command_failed" : error.message, message: status >= 500 ? "The command did not commit. Retry with its saved request key." : error.message });
  }
  return true;
}
