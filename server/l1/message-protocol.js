import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import sodium from "libsodium-wrappers";
import {
  cidBinToMultibase,
  cidMultibaseToBin,
  computeRawCidV1,
  decodeIpfsCidRef,
  decodeWireFields,
  encodeIpfsCidRef,
  hashHexDomain,
  hkdfSha256,
  pbBytes,
  pbMsg,
  pbString,
  pbVarint,
  sha256Bytes,
  sha3_384Bytes,
  toBytes,
} from "./wire-codec.js";

export {
  cidBinToMultibase,
  cidMultibaseToBin,
  computeRawCidV1,
  decodeIpfsCidRef,
  decodeWireFields,
  encodeIpfsCidRef,
  hashHexDomain,
  hkdfSha256,
  sha256Bytes,
  sha3_384Bytes,
  toBytes,
};

export const POINTER_MEMO_TYPE = "pf.ptr";
export const POINTER_MEMO_FORMAT_V5 = "v5";
export const POINTER_MEMO_FORMAT_V4 = "v4";
export const POINTER_MEMO_TYPE_HEX = "70662e707472";
export const POINTER_MEMO_FORMAT_V5_HEX = "7635";
export const MAX_PAYMENT_MEMO_DATA_BYTES = 256;
export const MAX_SINGLE_ENVELOPE_BYTES = 1_048_576;
export const TASK_REWARD_BADGE_LABEL = "Task reward";

export const ADDRESS_PREFIX = "pf";
export const ADDRESS_DERIVATION_DOMAIN = "postfiat.address.v1";
export const DOMAIN_ENVELOPE_SIGN = "postfiat-l1-v2/message-envelope/v1";
export const DOMAIN_MESSAGE_AAD = "postfiat-l1-v2/message-aad/v1";
export const DOMAIN_XWING_WRAP_INFO = "postfiat-l1-v2/xwing-wrap/v1";
const CEK_COMMIT_PREFIX = Buffer.from("postfiat-l1-v2/cek-commit/v1\0", "ascii");
const SEALED_TAG_PREFIX = Buffer.from("postfiat-l1-v2/sealed-recipient-tag/v1\0", "ascii");
export const DOMAIN_MESSAGE_KEY_KDF = "postfiat-l1-v2/message-key/v1";
export const DOMAIN_MESSAGE_KEY_BIND = "postfiat-l1-v2/message-key-bind/v1";

export const CONTENT_KIND = Object.freeze({
  UNSPECIFIED: 0,
  TASK: 1,
  TASK_UPDATE: 2,
  TASK_SUBMISSION: 3,
  CHAT: 4,
  CONTEXT: 5,
  REWARD: 6,
  POLICY: 7,
  IDENTITY: 8,
  ASSET: 9,
  DOCUMENT: 10,
  SYSTEM: 11,
  GOVERNANCE: 12,
  NFT: 13,
  X402: 14,
  TEST: 99,
});

export const CONTENT_KIND_BY_VALUE = Object.freeze(
  Object.fromEntries(Object.entries(CONTENT_KIND).map(([k, v]) => [v, k]))
);

export const POINTER_TARGET = Object.freeze({
  UNSPECIFIED: 0,
  CONTENT_BLOB: 1,
  MANIFEST: 2,
  INLINE: 3,
});

export const POINTER_FLAG = Object.freeze({
  UNSPECIFIED: 0,
  PRIVATE: 0x01,
  PUBLIC: 0x02,
  EPHEMERAL: 0x04,
  TOMBSTONE: 0x08,
  MULTIPART: 0x10,
  SEALED: 0x20,
});

export const VISIBILITY_FLAG_MASK = POINTER_FLAG.PRIVATE | POINTER_FLAG.PUBLIC | POINTER_FLAG.SEALED;
export const ALLOWED_POINTER_FLAG_MASK = 0x3f;

export const VISIBILITY = Object.freeze({
  UNSPECIFIED: 0,
  PUBLIC: 1,
  PRIVATE: 2,
  SEALED: 3,
});

export const CIPHER_SUITE = Object.freeze({
  UNSPECIFIED: 0,
  NONE: 1,
  XWING_XCHACHA20_POLY1305: 2,
  LEGACY_X25519_XCHACHA20_POLY1305: 3,
});

export const SIGNATURE_ALGORITHM = Object.freeze({
  UNSPECIFIED: 0,
  ML_DSA_65: 1,
});

export const BODY_ENCODING = Object.freeze({
  UNSPECIFIED: 0,
  PROTOBUF: 1,
  CANONICAL_JSON: 2,
  RAW_UTF8: 3,
  RAW_BYTES: 4,
});

export const PAYMENT_LANE = Object.freeze({
  UNSPECIFIED: 0,
  FASTPAY: 1,
  CONSENSUS_PFT: 2,
  CONSENSUS_ISSUED: 3,
});

export const SCHEMA_ID = Object.freeze({
  CUSTOM: 1,
  MESSAGE_TEXT_V1: 100,
  REWARD_V1: 201,
  NFT_METADATA_V1: 400,
  NFT_CLAIM_V1: 401,
  X402_REQUEST_V1: 402,
  NFT_PROVENANCE_V1: 403,
});

export function addressFromPublicKey(publicKey) {
  const digest = createHash("sha3-384")
    .update(Buffer.from(ADDRESS_DERIVATION_DOMAIN, "utf8"))
    .update(Buffer.from([0]))
    .update(toBytes(publicKey))
    .digest();
  return `${ADDRESS_PREFIX}${digest.subarray(0, 20).toString("hex")}`;
}

export function validatePointerFlags(flags) {
  const mask = Number(flags || 0);
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~ALLOWED_POINTER_FLAG_MASK) !== 0) {
    throw new Error("pointer_flags_unsupported_bits");
  }
  const visBits = mask & VISIBILITY_FLAG_MASK;
  const count =
    ((visBits & POINTER_FLAG.PRIVATE) ? 1 : 0) +
    ((visBits & POINTER_FLAG.PUBLIC) ? 1 : 0) +
    ((visBits & POINTER_FLAG.SEALED) ? 1 : 0);
  if (count !== 1) {
    throw new Error("pointer_flags_must_set_exact_one_visibility_bit");
  }
  return mask;
}

export function encodePointerV5({
  cidBin = null,
  cid_bin = null,
  cidMultibase = "",
  target = POINTER_TARGET.CONTENT_BLOB,
  kind = CONTENT_KIND.UNSPECIFIED,
  schema = 0,
  taskId = "",
  task_id = "",
  threadId = "",
  thread_id = "",
  contextId = "",
  context_id = "",
  flags = 0,
  inlinePayload = null,
  inline_payload = null,
  schemaName = "",
  schema_name = "",
} = {}) {
  const validFlags = validatePointerFlags(flags);
  const resolvedTarget = Number(target || 0);
  const resolvedCidBin = cidBin
    ? toBytes(cidBin)
    : cid_bin
      ? toBytes(cid_bin)
      : cidMultibase
        ? cidMultibaseToBin(cidMultibase)
        : Buffer.alloc(0);
  const resolvedInline = inlinePayload
    ? toBytes(inlinePayload)
    : inline_payload
      ? toBytes(inline_payload)
      : Buffer.alloc(0);

  if (resolvedTarget === POINTER_TARGET.INLINE) {
    if (resolvedCidBin.length > 0) throw new Error("pointer_inline_must_omit_cid_bin");
    if (resolvedInline.length === 0) throw new Error("pointer_inline_requires_payload");
  } else if (resolvedTarget === POINTER_TARGET.CONTENT_BLOB || resolvedTarget === POINTER_TARGET.MANIFEST) {
    if (resolvedCidBin.length !== 36) throw new Error("pointer_requires_36_byte_cid_bin");
    if (resolvedInline.length > 0) throw new Error("pointer_blob_must_omit_inline_payload");
  } else {
    throw new Error("pointer_invalid_target");
  }

  const resolvedSchema = Number(schema || 0);
  const resolvedSchemaName = String(schemaName || schema_name || "");
  if (resolvedSchema === SCHEMA_ID.CUSTOM && !resolvedSchemaName) {
    throw new Error("pointer_custom_schema_requires_schema_name");
  }

  const encoded = Buffer.concat([
    pbBytes(1, resolvedCidBin),
    pbVarint(2, resolvedTarget),
    pbVarint(3, Number(kind || 0)),
    pbVarint(4, resolvedSchema),
    pbString(5, taskId || task_id),
    pbString(6, threadId || thread_id),
    pbString(7, contextId || context_id),
    pbVarint(8, validFlags),
    pbBytes(9, resolvedInline),
    pbString(10, resolvedSchemaName),
  ]);

  if (encoded.length > MAX_PAYMENT_MEMO_DATA_BYTES) {
    throw new Error(`pointer_v5_exceeds_256_bytes:${encoded.length}`);
  }
  return encoded;
}

export function decodePointerV5(bufOrHex) {
  const raw = toBytes(bufOrHex);
  if (raw.length > MAX_PAYMENT_MEMO_DATA_BYTES) throw new Error("pointer_v5_exceeds_256_bytes");
  const out = {
    version: "v5",
    cidBin: Buffer.alloc(0),
    cidBinHex: "",
    cid: "",
    target: 0,
    kind: 0,
    kindLabel: "UNSPECIFIED",
    schema: 0,
    taskId: "",
    threadId: "",
    contextId: "",
    flags: 0,
    inlinePayload: Buffer.alloc(0),
    schemaName: "",
  };
  for (const { fieldNum, value } of decodeWireFields(raw)) {
    if (fieldNum === 1) out.cidBin = Buffer.from(value);
    else if (fieldNum === 2) out.target = Number(value);
    else if (fieldNum === 3) out.kind = Number(value);
    else if (fieldNum === 4) out.schema = Number(value);
    else if (fieldNum === 5) out.taskId = value.toString("utf8");
    else if (fieldNum === 6) out.threadId = value.toString("utf8");
    else if (fieldNum === 7) out.contextId = value.toString("utf8");
    else if (fieldNum === 8) out.flags = Number(value);
    else if (fieldNum === 9) out.inlinePayload = Buffer.from(value);
    else if (fieldNum === 10) out.schemaName = value.toString("utf8");
  }
  if (!encodePointerV5(out).equals(raw)) throw new Error("noncanonical_pointer_v5");
  out.kindLabel = CONTENT_KIND_BY_VALUE[out.kind] || String(out.kind);
  out.cidBinHex = out.cidBin.toString("hex");
  if (out.cidBin.length === 36) out.cid = cidBinToMultibase(out.cidBin);
  out.visibility =
    (out.flags & POINTER_FLAG.PUBLIC)
      ? "public"
      : (out.flags & POINTER_FLAG.SEALED)
        ? "sealed"
        : "private";
  return out;
}

export function decodeLegacyPointerV4(bufOrHex) {
  const raw = toBytes(bufOrHex);
  const out = {
    version: "v4",
    cid: "",
    target: 0,
    kind: 0,
    kindLabel: "UNSPECIFIED",
    schema: 0,
    taskId: "",
    threadId: "",
    contextId: "",
    flags: 0,
  };
  for (const { fieldNum, value } of decodeWireFields(raw)) {
    if (fieldNum === 1) out.cid = value.toString("utf8");
    else if (fieldNum === 2) out.target = Number(value);
    else if (fieldNum === 3) out.kind = Number(value);
    else if (fieldNum === 4) out.schema = Number(value);
    else if (fieldNum === 5) out.taskId = value.toString("utf8");
    else if (fieldNum === 6) out.threadId = value.toString("utf8");
    else if (fieldNum === 7) out.contextId = value.toString("utf8");
    else if (fieldNum === 8) out.flags = Number(value);
  }
  out.kindLabel = CONTENT_KIND_BY_VALUE[out.kind] || String(out.kind);
  out.visibility = (out.flags & POINTER_FLAG.PUBLIC) ? "public" : "private";
  return out;
}

export function buildFastPayPointerMemo(pointerInput = {}) {
  const bytes = encodePointerV5(pointerInput);
  return {
    memo_type: POINTER_MEMO_TYPE_HEX,
    memo_format: POINTER_MEMO_FORMAT_V5_HEX,
    memo_data: bytes.toString("hex"),
    memo_type_text: POINTER_MEMO_TYPE,
    memo_format_text: POINTER_MEMO_FORMAT_V5,
    byteLength: bytes.length,
    pointer: decodePointerV5(bytes),
  };
}

function decodeHexTextSafe(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(text)) {
    return Buffer.from(text, "hex").toString("utf8");
  }
  return text;
}

export function decodeAnyPointerMemo(memo = {}) {
  const inner = memo?.Memo || memo || {};
  const typeText = inner.memo_type_text || decodeHexTextSafe(inner.memo_type || inner.MemoType || "");
  const formatText = inner.memo_format_text || decodeHexTextSafe(inner.memo_format || inner.MemoFormat || "");
  const dataHex = String(inner.memo_data || inner.MemoData || "").trim();
  if (typeText !== POINTER_MEMO_TYPE || !dataHex) return null;
  if (formatText === POINTER_MEMO_FORMAT_V5) return decodePointerV5(dataHex);
  if (formatText === POINTER_MEMO_FORMAT_V4) return decodeLegacyPointerV4(dataHex);
  return null;
}

function chainHashBytes(value) {
  if (value == null || value === "") return Buffer.alloc(0);
  if (typeof value === "string" && !/^[0-9a-f]{96}$/i.test(value)) throw new Error("invalid_chain_hash");
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("invalid_chain_hash");
  const bytes = toBytes(value);
  if (bytes.length && bytes.length !== 48) throw new Error("invalid_chain_hash");
  return bytes;
}

export function encodeFastPayPaymentRef(ref = null) {
  if (!ref) return Buffer.alloc(0);
  return Buffer.concat([
    pbVarint(1, ref.lane || 0),
    pbString(2, ref.chainId || ref.chain_id || ""),
    pbBytes(3, chainHashBytes(ref.orderHash || ref.order_hash)),
    pbBytes(4, chainHashBytes(ref.certificateDigest || ref.certificate_digest)),
    pbBytes(5, chainHashBytes(ref.txHash || ref.tx_hash)),
    pbString(6, ref.assetId || ref.asset_id || ""),
    pbString(7, ref.payerAccount || ref.payer_account || ""),
    pbString(8, ref.payeeAccount || ref.payee_account || ""),
    pbVarint(9, ref.amountAtoms ?? ref.amount_atoms ?? 0),
    pbVarint(10, ref.feeAtoms ?? ref.fee_atoms ?? 0),
    pbVarint(11, ref.finalizedHeight ?? ref.finalized_height ?? 0),
  ]);
}

export function decodeFastPayPaymentRef(buf) {
  const out = {
    lane: 0,
    chainId: "",
    orderHash: Buffer.alloc(0),
    certificateDigest: Buffer.alloc(0),
    txHash: Buffer.alloc(0),
    assetId: "",
    payerAccount: "",
    payeeAccount: "",
    amountAtoms: 0n,
    feeAtoms: 0n,
    finalizedHeight: 0n,
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.lane = Number(value);
    else if (fieldNum === 2) out.chainId = value.toString("utf8");
    else if (fieldNum === 3) out.orderHash = chainHashBytes(value);
    else if (fieldNum === 4) out.certificateDigest = chainHashBytes(value);
    else if (fieldNum === 5) out.txHash = chainHashBytes(value);
    else if (fieldNum === 6) out.assetId = value.toString("utf8");
    else if (fieldNum === 7) out.payerAccount = value.toString("utf8");
    else if (fieldNum === 8) out.payeeAccount = value.toString("utf8");
    else if (fieldNum === 9) out.amountAtoms = value;
    else if (fieldNum === 10) out.feeAtoms = value;
    else if (fieldNum === 11) out.finalizedHeight = value;
  }
  out.orderHashHex = out.orderHash.toString("hex");
  out.certificateDigestHex = out.certificateDigest.toString("hex");
  out.txHashHex = out.txHash.toString("hex");
  return out;
}

export function encodeMessageHeader(header = {}) {
  return Buffer.concat([
    pbVarint(1, header.protocolVersion ?? header.protocol_version ?? 1),
    pbString(2, header.chainId || header.chain_id || ""),
    pbString(3, header.schemaName || header.schema_name || ""),
    pbVarint(4, header.schemaId ?? header.schema_id ?? 0),
    pbVarint(5, header.kind ?? 0),
    pbVarint(6, header.visibility ?? 0),
    pbVarint(7, header.bodyEncoding ?? header.body_encoding ?? BODY_ENCODING.PROTOBUF),
    pbVarint(8, header.cipherSuite ?? header.cipher_suite ?? CIPHER_SUITE.NONE),
    pbString(9, header.senderAccount || header.sender_account || ""),
    pbVarint(10, header.createdAtUnixMs ?? header.created_at_unix_ms ?? 0),
    pbString(11, header.taskId || header.task_id || ""),
    pbString(12, header.threadId || header.thread_id || ""),
    pbString(13, header.contextId || header.context_id || ""),
    pbMsg(14, encodeIpfsCidRef(header.replyToCid || header.reply_to_cid)),
    pbMsg(15, encodeFastPayPaymentRef(header.paymentRef || header.payment_ref)),
  ]);
}

export function decodeMessageHeader(buf) {
  const out = {
    protocolVersion: 0,
    chainId: "",
    schemaName: "",
    schemaId: 0,
    kind: 0,
    visibility: 0,
    bodyEncoding: 0,
    cipherSuite: 0,
    senderAccount: "",
    createdAtUnixMs: 0,
    taskId: "",
    threadId: "",
    contextId: "",
    replyToCid: null,
    paymentRef: null,
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.protocolVersion = Number(value);
    else if (fieldNum === 2) out.chainId = value.toString("utf8");
    else if (fieldNum === 3) out.schemaName = value.toString("utf8");
    else if (fieldNum === 4) out.schemaId = Number(value);
    else if (fieldNum === 5) out.kind = Number(value);
    else if (fieldNum === 6) out.visibility = Number(value);
    else if (fieldNum === 7) out.bodyEncoding = Number(value);
    else if (fieldNum === 8) out.cipherSuite = Number(value);
    else if (fieldNum === 9) out.senderAccount = value.toString("utf8");
    else if (fieldNum === 10) out.createdAtUnixMs = Number(value);
    else if (fieldNum === 11) out.taskId = value.toString("utf8");
    else if (fieldNum === 12) out.threadId = value.toString("utf8");
    else if (fieldNum === 13) out.contextId = value.toString("utf8");
    else if (fieldNum === 14) out.replyToCid = decodeIpfsCidRef(value);
    else if (fieldNum === 15) out.paymentRef = decodeFastPayPaymentRef(value);
  }
  return out;
}

export function encodeRecipientWrap(wrap = {}) {
  return Buffer.concat([
    pbBytes(1, wrap.recipientKeyId || wrap.recipient_key_id),
    pbString(2, wrap.recipientAccount || wrap.recipient_account || ""),
    pbBytes(3, wrap.xwingCiphertext || wrap.xwing_ciphertext),
    pbBytes(4, wrap.wrapNonce || wrap.wrap_nonce),
    pbBytes(5, wrap.wrappedCek || wrap.wrapped_cek),
  ]);
}

export function decodeRecipientWrap(buf) {
  const out = {
    recipientKeyId: Buffer.alloc(0),
    recipientAccount: "",
    xwingCiphertext: Buffer.alloc(0),
    wrapNonce: Buffer.alloc(0),
    wrappedCek: Buffer.alloc(0),
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.recipientKeyId = Buffer.from(value);
    else if (fieldNum === 2) out.recipientAccount = value.toString("utf8");
    else if (fieldNum === 3) out.xwingCiphertext = Buffer.from(value);
    else if (fieldNum === 4) out.wrapNonce = Buffer.from(value);
    else if (fieldNum === 5) out.wrappedCek = Buffer.from(value);
  }
  return out;
}

export function encodeXWingEncryptionHeader(header = {}) {
  const sorted = [...(header.recipients || [])].sort((a, b) =>
    Buffer.compare(toBytes(a.recipientKeyId || a.recipient_key_id), toBytes(b.recipientKeyId || b.recipient_key_id))
  );
  return Buffer.concat([
    pbVarint(1, header.cipherSuite ?? header.cipher_suite ?? CIPHER_SUITE.XWING_XCHACHA20_POLY1305),
    pbBytes(2, header.aeadNonce || header.aead_nonce),
    pbBytes(3, header.aadContext || header.aad_context),
    pbVarint(4, header.chunkIndex ?? header.chunk_index ?? 0),
    pbString(5, header.kdfInfo || header.kdf_info || DOMAIN_XWING_WRAP_INFO),
    ...sorted.map((wrap) => pbMsg(6, encodeRecipientWrap(wrap))),
    pbBytes(7, header.cekCommitment || header.cek_commitment),
  ]);
}

export function decodeXWingEncryptionHeader(buf) {
  const out = {
    cipherSuite: 0,
    aeadNonce: Buffer.alloc(0),
    aadContext: Buffer.alloc(0),
    chunkIndex: 0,
    kdfInfo: "",
    recipients: [],
    cekCommitment: Buffer.alloc(0),
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.cipherSuite = Number(value);
    else if (fieldNum === 2) out.aeadNonce = Buffer.from(value);
    else if (fieldNum === 3) out.aadContext = Buffer.from(value);
    else if (fieldNum === 4) out.chunkIndex = Number(value);
    else if (fieldNum === 5) out.kdfInfo = value.toString("utf8");
    else if (fieldNum === 6) out.recipients.push(decodeRecipientWrap(value));
    else if (fieldNum === 7) out.cekCommitment = Buffer.from(value);
  }
  return out;
}

export function encodeRewardNotice(notice = {}) {
  return Buffer.concat([
    pbString(1, notice.rewardId || notice.reward_id || ""),
    pbString(2, notice.taskId || notice.task_id || ""),
    pbString(3, notice.recipientAccount || notice.recipient_account || ""),
    pbVarint(4, notice.amountAtoms ?? notice.amount_atoms ?? 0),
    pbString(5, notice.assetId || notice.asset_id || "PFT"),
    pbString(6, notice.summary || ""),
    pbMsg(7, encodeFastPayPaymentRef(notice.paymentRef || notice.payment_ref)),
  ]);
}

export function decodeRewardNotice(buf) {
  const out = {
    rewardId: "",
    taskId: "",
    recipientAccount: "",
    amountAtoms: 0n,
    assetId: "",
    summary: "",
    paymentRef: null,
  };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.rewardId = value.toString("utf8");
    else if (fieldNum === 2) out.taskId = value.toString("utf8");
    else if (fieldNum === 3) out.recipientAccount = value.toString("utf8");
    else if (fieldNum === 4) out.amountAtoms = value;
    else if (fieldNum === 5) out.assetId = value.toString("utf8");
    else if (fieldNum === 6) out.summary = value.toString("utf8");
    else if (fieldNum === 7) out.paymentRef = decodeFastPayPaymentRef(value);
  }
  return out;
}

export function encodeEnvelope({
  version = 1,
  headerBytes,
  encryptionHeaderBytes = Buffer.alloc(0),
  bodyBytes = Buffer.alloc(0),
  signatureAlgorithm = SIGNATURE_ALGORITHM.ML_DSA_65,
  senderPubkey,
  signature,
} = {}) {
  const raw = Buffer.concat([
    pbVarint(1, version),
    pbBytes(2, headerBytes),
    pbBytes(3, encryptionHeaderBytes),
    pbBytes(4, bodyBytes),
    pbVarint(5, signatureAlgorithm),
    pbBytes(6, senderPubkey),
    pbBytes(7, signature),
  ]);
  if (raw.length > MAX_SINGLE_ENVELOPE_BYTES) {
    throw new Error(`envelope_exceeds_1mib:${raw.length}`);
  }
  return raw;
}

export function decodeEnvelopeRaw(bufOrHex) {
  const raw = toBytes(bufOrHex);
  if (raw.length > MAX_SINGLE_ENVELOPE_BYTES) throw new Error("envelope_too_large");
  const out = {
    version: 0,
    headerBytes: Buffer.alloc(0),
    encryptionHeaderBytes: Buffer.alloc(0),
    bodyBytes: Buffer.alloc(0),
    signatureAlgorithm: 0,
    senderPubkey: Buffer.alloc(0),
    signature: Buffer.alloc(0),
  };
  for (const { fieldNum, value } of decodeWireFields(raw)) {
    if (fieldNum === 1) out.version = Number(value);
    else if (fieldNum === 2) out.headerBytes = Buffer.from(value);
    else if (fieldNum === 3) out.encryptionHeaderBytes = Buffer.from(value);
    else if (fieldNum === 4) out.bodyBytes = Buffer.from(value);
    else if (fieldNum === 5) out.signatureAlgorithm = Number(value);
    else if (fieldNum === 6) out.senderPubkey = Buffer.from(value);
    else if (fieldNum === 7) out.signature = Buffer.from(value);
    else throw new Error("unknown_envelope_field");
  }
  return out;
}

function u32be(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(Number(n) >>> 0, 0);
  return buf;
}

// Raw-byte signing preimage (Zero Re-Serialization Rule, Contract C1 Section 4.1).
export function envelopeSigningPreimage({
  version = 1,
  headerBytes,
  encryptionHeaderBytes = Buffer.alloc(0),
  bodyBytes = Buffer.alloc(0),
} = {}) {
  const h = toBytes(headerBytes);
  const e = toBytes(encryptionHeaderBytes);
  const b = toBytes(bodyBytes);
  return Buffer.concat([
    Buffer.from(`${DOMAIN_ENVELOPE_SIGN}\0`, "utf8"),
    u32be(version),
    u32be(h.length),
    h,
    u32be(e.length),
    e,
    u32be(b.length),
    b,
  ]);
}

export function computeMessageAadContext({ chainId, headerBytes, chunkIndex = 0 }) {
  return sha256Bytes(
    Buffer.concat([
      Buffer.from(`${DOMAIN_MESSAGE_AAD}\0`, "utf8"),
      Buffer.from(`${String(chainId || "")}\0`, "utf8"),
      sha256Bytes(toBytes(headerBytes)),
      u32be(chunkIndex),
    ])
  );
}

export function deriveMessageKemSeed({ masterEntropy, chainId }) {
  return hkdfSha256({
    ikm: toBytes(masterEntropy),
    salt: Buffer.from(String(chainId || ""), "utf8"),
    info: Buffer.from(DOMAIN_MESSAGE_KEY_KDF, "utf8"),
    length: 32,
  });
}

export function generateMlDsa65Keypair(seed = null) {
  const kp = seed ? ml_dsa65.keygen(toBytes(seed)) : ml_dsa65.keygen();
  const publicKey = Buffer.from(kp.publicKey);
  const secretKey = Buffer.from(kp.secretKey);
  return {
    publicKey,
    secretKey,
    publicKeyHex: publicKey.toString("hex"),
    account: addressFromPublicKey(publicKey),
  };
}

export function generateXWingKeypair(seed = null) {
  const kp = seed ? ml_kem768_x25519.keygen(toBytes(seed)) : ml_kem768_x25519.keygen();
  const publicKey = Buffer.from(kp.publicKey);
  const secretKey = Buffer.from(kp.secretKey);
  const keyId = sha256Bytes(publicKey);
  return {
    publicKey,
    secretKey,
    keyId,
    keyIdHex: keyId.toString("hex"),
  };
}

export function signEnvelopeMlDsa65({
  version = 1,
  headerBytes,
  encryptionHeaderBytes = Buffer.alloc(0),
  bodyBytes = Buffer.alloc(0),
  publicKey,
  secretKey,
} = {}) {
  const preimage = envelopeSigningPreimage({ version, headerBytes, encryptionHeaderBytes, bodyBytes });
  const signature = Buffer.from(ml_dsa65.sign(preimage, toBytes(secretKey)));
  const rawEnvelopeBytes = encodeEnvelope({
    version,
    headerBytes,
    encryptionHeaderBytes,
    bodyBytes,
    signatureAlgorithm: SIGNATURE_ALGORITHM.ML_DSA_65,
    senderPubkey: toBytes(publicKey),
    signature,
  });
  return {
    rawEnvelopeBytes,
    signature,
    cid: computeRawCidV1(rawEnvelopeBytes),
    metadataHashSha3_384: sha3_384Bytes(rawEnvelopeBytes).toString("hex"),
  };
}

// Verifies CID / metadata_hash and ML-DSA-65 signature over exact raw bytes BEFORE decoding.
export function verifyEnvelopeRaw(
  rawEnvelopeBytes,
  { expectedCidBin = null, expectedMetadataHashSha3_384 = "", expectedChainId = "", expectedSenderAccount = "", expectedSenderPubkeyHex = "" } = {}
) {
  const raw = toBytes(rawEnvelopeBytes);
  if (raw.length > MAX_SINGLE_ENVELOPE_BYTES) return { ok: false, reason: "envelope_too_large" };
  const cid = computeRawCidV1(raw);
  const metadataHashSha3_384 = sha3_384Bytes(raw).toString("hex");
  if (expectedCidBin && Buffer.compare(cid.cidBin, toBytes(expectedCidBin)) !== 0) {
    return { ok: false, reason: "cid_mismatch", cid, metadataHashSha3_384 };
  }
  if (expectedMetadataHashSha3_384 && metadataHashSha3_384 !== String(expectedMetadataHashSha3_384).toLowerCase()) {
    return { ok: false, reason: "metadata_hash_mismatch", cid, metadataHashSha3_384 };
  }
  let envelope;
  try {
    envelope = decodeEnvelopeRaw(raw);
  } catch (error) {
    return { ok: false, reason: error?.message || "envelope_decode_failed", cid, metadataHashSha3_384 };
  }
  if (envelope.version !== 1 || envelope.signatureAlgorithm !== SIGNATURE_ALGORITHM.ML_DSA_65) {
    return { ok: false, reason: "unsupported_envelope_version_or_algorithm", cid, metadataHashSha3_384 };
  }
  const derivedAccount = addressFromPublicKey(envelope.senderPubkey);
  const senderPubkeyHex = envelope.senderPubkey.toString("hex");
  if (expectedSenderAccount && derivedAccount !== expectedSenderAccount) {
    return { ok: false, reason: "sender_account_mismatch", derivedAccount, senderPubkeyHex, cid, metadataHashSha3_384 };
  }
  if (expectedSenderPubkeyHex && senderPubkeyHex !== String(expectedSenderPubkeyHex).toLowerCase()) {
    return { ok: false, reason: "sender_pubkey_mismatch", derivedAccount, senderPubkeyHex, cid, metadataHashSha3_384 };
  }
  const preimage = envelopeSigningPreimage({
    version: envelope.version,
    headerBytes: envelope.headerBytes,
    encryptionHeaderBytes: envelope.encryptionHeaderBytes,
    bodyBytes: envelope.bodyBytes,
  });
  let sigValid = false;
  try {
    sigValid = ml_dsa65.verify(envelope.signature, preimage, envelope.senderPubkey);
  } catch {
    sigValid = false;
  }
  if (!sigValid) {
    return { ok: false, reason: "invalid_ml_dsa_65_signature", derivedAccount, senderPubkeyHex, cid, metadataHashSha3_384 };
  }
  const header = decodeMessageHeader(envelope.headerBytes);
  if (expectedChainId && expectedChainId !== header.chainId) return { ok: false, reason: "chain_id_mismatch" };
  if (header.senderAccount !== derivedAccount) {
    return { ok: false, reason: "header_sender_account_mismatch", derivedAccount, senderPubkeyHex, header, cid, metadataHashSha3_384 };
  }
  return {
    ok: true,
    envelope,
    header,
    derivedAccount,
    senderPubkeyHex,
    cid,
    metadataHashSha3_384,
  };
}

export async function encryptPrivateEnvelope({
  header,
  plaintextBodyBytes,
  recipients = [],
  signerPublicKey,
  signerSecretKey,
} = {}) {
  await sodium.ready;
  const headerBytes = encodeMessageHeader({
    ...header,
    visibility: header.visibility || VISIBILITY.PRIVATE,
    cipherSuite: CIPHER_SUITE.XWING_XCHACHA20_POLY1305,
  });
  const aadContext = computeMessageAadContext({
    chainId: header.chainId || header.chain_id || "",
    headerBytes,
    chunkIndex: 0,
  });
  const cek = randomBytes(32);
  const aeadNonce = randomBytes(24);
  const ciphertext = Buffer.from(
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      toBytes(plaintextBodyBytes),
      aadContext,
      null,
      aeadNonce,
      cek
    )
  );

  const wraps = [];
  for (const recipient of recipients) {
    const pub = toBytes(recipient.xwingPublicKey || recipient.publicKey);
    const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(pub);
    const keyId = header.visibility === VISIBILITY.SEALED
      ? sha256Bytes(Buffer.concat([SEALED_TAG_PREFIX, sharedSecret, aadContext]))
      : sha256Bytes(pub);
    const kek = hkdfSha256({
      ikm: Buffer.from(sharedSecret),
      salt: aadContext,
      info: Buffer.concat([Buffer.from(`${DOMAIN_XWING_WRAP_INFO}\0`, "utf8"), keyId]),
      length: 32,
    });
    const wrapNonce = randomBytes(24);
    const wrappedCek = Buffer.from(
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cek, aadContext, null, wrapNonce, kek)
    );
    wraps.push({
      recipientKeyId: keyId,
      recipientAccount: header.visibility === VISIBILITY.SEALED ? "" : String(recipient.account || ""),
      xwingCiphertext: Buffer.from(cipherText),
      wrapNonce,
      wrappedCek,
    });
  }

  const encryptionHeaderBytes = encodeXWingEncryptionHeader({
    cipherSuite: CIPHER_SUITE.XWING_XCHACHA20_POLY1305,
    aeadNonce,
    aadContext,
    chunkIndex: 0,
    kdfInfo: DOMAIN_XWING_WRAP_INFO,
    recipients: wraps,
    cekCommitment: sha256Bytes(Buffer.concat([CEK_COMMIT_PREFIX, cek, aadContext])),
  });

  return signEnvelopeMlDsa65({
    version: 1,
    headerBytes,
    encryptionHeaderBytes,
    bodyBytes: ciphertext,
    publicKey: signerPublicKey,
    secretKey: signerSecretKey,
  });
}

export async function decryptPrivateEnvelope({ rawEnvelopeBytes, recipientXWingSecretKey, recipientXWingPublicKey, expectedChainId, expectedSenderAccount, expectedCidBin } = {}) {
  const verified = verifyEnvelopeRaw(rawEnvelopeBytes, { expectedChainId, expectedSenderAccount, expectedCidBin });
  if (!verified.ok) throw new Error(`envelope_verification_failed:${verified.reason}`);
  await sodium.ready;
  const encHeader = decodeXWingEncryptionHeader(verified.envelope.encryptionHeaderBytes);
  const expectedAad = computeMessageAadContext({
    chainId: verified.header.chainId,
    headerBytes: verified.envelope.headerBytes,
    chunkIndex: encHeader.chunkIndex,
  });
  if (Buffer.compare(expectedAad, encHeader.aadContext) !== 0) {
    throw new Error("envelope_aad_context_mismatch");
  }
  const targetKeyId = sha256Bytes(toBytes(recipientXWingPublicKey));
  const secretKey = toBytes(recipientXWingSecretKey);
  let wrap = encHeader.recipients.find((entry) => entry.recipientKeyId.equals(targetKeyId));
  let sharedSecret;
  if (wrap) {
    sharedSecret = ml_kem768_x25519.decapsulate(wrap.xwingCiphertext, secretKey);
  } else if (verified.header.visibility === VISIBILITY.SEALED) {
    for (const entry of encHeader.recipients) {
      if (entry.recipientKeyId.length !== 32 || entry.xwingCiphertext.length !== 1120) continue;
      const candidate = ml_kem768_x25519.decapsulate(entry.xwingCiphertext, secretKey);
      const tag = sha256Bytes(Buffer.concat([SEALED_TAG_PREFIX, candidate, expectedAad]));
      if (timingSafeEqual(tag, entry.recipientKeyId)) {
        wrap = entry;
        sharedSecret = candidate;
        break;
      }
    }
  }
  if (!wrap) throw new Error("envelope_recipient_wrap_not_found");
  const kek = hkdfSha256({
    ikm: Buffer.from(sharedSecret),
    salt: encHeader.aadContext,
    info: Buffer.concat([Buffer.from(`${encHeader.kdfInfo || DOMAIN_XWING_WRAP_INFO}\0`, "utf8"), wrap.recipientKeyId]),
    length: 32,
  });
  const cek = Buffer.from(
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrap.wrappedCek, encHeader.aadContext, wrap.wrapNonce, kek)
  );
  if (encHeader.cekCommitment.length) {
    const expected = sha256Bytes(Buffer.concat([CEK_COMMIT_PREFIX, cek, expectedAad]));
    if (encHeader.cekCommitment.length !== expected.length || !timingSafeEqual(expected, encHeader.cekCommitment)) {
      throw new Error("envelope_cek_commitment_mismatch");
    }
  }
  const plaintextBytes = Buffer.from(
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      verified.envelope.bodyBytes,
      encHeader.aadContext,
      encHeader.aeadNonce,
      cek
    )
  );
  return { verified, plaintextBytes };
}
