// RFC 8785 (JCS) deterministic canonical JSON serialization for governance artifacts
// and cryptographic domain payloads (browser + Node compatible).

function canonicalizeValue(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) {
      const error = new Error("CANONICAL_JSON_NON_FINITE_NUMBER");
      error.code = "CANONICAL_JSON_NON_FINITE_NUMBER";
      throw error;
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalizeValue(item))).join(",")}]`;
  }
  if (type === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const entries = [];
    for (const key of keys) {
      entries.push(`${JSON.stringify(key)}:${canonicalizeValue(value[key])}`);
    }
    return `{${entries.join(",")}}`;
  }
  const error = new Error(`CANONICAL_JSON_UNSUPPORTED_TYPE:${type}`);
  error.code = "CANONICAL_JSON_UNSUPPORTED_TYPE";
  throw error;
}

export function canonicalJson(value) {
  if (value === undefined) return "null";
  return canonicalizeValue(value);
}

export async function sha256HexAsync(input) {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input || 0);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalJsonSha256HexAsync(value) {
  return sha256HexAsync(canonicalJson(value));
}
