import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { verifyValidatorLayout } from "./fixtures/validator-layout.mjs";
import { validatorDashboard } from "../server/validator-dashboard.js";
import { getDirectoryLeaderboardDocument } from "../server/repositories/directory-leaderboard.js";
import { validatorEligibility, validatorMenuStatus, validatorRewardLedgerTitle } from "../shared/validator-display.js";

const now = new Date("2026-11-02T12:00:00Z");
const ledger = { id: "ledger", network: "devnet", master_public_key: "public-ledger-key", bound_at: "2026-10-01T00:00:00Z" };
const l1 = { id: "l1", network: "l1-devnet", chain_id: "fixture-chain", validator_id: "fixture-node", bound_at: "2026-10-28T00:00:00Z" };
const paid = { id: "paid", validatorId: ledger.master_public_key, network: "devnet", month: "2026-11", amountUsd: 20, status: "paid", paidAt: "2026-11-01T01:00:00Z" };
const reports = Array.from({ length: 30 }, (_, i) => ({ date: new Date(+now - (i + 1) * 86400000).toISOString().slice(0, 10), score: .99 }));
const dependencies = { now, bindings: async () => [ledger, l1], history: async () => [paid], balance: async () => ({ availableCreditUsd: 18.75 }),
  reports: async () => reports, participation: async () => ({ daysReported: 5, meanAgreement: .98, eligible: false }) };
const status = await validatorDashboard("owner", dependencies);
assert.equal(status.availableCreditUsd, 18.75);
assert.equal(status.nextRewardDate, "2026-12-01T00:00:00.000Z");
assert.equal(status.bindings[0].eligibility.state, "on_track");
assert.equal(status.bindings[0].eligibility.daysObserved, 30);
assert.deepEqual(status.bindings[0].rewardHistory, [paid]);
assert.equal(status.bindings[1].eligibility.state, "building_history");
assert.deepEqual(status.bindings[1].rewardHistory, []);
const outage = await validatorDashboard("owner", { ...dependencies, reports: async () => { throw Error("offline"); } });
assert.equal(outage.bindings[0].eligibility.state, "unavailable");
assert.deepEqual(outage.rewardHistory, [paid], "a history provider outage preserves actual paid receipts");
const unbound = await validatorDashboard("owner", { ...dependencies, bindings: async () => [] });
assert.equal(unbound.badge, null); assert.deepEqual(unbound.bindings, []); assert.deepEqual(unbound.rewardHistory, [paid]);
assert.equal(validatorEligibility({ daysReported: 25, meanAgreement: .949, eligible: false }).state, "below_threshold");
assert.equal(validatorEligibility({ daysReported: 24, meanAgreement: 1, eligible: false }).state, "building_history");
assert.equal(validatorMenuStatus([]), "Connect");
assert.equal(validatorMenuStatus([l1]), "Connected · L1");
assert.equal(validatorMenuStatus([ledger]), "Connected · Ledger");
assert.equal(validatorMenuStatus([ledger, l1]), "Connected · L1 + Ledger");
assert.equal(validatorRewardLedgerTitle({ kind: "reward_credit", source: "validator_reward", uniqueKey: "validator-reward:fixture:2026-10", createdAt: "2026-11-02" }), "Validator reward — Oct 2026");
assert.equal(validatorRewardLedgerTitle({ kind: "reward_credit", source: "other" }), null);
const listed = { accountId: "public", score: 100 };
let lookupIds;
const directory = await getDirectoryLeaderboardDocument({ viewerAccountId: "public" }, {
  loadBase: async () => ({ operators: [listed], totals: { operators: 1 } }),
  loadValidators: async ids => { lookupIds = ids; return new Map([["public", [ledger]], ["private", [l1]]]); },
});
assert.deepEqual(lookupIds, ["public"]); assert.equal(directory.operators.length, 1);
assert.equal(directory.operators[0].validator.bindings.length, 1); assert.equal(directory.operators[0].isYou, true);
assert.equal(JSON.stringify(directory).includes("private"), false);
const revoked = await getDirectoryLeaderboardDocument({}, { loadBase: async () => ({ operators: [listed] }), loadValidators: async () => new Map() });
assert.equal(revoked.operators[0].validator, null, "membership is read after the ranking cache");

const vite = await createServer({ appType: "custom", logLevel: "error", optimizeDeps: { entries: [], noDiscovery: true }, server: { middlewareMode: true } });
try {
  const { ValidatorMark, ValidatorMenuLink, ValidatorAvatar } = await vite.ssrLoadModule("/src/features/research/ValidatorStatus.jsx");
  const { ValidatorBindingCard, ValidatorRewardHistory } = await vite.ssrLoadModule("/src/features/research/ValidatorRewards.jsx");
  const { ValidatorProfileCard, ValidatorProfileBanner } = await vite.ssrLoadModule("/src/features/research/ValidatorProfile.jsx");
  const { OperatorIdentity } = await vite.ssrLoadModule("/src/features/directory/DirectoryView.jsx");
  const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
  assert.equal(render(ValidatorMark, { bindings: [] }), "");
  assert.equal(render(ValidatorProfileBanner, { session: { validator: { bindings: [] } } }), "");
  const inactive = render(ValidatorMenuLink, { bindings: [] });
  assert.ok(inactive.includes("Connect") && inactive.includes("#settings/validator")); assert.ok(!inactive.includes("Connected"));
  for (const binding of [ledger, l1]) {
    const mark = render(ValidatorMark, { bindings: [binding] });
    assert.ok(mark.includes("linked 2026-10-") && mark.includes("Validator"));
    assert.equal(mark.split("lucide-server").length - 1, 1);
    assert.ok(render(ValidatorAvatar, { bindings: [binding] }).includes("validator-avatar-mark"));
    assert.ok(render(ValidatorProfileCard, { bindings: [binding] }).includes("Connected"));
  }
  assert.equal(render(ValidatorMark, { bindings: [ledger, l1] }).split("lucide-server").length - 1, 1, "one mark for multiple networks");
  const activeCard = render(ValidatorBindingCard, { binding: status.bindings[0] });
  assert.ok(activeCard.includes("On track") && activeCard.includes("30 / 25") && activeCard.includes("Nov 2026") && activeCard.includes("Paid"));
  const building = render(ValidatorBindingCard, { binding: status.bindings[1] });
  assert.ok(building.includes("Building history") && building.includes("5 / 25") && building.includes("No rewards paid yet"));
  assert.ok(render(ValidatorRewardHistory, { entries: [{ month: "2026-10", status: "not_eligible", reason: "Participation below 95%" }] }).includes("Not eligible"));
  if (process.env.CHROME_BIN) await verifyValidatorLayout({
    operator: handle => render(OperatorIdentity, { operator: { handle, isYou: true, validator: { bindings: [ledger, l1] } } }),
    menu: render(ValidatorMenuLink, { bindings: [ledger, l1] }),
  });
} finally { await vite.close(); }
console.log("validator-ux-smoke ok: both networks, eligibility/bound/unbound/outage/paid history, historical month label, private directory exclusion, revoked membership and rendered indicators");
