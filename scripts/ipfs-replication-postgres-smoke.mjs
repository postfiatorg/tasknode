import assert from "node:assert/strict";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { processIpfsReplicationJobsOnce } from "../server/ipfs-replication-worker.js";
import {
  deleteIpfsReplicationJobsForTest,
  enqueueIpfsReplicationJob,
} from "../server/repositories/ipfs-replication-jobs.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

if (!databaseEnabled()) {
  console.log("ipfs replication postgres smoke skipped: database not configured");
  process.exit(0);
}

await migrateDatabase();

const suffix = Date.now().toString(36);
const sourceRef = `ipfs_replication_smoke_${suffix}`;
const cid = "Qm11111111111111111111111111111111111111111111";
await deleteIpfsReplicationJobsForTest({ sourceRefPrefix: sourceRef });

const enqueued = await enqueueIpfsReplicationJob({
  cid,
  payloadClass: "task_reward",
  source: "pinata_json",
  sourceRef,
  exactCidRequired: true,
  metadata: { smoke: true },
});
assert.equal(enqueued.ok, true);
assert.equal(enqueued.job.status, "queued");

let cleanGatewayCalls = 0;
let pinEndpointCalled = false;
const result = await processIpfsReplicationJobsOnce({
  limit: 1,
  workerId: `ipfs_replication_smoke_${suffix}`,
  env: {
    TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/",
    TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT: "https://pin.example/replicate-cid",
    TASKNODE_IPFS_REPLICATION_PIN_TOKEN: "secret",
    TASKNODE_IPFS_REPLICATION_MIN_REPLICAS: "2",
  },
  fetchImpl: async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl.startsWith("https://clean.example/ipfs/")) {
      cleanGatewayCalls += 1;
      if (cleanGatewayCalls === 1) {
        return new Response("missing", { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true, cid }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (textUrl === "https://pin.example/replicate-cid") {
      pinEndpointCalled = true;
      assert.equal(options.headers.authorization, "Bearer secret");
      const body = JSON.parse(options.body);
      assert.equal(body.cid, cid);
      assert.equal(body.payloadClass, "task_reward");
      assert.equal(body.minReplicas, 2);
      return new Response(JSON.stringify({ ok: true, status: "cluster_pinned_and_verified" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  },
});

assert.equal(result.processed, 1);
assert.equal(result.failed, 0);
assert.equal(pinEndpointCalled, true);
assert.equal(cleanGatewayCalls, 2);

const stored = await query(
  "SELECT status, verified_gateway, metadata_json FROM ipfs_replication_jobs WHERE id = $1",
  [enqueued.job.id]
);
assert.equal(stored.rows[0].status, "verified");
assert.equal(stored.rows[0].verified_gateway, "https://clean.example/ipfs/");
assert.equal(stored.rows[0].metadata_json.smoke, true);
assert.equal(stored.rows[0].metadata_json.pin.ok, true);

await deleteIpfsReplicationJobsForTest({ sourceRefPrefix: sourceRef });
await closePool();

console.log("ipfs replication postgres smoke ok");
