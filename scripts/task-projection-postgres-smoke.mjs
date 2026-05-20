import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import { getTaskDetail, importTaskReplayReceipt, listTaskState } from "../server/repositories/tasks.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for task projection Postgres smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_task_pg_smoke_${suffix}`;
const walletAddress = `rTaskSmoke${suffix}`;
const taskId = `task_smoke_${suffix}`;
const receipt = {
  run_id: `task_projection_smoke_${suffix}`,
  task_id: taskId,
  fixture: {
    account_id: accountId,
    request_id: `req_smoke_${suffix}`,
  },
  wallets: [
    { role: "user", address: walletAddress },
    { role: "task_authority", address: `rAuthoritySmoke${suffix}` },
    { role: "allocation_reward", address: `rAllocationSmoke${suffix}` },
  ],
  cids: {
    context_doc: `QmContextSmoke${suffix}`,
    request_bundle: `QmBundleSmoke${suffix}`,
    offer: `QmOfferSmoke${suffix}`,
    reward: `QmRewardSmoke${suffix}`,
  },
  txs: {
    reward: { tx_hash: `REWARD_TX_${suffix}` },
  },
  taskgen: {
    model: "chat-latest",
    openai_response_id: `resp_smoke_${suffix}`,
  },
  generated_task: {
    title: "Smoke projected PFTL task",
    description: "Verify task projections can be imported and listed from Postgres.",
    task_kind: "engineering",
    steps: [
      "Import a replay receipt with generated task steps.",
      "List the projected task state from Postgres.",
      "Open task detail and confirm audit fields are present.",
    ],
    reward_offer: { amount_estimate_pft: "3.00" },
    submission_requirement: {
      type: "text",
      criteria: "Submit smoke evidence.",
    },
    verification_policy: { mode: "manual_review" },
    deadline: {
      accept_by: "2026-05-25T00:00:00Z",
      deadline_at: "2026-05-28T00:00:00Z",
    },
  },
  hydrated_events: [
    {
      schema: "pf.task.offer.v1",
      task_id: taskId,
      tx_hash: `OFFER_TX_${suffix}`,
      cid: `QmOfferSmoke${suffix}`,
      payload: {
        schema: "pf.task.offer.v1",
        task_id: taskId,
        event_id: `evt_offer_${suffix}`,
        title: "Smoke projected PFTL task",
        task_kind: "engineering",
        reward_offer: { amount_estimate_pft: "3.00" },
      },
    },
    {
      schema: "pf.reward.v1",
      task_id: taskId,
      tx_hash: `REWARD_TX_${suffix}`,
      cid: `QmRewardSmoke${suffix}`,
      payload: {
        schema: "pf.reward.v1",
        task_id: taskId,
        event_id: `evt_reward_${suffix}`,
        reward_pft: "3.00",
        reward_tier: "accepted",
        reward_score: 100,
        evidence_refs: [
          {
            artifact_cid: `QmEvidenceSmoke${suffix}`,
            artifact_type: "url",
            artifact_digest: `sha256:evidence${suffix}`,
          },
        ],
        processed_evidence: {
          artifacts: [
            {
              artifact_type: "url",
              status: "extracted",
              source: { url: "https://example.com/task-evidence" },
              excerpt: "Smoke evidence excerpt.",
            },
          ],
        },
      },
    },
  ],
  projection: {
    [taskId]: {
      status: "rewarded",
      title: "Smoke projected PFTL task",
      task_kind: "engineering",
      reward_offer_pft: "3.00",
      reward_actual_pft: "3.00",
      request_bundle_cid: `QmBundleSmoke${suffix}`,
      events: [{}, {}],
    },
  },
};

const imported = await importTaskReplayReceipt(receipt, {
  source: "task_projection_smoke",
  sourceRef: "task-projection-postgres-smoke",
});
assert.equal(imported.ok, true);
assert.equal(imported.taskId, taskId);

const state = await listTaskState({ accountId, walletAddress });
assert.equal(state.sync.status, "ready");
assert.equal(state.sync.projectionCount, 1);
assert.equal(state.rewarded.length, 1);
assert.equal(state.rewarded[0].taskId, taskId);
assert.equal(state.rewarded[0].title, "Smoke projected PFTL task");
assert.equal(state.rewarded[0].pft, 3);
assert.deepEqual(state.rewarded[0].steps, receipt.generated_task.steps);

const detail = await getTaskDetail({ accountId, walletAddress, taskId });
assert.equal(detail.ok, true);
assert.equal(detail.task.taskId, taskId);
assert.deepEqual(detail.task.steps, receipt.generated_task.steps);
assert.equal(detail.forensics.timeline.length, 2);
assert.equal(detail.forensics.timeline[0].cid, `QmOfferSmoke${suffix}`);
assert.equal(detail.forensics.timeline[0].details.some((entry) => entry.label === "Title"), true);
assert.equal(detail.forensics.timeline[0].details.some((entry) => entry.label === "Event ID"), true);
assert.equal(detail.forensics.timeline[1].details.some((entry) => entry.label === "Evidence refs"), true);
assert.equal(detail.forensics.timeline[1].details.some((entry) => entry.label === "Processed artifacts"), true);
assert.equal(detail.forensics.transactions.some((entry) => entry.txHash === `OFFER_TX_${suffix}`), true);
assert.equal(detail.forensics.transactions.some((entry) => entry.txHash === `REWARD_TX_${suffix}`), true);
assert.equal(detail.forensics.cids.some((entry) => entry.cid === `QmBundleSmoke${suffix}`), true);
assert.equal(detail.forensics.cids.some((entry) => entry.cid === `QmOfferSmoke${suffix}`), true);

console.log(`task projection postgres smoke ok: ${taskId}`);
await closePool();
