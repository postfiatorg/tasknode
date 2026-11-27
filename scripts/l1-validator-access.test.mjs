// What Task Node does with the rows of a verified uptime feed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessDecisions, creditFromFeedRow, feedAllowsNewBindings, l1UptimeFeedConfig, refreshL1ValidatorAccess,
  requireFeedForNewBinding } from "../server/l1-validator-access.js";
import { verifyUptimeFeed } from "../server/l1-uptime-feed.js";

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/l1-uptime-feed/${name}`, import.meta.url), "utf8"));
const keyset = load("postfiat-observer-keyset-v1.fixture.json");
const now = new Date("2026-11-27T01:40:40Z");
const rows = verifyUptimeFeed(load("postfiat-validator-uptime-v1.fixture.json"), { keyset, now }).validators;
const key = id => rows.find(row => row.validator_id === id).ml_dsa_public_key;
const binding = (validatorId, extra = {}) => ({ id: `vb_${validatorId}`, account_id: `acct_${validatorId}`,
  network: keyset.chain.network, chain_id: keyset.chain.chain_id, validator_id: validatorId,
  ml_dsa_public_key: key(validatorId), access_suspended_at: null, ...extra });
const actions = bindings => Object.fromEntries(accessDecisions(rows, bindings, keyset.chain).map(d => [d.binding.id, d.action]));

test("only a revoked validator is suspended; grace keeps access", () => {
  assert.deepEqual(actions([binding("validator-0"), binding("validator-3"), binding("validator-4")]), {
    "vb_validator-0": "keep",     // active
    "vb_validator-3": "keep",     // lapsed: 14 days of grace, access stays
    "vb_validator-4": "suspend",  // revoked
  });
});

test("a suspended binding is restored when the feed gives access again, and not suspended twice", () => {
  const suspended = { access_suspended_at: "2026-11-20T00:00:00Z" };
  assert.deepEqual(actions([binding("validator-0", suspended), binding("validator-4", suspended)]), {
    "vb_validator-0": "restore", "vb_validator-4": "keep",
  });
});

test("a binding the feed says nothing about is left alone", () => {
  const unknown = { ...binding("validator-0"), id: "vb_unknown", validator_id: "validator-9" };
  const otherKey = { ...binding("validator-4"), id: "vb_other_key", ml_dsa_public_key: key("validator-0") };
  const otherChain = { ...binding("validator-4"), id: "vb_other_chain", chain_id: "postfiat-other-1" };
  assert.deepEqual(actions([unknown, otherKey, otherChain]), { vb_unknown: "keep", vb_other_key: "keep" });
});

test("the credit follows a fresh row and nothing else", () => {
  const row = id => ({ ...rows.find(r => r.validator_id === id), feed_observed_at: "2026-11-27T01:40:00Z" });
  assert.deepEqual(creditFromFeedRow(row("validator-0"), now), { eligible: true, reason: "eligible" });
  assert.deepEqual(creditFromFeedRow(row("validator-3"), now), { eligible: false, reason: "below_liveness_threshold" });
  assert.deepEqual(creditFromFeedRow(row("validator-4"), now), { eligible: false, reason: "grace_expired" });
  assert.deepEqual(creditFromFeedRow(null, now), { eligible: false, reason: "no_feed_row" });
  // A row from a feed read more than an hour ago grants nothing, whatever it says.
  assert.deepEqual(creditFromFeedRow(row("validator-0"), new Date(now.getTime() + 3700000)), { eligible: false, reason: "feed_stale" });
});

test("off by default; the URL must be https; the keyset must be a real keyset", () => {
  assert.deepEqual(l1UptimeFeedConfig({}), { configured: false, enforced: false });
  const env = { TASKNODE_L1_UPTIME_FEED_URL: "https://feed.example/validator-uptime-feed.json",
    TASKNODE_L1_UPTIME_FEED_KEYSET_JSON: JSON.stringify(keyset) };
  assert.equal(l1UptimeFeedConfig(env).enforced, false);
  assert.equal(l1UptimeFeedConfig({ ...env, TASKNODE_L1_UPTIME_FEED_ENFORCED: "true" }).enforced, true);
  assert.throws(() => l1UptimeFeedConfig({ ...env, TASKNODE_L1_UPTIME_FEED_URL: "http://feed.example/x.json" }));
  assert.throws(() => l1UptimeFeedConfig({ ...env, TASKNODE_L1_UPTIME_FEED_KEYSET_JSON: JSON.stringify({ ...keyset, threshold: 1 }) }));
});

// A database that records what it is asked, enough to follow the refresh.
function fakeDb(bindings) {
  const log = [];
  const client = { query: async (sql, params) => {
    log.push([sql.replace(/\s+/g, " ").trim().slice(0, 60), params]);
    if (sql.includes("FROM validator_bindings WHERE network")) return { rows: bindings, rowCount: bindings.length };
    if (sql.includes("UPDATE research_api_keys")) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  } };
  return { log, enabled: () => true, query: client.query, transaction: async work => work(client) };
}
const feedResponse = feed => async () => new Response(JSON.stringify(feed));
const env = (extra = {}) => ({ TASKNODE_L1_UPTIME_FEED_URL: "https://feed.example/f.json",
  TASKNODE_L1_UPTIME_FEED_KEYSET_JSON: JSON.stringify(keyset), ...extra });

test("refresh: read without enforcement stores rows and touches no binding", async () => {
  const db = fakeDb([binding("validator-4")]);
  const result = await refreshL1ValidatorAccess({ env: env(), now, db,
    fetchImpl: feedResponse(load("postfiat-validator-uptime-v1.fixture.json")) });
  assert.equal(result.status, "applied");
  assert.equal(result.enforced, false);
  assert.equal(result.validators, 6);
  assert.equal(db.log.filter(([sql]) => sql.startsWith("INSERT INTO l1_validator_access")).length, 6);
  assert.equal(db.log.some(([sql]) => sql.startsWith("UPDATE validator_bindings")), false);
});

test("refresh: enforcement suspends the revoked, revokes its research keys, restores the recovered", async () => {
  const db = fakeDb([binding("validator-0", { access_suspended_at: "2026-11-01T00:00:00Z" }), binding("validator-3"), binding("validator-4")]);
  const result = await refreshL1ValidatorAccess({ env: env({ TASKNODE_L1_UPTIME_FEED_ENFORCED: "true" }), now, db,
    fetchImpl: feedResponse(load("postfiat-validator-uptime-v1.fixture.json")) });
  assert.deepEqual([result.suspended, result.restored, result.researchKeysRevoked], [["validator-4"], ["validator-0"], 2]);
});

test("refresh: a bad, stale or unreachable feed changes nothing", async () => {
  const enforced = env({ TASKNODE_L1_UPTIME_FEED_ENFORCED: "true" });
  const writes = db => db.log.filter(([sql]) => !sql.startsWith("SELECT")).length;
  const tampered = load("postfiat-validator-uptime-v1.fixture.json");
  tampered.validators[0].access_state = "revoked";
  let db = fakeDb([binding("validator-0")]);
  assert.equal((await refreshL1ValidatorAccess({ env: enforced, now, db, fetchImpl: feedResponse(tampered) })).status, "feed_rejected");
  assert.equal(writes(db), 0);
  db = fakeDb([binding("validator-4")]);
  const stale = await refreshL1ValidatorAccess({ env: enforced, now: new Date(now.getTime() + 3700000), db,
    fetchImpl: feedResponse(load("postfiat-validator-uptime-v1.fixture.json")) });
  assert.equal(stale.status, "indeterminate");
  assert.equal(writes(db), 0);
  db = fakeDb([binding("validator-4")]);
  const down = await refreshL1ValidatorAccess({ env: enforced, now, db, fetchImpl: async () => { throw new Error("connect refused"); } });
  assert.equal(down.status, "feed_unavailable");
  assert.equal(writes(db), 0);
});

test("a new binding waits while the feed is indeterminate", async () => {
  const [a, b, c] = keyset.observers.map(observer => observer.observer_id);
  const at = seconds => ({ last_observed_at: `${new Date(now.getTime() - seconds * 1000).toISOString().slice(0, 19)}Z` });
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(60) }, { observer_id: b, ...at(3500) }], keyset, now), true);
  // One fresh observer is not a quorum; an old attestation does not count; neither does an unpinned observer.
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(60) }], keyset, now), false);
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(60) }, { observer_id: b, ...at(3700) }], keyset, now), false);
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(60) }, { observer_id: "somebody-else", ...at(60) }], keyset, now), false);
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(60) }, { observer_id: a, ...at(90) }], keyset, now), false);
  assert.equal(feedAllowsNewBindings([{ observer_id: a, ...at(-600) }, { observer_id: c, ...at(-600) }], keyset, now), false);

  const rows = fresh => async () => ({ rows: fresh ? [{ observer_id: a, ...at(60) }, { observer_id: c, ...at(120) }] : [{ observer_id: a, ...at(60) }] });
  const enforced = env({ TASKNODE_L1_UPTIME_FEED_ENFORCED: "true" });
  await requireFeedForNewBinding({ env: enforced, now, queryImpl: rows(true) });
  await assert.rejects(requireFeedForNewBinding({ env: enforced, now, queryImpl: rows(false) }),
    error => error.status === 503 && error.message === "l1_uptime_feed_indeterminate");
  // Without enforcement nothing is asked and nothing is refused.
  await requireFeedForNewBinding({ env: env(), now, queryImpl: async () => { throw new Error("must not be asked"); } });
  await requireFeedForNewBinding({ env: {}, now, queryImpl: async () => { throw new Error("must not be asked"); } });
});
