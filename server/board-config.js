// Deterministic board configuration.
//
// The six network boards are operator-defined, seeded by migration
// 098_deterministic_boards.sql, and mutable only by migration or the
// board admin route. Model-driven board creation/mutation is retired.
// See work_in_progress/board_manager_resurrection_plan_20260805.md.

export const DETERMINISTIC_BOARD_IDS = Object.freeze([
  "board_community_promotion",
  "board_pf_terminal",
  "board_postfiat_l1v2",
  "board_ai_l1_governance",
  "board_tasknode_fixes",
  "board_capital_markets",
]);

export function deterministicBoardsEnabled(env = process.env) {
  // Default on. Explicit opt-out only, for local experiments.
  return env.TASKNODE_DETERMINISTIC_BOARDS !== "false";
}

export function isDeterministicBoardId(id = "") {
  return DETERMINISTIC_BOARD_IDS.includes(String(id || "").trim());
}

// Fields the board admin route may update. Everything else (id, type,
// origin, task/contributor projections) is migration- or worker-owned.
export const BOARD_ADMIN_MUTABLE_FIELDS = Object.freeze([
  "title",
  "summary",
  "objective",
  "about",
  "status",
  "priority",
  "phase_label",
  "phase_current",
  "phase_total",
]);
