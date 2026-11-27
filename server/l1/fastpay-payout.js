import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
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
export const FASTPAY_LOCK_ID_DOMAIN_V1 = "postfiat.fastpay.lock-id.v1";
export const FASTPAY_ORDER_RECOVERY_SCHEMA_V1 = "postfiat-fastpay-order-recovery-v1";
export const OWNED_CERTIFICATE_DOMAIN_SCHEMA_V2 = "postfiat-owned-certificate-domain-v2";
export const OWNED_TRANSFER_CONTEXT_V3 = "postfiat-l1-v2/owned-transfer/v3";
export const OWNED_NATIVE_ASSET = "PFT";
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

// Off unless switched on: paying by another lane is safe only after a proved cancel.
export function isFastPayConsensusFallbackEnabled(env = process.env) {
  return truthyEnv(env?.TASKNODE_FASTPAY_CONSENSUS_FALLBACK_ENABLED);
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

// Byte ports of Train A (postfiatl1v2 1d41d5bf4): fastpay_transfer_lock_preimage_v1
// (crates/types/src/fastpay_recovery_types.rs), owned_transfer_v3_signing_bytes and
// fastpay_transfer_order_digest_v3 (crates/execution/src/owned_transfer_recovery.rs).
// Pinned against a Rust-printed vector in fixtures/fastpay-owned-transfer-v3-vector.json.
function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(Number(value));
  return out;
}

function lenText(value = "") {
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([u64le(bytes.length), bytes]);
}

export function fastpayTransferLockPreimageV1(order = {}) {
  const { domain = {}, recovery = {} } = order;
  const inputs = Array.isArray(order.inputs) ? order.inputs : [];
  const outputs = Array.isArray(order.outputs) ? order.outputs : [];
  const memos = Array.isArray(order.memos) ? order.memos : [];
  return Buffer.concat([
    Buffer.from("postfiat.fastpay.transfer-lock-preimage.v1\0", "utf8"),
    lenText(domain.schema),
    lenText(domain.chain_id),
    lenText(domain.genesis_hash),
    u32le(domain.protocol_version),
    lenText(domain.registry_id),
    u64le(recovery.committee_epoch),
    u64le(recovery.valid_from_height),
    u64le(recovery.expires_at_height),
    u64le(recovery.recovery_closes_at_height),
    u64le(inputs.length),
    ...inputs.flatMap((input) => [lenText(input.id), u64le(input.version)]),
    u64le(outputs.length),
    ...outputs.flatMap((output) => [lenText(output.owner_pubkey_hex), u64le(output.value), lenText(output.asset)]),
    u64le(order.fee),
    u64le(order.nonce),
    u64le(memos.length),
    ...memos.flatMap((memo) => [lenText(memo.memo_type), lenText(memo.memo_format), lenText(memo.memo_data)]),
  ]);
}

export function fastpayTransferLockIdV1(order = {}) {
  return hashHexDomain(FASTPAY_LOCK_ID_DOMAIN_V1, fastpayTransferLockPreimageV1(order));
}

export function ownedTransferV3SigningBytes(order = {}) {
  const preimage = fastpayTransferLockPreimageV1(order);
  return Buffer.concat([
    Buffer.from("postfiat.owned-transfer.v3\0", "utf8"),
    u64le(preimage.length),
    preimage,
    lenText(order.recovery?.lock_id),
  ]);
}

export function fastpayTransferOrderDigestV3(order = {}) {
  return hashHexDomain(FASTPAY_TRANSFER_ORDER_DOMAIN, ownedTransferV3SigningBytes(order));
}

// The order hash is the chain's order digest; it is what queries and the chain's index use.
export function computeFastPayOrderHash(orderOrBytes) {
  if (Buffer.isBuffer(orderOrBytes) || orderOrBytes instanceof Uint8Array) {
    return hashHexDomain(FASTPAY_TRANSFER_ORDER_DOMAIN, orderOrBytes);
  }
  return fastpayTransferOrderDigestV3(orderOrBytes);
}

// SignedOwnedTransferOrderV3 {order, owner_pubkey_hex, owner_signature_hex}, signed with the
// Task Node's ML-DSA-65 wallet code under OWNED_TRANSFER_CONTEXT_V3.
export function signOwnedTransferOrderV3(order, signer) {
  if (!signer?.publicKey || !signer?.secretKey) throw new Error("fastpay_owner_signer_required");
  const signature = ml_dsa65.sign(ownedTransferV3SigningBytes(order), Uint8Array.from(signer.secretKey), {
    context: Buffer.from(OWNED_TRANSFER_CONTEXT_V3, "utf8"),
  });
  return {
    order,
    owner_pubkey_hex: Buffer.from(signer.publicKey).toString("hex"),
    owner_signature_hex: Buffer.from(signature).toString("hex"),
  };
}

export function verifyOwnedTransferV3Signature(signed = {}) {
  const pubkey = safeText(signed?.owner_pubkey_hex, 8192);
  const signature = safeText(signed?.owner_signature_hex, 16384);
  if (!/^[0-9a-f]+$/.test(pubkey) || !/^[0-9a-f]+$/.test(signature) || !signed?.order) return false;
  try {
    return ml_dsa65.verify(Buffer.from(signature, "hex"), ownedTransferV3SigningBytes(signed.order), Buffer.from(pubkey, "hex"), {
      context: Buffer.from(OWNED_TRANSFER_CONTEXT_V3, "utf8"),
    });
  } catch {
    return false;
  }
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
        version: Number(obj.version || 0),
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
        version: Number(changeObject.version || 0),
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
          version: Number(replaceObject.version || 0),
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
// 3. Falls back to consensus payment_v2 only when switched on and only after the FastPay lock is
//    proved cancelled; the leased object returns to the pool at its post-cancel version.
// 4. Async IPFS pinning runs in parallel so IPFS I/O never stalls FastPay finality.
export function createFastPayPayoutDriver({
  chainId = "postfiat-wan-devnet-2",
  store,
  payoutSigner,
  submitFastPayOrder,
  queryFastPayOrder,
  verifyFastPayCertificate = null,
  verifyFastPayLockCancellation = null,
  submitConsensusFallback = null,
  pinEnvelope = null,
  fastpayDomain = null,
  fastpayRecoveryWindow = null,
  signOwnedTransferOrder = null,
  env = process.env,
} = {}) {
  if (!store) throw new Error("fastpay_payout_store_required");
  if (!payoutSigner?.publicKey || !payoutSigner?.secretKey) throw new Error("fastpay_payout_signer_required");
  if (typeof submitFastPayOrder !== "function") throw new Error("fastpay_submit_fn_required");
  const senderAccount = addressFromPublicKey(payoutSigner.publicKey);
  const senderPubkeyHex = Buffer.from(payoutSigner.publicKey).toString("hex");

  // A payout counts as paid only on a certificate the injected verifier accepts
  // for this exact order hash. Refusals, empty answers and bare flags are unknown.
  async function verifyChainResult(res, persisted, source) {
    if (!res || typeof res !== "object") return { ok: false, reason: "no_answer" };
    if (res.ok === false || res.accepted === false || res.refused === true || res.rejected === true || res.error) {
      return { ok: false, reason: `refused:${safeText(res.error || res.reason || "refused", 120)}` };
    }
    if (source === "query" && res.confirmed !== true) return { ok: false, reason: "not_confirmed" };
    const answeredHash = safeText(res.orderHash || res.order_hash, 128).toLowerCase();
    if (source === "query" && !answeredHash) return { ok: false, reason: "query_without_order_hash" };
    if (answeredHash && answeredHash !== persisted.orderHash) return { ok: false, reason: "order_hash_mismatch" };
    const certificate = res.certificate ?? null;
    const certificateDigest = safeText(res.certificateDigest || res.certificate_digest, 128).toLowerCase();
    if (!certificate && !/^[0-9a-f]{96}$/.test(certificateDigest)) return { ok: false, reason: "no_certificate" };
    if (typeof verifyFastPayCertificate !== "function") return { ok: false, reason: "certificate_verifier_missing" };
    const verdict = await Promise.resolve()
      .then(() => verifyFastPayCertificate({
        orderHash: persisted.orderHash,
        order: persisted.order,
        certificate,
        certificateDigest,
        blockHeight: Number(res.blockHeight || res.block_height || 0),
      }))
      .catch(() => false);
    if (verdict !== true && verdict?.ok !== true) return { ok: false, reason: "certificate_not_verified" };
    const digest = safeText(verdict?.certificateDigest || certificateDigest, 128).toLowerCase();
    if (!/^[0-9a-f]{96}$/.test(digest)) return { ok: false, reason: "certificate_digest_missing" };
    return { ok: true, certificateDigest: digest };
  }

  // The lock is cancelled only on a cancelled fence or a recovery certificate for
  // this lock id that the injected verifier accepts, returning the leased object
  // at a later version. One "never certified" answer proves nothing.
  async function provenLockCancellation(res, persisted) {
    const cancellation = res?.cancellation;
    const lockId = safeText(persisted.lockId, 128).toLowerCase();
    if (!cancellation || !/^[0-9a-f]{96}$/.test(lockId)) return null;
    if (!["cancelled_fence", "recovery_certificate"].includes(cancellation.kind)) return null;
    if (safeText(cancellation.lockId || cancellation.lock_id, 128).toLowerCase() !== lockId) return null;
    const recovered = cancellation.recoveredObject || cancellation.recovered_object;
    if (!recovered || recovered.objectId !== persisted.objectId) return null;
    if (!(Number(recovered.version) > Number(persisted.objectVersion || 0))) return null;
    if (typeof verifyFastPayLockCancellation !== "function") return null;
    const verdict = await Promise.resolve()
      .then(() => verifyFastPayLockCancellation({ lockId, orderHash: persisted.orderHash, cancellation }))
      .catch(() => false);
    if (verdict !== true && verdict?.ok !== true) return null;
    return { kind: cancellation.kind, recoveredObject: { ...recovered, version: Number(recovered.version) } };
  }

  function unverifiedError(reason) {
    const error = new Error(`fastpay_unverified_result:${reason}`);
    error.submissionAttempted = true;
    return error;
  }

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
    if (existing?.status === "fallback_unknown") {
      const error = new Error("fastpay_fallback_outcome_unknown");
      error.submissionAttempted = true;
      throw error;
    }
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

      if (!/^[0-9a-f]+$/.test(safeText(recipientPubkeyHex, 8192).toLowerCase())) {
        throw new Error("fastpay_recipient_pubkey_required");
      }
      const domain = {
        schema: safeText(fastpayDomain?.schema || OWNED_CERTIFICATE_DOMAIN_SCHEMA_V2, 120),
        chain_id: safeText(fastpayDomain?.chain_id || chainId, 120),
        genesis_hash: safeText(fastpayDomain?.genesis_hash, 128).toLowerCase(),
        protocol_version: Number(fastpayDomain?.protocol_version || 0),
        registry_id: safeText(fastpayDomain?.registry_id, 128).toLowerCase(),
      };
      if (!domain.genesis_hash || !domain.registry_id || !domain.protocol_version) {
        throw new Error("fastpay_order_domain_required");
      }
      if (typeof fastpayRecoveryWindow !== "function") throw new Error("fastpay_recovery_window_required");
      const window = await fastpayRecoveryWindow({ chainId: domain.chain_id });
      const recoveryBase = {
        schema: FASTPAY_ORDER_RECOVERY_SCHEMA_V1,
        committee_epoch: Number(window?.committee_epoch || 0),
        lock_id: "",
        valid_from_height: Number(window?.valid_from_height || 0),
        expires_at_height: Number(window?.expires_at_height || 0),
        recovery_closes_at_height: Number(window?.recovery_closes_at_height || 0),
      };
      if (!recoveryBase.committee_epoch || !recoveryBase.valid_from_height || !(recoveryBase.expires_at_height >= recoveryBase.valid_from_height) || !(recoveryBase.recovery_closes_at_height > recoveryBase.expires_at_height)) {
        throw new Error("fastpay_recovery_window_invalid");
      }
      const memos = [{
        memo_type: artifact.memo.memo_type,
        memo_format: artifact.memo.memo_format,
        memo_data: artifact.memo.memo_data,
      }];

      // Build the chain's OwnedTransferOrderV3 and charge the fee on its real signing-byte length.
      const buildOrder = (leased, withChange) => {
        const outputs = [{ owner_pubkey_hex: safeText(recipientPubkeyHex, 8192).toLowerCase(), value: Number(payAtoms), asset: OWNED_NATIVE_ASSET }];
        if (withChange) outputs.push({ owner_pubkey_hex: senderPubkeyHex, value: 0, asset: OWNED_NATIVE_ASSET });
        const draft = {
          domain,
          recovery: { ...recoveryBase },
          inputs: [{ id: leased.objectId, version: Number(leased.version || 0) }],
          outputs,
          fee: 0,
          nonce: Number(leased.nonce || 0) + 1,
          memos,
        };
        // Every u64 is fixed width, so the length does not depend on the fee or change values.
        const minimum = fastpayMinimumFeeAtoms({
          weightBytes: ownedTransferV3SigningBytes(draft).length,
          inputsConsumed: draft.inputs.length,
          outputsCreated: outputs.length,
        });
        return { draft, minimum };
      };
      const probe = buildOrder({ objectId: "00".repeat(32), version: 0, nonce: 0 }, true);
      const leased = await store.leaseObject({ payoutId: id, minAtoms: payAtoms + probe.minimum });
      if (!leased) throw new Error("fastpay_payout_pool_exhausted");
      const leasedValue = BigInt(leased.valueAtoms);
      let { draft: order, minimum } = buildOrder(leased, true);
      let changeAtoms = leasedValue - payAtoms - minimum;
      if (changeAtoms > 0n) {
        order.fee = Number(minimum);
        order.outputs[1].value = Number(changeAtoms);
      } else {
        ({ draft: order, minimum } = buildOrder(leased, false));
        const fee = leasedValue - payAtoms;
        if (fee < minimum) {
          await store.releaseObjectLease({ objectId: leased.objectId, payoutId: id });
          throw new Error("fastpay_leased_object_insufficient_for_fee");
        }
        order.fee = Number(fee);
        changeAtoms = 0n;
      }
      if (!order.outputs.every((out) => Number.isSafeInteger(out.value)) || !Number.isSafeInteger(order.fee)) {
        await store.releaseObjectLease({ objectId: leased.objectId, payoutId: id });
        throw new Error("fastpay_order_value_exceeds_safe_integer");
      }
      order.recovery.lock_id = fastpayTransferLockIdV1(order);
      const exactFee = BigInt(order.fee);
      const finalChangeAtoms = changeAtoms;

      // The owner signature must be real: a hook may sign elsewhere, but nothing is sent without a valid one.
      const signedOrder = typeof signOwnedTransferOrder === "function"
        ? await signOwnedTransferOrder(order)
        : signOwnedTransferOrderV3(order, payoutSigner);
      if (
        !verifyOwnedTransferV3Signature(signedOrder) ||
        signedOrder.owner_pubkey_hex !== senderPubkeyHex ||
        fastpayTransferOrderDigestV3(signedOrder.order) !== fastpayTransferOrderDigestV3(order)
      ) {
        await store.releaseObjectLease({ objectId: leased.objectId, payoutId: id });
        throw new Error("fastpay_owner_signature_invalid");
      }
      const signedOrderBytes = Buffer.from(JSON.stringify(signedOrder), "utf8");
      const orderHash = fastpayTransferOrderDigestV3(order);

      persisted = await store.savePayout(id, {
        payoutId: id,
        taskId: taskId || id,
        lane: "fastpay",
        status: "order_persisted",
        objectId: leased.objectId,
        objectVersion: Number(leased.version || 0),
        changeAtoms: finalChangeAtoms.toString(),
        nonce: order.nonce,
        orderHash,
        lockId: order.recovery.lock_id,
        order,
        signedOrder,
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
      const checkedVerdict = await verifyChainResult(checked, persisted, "query");
      if (checkedVerdict.ok) {
        const receipt = buildConfirmedReceipt(persisted, { ...checked, certificateDigest: checkedVerdict.certificateDigest }, "fastpay");
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
        signedOrder: persisted.signedOrder,
        signedOrderBytes: Buffer.from(persisted.signedOrderBytesHex, "hex"),
      });
      const submitVerdict = await verifyChainResult(submitted, persisted, "submit");
      if (!submitVerdict.ok) throw unverifiedError(submitVerdict.reason);
      const receipt = buildConfirmedReceipt(persisted, { ...submitted, certificateDigest: submitVerdict.certificateDigest }, "fastpay");
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

      const statusVerdict = await verifyChainResult(statusCheck, persisted, "query");
      if (statusVerdict.ok) {
        const receipt = buildConfirmedReceipt(persisted, { ...statusCheck, certificateDigest: statusVerdict.certificateDigest }, "fastpay");
        await store.completeObjectLease({
          objectId: persisted.objectId,
          payoutId: id,
          changeObject: statusCheck.changeObject || null,
        });
        await store.savePayout(id, { ...persisted, status: "confirmed", receipt });
        if (awaitPin && pinPromise) await pinPromise;
        return { ...receipt, idempotentReplay: false, recoveredFromChain: true };
      }

      // Pay by consensus only after the FastPay lock is proved cancelled; the
      // object returns to the pool only at its post-cancel version.
      const cancelled = isFastPayConsensusFallbackEnabled(env) && typeof submitConsensusFallback === "function"
        ? await provenLockCancellation(statusCheck, persisted)
        : null;
      if (cancelled) {
        await store.releaseObjectLease({
          objectId: persisted.objectId,
          payoutId: id,
          replaceObject: cancelled.recoveredObject,
        });
        await store.savePayout(id, { ...persisted, lane: "consensus_pft", status: "fallback_unknown", cancellation: cancelled.kind });
        const fallbackRes = await submitConsensusFallback({
          payoutId: id,
          taskId: persisted.taskId,
          recipientAccount: persisted.recipientAccount,
          amountAtoms: persisted.amountAtoms,
          memo: persisted.memo,
          cid: persisted.cid,
          originalOrderHash: persisted.orderHash,
        });
        if (fallbackRes?.validated !== true || !safeText(fallbackRes?.txHash, 128) || fallbackRes?.ok === false) {
          throw unverifiedError("consensus_fallback_not_validated");
        }
        const receipt = {
          ok: true,
          verified: true,
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
          fastpayLockCancellation: cancelled.kind,
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

// The reward path calls this before it writes a FastPay reward as paid.
export function assertVerifiedFastPayReceipt(receipt = {}) {
  const digestOk = /^[0-9a-f]{96}$/.test(safeText(receipt?.certificateDigest, 128));
  const fallbackOk = receipt?.lane === "consensus_pft" && Boolean(safeText(receipt?.txHash, 128));
  if (receipt?.ok !== true || receipt?.verified !== true || !(digestOk || fallbackOk)) {
    const error = new Error("fastpay_receipt_not_verified");
    error.submissionAttempted = true;
    throw error;
  }
  return receipt;
}

function buildConfirmedReceipt(persisted, chainRes = {}, lane = "fastpay") {
  return {
    ok: true,
    verified: true,
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
