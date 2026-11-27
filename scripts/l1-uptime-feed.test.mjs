// Task Node's reader of the signed validator uptime feed, against two feeds it
// did not make: the fixture the Python reference signs (postfiatl1v2
// docs/specs/schemas), and a feed three observers signed with `postfiat-node`
// on postfiat-wan-devnet-2 on 27 November 2026. Three implementations of one
// contract have to accept and reject the same feeds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FeedRejected, canonicalJson, reconcile, verifyUptimeFeed } from "../server/l1-uptime-feed.js";

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/l1-uptime-feed/${name}`, import.meta.url), "utf8"));
const feed = () => load("postfiat-validator-uptime-v1.fixture.json");
const keyset = load("postfiat-observer-keyset-v1.fixture.json");
const now = new Date("2026-11-27T01:40:40Z");
const read = (value, options = {}) => verifyUptimeFeed(value, { keyset, now, ...options });
const FIRST = "observer-us-east-1";
/** The rows two good observers give, when the first is wrong. */
const withoutFirst = value => {
  value.validators = reconcile(value.observer_attestations.filter(a => a.observer_id !== FIRST)).rows;
  return value;
};

test("the Python-signed fixture verifies and reads the same", () => {
  const result = read(feed());
  assert.deepEqual(result.verifiedObservers, ["observer-ap-northeast-3", "observer-eu-central-2", FIRST]);
  assert.equal(result.indeterminate, false);
  assert.equal(result.allowNewBindings && result.allowCreditGrants, true);
  assert.deepEqual(result.rejectedObservers, {});
  assert.deepEqual(result.validators.map(row => [row.validator_id, row.access_state, row.access_state_reason]), [
    ["validator-0", "active", "healthy_liveness"],
    ["validator-1", "active", "day0_ramp_in"],
    ["validator-2", "active", "recovered_3day_streak"],
    ["validator-3", "lapsed", "below_liveness_threshold"],
    ["validator-4", "revoked", "grace_expired"],
    ["validator-5", "pending", "awaiting_ratification"],
  ]);
  const revoked = result.validators[4];
  assert.deepEqual([revoked.finance_hub_access, revoked.research_api_keys_active, revoked.reward_eligible,
    revoked.removal_proposal_eligible], [false, false, false, true]);
  assert.equal(result.validators[3].grace_expires_at, "2026-12-08T00:00:00Z");
});

test("a feed signed by postfiat-node on the live devnet verifies", () => {
  const live = load("node-signed.feed.json");
  const result = verifyUptimeFeed(live, { keyset: load("node-signed.keyset.json"), now: new Date("2026-11-27T21:04:00Z") });
  assert.equal(result.verifiedObservers.length, 3);
  assert.equal(result.indeterminate, false);
  assert.deepEqual(result.validators.map(row => row.validator_id),
    ["validator-0", "validator-1", "validator-2", "validator-3", "validator-4", "validator-5"]);
  assert.equal(result.validators.every(row => row.access_state === "active"), true);
  // The fixture keyset does not vouch for it.
  assert.throws(() => verifyUptimeFeed(live, { keyset, now: new Date("2026-11-27T21:04:00Z") }), FeedRejected);
});

test("one wrong observer is dropped; two make the feed indeterminate and revoke nobody", () => {
  const wrong = [
    ["signature does not verify", a => { a.signature_hex = "00".repeat(3309); }],
    ["signature does not verify", (a, all) => { a.signature_hex = all[1].signature_hex; }],
    ["claim_digest_sha256", a => { a.claim_digest_sha256 = "0".repeat(64); }],
    ["region differs", a => { a.region = "eu-west"; }],
    ["public_key_hex differs", a => { a.public_key_hex = "ab".repeat(1952); }],
    ["claim_digest_sha256", a => { a.validator_claims[3].access_state = "active"; }],
    ["claim_digest_sha256", a => { a.validator_claims[3].removal_proposal_eligible = true; }],
    ["claim_digest_sha256", a => { a.validator_claims[3].grace_started_at = "2026-11-26T00:00:00Z"; }],
  ];
  for (const [reason, change] of wrong) {
    const bad = feed();
    change(bad.observer_attestations[0], bad.observer_attestations);
    // Served as is, the rows still name the wrong observer.
    assert.throws(() => read(bad), FeedRejected, reason);
    const result = read(withoutFirst(bad));
    assert.equal(result.verifiedObservers.length, 2, reason);
    assert.match(result.rejectedObservers[FIRST], new RegExp(reason));
    assert.equal(result.validators.length, 6);
  }
  const two = feed();
  two.observer_attestations[0].signature_hex = "00".repeat(3309);
  two.observer_attestations[1].signature_hex = "00".repeat(3309);
  const result = read(two);
  assert.deepEqual([result.indeterminate, result.allowNewBindings, result.allowCreditGrants, result.revokeExistingAccess],
    [true, false, false, false]);
  assert.deepEqual(result.validators, []);
});

test("every field of a served row is covered by the signatures", () => {
  for (const [field, value] of [["removal_proposal_eligible", true], ["grace_started_at", "2026-11-26T00:00:00Z"],
    ["consecutive_passing_days", 3], ["finance_hub_access", false], ["reward_eligible", true],
    ["source_observer_id", FIRST], ["an_added_field", 1]]) {
    const bad = feed();
    bad.validators[3][field] = value;
    assert.throws(() => read(bad), FeedRejected, field);
  }
  const dropped = feed();
  dropped.validators.pop();
  assert.throws(() => read(dropped), FeedRejected);
});

test("stale, replayed, another chain, moved constants", () => {
  const stale = read(feed(), { now: new Date(now.getTime() + 3700000) });
  assert.equal(stale.indeterminate, true);
  assert.deepEqual([...new Set(Object.values(stale.rejectedObservers))], ["stale"]);
  const accepted = read(feed()).accepted;
  assert.equal(read(feed(), { lastAccepted: accepted }).indeterminate, false);
  const newer = Object.fromEntries(Object.entries(accepted).map(([id, at]) =>
    [id, `${new Date(Date.parse(at) + 5000).toISOString().slice(0, 19)}Z`]));
  const replay = read(feed(), { lastAccepted: newer });
  assert.equal(replay.indeterminate, true);
  assert.equal(Object.values(replay.rejectedObservers).every(reason => reason.includes("older than")), true);
  assert.throws(() => verifyUptimeFeed(feed(), { now, keyset: { ...keyset, chain: { ...keyset.chain, chain_id: "postfiat-other-1" } } }), FeedRejected);
  for (const change of [
    value => { value.window_spec.liveness_threshold_bps = 9400; },
    value => { value.window_spec.grace_period_days = 7; },
    value => { value.window_spec.metric_version = "precommit-qc-observer-brackets-v1"; },
    value => { value.window_spec.credit_sources = ["precommit_certificate"]; },
    value => { value.quorum_policy.quorum_threshold = 1; },
    value => { value.undeclared_extra = true; },
    value => { value.observer_attestations[1] = structuredClone(value.observer_attestations[0]); },
    value => { value.observer_attestations.push(structuredClone(value.observer_attestations[0])); },
  ]) {
    const bad = feed();
    change(bad);
    assert.throws(() => read(bad), FeedRejected);
  }
});

test("canonical JSON is the bytes the other implementations sign", () => {
  assert.equal(canonicalJson({ b: [1, { d: null, c: true }], a: "x" }), '{"a":"x","b":[1,{"c":true,"d":null}]}');
});
