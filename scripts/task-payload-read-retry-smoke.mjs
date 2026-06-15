import assert from "node:assert/strict";
import {
  encryptTasknodePayload,
  fetchAndDecryptTasknodePayload,
  tasknodeServiceIdentityFromEnv,
} from "../server/task-payloads.js";

const env = {
  TASKNODE_SERVICE_SEED: "task-payload-read-retry-smoke-seed",
  TASKNODE_IPFS_READ_RETRY_ATTEMPTS: "3",
  TASKNODE_IPFS_READ_RETRY_BACKOFF_MS: "1",
};
const identity = await tasknodeServiceIdentityFromEnv(env);
const encrypted = await encryptTasknodePayload({
  plaintext: JSON.stringify({ ok: true, source: "read-retry-smoke" }),
  recipientPublicKeys: [identity.publicKeyBase64],
});

let fetchCalls = 0;
const sleeps = [];
const hydrated = await fetchAndDecryptTasknodePayload({
  cid: "bafkreiretrysmoke",
  env,
  fetchIpfsJson: async ({ cid }) => {
    fetchCalls += 1;
    if (fetchCalls < 3) return { ok: false, error: `transient_${fetchCalls}` };
    return {
      ok: true,
      cid,
      gateway: "smoke-gateway",
      payload: encrypted,
    };
  },
  sleepFn: async (ms) => {
    sleeps.push(ms);
  },
});
assert.equal(fetchCalls, 3);
assert.deepEqual(sleeps, [1, 3]);
assert.equal(hydrated.gateway, "smoke-gateway");
assert.equal(hydrated.payload.source, "read-retry-smoke");

let decryptFailureFetchCalls = 0;
await assert.rejects(
  () => fetchAndDecryptTasknodePayload({
    cid: "bafkreidecryptfail",
    env,
    fetchIpfsJson: async () => {
      decryptFailureFetchCalls += 1;
      return { ok: true, payload: { enc: "bad-suite" } };
    },
    sleepFn: async () => {
      throw new Error("should_not_sleep_on_decryption_failure");
    },
  }),
  /task_payload_unsupported_encryption/
);
assert.equal(decryptFailureFetchCalls, 1);

console.log("task payload read retry smoke ok");
