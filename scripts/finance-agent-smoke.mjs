#!/usr/bin/env node
// Finance Hub model agent: allowlist, worker token and route gating (no database; the store is faked).
import assert from "node:assert/strict";
import { createFinanceAgentRouteHandler, financeAgentAllowed, financeAgentWorkerAuthorized } from "../server/finance-agent.js";

const env = { TASKNODE_FINANCE_AGENT_ACCOUNTS: "acct_owner, rWALLETowner", TASKNODE_FINANCE_AGENT_WORKER_TOKEN: "worker-secret-token" };
const wallets = { acct_wallet: { status: "linked", address: "rWALLETowner" }, acct_other: { status: "linked", address: "rSomeoneElse" } };
const linkedWallet = async ({ accountId }) => wallets[accountId] || { status: "unlinked" };

assert.equal(await financeAgentAllowed({ accountId: "acct_owner" }, { env, linkedWallet }), true);
assert.equal(await financeAgentAllowed({ accountId: "acct_wallet" }, { env, linkedWallet }), true, "linked wallet on the allowlist");
assert.equal(await financeAgentAllowed({ accountId: "acct_other" }, { env, linkedWallet }), false);
assert.equal(await financeAgentAllowed(null, { env, linkedWallet }), false);
assert.equal(await financeAgentAllowed({ accountId: "acct_owner" }, { env: {}, linkedWallet }), false, "an empty allowlist allows nobody");

assert.equal(financeAgentWorkerAuthorized("Bearer worker-secret-token", env), true);
assert.equal(financeAgentWorkerAuthorized("Bearer wrong", env), false);
assert.equal(financeAgentWorkerAuthorized("", env), false);
assert.equal(financeAgentWorkerAuthorized("Bearer worker-secret-token", {}), false, "no configured token refuses every worker");

const calls = [];
const store = new Proxy({}, { get: (_target, name) => async (...args) => { calls.push([name, ...args]); return name === "claim" ? null : { thread: { id: "fat_1" }, messages: [], proposals: [] }; } });
const allowed = async (session) => session?.accountId === "acct_owner";
const handler = createFinanceAgentRouteHandler({ store, allowed, env });
async function call(method, path, { session = null, body = {}, authorization = "" } = {}) {
  let status = 0, payload = null;
  const res = { setHeader() {} };
  const json = (_res, code, value) => { status = code; payload = value; };
  const readJson = async () => body;
  const handled = await handler({ json, readJson, req: { method, headers: { authorization } }, res, session, url: new URL(`https://t.example${path}`) });
  return { handled, status, payload };
}

assert.equal((await call("GET", "/api/other")).handled, false, "other routes pass through");
assert.equal((await call("GET", "/api/finance-agent/access")).status, 401, "signed out");
assert.equal((await call("GET", "/api/finance-agent/access", { session: { accountId: "acct_x" } })).status, 403, "not allowlisted");
assert.equal((await call("GET", "/api/finance-agent/threads?model=CRCL", { session: { accountId: "acct_x" } })).status, 403);
assert.equal((await call("POST", "/api/finance-agent/decisions", { session: { accountId: "acct_x" }, body: { proposalId: "fap_1", decision: "approve" } })).status, 403);
assert.equal(calls.length, 0, "a refused account never reaches the store");
assert.deepEqual((await call("GET", "/api/finance-agent/access", { session: { accountId: "acct_owner" } })).payload, { ok: true, allowed: true });
assert.equal((await call("GET", "/api/finance-agent/threads?model=crcl", { session: { accountId: "acct_owner" } })).status, 200);
assert.deepEqual(calls.at(-1), ["listThreads", "acct_owner", "CRCL"]);
assert.equal((await call("POST", "/api/finance-agent/threads", { session: { accountId: "acct_owner" }, body: { model: "../etc" } })).status, 400, "model ids are validated");
assert.equal((await call("POST", "/api/finance-agent/messages", { session: { accountId: "acct_owner" }, body: { threadId: "fat_1", text: "  " } })).status, 400);
assert.equal((await call("POST", "/api/finance-agent/messages", { session: { accountId: "acct_owner" }, body: { threadId: "fat_1", text: "Why +33%?", context: { tab: "summary" } } })).status, 202);
assert.equal((await call("POST", "/api/finance-agent/decisions", { session: { accountId: "acct_owner" }, body: { proposalId: "fap_1", decision: "maybe" } })).status, 400);
assert.equal((await call("POST", "/api/finance-agent/worker/claim", { authorization: "Bearer wrong" })).status, 401, "worker needs the service token");
assert.equal((await call("POST", "/api/finance-agent/worker/claim", { session: { accountId: "acct_owner" } })).status, 401, "a session is not a worker credential");
const claim = await call("POST", "/api/finance-agent/worker/claim", { authorization: "Bearer worker-secret-token" });
assert.deepEqual([claim.status, claim.payload], [200, { ok: true, job: null }]);
console.log("finance agent smoke ok: allowlist, worker token and route gating");
