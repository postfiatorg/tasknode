import { timingSafeEqual } from "node:crypto";

import { query, databaseEnabled } from "./db/pool.js";
import {
  BOARD_ADMIN_MUTABLE_FIELDS,
  DETERMINISTIC_BOARD_IDS,
  isDeterministicBoardId,
} from "./board-config.js";

const allowedStatuses = new Set(["active", "paused", "completed", "archived"]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeEqualText(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(header = "") {
  const text = safeText(header, 2000);
  return text.toLowerCase().startsWith("bearer ") ? text.slice("bearer ".length).trim() : "";
}

export function boardAdminAuthorized(req, env = process.env) {
  const expected = env.TASKNODE_BOARD_ADMIN_TOKEN || "";
  if (!expected) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "board_admin_not_configured",
        message: "Board admin writes require TASKNODE_BOARD_ADMIN_TOKEN.",
      },
    };
  }
  const actual = bearerToken(req.headers.authorization || "");
  if (!actual || !safeEqualText(actual, expected)) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "board_admin_unauthorized",
        message: "Board admin writes require an authorized operator bearer token.",
      },
    };
  }
  return { ok: true };
}

export function normalizeBoardAdminUpdate(payload = {}) {
  const input = safeObject(payload);
  const boardId = safeText(input.boardId || input.board_id || input.id, 120);
  if (!isDeterministicBoardId(boardId)) {
    return { ok: false, error: "board_admin_unknown_board", boards: DETERMINISTIC_BOARD_IDS };
  }
  const fields = {};
  for (const field of BOARD_ADMIN_MUTABLE_FIELDS) {
    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = input[field] !== undefined ? input[field] : input[camel];
    if (value === undefined) continue;
    if (field === "status") {
      const status = safeText(value, 40);
      if (!allowedStatuses.has(status)) return { ok: false, error: "board_admin_invalid_status" };
      fields[field] = status;
    } else if (field === "priority" || field === "phase_current" || field === "phase_total") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { ok: false, error: `board_admin_invalid_${field}` };
      fields[field] = Math.max(0, Math.round(parsed));
    } else {
      fields[field] = safeText(value, field === "about" ? 8000 : 2000);
    }
  }
  const metadataPatch = safeObject(input.metadataPatch || input.metadata_patch);
  if (!Object.keys(fields).length && !Object.keys(metadataPatch).length) {
    return { ok: false, error: "board_admin_no_fields", allowed: BOARD_ADMIN_MUTABLE_FIELDS };
  }
  return { ok: true, boardId, fields, metadataPatch };
}

async function applyBoardAdminUpdate({ boardId, fields, metadataPatch, actor = "" }) {
  const sets = [];
  const values = [boardId];
  for (const [field, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }
  values.push(
    JSON.stringify({
      ...metadataPatch,
      board_admin_updated_at: new Date().toISOString(),
      board_admin_updated_by: safeText(actor, 180) || "operator",
    })
  );
  sets.push(`metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $${values.length}::jsonb`);
  sets.push("updated_at = now()");
  const result = await query(
    `UPDATE network_projects SET ${sets.join(", ")} WHERE id = $1
     RETURNING id, type, title, summary, status, priority, phase_label, updated_at`,
    values
  );
  return result.rows[0] || null;
}

export async function handleBoardAdminRoute({ json, readJson, req, res, url }) {
  if (url.pathname === "/api/boards/admin/list" && req.method === "GET") {
    const auth = boardAdminAuthorized(req);
    if (!auth.ok) {
      json(res, auth.status, auth.body);
      return true;
    }
    if (!databaseEnabled()) {
      json(res, 503, { ok: false, error: "database_not_configured" });
      return true;
    }
    const result = await query(
      `SELECT id, type, title, summary, status, priority, phase_label, updated_at
       FROM network_projects WHERE id = ANY($1) ORDER BY priority`,
      [[...DETERMINISTIC_BOARD_IDS]]
    );
    json(res, 200, { ok: true, boards: result.rows });
    return true;
  }

  if (url.pathname === "/api/boards/admin/update" && req.method === "POST") {
    const auth = boardAdminAuthorized(req);
    if (!auth.ok) {
      json(res, auth.status, auth.body);
      return true;
    }
    if (!databaseEnabled()) {
      json(res, 503, { ok: false, error: "database_not_configured" });
      return true;
    }
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      json(res, 400, { ok: false, error: "board_admin_invalid_json" });
      return true;
    }
    const normalized = normalizeBoardAdminUpdate(payload);
    if (!normalized.ok) {
      json(res, 400, { ok: false, ...normalized });
      return true;
    }
    const row = await applyBoardAdminUpdate({
      ...normalized,
      actor: safeText(safeObject(payload).actor, 180),
    });
    if (!row) {
      json(res, 404, { ok: false, error: "board_admin_board_not_found" });
      return true;
    }
    json(res, 200, { ok: true, board: row });
    return true;
  }

  return false;
}
