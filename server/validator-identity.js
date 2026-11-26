import { randomBytes } from "node:crypto";
import { decodeNodePublic } from "ripple-address-codec";
import { verify } from "ripple-keypairs";
import { decode, encode } from "ripple-binary-codec";

export const VHS_ORIGINS = Object.freeze({
  devnet: "https://vhs.devnet.postfiat.org",
  testnet: "https://vhs.testnet.postfiat.org",
});

export function validatorError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function createValidatorChallenge(accountId, now = Date.now()) {
  if (!accountId) throw validatorError("account_required", 401);
  const expiresUnix = Math.floor(now / 1000) + 1800;
  const challenge = `pf-tasknode:${randomBytes(32).toString("hex")}:${accountId}:${expiresUnix}`;
  return { challenge, expiresAt: new Date(expiresUnix * 1000).toISOString() };
}

export function verifyValidatorSignature({ masterPublicKey, signature, challenge }) {
  try {
    if (typeof masterPublicKey !== "string" || typeof signature !== "string" || typeof challenge !== "string") return false;
    if (signature.length < 128 || signature.length > 144 || signature.length % 2 ||
        ![...signature].every((c) => "0123456789abcdefABCDEF".includes(c))) return false;
    const key = Buffer.from(decodeNodePublic(masterPublicKey));
    if (key.length !== 33 || ![0xed, 0x02, 0x03].includes(key[0])) return false;
    // ripple-keypairs verifies raw UTF-8 bytes for Ed25519, and DER ECDSA over
    // SHA-512Half for secp256k1, matching validator-keys sign.
    return verify(Buffer.from(challenge, "utf8").toString("hex"), signature, key.toString("hex").toUpperCase());
  } catch {
    return false;
  }
}

// A public validator manifest is the master-signed delegation to the ephemeral
// key. Its signing prefix is MAN\0, with both signature fields excluded.
export function verifyValidatorManifest({ manifest, masterPublicKey, signingPublicKey }) {
  try {
    if (typeof manifest !== "string" || !manifest.length || manifest.length > 2048) return false;
    const bytes = Buffer.from(manifest, "base64");
    if (bytes.toString("base64") !== manifest) return false;
    const hex = bytes.toString("hex").toUpperCase();
    const row = decode(hex);
    const allowed = ["Sequence", "PublicKey", "SigningPubKey", "Signature", "MasterSignature", "Domain", "Version"];
    if (Object.keys(row).some(field => !allowed.includes(field)) || encode(row) !== hex ||
        !Number.isInteger(row.Sequence) || row.Sequence < 0 || row.Sequence >= 0xffffffff ||
        (row.Version !== undefined && row.Version !== 0)) return false;
    const master = Buffer.from(decodeNodePublic(masterPublicKey)).toString("hex").toUpperCase();
    const signing = Buffer.from(decodeNodePublic(signingPublicKey)).toString("hex").toUpperCase();
    if (row.PublicKey !== master || row.SigningPubKey !== signing) return false;
    const { Signature, MasterSignature, ...unsigned } = row;
    const message = `4D414E00${encode(unsigned)}`;
    return verify(message, MasterSignature, master) && verify(message, Signature, signing);
  } catch { return false; }
}

export async function verifyRegisteredValidatorProof({ masterPublicKey, signingPublicKey, signature, challenge, manifest }, lookup = findRegisteredValidator) {
  const delegated = signingPublicKey !== undefined;
  if (!verifyValidatorSignature({ masterPublicKey: delegated ? signingPublicKey : masterPublicKey, signature, challenge })) {
    throw validatorError("validator_signature_invalid", 403);
  }
  const registered = await lookup(masterPublicKey);
  if (delegated && (!registered.signingPublicKey || registered.signingPublicKey !== signingPublicKey)) {
    throw validatorError("validator_signing_key_not_current", 403);
  }
  if (manifest !== undefined && (!delegated || !verifyValidatorManifest({ manifest, masterPublicKey, signingPublicKey }))) {
    throw validatorError("validator_manifest_invalid", 403);
  }
  return registered;
}

async function vhsJson(network, path, fetchImpl = fetch) {
  const origin = VHS_ORIGINS[network];
  if (!origin) throw validatorError("validator_network_invalid");
  const response = await fetchImpl(`${origin}${path}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw validatorError("validator_history_unavailable", 503);
  const value = await response.json();
  if (value.result !== "success") throw validatorError("validator_history_unavailable", 503);
  return value;
}

export async function findRegisteredValidator(masterPublicKey, { network, fetchImpl = fetch } = {}) {
  let unavailable = false;
  for (const candidate of network ? [network] : ["devnet", "testnet"]) {
    let value;
    try { value = await vhsJson(candidate, "/v1/network/validators", fetchImpl); }
    catch { unavailable = true; continue; }
    if (!Array.isArray(value.validators)) { unavailable = true; continue; }
    const row = value.validators.find((item) => (item.master_key || item.validation_public_key) === masterPublicKey);
    if (!row) continue;
    if (row.revoked !== false) throw validatorError("validator_revoked", 403);
    return { network: candidate, masterPublicKey, signingPublicKey: row.signing_key || null, domain: row.domain || "" };
  }
  throw validatorError(unavailable ? "validator_history_unavailable" : "validator_unknown", unavailable ? 503 : 403);
}

export async function fetchValidatorReports(masterPublicKey, network, fetchImpl = fetch) {
  const value = await vhsJson(network, `/v1/network/validator/${encodeURIComponent(masterPublicKey)}/reports`, fetchImpl);
  if (!Array.isArray(value.reports)) throw validatorError("validator_history_unavailable", 503);
  return value.reports;
}

export function dailyAgreement(reports, asOf = new Date()) {
  const end = new Date(asOf);
  if (!Number.isFinite(end.getTime())) throw validatorError("reward_window_invalid");
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 86400000);
  const days = new Map();
  for (const row of reports) {
    const at = new Date(row.date);
    const score = Number(row.score);
    if (!Number.isFinite(at.getTime()) || at < start || at >= end || row.score === null || row.score === "" ||
        !Number.isFinite(score) || score < 0 || score > 1) continue;
    const day = at.toISOString().slice(0, 10);
    // Duplicate dates must not count twice; conflicting evidence fails closed.
    if (days.has(day) && days.get(day) !== score) throw validatorError("validator_report_conflict", 503);
    days.set(day, score);
  }
  // Compensated summation preserves the inclusive 0.95 boundary (repeated
  // binary floating point addition can otherwise turn 95% into 94.999…%).
  let total = 0;
  let correction = 0;
  for (const score of days.values()) {
    const adjusted = score - correction;
    const next = total + adjusted;
    correction = (next - total) - adjusted;
    total = next;
  }
  const mean = days.size ? total / days.size : null;
  return { windowStart: start.toISOString(), windowEnd: end.toISOString(), daysReported: days.size,
    meanAgreement: mean, eligible: days.size >= 25 && mean >= 0.95 };
}

export function rewardMonthWindow(month, now = new Date()) {
  const [year, number, ...extra] = String(month).split("-");
  if (extra.length || year.length !== 4 || number?.length !== 2 ||
      ![...year + number].every((c) => "0123456789".includes(c)) || Number(number) < 1 || Number(number) > 12) {
    throw validatorError("reward_month_invalid");
  }
  const end = new Date(`${year}-${number}-01T00:00:00.000Z`);
  if (!Number.isFinite(end.getTime()) || end > now) throw validatorError("reward_month_not_due");
  return end;
}
