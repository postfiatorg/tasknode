import {
  BODY_ENCODING,
  CONTENT_KIND,
  PAYMENT_LANE,
  POINTER_FLAG,
  POINTER_TARGET,
  SCHEMA_ID,
  TASK_REWARD_BADGE_LABEL,
  VISIBILITY,
  addressFromPublicKey,
  buildFastPayPointerMemo,
  decodeAnyPointerMemo,
  decodeRewardNotice,
  encodeRewardNotice,
  encryptPrivateEnvelope,
  hashHexDomain,
  verifyEnvelopeRaw,
} from "./message-protocol.js";

export const FASTPAY_TRANSFER_ORDER_DOMAIN = "postfiat.fastpay.transfer-order.v3";
export const FASTPAY_MIN_BASE_FEE_ATOMS = 25n;
export const FASTPAY_FEE_BYTE_QUANTUM = 512n;
export const FASTPAY_FEE_PER_BYTE_QUANTUM_ATOMS = 1n;
export const FASTPAY_FEE_PER_NEW_OBJECT_ATOMS = 1_000n;
export const FASTPAY_FEE_PER_INPUT_ATOMS = 1n;
export const PFT_ATOMS_PER_PFT = 1_000_000n;

function truthyEnv(value = "") {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

export function isFastPayPayoutsEnabled(env = process.env) {
  return truthyEnv(env?.TASKNODE_FASTPAY_PAYOUTS_ENABLED);
}

export function isFastPayConsensusFallbackEnabled(env = process.env) {
  if (env?.TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED === undefined) return true;
  return truthyEnv(env.TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED);
}

export function isL1Address(value = "") {
  return /^pf[0-9a-f]{40}$/.test(safeText(value, 120));
}

// Sui-inspired minimum FastPay fee formula (Train A Contract Section 2.2):
//   25 + ceil(weight_bytes / 512) * 1 + max(0, outputs - inputs) * 1000 + inputs * 1
export function fastpayMinimumFeeAtoms({ weightBytes = 512, inputsConsumed = 1, outputsCreated = 2 } = {}) {
  const w = BigInt(Math.max(1, Math.trunc(Number(weightBytes) || 1)));
  const inputs = BigInt(Math.max(1, Math.trunc(Number(inputsConsumed) || 1)));
  const outputs = BigInt(Math.max(0, Math.trunc(Number(outputsCreated) || 0)));
  const byteQuanta = (w + FASTPAY_FEE_BYTE_QUANTUM - 1n) / FASTPAY_FEE_BYTE_QUANTUM;
  const byteFee = byteQuanta * FASTPAY_FEE_PER_BYTE_QUANTUM_ATOMS;
  const netNewObjects = outputs > inputs ? outputs - inputs : 0n;
  const newObjectFee = netNewObjects * FASTPAY_FEE_PER_NEW_OBJECT_ATOMS;
  const inputFee = inputs * FASTPAY_FEE_PER_INPUT_ATOMS;
  return FASTPAY_MIN_BASE_FEE_ATOMS + byteFee + newObjectFee + inputFee;
}

export function canonicalOrderSigningBytes(order = {}) {
  const normalized = {
    chain_id: safeText(order.chain_id || order.chainId, 120),
    owner_pubkey_hex: safeText(order.owner_pubkey_hex || order.ownerPubkeyHex, 8192).toLowerCase(),
    nonce: Number(order.nonce || 0),
    inputs: (Array.isArray(order.inputs) ? order.inputs : []).map((id) => String(id).toLowerCase()),
    outputs: (Array.isArray(order.outputs) ? order.outputs : []).map((out) => ({
      owner_pubkey_hex: safeText(out.owner_pubkey_hex || out.ownerPubkeyHex, 8192).toLowerCase(),
      owner_account: safeText(out.owner_account || out.ownerAccount, 120).toLowerCase(),
      value: String(out.value),
    })),
    fee: String(order.fee),
    memos: (Array.isArray(order.memos) ? order.memos : []).map((memo) => ({
      memo_type: safeText(memo.memo_type, 256).toLowerCase(),
      memo_format: safeText(memo.memo_format, 256).toLowerCase(),
      memo_data: safeText(memo.memo_data, 1024).toLowerCase(),
    })),
  };
  return Buffer.from(JSON.stringify(normalized), "utf8");
}

// Canonical immutable 96-hex SHA3-384 order_hash independent of validator certificate signatures.
export function computeFastPayOrderHash(orderOrBytes) {
  const bytes = Buffer.isBuffer(orderOrBytes) || orderOrBytes instanceof Uint8Array
    ? orderOrBytes
    : canonicalOrderSigningBytes(orderOrBytes);
  return hashHexDomain(FASTPAY_TRANSFER_ORDER_DOMAIN, bytes);
}

// Spoof-proof Explorer / Task Node "Task reward" badge verification (Pillar 2 Section 4).
// Shows "Task reward" ONLY when:
//   1. Raw-byte ML-DSA-65 signature is valid
//   2. Envelope sender matches txSignerAccount (when supplied)
//   3. Envelope sender_pubkey matches the pinned official Task Node payout key
//   4. Header schema_name == "pf.reward.v1" and visibility == VISIBILITY_PRIVATE (not SEALED)
export function classifyRewardBadge({
  rawEnvelopeBytes,
  txSignerAccount = "",
  officialPayoutPubkeyHex = "",
  officialPayoutAccount = "",
} = {}) {
  const verified = verifyEnvelopeRaw(rawEnvelopeBytes, {
    expectedSenderAccount: txSignerAccount || "",
  });
  if (!verified.ok) {
    return { badge: "Private message", verified: false, reason: verified.reason };
  }
  if (verified.header.schemaName !== "pf.reward.v1") {
    return { badge: "Private message", verified: false, reason: "schema_not_pf_reward_v1" };
  }
  if (verified.header.visibility !== VISIBILITY.PRIVATE) {
    return { badge: "Private message", verified: false, reason: "reward_visibility_must_be_private" };
  }
  const pinnedPubkey = safeText(officialPayoutPubkeyHex, 8192).toLowerCase();
  const pinnedAccount = safeText(officialPayoutAccount, 120).toLowerCase();
  if (!pinnedPubkey && !pinnedAccount) {
    return { badge: "Private message", verified: false, reason: "official_payout_key_unconfigured" };
  }
  if (pinnedPubkey && verified.senderPubkeyHex !== pinnedPubkey) {
    return { badge: "Private message", verified: false, reason: "sender_pubkey_not_official_payout_key" };
  }
  if (pinnedAccount && verified.derivedAccount !== pinnedAccount) {
    return { badge: "Private message", verified: false, reason: "sender_account_not_official_payout_account" };
  }
  return {
    badge: TASK_REWARD_BADGE_LABEL,
    verified: true,
    reason: "verified_official_task_reward",
    schemaName: verified.header.schemaName,
    senderAccount: verified.derivedAccount,
    senderPubkeyHex: verified.senderPubkeyHex,
    cid: verified.cid.multibaseCid,
    taskId: verified.header.taskId,
  };
}

export async function buildFastPayRewardEnvelopeAndMemo({
  chainId = "postfiat-wan-devnet-2",
  rewardId = "",
  taskId = "",
  recipientAccount = "",
  amountAtoms = 0n,
  assetId = "PFT",
  summary = "",
  recipients = [],
  payoutSigner,
  createdAtUnixMs = Date.now(),
} = {}) {
  if (!payoutSigner?.publicKey || !payoutSigner?.secretKey) {
    throw new Error("fastpay_payout_signer_required");
  }
  const senderAccount = addressFromPublicKey(payoutSigner.publicKey);
  const noticeBytes = encodeRewardNotice({
    rewardId,
    taskId,
    recipientAccount,
    amountAtoms: BigInt(amountAtoms),
    assetId,
    summary,
  });

  // Pillar 2 locked decision: Task Node payouts are PRIVATE (not SEALED) so
  // task details stay confidential while explorers display the "Task reward" badge.
  const encrypted = await encryptPrivateEnvelope({
    header: {
      protocolVersion: 1,
      chainId,
      schemaName: "pf.reward.v1",
      schemaId: SCHEMA_ID.REWARD_V1,
      kind: CONTENT_KIND.REWARD,
      visibility: VISIBILITY.PRIVATE,
      bodyEncoding: BODY_ENCODING.PROTOBUF,
      senderAccount,
      createdAtUnixMs,
      taskId,
    },
    plaintextBodyBytes: noticeBytes,
    recipients,
    signerPublicKey: payoutSigner.publicKey,
    signerSecretKey: payoutSigner.secretKey,
  });

  const memo = buildFastPayPointerMemo({
    cidBin: encrypted.cid.cidBin,
    target: POINTER_TARGET.CONTENT_BLOB,
    kind: CONTENT_KIND.REWARD,
    schema: SCHEMA_ID.REWARD_V1,
    taskId,
    flags: POINTER_FLAG.PRIVATE,
  });

  return {
    senderAccount,
    senderPubkeyHex: Buffer.from(payoutSigner.publicKey).toString("hex"),
    rawEnvelopeBytes: encrypted.rawEnvelopeBytes,
    cid: encrypted.cid.multibaseCid,
    cidBinHex: encrypted.cid.cidBinHex,
    memo,
    badge: TASK_REWARD_BADGE_LABEL,
    pointerVersion: "v5",
  };
}

export class InMemoryFastPayPayoutStore {
  constructor(initialObjects = []) {
    this.payouts = new Map();
    this.pool = new Map();
    for (const obj of initialObjects) {
      this.pool.set(obj.objectId, {
        objectId: obj.objectId,
        valueAtoms: BigInt(obj.valueAtoms),
        nonce: Number(obj.nonce || 0),
        leasedBy: null,
      });
    }
  }

  getPayout(payoutId) {
    const rec = this.payouts.get(payoutId);
    return rec ? { ...rec } : null;
  }

  savePayout(payoutId, record) {
    this.payouts.set(payoutId, { ...record, updatedAt: new Date().toISOString() });
    return this.getPayout(payoutId);
  }

  leaseObject({ payoutId, minAtoms }) {
    const needed = BigInt(minAtoms);
    for (const obj of this.pool.values()) {
      if (obj.leasedBy === payoutId) return { ...obj };
    }
    for (const obj of this.pool.values()) {
      if (!obj.leasedBy && obj.valueAtoms >= needed) {
        obj.leasedBy = payoutId;
        return { ...obj };
      }
    }
    return null;
  }

  completeObjectLease({ objectId, payoutId, changeObject = null }) {
    const existing = this.pool.get(objectId);
    if (existing && existing.leasedBy === payoutId) {
      this.pool.delete(objectId);
    }
    if (changeObject && BigInt(changeObject.valueAtoms || 0n) > 0n) {
      this.pool.set(changeObject.objectId, {
        objectId: changeObject.objectId,
        valueAtoms: BigInt(changeObject.valueAtoms),
        nonce: Number(changeObject.nonce || 0),
        leasedBy: null,
      });
    }
  }

  releaseObjectLease({ objectId, payoutId, replaceObject = null }) {
    const existing = this.pool.get(objectId);
    if (existing && existing.leasedBy === payoutId) {
      if (replaceObject) {
        this.pool.delete(objectId);
        this.pool.set(replaceObject.objectId, {
          objectId: replaceObject.objectId,
          valueAtoms: BigInt(replaceObject.valueAtoms),
          nonce: Number(replaceObject.nonce || 0),
          leasedBy: null,
        });
      } else {
        existing.leasedBy = null;
      }
    }
  }
}

// Crash-safe FastPay payout driver (Pillar 2 Section 3):
// 1. Persists (payout_id, object_id, order_hash, signed_order_bytes) BEFORE validator submission.
// 2. Retries ALWAYS query / resubmit the EXACT persisted order_hash (zero equivocation, zero double-pay).
// 3. Falls back to consensus payment_v2 ONLY after confirming FastPay order was never certified and
//    cleanly recovering/releasing the leased object.
// 4. Async IPFS pinning runs in parallel so IPFS I/O never stalls FastPay finality.
export function createFastPayPayoutDriver({
  chainId = "postfiat-wan-devnet-2",
  store,
  payoutSigner,
  submitFastPayOrder,
  queryFastPayOrder,
  submitConsensusFallback = null,
  pinEnvelope = null,
  env = process.env,
} = {}) {
  if (!store) throw new Error("fastpay_payout_store_required");
  if (!payoutSigner?.publicKey || !payoutSigner?.secretKey) throw new Error("fastpay_payout_signer_required");
  if (typeof submitFastPayOrder !== "function") throw new Error("fastpay_submit_fn_required");
  const senderAccount = addressFromPublicKey(payoutSigner.publicKey);
  const senderPubkeyHex = Buffer.from(payoutSigner.publicKey).toString("hex");

  function scheduleAsyncPin(rawEnvelopeBytes, cid, meta) {
    if (typeof pinEnvelope !== "function") return Promise.resolve({ ok: true, cid, skipped: true });
    return Promise.resolve()
      .then(() => pinEnvelope({ rawEnvelopeBytes, cid, ...meta }))
      .catch((error) => ({ ok: false, cid, error: error?.message || "pin_failed" }));
  }

  async function executePayout({
    payoutId,
    taskId = "",
    recipientAccount,
    recipientPubkeyHex = "",
    recipientXWingPublicKey,
    serviceXWingPublicKey = null,
    amountAtoms,
    summary = "",
    awaitPin = false,
  } = {}) {
    if (!isFastPayPayoutsEnabled(env)) {
      throw new Error("fastpay_payouts_disabled");
    }
    const id = safeText(payoutId || taskId, 180);
    if (!id) throw new Error("fastpay_payout_id_required");
    if (!isL1Address(recipientAccount)) throw new Error("fastpay_invalid_recipient_account");
    const payAtoms = BigInt(amountAtoms);
    if (payAtoms <= 0n) throw new Error("fastpay_positive_amount_required");

    // Step 0: Idempotent check on durable store.
    const existing = await store.getPayout(id);
    if (existing?.status === "confirmed") {
      return {
        ...existing.receipt,
        idempotentReplay: true,
        orderHash: existing.orderHash,
        lane: existing.lane,
        badge: TASK_REWARD_BADGE_LABEL,
        pointerVersion: "v5",
      };
    }

    let persisted = existing;
    let pinPromise = null;

    // Step 1: If no order has been persisted yet, build envelope/memo, lease object,
    // sign order, and DURABLY persist BEFORE touching validators.
    if (!persisted || !persisted.orderHash || !persisted.signedOrderBytesHex) {
      const recipients = [{ account: recipientAccount, xwingPublicKey: recipientXWingPublicKey }];
      if (serviceXWingPublicKey) {
        recipients.push({ account: senderAccount, xwingPublicKey: serviceXWingPublicKey });
      }
      const artifact = await buildFastPayRewardEnvelopeAndMemo({
        chainId,
        rewardId: id,
        taskId: taskId || id,
        recipientAccount,
        amountAtoms: payAtoms,
        assetId: "PFT",
        summary,
        recipients,
        payoutSigner,
      });

      // Kick off async IPFS pinning in parallel so it never blocks FastPay submission.
      pinPromise = scheduleAsyncPin(artifact.rawEnvelopeBytes, artifact.cid, {
        taskId: taskId || id,
        payoutId: id,
        schema: "pf.reward.v1",
      });

      const estimatedFee = fastpayMinimumFeeAtoms({
        weightBytes: 640 + artifact.memo.byteLength,
        inputsConsumed: 1,
        outputsCreated: 2,
      });
      const leased = await store.leaseObject({ payoutId: id, minAtoms: payAtoms + estimatedFee });
      if (!leased) throw new Error("fastpay_payout_pool_exhausted");

      const changeAtoms = leased.valueAtoms - payAtoms - estimatedFee;
      const outputs = [
        { owner_account: recipientAccount, owner_pubkey_hex: recipientPubkeyHex, value: payAtoms.toString() },
      ];
      if (changeAtoms > 0n) {
        outputs.push({
          owner_account: senderAccount,
          owner_pubkey_hex: senderPubkeyHex,
          value: changeAtoms.toString(),
        });
      }
      const exactFee = fastpayMinimumFeeAtoms({
        weightBytes: 512 + artifact.memo.byteLength,
        inputsConsumed: 1,
        outputsCreated: outputs.length,
      });
      const finalChangeAtoms = leased.valueAtoms - payAtoms - exactFee;
      if (finalChangeAtoms < 0n) {
        await store.releaseObjectLease({ objectId: leased.objectId, payoutId: id });
        throw new Error("fastpay_leased_object_insufficient_for_fee");
      }
      if (outputs.length === 2) outputs[1].value = finalChangeAtoms.toString();

      const order = {
        chain_id: chainId,
        owner_pubkey_hex: senderPubkeyHex,
        nonce: leased.nonce + 1,
        inputs: [leased.objectId],
        outputs,
        fee: exactFee.toString(),
        memos: [
          {
            memo_type: artifact.memo.memo_type,
            memo_format: artifact.memo.memo_format,
            memo_data: artifact.memo.memo_data,
          },
        ],
      };
      const signedOrderBytes = canonicalOrderSigningBytes(order);
      const orderHash = computeFastPayOrderHash(signedOrderBytes);

      persisted = await store.savePayout(id, {
        payoutId: id,
        taskId: taskId || id,
        lane: "fastpay",
        status: "order_persisted",
        objectId: leased.objectId,
        changeAtoms: finalChangeAtoms.toString(),
        nonce: order.nonce,
        orderHash,
        order,
        signedOrderBytesHex: signedOrderBytes.toString("hex"),
        cid: artifact.cid,
        cidBinHex: artifact.cidBinHex,
        memo: artifact.memo,
        rawEnvelopeHex: artifact.rawEnvelopeBytes.toString("hex"),
        amountAtoms: payAtoms.toString(),
        feeAtoms: exactFee.toString(),
        recipientAccount,
        senderAccount,
        senderPubkeyHex,
        badge: TASK_REWARD_BADGE_LABEL,
        pointerVersion: "v5",
      });
    } else if (persisted.rawEnvelopeHex) {
      pinPromise = scheduleAsyncPin(Buffer.from(persisted.rawEnvelopeHex, "hex"), persisted.cid, {
        taskId: persisted.taskId,
        payoutId: id,
        schema: "pf.reward.v1",
      });
    }

    // Step 2: Before (re-)submitting, poll validator/RPC state for the EXACT persisted order_hash
    // so crash recovery NEVER double-pays an already-certified order.
    if (typeof queryFastPayOrder === "function" && persisted.status !== "order_persisted") {
      const checked = await queryFastPayOrder(persisted.orderHash).catch(() => null);
      if (checked?.confirmed === true) {
        const receipt = buildConfirmedReceipt(persisted, checked, "fastpay");
        await store.completeObjectLease({
          objectId: persisted.objectId,
          payoutId: id,
          changeObject: checked.changeObject || (BigInt(persisted.changeAtoms || 0n) > 0n
            ? { objectId: `${persisted.orderHash.slice(0, 64)}:1`, valueAtoms: persisted.changeAtoms, nonce: persisted.nonce }
            : null),
        });
        await store.savePayout(id, { ...persisted, status: "confirmed", receipt });
        if (awaitPin && pinPromise) await pinPromise;
        return { ...receipt, idempotentReplay: true, recoveredFromChain: true };
      }
    }

    // Step 3: Submit the exact persisted signed order bytes & order_hash to validators.
    await store.savePayout(id, { ...persisted, status: "submitting" });
    try {
      const submitted = await submitFastPayOrder({
        orderHash: persisted.orderHash,
        order: persisted.order,
        signedOrderBytes: Buffer.from(persisted.signedOrderBytesHex, "hex"),
      });
      const receipt = buildConfirmedReceipt(persisted, submitted, "fastpay");
      await store.completeObjectLease({
        objectId: persisted.objectId,
        payoutId: id,
        changeObject: submitted?.changeObject || (BigInt(persisted.changeAtoms || 0n) > 0n
          ? { objectId: `${persisted.orderHash.slice(0, 64)}:1`, valueAtoms: persisted.changeAtoms, nonce: persisted.nonce }
          : null),
      });
      await store.savePayout(id, { ...persisted, status: "confirmed", receipt });
      if (awaitPin && pinPromise) await pinPromise;
      return { ...receipt, idempotentReplay: false };
    } catch (submitError) {
      // Mark unknown until we check certification status.
      await store.savePayout(id, {
        ...persisted,
        status: "submit_unknown",
        lastError: submitError?.message || "fastpay_submit_failed",
      });

      // Check whether the exact order_hash was certified despite transport timeout.
      const statusCheck = typeof queryFastPayOrder === "function"
        ? await queryFastPayOrder(persisted.orderHash).catch(() => null)
        : null;

      if (statusCheck?.confirmed === true) {
        const receipt = buildConfirmedReceipt(persisted, statusCheck, "fastpay");
        await store.completeObjectLease({
          objectId: persisted.objectId,
          payoutId: id,
          changeObject: statusCheck.changeObject || null,
        });
        await store.savePayout(id, { ...persisted, status: "confirmed", receipt });
        if (awaitPin && pinPromise) await pinPromise;
        return { ...receipt, idempotentReplay: false, recoveredFromChain: true };
      }

      // Only fall back to consensus payment_v2 when explicitly confirmed never_certified!
      if (
        statusCheck?.certified === false &&
        statusCheck?.reason === "never_certified" &&
        isFastPayConsensusFallbackEnabled(env) &&
        typeof submitConsensusFallback === "function"
      ) {
        await store.releaseObjectLease({
          objectId: persisted.objectId,
          payoutId: id,
          replaceObject: statusCheck.recoveredObject || null,
        });
        const fallbackRes = await submitConsensusFallback({
          payoutId: id,
          taskId: persisted.taskId,
          recipientAccount: persisted.recipientAccount,
          amountAtoms: persisted.amountAtoms,
          memo: persisted.memo,
          cid: persisted.cid,
          originalOrderHash: persisted.orderHash,
        });
        const receipt = {
          ok: true,
          lane: "consensus_pft",
          txHash: fallbackRes.txHash,
          orderHash: persisted.orderHash,
          certificateDigest: "",
          cid: persisted.cid,
          memo: persisted.memo,
          badge: TASK_REWARD_BADGE_LABEL,
          pointerVersion: "v5",
          amountAtoms: persisted.amountAtoms,
          feeAtoms: String(fallbackRes.feeAtoms ?? persisted.feeAtoms),
          recipientAccount: persisted.recipientAccount,
          senderAccount: persisted.senderAccount,
          fallbackFromFastPay: true,
        };
        await store.savePayout(id, { ...persisted, lane: "consensus_pft", status: "confirmed", receipt });
        if (awaitPin && pinPromise) await pinPromise;
        return { ...receipt, idempotentReplay: false };
      }

      throw submitError;
    }
  }

  return {
    senderAccount,
    senderPubkeyHex,
    executePayout,
  };
}

function buildConfirmedReceipt(persisted, chainRes = {}, lane = "fastpay") {
  return {
    ok: true,
    lane,
    txHash: persisted.orderHash,
    orderHash: persisted.orderHash,
    certificateDigest: safeText(chainRes.certificateDigest || chainRes.certificate_digest, 128),
    fastpayLockId: safeText(chainRes.lockId || chainRes.fastpay_lock_id, 128),
    blockHeight: Number(chainRes.blockHeight || chainRes.block_height || 0),
    cid: persisted.cid,
    memo: persisted.memo,
    badge: TASK_REWARD_BADGE_LABEL,
    pointerVersion: "v5",
    amountAtoms: persisted.amountAtoms,
    feeAtoms: persisted.feeAtoms,
    recipientAccount: persisted.recipientAccount,
    senderAccount: persisted.senderAccount,
    senderPubkeyHex: persisted.senderPubkeyHex,
  };
}

// Unified dual-era reward history reader: seamlessly normalizes both FastPay v5
// (postfiatl1v2, keyed by order_hash) and legacy XRPL v4 (pf.ptr v4) reward history rows.
export function normalizeUnifiedRewardHistoryRow(row = {}, { officialPayoutPubkeyHex = "", officialPayoutAccount = "" } = {}) {
  const memos = Array.isArray(row.memos) ? row.memos : Array.isArray(row.tx?.Memos) ? row.tx.Memos : [];
  let decodedPointer = null;
  for (const memo of memos) {
    const parsed = decodeAnyPointerMemo(memo);
    if (parsed) {
      decodedPointer = parsed;
      break;
    }
  }

  const isFastPay =
    row.lane === "fastpay" ||
    row.batch_kind === "fastpay" ||
    row.transaction_kind === "owned_transfer_v3" ||
    Boolean(row.order_hash || row.orderHash);
  const pointerVersion = row.pointerVersion || row.pointer_version || decodedPointer?.version || (isFastPay ? "v5" : "v4");
  const orderHash = safeText(row.order_hash || row.orderHash, 128);
  const txHash = safeText(row.tx_id || row.txHash || row.tx_hash || orderHash, 128);
  const cid = safeText(row.cid || decodedPointer?.cid, 200);
  const taskId = safeText(row.taskId || row.task_id || decodedPointer?.taskId, 180);

  let badge = null;
  if (row.rawEnvelopeBytes) {
    badge = classifyRewardBadge({
      rawEnvelopeBytes: row.rawEnvelopeBytes,
      txSignerAccount: row.from || row.senderAccount || "",
      officialPayoutPubkeyHex,
      officialPayoutAccount,
    });
  } else if (isFastPay && decodedPointer?.kind === CONTENT_KIND.REWARD) {
    const fromAccount = safeText(row.from || row.senderAccount, 120).toLowerCase();
    const pinnedAccount = safeText(officialPayoutAccount, 120).toLowerCase();
    const verified = Boolean(pinnedAccount && fromAccount === pinnedAccount && decodedPointer.visibility === "private");
    badge = {
      badge: verified ? TASK_REWARD_BADGE_LABEL : "Private message",
      verified,
    };
  }

  const amountAtoms = row.amountAtoms ?? row.amount_atoms ?? row.amount ?? row.deliveredDrops ?? "0";

  return {
    id: orderHash || txHash,
    txHash,
    orderHash: orderHash || null,
    certificateDigest: safeText(row.certificate_digest || row.certificateDigest, 128) || null,
    lane: isFastPay ? "fastpay" : row.lane || "legacy_pftl_v4",
    pointerVersion,
    taskId,
    cid,
    from: safeText(row.from || row.account || row.senderAccount, 120),
    to: safeText(row.to || row.destination || row.recipientAccount, 120),
    amountAtoms: String(amountAtoms),
    amountPft: Number((Number(amountAtoms) / Number(PFT_ATOMS_PER_PFT)).toFixed(6)),
    feeAtoms: String(row.fee ?? row.feeAtoms ?? row.feeDrops ?? "0"),
    blockHeight: Number(row.block_height ?? row.blockHeight ?? row.ledgerIndex ?? 0),
    timestamp: row.timestamp || row.closeTime || row.observedAt || null,
    badge: badge?.badge || (decodedPointer?.kind === CONTENT_KIND.REWARD && pointerVersion === "v4" ? "Legacy task reward" : null),
    badgeVerified: Boolean(badge?.verified),
    pointer: decodedPointer,
  };
}

export function readUnifiedRewardHistory({
  fastpayRows = [],
  legacyRows = [],
  officialPayoutPubkeyHex = "",
  officialPayoutAccount = "",
} = {}) {
  const seen = new Set();
  const merged = [];
  for (const raw of [...(Array.isArray(fastpayRows) ? fastpayRows : []), ...(Array.isArray(legacyRows) ? legacyRows : [])]) {
    const normalized = normalizeUnifiedRewardHistoryRow(raw, {
      officialPayoutPubkeyHex,
      officialPayoutAccount,
    });
    const key = normalized.orderHash || normalized.txHash;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(normalized);
  }
  merged.sort((a, b) => {
    const timeDiff = Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return (b.blockHeight || 0) - (a.blockHeight || 0);
  });
  return merged;
}

export { decodeRewardNotice, PAYMENT_LANE };
