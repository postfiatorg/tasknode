const textEncoder = new TextEncoder();

export const POINTER_MEMO_TYPE = "pf.ptr";
export const POINTER_MEMO_FORMAT = "v4";
export const POINTER_FLAGS = Object.freeze({
  encrypted: 0x01,
  public: 0x02,
  ephemeral: 0x04,
  tombstone: 0x08,
  multipart: 0x10,
});

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
  TEST: 99,
});

const TARGETS = Object.freeze({
  CONTENT_BLOB: 1,
  TARGET_CONTENT_BLOB: 1,
});

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function utf8Hex(value) {
  return bytesToHex(textEncoder.encode(String(value || "")));
}

function varintBytes(value) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw new Error("Invalid pointer varint");
  }

  const bytes = [];
  while (number > 0x7f) {
    bytes.push((number & 0x7f) | 0x80);
    number >>>= 7;
  }
  bytes.push(number);
  return bytes;
}

function fieldKey(fieldNumber, wireType) {
  return varintBytes((fieldNumber << 3) | wireType);
}

function fieldVarint(fieldNumber, value) {
  if (value === undefined || value === null || value === "") return [];
  return [...fieldKey(fieldNumber, 0), ...varintBytes(value)];
}

function fieldString(fieldNumber, value) {
  const text = String(value || "");
  if (!text) return [];
  const bytes = Array.from(textEncoder.encode(text));
  return [...fieldKey(fieldNumber, 2), ...varintBytes(bytes.length), ...bytes];
}

function normalizeEnumValue(value, values, fallback = null) {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) throw new Error("Missing enum value");
    return fallback;
  }
  if (typeof value === "number") {
    if (Object.values(values).includes(value)) return value;
    throw new Error("Invalid enum value");
  }

  const key = String(value)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^CONTENT_KIND_/, "")
    .replace(/^TARGET_/, "");
  if (values[key] !== undefined) return values[key];
  if (values[`CONTENT_KIND_${key}`] !== undefined) return values[`CONTENT_KIND_${key}`];
  if (values[`TARGET_${key}`] !== undefined) return values[`TARGET_${key}`];
  throw new Error(`Unknown enum value: ${value}`);
}

function normalizeFlags(input) {
  if (input === undefined || input === null || input === "") return POINTER_FLAGS.encrypted;
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) throw new Error("Invalid pointer flags");
    return input;
  }
  if (Array.isArray(input)) {
    return input.reduce((acc, entry) => acc | normalizeFlags(entry), 0);
  }
  const raw = String(input).trim();
  if (!raw) return POINTER_FLAGS.encrypted;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .reduce((acc, entry) => acc | (POINTER_FLAGS[entry] || 0), 0);
}

function normalizeSchema(value) {
  const schema = Number(value);
  if (!Number.isInteger(schema) || schema <= 0) throw new Error("Invalid pointer schema");
  return schema;
}

export function buildPftPointerPayload({
  cid,
  kind,
  schema,
  target = "CONTENT_BLOB",
  flags = POINTER_FLAGS.encrypted,
  taskId,
  task_id: taskIdSnake,
  threadId,
  thread_id: threadIdSnake,
  contextId,
  context_id: contextIdSnake,
} = {}) {
  const normalizedCid = String(cid || "").trim().replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "");
  if (!normalizedCid) throw new Error("Missing CID");

  const normalizedKind = normalizeEnumValue(kind, CONTENT_KIND, CONTENT_KIND.UNSPECIFIED);
  if (normalizedKind === CONTENT_KIND.UNSPECIFIED) throw new Error("Content kind required");

  return {
    cid: normalizedCid,
    target: normalizeEnumValue(target, TARGETS, TARGETS.CONTENT_BLOB),
    kind: normalizedKind,
    schema: normalizeSchema(schema),
    flags: normalizeFlags(flags),
    taskId: String(taskId || taskIdSnake || "").trim() || null,
    threadId: String(threadId || threadIdSnake || "").trim() || null,
    contextId: String(contextId || contextIdSnake || "").trim() || null,
  };
}

export function buildPftPointerMemo(input = {}) {
  const payload = buildPftPointerPayload(input);
  const bytes = [
    ...fieldString(1, payload.cid),
    ...fieldVarint(2, payload.target),
    ...fieldVarint(3, payload.kind),
    ...fieldVarint(4, payload.schema),
    ...fieldString(5, payload.taskId),
    ...fieldString(6, payload.threadId),
    ...fieldString(7, payload.contextId),
    ...fieldVarint(8, payload.flags),
  ];

  return {
    payload,
    memoTypeHex: utf8Hex(POINTER_MEMO_TYPE),
    memoFormatHex: utf8Hex(POINTER_MEMO_FORMAT),
    memoDataHex: bytesToHex(bytes),
  };
}
