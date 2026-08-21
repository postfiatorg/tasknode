import assert from "node:assert/strict";
import { classifyIpfsPayloadForReplication } from "../server/context-ipfs.js";
import {
  pinCidWithConfiguredInterface,
  processIpfsReplicationJobsOnce,
  verifyCidOnCleanGateway,
} from "../server/ipfs-replication-worker.js";

const cid = "Qm11111111111111111111111111111111111111111111";

assert.equal(
  classifyIpfsPayloadForReplication({ keyvalues: { schema: "pf.reward.v1" } }),
  "task_reward"
);
assert.equal(
  classifyIpfsPayloadForReplication({ keyvalues: { schema: "pf.daily_airdrop.v1" } }),
  "daily_airdrop"
);
assert.equal(
  classifyIpfsPayloadForReplication({ keyvalues: { schema: "pf.task.offer.v1" } }),
  "task_offer"
);
assert.equal(
  classifyIpfsPayloadForReplication({ keyvalues: { type: "profile_nft_image" } }),
  "profile_nft_image"
);
assert.equal(
  classifyIpfsPayloadForReplication({ keyvalues: { type: "profile_nft_metadata" } }),
  "profile_nft_metadata"
);

const cleanJson = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "task_reward",
  env: { TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/" },
  fetchImpl: async (url, options = {}) => {
    assert.equal(url, `https://clean.example/ipfs/${cid}`);
    assert.equal(options.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(cleanJson.ok, true);
assert.equal(cleanJson.gateway, "https://clean.example/ipfs/");
assert.equal(cleanJson.verifyMethod, "HEAD");

let largeDownloaded = false;
const largeImage = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "profile_nft_image",
  env: {
    TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/",
    TASKNODE_IPFS_REPLICATION_STRICT_CONTENT_TYPE: "true",
  },
  fetchImpl: async (url, options = {}) => {
    assert.equal(options.method, "HEAD");
    largeDownloaded = false;
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(2 * 1024 * 1024),
      },
    });
  },
});
assert.equal(largeImage.ok, true);
assert.equal(largeImage.verifyMethod, "HEAD");
assert.equal(largeDownloaded, false);

const rangeFallback = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "task_reward",
  env: { TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/" },
  fetchImpl: async (url, options = {}) => {
    assert.equal(url, `https://clean.example/ipfs/${cid}`);
    if (options.method === "HEAD") {
      return new Response(null, { status: 405 });
    }
    assert.equal(options.method, "GET");
    assert.equal(options.headers.range, "bytes=0-0");
    return new Response(new Uint8Array([123]), {
      status: 206,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(rangeFallback.ok, true);
assert.equal(rangeFallback.verifyMethod, "GET_RANGE");

const emptyFallback = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "task_reward",
  env: { TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/" },
  fetchImpl: async (url, options = {}) => {
    if (options.method === "HEAD") return new Response(null, { status: 405 });
    return new Response(new Uint8Array(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(emptyFallback.ok, false);
assert.equal(emptyFallback.error, "clean_gateway_empty_response");

const image = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "profile_nft_image",
  env: {
    TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/",
    TASKNODE_IPFS_REPLICATION_STRICT_CONTENT_TYPE: "true",
  },
  fetchImpl: async () => new Response(null, {
    status: 200,
    headers: { "content-type": "image/png" },
  }),
});
assert.equal(image.ok, true);

let endpointBody = null;
const pin = await pinCidWithConfiguredInterface({
  job: {
    cid,
    payloadClass: "task_reward",
    source: "pinata_json",
    sourceRef: "task_smoke",
    exactCidRequired: true,
  },
  env: {
    TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT: "https://pin.example/pin",
    TASKNODE_IPFS_REPLICATION_PIN_TOKEN: "secret",
    TASKNODE_IPFS_REPLICATION_MIN_REPLICAS: "2",
  },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://pin.example/pin");
    assert.equal(options.headers.authorization, "Bearer secret");
    endpointBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, status: "cluster_pinned_and_verified" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(pin.ok, true);
assert.equal(endpointBody.cid, cid);
assert.equal(endpointBody.payloadClass, "task_reward");
assert.equal(endpointBody.exactCidRequired, true);
assert.equal(endpointBody.minReplicas, 2);
assert.deepEqual(endpointBody.exactReaddGateways, [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
]);

const missingInterface = await pinCidWithConfiguredInterface({
  job: { cid, payloadClass: "task_reward" },
  env: {},
  fetchImpl: async () => {
    throw new Error("should_not_fetch");
  },
});
assert.equal(missingInterface.ok, false);
assert.equal(missingInterface.error, "first_party_pin_interface_missing");

const jobs = Array.from({ length: 7 }, (_, index) => ({
  id: `ipfsjob_smoke_${index + 1}`,
  cid: `${cid}_${index + 1}`,
  attempts: 0,
}));
let inFlight = 0;
let maxInFlight = 0;
const processed = [];
const concurrent = await processIpfsReplicationJobsOnce({
  env: { TASKNODE_IPFS_REPLICATION_CONCURRENCY: "3" },
  claimJobs: async () => ({ ok: true, jobs }),
  fetchImpl: async (_job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return { ok: true, job: { status: "verified" } };
  },
  jobProcessor: async ({ job, fetchImpl }) => {
    const result = await fetchImpl(job);
    processed.push(job.id);
    return result;
  },
  markFailed: async () => {
    throw new Error("should_not_mark_failed");
  },
  logger: { warn: () => {} },
});
assert.equal(concurrent.ok, true);
assert.equal(concurrent.claimed, jobs.length);
assert.equal(concurrent.processed, jobs.length);
assert.equal(concurrent.failed, 0);
assert.equal(processed.length, jobs.length);
assert.ok(maxInFlight <= 3, `max in-flight ${maxInFlight} exceeded concurrency bound`);
assert.ok(maxInFlight > 1, "batch did not process concurrently");

console.log("ipfs replication smoke ok");
