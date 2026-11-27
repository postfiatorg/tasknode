import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createValidatorBundleHandler } from "../server/validator-bundles.js";
import { BUNDLE_FILE_FORMAT, createBundleFileLoader, encryptBundleFile } from "../server/validator-bundle-files.js";
import {
  FINANCE_HUB_TIER,
  GOODBRIEF_SANDBOX_ATTR,
  GOODBRIEF_SRCDOC_CSP,
  buildFinanceHubWatermark,
  createFinanceHubAccessGuard,
  evaluateFinanceHubAccess,
  evaluateValidatorFinanceHubState,
  isFinanceHubProtectedIndex,
  prepareGoodbriefSrcDoc,
} from "../server/finance-hub-access.js";
import {
  computeTop30Snapshot,
  lookupTop30Entitlement,
  runDailyTop30SnapshotJob,
} from "../server/finance-hub-top30.js";
import {
  createFinanceHubPublishHandler,
  sha256Hex,
  signPublishPayload,
} from "../server/finance-hub-publish.js";
import { createFinanceHubRoutesHandler } from "../server/finance-hub-routes.js";
import {
  GOODBRIEF_SANDBOX_ATTR as CLIENT_GOODBRIEF_SANDBOX,
  GOODBRIEF_SRCDOC_CSP as CLIENT_GOODBRIEF_CSP,
  buildGoodbriefSrcDoc,
  escapePlainText,
  formatAccessBasisBadge,
  isNewSinceBaseline,
  matchesTodayFilters,
  sortWithWatchlistFirst,
} from "../src/features/research/goodbrief-sandbox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function makeCandidate(index, overrides = {}) {
  return {
    account_id: `acct_${String(index).padStart(3, "0")}`,
    network_tasks: 100 - index,
    personal_tasks: 20,
    rewards_pft: 25_000,
    alignment_score: 50,
    is_public_profile: index % 2 === 0,
    ...overrides,
  };
}

function createMemoryPublishStore() {
  const versions = new Map();
  const nonces = new Set();
  const manifests = new Map();
  const indices = new Map();
  const files = new Map();

  return {
    indices,
    files,
    versions,
    async withIndexLock(indexId, work) {
      const currentVersion = versions.get(indexId) || 0;
      return work({
        currentVersion,
        hasSeenNonce: async (id, nonce) => nonces.has(`${id}:${nonce}`),
        hasHistoricalManifest: async (id, manifestSha256) => manifests.get(`${id}:${manifestSha256}`) || null,
        commitPublish: async ({ payload, manifestSha256, decodedFiles, historicalManifest }) => {
          const contentKey = indices.get(indexId)?.contentKey || randomBytes(32).toString("base64");
          const bundleHash = payload.operation === "rollback"
            ? historicalManifest.bundle_hash
            : sha256Hex(`${indexId}:${payload.version}:${manifestSha256}`);

          if (payload.operation === "publish" && decodedFiles) {
            for (const file of decodedFiles) {
              const encrypted = encryptBundleFile(file.bytes, indexId, { contentHash: bundleHash, contentKey }, file.path);
              files.set(`${indexId}:${bundleHash}:${file.path}`, encrypted);
            }
          }
          versions.set(indexId, payload.version);
          nonces.add(`${indexId}:${payload.nonce}`);
          manifests.set(`${indexId}:${manifestSha256}`, {
            version: payload.version,
            manifest_sha256: manifestSha256,
            bundle_hash: bundleHash,
          });
          indices.set(indexId, {
            indexId,
            title: payload.title,
            summary: payload.summary || "",
            tier: payload.tier,
            contentKey,
            contentHash: bundleHash,
            availableAt: "2026-01-01T00:00:00Z",
            publishedAt: payload.issued_at,
            metadata: {
              fileFormat: BUNDLE_FILE_FORMAT,
              wholeBundleDisabled: indexId !== "finance-hub-public",
              allowedBases: payload.allowed_bases,
              version: payload.version,
              manifestSha256,
            },
          });
          return { bundleHash };
        },
      });
    },
  };
}

// ============================================================================
// (a) Unauthorized users get ZERO leaked bundle content; strict access gating,
//     whole-bundle closure, watermarks, rate limiting & scrape alerts
// ============================================================================

test("(a) unauthorized users get zero leaked bundle content across content, unlock, bundle, today & goodbrief routes", async () => {
  const secretPayload = Buffer.from("<html><head></head><body>SECRET_ALPHA_TARGET_$999</body></html>", "utf8");
  const goodbriefSecret = Buffer.from("<html><head></head><body>SECRET_GOODBRIEF_MACRO</body></html>", "utf8");
  const contentKey = randomBytes(32).toString("base64");
  const gaIndex = {
    indexId: "ga-models",
    tier: FINANCE_HUB_TIER,
    contentKey,
    contentHash: "hash-ga-v1",
    availableAt: "2026-01-01T00:00:00Z",
    metadata: { fileFormat: BUNDLE_FILE_FORMAT, allowedBases: ["validator", "top30", "grace"] },
  };
  const gbIndex = {
    indexId: "goodbrief",
    tier: FINANCE_HUB_TIER,
    contentKey,
    contentHash: "hash-gb-v1",
    availableAt: "2026-01-01T00:00:00Z",
    metadata: { fileFormat: BUNDLE_FILE_FORMAT, allowedBases: ["validator", "top30"] },
  };

  assert.equal(isFinanceHubProtectedIndex("ga-models", gaIndex), true);
  assert.equal(isFinanceHubProtectedIndex("goodbrief", gbIndex), true);

  let fileReads = 0;
  const loader = createBundleFileLoader({
    fetchFile: async (id, ix, filePath) => {
      fileReads += 1;
      if (id === "ga-models" && filePath === "index.html") return encryptBundleFile(secretPayload, id, ix, filePath);
      if (id === "goodbrief" && filePath === "index.html") return encryptBundleFile(goodbriefSecret, id, ix, filePath);
      return null;
    },
  });

  const blacklisted = new Set(["acct_blacklisted"]);
  const suspended = new Set(["acct_suspended"]);
  const validators = new Map([
    ["acct_validator", [{ network: "l1-devnet", p3_access_state: "active" }]],
    ["acct_validator_revoked", [{ network: "l1-devnet", p3_access_state: "revoked" }]],
    ["acct_validator_lapsed", [{ network: "l1-devnet", p3_access_state: "lapsed", grace_ends_at: "2026-12-10T00:00:00Z" }]],
  ]);
  const top30Snapshot = {
    snapshot_at: "2026-11-27T00:00:00Z",
    entries: [
      { account_id: "acct_top30", rank: 12, access_basis: "top30", entitlement_state: "seated_top30", grace_started_at: null, grace_ends_at: null },
      { account_id: "acct_grace", rank: 37, access_basis: "grace", entitlement_state: "grace_7d", grace_started_at: "2026-11-25T00:00:00Z", grace_ends_at: "2026-12-02T00:00:00Z" },
    ],
  };

  const now = new Date("2026-11-27T01:00:00Z");
  const checkAccess = ({ accountId, tier, index }) => evaluateFinanceHubAccess({
    accountId,
    tier,
    index,
    now,
    getBlacklist: async ({ accountId: id }) => (blacklisted.has(id) ? { id: "blk_1" } : null),
    getSuspension: async (id) => (suspended.has(id) ? { id: "sus_1" } : null),
    getValidatorBindings: async (id) => validators.get(id) || [],
    getTop30Snapshot: async () => top30Snapshot,
  });

  const accessLogs = [];
  const scrapeAlerts = [];
  const accessGuard = createFinanceHubAccessGuard({
    maxRequestsPerWindow: 20,
    scrapeUniqueFilesThreshold: 2,
    onAccessLog: (entry) => accessLogs.push(entry),
    onScrapeAlert: (alert) => scrapeAlerts.push(alert),
  });

  const bundleHandler = createValidatorBundleHandler({
    readIndex: async (id) => (id === "ga-models" ? gaIndex : id === "goodbrief" ? gbIndex : null),
    meetsTier: checkAccess,
    loadFile: loader.load,
    loadEncrypted: () => assert.fail("whole-bundle encrypted archive must never be read for Finance Hub"),
    loadFiles: () => assert.fail("whole-bundle decrypted archive must never be read"),
    accessGuard,
    watermarkSecret: "test-wm-secret",
  });

  // 1. Whole-bundle /content downloads MUST be rejected for both ga-models and goodbrief, even for entitled validators!
  for (const id of ["ga-models", "goodbrief"]) {
    const res = await invokeHandler(bundleHandler, {
      pathname: `/api/index-viewer/indices/${id}/content`,
      session: { accountId: "acct_validator" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "whole_bundle_download_disabled");
    assert.ok(!JSON.stringify(res.body).includes("SECRET_"));
  }

  // 2. Unauthenticated, rank-31 outsider, revoked validator, blacklisted, and suspended users get 403 and ZERO bundle bytes!
  for (const [acct, expectedReason] of [
    [null, "not_signed_in"],
    ["acct_outsider", "finance_hub_access_required"],
    ["acct_validator_revoked", "finance_hub_access_required"],
    ["acct_blacklisted", "account_blacklisted"],
    ["acct_suspended", "finance_hub_suspended"],
  ]) {
    const res = await invokeHandler(bundleHandler, {
      pathname: "/api/research/bundles/ga-models/index.html",
      session: acct ? { accountId: acct } : null,
    });
    assert.equal(res.status, 403, `expected 403 for ${acct}`);
    assert.equal(res.body.error, expectedReason);
    assert.ok(!JSON.stringify(res.body).includes("SECRET_ALPHA_TARGET"));
  }
  assert.equal(fileReads, 0, "denied users must never trigger bundle decryption or file reads");

  // 3. Per-publication allowed_bases check: goodbrief allows ["validator", "top30"] ONLY -> grace user denied on goodbrief, allowed on ga-models!
  const graceOnGoodbrief = await invokeHandler(bundleHandler, {
    pathname: "/api/research/bundles/goodbrief/index.html",
    session: { accountId: "acct_grace" },
  });
  assert.equal(graceOnGoodbrief.status, 403);
  assert.equal(graceOnGoodbrief.body.error, "publication_basis_not_allowed");
  assert.ok(!JSON.stringify(graceOnGoodbrief.body).includes("SECRET_GOODBRIEF_MACRO"));

  const graceOnModels = await invokeHandler(bundleHandler, {
    pathname: "/api/research/bundles/ga-models/index.html",
    session: { accountId: "acct_grace" },
  });
  assert.equal(graceOnModels.status, 200);
  assert.ok(graceOnModels.headers["x-finance-hub-watermark"]?.startsWith("fh-"));
  assert.ok(graceOnModels.body.toString("utf8").includes("SECRET_ALPHA_TARGET_$999"));
  assert.ok(graceOnModels.body.toString("utf8").includes(graceOnModels.headers["x-finance-hub-watermark"]));

  // 4. Active validator & Top-30 user get distinct deterministic watermarks, and CSP drops 'unsafe-inline' on script-src!
  const valRes = await invokeHandler(bundleHandler, {
    pathname: "/api/research/bundles/ga-models/index.html",
    session: { accountId: "acct_validator" },
  });
  const top30Res = await invokeHandler(bundleHandler, {
    pathname: "/api/research/bundles/ga-models/index.html",
    session: { accountId: "acct_top30" },
  });
  assert.equal(valRes.status, 200);
  assert.equal(top30Res.status, 200);
  assert.notEqual(valRes.headers["x-finance-hub-watermark"], top30Res.headers["x-finance-hub-watermark"]);
  assert.match(valRes.headers["content-security-policy"], /script-src 'self';/);
  assert.ok(!valRes.headers["content-security-policy"].includes("script-src 'self' 'unsafe-inline'"));

  // 5. Scrape anomaly alert fires when a single account fetches >= threshold unique files.
  const gbRes = await invokeHandler(bundleHandler, {
    pathname: "/api/research/bundles/goodbrief/index.html",
    session: { accountId: "acct_validator" },
  });
  assert.equal(gbRes.status, 200);
  assert.equal(scrapeAlerts.length, 1);
  assert.equal(scrapeAlerts[0].accountId, "acct_validator");
  assert.ok(accessLogs.length >= 4);

  // 6. Finance Hub Today & Goodbrief shell routes also fail closed with zero leaked content for outsiders.
  const hubRoutes = createFinanceHubRoutesHandler({
    readIndex: async (id) => (id === "ga-models" ? gaIndex : id === "goodbrief" ? gbIndex : null),
    checkAccess,
    loadFile: loader.load,
    readUserState: async () => ({ watchlist: ["NVDA"], visitBaselineAt: "2026-11-26T00:00:00Z", goodbriefNotifyEnabled: false }),
    now: () => now,
  });
  const outsiderToday = await invokeHandler(hubRoutes, { pathname: "/api/finance-hub/today", session: { accountId: "acct_outsider" } });
  assert.equal(outsiderToday.status, 403);
  assert.ok(!JSON.stringify(outsiderToday.body).includes("SECRET_"));

  const graceGoodbriefApi = await invokeHandler(hubRoutes, { pathname: "/api/finance-hub/goodbrief", session: { accountId: "acct_grace" } });
  assert.equal(graceGoodbriefApi.status, 403);
  assert.equal(graceGoodbriefApi.body.error, "publication_basis_not_allowed");

  // 7. Verify index-viewer unlock route source explicitly disables whole-bundle unlock for Finance Hub protected indices.
  const indexViewerSrc = readFileSync(path.join(ROOT, "server", "index-viewer-routes.js"), "utf8");
  assert.match(indexViewerSrc, /isFinanceHubProtectedIndex\(indexId, index\)/);
  assert.match(indexViewerSrc, /whole_bundle_unlock_disabled/);
});

test("(a.2) Pillar 3 stale validator feed (>1h) preserves existing validator access and blocks brand-new grants", async () => {
  const now = new Date("2026-11-27T02:00:00Z");
  const staleRegistry = async () => ({
    schema: "postfiat-tasknode-l1-registry-v1",
    generated_at: "2026-11-27T00:30:00Z", // 90 minutes old (> 3600s)
    validators: [],
  });

  const existingBound = await evaluateValidatorFinanceHubState({
    bindings: [{ network: "l1-devnet", validator_id: "val-1", bound_at: "2026-11-01T00:00:00Z" }],
    loadL1Registry: staleRegistry,
    now,
  });
  assert.equal(existingBound.ok, true);
  assert.equal(existingBound.basis, "validator");
  assert.equal(existingBound.validatorState, "stale_feed_preserved");
  assert.equal(existingBound.feedStale, true);

  const brandNewBound = await evaluateValidatorFinanceHubState({
    bindings: [{ network: "l1-devnet", validator_id: "val-new", bound_at: "2026-11-27T01:55:00Z" }],
    loadL1Registry: staleRegistry,
    now,
  });
  assert.equal(brandNewBound.ok, false);
});

// ============================================================================
// (b) Signed Publish API (Ed25519 + HMAC-SHA256, replay window, bad sigs -> 401/403)
// ============================================================================

test("(b) Signed Publish API verifies Ed25519/HMAC, 2-key rotation, monotonic rollbacks, and rejects tampered/invalid/stale signatures", async () => {
  const nowIso = "2026-11-27T01:30:00Z";
  const nowMs = Date.parse(nowIso);
  const expiresIso = "2026-11-27T01:35:00Z";

  const edPrimary = generateKeyPairSync("ed25519");
  const edNext = generateKeyPairSync("ed25519");
  const hmacSecret = randomBytes(32);

  const keyRing = new Map([
    ["ga-models:ga-ed-k1", { algorithm: "ed25519", publicKey: edPrimary.publicKey }],
    ["ga-models:ga-ed-k2", { algorithm: "ed25519", publicKey: edNext.publicKey }],
    ["goodbrief:gb-hmac-k1", { algorithm: "hmac-sha256", hmacSecret }],
    ["finance-hub-public:pub-ed-k1", { algorithm: "ed25519", publicKey: edPrimary.publicKey }],
  ]);

  const store = createMemoryPublishStore();
  const handler = createFinanceHubPublishHandler({
    getKeyRing: () => keyRing,
    store,
    now: () => nowMs,
  });

  const htmlV1 = Buffer.from("<!doctype html><html><head></head><body><h1>Models v1</h1></body></html>", "utf8");
  const makeGaPayload = (version, nonce, bytes = htmlV1, overrides = {}) => ({
    schema_version: "finance-hub.publish-payload.v1",
    index_id: "ga-models",
    tier: "finance_hub",
    allowed_bases: ["validator", "top30", "grace"],
    version,
    operation: "publish",
    issued_at: nowIso,
    expires_at: expiresIso,
    nonce,
    title: "Finance Hub Models",
    summary: `Build v${version}`,
    manifest_sha256: "0".repeat(64),
    total_bytes: bytes.length,
    files: [{
      path: "index.html",
      sha256: sha256Hex(bytes),
      size_bytes: bytes.length,
      content_type: "text/html; charset=utf-8",
      encoding: "identity",
      content_base64: bytes.toString("base64"),
    }],
    render_gate: { passed: true, shrink_guard_passed: true, public_leak_scan_passed: false, file_count: 1 },
    ...overrides,
  });

  // 1. Valid Ed25519 publish (primary key) succeeds.
  const signedV1 = signPublishPayload(makeGaPayload(1, "nonce_ga_models_v1_aaaaaaaaaaaa"), {
    algorithm: "ed25519",
    keyId: "ga-ed-k1",
    privateKey: edPrimary.privateKey,
  });
  const resV1 = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: signedV1 });
  assert.equal(resV1.status, 201);
  assert.equal(resV1.body.ok, true);
  assert.equal(resV1.body.version, 1);

  // 2. Replayed version rejected with 409; replayed nonce on higher version rejected with 409.
  const replayVer = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: signedV1 });
  assert.equal(replayVer.status, 409);
  assert.equal(replayVer.body.error, "version_not_monotonic");

  const replayNonce = signPublishPayload(makeGaPayload(2, "nonce_ga_models_v1_aaaaaaaaaaaa"), {
    algorithm: "ed25519",
    keyId: "ga-ed-k1",
    privateKey: edPrimary.privateKey,
  });
  const replayNonceRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: replayNonce });
  assert.equal(replayNonceRes.status, 409);
  assert.equal(replayNonceRes.body.error, "nonce_replayed");

  // 3. Tampered payload / bad Ed25519 signature / wrong key / cross-index key rejected with 401!
  const tamperedTitle = { ...structuredClone(signedV1), version: 2, nonce: "nonce_ga_models_tamper_1234567890", title: "Pwned Hub" };
  const tamperedRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: tamperedTitle });
  assert.equal(tamperedRes.status, 401);
  assert.equal(tamperedRes.body.error, "digest_mismatch");

  const badSig = signPublishPayload(makeGaPayload(2, "nonce_ga_models_badsig_1234567890"), {
    algorithm: "ed25519",
    keyId: "ga-ed-k1",
    privateKey: edNext.privateKey, // Wrong private key for ga-ed-k1!
  });
  const badSigRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: badSig });
  assert.equal(badSigRes.status, 401);
  assert.equal(badSigRes.body.error, "signature_invalid");

  // Cross-index key isolation: goodbrief HMAC key MUST NOT publish to ga-models.
  const crossIndex = signPublishPayload(makeGaPayload(2, "nonce_ga_models_cross_1234567890"), {
    algorithm: "hmac-sha256",
    keyId: "gb-hmac-k1",
    hmacSecret,
  });
  const crossIndexRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: crossIndex });
  assert.equal(crossIndexRes.status, 401);
  assert.equal(crossIndexRes.body.error, "unknown_or_mismatched_key");

  // 4. Stale / expired signature rejected with 401!
  const stale = signPublishPayload(
    makeGaPayload(2, "nonce_ga_models_stale_1234567890", htmlV1, {
      issued_at: "2026-11-27T01:15:00Z",
      expires_at: "2026-11-27T01:20:00Z",
    }),
    { algorithm: "ed25519", keyId: "ga-ed-k1", privateKey: edPrimary.privateKey }
  );
  const staleRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: stale });
  assert.equal(staleRes.status, 401);
  assert.equal(staleRes.body.error, "issued_at_out_of_window");

  // 5. 2-key rotation (next key) succeeds for v2, and monotonic-version signed rollback to v1 succeeds at v3!
  const htmlV2 = Buffer.from("<!doctype html><html><head></head><body><h1>Models v2</h1></body></html>", "utf8");
  const signedV2 = signPublishPayload(makeGaPayload(2, "nonce_ga_models_v2_bbbbbbbbbbbb", htmlV2), {
    algorithm: "ed25519",
    keyId: "ga-ed-k2",
    privateKey: edNext.privateKey,
  });
  assert.equal((await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: signedV2 })).status, 201);

  const rollbackV3 = signPublishPayload(
    {
      ...makeGaPayload(3, "nonce_ga_models_rb_v3_cccccccccc", htmlV1, {
        operation: "rollback",
        rollback_target_version: 1,
        rollback_of_manifest_sha256: signedV1.manifest_sha256,
      }),
      files: [{
        path: "index.html",
        sha256: sha256Hex(htmlV1),
        size_bytes: htmlV1.length,
        content_type: "text/html; charset=utf-8",
        encoding: "identity",
      }],
    },
    { algorithm: "ed25519", keyId: "ga-ed-k2", privateKey: edNext.privateKey }
  );
  const rbRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: rollbackV3 });
  assert.equal(rbRes.status, 201);
  assert.equal(rbRes.body.version, 3);
  assert.equal(rbRes.body.bundle_hash, resV1.body.bundle_hash);

  // 6. Decoupled HMAC-signed Goodbrief publish succeeds independently.
  const gbHtml = Buffer.from("<article>Goodbrief Macro Roundup</article>", "utf8");
  const gbSigned = signPublishPayload(
    makeGaPayload(1, "nonce_goodbrief_v1_dddddddddddd", gbHtml, { index_id: "goodbrief", title: "Goodbrief" }),
    { algorithm: "hmac-sha256", keyId: "gb-hmac-k1", hmacSecret }
  );
  assert.equal((await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: gbSigned })).status, 201);

  // 7. Public index anti-leak scanner blocks price targets / internal estimates with 403!
  const leakyBrief = Buffer.from(JSON.stringify({ public_summary: "Our price target of $240 implies +45% upside." }), "utf8");
  const leakySigned = signPublishPayload(
    {
      schema_version: "finance-hub.publish-payload.v1",
      index_id: "finance-hub-public",
      tier: "public_safe",
      allowed_bases: ["public"],
      version: 1,
      operation: "publish",
      issued_at: nowIso,
      expires_at: expiresIso,
      nonce: "nonce_public_leak_1234567890abcdef",
      title: "Public Briefs",
      manifest_sha256: "0".repeat(64),
      total_bytes: leakyBrief.length,
      files: [{
        path: "public/briefs/NVDA.json",
        sha256: sha256Hex(leakyBrief),
        size_bytes: leakyBrief.length,
        content_type: "application/json",
        encoding: "identity",
        content_base64: leakyBrief.toString("base64"),
      }],
      render_gate: { passed: true, shrink_guard_passed: true, public_leak_scan_passed: true, file_count: 1 },
    },
    { algorithm: "ed25519", keyId: "pub-ed-k1", privateKey: edPrimary.privateKey }
  );
  const leakRes = await invokeHandler(handler, { method: "POST", pathname: "/api/research/publish", body: leakySigned });
  assert.equal(leakRes.status, 403);
  assert.equal(leakRes.body.error, "public_leak_detected");
});

// ============================================================================
// (c) Daily Top-30 + rank 31-35 hysteresis + 7-day grace + 30-day cooldown
// ============================================================================

test("(c) Top-30 snapshot enforces leaderboard formula, private accounts, non-validator seats, rank 31-35 hysteresis, 7d grace & 30d anti-bounce cooldown", async () => {
  // Build 42 accounts: 2 active validators (high scores), 1 blacklisted (high score), 39 non-validator accounts (including private accounts + exact tie).
  const day1 = new Date("2026-11-01T00:00:00Z");
  const candidates = [
    makeCandidate(0, { account_id: "acct_val_top", network_tasks: 500 }),
    makeCandidate(0, { account_id: "acct_val_second", network_tasks: 499 }),
    makeCandidate(0, { account_id: "acct_blk_top", network_tasks: 498 }),
    // Exact score tie between private acct_001_a and public acct_001_b -> deterministic tie-break account_id ASC!
    makeCandidate(1, { account_id: "acct_001_b", network_tasks: 120, personal_tasks: 10, rewards_pft: 50_000, alignment_score: 80, is_public_profile: true }),
    makeCandidate(1, { account_id: "acct_001_a", network_tasks: 120, personal_tasks: 10, rewards_pft: 50_000, alignment_score: 80, is_public_profile: false }),
  ];
  for (let i = 3; i <= 40; i += 1) {
    candidates.push(makeCandidate(i));
  }

  const day1Res = computeTop30Snapshot({
    candidates,
    activeValidatorAccountIds: new Set(["acct_val_top", "acct_val_second"]),
    blacklistedOrSuspendedAccountIds: new Set(["acct_blk_top"]),
    now: day1,
  });
  const snap1 = day1Res.snapshot;

  assert.equal(snap1.summary.excluded_active_validators, 2);
  assert.equal(snap1.summary.excluded_blacklisted_or_suspended, 1);
  assert.equal(snap1.summary.seated_count, 30, "must award exactly 30 non-validator seats");
  assert.equal(snap1.summary.hysteresis_retained_count, 0);
  assert.equal(snap1.summary.grace_count, 0);

  // Private account included and wins deterministic account_id ASC tie-break.
  assert.equal(snap1.entries[0].account_id, "acct_001_a");
  assert.equal(snap1.entries[0].is_public_profile, false);
  assert.equal(snap1.entries[0].rank, 1);
  assert.equal(snap1.entries[1].account_id, "acct_001_b");
  assert.equal(snap1.entries[1].rank, 2);
  assert.equal(snap1.entries[0].score, snap1.entries[1].score);
  assert.equal(snap1.entries[0].score, 120 * 3 + 10 + 50_000 / 25_000 + 80);

  // Brand-new rank 31 account without prior top30 entitlement MUST NOT get hysteresis access.
  assert.equal(lookupTop30Entitlement(snap1, "acct_031", day1).ok, false);

  // Day 2: Move acct_030 down to rank 33 (inside 31-35 hysteresis) and acct_029 down to rank 37 (enters 7-day grace).
  // Also keep acct_031 at rank 31 (still no prior top30 entitlement -> still denied!).
  const day2 = new Date("2026-11-02T00:00:00Z");
  const day2Candidates = candidates.map((c) => {
    if (c.account_id === "acct_030") return { ...c, network_tasks: 100 - 33 }; // drops to 33
    if (c.account_id === "acct_029") return { ...c, network_tasks: 100 - 37 }; // drops to 37
    if (c.account_id === "acct_032") return { ...c, network_tasks: 100 - 20 }; // rises into top 30
    if (c.account_id === "acct_033") return { ...c, network_tasks: 100 - 21 }; // rises into top 30
    return c;
  });
  const day2Res = computeTop30Snapshot({
    candidates: day2Candidates,
    previousSnapshot: snap1,
    activeValidatorAccountIds: new Set(["acct_val_top", "acct_val_second"]),
    blacklistedOrSuspendedAccountIds: new Set(["acct_blk_top"]),
    now: day2,
  });
  const snap2 = day2Res.snapshot;

  const hysteresisEntry = snap2.entries.find((e) => e.account_id === "acct_030");
  assert.equal(hysteresisEntry.entitlement_state, "retained_hysteresis_31_35");
  assert.equal(hysteresisEntry.access_basis, "top30");
  assert.ok(hysteresisEntry.rank >= 31 && hysteresisEntry.rank <= 35);
  assert.equal(lookupTop30Entitlement(snap2, "acct_030", day2).basis, "top30");

  const graceEntry = snap2.entries.find((e) => e.account_id === "acct_029");
  assert.equal(graceEntry.entitlement_state, "grace_7d");
  assert.equal(graceEntry.access_basis, "grace");
  assert.ok(graceEntry.rank >= 36);
  assert.equal(graceEntry.grace_started_at, "2026-11-02T00:00:00Z");
  assert.equal(graceEntry.grace_ends_at, "2026-11-09T00:00:00Z");
  assert.equal(graceEntry.grace_cooldown_until, "2026-12-02T00:00:00Z");
  assert.equal(lookupTop30Entitlement(snap2, "acct_029", new Date("2026-11-08T23:59:00Z")).basis, "grace");
  assert.equal(lookupTop30Entitlement(snap2, "acct_029", new Date("2026-11-09T00:00:01Z")).ok, false, "grace expires at exact 7d timestamp");

  // Day 10: acct_029 climbs back into top 30 (re-seated), then on Day 11 drops back to rank 37.
  // Because acct_029 is STILL inside its 30-day cooldown (until 2026-12-02), bouncing 35<->36 MUST NOT grant a fresh 7-day grace!
  const cooldownHistory = new Map([["acct_029", graceEntry.grace_cooldown_until]]);
  const day10 = new Date("2026-11-10T00:00:00Z");
  const day10Candidates = candidates.map((c) => (c.account_id === "acct_029" ? { ...c, network_tasks: 110 } : c));
  const snap10 = computeTop30Snapshot({
    candidates: day10Candidates,
    previousSnapshot: snap2,
    activeValidatorAccountIds: new Set(["acct_val_top", "acct_val_second"]),
    blacklistedOrSuspendedAccountIds: new Set(["acct_blk_top"]),
    cooldownHistory,
    now: day10,
  }).snapshot;
  assert.equal(lookupTop30Entitlement(snap10, "acct_029", day10).basis, "top30");

  const day11 = new Date("2026-11-11T00:00:00Z");
  const day11Candidates = candidates.map((c) => (c.account_id === "acct_029" ? { ...c, network_tasks: 100 - 38 } : c));
  const snap11 = computeTop30Snapshot({
    candidates: day11Candidates,
    previousSnapshot: snap10,
    activeValidatorAccountIds: new Set(["acct_val_top", "acct_val_second"]),
    blacklistedOrSuspendedAccountIds: new Set(["acct_blk_top"]),
    cooldownHistory,
    now: day11,
  }).snapshot;
  assert.equal(lookupTop30Entitlement(snap11, "acct_029", day11).ok, false, "30-day grace cooldown blocks infinite 35<->36 bounce grace");

  // Fail-safe snapshot job retains last good snapshot and alerts operator when inputs fail.
  const alerts = [];
  const failedRun = await runDailyTop30SnapshotJob({
    loadPreviousSnapshot: async () => snap11,
    loadInputs: async () => { throw new Error("postgres_read_timeout"); },
    persistSnapshot: async () => {},
    alertOperator: (event) => alerts.push(event),
    now: day11,
  });
  assert.equal(failedRun.ok, false);
  assert.equal(failedRun.retainedFallback, true);
  assert.equal(failedRun.snapshot.status, "fallback_retained");
  assert.equal(failedRun.snapshot.snapshot_id, snap11.snapshot_id);
  assert.equal(alerts.length, 1);
});

// ============================================================================
// (d) Goodbrief sandbox attributes, CSP enforcement, and Today desk helpers
// ============================================================================

test("(d) Goodbrief sandbox attributes & zero-exfiltration CSP are strictly enforced on both server and client", () => {
  assert.equal(GOODBRIEF_SANDBOX_ATTR, "allow-scripts");
  assert.equal(CLIENT_GOODBRIEF_SANDBOX, "allow-scripts");
  assert.ok(!CLIENT_GOODBRIEF_SANDBOX.includes("allow-same-origin"), "Goodbrief iframe must NEVER allow-same-origin");
  assert.ok(!CLIENT_GOODBRIEF_SANDBOX.includes("allow-top-navigation"), "Goodbrief iframe must NEVER allow-top-navigation");
  assert.ok(!CLIENT_GOODBRIEF_SANDBOX.includes("allow-forms"));

  assert.equal(GOODBRIEF_SRCDOC_CSP, CLIENT_GOODBRIEF_CSP);
  assert.match(GOODBRIEF_SRCDOC_CSP, /default-src 'none'/);
  assert.match(GOODBRIEF_SRCDOC_CSP, /connect-src 'none'/);
  assert.match(GOODBRIEF_SRCDOC_CSP, /form-action 'none'/);
  assert.match(GOODBRIEF_SRCDOC_CSP, /img-src data:/);

  const hostileHtml = `<!doctype html>
    <html><head>
      <base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <meta http-equiv="Content-Security-Policy" content="default-src *">
      <link rel="stylesheet" href="https://evil.example/exfil.css">
      <script src="https://evil.example/steal.js"></script>
    </head><body>
      <h1>Goodbrief</h1>
      <iframe src="https://evil.example/frame"></iframe>
      <object data="https://evil.example/x"></object>
      <script>console.log("inline chart ok");</script>
    </body></html>`;

  const wm = buildFinanceHubWatermark({ accountId: "acct_1", basis: "top30", indexId: "goodbrief", filePath: "index.html", secret: "s" });
  const serverDoc = prepareGoodbriefSrcDoc(hostileHtml, { watermarkId: wm.watermarkId, title: "Goodbrief" });
  const clientDoc = buildGoodbriefSrcDoc(hostileHtml, { watermarkId: wm.watermarkId, title: "Goodbrief" });

  for (const doc of [serverDoc, clientDoc]) {
    assert.ok(doc.includes(`http-equiv="Content-Security-Policy" content="${GOODBRIEF_SRCDOC_CSP.replace(/"/g, "&quot;")}"`));
    assert.ok(!/<base\b/i.test(doc), "base tag must be stripped");
    assert.ok(!/http-equiv\s*=\s*["']?refresh/i.test(doc), "meta refresh must be stripped");
    assert.ok(!/evil\.example\/steal\.js/i.test(doc), "external script src must be stripped");
    assert.ok(!/evil\.example\/exfil\.css/i.test(doc), "external stylesheet must be stripped");
    assert.ok(!/<iframe\b/i.test(doc), "nested iframe must be stripped");
    assert.ok(!/<object\b/i.test(doc), "object tag must be stripped");
    assert.ok(doc.includes(wm.watermarkId), "watermark must be embedded");
  }

  // Verify GoodbriefFrame.jsx renders iframe with sandbox={GOODBRIEF_SANDBOX_ATTR} and srcDoc, never allow-same-origin.
  const frameSource = readFileSync(path.join(ROOT, "src", "features", "research", "GoodbriefFrame.jsx"), "utf8");
  assert.match(frameSource, /sandbox=\{GOODBRIEF_SANDBOX_ATTR\}/);
  assert.match(frameSource, /srcDoc=\{safeSrcDoc\}/);
  assert.ok(!frameSource.includes("allow-same-origin"));

  // Verify plain text escaper & Today desk sorting/filtering/visit-markers.
  assert.equal(escapePlainText("<script>alert('x')</script>"), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  assert.equal(isNewSinceBaseline("2026-11-27T02:00:00Z", "2026-11-27T01:00:00Z"), true);
  assert.equal(isNewSinceBaseline("2026-11-27T00:30:00Z", "2026-11-27T01:00:00Z"), false);

  const items = [
    { ticker: "AAPL", name: "Apple", asset_class: "perp_megacap_equity" },
    { ticker: "SOL", name: "Solana", asset_class: "crypto_protocol" },
    { ticker: "NVDA", name: "NVIDIA", asset_class: "perp_megacap_equity" },
  ];
  const watchlist = new Set(["NVDA"]);
  const sorted = sortWithWatchlistFirst(items, watchlist);
  assert.deepEqual(sorted.map((i) => i.ticker), ["NVDA", "AAPL", "SOL"]);
  assert.deepEqual(
    items.filter((i) => matchesTodayFilters(i, { assetClass: "crypto" })).map((i) => i.ticker),
    ["SOL"]
  );
  assert.deepEqual(
    items.filter((i) => matchesTodayFilters(i, { query: "nvidia" })).map((i) => i.ticker),
    ["NVDA"]
  );
  assert.deepEqual(
    items.filter((i) => matchesTodayFilters(i, { watchlistSet: watchlist, watchlistOnly: true })).map((i) => i.ticker),
    ["NVDA"]
  );
  assert.equal(formatAccessBasisBadge({ ok: true, basis: "top30", rank: 7 }).label, "Top 30 #7");
  assert.equal(formatAccessBasisBadge({ ok: true, basis: "grace", graceEndsAt: "2026-12-04T00:00:00Z" }).label, "Grace · ends 2026-12-04");
});
