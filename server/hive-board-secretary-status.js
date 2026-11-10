import { intEnv, minute, runFreshness } from "./system-status-base.js";

export const HIVE_BOARD_SECRETARY_SCOPE = "hive_board_secretary:all_projects";

export function hiveBoardSecretaryCadenceSeconds(env = process.env) {
  return intEnv(env.TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS, 3600, { min: 60, max: 86400 });
}

// Memo age is not worker health: unchanged boards intentionally keep their
// memo forever. Observe completed scans, including scans that generate nothing.
export function hiveBoardSecretaryScanStatus({ lease, enabled, nowMs, cadenceSeconds }) {
  if (!enabled) return { status: "disabled", label: "Disabled" };
  const scan = lease?.metadata_json?.secretary_scan;
  const lastRunAt = lease?.status === "active" ? lease.claimed_at : scan?.completedAt;
  const freshness = runFreshness({
    lastSuccessAt: lastRunAt,
    warningAfterMs: cadenceSeconds * 1000 + 5 * minute,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    nowMs,
  });
  if (!lastRunAt) return { status: "unknown", label: "Scan telemetry unavailable" };
  if (freshness.status !== "ok") return freshness;
  if (lease.status === "active") return { status: "ok", label: "Scanning boards" };
  return scan?.ok === true
    ? { status: "ok", label: "Boards checked" }
    : { status: "warning", label: "Board scan failed" };
}
