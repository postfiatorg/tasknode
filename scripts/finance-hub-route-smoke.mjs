import assert from "node:assert/strict";
import { FINANCE_HUB_BUNDLE_PATH, financeHubAppHash, financeHubFrameSrc, financeHubRouteFromAppHash, financeHubRouteFromViewerHash,
  financeHubSectionFromAppHash, financeHubViewerHash, hasFinanceHubAccess } from "../src/features/research/finance-hub-route.js";

assert.equal(hasFinanceHubAccess({ validator: { bindings: [{ id: "l1" }] } }), true);
assert.equal(hasFinanceHubAccess({ financeHub: { ok: true, basis: "top30", rank: 14 }, validator: { bindings: [] } }), true);
assert.equal(hasFinanceHubAccess({ financeHub: { ok: true, basis: "grace", graceEndsAt: "2026-12-04T00:00:00Z" }, validator: { bindings: [] } }), true);
assert.equal(hasFinanceHubAccess({ validator: { bindings: [] } }), false, "non-validators without Top-30 see nothing new");
assert.equal(hasFinanceHubAccess(null), false);
assert.equal(financeHubSectionFromAppHash("#finance-hub"), "today");
assert.equal(financeHubSectionFromAppHash("#finance-hub/goodbrief"), "goodbrief");
assert.equal(financeHubSectionFromAppHash("#finance-hub/library"), "library");
assert.equal(financeHubSectionFromAppHash("#finance-hub/models"), "models");
assert.equal(financeHubSectionFromAppHash("#finance-hub/RKLB/summary"), "models");
assert.deepEqual(financeHubRouteFromAppHash("#finance-hub"), { model: "", tab: "" });
assert.deepEqual(financeHubRouteFromAppHash("#finance-hub/goodbrief"), { model: "", tab: "" });
assert.deepEqual(financeHubRouteFromAppHash("#finance-hub/RKLB/summary"), { model: "RKLB", tab: "summary" });
assert.deepEqual(financeHubRouteFromAppHash("#/finance-hub/PLTR/income_statement"), { model: "PLTR", tab: "income_statement" });
assert.deepEqual(financeHubRouteFromAppHash("#finance-hub/PLTR"), { model: "PLTR", tab: "" });
assert.deepEqual(financeHubRouteFromAppHash("#finance-hub/<script>/x"), { model: "", tab: "" }, "unsafe segments fall back to the hub home");
assert.deepEqual(financeHubRouteFromAppHash("#tasks/RKLB"), { model: "", tab: "" });
assert.deepEqual(financeHubRouteFromViewerHash("#m=RKLB&tab=calls"), { model: "RKLB", tab: "calls" });
assert.deepEqual(financeHubRouteFromViewerHash("#home"), { model: "", tab: "" });
assert.equal(financeHubViewerHash({ model: "PLTR" }), "#m=PLTR&tab=summary");
assert.equal(financeHubViewerHash({}), "#home");
assert.equal(financeHubAppHash({ model: "PLTR", tab: "income_statement" }), "finance-hub/PLTR/income_statement");
assert.equal(financeHubAppHash({}), "finance-hub");
for (const hash of ["#finance-hub", "#finance-hub/RKLB/summary", "#finance-hub/PLTR/income_statement"]) {
  const route = financeHubRouteFromAppHash(hash);
  assert.equal(`#${financeHubAppHash(financeHubRouteFromViewerHash(financeHubViewerHash(route)))}`, hash, "round trip");
}
assert.equal(financeHubFrameSrc({ model: "RKLB", tab: "summary" }, "dark"), `${FINANCE_HUB_BUNDLE_PATH}?embed=1&theme=dark#m=RKLB&tab=summary`);
assert.equal(financeHubFrameSrc({}, "anything"), `${FINANCE_HUB_BUNDLE_PATH}?embed=1&theme=light#home`);
assert.equal(financeHubFrameSrc({ model: "RKLB", tab: "summary" }, "dark", "https://hub-viewer.postfiat.org"), `https://hub-viewer.postfiat.org${FINANCE_HUB_BUNDLE_PATH}?embed=1&theme=dark#m=RKLB&tab=summary`);
console.log("finance-hub-route-smoke ok: validator/top30/grace gate, section routes, deep links both ways, unsafe segments, round trip, isolated viewer origin");
