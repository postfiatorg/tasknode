import { researchLedgerAmount } from "../server/research-billing.js";
import { researchSources, researchSourceUrl } from "../src/features/research/research-sources.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { encodeNodePublic } from "ripple-address-codec";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createValidatorChallenge, dailyAgreement, findRegisteredValidator, rewardMonthWindow, verifyValidatorSignature } from "../server/validator-identity.js";
import { safeReturnTo } from "../server/index-viewer-routes.js";
import { researchHmacHeaders, callResearchService } from "../server/research-provider.js";
import { readFile } from "node:fs/promises";
import { parse } from "espree";

assert.equal(researchSourceUrl("https://example.com/source?id=1"), "https://example.com/source?id=1");
for (const value of [null, {}, "", "javascript:alert(1)", "data:text/html,test", "https://user:secret@example.com/", "file:///tmp/report"]) assert.equal(researchSourceUrl(value), null);
assert.deepEqual(researchSources(null), []);
assert.deepEqual(researchSources([null, [], "bad"]), []);
const source = { id: "F1", ticker: "EXAMPLE", rows: [{ period: "2026-09-30", revenue: 100 }] };
assert.deepEqual(researchSources([source]), [{ id: "F1", label: "EXAMPLE", url: null, evidence: source }]);
assert.equal(researchSources([{ title: {}, date: [] }])[0].label, "Source evidence");

for (const [cost, expected] of [[0, 0], [0.1, 0.1], [0.100001, 0.100001], [0.123456789, 0.123457], [0.117940644, 0.117941], [0.000000000001, 0.000001], [0.01, 0.01]]) {
  assert.equal(researchLedgerAmount(cost), expected);
}
assert.throws(() => researchLedgerAmount(-1), /invalid/);
assert.throws(() => researchLedgerAmount(NaN), /invalid/);
const now = Date.parse("2026-10-28T12:00:00Z");
const proof = createValidatorChallenge("account-one", now);
assert.equal(new Date(proof.expiresAt).getTime(), now + 1800000);
assert.equal(proof.challenge.split(":")[1].length, 64);
assert.notEqual(proof.challenge, createValidatorChallenge("account-one", now).challenge);
for (const algorithm of ["ed25519", "ecdsa-secp256k1"]) {
  const key = deriveKeypair(generateSeed({ algorithm }));
  const other = deriveKeypair(generateSeed({ algorithm }));
  const masterPublicKey = encodeNodePublic(Buffer.from(key.publicKey, "hex"));
  const signature = sign(Buffer.from(proof.challenge).toString("hex"), key.privateKey);
  const vector = { masterPublicKey, signature, challenge: proof.challenge };
  assert.equal(verifyValidatorSignature(vector), true, algorithm);
  assert.equal(verifyValidatorSignature({ ...vector, challenge: `${proof.challenge}!` }), false);
  assert.equal(verifyValidatorSignature({ ...vector, masterPublicKey: encodeNodePublic(Buffer.from(other.publicKey, "hex")) }), false);
  assert.equal(verifyValidatorSignature({ ...vector, signature: signature.slice(2) }), false);
  assert.equal(verifyValidatorSignature({ ...vector, signature: "g".repeat(128) }), false);
  assert.equal(verifyValidatorSignature({ ...vector, masterPublicKey: "unknown" }), false);
}
const reports = Array.from({ length: 30 }, (_, i) => ({ date: new Date(now - (i + 1) * 86400000).toISOString().slice(0, 10), score: "0.95000" }));
assert.equal(dailyAgreement(reports, new Date(now)).eligible, true, "95 percent boundary includes equality");
assert.equal(dailyAgreement(reports.slice(0, 25), new Date(now)).eligible, true);
assert.equal(dailyAgreement(reports.slice(0, 24), new Date(now)).eligible, false);
assert.equal(dailyAgreement(reports.map((row) => ({ ...row, score: 0.949 })), new Date(now)).eligible, false);
assert.equal(dailyAgreement([...reports, ...reports], new Date(now)).daysReported, 30);
assert.equal(dailyAgreement([...reports, { date: "2026-10-28", score: 0 }], new Date(now)).eligible, true, "current partial day excluded");
assert.equal(dailyAgreement([{ date: "2026-10-27", score: null }], new Date(now)).daysReported, 0);
assert.throws(() => dailyAgreement([...reports, { ...reports[0], score: 0.1 }], new Date(now)), /conflict/);
assert.equal(rewardMonthWindow("2026-10", new Date(now)).toISOString(), "2026-10-01T00:00:00.000Z");
assert.throws(() => rewardMonthWindow("2026-11", new Date(now)), /not_due/);
assert.throws(() => rewardMonthWindow("2026-13", new Date(now)), /invalid/);
const fetchVhs = (rows) => async () => ({ ok: true, json: async () => ({ result: "success", validators: rows }) });
await assert.rejects(findRegisteredValidator("unknown", { fetchImpl: fetchVhs([]) }), /validator_unknown/);
await assert.rejects(findRegisteredValidator("revoked", { fetchImpl: fetchVhs([{ master_key: "revoked", revoked: true }]) }), /validator_revoked/);
assert.equal((await findRegisteredValidator("known", { fetchImpl: fetchVhs([{ master_key: "known", revoked: false }]) })).network, "devnet");
let lookups = 0;
assert.equal((await findRegisteredValidator("known", { fetchImpl: async () => ({ ok: true, json: async () => ({ result: "success", validators: ++lookups === 1 ? [] : [{ master_key: "known", revoked: false }] }) }) })).network, "testnet");
assert.equal(safeReturnTo("https://attacker.example/capture"), null);
assert.equal(safeReturnTo("https://agti.net.attacker.example/capture"), null);
assert.equal(safeReturnTo("https://attacker@agti.net/capture"), null);
assert.equal(safeReturnTo("http://localhost:5174/x"), null);
assert.equal(safeReturnTo("https://agti.net/path#fragment").hash, "");
const headers = researchHmacHeaders({ method: "GET", path: "/v1/research/id", accountId: "account-one", timestamp: 123, secret: "unit-secret" });
assert.equal(headers["X-GA-Signature"], createHmac("sha256", "unit-secret").update("GET\n/v1/research/id\n123\naccount-one\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").digest("hex"));
let captured;
await callResearchService({ method: "POST", path: "/v1/research", accountId: "account-one", payload: { question: "What changed?" }, env: { GA_RESEARCH_URL: "https://service.example/ga-research", GA_RESEARCH_HMAC_SECRET: "unit-secret" }, fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({}) }; } });
assert.equal(captured.url, "https://service.example/ga-research/v1/research");
assert.equal(captured.options.body, '{"question":"What changed?"}');
assert.equal(captured.options.redirect, "error");
// The branded base keeps the externally mounted prefix out of the signed path.
for (const base of ["https://research.goodalexander.com:18443/ga-research", "https://research.goodalexander.com:18443/ga-research/"]) {
  for (const method of ["GET", "POST"]) {
    const path = method === "GET" ? "/v1/research/fixture/result" : "/v1/research";
    const payload = method === "POST" ? { question: "Fixture question", max_cost_usd: 0.5 } : undefined;
    await callResearchService({ method, path, accountId: "account-one", payload,
      env: { GA_RESEARCH_URL: base, GA_RESEARCH_HMAC_SECRET: "unit-secret" },
      fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({}) }; } });
    assert.equal(captured.url, `https://research.goodalexander.com:18443/ga-research${path}`);
    assert.equal(captured.options.redirect, "error");
    assert.equal(captured.options.headers["X-GA-Signature"], researchHmacHeaders({ method, path, accountId: "account-one",
      body: payload ? JSON.stringify(payload) : "", timestamp: Number(captured.options.headers["X-GA-Timestamp"]), secret: "unit-secret" })["X-GA-Signature"]);
  }
}
// Guard every new prompt/provider/usage path against regex reintroduction.
for (const file of ["shared/research-agent.js", "server/research-preview.js", "src/features/chat/research-markdown.js", "src/features/chat/ResearchProgress.jsx", "src/features/chat/ResearchMenuItems.jsx", "src/features/chat/ResearchPreview.jsx", "src/features/chat/use-research-preview.js", "src/features/chat/use-deep-research-polling.js", "shared/chat-research.js", "server/research-billing.js", "server/research-provider.js", "server/research-gateway.js", "server/repositories/research-gateway.js", "server/validator-research-routes.js", "src/features/research/research-client.js", "src/features/research/research-sources.js", "server/chat-research-provider.js", "server/deep-research-routes.js", "server/repositories/deep-research.js", "src/features/chat/deep-research-client.js"]) {
  const ast = parse(await readFile(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } });
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    assert.ok(!node.regex, `regex prohibited: ${file}`);
    assert.ok(!(node.type === "NewExpression" && node.callee?.name === "RegExp"), `RegExp prohibited: ${file}`);
    for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value); }
  };
  visit(ast);
}
console.log("validator-research-smoke ok: signatures, negative proofs, eligibility boundaries, VHS network/revocation, redirect origin, HMAC, no regex");
