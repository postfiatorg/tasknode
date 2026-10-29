export const RESEARCH_MAX_USD = 10;
export const researchDefaultBudget = mode => mode === "agent" ? 3 : 1.5;

export function researchMode(value, fallback = "auto") {
  if (value === undefined || value === null) return fallback;
  if (!["auto", "fast", "agent"].includes(value)) throw Object.assign(new Error("research_mode_invalid"), { status: 400 });
  return value;
}

export function researchProgress(value) {
  if (value === undefined || value === null) return {};
  const fail = () => { throw Object.assign(new Error("research_progress_invalid"), { status: 502 }); };
  if (typeof value !== "object" || Array.isArray(value)) return fail();
  if (!Object.keys(value).length) return {};
  const out = {};
  for (const key of ["sequence", "step", "step_limit", "documents_total", "documents_completed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return fail();
    out[key] = value[key];
  }
  if (out.step > out.step_limit || out.step_limit > 25 || out.documents_completed > out.documents_total) return fail();
  for (const key of ["elapsed_seconds", "cost_usd"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) return fail();
    out[key] = value[key];
  }
  if (typeof value.stage !== "string" || !value.stage || value.stage.length > 80 ||
      typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) return fail();
  return { ...out, stage: value.stage, updated_at: value.updated_at };
}

export function newerResearchProgress(previous = {}, next = {}) {
  if (previous.sequence === undefined) return next;
  if (next.sequence === undefined || next.sequence <= previous.sequence ||
      next.elapsed_seconds < previous.elapsed_seconds || next.cost_usd < previous.cost_usd) return previous;
  return next;
}

export function researchTables(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(table => {
    if (!table || typeof table.name !== "string" || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return [];
    const columns = table.columns.slice(0, 30).filter(column => column && typeof column.name === "string" && column.name.length > 0 && column.name.length <= 120)
      .map(column => ({ name: column.name.slice(0, 120), unit: typeof column.unit === "string" ? column.unit.slice(0, 80) : "" }));
    if (!columns.length) return [];
    const rows = table.rows.slice(0, 500).filter(row => row && typeof row === "object" && !Array.isArray(row))
      .map(row => Object.fromEntries(columns.map(({ name }) => {
        const value = row[name];
        return [name, typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? value.slice(0, 2000) : null];
      })));
    return [{ name: table.name.slice(0, 200), columns, rows, totalRows: table.rows.length,
      source_ids: Array.isArray(table.source_ids) ? table.source_ids.filter(id => typeof id === "string").slice(0, 100) : [] }];
  });
}
