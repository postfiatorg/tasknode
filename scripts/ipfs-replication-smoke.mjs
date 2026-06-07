import assert from "node:assert/strict";
import { classifyIpfsPayloadForReplication } from "../server/context-ipfs.js";
import {
  pinCidWithConfiguredInterface,
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
  fetchImpl: async (url) => {
    assert.equal(url, `https://clean.example/ipfs/${cid}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal(cleanJson.ok, true);
assert.equal(cleanJson.gateway, "https://clean.example/ipfs/");

const badJson = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "task_reward",
  env: { TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/" },
  fetchImpl: async () => new Response("not json", {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
assert.equal(badJson.ok, false);
assert.equal(badJson.error, "json_parse_failed");

const image = await verifyCidOnCleanGateway({
  cid,
  payloadClass: "profile_nft_image",
  env: {
    TASKNODE_IPFS_CLEAN_GATEWAY: "https://clean.example/ipfs/",
    TASKNODE_IPFS_REPLICATION_STRICT_CONTENT_TYPE: "true",
  },
  fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
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

console.log("ipfs replication smoke ok");
