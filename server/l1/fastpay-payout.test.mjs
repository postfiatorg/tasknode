import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CONTENT_KIND,
  POINTER_FLAG,
  POINTER_TARGET,
  SCHEMA_ID,
  TASK_REWARD_BADGE_LABEL,
  VISIBILITY,
  buildFastPayPointerMemo,
  computeMessageAadContext,
  computeRawCidV1,
  decodeAnyPointerMemo,
  decodeLegacyPointerV4,
  decodePointerV5,
  decodeRewardNotice,
  decryptPrivateEnvelope,
  deriveMessageKemSeed,
  encodePointerV5,
  envelopeSigningPreimage,
  generateMlDsa65Keypair,
  generateXWingKeypair,
  encryptPrivateEnvelope,
} from "./message-protocol.js";
import { computeMigratedSerial } from "./nft-protocol.js";
import {
  InMemoryFastPayPayoutStore,
  buildFastPayRewardEnvelopeAndMemo,
  classifyRewardBadge,
  computeFastPayOrderHash,
  createFastPayPayoutDriver,
  fastpayMinimumFeeAtoms,
  isFastPayPayoutsEnabled,
  readUnifiedRewardHistory,
} from "./fastpay-payout.js";
import { projectHistory } from "./history.js";
import { taskRewardOutcome } from "../task-reward-outcome.js";

function seed32(label) {
  return createHash("sha256").update(label, "utf8").digest();
}

test("Contract C1 frozen hex vectors match byte-for-byte (V1, V2B, V3, V4, V5, V8 serial)", () => {
  // V1_POINTER_V5_PUBLIC_TEXT
  const v1CidBinHex = "015512202acc209da9af312de8e9d20175c075a22b31b329a3e6d856dec9cf66436d523d";
  const v1Memo = buildFastPayPointerMemo({
    cidBin: Buffer.from(v1CidBinHex, "hex"),
    target: POINTER_TARGET.CONTENT_BLOB,
    kind: CONTENT_KIND.CHAT,
    schema: SCHEMA_ID.MESSAGE_TEXT_V1,
    threadId: "thread-c1-001",
    flags: POINTER_FLAG.PUBLIC,
  });
  assert.equal(v1Memo.memo_type, "70662e707472");
  assert.equal(v1Memo.memo_format, "7635");
  assert.equal(
    v1Memo.memo_data,
    "0a24015512202acc209da9af312de8e9d20175c075a22b31b329a3e6d856dec9cf66436d523d100118042064320d7468726561642d63312d3030314002"
  );
  assert.equal(v1Memo.byteLength, 61);
  assert.equal(v1Memo.pointer.cid, "bafkreibkzqqj3knpgew6r2osaf24a5ncfmy3gknd43mfnxwjz5teg3kshu");

  // V2B_POINTER_V5_INLINE_X402
  const v2b = encodePointerV5({
    target: POINTER_TARGET.INLINE,
    kind: CONTENT_KIND.X402,
    schema: SCHEMA_ID.X402_REQUEST_V1,
    flags: POINTER_FLAG.PUBLIC | POINTER_FLAG.EPHEMERAL,
    inlinePayload: Buffer.from("ee159abe7875173448aac81f2ac10748b46f3f8261f8d78d2b2d98b063a2bb56", "hex"),
  });
  assert.equal(
    v2b.toString("hex"),
    "1003180e20920340064a20ee159abe7875173448aac81f2ac10748b46f3f8261f8d78d2b2d98b063a2bb56"
  );
  assert.equal(v2b.length, 43);

  // V3_LEGACY_POINTER_V4_DECODE (uppercase hex on old chain)
  const v3 = decodeLegacyPointerV4(
    "0A3B6261666B726569676832616B69736361696C646371616273796733646672366368753366677072656769796D73636B376537617161347335327A791001180620012A107461736B2D6C65676163792D303034324001"
  );
  assert.equal(v3.version, "v4");
  assert.equal(v3.kind, CONTENT_KIND.REWARD);
  assert.equal(v3.kindLabel, "REWARD");
  assert.equal(v3.taskId, "task-legacy-0042");
  assert.equal(v3.cid, "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");

  // V4 signing preimage SHA-256 & CID
  const v4Header = Buffer.from(
    "08011211706f7374666961742d6465766e65742d321a1270662e6d6573736167652e746578742e7631206428043001380140014a2a70663173656e6465723030303030303030303030303030303030303030303030303030303030303030305080a8f094ac33620d7468726561642d63312d303031",
    "hex"
  );
  const v4Body = Buffer.from("0a1548656c6c6f20506f73742046696174204c31763221120a746578742f706c61696e", "hex");
  const v4PreimageHash = createHash("sha256")
    .update(envelopeSigningPreimage({ version: 1, headerBytes: v4Header, bodyBytes: v4Body }))
    .digest("hex");
  assert.equal(v4PreimageHash, "e9d50d27fa79f160fda793f8133fc9ce19f5a507ed539e2a4bbea19d67c53ba7");

  // V5 AAD context & KEM seed
  const v5Header = Buffer.from(
    "08011211706f7374666961742d6465766e65742d321a0c70662e7265776172642e763120c90128063002380140024a2a7066317461736b6e6f64653030303030303030303030303030303030303030303030303030303030303050e0fcf394ac335a107461736b2d7265776172642d303030317abf0108011211706f7374666961742d6465766e65742d321a201fa9e64486fcda633292370aa97c47fa1ffa1463b8bc3804503e4d9a03c940942220986cb4a5f6ae7ce3b980118f577d54a1a32347ac8d467394479f43d340e04ef832035046543a2a7066317461736b6e6f646530303030303030303030303030303030303030303030303030303030303030422a7066317265636970303030303030303030303030303030303030303030303030303030303030303030304880cab5ee01508208",
    "hex"
  );
  assert.equal(
    computeMessageAadContext({ chainId: "postfiat-devnet-2", headerBytes: v5Header, chunkIndex: 0 }).toString("hex"),
    "34df597e69504a383a97eba1f106a9286b71496de75c7a66af953d4cec167c70"
  );
  assert.equal(
    deriveMessageKemSeed({ masterEntropy: Buffer.alloc(32, 0x10), chainId: "postfiat-devnet-2" }).toString("hex"),
    "430e4662271619e3e43878bddafd267013540a0e72aec34a4eeb1225af12199a"
  );

  // V8 migrated_serial exact BigInt
  assert.equal(
    computeMigratedSerial(
      "postfiat-legacy-xrpl",
      "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000001"
    ),
    16447061904156710842n
  );

  // Pointer visibility mutual exclusion check
  assert.throws(
    () =>
      encodePointerV5({
        cidBin: Buffer.from(v1CidBinHex, "hex"),
        target: POINTER_TARGET.CONTENT_BLOB,
        kind: CONTENT_KIND.REWARD,
        schema: SCHEMA_ID.REWARD_V1,
        flags: POINTER_FLAG.PRIVATE | POINTER_FLAG.PUBLIC,
      }),
    /exact_one_visibility_bit/
  );
});

test("Train A Sui-inspired FastPay minimum fee schedule matches worked examples", () => {
  assert.equal(fastpayMinimumFeeAtoms({ weightBytes: 420, inputsConsumed: 1, outputsCreated: 1 }), 27n);
  assert.equal(fastpayMinimumFeeAtoms({ weightBytes: 600, inputsConsumed: 1, outputsCreated: 2 }), 1_028n);
  assert.equal(fastpayMinimumFeeAtoms({ weightBytes: 8_192, inputsConsumed: 100, outputsCreated: 1 }), 141n);
  assert.equal(fastpayMinimumFeeAtoms({ weightBytes: 380, inputsConsumed: 1, outputsCreated: 0 }), 27n);
});

test("Task reward badge payload encrypts with X-Wing, decrypts locally, and blocks outsider spoofing", async () => {
  const officialSigner = generateMlDsa65Keypair(seed32("official-tasknode-payout"));
  const outsiderSigner = generateMlDsa65Keypair(seed32("outsider-spoof-key"));
  const recipientAccount = generateMlDsa65Keypair(seed32("recipient-account")).account;
  const recipientKem = generateXWingKeypair(seed32("recipient-xwing-kem"));

  const built = await buildFastPayRewardEnvelopeAndMemo({
    chainId: "postfiat-wan-devnet-2",
    rewardId: "rew-001",
    taskId: "task-fastpay-001",
    recipientAccount,
    amountAtoms: 50_000_000n,
    summary: "Completed Pillar 2 FastPay payout spec",
    recipients: [{ account: recipientAccount, xwingPublicKey: recipientKem.publicKey }],
    payoutSigner: officialSigner,
  });

  // Memo is lowercase hex pf.ptr v5, PRIVATE (not SEALED), <= 256 bytes
  assert.equal(built.memo.memo_type, "70662e707472");
  assert.equal(built.memo.memo_format, "7635");
  assert.equal(built.memo.memo_data, built.memo.memo_data.toLowerCase());
  assert.ok(built.memo.byteLength <= 256);
  const decodedPtr = decodePointerV5(built.memo.memo_data);
  assert.equal(decodedPtr.kind, CONTENT_KIND.REWARD);
  assert.equal(decodedPtr.visibility, "private");
  assert.equal(decodedPtr.cid, built.cid);
  assert.equal(decodedPtr.taskId, "task-fastpay-001");

  // Official key + matching tx signer => verified "Task reward" badge
  const verifiedBadge = classifyRewardBadge({
    rawEnvelopeBytes: built.rawEnvelopeBytes,
    txSignerAccount: officialSigner.account,
    officialPayoutPubkeyHex: officialSigner.publicKeyHex,
  });
  assert.equal(verifiedBadge.verified, true);
  assert.equal(verifiedBadge.badge, TASK_REWARD_BADGE_LABEL);

  // Outsider claiming pf.reward.v1 => generic "Private message" (no spoofing!)
  const spoofed = await buildFastPayRewardEnvelopeAndMemo({
    chainId: "postfiat-wan-devnet-2",
    rewardId: "rew-spoof",
    taskId: "task-spoof",
    recipientAccount,
    amountAtoms: 1_000_000n,
    recipients: [{ account: recipientAccount, xwingPublicKey: recipientKem.publicKey }],
    payoutSigner: outsiderSigner,
  });
  const spoofCheck = classifyRewardBadge({
    rawEnvelopeBytes: spoofed.rawEnvelopeBytes,
    txSignerAccount: outsiderSigner.account,
    officialPayoutPubkeyHex: officialSigner.publicKeyHex,
  });
  assert.equal(spoofCheck.verified, false);
  assert.equal(spoofCheck.badge, "Private message");

  // Sealed visibility is also rejected for "Task reward" badge (Pillar 2 locked: Private, not Sealed)
  const sealed = await encryptPrivateEnvelope({
    header: {
      protocolVersion: 1,
      chainId: "postfiat-wan-devnet-2",
      schemaName: "pf.reward.v1",
      schemaId: SCHEMA_ID.REWARD_V1,
      kind: CONTENT_KIND.REWARD,
      visibility: VISIBILITY.SEALED,
      senderAccount: officialSigner.account,
    },
    plaintextBodyBytes: Buffer.from("sealed-body"),
    recipients: [{ account: recipientAccount, xwingPublicKey: recipientKem.publicKey }],
    signerPublicKey: officialSigner.publicKey,
    signerSecretKey: officialSigner.secretKey,
  });
  const sealedCheck = classifyRewardBadge({
    rawEnvelopeBytes: sealed.rawEnvelopeBytes,
    txSignerAccount: officialSigner.account,
    officialPayoutPubkeyHex: officialSigner.publicKeyHex,
  });
  assert.equal(sealedCheck.verified, false);
  assert.equal(sealedCheck.badge, "Private message");

  // Recipient decrypts locally via X-Wing + XChaCha20-Poly1305
  const decrypted = await decryptPrivateEnvelope({
    rawEnvelopeBytes: built.rawEnvelopeBytes,
    recipientXWingSecretKey: recipientKem.secretKey,
    recipientXWingPublicKey: recipientKem.publicKey,
  });
  const notice = decodeRewardNotice(decrypted.plaintextBytes);
  assert.equal(notice.rewardId, "rew-001");
  assert.equal(notice.taskId, "task-fastpay-001");
  assert.equal(notice.amountAtoms, 50_000_000n);
});

test("FastPay payout driver enforces feature flag, records order_hash, and guarantees idempotent retry without double-pay", async () => {
  const payoutSigner = generateMlDsa65Keypair(seed32("driver-payout-signer"));
  const recipient = generateMlDsa65Keypair(seed32("driver-recipient"));
  const recipientKem = generateXWingKeypair(seed32("driver-recipient-kem"));

  assert.equal(isFastPayPayoutsEnabled({}), false);
  assert.equal(isFastPayPayoutsEnabled({ TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true" }), true);

  const store = new InMemoryFastPayPayoutStore([
    { objectId: "obj_pool_01", valueAtoms: 500_000_000n, nonce: 1 },
    { objectId: "obj_pool_02", valueAtoms: 500_000_000n, nonce: 1 },
  ]);

  let submitCalls = 0;
  let pinCalls = 0;
  const submittedOrderHashes = [];

  const disabledDriver = createFastPayPayoutDriver({
    store,
    payoutSigner,
    submitFastPayOrder: async () => ({ certificateDigest: "cert" }),
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "false" },
  });
  await assert.rejects(
    () =>
      disabledDriver.executePayout({
        payoutId: "task-disabled",
        recipientAccount: recipient.account,
        recipientXWingPublicKey: recipientKem.publicKey,
        amountAtoms: 10_000_000n,
      }),
    /fastpay_payouts_disabled/
  );

  const driver = createFastPayPayoutDriver({
    store,
    payoutSigner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true" },
    pinEnvelope: async ({ cid }) => {
      pinCalls += 1;
      return { ok: true, cid };
    },
    submitFastPayOrder: async ({ orderHash, order }) => {
      submitCalls += 1;
      submittedOrderHashes.push(orderHash);
      assert.equal(orderHash, computeFastPayOrderHash(order));
      return {
        certificateDigest: "d".repeat(96),
        lockId: "e".repeat(96),
        blockHeight: 124501,
      };
    },
  });

  const first = await driver.executePayout({
    payoutId: "task-idem-001",
    taskId: "task-idem-001",
    recipientAccount: recipient.account,
    recipientPubkeyHex: recipient.publicKeyHex,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 25_000_000n,
    summary: "Reward payout 1",
    awaitPin: true,
  });

  assert.equal(first.ok, true);
  assert.equal(first.lane, "fastpay");
  assert.equal(first.badge, TASK_REWARD_BADGE_LABEL);
  assert.equal(first.pointerVersion, "v5");
  assert.equal(first.orderHash.length, 96);
  assert.equal(first.idempotentReplay, false);
  assert.equal(submitCalls, 1);
  assert.equal(pinCalls, 1);

  // Idempotent retry: ZERO second submission, exact same orderHash returned!
  const second = await driver.executePayout({
    payoutId: "task-idem-001",
    taskId: "task-idem-001",
    recipientAccount: recipient.account,
    recipientPubkeyHex: recipient.publicKeyHex,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 25_000_000n,
  });
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.orderHash, first.orderHash);
  assert.equal(submitCalls, 1);
});

test("Crash recovery resubmits exact order_hash without equivocation and only falls back when never_certified", async () => {
  const payoutSigner = generateMlDsa65Keypair(seed32("recovery-payout-signer"));
  const recipient = generateMlDsa65Keypair(seed32("recovery-recipient"));
  const recipientKem = generateXWingKeypair(seed32("recovery-recipient-kem"));

  // Scenario A: Transport timeout after validator already certified -> recovery finds confirmed order_hash (zero double-pay)
  const storeA = new InMemoryFastPayPayoutStore([{ objectId: "obj_a", valueAtoms: 200_000_000n, nonce: 4 }]);
  let submitCountA = 0;
  let fallbackCountA = 0;
  let seenOrderHashA = "";
  const driverA = createFastPayPayoutDriver({
    store: storeA,
    payoutSigner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true" },
    submitFastPayOrder: async ({ orderHash }) => {
      submitCountA += 1;
      seenOrderHashA = orderHash;
      throw new Error("validator_quorum_timeout");
    },
    queryFastPayOrder: async (orderHash) => {
      assert.equal(orderHash, seenOrderHashA);
      return { confirmed: true, certificateDigest: "a".repeat(96), blockHeight: 999 };
    },
    submitConsensusFallback: async () => {
      fallbackCountA += 1;
      return { txHash: "fallback_should_not_run" };
    },
  });

  const recovered = await driverA.executePayout({
    payoutId: "task-timeout-already-certified",
    recipientAccount: recipient.account,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 10_000_000n,
  });
  assert.equal(recovered.lane, "fastpay");
  assert.equal(recovered.orderHash, seenOrderHashA);
  assert.equal(recovered.recoveredFromChain, true);
  assert.equal(submitCountA, 1);
  assert.equal(fallbackCountA, 0);

  // Scenario B: FastPay confirmed never_certified -> releases object & falls back cleanly to payment_v2, idempotent on retry
  const storeB = new InMemoryFastPayPayoutStore([{ objectId: "obj_b", valueAtoms: 200_000_000n, nonce: 2 }]);
  let fallbackCountB = 0;
  const driverB = createFastPayPayoutDriver({
    store: storeB,
    payoutSigner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true" },
    submitFastPayOrder: async () => {
      throw new Error("fastpay_quorum_unreachable");
    },
    queryFastPayOrder: async () => ({ confirmed: false, certified: false, reason: "never_certified" }),
    submitConsensusFallback: async ({ cid }) => {
      fallbackCountB += 1;
      return { txHash: "b".repeat(96), feeAtoms: "25", cid };
    },
  });

  const fallbackRes = await driverB.executePayout({
    payoutId: "task-fallback-001",
    recipientAccount: recipient.account,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 10_000_000n,
  });
  assert.equal(fallbackRes.lane, "consensus_pft");
  assert.equal(fallbackRes.fallbackFromFastPay, true);
  assert.equal(fallbackRes.badge, TASK_REWARD_BADGE_LABEL);
  assert.equal(fallbackCountB, 1);
  // Leased object was released cleanly!
  assert.equal(storeB.pool.get("obj_b").leasedBy, null);

  // Retrying after consensus fallback is idempotent (zero double-pay!)
  const replayB = await driverB.executePayout({
    payoutId: "task-fallback-001",
    recipientAccount: recipient.account,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 10_000_000n,
  });
  assert.equal(replayB.idempotentReplay, true);
  assert.equal(fallbackCountB, 1);
});

test("Unified reward history & L1 history projection seamlessly read FastPay v5 and legacy v4 rewards", async () => {
  const officialSigner = generateMlDsa65Keypair(seed32("hist-official-signer"));
  const recipient = generateMlDsa65Keypair(seed32("hist-recipient"));
  const recipientKem = generateXWingKeypair(seed32("hist-recipient-kem"));

  const built = await buildFastPayRewardEnvelopeAndMemo({
    chainId: "postfiat-wan-devnet-2",
    rewardId: "rew-hist-1",
    taskId: "task-v5-1",
    recipientAccount: recipient.account,
    amountAtoms: 42_000_000n,
    recipients: [{ account: recipient.account, xwingPublicKey: recipientKem.publicKey }],
    payoutSigner: officialSigner,
  });

  const orderHash = "f".repeat(96);
  const blockWithFastPay = {
    header: { height: 500, batch_kind: "transparent", batch_id: "b500" },
    receipt_ids: [],
    fastpay_pre_state_effects: [
      {
        lock_id: "1".repeat(96),
        decision: {
          Confirmed: {
            order_digest: orderHash,
            certificate_digest: "2".repeat(96),
          },
        },
        certificate: {
          owner_pubkey_hex: officialSigner.publicKeyHex,
          order: {
            nonce: 7,
            fee: 1028,
            outputs: [
              { owner_account: recipient.account, value: 42_000_000 },
              { owner_account: officialSigner.account, value: 100_000_000 },
            ],
            memos: [
              {
                memo_type: built.memo.memo_type,
                memo_format: built.memo.memo_format,
                memo_data: built.memo.memo_data,
              },
            ],
          },
        },
      },
    ],
  };

  const projected = projectHistory(
    {
      blocks: [blockWithFastPay],
      archives: [{ batch_kind: "transparent", batch_id: "b500", payload_json: JSON.stringify({ batch_id: "b500" }) }],
      receipts: [],
    },
    recipient.account
  );
  assert.equal(projected.rows.length, 1);
  assert.equal(projected.rows[0].tx_id, orderHash);
  assert.equal(projected.rows[0].order_hash, orderHash);
  assert.equal(projected.rows[0].batch_kind, "fastpay");
  assert.equal(projected.rows[0].transaction_kind, "owned_transfer_v3");
  assert.equal(projected.rows[0].pointer_version, "v5");
  assert.equal(projected.rows[0].task_id, "task-v5-1");
  assert.equal(projected.rows[0].reward_memo_private, true);

  // Merge FastPay v5 row with legacy XRPL v4 row seamlessly
  const legacyV4Row = {
    txHash: "LEGACY_XRPL_TX_HASH_001",
    account: "rLegacyRewardAuthority",
    destination: "rLegacyUserWallet",
    deliveredDrops: "15000000",
    ledgerIndex: 4100000,
    closeTime: "2026-06-01T12:00:00.000Z",
    tx: {
      Memos: [
        {
          Memo: {
            MemoType: "70662E707472",
            MemoFormat: "7634",
            MemoData:
              "0A3B6261666B726569676832616B69736361696C646371616273796733646672366368753366677072656769796D73636B376537617161347335327A791001180620012A107461736B2D6C65676163792D303034324001",
          },
        },
      ],
    },
  };

  assert.equal(decodeAnyPointerMemo(legacyV4Row.tx.Memos[0]).version, "v4");
  const history = readUnifiedRewardHistory({
    fastpayRows: [{ ...projected.rows[0], rawEnvelopeBytes: built.rawEnvelopeBytes, timestamp: "2026-11-27T01:00:00.000Z" }],
    legacyRows: [legacyV4Row],
    officialPayoutPubkeyHex: officialSigner.publicKeyHex,
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].lane, "fastpay");
  assert.equal(history[0].orderHash, orderHash);
  assert.equal(history[0].badge, TASK_REWARD_BADGE_LABEL);
  assert.equal(history[0].badgeVerified, true);
  assert.equal(history[0].pointerVersion, "v5");
  assert.equal(history[0].amountPft, 42);

  assert.equal(history[1].lane, "legacy_pftl_v4");
  assert.equal(history[1].pointerVersion, "v4");
  assert.equal(history[1].taskId, "task-legacy-0042");
  assert.equal(history[1].amountPft, 15);
  assert.equal(history[1].cid, "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");

  // taskRewardOutcome exposes both FastPay v5 and legacy v4 fields cleanly
  const v5Outcome = taskRewardOutcome({
    timeline: [
      {
        schema: "pf.reward.v1",
        cid: built.cid,
        txHash: orderHash,
        rawPayload: {
          schema: "pf.reward.v1",
          reward_pft: "42.00",
          order_hash: orderHash,
          payment_lane: "fastpay",
          pointer_version: "v5",
          explorer_badge: TASK_REWARD_BADGE_LABEL,
          reward_score: { decision: "reward", reason: "Great work" },
        },
      },
    ],
  });
  assert.equal(v5Outcome.paymentOrderHash, orderHash);
  assert.equal(v5Outcome.paymentLane, "fastpay");
  assert.equal(v5Outcome.pointerVersion, "v5");
  assert.equal(v5Outcome.badge, TASK_REWARD_BADGE_LABEL);

  const v4Outcome = taskRewardOutcome({
    timeline: [
      {
        schema: "pf.reward.v1",
        cid: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
        txHash: "LEGACY_TX_HASH",
        rawPayload: {
          schema: "pf.reward.v1",
          reward_pft: "15.00",
          reward_score: { decision: "reward", reason: "Legacy work" },
        },
      },
    ],
  });
  assert.equal(v4Outcome.paymentLane, "legacy_pftl_v4");
  assert.equal(v4Outcome.pointerVersion, "v4");
  assert.equal(v4Outcome.paymentTxHash, "LEGACY_TX_HASH");
  assert.equal(computeRawCidV1(built.rawEnvelopeBytes).multibaseCid, built.cid);
});
