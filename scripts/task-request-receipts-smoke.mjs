import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { taskRequestCommandIds } from "../server/task-request-command.js";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { dismissOwnedTaskRequest, getOwnedTaskRequest, listTaskRequests, publicTaskRequest, upsertTaskRequest, retryOwnedTaskRequest } from "../server/repositories/task-requests.js";
import { taskRequestAction } from "../server/task-request.js";

const accountId = `receipt_smoke_${randomUUID()}`;
const ids = taskRequestCommandIds({ accountId, idempotencyKey: "reconnect-key" });
assert.deepEqual(ids, taskRequestCommandIds({ accountId, idempotencyKey: "reconnect-key" }));
assert.notEqual(ids.requestId, taskRequestCommandIds({ accountId: "another-account", idempotencyKey: "reconnect-key" }).requestId);
assert.throws(() => taskRequestCommandIds({ accountId, idempotencyKey: {} }), { code: "task_request_idempotency_key_invalid" });
for (const status of ["published", "queued", "generating", "failed"]) {
  const receipt = publicTaskRequest({ status, created_at: "2020-01-01", updated_at: "2020-01-01" });
  assert.equal(receipt.isActive, true, `${status} must remain visible until resolved`);
  assert.equal(receipt.canRetry, status === "failed", "an active worker cannot be reset by the UI");
}
assert.ok(databaseEnabled(), "Run this fixture against an isolated PostgreSQL database");
try {
  await migrateDatabase();
  const input = { ...ids, accountId, subjectWallet: "rReceiptSmoke", userDetailText: "Build a useful task from my saved context", status: "queued" };
  const receipts = await Promise.all(Array.from({ length: 12 }, () => upsertTaskRequest(input)));
  assert.equal(receipts.filter((item) => !item.replayed).length, 1);
  assert.equal(new Set(receipts.map((item) => item.request.requestId)).size, 1);
  await query("UPDATE task_requests SET status='proposed', generated_task_id='task_receipt_completed', worker_attempt_count=2 WHERE request_id=$1", [ids.requestId]);
  const replay = await upsertTaskRequest(input);
  assert.equal(replay.request.status, "proposed");
  assert.equal(replay.request.generatedTaskId, "task_receipt_completed");
  assert.equal(replay.request.workerAttemptCount, 2);
  for (const changed of [{ accountId: "another-account" }, { subjectWallet: "rAnotherWallet" }, { userDetailText: "Different work" }, { requestedTaskKind: "network" }, { attachments: [{ name: "new.txt" }] }]) {
    await assert.rejects(upsertTaskRequest({ ...input, ...changed }), { code: "task_request_idempotency_conflict" });
  }
  await query(`INSERT INTO task_requests(request_id,account_id,subject_wallet,status)
    SELECT $1 || n, $2, 'rReceiptSmoke', 'proposed' FROM generate_series(1,110) n`, [`${accountId}_newer_`, accountId]);
  assert.equal((await getOwnedTaskRequest({ requestId: ids.requestId, accountId })).generatedTaskId, "task_receipt_completed");
  assert.equal(await getOwnedTaskRequest({ requestId: ids.requestId, accountId: "another-account" }), null);
  const seen = [];
  let cursor = "";
  do {
    const page = await listTaskRequests({ accountId, walletAddress: "rReceiptSmoke", limit: 17, cursor });
    seen.push(...page.items.map((item) => item.requestId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 111);
  assert.equal(new Set(seen).size, 111);
  await assert.rejects(listTaskRequests({ accountId, cursor: "invalid" }), { code: "task_request_cursor_invalid" });
  const retryId = `${accountId}_newer_1`;
  await query("UPDATE task_requests SET status='failed',worker_attempt_count=3 WHERE request_id=$1", [retryId]);
  const retry = { accountId, requestId: retryId, expectedAttemptCount: 3 };
  await assert.rejects(retryOwnedTaskRequest({ ...retry, accountId: "another-account" }), { status: 404 });
  const changedAccount = await taskRequestAction({ phase: "retry", ...retry, expectedAccountId: "another-account" }, "POST", { accountId });
  assert.equal(changedAccount.status, 409);
  assert.equal((await retryOwnedTaskRequest(retry)).status, "queued");
  assert.equal((await retryOwnedTaskRequest(retry)).status, "queued");
  await query("UPDATE task_requests SET status='failed',worker_attempt_count=4 WHERE request_id=$1", [retryId]);
  assert.equal((await retryOwnedTaskRequest(retry)).status, "failed", "a lost response cannot restart a newer failed attempt");
  assert.equal((await retryOwnedTaskRequest({ ...retry, requestId: ids.requestId, expectedAttemptCount: 2 })).status, "proposed");
  await assert.rejects(dismissOwnedTaskRequest({ ...retry, accountId: "another-account" }), { status: 404 });
  assert.equal((await dismissOwnedTaskRequest(retry)).status, "failed", "a stale dismissal cannot close a newer attempt");
  const wrongOwner = await taskRequestAction({ phase: "dismiss", ...retry, expectedAccountId: "another-account" }, "POST", { accountId });
  assert.equal(wrongOwner.status, 409);
  const dismissed = await taskRequestAction({ phase: "dismiss", ...retry, expectedAttemptCount: 4, expectedAccountId: accountId }, "POST", { accountId });
  assert.equal(dismissed.body.request.status, "cancelled");
  assert.equal(dismissed.body.request.statusLabel, "Dismissed");
  assert.equal(dismissed.body.request.isActive, false);
  assert.equal(dismissed.body.request.canRetry, false);
  assert.equal((await dismissOwnedTaskRequest({ ...retry, expectedAttemptCount: 4 })).status, "cancelled");
  assert.equal((await getOwnedTaskRequest({ accountId, requestId: retryId })).status, "cancelled", "dismissal retains the durable receipt");
  assert.equal((await dismissOwnedTaskRequest({ ...retry, requestId: ids.requestId, expectedAttemptCount: 2 })).status, "proposed", "a generated task cannot be dismissed through a request");
  const activeId = `${accountId}_newer_2`;
  await query("UPDATE task_requests SET status='generating',worker_attempt_count=1 WHERE request_id=$1", [activeId]);
  assert.equal((await dismissOwnedTaskRequest({ accountId, requestId: activeId, expectedAttemptCount: 1 })).status, "generating");
  console.log(JSON.stringify({ ok: true, concurrentRetries: 12, immutableCompletion: true, conflicts: 5, oldReceiptLookup: true }));
} finally {
  await query("DELETE FROM task_requests WHERE account_id=$1", [accountId]);
  await closePool();
}
