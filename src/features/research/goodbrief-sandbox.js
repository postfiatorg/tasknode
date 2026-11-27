// Pure Goodbrief sandbox isolation and Today desk sorting/filtering helpers.
// Keep zero browser-only globals so Node unit tests verify every security invariant directly.

export const GOODBRIEF_SANDBOX_ATTR = "allow-scripts";
export const GOODBRIEF_SRCDOC_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'";

export function escapePlainText(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Ensures Goodbrief HTML rendered inside `<iframe sandbox="allow-scripts" srcdoc=...>`
 * always starts with the locked zero-exfiltration CSP and strips any tags capable
 * of external requests, redirects, or nested frames.
 */
export function buildGoodbriefSrcDoc(rawHtml = "", { watermarkId = "", title = "Goodbrief" } = {}) {
  let html = String(rawHtml || "");
  html = html
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?https?:[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "");

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(GOODBRIEF_SRCDOC_CSP)}">`;
  const wmMeta = watermarkId ? `<meta name="pf-fh-wm" content="${escapeAttr(watermarkId)}">` : "";

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${cspMeta}${wmMeta}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${wmMeta}<title>${escapeAttr(title)}</title></head><body>${html}</body></html>`;
}

export function isNewSinceBaseline(updatedAt, visitBaselineAt) {
  if (!updatedAt || !visitBaselineAt) return false;
  const itemMs = Date.parse(updatedAt);
  const baseMs = Date.parse(visitBaselineAt);
  return Number.isFinite(itemMs) && Number.isFinite(baseMs) && itemMs > baseMs;
}

export function matchesTodayFilters(item, { query = "", assetClass = "all", watchlistSet = null, watchlistOnly = false } = {}) {
  const ticker = String(item?.ticker || item?.model_id || "").trim().toUpperCase();
  const name = String(item?.name || item?.title || "").trim();
  const itemClass = String(item?.asset_class || item?.assetClass || item?.category || "equity").toLowerCase();

  if (watchlistOnly && watchlistSet && !watchlistSet.has(ticker)) return false;

  if (assetClass && assetClass !== "all") {
    const normalized = assetClass.toLowerCase();
    if (normalized === "crypto" && !itemClass.includes("crypto")) return false;
    if (normalized === "equities" && !itemClass.includes("equity") && !itemClass.includes("equities")) return false;
    if (normalized === "macro" && !itemClass.includes("macro")) return false;
  }

  const trimmed = String(query || "").trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = [ticker, name, item?.summary, item?.takeaway, item?.why].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(trimmed);
}

/**
 * Floats starred watchlist tickers to the top of any Today section while
 * preserving the section's original relative priority order within each group.
 */
export function sortWithWatchlistFirst(items = [], watchlistSet = new Set()) {
  if (!Array.isArray(items) || !items.length) return [];
  const starred = [];
  const rest = [];
  for (const item of items) {
    const ticker = String(item?.ticker || item?.model_id || "").trim().toUpperCase();
    if (ticker && watchlistSet.has(ticker)) starred.push(item);
    else rest.push(item);
  }
  return [...starred, ...rest];
}

export function formatAccessBasisBadge(access = null) {
  if (!access?.ok) return null;
  if (access.basis === "validator") {
    return { tone: "validator", label: "Active Validator" };
  }
  if (access.basis === "top30") {
    const rankSuffix = Number.isInteger(access.rank) ? ` #${access.rank}` : "";
    return { tone: "top30", label: `Top 30${rankSuffix}` };
  }
  if (access.basis === "grace") {
    const ends = access.graceEndsAt ? String(access.graceEndsAt).slice(0, 10) : "";
    return { tone: "grace", label: ends ? `Grace · ends ${ends}` : "Grace Window" };
  }
  return null;
}
