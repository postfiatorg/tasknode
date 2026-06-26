import { databaseEnabled, query } from "./db/pool.js";

export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;

const trackedTables = [
  "board_manager_action_results",
  "board_manager_jobs",
  "board_manager_leases",
  "board_manager_runs",
  "board_manager_scopes",
  "board_manager_secretary_packets",
  "chat_deep_memory_jobs",
  "chat_memory_entries",
  "chat_memory_jobs",
  "context_rewrite_jobs",
  "context_rewrite_provider_calls",
  "hive_decision_runs",
  "hive_project_generations",
  "hive_project_planning_jobs",
  "hive_report_verifications",
  "hive_reports",
  "hive_secretary_jobs",
  "hive_secretary_reports",
  "jobs_corpus_chunks",
  "jobs_corpus_sources",
  "network_task_generation_jobs",
  "network_task_profile_jobs",
  "network_task_profiles",
  "orc_agents",
  "orc_work_journal",
  "pftl_cache_maintenance_runs",
  "pftl_cache_reducer_events",
  "pftl_cache_watcher_state",
  "pftl_sync_wallets",
  "profile_daily_airdrop_issuances",
  "profile_daily_airdrop_runs",
  "task_events",
  "task_projections",
  "task_requests",
];

export function boolEnv(value) {
  return String(value || "").toLowerCase() === "true";
}

export function intEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function redactStatusText(value = "", max = 500) {
  return safeText(value, max)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\/\/[^@\s]+@/g, "//");
}

function endpointLabel(value = "") {
  const raw = safeText(value, 500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/\/[^@\s]+@/, "//").split("?")[0].slice(0, 120);
  }
}

export function endpointList(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map(endpointLabel)
    .filter(Boolean);
}

function statusRank(status = "unknown") {
  return {
    critical: 4,
    warning: 3,
    unknown: 2,
    disabled: 1,
    ok: 0,
  }[status] ?? 2;
}

export function summarizeCategories(categories = []) {
  const summary = { ok: 0, warning: 0, critical: 0, unknown: 0, disabled: 0, total: 0 };
  for (const item of categories.flatMap((category) => category.items || [])) {
    const key = item.status in summary ? item.status : "unknown";
    summary[key] += 1;
    summary.total += 1;
  }
  return summary;
}

export function countsFromRows(rows = []) {
  const counts = {};
  for (const row of rows) counts[row.status || "unknown"] = Number(row.count || 0);
  return counts;
}

export function countValue(counts = {}, names = []) {
  return names.reduce((sum, name) => sum + Number(counts[name] || 0), 0);
}

export function oldestAgeMs(value, nowMs) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

export function runFreshness({
  enabled = true,
  lastSuccessAt = null,
  warningAfterMs = null,
  staleAfterMs = null,
  nowMs = Date.now(),
  missingStatus = "unknown",
} = {}) {
  if (!enabled) return { status: "disabled", label: "Disabled" };
  if (!lastSuccessAt) return { status: missingStatus, label: missingStatus === "critical" ? "No run found" : "No run data" };
  const age = nowMs - Date.parse(lastSuccessAt);
  if (staleAfterMs && age > staleAfterMs) return { status: "critical", label: "Stale" };
  if (warningAfterMs && age > warningAfterMs) return { status: "warning", label: "Lagging" };
  return { status: "ok", label: "Current" };
}

export function mergeStatus(base, next) {
  return statusRank(next.status) > statusRank(base.status) ? next : base;
}

export function item({
  id,
  category,
  title,
  description,
  owner,
  trigger,
  cadence,
  status = "unknown",
  statusLabel = "Unknown",
  lastRunAt = null,
  lastSuccessAt = null,
  nextRunAt = null,
  staleAfterMs = null,
  counts = {},
  details = [],
  lastError = "",
} = {}) {
  return {
    id,
    category,
    title,
    description,
    owner,
    trigger,
    cadence,
    status,
    statusLabel,
    lastRunAt: iso(lastRunAt),
    lastSuccessAt: iso(lastSuccessAt),
    nextRunAt: iso(nextRunAt),
    staleAfterSeconds: staleAfterMs ? Math.round(staleAfterMs / 1000) : null,
    counts,
    details: details.filter(Boolean).map((detail) => redactStatusText(detail, 500)),
    lastError: redactStatusText(lastError, 1000),
  };
}

export async function tableMap() {
  if (!databaseEnabled()) return new Map();
  const result = await query(
    `
      SELECT table_name, to_regclass('public.' || table_name) IS NOT NULL AS exists
      FROM unnest($1::text[]) AS table_name
    `,
    [trackedTables]
  );
  return new Map(result.rows.map((row) => [row.table_name, row.exists === true]));
}

function hasTable(tables, name) {
  return tables.get(name) === true;
}

export async function optionalQuery(tables, requiredTables, sql, params = [], fallback = { rows: [] }) {
  if (!databaseEnabled()) return fallback;
  if (!requiredTables.every((name) => hasTable(tables, name))) return fallback;
  return query(sql, params);
}
