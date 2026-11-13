import assert from "node:assert/strict";
import test from "node:test";
import { askDepth, changeBps, finalizedReadings, freshness, heldNavValues, readCoin, sortByTvl, verificationSplit } from "./model.js";

const profile = { verifier_kind: "sp1-groth16", max_snapshot_age_blocks: 1000, max_epoch_gap_blocks: 128 };
const packet = { verified_net_assets: 100, cryptographically_verified_value: 30, attested_value: 20, controlled_value: 40, submitted_at_height: 200 };
test("split credits only proven and attested value; controlled stays reported", () => {
  assert.deepEqual(verificationSplit(packet, profile).bps, [3000, 2000, 5000]);
  assert.deepEqual(verificationSplit(packet, { ...profile, verifier_kind: "placeholder" }).bps, [0, 0, 10000]);
  assert.deepEqual(verificationSplit({ ...packet, cryptographically_verified_value: 0, attested_value: 0 }, profile).bps, [0, 0, 10000]);
  assert.deepEqual(verificationSplit(packet, null).bps, [0, 0, 10000]);
});
test("split rounding totals 100%, exact above safe integer range, invalid totals fail closed", () => {
  const thirds = verificationSplit({ verified_net_assets: "30000000000000000000", cryptographically_verified_value: "10000000000000000000", attested_value: "10000000000000000000" }, profile);
  assert.deepEqual(thirds.bps, [3334, 3333, 3333]);
  assert.equal(verificationSplit({ ...packet, attested_value: 90 }, profile).reportedOnly, true);
  assert.equal(verificationSplit({ ...packet, cryptographically_verified_value: -1 }, profile).reportedOnly, true);
  assert.equal(verificationSplit({ ...packet, verified_net_assets: 0 }, profile).available, false);
  assert.equal(verificationSplit(null, profile).available, false);
});
test("freshness uses stricter positive block limit, inclusive boundary, zero means disabled", () => {
  assert.deepEqual(freshness(packet, profile, 328), { age: 128n, limit: 128n, stale: false, known: true });
  assert.equal(freshness(packet, profile, 329).stale, true);
  assert.equal(freshness(packet, { ...profile, max_epoch_gap_blocks: 0 }, 1201).stale, true);
  assert.equal(freshness(packet, { ...profile, max_epoch_gap_blocks: 0, max_snapshot_age_blocks: 0 }, 9999).stale, false);
  assert.equal(freshness(packet, null, 9999).stale, null);
  assert.equal(freshness(packet, profile, 199).age, null);
  assert.equal(freshness(null, profile, 9999).stale, null);
});
test("finalized epochs are ordered; pending readings cannot change price or TVL", () => {
  const history = finalizedReadings({ packets: [{ epoch: 3, state: "pending" }, { epoch: 2, state: "finalized" }, { epoch: 1, state: "finalized" }] });
  assert.deepEqual(history.map(p => p.epoch), [1, 2]);
  assert.equal(changeBps(110, 100), 1000n);
  assert.equal(changeBps(90, 100), -1000n);
  assert.equal(changeBps(100, 0), null);
  assert.deepEqual(sortByTvl([{ name: "A", latest: { verified_net_assets: 3 } }, { name: "B", latest: { verified_net_assets: 4 } }]).map(c => c.name), ["B", "A"]);
});
test("depth excludes closed, expired and wrong-pair offers and discloses truncation", () => {
  const coin = { asset_id: "a", market_quote_asset_id: "q" };
  const offer = { state: "open", taker_gets_asset_id: "a", taker_pays_asset_id: "q", taker_gets_amount_remaining: 2000000, taker_pays_amount_remaining: 3000000 };
  const depth = askDepth({ truncated: true, offers: [offer, { ...offer, state: "canceled" }, { ...offer, expiration_height: 100 }, { ...offer, taker_pays_asset_id: "other" }] }, coin, 100);
  assert.deepEqual(depth, { amount: 2000000n, best: 1500000n, partial: true });
  assert.equal(askDepth(null, coin, 100), null);
});
test("wallet values each NAVCoin using its own NAV, including zero holdings without NAV", () => {
  const coins = [{ asset_id: "a", latest: { nav_per_unit: 2000000 }, asset: { precision: 6 } }, { asset_id: "b", latest: { nav_per_unit: 150000000000 }, asset: { precision: 6 } }, { asset_id: "c" }];
  const result = heldNavValues([{ asset_id: "a", balance: 3000000 }, { asset_id: "b", balance: 100000 }], coins);
  assert.deepEqual(result.map(r => r.value), [6000000n, 15000000000n, 0n]);
  assert.equal(heldNavValues([{ asset_id: "c", balance: 1 }], coins)[2].value, null);
});
test("live re-read updates finalized NAV and trust; a failed book does not hide NAV", async () => {
  let next = false;
  const client = { call: async method => {
    if (method === "nav_reserve_proof_status") return { asset_id: "a", current_height: 300, active_profile: profile, packets: [{ ...packet, state: "finalized", epoch: next ? 2 : 1, nav_per_unit: next ? 2000000 : 1000000, cryptographically_verified_value: next ? 30 : 0, attested_value: 0 }] };
    if (method === "asset_info") return { asset: { asset_id: "a", outstanding_supply: 100 } };
    throw Error("book offline");
  } };
  const coin = { asset_id: "a", market_quote_asset_id: "q" };
  assert.equal((await readCoin(client, coin)).latest.nav_per_unit, 1000000);
  next = true;
  const updated = await readCoin(client, coin);
  assert.equal(updated.latest.nav_per_unit, 2000000);
  assert.deepEqual(updated.split.bps, [3000, 0, 7000]);
  assert.equal(updated.depth, null);
  assert.match(updated.errors[0], /book offline/);
});
