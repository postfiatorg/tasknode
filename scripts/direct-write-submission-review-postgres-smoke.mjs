// #347: a direct-write submission stored its event but left
// `submission.summaries` empty, so recorded evidence looked missing, and a
// failing verification-request worker left the task in `submitted` with both
// evidence gates closed and nothing on the task to say why.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { applyOffchainTaskTransition } from "../server/offchain-task-lifecycle.js";
import { getTaskDetail, getTerminalTaskProjectionDetail, importTaskReplayReceipt } from "../server/repositories/tasks.js";
import { processTaskReviewQueueOnce } from "../server/task-review-worker.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the direct-write submission summary smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_direct_summary_${suffix}`;
const walletAddress = `rDirectSummary${suffix}`;
const taskId = `task_direct_summary_${suffix}`;
const privateBody = `Private evidence body ${suffix} https://example.com/private-proof`;

await importTaskReplayReceipt({
  run_id: `direct_summary_${suffix}`,
  task_id: taskId,
  fixture: { account_id: accountId, request_id: `req_direct_summary_${suffix}` },
  wallets: [{ role: "user", address: walletAddress }],
  // An earlier indexed summary must survive the appended direct-write one.
  submission_summaries: [{ type: "Replay", summary: "Indexed from PFTL replay." }],
  generated_task: { title: "Direct-write summary smoke" },
  hydrated_events: [{
    schema: "pf.task.offer.v1",
    task_id: taskId,
    payload: { schema: "pf.task.offer.v1", task_id: taskId, title: "Direct-write summary smoke" },
  }],
  projection: { [taskId]: { status: "accepted", title: "Direct-write summary smoke", events: [{}] } },
}, { source: "direct_write_summary_smoke", sourceRef: "direct-write-submission-summary-smoke" });

async function detail() {
  return getTerminalTaskProjectionDetail({ accountId, walletAddress, taskId });
}

const submitInput = {
  accountId,
  walletAddress,
  task: { task_id: taskId, status: "accepted" },
  transition: "submitted",
  payload: { evidence_items: [{ artifact_type: "url", value: privateBody }] },
  metadata: { endpoint: "POST /api/tasks/submission", submissionMode: "initial_submission" },
};
const submitted = await applyOffchainTaskTransition(submitInput);
assert.equal(submitted.eventInserted, true);

const afterSubmit = await detail();
assert.equal(afterSubmit.task.statusKey || afterSubmit.task.status, "submitted");
assert.equal(afterSubmit.submission.summaries.length, 2, "direct-write submission must be visible");
const [replaySummary, directSummary] = afterSubmit.submission.summaries;
assert.equal(replaySummary.type, "Replay");
assert.equal(directSummary.type, "Initial submission");
assert.equal(directSummary.summary, "Initial submission recorded directly in Task Node with 1 evidence item (url).");
assert.equal(directSummary.eventId, submitted.event.eventId);
assert.equal(directSummary.cid, submitted.event.sourceCid);
assert.equal(directSummary.source, "direct_write");
assert.equal(JSON.stringify(afterSubmit.submission).includes(privateBody), false, "evidence body must stay out of summaries");

// Replaying the same stored event (same tx/cid refs) inserts nothing and must not duplicate the summary.
const replayed = await applyOffchainTaskTransition({
  ...submitInput,
  payload: {
    ...submitInput.payload,
    offchainPayload: { event_id: submitted.event.eventId },
    sourceTxHash: submitted.event.sourceTxHash,
    sourceCid: submitted.event.sourceCid,
  },
});
assert.equal(replayed.eventInserted, false);
assert.equal((await detail()).submission.summaries.length, 2);

// No authority seed is configured, so the real worker pass fails, one of the
// causes listed in #347.
for (const key of [
  "TASKNODE_AUTHORITY_SEED",
  "TASKNODE_SERVICE_SEED",
  "TASKNODE_ENCRYPTION_SEED",
  "TASKNODE_PFT_FAUCET_SEED",
  "FAUCET_SEED",
]) {
  delete process.env[key];
}
const quietLogger = { info() {}, warn() {} };
function reviewStatus(value) {
  const { phase, stalled, failureCount, lastErrorCode } = value.verificationRequestStatus || {};
  return { phase, stalled, failureCount, lastErrorCode };
}
async function runWorkerPass() {
  const pass = await processTaskReviewQueueOnce({ limit: 3, logger: quietLogger });
  return pass.results.find((result) => result.taskId === taskId);
}
async function expireRetryBackoff() {
  await query(
    `UPDATE task_projections
        SET metadata_json = jsonb_set(metadata_json, '{workers,verification_request,retry_after}', '""'::jsonb)
      WHERE task_id = $1`,
    [taskId]
  );
}

assert.deepEqual(reviewStatus(await detail()), { phase: "queued", stalled: false, failureCount: 0, lastErrorCode: "" });

assert.deepEqual(await runWorkerPass(), {
  ok: false,
  taskId,
  phase: "verification_request",
  error: "task_authority_seed_missing",
});
const afterFirstFailure = await detail();
assert.deepEqual(reviewStatus(afterFirstFailure), {
  phase: "retrying",
  stalled: false,
  failureCount: 1,
  lastErrorCode: "task_authority_seed_missing",
});
assert.ok(afterFirstFailure.verificationRequestStatus.retryAfter, "retry backoff is reported");
assert.equal(await runWorkerPass(), undefined, "backoff keeps the task out of the next pass");

for (let attempt = 0; attempt < 2; attempt += 1) {
  await expireRetryBackoff();
  assert.equal((await runWorkerPass())?.error, "task_authority_seed_missing");
}
// The #1280 state: still submitted, both gates closed, no request. The task
// now says the request is overdue instead of looking like nothing happened.
for (const view of [await detail(), await getTaskDetail({ accountId, walletAddress, taskId })]) {
  assert.equal(view.task.statusKey || view.task.status, "submitted");
  assert.equal(view.actions.canSubmitInitialEvidence, false);
  assert.equal(view.actions.canSubmitVerificationEvidence, false);
  assert.deepEqual(reviewStatus(view), {
    phase: "retrying",
    stalled: true,
    failureCount: 3,
    lastErrorCode: "task_authority_seed_missing",
  });
  assert.match(view.verificationRequestStatus.message, /do not resubmit or cancel/);
}

// A worker that never ran (disabled, or never claimed the task) is caught by age alone.
await query(
  `UPDATE task_projections
      SET metadata_json = metadata_json - 'workers', last_event_at = now() - interval '2 hours'
    WHERE task_id = $1`,
  [taskId]
);
assert.deepEqual(reviewStatus(await detail()), { phase: "queued", stalled: true, failureCount: 0, lastErrorCode: "" });

const responded = await applyOffchainTaskTransition({
  accountId,
  walletAddress,
  task: { task_id: taskId, status: "verification_requested" },
  transition: "verification_response_submitted",
  payload: {
    offchainPayload: { response_summary: "Answered the verification question.", response: "Private answer text" },
  },
});
const afterResponse = await detail();
assert.equal(afterResponse.verificationRequestStatus, null, "only submitted tasks report a pending request");
assert.equal(afterResponse.submission.summaries.length, 3);
assert.deepEqual(
  { type: afterResponse.submission.summaries[2].type, summary: afterResponse.submission.summaries[2].summary },
  { type: "Verification response", summary: "Answered the verification question." }
);
assert.equal(afterResponse.submission.summaries[2].eventId, responded.event.eventId);
assert.equal(JSON.stringify(afterResponse.submission).includes("Private answer text"), false);

const eventCount = await query("SELECT count(*)::int AS count FROM task_events WHERE task_id = $1", [taskId]);
assert.equal(eventCount.rows[0].count, 2);

console.log(`direct-write submission review smoke ok: ${taskId}`);
await closePool();
