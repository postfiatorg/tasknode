// Finance Hub inside Task Node: the validator research bundle is rendered in an iframe on the #finance-hub route.
// Task Node owns the address bar (#finance-hub/<model>/<tab>); the viewer owns its own hash (#home, #m=<model>&tab=<tab>).
// Both sides talk over same-origin postMessage; these pure helpers translate between the two forms.

export const FINANCE_HUB_VIEW = "finance-hub";
export const FINANCE_HUB_BUNDLE_PATH = "/api/research/bundles/ga-models/index.html";
export const FINANCE_HUB_MESSAGES = Object.freeze({
  route: "tasknode-finance-hub:route", // viewer -> Task Node: the viewer is now showing this hash
  navigate: "tasknode-finance-hub:navigate", // Task Node -> viewer: show this hash (replaces the viewer's history entry)
  theme: "tasknode-finance-hub:theme", // Task Node -> viewer: resolved appearance, "light" or "dark"
});

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const clean = (value) => {
  let text = String(value || "").trim();
  try { text = decodeURIComponent(text); } catch { /* keep the raw segment */ }
  return SEGMENT.test(text) ? text : "";
};

export function hasFinanceHubAccess(session) {
  return Array.isArray(session?.validator?.bindings) && session.validator.bindings.length > 0;
}

// "#finance-hub/RKLB/income_statement" -> { model: "RKLB", tab: "income_statement" }; anything else -> the hub home.
export function financeHubRouteFromAppHash(hash = "") {
  const parts = String(hash).replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean);
  if ((parts[0] || "").toLowerCase() !== FINANCE_HUB_VIEW) return { model: "", tab: "" };
  const model = clean(parts[1]);
  return { model, tab: model ? clean(parts[2]) : "" };
}

// "#m=RKLB&tab=summary" -> { model: "RKLB", tab: "summary" }; "#home" or anything else -> the hub home.
export function financeHubRouteFromViewerHash(hash = "") {
  const params = new URLSearchParams(String(hash).replace(/^#/, ""));
  const model = clean(params.get("m"));
  return { model, tab: model ? clean(params.get("tab")) : "" };
}

export function financeHubAppHash({ model = "", tab = "" } = {}) {
  if (!model) return FINANCE_HUB_VIEW;
  return `${FINANCE_HUB_VIEW}/${encodeURIComponent(model)}/${encodeURIComponent(tab || "summary")}`;
}

export function financeHubViewerHash({ model = "", tab = "" } = {}) {
  return model ? `#m=${model}&tab=${tab || "summary"}` : "#home";
}

export function financeHubFrameSrc(route, theme) {
  const resolvedTheme = theme === "dark" ? "dark" : "light";
  return `${FINANCE_HUB_BUNDLE_PATH}?embed=1&theme=${resolvedTheme}${financeHubViewerHash(route)}`;
}
