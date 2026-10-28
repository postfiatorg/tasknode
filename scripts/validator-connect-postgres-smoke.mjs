import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeNodePublic } from "ripple-address-codec";
import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { issueValidatorConnect, validatorConnectChallenge, finishValidatorConnect, validatorConnectStatus } from "../server/repositories/validator-connect.js";
import { handleDeepResearchRoute } from "../server/deep-research-routes.js";
import { createDeepResearchJob } from "../server/repositories/deep-research.js";
import { chatResearchAccess } from "../server/chat-research-provider.js";
import { insertLedgerEntry } from "../server/repositories/chat-billing.js";
import { transaction } from "../server/db/pool.js";

const accountId = `connect_smoke_${randomUUID()}`;
const other = `${accountId}_other`;
const keypair = deriveKeypair(generateSeed({ algorithm: "ed25519" }));
const masterPublicKey = encodeNodePublic(Buffer.from(keypair.publicKey, "hex"));
const lookup = async () => ({ network: "devnet" });
const signChallenge = challenge => sign(Buffer.from(challenge).toString("hex"), keypair.privateKey);
const originalFetch = globalThis.fetch;
const calls = [];
const report = { markdown: "# Answer\n\nA useful research answer with financial evidence. [F1]", sources: [{ id: "F1", ticker: "EXAMPLE", rows: [{ revenue: 10 }] }] };
async function route(path, { method = "GET", payload, account = accountId } = {}) {
  let status, body;
  await handleDeepResearchRoute({ req: { method }, res: {}, session: account ? { accountId: account } : null,
    url: new URL(path, "http://localhost"), readJson: async () => payload,
    json: (_res, code, value) => { status = code; body = value; } });
  return { status, body };
}
try {
  await migrateDatabase();
  const token = await issueValidatorConnect(accountId);
  assert.equal(token.token.length, 68);
  const stored = (await query("SELECT * FROM validator_connect_tokens WHERE id=$1", [token.id])).rows[0];
  assert.equal(stored.token_hash, createHash("sha256").update(token.token).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(token.token));
  assert.ok(Math.abs(new Date(stored.expires_at) - new Date(stored.created_at) - 1800000) < 2000);
  await assert.rejects(validatorConnectChallenge(token.token, other));
  await assert.rejects(validatorConnectStatus(other, token.id));
  const challenge = await validatorConnectChallenge(token.token);
  const payload = { token: token.token, masterPublicKey, signature: signChallenge(challenge.challenge) };
  await assert.rejects(finishValidatorConnect({ ...payload, accountId: other }, { lookup }));
  await assert.rejects(finishValidatorConnect({ ...payload, signature: "0".repeat(128) }, { lookup }));
  assert.equal((await validatorConnectStatus(accountId, token.id)).status, "waiting");
  const raced = await Promise.allSettled([finishValidatorConnect(payload, { lookup }), finishValidatorConnect(payload, { lookup })]);
  assert.equal(raced.filter(r => r.status === "fulfilled").length, 1);
  const binding = raced.find(r => r.status === "fulfilled").value;
  assert.equal((await validatorConnectStatus(accountId, token.id)).status, "connected");
  assert.equal((await validatorConnectStatus(accountId, token.id)).bindingId, binding.id);
  await assert.rejects(finishValidatorConnect(payload, { lookup }));
  await assert.rejects(validatorConnectChallenge(token.token));
  const again = await issueValidatorConnect(accountId);
  const againChallenge = await validatorConnectChallenge(again.token);
  assert.equal((await finishValidatorConnect({ token: again.token, masterPublicKey, signature: signChallenge(againChallenge.challenge) }, { lookup })).id, binding.id);
  const foreign = await issueValidatorConnect(other);
  const foreignChallenge = await validatorConnectChallenge(foreign.token);
  await assert.rejects(finishValidatorConnect({ token: foreign.token, masterPublicKey, signature: signChallenge(foreignChallenge.challenge) }, { lookup }));
  assert.equal((await validatorConnectStatus(other, foreign.id)).status, "waiting", "failed ownership proof does not consume token");
  const expired = await issueValidatorConnect(accountId);
  await query("UPDATE validator_connect_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  await assert.rejects(validatorConnectChallenge(expired.token));
  await assert.rejects(finishValidatorConnect({ token: expired.token, masterPublicKey, signature: payload.signature }, { lookup }));
  assert.equal((await validatorConnectStatus(accountId, expired.id)).status, "expired");

  process.env.GA_RESEARCH_URL = "https://ga.example.test/ga-research";
  process.env.GA_RESEARCH_HMAC_SECRET = "synthetic-provider-secret";
  process.env.CORBANU_DEEP_RESEARCH_BASE_URL = "https://corbanu.example.test";
  process.env.CORBANU_TASKNODE_INTEGRATION_SECRET = "synthetic-legacy-secret";
  assert.equal((await chatResearchAccess({ accountId })).provider, "goodalexander");
  assert.equal((await chatResearchAccess({ accountId: other })).provider, "corbanu");
  assert.equal((await chatResearchAccess({ accountId: "" })).available, false);
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url); const method = options.method || "GET";
    calls.push({ origin: parsed.origin, path: parsed.pathname, method, payload: options.body ? JSON.parse(options.body) : null });
    let body;
    if (parsed.hostname === "ga.example.test") {
      const usage = { total_cost_usd: 0.123456789 };
      body = method === "POST" ? { job_id: "ga-fixture", status: "queued" }
        : parsed.pathname.endsWith("/result") ? { job_id: "ga-fixture", ...report, usage }
          : { job_id: "ga-fixture", status: "completed", usage };
    } else if (parsed.hostname === "corbanu.example.test") {
      body = method === "POST" ? { id: "legacy-fixture", status: "queued" }
        : parsed.pathname.endsWith("/result") ? { result: { markdown: "Legacy report unchanged" } }
          : { status: "completed", usage: { total_cost_usd: 0.04 } };
    } else throw Error("unexpected external call");
    return new Response(JSON.stringify(body), { status: method === "POST" ? 202 : 200 });
  };
  await transaction(client => insertLedgerEntry(client, { accountId, kind: "account_credit", amountUsd: 2, source: "test_fixture", uniqueKey: accountId }));
  const request = { question: "Compare recent financial results.", conversationId: `${accountId}_conversation`, requestId: "ga-chat", maxCostUsd: 0.5 };
  assert.equal((await route("/api/deep-research/jobs", { method: "POST", payload: request, account: null })).status, 401);
  const created = await route("/api/deep-research/jobs", { method: "POST", payload: request });
  assert.equal(created.status, 202);
  assert.equal(created.body.job.provider, "goodalexander");
  assert.equal(created.body.job.maxCostUsd, 0.5);
  const id = created.body.job.id;
  const result = await route(`/api/deep-research/jobs/${id}`);
  assert.equal(result.body.job.status, "completed");
  assert.equal(result.body.assistant.body, report.markdown, "the report is readable in chat");
  assert.equal(result.body.assistant.metadata.deepResearch.usage.total_cost_usd, 0.123456789);
  assert.equal(result.body.assistant.metadata.deepResearch.usage.billed_cost_usd, 0.123457);
  assert.deepEqual((await route(`/api/deep-research/jobs/${id}`)).body, result.body);
  assert.equal((await route(`/api/deep-research/jobs/${id}`, { account: other })).status, 404);
  assert.equal((await route(`/api/deep-research/jobs/${id}/cancel`, { method: "POST" })).status, 409);
  assert.equal((await route("/api/deep-research/jobs", { method: "POST", payload: request })).body.job.id, id);
  await assert.rejects(createDeepResearchJob({ accountId, conversationId: request.conversationId, question: "A changed question", requestId: request.requestId, maxCostUsd: 0.5 }));
  const debits = (await query("SELECT amount_usd FROM billing_ledger_entries WHERE account_id=$1 AND source='validator_research'", [accountId])).rows;
  assert.equal(debits.length, 1); assert.equal(debits[0].amount_usd, "0.123457");
  assert.equal(calls.filter(c => c.method === "POST" && c.origin === "https://ga.example.test").length, 1);
  const legacy = await route("/api/deep-research/jobs", { method: "POST", account: other, payload: { ...request, conversationId: `${other}_conversation` } });
  assert.equal(legacy.body.job.provider, "corbanu");
  assert.equal((await route(`/api/deep-research/jobs/${legacy.body.job.id}`, { account: other })).body.assistant.metadata.deepResearch.markdown, "Legacy report unchanged");
  assert.equal(calls.filter(c => c.method === "POST" && c.origin === "https://corbanu.example.test").length, 1);
  // Provider choice is durable even after the validator disconnects.
  await query("UPDATE validator_bindings SET revoked_at=now() WHERE account_id=$1", [accountId]);
  assert.equal((await route(`/api/deep-research/jobs/${id}`)).body.job.provider, "goodalexander");
  console.log("validator-connect-postgres-smoke ok: hashed/30-minute/single-use/account-bound tokens, concurrent proof, expiry, reconnect without unbind, chat provider routing, report persistence, single ceil6 debit, replay and owner isolation, legacy behavior");
} finally {
  globalThis.fetch = originalFetch;
  for (const table of ["deep_research_jobs", "chat_messages", "chat_conversations", "research_gateway_jobs", "validator_connect_tokens", "validator_bindings", "validator_challenges", "billing_ledger_entries", "billing_accounts"]) {
    await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [[accountId, other]]);
  }
  await closePool();
}
