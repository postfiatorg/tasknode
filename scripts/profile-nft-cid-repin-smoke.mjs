import assert from "node:assert/strict";
import { pinIpfsCidByHash } from "../server/context-ipfs.js";
import { collectProfileNftCids } from "./profile-nft-cid-repin.mjs";

const imageCid = "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq";
const metadataCid = "bafkreiew5ibtmvyrq3gjpxqsfeae6nvjkdfk3zguihtsa44am5nsyvob5y";
const thumbnailCid = "bafkreidoljnyeebcjz447cwqbix43cyzsc3noygyvcavrtcvjmo6oojfcq";

const cids = collectProfileNftCids([
  {
    id: "nft_1",
    account_id: "acct_1",
    wallet_address: "rWallet",
    title: "One",
    image_cid: imageCid,
    metadata_cid: metadataCid,
    metadata_json: { thumbnailCid },
  },
  {
    id: "nft_2",
    account_id: "acct_2",
    wallet_address: "rWallet2",
    nft_name: "Two",
    image_cid: imageCid,
    metadata_cid: metadataCid,
    thumbnail_cid: thumbnailCid,
  },
]);

assert.equal(cids.length, 3);
assert.equal(cids.find((entry) => entry.cid === imageCid)?.refCount, 2);
assert.deepEqual(cids.find((entry) => entry.cid === imageCid)?.kinds, ["image"]);
assert.equal(cids.find((entry) => entry.cid === metadataCid)?.refCount, 2);
assert.deepEqual(cids.find((entry) => entry.cid === thumbnailCid)?.kinds, ["thumbnail"]);

let observedRequest = null;
const pinned = await pinIpfsCidByHash({
  cid: imageCid,
  name: "profile_nft_image_smoke",
  keyvalues: { type: "profile_nft_legacy_repin", refCount: 2 },
  env: {
    PINATA_API_KEY: "pinata-key",
    PINATA_API_SECRET: "pinata-secret",
  },
  fetchImpl: async (url, options) => {
    observedRequest = {
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({ id: "pin-job" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

assert.equal(pinned.ok, true);
assert.equal(pinned.cid, imageCid);
assert.equal(observedRequest.url, "https://api.pinata.cloud/pinning/pinByHash");
assert.equal(observedRequest.method, "POST");
assert.equal(observedRequest.body.hashToPin, imageCid);
assert.equal(observedRequest.body.pinataMetadata.name, "profile_nft_image_smoke");
assert.equal(observedRequest.body.pinataMetadata.keyvalues.type, "profile_nft_legacy_repin");

await assert.rejects(
  () => pinIpfsCidByHash({
    cid: "not a cid",
    env: {
      PINATA_API_KEY: "pinata-key",
      PINATA_API_SECRET: "pinata-secret",
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }),
  /ipfs_cid_invalid/
);

await assert.rejects(
  () => pinIpfsCidByHash({
    cid: imageCid,
    env: {
      PINATA_API_KEY: "pinata-key",
      PINATA_API_SECRET: "pinata-secret",
    },
    fetchImpl: async () => new Response("provider unavailable", { status: 502 }),
  }),
  /pinata_pin_by_hash_http_502/
);

console.log("profile-nft-cid-repin-smoke ok");
