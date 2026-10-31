// #347: a direct-write submission stored its event but left
// `submission.summaries` empty, so recorded evidence looked missing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { applyOffchainTaskTransition } from "../server/offchain-task-lifecycle.js";
import { getTerminalTaskProjectionDetail, importTaskReplayReceipt } from "../server/repositories/tasks.js";

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
assert.equal(afterResponse.submission.summaries.length, 3);
assert.deepEqual(
  { type: afterResponse.submission.summaries[2].type, summary: afterResponse.submission.summaries[2].summary },
  { type: "Verification response", summary: "Answered the verification question." }
);
assert.equal(afterResponse.submission.summaries[2].eventId, responded.event.eventId);
assert.equal(JSON.stringify(afterResponse.submission).includes("Private answer text"), false);

const eventCount = await query("SELECT count(*)::int AS count FROM task_events WHERE task_id = $1", [taskId]);
assert.equal(eventCount.rows[0].count, 2);

console.log(`direct-write submission summary smoke ok: ${taskId}`);
await closePool();
