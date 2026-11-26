import assert from "node:assert/strict";
import test from "node:test";
import { l1RewardEligibility } from "../server/l1-validator-identity.js";
import { dailyAgreement } from "../server/validator-identity.js";
import { l1UptimeEnabled } from "../server/l1-validator-uptime.js";
import { validatorEligibility } from "../shared/validator-display.js";

const now = new Date("2026-12-01T00:00:00Z");
const window = dailyAgreement([], now);
const enabled = { TASKNODE_L1_UPTIME_REWARDS_ENABLED: "true" };
function fixture(online = 96, days = 30) {
  return { validator_id: "validator-test", ml_dsa_public_key: "fixture-public-key", participation: {
    window_start: window.windowStart, window_end: window.windowEnd,
    time_basis: "observer_brackets", available: false, daily: [],
  }, uptime: { schema: "postfiat-validator-uptime-v1", validator_id: "validator-test",
    ml_dsa_public_key: "fixture-public-key", cadence_seconds: 900, time_basis: "validator_probes",
    window_start: window.windowStart, window_end: window.windowEnd,
    daily: Array.from({ length: days }, (_, i) => ({
      date: new Date(Date.parse(window.windowStart) + i * 86400000).toISOString().slice(0, 10),
      complete: true, expected_samples: 96, observed_samples: 96, online_samples: online,
    })) } };
}

test("flag defaults off; current participation stays unchanged; enabled uptime counts idle days", () => {
  assert.equal(l1UptimeEnabled({}), false);
  assert.equal(l1UptimeEnabled({ TASKNODE_L1_UPTIME_REWARDS_ENABLED: "1" }), false);
  assert.equal(l1RewardEligibility(fixture(), now, {}).eligible, false);
  const result = l1RewardEligibility(fixture(), now, enabled);
  assert.equal(result.eligible, true);
  assert.equal(result.metric, "uptime");
  assert.equal(result.daysReported, 30);
  assert.equal(result.meanAgreement, 1);
  assert.equal(result.policy, "l1-uptime-v1");
  assert.equal(dailyAgreement([], now).eligible, false, "legacy chain remains block-report based");
});

test("uptime requires full identity-bound probe evidence; block coverage is not uptime", () => {
  const mutations = [
    r => { delete r.uptime; },
    r => { r.uptime = r.participation; },
    r => { r.uptime.validator_id = "other"; },
    r => { r.uptime.ml_dsa_public_key = "rotated"; },
    r => { r.uptime.window_end = "2026-11-01T00:00:00Z"; },
    r => { r.uptime.daily[0].observed_samples = 95; },
    r => { r.uptime.daily[0].online_samples = 97; },
    r => { r.uptime.daily[0].online_samples = 95.5; },
    r => { r.uptime.daily[0].date = r.uptime.daily[1].date; },
    r => { r.uptime.daily[0].date = "2026-12-01"; },
    r => { r.uptime.cadence_seconds = 3600; },
  ];
  for (const mutate of mutations) {
    const row = fixture(); mutate(row);
    const result = l1RewardEligibility(row, now, enabled);
    assert.equal(result.eligible, false);
    assert.equal(result.rewardsOnHold, true);
  }
});

test("existing observation minimum and inclusive 95 percent boundary are preserved", () => {
  assert.equal(l1RewardEligibility(fixture(96, 24), now, enabled).eligible, false);
  assert.equal(l1RewardEligibility(fixture(96, 25), now, enabled).eligible, true);
  const row = fixture(91, 25);
  for (let i = 0; i < 5; i++) row.uptime.daily[i].online_samples = 92;
  assert.equal(l1RewardEligibility(row, now, enabled).meanAgreement, .95);
  assert.equal(l1RewardEligibility(row, now, enabled).eligible, true);
  row.uptime.daily[0].online_samples--;
  const below = l1RewardEligibility(row, now, enabled);
  assert.equal(below.eligible, false);
  assert.match(validatorEligibility(below).reason, /uptime/);
  const incomplete = fixture(96, 25); incomplete.uptime.daily[0].complete = false;
  assert.equal(l1RewardEligibility(incomplete, now, enabled).eligible, false);
});
