import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { Wallet } from "xrpl";
import { closePool, query } from "../server/db/pool.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";
import {
  markPftlReducerEventCompleted,
  processPftlReducerEvent,
} from "../server/pftl-cache-reducer.js";
import { tasknodeServiceIdentityFromEnv } from "../server/task-payloads.js";
import {
  enqueuePftlReducerEventsForTransaction,
  registerPftlSyncWallet,
  storePftlAccountTransactions,
} from "../server/repositories/pftl-cache.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) process.env.TASKNODE_DATABASE_ENABLED = "true";
if (!process.env.TASKNODE_ENCRYPTION_SEED) process.env.TASKNODE_ENCRYPTION_SEED = "reducer-smoke-service-seed";

const runId = `pftl_cache_reducer_${Date.now()}`;
const accountId = `acct_${runId}`;
const userWallet = Wallet.generate().address;
const authorityWallet = Wallet.generate().address;
const allocationWallet = Wallet.generate().address;
const contextTxHash = `PFTL_REDUCER_CONTEXT_${runId}`;
const taskTxHash = `PFTL_REDUCER_TASK_${runId}`;
const verificationRequestTxHash = `PFTL_REDUCER_VERIFICATION_${runId}`;
const rewardDecisionTxHash = `PFTL_REDUCER_REWARD_DECISION_${runId}`;
const nullTaskTxHash = `PFTL_REDUCER_NULL_TASK_${runId}`;
const txHashes = [contextTxHash, taskTxHash, verificationRequestTxHash, rewardDecisionTxHash, nullTaskTxHash];
const contextCid = `bafkreireducercontext${Date.now()}`;
const taskCid = `bafkreireducertask${Date.now()}`;
const verificationRequestCid = `bafkreireducerverification${Date.now()}`;
const rewardDecisionCid = `bafkreireducerrewarddecision${Date.now()}`;
const nullTaskCid = `bafkreireducernulltask${Date.now()}`;
const taskId = `task_${runId}`;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function b64(value) {
  return Buffer.from(value).toString("base64");
}

async function encryptForService(payload) {
  await sodium.ready;
  const identity = await tasknodeServiceIdentityFromEnv(process.env);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const fileKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    fileKey
  );
  const wrapNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ephemeral = sodium.crypto_box_keypair();
  const encryptedFileKey = sodium.crypto_box_easy(
    fileKey,
    wrapNonce,
    identity.publicKey,
    ephemeral.privateKey
  );
  return {
    version: 1,
    enc: "ENC_X25519_XCHACHA20P1305",
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    content_hash: sha256Hex(plaintext),
    recipients: [{
      recipient_id: identity.recipientId,
      ephemeral_pubkey: b64(ephemeral.publicKey),
      wrap_nonce: b64(wrapNonce),
      encrypted_file_key: b64(encryptedFileKey),
    }],
  };
}

function txEntry({ txHash, pointerMemo, ledgerIndex }) {
  return {
    tx: {
      TransactionType: "Payment",
      Account: authorityWallet,
      Destination: userWallet,
      Amount: "1000000",
      Fee: "12",
      date: 831600000 + ledgerIndex,
      hash: txHash,
      ledger_index: ledgerIndex,
      Memos: [
        {
          Memo: {
            MemoType: pointerMemo.memoTypeHex,
            MemoFormat: pointerMemo.memoFormatHex,
            MemoData: pointerMemo.memoDataHex,
          },
        },
      ],
    },
    meta: {
      TransactionResult: "tesSUCCESS",
      delivered_amount: "1000000",
    },
    validated: true,
    ledger_index: ledgerIndex,
  };
}

async function cleanup() {
  await query("DELETE FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM context_history_pointers WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM context_history_imports WHERE account_id = $1 AND wallet_address = $2", [accountId, userWallet]);
  await query("DELETE FROM task_events WHERE task_id = $1", [taskId]);
  await query("DELETE FROM task_projections WHERE task_id = $1", [taskId]);
  await query("DELETE FROM pftl_task_pointer_events WHERE source_tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_task_sync_runs WHERE account_id = $1 AND wallet_address = $2", [accountId, userWallet]);
  await query("DELETE FROM pftl_pointer_memos WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_wallet_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_transactions WHERE tx_hash = ANY($1)", [txHashes]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = ANY($1)", [[userWallet, authorityWallet]]);
}

try {
  await cleanup();
  await registerPftlSyncWallet({
    walletAddress: userWallet,
    accountId,
    role: "user",
    priority: 1,
  });
  await registerPftlSyncWallet({
    walletAddress: authorityWallet,
    accountId,
    role: "task_authority",
    priority: 1,
  });

  const contextPointer = buildPftPointerMemo({
    cid: contextCid,
    kind: "CONTEXT",
    schema: 1,
    contextId: `ctx_${runId}`,
  });
  const taskPointer = buildPftPointerMemo({
    cid: taskCid,
    kind: "TASK",
    schema: 1,
    taskId,
  });
  const verificationRequestPointer = buildPftPointerMemo({
    cid: verificationRequestCid,
    kind: "TASK_UPDATE",
    schema: 1,
    taskId,
  });
  const rewardDecisionPointer = buildPftPointerMemo({
    cid: rewardDecisionCid,
    kind: "TASK_UPDATE",
    schema: 1,
    taskId,
  });
  const nullTaskPointer = buildPftPointerMemo({
    cid: nullTaskCid,
    kind: "TASK_SUBMISSION",
    schema: 1,
  });

  const taskOffer = {
    schema: "pf.task.offer.v1",
    task_id: taskId,
    request_id: `req_${runId}`,
    subject_wallet: userWallet,
    authority_wallet: authorityWallet,
    allocation_wallet: allocationWallet,
    status: "proposed",
    title: "Reducer smoke projected task",
    description: "Verify cached PFTL pointer reducer hydration writes task projections.",
    task_kind: "smoke",
    steps: [
      "Create a reducer smoke task offer payload.",
      "Hydrate the encrypted task offer through the reducer.",
      "Verify the task projection preserves generated steps.",
    ],
    submission_requirement: {
      type: "text",
      criteria: "Submit the reducer smoke output.",
    },
    verification_policy: {
      type: "manual",
      criteria: "Task projection row exists.",
    },
    reward_offer: {
      amount_estimate_pft: "12.50",
    },
    generation: {
      request_bundle_cid: "bafyrequestbundle",
    },
    context_refs: [{ cid: contextCid }],
    accept_by: new Date(Date.now() + 3600000).toISOString(),
    deadline_at: new Date(Date.now() + 7200000).toISOString(),
  };
  const encryptedTaskOffer = await encryptForService(taskOffer);
  const verificationRequest = {
    schema: "pf.task.update.v1",
    task_id: taskId,
    transition: "verification_requested",
    status_after: "verification_requested",
    verification_type: "text",
    verification_ask: "Provide the reducer smoke verification note.",
    verification_request: {
      assessment: "incomplete",
      reason: "Reducer smoke follow-up.",
      verification_type: "text",
      verification_ask: "Provide the reducer smoke verification note.",
    },
    subject_wallet: userWallet,
    authority_wallet: authorityWallet,
    allocation_wallet: allocationWallet,
  };
  const encryptedVerificationRequest = await encryptForService(verificationRequest);
  const rewardDecision = {
    schema: "pf.task.reward_decision.v1",
    task_id: taskId,
    status_after: "reward_decided",
    score: {
      decision: "reject",
      reward_pft: "0.00",
    },
    subject_wallet: userWallet,
    authority_wallet: authorityWallet,
    allocation_wallet: allocationWallet,
  };
  const encryptedRewardDecision = await encryptForService(rewardDecision);
  const ipfsPayloads = new Map([
    [taskCid, encryptedTaskOffer],
    [verificationRequestCid, encryptedVerificationRequest],
    [rewardDecisionCid, encryptedRewardDecision],
  ]);
  const fetchedCids = [];

  const contextEntry = txEntry({ txHash: contextTxHash, pointerMemo: contextPointer, ledgerIndex: 810001 });
  const taskEntry = txEntry({ txHash: taskTxHash, pointerMemo: taskPointer, ledgerIndex: 810002 });
  const nullTaskEntry = txEntry({ txHash: nullTaskTxHash, pointerMemo: nullTaskPointer, ledgerIndex: 810000 });
  const verificationRequestEntry = txEntry({
    txHash: verificationRequestTxHash,
    pointerMemo: verificationRequestPointer,
    ledgerIndex: 810003,
  });
  const rewardDecisionEntry = txEntry({
    txHash: rewardDecisionTxHash,
    pointerMemo: rewardDecisionPointer,
    ledgerIndex: 810004,
  });
  await storePftlAccountTransactions({
    walletAddress: userWallet,
    transactions: [contextEntry, taskEntry],
  });
  await storePftlAccountTransactions({
    walletAddress: authorityWallet,
    transactions: [nullTaskEntry, verificationRequestEntry, rewardDecisionEntry],
  });
  for (const [walletAddress, entry] of [
    [userWallet, contextEntry],
    [userWallet, taskEntry],
    [authorityWallet, verificationRequestEntry],
    [authorityWallet, rewardDecisionEntry],
  ]) {
    await enqueuePftlReducerEventsForTransaction({
      walletAddress,
      accountId,
      txHash: entry.tx.hash,
      ledgerIndex: entry.ledger_index,
      transactionResult: "tesSUCCESS",
      source: "pftl_cache_reducer_smoke",
    });
  }

  const reducerEvents = await query(
    `
      UPDATE pftl_cache_reducer_events
      SET status = 'processing',
          attempts = attempts + 1,
          updated_at = now()
      WHERE tx_hash = ANY($1)
      RETURNING *
    `,
    [txHashes]
  );
  assert.equal(reducerEvents.rows.length, 8);

  const reducerOptions = {
    fetchIpfsJson: async ({ cid }) => {
      fetchedCids.push(cid);
      return {
        ok: ipfsPayloads.has(cid),
        status: ipfsPayloads.has(cid) ? 200 : 404,
        cid,
        payload: ipfsPayloads.get(cid),
        error: ipfsPayloads.has(cid) ? null : "missing_fixture_cid",
      };
    },
    env: process.env,
  };
  for (const event of reducerEvents.rows) {
    const processed = await processPftlReducerEvent(event, reducerOptions);
    await markPftlReducerEventCompleted({ id: event.id, metadata: processed });
  }

  const contextRows = await query(
    "SELECT cid, pointer_type FROM context_history_pointers WHERE account_id = $1 AND wallet_address = $2 AND tx_hash = $3",
    [accountId, userWallet, contextTxHash]
  );
  assert.equal(contextRows.rows.length, 1);
  assert.equal(contextRows.rows[0].cid, contextCid);
  assert.equal(contextRows.rows[0].pointer_type, "context");

  const projectionRows = await query(
    "SELECT status, title, reward_offer_pft::text AS reward_offer_pft, reward_actual_pft::text AS reward_actual_pft, metadata_json FROM task_projections WHERE task_id = $1",
    [taskId]
  );
  assert.equal(projectionRows.rows.length, 1);
  assert.equal(projectionRows.rows[0].status, "reward_decided");
  assert.equal(projectionRows.rows[0].title, "Reducer smoke projected task");
  assert.equal(projectionRows.rows[0].reward_offer_pft, "12.500000");
  assert.equal(projectionRows.rows[0].reward_actual_pft, "0.000000");
  assert.deepEqual(projectionRows.rows[0].metadata_json.generatedTask.steps, taskOffer.steps);
  assert.ok(!fetchedCids.includes(nullTaskCid), "known-task projection must not hydrate unrelated null-task pointers");

  const taskEventRows = await query(
    "SELECT payload_json->>'schema' AS schema, payload_json->>'transition' AS transition FROM task_events WHERE task_id = $1 ORDER BY occurred_at, source_tx_hash",
    [taskId]
  );
  assert.ok(taskEventRows.rows.some((row) => (
    row.schema === "pf.task.update.v1" && row.transition === "verification_requested"
  )));

  const reducerRows = await query(
    "SELECT reducer_kind, status FROM pftl_cache_reducer_events WHERE tx_hash = ANY($1)",
    [txHashes]
  );
  assert.equal(reducerRows.rows.length, 8);
  assert.ok(reducerRows.rows.every((row) => row.status === "completed"));

  console.log("pftl cache reducer postgres smoke ok");
} finally {
  await cleanup().catch(() => {});
  await closePool();
}
