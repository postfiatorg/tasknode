import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";
import pg from "pg";

// Exercise the exported action with a synthetic failure at its first wallet
// lookup. This checks error guidance, not a lost commit or recovery protocol.
const store = mkdtempSync(path.join(tmpdir(), "task-submission-guidance-"));
process.env.TASKNODE_STORE_PATH = path.join(store, "runtime-store.json");
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";
const noConnection = mock.method(pg.Pool.prototype, "connect", () => {
  throw new Error("This fixture must not open a database connection");
});
const noFetch = mock.method(globalThis, "fetch", () => {
  throw new Error("This fixture must not make network requests");
});
const { taskSubmissionAction } = await import("../server/task-submission.js");
const { closePool } = await import("../server/db/pool.js");
const session = { accountId: "account_guidance_fixture" };
const ordinaryAdvice = "Check wallet unlock state, PFT balance, PFTL connectivity, and IPFS configuration, then retry.";
const evidenceAdvice = "Choose a supported readable file or provide the evidence as text, a screenshot, or a public URL.";

async function failedAction(t, payload, message = "fixture_lookup_failed", details = {}) {
  const error = Object.assign(new Error(message), details);
  const lookup = t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
    assert.ok(sql.includes("FROM account_linked_wallets"));
    assert.deepEqual(params, [session.accountId]);
    throw error;
  });
  const result = await taskSubmissionAction(payload, "POST", session);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(noConnection.mock.callCount(), 0);
  assert.equal(noFetch.mock.callCount(), 0);
  assert.equal(result.status, details.status || 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.action, "task_submission");
  assert.equal(result.body.error, details.code || message);
  assert.deepEqual(result.body.attempts, details.attempts);
  return result.body;
}

for (const [name, payload] of [
  ["explicit submit", { phase: "submit" }],
  ["normalized submit", { phase: " SUBMIT " }],
  ["legacy camel-case signed blob", { signedTxBlob: "fixture-not-a-transaction" }],
  ["legacy snake-case signed blob", { signed_tx_blob: "fixture-not-a-transaction" }],
  ["unrecognized phase with signed blob", { phase: "legacy", signedTxBlob: "fixture-not-a-transaction" }],
]) {
  test(name + " exception requires reconciliation before resubmission", async (t) => {
    const body = await failedAction(t, payload, "fixture_lookup_failed", {
      status: 503, code: "FIXTURE_UNAVAILABLE", attempts: [{ stage: "lookup" }],
    });
    assert.equal(body.message, "fixture_lookup_failed");
    assert.match(body.actionRequired, /outcome may be uncertain/i);
    assert.match(body.actionRequired, /preserve/i);
    assert.match(body.actionRequired, /refresh.*task.*history/i);
    assert.match(body.actionRequired, /reconcil/i);
    assert.match(body.actionRequired, /do not resubmit/i);
    assert.notEqual(body.actionRequired, ordinaryAdvice);
  });
}

for (const phase of ["prepare", "process_evidence"]) {
  for (const signedField of [null, "signedTxBlob", "signed_tx_blob"]) {
    test(phase + " keeps ordinary advice even with " + (signedField || "no signed blob"), async (t) => {
      const payload = { phase, ...(signedField ? { [signedField]: "fixture-not-a-transaction" } : {}) };
      const body = await failedAction(t, payload);
      assert.equal(body.message, "fixture_lookup_failed");
      assert.equal(body.actionRequired, ordinaryAdvice);
    });
  }
}

test("configuration lookup failures keep ordinary advice", async (t) => {
  const body = await failedAction(t, {});
  assert.equal(body.actionRequired, ordinaryAdvice);
});

test("evidence-specific errors keep their readable-file guidance before signed-blob dispatch", async (t) => {
  const body = await failedAction(t, {
    phase: "process_evidence", signedTxBlob: "fixture-not-a-transaction",
  }, "evidence_file_no_extractable_text");
  assert.equal(body.actionRequired, evidenceAdvice);
  assert.match(body.message, /could not find readable text/);
});

test("method rejection and unauthenticated submit return before any lookup", async (t) => {
  const lookup = t.mock.method(pg.Pool.prototype, "query", () => assert.fail("unexpected lookup"));
  const method = await taskSubmissionAction({ phase: "submit" }, "GET", session);
  assert.equal(method.status, 405);
  assert.equal(method.body.error, "task_submission_method_not_allowed");
  assert.equal(method.body.actionRequired, "Call the task submission endpoint with POST.");
  const login = await taskSubmissionAction({ phase: "submit" });
  assert.equal(login.status, 401);
  assert.equal(login.body.error, "task_submission_login_required");
  assert.equal(login.body.actionRequired, "Sign in, unlock the linked wallet, then retry.");
  assert.equal(lookup.mock.callCount(), 0);
});

test("a returned wallet validation error retains its specific guidance", async (t) => {
  const lookup = t.mock.method(pg.Pool.prototype, "query", async () => ({ rows: [] }));
  const result = await taskSubmissionAction({ phase: "submit" }, "POST", session);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "task_submission_wallet_required");
  assert.equal(result.body.actionRequired, "Create or link a seed wallet, unlock the local vault, then retry.");
});

after(async () => {
  await closePool();
  mock.restoreAll();
  rmSync(store, { recursive: true, force: true });
});
