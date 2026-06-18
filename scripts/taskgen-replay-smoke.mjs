import assert from "node:assert/strict";

import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  buildTaskgenReplayKey,
  findPublishedTaskgenOfferByTaskId,
  getTaskgenReplay,
  hasGeneratedTaskgenReplay,
  hasPublishedTaskgenReplay,
  recordTaskgenReplayGenerated,
  recordTaskgenReplayPublished,
} from "../server/repositories/taskgen-replay-cache.js";
import { taskgenReplayIdentity } from "../server/task-generation-worker.js";

process.env.TASKNODE_TASKGEN_MODEL = "taskgen-replay-smoke-model";

const taskInput = {
  schema: "pf.taskgen.input.v1",
  request_bundle: {
    bundle_id: "bundle_replay_smoke",
    cid: "QmReplaySmokeBundle",
    digest: "sha256:bundle-digest",
  },
  request: {
    request_id: "req_replay_smoke",
    requestedTaskKind: "network",
    source: "network_task",
  },
  context: {},
  chat: {},
  memory: {},
  task_queue: {},
  network_task: {
    generation_job_id: "nettaskjob_replay_smoke",
    allocation_id: "netalloc_replay_smoke",
    project_id: "project_replay_smoke",
    task_class: "network",
    source_payload_digest: "sha256:source-payload-a",
  },
  wallet: { wallet_address: "rReplaySmoke" },
  policy: {
    task_class: "network",
    reward_policy_version: "network-reward-policy-v1",
    task_policy_version: "task-policy-network-v1",
    generation_policy_version: "taskgen-policy-network-v1",
  },
};

const identity = taskgenReplayIdentity({
  taskInput,
  request: {
    requestId: "req_replay_smoke",
    requestBundleCid: "QmReplaySmokeBundle",
    requestedTaskKind: "network",
  },
  requestBundle: {
    bundle_id: "bundle_replay_smoke",
  },
  requestBundleCid: "QmReplaySmokeBundle",
  requestBundleDigest: "sha256:bundle-digest",
});
const sameIdentity = taskgenReplayIdentity({
  taskInput,
  request: {
    requestId: "req_replay_smoke",
    requestBundleCid: "QmReplaySmokeBundle",
    requestedTaskKind: "network",
  },
  requestBundle: {
    bundle_id: "bundle_replay_smoke",
  },
  requestBundleCid: "QmReplaySmokeBundle",
  requestBundleDigest: "sha256:bundle-digest",
});
assert.equal(identity.replay_key, sameIdentity.replay_key);
assert.match(identity.replay_key, /^taskgen_[a-f0-9]{48}$/);
assert.equal(identity.source_payload_digest, "sha256:source-payload-a");
assert.equal(identity.model, "taskgen-replay-smoke-model");
assert.equal(identity.task_class, "network");

const changedSourceKey = buildTaskgenReplayKey({
  ...identity,
  source_payload_digest: "sha256:source-payload-b",
});
assert.notEqual(changedSourceKey, identity.replay_key);

const changedBundleKey = buildTaskgenReplayKey({
  ...identity,
  request_bundle_cid: "QmReplaySmokeBundleChanged",
});
assert.notEqual(changedBundleKey, identity.replay_key);

assert.equal(hasGeneratedTaskgenReplay(null), false);
assert.equal(hasPublishedTaskgenReplay(null), false);
assert.equal(hasGeneratedTaskgenReplay({
  replayKey: identity.replay_key,
  taskId: "task_replay_smoke",
  taskgenOutput: { title: "Replay smoke" },
}), true);
assert.equal(hasPublishedTaskgenReplay({
  replayKey: identity.replay_key,
  status: "generated",
  taskId: "task_replay_smoke",
  taskgenOutput: { title: "Replay smoke" },
  offerCid: "QmReplaySmokeOffer",
  offerTxHash: "ABC",
}), false);
assert.equal(hasPublishedTaskgenReplay({
  replayKey: identity.replay_key,
  status: "published",
  taskId: "task_replay_smoke",
  taskgenOutput: { title: "Replay smoke" },
  offerCid: "QmReplaySmokeOffer",
  offerTxHash: "ABC",
}), true);

if (databaseEnabled()) {
  await migrateDatabase();
  await query("DELETE FROM taskgen_replay_cache WHERE replay_key = $1", [identity.replay_key]);
  await query("DELETE FROM task_events WHERE id = $1", ["evt_taskgen_replay_smoke"]);
  await recordTaskgenReplayGenerated({
    replayKey: identity.replay_key,
    identity,
    taskId: "task_replay_smoke",
    subjectWallet: "rReplaySmoke",
    taskgenOutput: { title: "Replay smoke", reward_offer: { amount_estimate_pft: "2.50" } },
    taskgenMetadata: { provider: "smoke", model: identity.model },
  });
  const generated = await getTaskgenReplay(identity.replay_key);
  assert.equal(hasGeneratedTaskgenReplay(generated), true);
  assert.equal(hasPublishedTaskgenReplay(generated), false);
  await recordTaskgenReplayPublished({
    replayKey: identity.replay_key,
    identity,
    taskId: "task_replay_smoke",
    subjectWallet: "rReplaySmoke",
    offerCid: "QmReplaySmokeOffer",
    offerDigest: "sha256:offer",
    offerTxHash: "ABC",
    taskgenOutput: { title: "Replay smoke", reward_offer: { amount_estimate_pft: "2.50" } },
    taskgenMetadata: { provider: "smoke", model: identity.model },
    offerPayload: { task_id: "task_replay_smoke", title: "Replay smoke" },
  });
  const published = await getTaskgenReplay(identity.replay_key);
  assert.equal(hasPublishedTaskgenReplay(published), true);
  assert.equal(published.offerCid, "QmReplaySmokeOffer");
  await query(
    `
      INSERT INTO task_events (
        id, task_id, account_id, wallet_address, event_type,
        source_tx_hash, source_cid, payload_json
      )
      VALUES ($1, $2, $3, $4, 'pf.task.offer.v1', $5, $6, $7::jsonb)
    `,
    [
      "evt_taskgen_replay_smoke",
      "task_replay_smoke",
      "acct_replay_smoke",
      "rReplaySmoke",
      "ABC_RECOVERED",
      "QmReplaySmokeRecoveredOffer",
      JSON.stringify({
        task_id: "task_replay_smoke",
        request_id: "req_replay_smoke",
        subject_wallet: "rReplaySmoke",
        title: "Recovered replay smoke",
      }),
    ]
  );
  const recoveredOffer = await findPublishedTaskgenOfferByTaskId({
    taskId: "task_replay_smoke",
    requestId: "req_replay_smoke",
  });
  assert.equal(recoveredOffer.offerCid, "QmReplaySmokeRecoveredOffer");
  assert.equal(recoveredOffer.txHash, "ABC_RECOVERED");
  await query("DELETE FROM task_events WHERE id = $1", ["evt_taskgen_replay_smoke"]);
  await query("DELETE FROM taskgen_replay_cache WHERE replay_key = $1", [identity.replay_key]);
  await closePool();
}

console.log("taskgen replay smoke ok");
