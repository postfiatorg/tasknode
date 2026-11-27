// Review of PR 447 (8616a0f44): each test reproduces a finding and fails on that head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  FINANCE_HUB_TIER,
  evaluateFinanceHubAccess,
  evaluateValidatorFinanceHubState,
} from "../server/finance-hub-access.js";
import { createValidatorBundleHandler } from "../server/validator-bundles.js";
import { BUNDLE_FILE_FORMAT } from "../server/validator-bundle-files.js";
import { createFinanceHubRoutesHandler } from "../server/finance-hub-routes.js";
import { libraryRestrictionsFromFiles } from "../server/finance-hub-library.js";
import { sha256Hex, signPublishPayload, verifySignedPublishRequest } from "../server/finance-hub-publish.js";

async function invokeHandler(handler, { method = "GET", pathname, session = null, body = null, headers = {} }) {
  const response = { status: null, headers: {}, body: null };
  const res = {
    writeHead(status, resHeaders = {}) {
      response.status = status;
      response.headers = Object.fromEntries(
        Object.entries(resHeaders).map(([k, v]) => [k.toLowerCase(), v])
      );
    },
    end(payload) {
      response.body = payload;
    },
  };
  const json = (_, status, payload, extraHeaders = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    res.end(payload);
  };
  const readJson = async () => body ?? {};
  const handled = await handler({
    json,
    readJson,
    req: { method, headers },
    res,
    session,
    url: new URL(pathname, "https://tasknode.postfiat.org"),
  });
  return { handled, ...response };
}

// ============================================================================
// (e) An access check that cannot decide refuses (review 447-02, 447-03, 447-04)
// ============================================================================

const L1_KEY = "a".repeat(3904);
const L1_BINDING = {
  id: "bind-l1",
  network: "l1-devnet",
  validator_id: "v1",
  chain_id: "postfiat-wan-devnet-2",
  ml_dsa_public_key: L1_KEY,
  bound_at: "2026-06-01T00:00:00Z",
};
const l1Registry = (row, at) => ({
  chain_id: L1_BINDING.chain_id,
  generated_at: at.toISOString(),
  validators: [{ validator_id: "v1", ml_dsa_public_key: L1_KEY, active: true, ...row }],
});
function memoryValidatorAccess() {
  const states = new Map();
  return {
    states,
    readRecordedState: async (binding) => states.get(binding.id) || null,
    recordState: async (binding, state) => { states.set(binding.id, state); },
  };
}
const feedDown = async () => { throw new Error("feed down"); };

test("(e.1) a failed blacklist or suspension lookup is unavailable, never no restriction", async () => {
  const now = new Date("2026-11-27T10:00:00Z");
  for (const broken of ["getBlacklist", "getSuspension"]) {
    const result = await evaluateFinanceHubAccess({
      accountId: "acct_blocked",
      now,
      env: {},
      getBlacklist: async () => null,
      getSuspension: async () => null,
      getValidatorBindings: async () => [{ network: "devnet" }],
      getTop30Snapshot: async () => null,
      [broken]: async () => { throw new Error("query failed"); },
    });
    assert.equal(result.ok, false, `${broken} failure must refuse`);
    assert.equal(result.reason, "access_check_unavailable");
  }
});

test("(e.2) a feed outage never creates or revives access; only a recorded authorized state is preserved until its expiry", async () => {
  const now = new Date("2026-11-27T10:00:00Z");
  const store = memoryValidatorAccess();
  const fresh = (row, at = now) => evaluateValidatorFinanceHubState({
    bindings: [L1_BINDING], now: at, env: {}, loadL1Registry: async () => l1Registry(row, at), ...store,
  });
  const outage = (at = now, binding = L1_BINDING) => evaluateValidatorFinanceHubState({
    bindings: [binding], now: at, env: {}, loadL1Registry: feedDown, ...store,
  });
  const staleFeed = (at = now) => evaluateValidatorFinanceHubState({
    bindings: [L1_BINDING], now: at, env: {}, loadL1Registry: async () => l1Registry({ access_state: "active" }, new Date(at.getTime() - 2 * 3600_000)), ...store,
  });

  // An old binding with nothing recorded gets nothing from an outage; neither does a missing bound_at.
  assert.equal((await outage()).ok, false);
  assert.equal((await outage(now, { ...L1_BINDING, bound_at: null })).ok, false);
  assert.equal((await staleFeed()).ok, false);

  // A fresh revocation is recorded and stays revoked through an outage.
  assert.equal((await fresh({ access_state: "revoked" })).ok, false);
  assert.equal(store.states.get("bind-l1").access_state, "revoked");
  assert.equal((await outage()).ok, false);
  assert.equal((await outage(new Date("2026-12-20T00:00:00Z"))).ok, false);

  // A fresh active decision is recorded and preserved through an outage, but only until its own expiry.
  assert.equal((await fresh({ access_state: "active" })).ok, true);
  const preserved = await outage(new Date("2026-11-28T10:00:00Z"));
  assert.equal(preserved.ok, true);
  assert.equal(preserved.validatorState, "stale_feed_preserved");
  assert.equal((await staleFeed(new Date("2026-11-28T10:00:00Z"))).ok, true);
  assert.equal((await outage(new Date("2026-12-12T10:00:00Z"))).ok, false);

  // A failed lookup of the recorded state refuses.
  const unreadable = await evaluateValidatorFinanceHubState({
    bindings: [L1_BINDING], now, env: {}, loadL1Registry: feedDown,
    readRecordedState: async () => { throw new Error("db down"); }, recordState: async () => {},
  });
  assert.equal(unreadable.ok, false);
});

test("(e.3) validator grace starts at a recorded time, ramp-in is bounded, and a valid lapse grace survives active:false", async () => {
  const now = new Date("2026-11-27T10:00:00Z");
  const later = new Date("2027-01-06T10:00:00Z");
  const run = (row, at, store) => evaluateValidatorFinanceHubState({
    bindings: [L1_BINDING], now: at, env: {}, loadL1Registry: async () => l1Registry(row, at), ...store,
  });

  // A lapsed row with no recorded start is refused, not given a new 14 days, now or 40 days later.
  const unrecorded = memoryValidatorAccess();
  assert.equal((await run({ access_state: "lapsed" }, now, unrecorded)).ok, false);
  assert.equal((await run({ access_state: "lapsed" }, later, unrecorded)).ok, false);

  // After a recorded active state, grace runs 14 days from that record and is not re-issued per request.
  const recorded = memoryValidatorAccess();
  assert.equal((await run({ access_state: "active" }, now, recorded)).ok, true);
  const lapsed = await run({ access_state: "lapsed" }, new Date("2026-11-30T10:00:00Z"), recorded);
  assert.equal(lapsed.basis, "grace");
  assert.equal(lapsed.graceEndsAt, "2026-12-11T10:00:00.000Z");
  const again = await run({ access_state: "lapsed" }, new Date("2026-12-05T10:00:00Z"), recorded);
  assert.equal(again.graceEndsAt, "2026-12-11T10:00:00.000Z");
  assert.equal((await run({ access_state: "lapsed" }, later, recorded)).ok, false);

  // A six-month-old binding without enough observed days is past ramp-in: no validator access.
  const oldBinding = await run({}, now, memoryValidatorAccess());
  assert.notEqual(oldBinding.basis, "validator");
  assert.equal(oldBinding.ok, false);
  // A fresh binding inside the 30-day ramp-in still gets in.
  const rampIn = await evaluateValidatorFinanceHubState({
    bindings: [{ ...L1_BINDING, bound_at: "2026-11-20T00:00:00Z" }], now, env: {},
    loadL1Registry: async () => l1Registry({}, now), ...memoryValidatorAccess(),
  });
  assert.equal(rampIn.ok, true);
  assert.equal(rampIn.validatorState, "pending");

  // Pillar 3: falling out of the registry enters lapsed; an unexpired feed grace is honoured.
  const inactive = await run({ active: false, access_state: "lapsed", grace_ends_at: "2026-12-01T00:00:00Z" }, now, memoryValidatorAccess());
  assert.equal(inactive.ok, true);
  assert.equal(inactive.basis, "grace");
  assert.equal(inactive.graceEndsAt, "2026-12-01T00:00:00.000Z");
});

// ============================================================================
// (f) Library item restrictions apply on every route (review 447-07, 447-21)
// ============================================================================

test("(f) a Library item's allowed_bases applies to Today, Library and the direct file route; an empty list admits nobody", async () => {
  const restricted = { id: "validator-only", title: "CONFIDENTIAL_VALIDATOR_REPORT", url: "/api/research/bundles/ga-models/restricted.html", allowed_bases: ["validator"] };
  const nobody = { id: "nobody", title: "EMPTY_POLICY_ITEM", path: "nobody.html", allowed_bases: [] };
  const open = { id: "open", title: "OPEN_ITEM", url: "/api/research/bundles/ga-models/open.html" };
  const bundle = {
    "hub/library.json": Buffer.from(JSON.stringify({ items: [restricted, nobody, open] })),
    "hub/today.json": Buffer.from(JSON.stringify({ library: [restricted] })),
    "restricted.html": Buffer.from("CONFIDENTIAL_VALIDATOR_REPORT"),
    "nobody.html": Buffer.from("EMPTY_POLICY_ITEM"),
    "open.html": Buffer.from("OPEN_ITEM"),
  };
  // The restriction map is trusted publication metadata, derived from the bundle at publish time.
  const libraryRestrictions = libraryRestrictionsFromFiles(
    Object.entries(bundle).map(([filePath, bytes]) => ({ path: filePath, bytes })), "ga-models");
  assert.deepEqual(libraryRestrictions, { "restricted.html": ["validator"], "nobody.html": [] });
  const index = {
    indexId: "ga-models",
    tier: FINANCE_HUB_TIER,
    contentHash: "hash-lib",
    availableAt: "2026-01-01T00:00:00Z",
    metadata: { fileFormat: BUNDLE_FILE_FORMAT, allowedBases: ["top30", "validator"], libraryRestrictions },
  };
  const reads = [];
  const loadFile = async (_id, _ix, filePath) => {
    reads.push(filePath);
    if (bundle[filePath]) return bundle[filePath];
    const error = new Error("bundle_file_not_found");
    error.status = 404;
    throw error;
  };
  const asBasis = (basis) => async () => ({ ok: true, basis });
  const body = (res) => (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : JSON.stringify(res.body));

  for (const [basis, sees] of [["top30", ["OPEN_ITEM"]], ["validator", ["CONFIDENTIAL_VALIDATOR_REPORT", "OPEN_ITEM"]]]) {
    const api = createFinanceHubRoutesHandler({ readIndex: async () => index, checkAccess: asBasis(basis), loadFile, readUserState: async () => ({}) });
    const files = createValidatorBundleHandler({ readIndex: async () => index, meetsTier: asBasis(basis), loadFile, accessGuard: null, watermarkSecret: "s" });
    const library = await invokeHandler(api, { pathname: "/api/finance-hub/library", session: { accountId: "acct" } });
    const today = await invokeHandler(api, { pathname: "/api/finance-hub/today", session: { accountId: "acct" } });
    assert.deepEqual(library.body.items.map((item) => item.title), sees);
    assert.deepEqual(today.body.library.map((item) => item.title), sees);
    const manifest = await invokeHandler(files, { pathname: "/api/research/bundles/ga-models/hub/library.json", session: { accountId: "acct" } });
    assert.equal(manifest.status, 200);
    assert.deepEqual(JSON.parse(body(manifest)).items.map((item) => item.title), sees);
    assert.equal(body(manifest).includes("EMPTY_POLICY_ITEM"), false);

    reads.length = 0;
    const report = await invokeHandler(files, { pathname: "/api/research/bundles/ga-models/restricted.html", session: { accountId: "acct" } });
    assert.equal(report.status, basis === "validator" ? 200 : 403, `${basis} on restricted.html`);
    if (basis !== "validator") {
      assert.equal(report.body.error, "library_item_basis_not_allowed");
      assert.equal(reads.includes("restricted.html"), false, "the restricted file must not be read before the check");
    }
    const empty = await invokeHandler(files, { pathname: "/api/research/bundles/ga-models/nobody.html", session: { accountId: "acct" } });
    assert.equal(empty.status, 403);
    const openFile = await invokeHandler(files, { pathname: "/api/research/bundles/ga-models/open.html", session: { accountId: "acct" } });
    assert.equal(openFile.status, 200);
  }

  // 447-21: an explicitly empty publication policy admits nobody; only absence falls back to the tier.
  const emptyPolicy = await evaluateFinanceHubAccess({
    accountId: "acct_validator",
    index: { tier: FINANCE_HUB_TIER, metadata: { allowedBases: [] } },
    env: {},
    getBlacklist: async () => null,
    getSuspension: async () => null,
    getValidatorBindings: async () => [{ network: "devnet" }],
    getTop30Snapshot: async () => null,
  });
  assert.equal(emptyPolicy.ok, false);
  assert.equal(emptyPolicy.reason, "publication_basis_not_allowed");
});

// ============================================================================
// (g) Public content is scanned as it will be served (review 447-05)
// ============================================================================

test("(g) public publications are decoded before the leak scan and their JSON must match the PR 446 schemas", async () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const key = { algorithm: "hmac-sha256", keyId: "review-key", hmacSecret: Buffer.alloc(32, 1) };
  const keyRing = new Map(["goodbrief", "finance-hub-public"].map((id) => [`${id}:review-key`, key]));
  const file = (filePath, bytes, encoding = "identity", contentType = "application/json") => ({
    path: filePath, sha256: sha256Hex(bytes), size_bytes: bytes.length, content_type: contentType, encoding, content_base64: bytes.toString("base64"),
  });
  const verify = (indexId, files) => verifySignedPublishRequest(signPublishPayload({
    schema_version: "finance-hub.publish-payload.v1",
    index_id: indexId,
    tier: indexId === "finance-hub-public" ? "public_safe" : "finance_hub",
    allowed_bases: indexId === "finance-hub-public" ? ["public"] : ["validator"],
    version: 1,
    operation: "publish",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 300_000).toISOString(),
    nonce: "review_nonce_1234567890_abcdef",
    title: "review",
    manifest_sha256: "0".repeat(64),
    total_bytes: files.reduce((sum, entry) => sum + entry.size_bytes, 0),
    files,
    render_gate: { passed: true, shrink_guard_passed: true, public_leak_scan_passed: true, file_count: files.length },
  }, key), { keyRing, currentVersion: 0, hasSeenNonce: async () => false, nowMs: now });

  const gzSecret = gzipSync(Buffer.from("Our price target is $240."));
  const hidden = await verify("finance-hub-public", [file("public/briefs/a.txt", gzSecret, "gzip", "text/plain")]);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.error, "public_leak_detected");

  const wrongSchema = Buffer.from(JSON.stringify({ schema_version: "not-a-brief", anything: "arbitrary extra field" }));
  const invalid = await verify("finance-hub-public", [file("public/briefs/ABC.json", wrongSchema)]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "public_schema_invalid");

  const brief = {
    schema_version: "finance-hub.agent-brief-public.v1",
    index_scope: "public_safe",
    model_id: "NVDA", ticker: "NVDA", name: "NVIDIA Corporation", asset_class: "perp_megacap_equity",
    generated_at: "2026-11-27T01:00:00Z", publication_version: 42,
    public_summary: "NVIDIA designs GPU compute platforms, networking interconnects, and CUDA software stacks deployed across public cloud hyperscalers and enterprise AI clusters.",
    area_tags: ["ai-accelerators", "datacenter-capex"],
    public_topics: [{
      topic_id: "cloud-inference-utilization",
      title: "Public cloud GPU instance availability and queue behavior",
      description: "Observable cloud instance pricing, waitlist behavior, and deployment lead times reported by infrastructure buyers in public markets.",
      observable_by: ["operator", "customer"],
    }],
    public_questions: [{
      question_id: "q-triangulate-role",
      prompt: "Which public cloud or open-benchmark GPU workloads do you directly observe in your day-to-day technical work?",
      phase: "triangulation", mnpi_safe_verified: true,
    }],
    redaction_attestation: {
      contains_price_targets: false, contains_internal_estimates: false, contains_member_claims: false,
      contains_private_memory: false, leak_scan_passed: true, scanner_version: "public-brief-guard-v1",
    },
  };
  const briefBytes = Buffer.from(JSON.stringify(brief));
  const gzBrief = gzipSync(briefBytes);
  const valid = await verify("finance-hub-public", [file("public/briefs/NVDA.json", gzBrief, "gzip")]);
  assert.equal(valid.ok, true, JSON.stringify(valid.details));
  assert.deepEqual(valid.decodedFiles[0].bytes, briefBytes, "the served representation is the decoded content");
  const misnamed = await verify("finance-hub-public", [file("public/briefs/AMD.json", briefBytes)]);
  assert.equal(misnamed.error, "public_schema_invalid");

  // Gated bundles also store what they will serve: decoded, since no Content-Encoding is kept.
  const html = Buffer.from("<article>Goodbrief</article>");
  const gated = await verify("goodbrief", [file("index.html", gzipSync(html), "gzip", "text/html")]);
  assert.equal(gated.ok, true);
  assert.deepEqual(gated.decodedFiles[0].bytes, html);
  const corrupt = await verify("goodbrief", [file("index.html", Buffer.from("not gzip"), "gzip", "text/html")]);
  assert.equal(corrupt.error, "file_encoding_invalid");
});
