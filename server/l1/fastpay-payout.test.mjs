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

// The chain identity and recovery window a driver needs to build an OwnedTransferOrderV3.
function chainConfig() {
  return {
    fastpayDomain: {
      schema: "postfiat-owned-certificate-domain-v2",
      chain_id: "postfiat-wan-devnet-2",
      genesis_hash: "11".repeat(48),
      protocol_version: 1,
      registry_id: "22".repeat(48),
    },
    fastpayRecoveryWindow: async () => ({ committee_epoch: 2, valid_from_height: 1900, expires_at_height: 2000, recovery_closes_at_height: 2100 }),
  };
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
    ...chainConfig(),
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
        recipientPubkeyHex: recipient.publicKeyHex,
        recipientXWingPublicKey: recipientKem.publicKey,
        amountAtoms: 10_000_000n,
      }),
    /fastpay_payouts_disabled/
  );

  const driver = createFastPayPayoutDriver({
    ...chainConfig(),
    store,
    payoutSigner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true" },
    verifyFastPayCertificate: async ({ certificateDigest }) => certificateDigest === "d".repeat(96),
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
    ...chainConfig(),
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
      return { confirmed: true, orderHash, certificateDigest: "a".repeat(96), blockHeight: 999 };
    },
    verifyFastPayCertificate: async ({ certificateDigest }) => certificateDigest === "a".repeat(96),
    submitConsensusFallback: async () => {
      fallbackCountA += 1;
      return { txHash: "fallback_should_not_run" };
    },
  });

  const recovered = await driverA.executePayout({
    payoutId: "task-timeout-already-certified",
    recipientAccount: recipient.account,
    recipientPubkeyHex: recipient.publicKeyHex,
    recipientXWingPublicKey: recipientKem.publicKey,
    amountAtoms: 10_000_000n,
  });
  assert.equal(recovered.lane, "fastpay");
  assert.equal(recovered.orderHash, seenOrderHashA);
  assert.equal(recovered.recoveredFromChain, true);
  assert.equal(submitCountA, 1);
  assert.equal(fallbackCountA, 0);

  // Scenario B: one "never certified" answer is not a proof the lock is cancelled (review finding 2):
  // nothing is paid by consensus and the leased object stays out of the pool.
  const storeB = new InMemoryFastPayPayoutStore([{ objectId: "obj_b", valueAtoms: 200_000_000n, nonce: 2 }]);
  let fallbackCountB = 0;
  const driverB = createFastPayPayoutDriver({
    ...chainConfig(),
    store: storeB,
    payoutSigner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "true", TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED: "true" },
    submitFastPayOrder: async () => {
      throw new Error("fastpay_quorum_unreachable");
    },
    queryFastPayOrder: async () => ({ confirmed: false, certified: false, reason: "never_certified" }),
    submitConsensusFallback: async ({ cid }) => {
      fallbackCountB += 1;
      return { txHash: "b".repeat(96), feeAtoms: "25", cid, validated: true };
    },
  });

  await assert.rejects(
    () =>
      driverB.executePayout({
        payoutId: "task-fallback-001",
        recipientAccount: recipient.account,
        recipientPubkeyHex: recipient.publicKeyHex,
        recipientXWingPublicKey: recipientKem.publicKey,
        amountAtoms: 10_000_000n,
      }),
    /fastpay_quorum_unreachable/
  );
  assert.equal(fallbackCountB, 0);
  assert.equal(storeB.getPayout("task-fallback-001").status, "submit_unknown");
  assert.equal(storeB.pool.get("obj_b").leasedBy, "task-fallback-001");
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

// Review of PR 450, finding 3: only a verified result is recorded as paid.
test("finding 3: a refusal, an answer without a certificate, or a bare confirmed:true is never recorded as paid", async () => {
  const fp = await import("./fastpay-payout.js");
  const signer = generateMlDsa65Keypair(seed32("f3-payout"));
  const recip = generateMlDsa65Keypair(seed32("f3-recipient"));
  const kem = generateXWingKeypair(seed32("f3-kem"));
  const env = { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" };
  const OBJ = "aa".repeat(32);
  const base = {
    payoutId: "task_f3",
    taskId: "task_f3",
    recipientAccount: recip.account,
    recipientPubkeyHex: recip.publicKeyHex,
    recipientXWingPublicKey: kem.publicKey,
    amountAtoms: "12000000",
  };
  const verifyFastPayCertificate = async ({ orderHash, certificateDigest }) =>
    certificateDigest === "c".repeat(96) && orderHash.length === 96;
  const run = async (hooks) => {
    const store = new InMemoryFastPayPayoutStore([{ objectId: OBJ, valueAtoms: 100_000_000n, version: 3, nonce: 0 }]);
    const driver = createFastPayPayoutDriver({ ...chainConfig(), store, payoutSigner: signer, env, verifyFastPayCertificate, ...hooks });
    let result = null;
    let error = null;
    try {
      result = await driver.executePayout(base);
    } catch (caught) {
      error = caught;
    }
    return { store, result, error, record: store.getPayout("task_f3") };
  };

  // S1 of the review: a refusal resolved instead of thrown.
  const refused = await run({ submitFastPayOrder: async () => ({ ok: false, accepted: false, error: "InsufficientFee" }) });
  assert.equal(refused.result, null);
  assert.match(refused.error.message, /fastpay_unverified_result/);
  assert.equal(refused.record.status, "submit_unknown");
  assert.equal(refused.store.pool.get(OBJ).leasedBy, "task_f3");

  // An answer with no certificate.
  const empty = await run({ submitFastPayOrder: async () => ({}) });
  assert.equal(empty.record.status, "submit_unknown");
  assert.equal(empty.result, null);

  // A certificate the verifier does not accept.
  const forged = await run({ submitFastPayOrder: async () => ({ certificateDigest: "d".repeat(96) }) });
  assert.equal(forged.record.status, "submit_unknown");

  // The query is not trusted on confirmed === true alone.
  const bareQuery = await run({
    submitFastPayOrder: async () => {
      throw new Error("timeout");
    },
    queryFastPayOrder: async () => ({ confirmed: true }),
  });
  assert.equal(bareQuery.record.status, "submit_unknown");
  assert.equal(bareQuery.result, null);

  // A confirmed record for another order hash is not this payout.
  const otherHash = await run({
    submitFastPayOrder: async () => {
      throw new Error("timeout");
    },
    queryFastPayOrder: async () => ({ confirmed: true, orderHash: "f".repeat(96), certificateDigest: "c".repeat(96), blockHeight: 9 }),
  });
  assert.equal(otherHash.record.status, "submit_unknown");

  // A verified certificate is recorded as paid.
  const good = await run({ submitFastPayOrder: async () => ({ certificateDigest: "c".repeat(96), blockHeight: 9 }) });
  assert.equal(good.error, null);
  assert.equal(good.result.ok, true);
  assert.equal(good.result.verified, true);
  assert.equal(good.record.status, "confirmed");

  // The reward path refuses a receipt that is not verified.
  assert.throws(() => fp.assertVerifiedFastPayReceipt({ ok: true, lane: "fastpay", certificateDigest: "" }), /fastpay_receipt_not_verified/);
  assert.throws(() => fp.assertVerifiedFastPayReceipt({ ok: true, lane: "fastpay", certificateDigest: "c".repeat(96) }), /fastpay_receipt_not_verified/);
  assert.doesNotThrow(() => fp.assertVerifiedFastPayReceipt(good.result));
});

// Review of PR 450, finding 2: the consensus fallback is off by default and pays only after a proved cancel.
test("finding 2: the fallback is off by default and pays by consensus only after the FastPay lock is proved cancelled", async () => {
  const fp = await import("./fastpay-payout.js");
  assert.equal(fp.isFastPayConsensusFallbackEnabled({}), false);
  assert.equal(fp.isFastPayConsensusFallbackEnabled({ TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED: "1" }), true);

  const signer = generateMlDsa65Keypair(seed32("f2-payout"));
  const recip = generateMlDsa65Keypair(seed32("f2-recipient"));
  const kem = generateXWingKeypair(seed32("f2-kem"));
  const OBJ = "aa".repeat(32);
  const base = {
    payoutId: "task_f2",
    taskId: "task_f2",
    recipientAccount: recip.account,
    recipientPubkeyHex: recip.publicKeyHex,
    recipientXWingPublicKey: kem.publicKey,
    amountAtoms: "12000000",
  };
  const timeout = async () => {
    throw new Error("timeout");
  };

  async function scenario({ env, answer, verifyFastPayLockCancellation = async () => true }) {
    const store = new InMemoryFastPayPayoutStore([{ objectId: OBJ, valueAtoms: 100_000_000n, version: 3, nonce: 0 }]);
    const paid = [];
    const hooks = {
      ...chainConfig(),
      store,
      payoutSigner: signer,
      env,
      submitFastPayOrder: timeout,
      verifyFastPayCertificate: async () => false,
      verifyFastPayLockCancellation,
      submitConsensusFallback: async (p) => {
        paid.push(p.amountAtoms);
        return { txHash: "cc".repeat(48), validated: true };
      },
    };
    // First attempt: the submission times out and nothing is known; the order stays persisted.
    await assert.rejects(() => fp.createFastPayPayoutDriver({ ...hooks, queryFastPayOrder: async () => null }).executePayout(base));
    const record = store.getPayout("task_f2");
    const lockId = record.lockId || "ab".repeat(48);
    if (!record.lockId) store.savePayout("task_f2", { ...record, lockId, objectVersion: 3 });
    const driver = fp.createFastPayPayoutDriver({ ...hooks, queryFastPayOrder: async () => answer(lockId) });
    let result = null;
    let error = null;
    try {
      result = await driver.executePayout(base);
    } catch (caught) {
      error = caught;
    }
    return { store, paid, result, error, lockId };
  }

  const on = { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1", TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED: "1" };
  const neverCertified = () => ({ certified: false, reason: "never_certified" });

  // S2 of the review: one "never certified" answer is not a proof; nothing is paid and the object stays leased.
  const s2 = await scenario({ env: on, answer: neverCertified });
  assert.equal(s2.paid.length, 0);
  assert.ok(s2.error);
  assert.equal(s2.store.getPayout("task_f2").status, "submit_unknown");
  assert.equal(s2.store.leaseObject({ payoutId: "task_next", minAtoms: 1n }), null);

  // With the fallback switch unset, even a proved cancel pays nothing by another lane.
  const cancelled = (lockId, version = 4, kind = "cancelled_fence") => ({
    certified: false,
    reason: "never_certified",
    cancellation: { kind, lockId, recoveredObject: { objectId: OBJ, version, valueAtoms: "100000000" } },
  });
  const defaultOff = await scenario({ env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" }, answer: (l) => cancelled(l) });
  assert.equal(defaultOff.paid.length, 0);

  // A cancel for another lock, at the same version, or not accepted by the verifier is not a proof.
  assert.equal((await scenario({ env: on, answer: () => cancelled("cd".repeat(48)) })).paid.length, 0);
  assert.equal((await scenario({ env: on, answer: (l) => cancelled(l, 3) })).paid.length, 0);
  assert.equal((await scenario({ env: on, answer: (l) => cancelled(l), verifyFastPayLockCancellation: async () => false })).paid.length, 0);

  // A proved cancel (fence or recovery certificate): one payment, and the object returns at its post-cancel version.
  for (const kind of ["cancelled_fence", "recovery_certificate"]) {
    const proved = await scenario({ env: on, answer: (l) => cancelled(l, 4, kind) });
    assert.equal(proved.error, null);
    assert.deepEqual(proved.paid, ["12000000"]);
    assert.equal(proved.result.lane, "consensus_pft");
    assert.equal(proved.result.verified, true);
    const back = proved.store.pool.get(OBJ);
    assert.equal(back.leasedBy, null);
    assert.equal(back.version, 4);
  }
});

// Review of PR 450, finding 1: the driver builds, hashes, prices and signs the chain's OwnedTransferOrderV3.
// The vector was printed by Rust (Train A 1d41d5bf4), not by this JavaScript.
test("finding 1: the order matches the chain's OwnedTransferOrderV3 signing bytes, digest, lock id, fee and owner signature", async () => {
  const fp = await import("./fastpay-payout.js");
  const { readFileSync } = await import("node:fs");
  const vector = JSON.parse(readFileSync(new URL("./fixtures/fastpay-owned-transfer-v3-vector.json", import.meta.url), "utf8"));
  const order = vector.order_json;

  const preimage = fp.fastpayTransferLockPreimageV1(order);
  assert.equal(preimage.length, vector.lock_preimage_len);
  assert.equal(fp.fastpayTransferLockIdV1(order), vector.lock_id);
  const signing = fp.ownedTransferV3SigningBytes(order);
  assert.equal(signing.length, vector.signing_bytes_len);
  assert.equal(signing.subarray(0, 200).toString("hex"), vector.signing_bytes_head_hex);
  assert.equal(signing.subarray(signing.length - 200).toString("hex"), vector.signing_bytes_tail_hex);
  assert.equal(fp.fastpayTransferOrderDigestV3(order), vector.order_digest);
  assert.equal(computeFastPayOrderHash(order), vector.order_digest);
  assert.equal(
    fastpayMinimumFeeAtoms({ weightBytes: signing.length, inputsConsumed: 1, outputsCreated: 2 }),
    BigInt(vector.minimum_fee_atoms)
  );

  // The Task Node's ML-DSA wallet code derives the same owner key and accepts Rust's owner signature.
  const owner = generateMlDsa65Keypair(Buffer.from(vector.owner_seed_hex, "hex"));
  assert.equal(owner.publicKeyHex, vector.owner_pubkey_hex);
  const rustSigned = { order, owner_pubkey_hex: vector.owner_pubkey_hex, owner_signature_hex: vector.owner_signature_hex };
  assert.equal(fp.verifyOwnedTransferV3Signature(rustSigned), true);
  assert.equal(fp.verifyOwnedTransferV3Signature({ ...rustSigned, order: { ...order, fee: order.fee + 1 } }), false);
  const signed = fp.signOwnedTransferOrderV3(order, owner);
  assert.equal(fp.verifyOwnedTransferV3Signature(signed), true);
  assert.deepEqual(Object.keys(signed), ["order", "owner_pubkey_hex", "owner_signature_hex"]);

  // The driver submits exactly this shape, with order_hash as the chain computes it and the fee on the real length.
  const recip = generateMlDsa65Keypair(seed32("f1-recipient"));
  const kem = generateXWingKeypair(seed32("f1-kem"));
  const store = new InMemoryFastPayPayoutStore([{ objectId: "aa".repeat(32), valueAtoms: 100_000_000n, version: 3, nonce: 0 }]);
  let sent = null;
  const driver = createFastPayPayoutDriver({
    store,
    payoutSigner: owner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" },
    fastpayDomain: order.domain,
    fastpayRecoveryWindow: async () => ({ committee_epoch: 2, valid_from_height: 1900, expires_at_height: 2000, recovery_closes_at_height: 2100 }),
    verifyFastPayCertificate: async () => true,
    submitFastPayOrder: async (x) => {
      sent = x;
      return { certificateDigest: "c".repeat(96) };
    },
  });
  const paid = await driver.executePayout({
    payoutId: "task_f1",
    recipientAccount: recip.account,
    recipientPubkeyHex: recip.publicKeyHex,
    recipientXWingPublicKey: kem.publicKey,
    amountAtoms: "12000000",
  });
  const chainOrder = sent.signedOrder.order;
  assert.deepEqual(Object.keys(chainOrder), ["domain", "recovery", "inputs", "outputs", "fee", "nonce", "memos"]);
  assert.deepEqual(chainOrder.inputs, [{ id: "aa".repeat(32), version: 3 }]);
  assert.equal(chainOrder.outputs[0].owner_pubkey_hex, recip.publicKeyHex);
  assert.ok(chainOrder.outputs.every((out) => out.asset === "PFT" && !("owner_account" in out)));
  assert.equal(chainOrder.recovery.lock_id, fp.fastpayTransferLockIdV1(chainOrder));
  assert.equal(sent.orderHash, fp.fastpayTransferOrderDigestV3(chainOrder));
  assert.equal(paid.orderHash, sent.orderHash);
  assert.equal(store.getPayout("task_f1").lockId, chainOrder.recovery.lock_id);
  const len = fp.ownedTransferV3SigningBytes(chainOrder).length;
  assert.equal(BigInt(chainOrder.fee), fastpayMinimumFeeAtoms({ weightBytes: len, inputsConsumed: 1, outputsCreated: chainOrder.outputs.length }));
  assert.equal(BigInt(chainOrder.outputs[0].value + chainOrder.outputs[1].value + chainOrder.fee), 100_000_000n);
  assert.equal(fp.verifyOwnedTransferV3Signature(sent.signedOrder), true);

  // No owner signature, no submission.
  const unsigned = createFastPayPayoutDriver({
    store: new InMemoryFastPayPayoutStore([{ objectId: "aa".repeat(32), valueAtoms: 100_000_000n, version: 3, nonce: 0 }]),
    payoutSigner: owner,
    env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" },
    fastpayDomain: order.domain,
    fastpayRecoveryWindow: async () => ({ committee_epoch: 2, valid_from_height: 1900, expires_at_height: 2000, recovery_closes_at_height: 2100 }),
    signOwnedTransferOrder: async (o) => ({ order: o, owner_pubkey_hex: owner.publicKeyHex, owner_signature_hex: "" }),
    submitFastPayOrder: async () => {
      throw new Error("must_not_submit_unsigned");
    },
  });
  await assert.rejects(
    () => unsigned.executePayout({ payoutId: "task_f1u", recipientAccount: recip.account, recipientPubkeyHex: recip.publicKeyHex, recipientXWingPublicKey: kem.publicKey, amountAtoms: "12000000" }),
    /fastpay_owner_signature_invalid/
  );
});

// Review of PR 450, finding 5: a failure before anything is sent is retryable, not "submit unknown".
test("finding 5: errors raised before sending carry submissionAttempted:false, and the order hash is reported before sending", async () => {
  const { submissionDefinitelyNotAttempted } = await import("../task-review-core.js");
  const signer = generateMlDsa65Keypair(seed32("f5-payout"));
  const recip = generateMlDsa65Keypair(seed32("f5-recipient"));
  const kem = generateXWingKeypair(seed32("f5-kem"));
  const env = { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" };
  const base = { payoutId: "task_f5", recipientAccount: recip.account, recipientPubkeyHex: recip.publicKeyHex, recipientXWingPublicKey: kem.publicKey, amountAtoms: "12000000" };
  const make = (objects, extra = {}) =>
    createFastPayPayoutDriver({ ...chainConfig(), store: new InMemoryFastPayPayoutStore(objects), payoutSigner: signer, env, verifyFastPayCertificate: async () => true, submitFastPayOrder: async () => ({ certificateDigest: "c".repeat(96) }), ...extra });
  const pool = [{ objectId: "aa".repeat(32), valueAtoms: 100_000_000n, version: 3, nonce: 0 }];
  const cases = [
    ["S5 no X-Wing key", make(pool), { ...base, recipientXWingPublicKey: undefined }],
    ["S6 empty pool", make([]), base],
    ["no recipient public key", make(pool), { ...base, recipientPubkeyHex: "" }],
  ];
  for (const [label, driver, input] of cases) {
    const error = await driver.executePayout(input).then(() => null, (caught) => caught);
    assert.ok(error, label);
    assert.equal(submissionDefinitelyNotAttempted(error), true, `${label}: ${error.message}`);
  }
  const seen = [];
  const driver = make(pool, {
    submitFastPayOrder: async ({ orderHash }) => {
      assert.deepEqual(seen.map((x) => x.orderHash), [orderHash]);
      throw new Error("timeout");
    },
  });
  const error = await driver.executePayout({ ...base, onPrepared: async (prepared) => seen.push(prepared) }).then(() => null, (caught) => caught);
  assert.equal(submissionDefinitelyNotAttempted(error), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].lockId.length, 96);
});

// Second-reader fix: recovery.lock_id is 96 hex chars once populated, so buildOrder() must
// price signing bytes with a 96-char placeholder to avoid 1-atom under-calculation near 512B boundaries.
test("fee pricing accounts for the 96-byte recovery.lock_id across 512-byte fee boundaries", async () => {
  const fp = await import("./fastpay-payout.js");
  const owner = generateMlDsa65Keypair(seed32("boundary-owner"));
  const recip = generateMlDsa65Keypair(seed32("boundary-recip"));
  const kem = generateXWingKeypair(seed32("boundary-kem"));
  for (let padLen = 0; padLen < 120; padLen += 1) {
    const store = new InMemoryFastPayPayoutStore([{ objectId: "bb".repeat(32), valueAtoms: 100_000_000n, version: 1, nonce: 0 }]);
    let sent = null;
    const driver = createFastPayPayoutDriver({
      ...chainConfig(),
      store,
      payoutSigner: owner,
      env: { TASKNODE_FASTPAY_PAYOUTS_ENABLED: "1" },
      verifyFastPayCertificate: async () => true,
      submitFastPayOrder: async (x) => {
        sent = x;
        return { certificateDigest: "d".repeat(96) };
      },
    });
    await driver.executePayout({
      payoutId: `p_${"x".repeat(padLen)}`,
      recipientAccount: recip.account,
      recipientPubkeyHex: recip.publicKeyHex,
      recipientXWingPublicKey: kem.publicKey,
      amountAtoms: "5000000",
    });
    const chainOrder = sent.signedOrder.order;
    const finalLen = fp.ownedTransferV3SigningBytes(chainOrder).length;
    const expectedMin = fastpayMinimumFeeAtoms({
      weightBytes: finalLen,
      inputsConsumed: chainOrder.inputs.length,
      outputsCreated: chainOrder.outputs.length,
    });
    assert.ok(
      BigInt(chainOrder.fee) >= expectedMin,
      `padLen=${padLen} finalLen=${finalLen} mod512=${finalLen % 512} fee=${chainOrder.fee} < min=${expectedMin}`
    );
  }
});

test("payment reference uses SHA3-384 for each present chain identifier", async () => {
  const { encodeFastPayPaymentRef, decodeFastPayPaymentRef } = await import("./message-protocol.js");
  for (const field of ["orderHash", "certificateDigest", "txHash"]) {
    const bytes = Buffer.alloc(48, 21);
    assert.deepEqual(decodeFastPayPaymentRef(encodeFastPayPaymentRef({ [field]: bytes }))[field], bytes);
    assert.throws(() => encodeFastPayPaymentRef({ [field]: Buffer.alloc(32) }), /invalid_chain_hash/);
  }
  assert.deepEqual(encodeFastPayPaymentRef({}), Buffer.alloc(0));
});

test("v5 pointer decoding enforces the same canonical representation as encoding", () => {
  const canonical = encodePointerV5({ flags: POINTER_FLAG.PUBLIC, target: POINTER_TARGET.INLINE, inlinePayload: Buffer.of(1) });
  assert.deepEqual(encodePointerV5(decodePointerV5(canonical)), canonical);
  assert.throws(() => decodePointerV5(Buffer.alloc(257)), /exceeds_256/);
  assert.throws(() => decodePointerV5(Buffer.concat([canonical, Buffer.of(88, 1)])), /noncanonical/);
});
