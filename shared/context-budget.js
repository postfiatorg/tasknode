export const MODEL_CONTEXT_MAX_CHARS = 60_000;
export const TASKGEN_CONTEXT_MAX_CHARS = MODEL_CONTEXT_MAX_CHARS;
export const CONTEXT_DOCUMENT_MAX_CHARS = 120_000;

export function normalizeContextCharLimit(value, fallback = TASKGEN_CONTEXT_MAX_CHARS) {
  const parsed = Number(value);
  const fallbackNumber = Number(fallback);
  const base = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? fallbackNumber
      : TASKGEN_CONTEXT_MAX_CHARS;
  return Math.min(Math.max(Math.round(base), 1_000), CONTEXT_DOCUMENT_MAX_CHARS);
}

export function compactContextForModel(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function contextBudgetMetrics(value = "", { maxChars = TASKGEN_CONTEXT_MAX_CHARS } = {}) {
  const normalizedMaxChars = normalizeContextCharLimit(maxChars, TASKGEN_CONTEXT_MAX_CHARS);
  const text = compactContextForModel(value);
  const sourceChars = text.length;
  const includedChars = Math.min(sourceChars, normalizedMaxChars);
  const usagePercent = normalizedMaxChars > 0
    ? Math.min(999.9, Math.round((sourceChars / normalizedMaxChars) * 1000) / 10)
    : 0;

  return {
    text: text.slice(0, normalizedMaxChars),
    sourceChars,
    includedChars,
    omittedChars: Math.max(0, sourceChars - normalizedMaxChars),
    maxChars: normalizedMaxChars,
    clipped: sourceChars > normalizedMaxChars,
    usagePercent,
  };
}
