import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { addressFromPublicKey, generateXWingKeypair } from "./message-protocol.js";
import {
  InMemoryFastPayPayoutStore,
  assertDurableFastPayStore,
  createFastPayPayoutDriver,
} from "./fastpay-payout.js";
import {
  PostgresFastPayPayoutStore,
  drainFastPayPinOutbox,
} from "./fastpay-payout-postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../db/migrations/169_fastpay_payouts.sql");

function makeTestKeys(tag) {
  const seed = Buffer.alloc(32, tag);
  const dsa = ml_dsa65.keygen(seed);
  const xwing = generateXWingKeypair(Buffer.alloc(32, tag + 10));
  return {
    signer: { publicKey: dsa.publicKey, secretKey: dsa.secretKey },
    account: addressFromPublicKey(dsa.publicKey),
    pubkeyHex: Buffer.from(dsa.publicKey).toString("hex"),
    xwingPublicKey: xwing.publicKey,
  };
}

function chainConfig() {
  return {
    fastpayDomain: {
      schema: "postfiat-owned-certificate-domain-v2",
      chain_id: "postfiat-wan-devnet-2",
      genesis_hash: "11".repeat(48),
      protocol_version: 2,
      registry_id: "22".repeat(48),
    },
    fastpayRecoveryWindow: async () => ({
      committee_epoch: 7,
      valid_from_height: 2000,
      expires_at_height: 2100,
      recovery_closes_at_height: 2200,
    }),
  };
}

test("production fail-closed guard refuses InMemoryFastPayPayoutStore and migration enforces uniqueness", async () => {
  const payout = makeTestKeys(1);
  const memStore = new InMemoryFastPayPayoutStore([{ objectId: "aa".repeat(32), valueAtoms: 100_000_000n, version: 1, nonce: 0 }]);

  assert.throws(
    () => assertDurableFastPayStore(memStore, { NODE_ENV: "production" }),
    /fastpay_durable_store_required_in_production/
  );
  assert.throws(
    () =>
      createFastPayPayoutDriver({
        ...chainConfig(),
        store: memStore,
        payoutSigner: payout.signer,
        submitFastPayOrder: async () => ({}),
        env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true", TASKNODE_ENV: "production" },
      }),
    /fastpay_durable_store_required_in_production/
  );
  assert.throws(
    () =>
      createFastPayPayoutDriver({
        ...chainConfig(),
        store: memStore,
        payoutSigner: payout.signer,
        submitFastPayOrder: async () => ({}),
        env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true", TASKNODE_FASTPAY_REQUIRE_DURABLE_STORE: "true" },
      }),
    /fastpay_durable_store_required_in_production/
  );

  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /PRIMARY KEY \(object_id, version\)/);
  assert.match(sql, /payout_id text PRIMARY KEY/);
  assert.match(sql, /UNIQUE \(object_id, object_version\)/);
  assert.match(sql, /fallback_attempt_id text UNIQUE/);
  assert.match(sql, /CREATE TABLE l1_fastpay_pin_outbox/);
});

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

test(
  "PostgresFastPayPayoutStore: 2-worker contention, crash-after-broadcast recovery, first-pin outbox retry, and durable fallback attempt ID",
  { skip: !DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
    const schemaName = `fastpay_pg_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const scopedPool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 8,
      options: `-c search_path=${schemaName}`,
    });
    const payout = makeTestKeys(3);
    const alice = makeTestKeys(4);
    const bob = makeTestKeys(5);
    const prodEnv = {
      NODE_ENV: "production",
      TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true",
      TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED: "true",
    };

    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      const sql = await readFile(migrationPath, "utf8");
      await scopedPool.query(sql);

      // ------------------------------------------------------------------
      // Scenario 1: Two concurrent workers racing on the SAME payout_id
      // Must produce 1 persisted order, 1 object lease, 1 chain payment.
      // ------------------------------------------------------------------
      const store1 = new PostgresFastPayPayoutStore({ pool: scopedPool, leaseTtlMs: 15_000, staleSubmitMs: 15_000 });
      const store2 = new PostgresFastPayPayoutStore({ pool: scopedPool, leaseTtlMs: 15_000, staleSubmitMs: 15_000 });
      await store1.seedObjects([
        { objectId: "10".repeat(32), valueAtoms: 50_000_000n, version: 1, nonce: 0 },
        { objectId: "20".repeat(32), valueAtoms: 50_000_000n, version: 1, nonce: 0 },
      ]);

      const observedFastPayPayments = new Map();
      let submitCalls = 0;
      const makeChainHooks = (delayMs = 40) => ({
        verifyFastPayCertificate: async ({ certificateDigest }) => /^[0-9a-f]{96}$/.test(certificateDigest),
        queryFastPayOrder: async (orderHash) => {
          const hit = observedFastPayPayments.get(orderHash);
          return hit ? { confirmed: true, orderHash, certificateDigest: hit.certificateDigest, blockHeight: 2010 } : { confirmed: false };
        },
        submitFastPayOrder: async ({ orderHash, order }) => {
          submitCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const certDigest = "c1".repeat(48);
          observedFastPayPayments.set(orderHash, { order, certificateDigest: certDigest });
          return {
            ok: true,
            orderHash,
            certificateDigest: certDigest,
            blockHeight: 2010,
            changeObject: {
              objectId: "10".repeat(32),
              version: 2,
              valueAtoms: String(order.outputs[1].value),
              nonce: order.nonce,
            },
          };
        },
      });

      const workerA = createFastPayPayoutDriver({
        ...chainConfig(),
        ...makeChainHooks(60),
        store: store1,
        payoutSigner: payout.signer,
        env: prodEnv,
      });
      const workerB = createFastPayPayoutDriver({
        ...chainConfig(),
        ...makeChainHooks(60),
        store: store2,
        payoutSigner: payout.signer,
        env: prodEnv,
      });

      const samePayoutArgs = {
        payoutId: "payout_race_same_001",
        taskId: "task_race_same_001",
        recipientAccount: alice.account,
        recipientPubkeyHex: alice.pubkeyHex,
        recipientXWingPublicKey: alice.xwingPublicKey,
        amountAtoms: 10_000_000n,
        summary: "Concurrent same-payout race",
      };

      const settledSame = await Promise.allSettled([
        workerA.executePayout(samePayoutArgs),
        workerB.executePayout(samePayoutArgs),
      ]);
      const fulfilled = settledSame.filter((r) => r.status === "fulfilled");
      const rejected = settledSame.filter((r) => r.status === "rejected");
      assert.ok(fulfilled.length >= 1, "at least one racing worker must complete the payout");
      for (const rej of rejected) {
        assert.match(rej.reason?.message || "", /fastpay_payout_in_progress/);
      }
      assert.equal(submitCalls, 1, "exactly one validator broadcast must occur across both racing workers");
      assert.equal(observedFastPayPayments.size, 1, "exactly one chain payment must be observed");

      // Re-running after completion returns idempotent replay with zero extra chain submissions.
      const replay = await workerB.executePayout(samePayoutArgs);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.orderHash, fulfilled[0].value.orderHash);
      assert.equal(submitCalls, 1);

      // ------------------------------------------------------------------
      // Scenario 2: Two concurrent workers paying DIFFERENT payouts
      // Must lease two distinct pool objects via FOR UPDATE SKIP LOCKED.
      // ------------------------------------------------------------------
      const diffResults = await Promise.all([
        workerA.executePayout({
          payoutId: "payout_diff_001",
          taskId: "task_diff_001",
          recipientAccount: alice.account,
          recipientPubkeyHex: alice.pubkeyHex,
          recipientXWingPublicKey: alice.xwingPublicKey,
          amountAtoms: 5_000_000n,
          summary: "Parallel payout 1",
        }),
        workerB.executePayout({
          payoutId: "payout_diff_002",
          taskId: "task_diff_002",
          recipientAccount: bob.account,
          recipientPubkeyHex: bob.pubkeyHex,
          recipientXWingPublicKey: bob.xwingPublicKey,
          amountAtoms: 5_000_000n,
          summary: "Parallel payout 2",
        }),
      ]);
      assert.notEqual(diffResults[0].orderHash, diffResults[1].orderHash);
      const persisted1 = await store1.getPayout("payout_diff_001");
      const persisted2 = await store1.getPayout("payout_diff_002");
      assert.notEqual(persisted1.objectId, persisted2.objectId, "concurrent payouts must lease distinct pool objects");

      // ------------------------------------------------------------------
      // Scenario 3: Process crash AFTER validator broadcast (before DB confirm)
      // + first IPFS pin failure -> fresh process reconciles 1 chain payment
      // AND drains the durable first-pin outbox!
      // ------------------------------------------------------------------
      const crashStore = new PostgresFastPayPayoutStore({ pool: scopedPool, staleSubmitMs: 0 });
      await crashStore.seedObjects([{ objectId: "30".repeat(32), valueAtoms: 80_000_000n, version: 1, nonce: 0 }]);

      const chainSeenAfterCrash = new Map();
      let crashBroadcastCount = 0;
      const crashingDriver = createFastPayPayoutDriver({
        ...chainConfig(),
        store: crashStore,
        payoutSigner: payout.signer,
        env: prodEnv,
        verifyFastPayCertificate: async ({ certificateDigest }) => /^[0-9a-f]{96}$/.test(certificateDigest),
        pinEnvelope: async () => {
          throw new Error("ipfs_gateway_503_on_first_pin");
        },
        submitFastPayOrder: async ({ orderHash, order }) => {
          crashBroadcastCount += 1;
          // Validators certify the order on chain, THEN the Task Node process dies before getting the reply!
          chainSeenAfterCrash.set(orderHash, {
            confirmed: true,
            orderHash,
            certificateDigest: "d4".repeat(48),
            blockHeight: 2025,
            changeObject: {
              objectId: "30".repeat(32),
              version: 2,
              valueAtoms: String(order.outputs[1].value),
              nonce: order.nonce,
            },
          });
          throw new Error("simulated_sigkill_lost_rpc_reply");
        },
        queryFastPayOrder: async () => null, // Process dies before query succeeds
      });

      const crashArgs = {
        payoutId: "payout_crash_after_broadcast_001",
        taskId: "task_crash_after_broadcast_001",
        recipientAccount: alice.account,
        recipientPubkeyHex: alice.pubkeyHex,
        recipientXWingPublicKey: alice.xwingPublicKey,
        amountAtoms: 12_000_000n,
        summary: "Crash after broadcast test",
        awaitPin: true,
      };
      await assert.rejects(() => crashingDriver.executePayout(crashArgs), /simulated_sigkill_lost_rpc_reply/);

      // Verify pre-broadcast persisted order AND durable pin outbox exist in Postgres after the crash.
      const preRestartRow = await crashStore.getPayout(crashArgs.payoutId);
      assert.equal(preRestartRow.status, "submit_unknown");
      assert.equal(chainSeenAfterCrash.size, 1);
      assert.equal(preRestartRow.orderHash, [...chainSeenAfterCrash.keys()][0]);

      const failedPinJob = await crashStore.getPinOutboxJob(crashArgs.payoutId);
      assert.ok(failedPinJob, "durable first-pin outbox row must survive process crash");
      assert.equal(failedPinJob.cid, preRestartRow.cid);
      assert.equal(failedPinJob.status, "retry_wait");

      // Brand-new process starts with a fresh store + driver instance.
      const freshStore = new PostgresFastPayPayoutStore({ pool: scopedPool, staleSubmitMs: 0 });
      let freshSubmitCount = 0;
      const freshDriver = createFastPayPayoutDriver({
        ...chainConfig(),
        store: freshStore,
        payoutSigner: payout.signer,
        env: prodEnv,
        verifyFastPayCertificate: async ({ certificateDigest }) => /^[0-9a-f]{96}$/.test(certificateDigest),
        queryFastPayOrder: async (orderHash) => chainSeenAfterCrash.get(orderHash) || { confirmed: false },
        submitFastPayOrder: async () => {
          freshSubmitCount += 1;
          throw new Error("must_not_rebroadcast_already_certified_order");
        },
      });

      const recovered = await freshDriver.executePayout(crashArgs);
      assert.equal(recovered.ok, true);
      assert.equal(recovered.recoveredFromChain, true);
      assert.equal(recovered.orderHash, preRestartRow.orderHash);
      assert.equal(crashBroadcastCount, 1);
      assert.equal(freshSubmitCount, 0, "fresh process must recover from chain without double-broadcasting");
      assert.equal(chainSeenAfterCrash.size, 1, "exactly one chain payment must exist");

      // Fresh process drains the durable first-pin outbox (force next_attempt_at <= now for test determinism).
      await scopedPool.query("UPDATE l1_fastpay_pin_outbox SET next_attempt_at = now() - interval '1 second' WHERE payout_id = $1", [crashArgs.payoutId]);
      const pinnedCids = [];
      const drain = await drainFastPayPinOutbox({
        store: freshStore,
        pinEnvelope: async ({ rawEnvelopeBytes, cid }) => {
          assert.equal(rawEnvelopeBytes.toString("hex"), preRestartRow.rawEnvelopeHex);
          pinnedCids.push(cid);
          return { ok: true, cid };
        },
      });
      assert.equal(drain.pinned, 1);
      assert.deepEqual(pinnedCids, [preRestartRow.cid]);
      assert.equal((await freshStore.getPinOutboxJob(crashArgs.payoutId)).status, "pinned");

      // ------------------------------------------------------------------
      // Scenario 4: Proved lock cancellation -> durable fallbackAttemptId
      // persisted BEFORE consensus submission; crash during fallback blocks
      // any second fallback attempt.
      // ------------------------------------------------------------------
      await freshStore.seedObjects([{ objectId: "40".repeat(32), valueAtoms: 90_000_000n, version: 5, nonce: 0 }]);
      const seenFallbackAttemptIds = [];
      const fallbackCrashingDriver = createFastPayPayoutDriver({
        ...chainConfig(),
        store: freshStore,
        payoutSigner: payout.signer,
        env: prodEnv,
        verifyFastPayCertificate: async () => false,
        verifyFastPayLockCancellation: async () => true,
        submitFastPayOrder: async () => {
          throw new Error("validators_timed_out");
        },
        queryFastPayOrder: async (orderHash) => {
          const rec = await freshStore.getPayout("payout_fallback_crash_001");
          return {
            confirmed: false,
            orderHash,
            cancellation: {
              kind: "recovery_certificate",
              lockId: rec.lockId,
              recoveredObject: {
                objectId: rec.objectId,
                version: rec.objectVersion + 1,
                valueAtoms: "90000000",
                nonce: rec.nonce,
              },
            },
          };
        },
        submitConsensusFallback: async ({ fallbackAttemptId }) => {
          seenFallbackAttemptIds.push(fallbackAttemptId);
          // Process crashes after fallback broadcast before response returns.
          throw new Error("consensus_reply_lost");
        },
      });

      const fbArgs = {
        payoutId: "payout_fallback_crash_001",
        taskId: "task_fallback_crash_001",
        recipientAccount: bob.account,
        recipientPubkeyHex: bob.pubkeyHex,
        recipientXWingPublicKey: bob.xwingPublicKey,
        amountAtoms: 15_000_000n,
        summary: "Fallback crash durability",
      };
      await assert.rejects(() => fallbackCrashingDriver.executePayout(fbArgs), /consensus_reply_lost/);
      assert.equal(seenFallbackAttemptIds.length, 1);
      const fbPersisted = await freshStore.getPayout(fbArgs.payoutId);
      assert.equal(fbPersisted.status, "fallback_unknown");
      assert.equal(fbPersisted.fallbackAttemptId, seenFallbackAttemptIds[0]);

      // Fresh process MUST refuse to create a second fallback payment!
      await assert.rejects(() => fallbackCrashingDriver.executePayout(fbArgs), /fastpay_fallback_outcome_unknown/);
      assert.equal(seenFallbackAttemptIds.length, 1);

      // Verify cancelled object rotated to post-cancel version in pool!
      const objects = await freshStore.listPoolObjects();
      const retiredObj = objects.find((o) => o.objectId === fbPersisted.objectId && o.version === fbPersisted.objectVersion);
      const rotatedObj = objects.find((o) => o.objectId === fbPersisted.objectId && o.version === fbPersisted.objectVersion + 1);
      assert.equal(retiredObj?.status, "retired");
      assert.equal(rotatedObj?.status, "available");
    } finally {
      await scopedPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  }
);
