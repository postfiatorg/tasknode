import assert from "node:assert/strict";
import {
  selectReplayWindowCids,
  summarizeReplayWindow,
  verifyReplayWindow,
} from "./ipfs-active-replay-window.mjs";

const contextCid = "QmTNtQcR1qDkEAsCEPK53TY4Yr6Ro64K4z8ZETSMmS5hsK";
const taskCid = "QmZP51kHQvcRyDQRkHNPCzW3pJshB23RfHnjhV4NoxU2gs";
const rewardCid = "QmP4MKiBHeDsmh5LgeYd29RBngZDhWRA2JL7Kj5QpYhykg";
const missingCid = "QmbEBhmJowxRY1hGVTHrdkWBNNFxfHHFxFN872p4hZJeHP";

const records = [
  {
    source: "pftl_pointer_memos",
    cid: contextCid,
    payloadClass: "context_json",
    contextId: "ctx_1",
    observedAt: "2026-06-06T12:00:00.000Z",
  },
  {
    source: "pftl_pointer_memos",
    cid: taskCid,
    payloadClass: "task_json",
    taskId: "task_1",
    observedAt: "2026-06-06T11:00:00.000Z",
  },
  {
    source: "task_events",
    cid: taskCid,
    payloadClass: "task_json",
    taskId: "task_1",
    observedAt: "2026-06-06T11:30:00.000Z",
  },
  {
    source: "task_events",
    cid: rewardCid,
    payloadClass: "reward_json",
    taskId: "task_2",
    observedAt: "2026-06-06T10:00:00.000Z",
  },
  {
    source: "task_events",
    cid: missingCid,
    payloadClass: "task_submission_json",
    taskId: "task_3",
    observedAt: "2026-06-06T09:00:00.000Z",
  },
];

const selected = selectReplayWindowCids(records, { perClass: 3, maxCids: 10 });
assert.equal(selected.length, 4);
assert.equal(selected[0].cid, contextCid);
assert.deepEqual(selected.find((entry) => entry.cid === taskCid).payloadClasses, ["task_json"]);

const fetchImpl = async (url) => {
  const text = String(url || "");
  if (text.includes(missingCid)) return new Response("missing", { status: 404 });
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "2" },
  });
};

const verified = await verifyReplayWindow({
  entries: selected,
  currentGateways: ["https://current.example/ipfs/"],
  timeoutMs: 1000,
  concurrency: 2,
  fetchImpl,
});
const summary = summarizeReplayWindow(verified);

assert.equal(summary.selectedCids, 4);
assert.equal(summary.okCount, 3);
assert.equal(summary.failureCount, 1);
assert.equal(verified.find((entry) => entry.cid === contextCid).firstCurrentGateway, "https://current.example/ipfs/");
assert.equal(verified.find((entry) => entry.cid === missingCid).ok, false);

console.log("ipfs-active-replay-window-smoke ok");
