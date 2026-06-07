import assert from "node:assert/strict";
import {
  buildInventory,
  checkPinataCidStatus,
  recordsFromLegacyJsonRows,
  verifyInventory,
} from "./ipfs-cid-inventory.mjs";

const taskCid = "QmTNtQcR1qDkEAsCEPK53TY4Yr6Ro64K4z8ZETSMmS5hsK";
const imageCid = "QmZP51kHQvcRyDQRkHNPCzW3pJshB23RfHnjhV4NoxU2gs";
const metadataCid = "QmP4MKiBHeDsmh5LgeYd29RBngZDhWRA2JL7Kj5QpYhykg";
const missingCid = "QmbEBhmJowxRY1hGVTHrdkWBNNFxfHHFxFN872p4hZJeHP";

const legacyRows = [
  {
    id: "legacy_1",
    owner_wallet_address: "rLegacy",
    image_cid: imageCid,
    metadata_cid: metadataCid,
  },
  {
    id: "legacy_2",
    wallet_address: "rLegacy",
    cid: missingCid,
    payloadClass: "profile_nft_thumbnail",
  },
];

const records = [
  {
    cid: taskCid,
    source: "current_db",
    table: "pftl_pointer_memos",
    column: "cid",
    payloadClass: "task_json",
    taskId: "task_1",
    public: false,
    encrypted: true,
    exactCidRequired: true,
  },
  {
    cid: taskCid,
    source: "current_db",
    table: "task_events",
    column: "source_cid",
    payloadClass: "task_json",
    taskId: "task_1",
    public: false,
    encrypted: true,
    exactCidRequired: true,
  },
  ...recordsFromLegacyJsonRows(legacyRows),
];

const inventory = buildInventory(records);
assert.equal(inventory.length, 4);
const taskEntry = inventory.find((entry) => entry.cid === taskCid);
assert.equal(taskEntry.refCount, 2);
assert.equal(taskEntry.encrypted, true);
assert.equal(taskEntry.public, false);
assert.deepEqual(taskEntry.sources, ["current_db"]);
assert.deepEqual(taskEntry.payloadClasses, ["task_json"]);

const imageEntry = inventory.find((entry) => entry.cid === imageCid);
assert.equal(imageEntry.public, true);
assert.equal(imageEntry.exactCidRequired, true);
assert.deepEqual(imageEntry.payloadClasses, ["profile_nft_image"]);

const fetchImpl = async (url) => {
  const text = String(url || "");
  if (text.includes(taskCid) && text.startsWith("https://current.example/")) {
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "2" },
    });
  }
  if (text.includes(imageCid) && text.startsWith("https://legacy.example/")) {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    });
  }
  return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
};

const verified = await verifyInventory({
  inventory,
  currentGateways: ["https://current.example/ipfs/"],
  legacyGateways: ["https://legacy.example/ipfs/"],
  timeoutMs: 1000,
  concurrency: 2,
  fetchImpl,
});

assert.equal(verified.find((entry) => entry.cid === taskCid).migrationStatus, "current_resolvable");
assert.equal(verified.find((entry) => entry.cid === imageCid).migrationStatus, "needs_repin");
assert.equal(verified.find((entry) => entry.cid === missingCid).migrationStatus, "missing_from_all_gateways");
assert.equal(verified.find((entry) => entry.cid === imageCid).firstGateway, "https://legacy.example/ipfs/");
assert.equal(verified.find((entry) => entry.cid === imageCid).contentType, "image/png");
assert.equal(verified.find((entry) => entry.cid === imageCid).byteSize, 3);

const missingPinataConfig = await checkPinataCidStatus({ cid: taskCid, env: {}, fetchImpl });
assert.equal(missingPinataConfig.status, "not_configured");

let observedPinataUrl = "";
const pinataFetchImpl = async (url) => {
  const text = String(url || "");
  if (text.startsWith("https://api.pinata.cloud/data/pinList")) {
    observedPinataUrl = text;
    return new Response(JSON.stringify({
      rows: [
        {
          ipfs_pin_hash: taskCid,
          status: "pinned",
          date_pinned: "2026-06-06T00:00:00Z",
          metadata: { name: "task-cid" },
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return fetchImpl(url);
};

const pinataStatus = await checkPinataCidStatus({
  cid: taskCid,
  env: { PINATA_JWT: "pinata-jwt" },
  fetchImpl: pinataFetchImpl,
});
assert.equal(pinataStatus.status, "pinned");
assert.equal(pinataStatus.matchedHash, taskCid);
assert.ok(observedPinataUrl.includes(`hashContains=${encodeURIComponent(taskCid)}`));

const pinChecked = await verifyInventory({
  inventory: [taskEntry],
  currentGateways: ["https://current.example/ipfs/"],
  legacyGateways: ["https://legacy.example/ipfs/"],
  timeoutMs: 1000,
  concurrency: 1,
  checkPinata: true,
  env: { PINATA_JWT: "pinata-jwt" },
  fetchImpl: pinataFetchImpl,
});
assert.equal(pinChecked[0].currentPinProviderStatus, "pinned");
assert.equal(pinChecked[0].migrationStatus, "current_pinned");

console.log("ipfs-cid-inventory-smoke ok");
