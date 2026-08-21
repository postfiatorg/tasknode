import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { publishTaskLifecycleAction } from "../src/features/tasks/task-actions.js";
import { publishTaskRequest } from "../src/features/tasks/task-request-actions.js";
import {
  evaluateTaskRequestUnlockPolicy,
  evaluateTaskSigningUnlockPolicy,
  TASK_REQUEST_UNLOCK_STATES,
} from "../src/features/tasks/task-request-unlock-policy.js";
import { publishTaskEvidenceSubmission } from "../src/features/tasks/task-submission-actions.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const accountId = "acct_offchain_smoke";
const wallet = "rOffchainSmokeWallet";
const directLifecycle = { enabled: true, dualWrite: false, writeSource: "direct_write" };
const pointerLifecycle = { enabled: false, dualWrite: false, writeSource: "pftl_pointer" };
const calls = [];
let requestDirectMode = true;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function readBody(options = {}) {
  return JSON.parse(String(options.body || "{}"));
}

globalThis.fetch = async (path, options = {}) => {
  const body = readBody(options);
  calls.push({ path, body });
  if (path === "/api/tasks/request") {
    if (body.phase === "config") {
      return jsonResponse({
        ok: true,
        requestId: body.requestId,
        bundleId: body.bundleId,
        tasknodeEncryptionPubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        offchainLifecycle: requestDirectMode ? directLifecycle : pointerLifecycle,
        wallets: { user: wallet, authority: "rAuthority" },
        requestBundle: {
          bundle_id: body.bundleId,
          request: {
            request_id: body.requestId,
            request_text: body.requestText,
            user_detail_text: body.userDetailText,
            requested_task_kind: body.requestedTaskKind,
          },
        },
      });
    }
    if (body.phase === "submit") {
      assert.equal(body.signedTxBlob, undefined, "direct task request must not submit signedTxBlob");
      return jsonResponse({
        ok: true,
        phase: "submitted",
        requestId: body.requestId,
        bundleId: body.bundleId,
        cid: `postgres:${body.requestId}`,
        bundleCid: "QmDirectBundle",
        txHash: `offchain:${body.requestId}`,
        offchainLifecycle: directLifecycle,
      });
    }
  }
  if (path === "/api/tasks/submission") {
    if (body.phase === "config") {
      return jsonResponse({
        ok: true,
        taskId: body.taskId,
        submissionMode: "initial_submission",
        actions: { canSubmitInitialEvidence: true },
        wallets: { user: wallet, authority: "rAuthority", allocation: "" },
        offchainLifecycle: directLifecycle,
      });
    }
    if (body.phase === "submit") {
      assert.equal(body.signedTxBlob, undefined, "direct evidence submit must not submit signedTxBlob");
      assert.equal(body.offchainPayload?.task_id, "task_submit_smoke");
      return jsonResponse({
        ok: true,
        phase: "submitted",
        taskId: body.taskId,
        cid: "postgres:evt_submission",
        txHash: "offchain:evt_submission",
        offchainLifecycle: directLifecycle,
      });
    }
  }
  if (path === "/api/tasks/action") {
    if (body.phase === "config") {
      return jsonResponse({
        ok: true,
        taskId: body.taskId,
        status: "proposed",
        actions: { canAccept: true },
        wallets: { user: wallet, authority: "rAuthority", allocation: "" },
        offchainLifecycle: directLifecycle,
      });
    }
    if (body.phase === "submit") {
      assert.equal(body.signedTxBlob, undefined, "direct task action must not submit signedTxBlob");
      assert.equal(body.offchainPayload?.task_id, "task_accept_smoke");
      return jsonResponse({
        ok: true,
        phase: "submitted",
        taskId: body.taskId,
        cid: "postgres:evt_accept",
        txHash: "offchain:evt_accept",
        offchainLifecycle: directLifecycle,
      });
    }
  }
  throw new Error(`Unexpected fetch ${path} ${body.phase || ""}`);
};

const directRequestPolicy = evaluateTaskRequestUnlockPolicy({
  accountId,
  directOffchain: true,
  linkedWalletAddress: wallet,
  walletSecret: null,
  walletVault: { available: false, address: wallet, unlocked: false },
});
assert.equal(directRequestPolicy.allowed, true);
assert.equal(directRequestPolicy.state, TASK_REQUEST_UNLOCK_STATES.OFFCHAIN_READY);

const pointerRequestPolicy = evaluateTaskRequestUnlockPolicy({
  accountId,
  directOffchain: false,
  linkedWalletAddress: wallet,
  walletSecret: null,
  walletVault: { available: true, address: wallet, unlocked: false },
});
assert.equal(pointerRequestPolicy.allowed, false);
assert.equal(pointerRequestPolicy.state, TASK_REQUEST_UNLOCK_STATES.LOCKED);

const directSigningPolicy = evaluateTaskSigningUnlockPolicy({
  accountId,
  directOffchain: true,
  linkedWalletAddress: wallet,
  walletSecret: null,
  walletVault: { available: false, address: wallet, unlocked: false },
});
assert.equal(directSigningPolicy.allowed, true);

const requestProgress = [];
const requestResult = await publishTaskRequest({
  accountId,
  linkedWalletAddress: wallet,
  walletSecret: null,
  requestId: "req_direct_smoke",
  bundleId: "bundle_direct_smoke",
  userDetailText: "Generate a small real task.",
  onProgress: (label) => requestProgress.push(label),
});
assert.equal(requestResult.txHash, "offchain:req_direct_smoke");
assert.deepEqual(requestProgress, ["Configuring request", "Submitting request"]);
assert.equal(requestProgress.includes("Signing transaction"), false);
assert.equal(requestProgress.includes("Publishing to PFTL"), false);

requestDirectMode = false;
await assert.rejects(
  () =>
    publishTaskRequest({
      accountId,
      linkedWalletAddress: wallet,
      walletSecret: null,
      requestId: "req_pointer_smoke",
      bundleId: "bundle_pointer_smoke",
      userDetailText: "Generate a pointer-mode task.",
    }),
  /Unlock the local seed vault/
);
requestDirectMode = true;

const evidenceProgress = [];
const evidenceResult = await publishTaskEvidenceSubmission({
  accountId,
  linkedWalletAddress: wallet,
  walletSecret: null,
  detail: { actions: { canSubmitInitialEvidence: true } },
  task: { taskId: "task_submit_smoke" },
  value: "Real evidence.",
  onProgress: (label) => evidenceProgress.push(label),
});
assert.equal(evidenceResult.txHash, "offchain:evt_submission");
assert.deepEqual(evidenceProgress, ["Configuring evidence", "Recording evidence"]);
assert.equal(evidenceProgress.includes("Signing transaction"), false);
assert.equal(evidenceProgress.includes("Publishing to PFTL"), false);

const actionResult = await publishTaskLifecycleAction({
  accountId,
  linkedWalletAddress: wallet,
  walletSecret: null,
  task: { taskId: "task_accept_smoke" },
  taskAction: "accept",
});
assert.equal(actionResult.txHash, "offchain:evt_accept");

assert.equal(calls.some((call) => call.body.phase === "prepare"), false);
assert.equal(calls.some((call) => call.body.signedTxBlob), false);

console.log("task client offchain completion smoke ok");
