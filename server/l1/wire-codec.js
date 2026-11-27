import { createHash, createHmac } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE32_LOOKUP = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((ch, idx) => [ch, idx]))
);

export function toBytes(input) {
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") {
    const clean = input.trim();
    if (!clean) return Buffer.alloc(0);
    if (clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(clean, "hex");
    return Buffer.from(clean, "utf8");
  }
  return Buffer.alloc(0);
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(toBytes(bytes)).digest();
}

export function sha3_384Bytes(bytes) {
  return createHash("sha3-384").update(toBytes(bytes)).digest();
}

export function hashHexDomain(domain, bytes) {
  return createHash("sha3-384")
    .update(Buffer.from(String(domain), "utf8"))
    .update(Buffer.from([0]))
    .update(toBytes(bytes))
    .digest("hex");
}

export function hkdfSha256({ ikm, salt, info, length = 32 }) {
  const saltBytes = salt && salt.length ? toBytes(salt) : Buffer.alloc(32);
  const prk = createHmac("sha256", saltBytes).update(toBytes(ikm)).digest();
  const infoBytes = toBytes(info || Buffer.alloc(0));
  const okm = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  while (okm.length * 32 < length) {
    prev = createHmac("sha256", prk)
      .update(Buffer.concat([prev, infoBytes, Buffer.from([counter])]))
      .digest();
    okm.push(prev);
    counter += 1;
  }
  return Buffer.concat(okm).subarray(0, length);
}

export function base32LowerEncode(bytes) {
  const buf = toBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32LowerDecode(text) {
  const clean = String(text || "").trim().toLowerCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_LOOKUP[ch];
    if (idx === undefined) throw new Error("invalid_base32_character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function computeRawCidV1(blockBytes) {
  const raw = toBytes(blockBytes);
  const digest = sha256Bytes(raw);
  const cidBin = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const multibaseCid = `b${base32LowerEncode(cidBin)}`;
  return {
    cidBin,
    cidBinHex: cidBin.toString("hex"),
    multibaseCid,
    byteLength: raw.length,
    sha256Hex: digest.toString("hex"),
  };
}

export function cidBinToMultibase(cidBin) {
  const raw = toBytes(cidBin);
  if (raw.length !== 36 || raw[0] !== 0x01 || raw[1] !== 0x55 || raw[2] !== 0x12 || raw[3] !== 0x20) {
    throw new Error("invalid_cidv1_raw_binary");
  }
  return `b${base32LowerEncode(raw)}`;
}

export function cidMultibaseToBin(multibase) {
  const clean = String(multibase || "").trim().replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "");
  if (!clean.startsWith("b")) throw new Error("unsupported_cid_multibase_prefix");
  const bin = base32LowerDecode(clean.slice(1));
  if (bin.length !== 36 || bin[0] !== 0x01 || bin[1] !== 0x55 || bin[2] !== 0x12 || bin[3] !== 0x20) {
    throw new Error("invalid_cidv1_raw_multibase");
  }
  return bin;
}

export function encodeVarint(value) {
  let n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error(`negative_varint:${n.toString()}`);
  const out = [];
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

export function decodeVarint(buf, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) throw new Error("truncated_varint");
    const byte = buf[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: pos };
    shift += 7n;
    if (shift > 63n) throw new Error("varint_overflow");
  }
}

function pbTag(fieldNum, wireType) {
  return encodeVarint((BigInt(fieldNum) << 3n) | BigInt(wireType));
}

export function pbVarint(fieldNum, value) {
  if (value === undefined || value === null || value === "") return Buffer.alloc(0);
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n === 0n) return Buffer.alloc(0);
  return Buffer.concat([pbTag(fieldNum, 0), encodeVarint(n)]);
}

export function pbBool(fieldNum, value) {
  return value ? pbVarint(fieldNum, 1n) : Buffer.alloc(0);
}

export function pbBytes(fieldNum, bytes) {
  if (!bytes || !bytes.length) return Buffer.alloc(0);
  const raw = toBytes(bytes);
  if (!raw.length) return Buffer.alloc(0);
  return Buffer.concat([pbTag(fieldNum, 2), encodeVarint(raw.length), raw]);
}

export function pbString(fieldNum, value) {
  const text = String(value ?? "");
  if (!text) return Buffer.alloc(0);
  return pbBytes(fieldNum, Buffer.from(text, "utf8"));
}

export function pbMsg(fieldNum, encoded) {
  return pbBytes(fieldNum, encoded);
}

export function pbMapStringString(fieldNum, mapObj = {}) {
  const entries = Object.entries(mapObj || {}).filter(([, v]) => v !== undefined && v !== null);
  entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return Buffer.concat(
    entries.map(([k, v]) => pbMsg(fieldNum, Buffer.concat([pbString(1, k), pbString(2, String(v))])))
  );
}

export function decodeWireFields(buf) {
  const raw = toBytes(buf);
  const fields = [];
  let offset = 0;
  while (offset < raw.length) {
    const tag = decodeVarint(raw, offset);
    offset = tag.offset;
    const fieldNum = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNum === 0) throw new Error("invalid_protobuf_field_0");
    if (wireType === 0) {
      const val = decodeVarint(raw, offset);
      offset = val.offset;
      fields.push({ fieldNum, wireType, value: val.value });
    } else if (wireType === 2) {
      const len = decodeVarint(raw, offset);
      offset = len.offset;
      const byteLen = Number(len.value);
      if (offset + byteLen > raw.length) throw new Error("truncated_length_delimited_field");
      fields.push({ fieldNum, wireType, value: raw.subarray(offset, offset + byteLen) });
      offset += byteLen;
    } else if (wireType === 1) {
      if (offset + 8 > raw.length) throw new Error("truncated_fixed64");
      fields.push({ fieldNum, wireType, value: raw.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > raw.length) throw new Error("truncated_fixed32");
      fields.push({ fieldNum, wireType, value: raw.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported_wire_type:${wireType}`);
    }
  }
  return fields;
}

export function encodeIpfsCidRef(ref = null) {
  if (!ref) return Buffer.alloc(0);
  const cidBin = ref.cidBin ? toBytes(ref.cidBin) : ref.cid_bin ? toBytes(ref.cid_bin) : Buffer.alloc(0);
  const byteLength = ref.byteLength ?? ref.byte_length ?? 0;
  const multibaseCid = ref.multibaseCid ?? ref.multibase_cid ?? "";
  return Buffer.concat([
    pbBytes(1, cidBin),
    pbVarint(2, byteLength),
    pbString(3, multibaseCid),
  ]);
}

export function decodeIpfsCidRef(buf) {
  const out = { cidBin: Buffer.alloc(0), byteLength: 0, multibaseCid: "" };
  for (const { fieldNum, value } of decodeWireFields(buf)) {
    if (fieldNum === 1) out.cidBin = Buffer.from(value);
    else if (fieldNum === 2) out.byteLength = Number(value);
    else if (fieldNum === 3) out.multibaseCid = value.toString("utf8");
  }
  out.cidBinHex = out.cidBin.toString("hex");
  return out;
}
