import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { dailyAgreement, validatorError } from "./validator-identity.js";

export const L1_NETWORK = "l1-devnet";
export const L1_CHAIN_ID = "postfiat-wan-devnet-2";
export const L1_REGISTRY_URL = "https://178-156-143-199.sslip.io:18443/l1-registry/registry.json";
export const L1_BINDING_CONTEXT = "postfiat-l1-v2/tasknode-validator-binding/v1";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const context = new TextEncoder().encode(L1_BINDING_CONTEXT);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
export const lowerHex = (value, length) => typeof value === "string" && value.length === length &&
  [...value].every(character => "0123456789abcdef".includes(character));
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 128 &&
  [...value].every(character => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".includes(character));

export function verifyL1ValidatorSignature({ publicKey, signature, challenge }) {
  if (!lowerHex(publicKey, 3904) || !lowerHex(signature, 6618) || typeof challenge !== "string") return false;
  try {
    return ml_dsa65.verify(Uint8Array.from(Buffer.from(signature, "hex")), new TextEncoder().encode(challenge),
      Uint8Array.from(Buffer.from(publicKey, "hex")), { context });
  } catch { return false; }
}

export function validateL1Registry(value, now = new Date()) {
  const invalid = () => { throw validatorError("l1_registry_invalid", 503); };
  if (!value || value.schema !== "postfiat-tasknode-l1-registry-v1" || value.network !== L1_NETWORK ||
      value.chain_id !== L1_CHAIN_ID || !lowerHex(value.genesis_hash, 96) || !lowerHex(value.registry_root, 96) ||
      !positiveInteger(value.height) || typeof value.generated_at !== "string" || !value.generated_at.endsWith("Z")) invalid();
  const generated = Date.parse(value.generated_at);
  const age = new Date(now).getTime() - generated;
  if (!Number.isFinite(age)) invalid();
  if (age > 3600000 || age < -60000) throw validatorError("l1_registry_stale", 503);
  if (!Array.isArray(value.validators) || !value.validators.length || value.validators.length > 128) invalid();
  const ids = new Set(), keys = new Set();
  for (const row of value.validators) {
    if (!row || !validId(row.validator_id) || !lowerHex(row.ml_dsa_public_key, 3904) ||
        typeof row.active !== "boolean" || ids.has(row.validator_id) || keys.has(row.ml_dsa_public_key)) invalid();
    ids.add(row.validator_id); keys.add(row.ml_dsa_public_key);
  }
  const commit = value.latest_commit;
  if (!commit || commit.height !== value.height || !lowerHex(commit.block_hash, 96) ||
      !Array.isArray(commit.precommit_signers) || !commit.precommit_signers.length ||
      new Set(commit.precommit_signers).size !== commit.precommit_signers.length ||
      commit.precommit_signers.some(id => !ids.has(id))) invalid();
  if (!Array.isArray(value.source_heights) || value.source_heights.length < 2 || value.source_heights.length > 128) invalid();
  const sources = new Set();
  for (const source of value.source_heights) {
    if (!source || !ids.has(source.validator_id) || sources.has(source.validator_id) ||
        source.height !== value.height || source.registry_root !== value.registry_root || source.block_hash !== commit.block_hash) invalid();
    sources.add(source.validator_id);
  }
  return value;
}

export async function fetchL1Registry({ fetchImpl = fetch, now } = {}) {
  try {
    const response = await fetchImpl(L1_REGISTRY_URL, { redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > MAX_REGISTRY_BYTES) {
      await response.body?.cancel();
      throw validatorError("l1_registry_unavailable", 503);
    }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REGISTRY_BYTES) throw validatorError("l1_registry_too_large", 503);
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return validateL1Registry(JSON.parse(Buffer.concat(chunks).toString("utf8")), now);
  } catch (error) {
    if (error.status) throw error;
    throw validatorError("l1_registry_unavailable", 503);
  }
}

export function registeredL1Validator(registry, { validatorId, publicKey, chainId = L1_CHAIN_ID }) {
  if (!validId(validatorId) || !lowerHex(publicKey, 3904) || chainId !== registry.chain_id) {
    throw validatorError("l1_validator_identity_invalid", 403);
  }
  const row = registry.validators.find(item => item.validator_id === validatorId);
  if (!row) throw validatorError("l1_validator_unknown", 403);
  if (row.active !== true) throw validatorError("l1_validator_inactive", 403);
  if (row.ml_dsa_public_key !== publicKey) throw validatorError("l1_validator_key_not_current", 403);
  return row;
}

export async function verifyRegisteredL1Proof({ validatorId, publicKey, signature, challenge }, registryOptions) {
  if (!verifyL1ValidatorSignature({ publicKey, signature, challenge })) throw validatorError("validator_signature_invalid", 403);
  const registry = await fetchL1Registry(registryOptions);
  registeredL1Validator(registry, { validatorId, publicKey });
  return { network: L1_NETWORK, chainId: registry.chain_id, validatorId, publicKey,
    registryEvidence: { generatedAt: registry.generated_at, height: registry.height, registryRoot: registry.registry_root, genesisHash: registry.genesis_hash } };
}

// D63 authorizes conservative, timestamped observer brackets. Never infer
// historical coverage from a fresh registry timestamp or committee membership.
export function l1Participation(participation, asOf = new Date()) {
  const empty = dailyAgreement([], asOf);
  const result = { ...empty, available: false, qualifies: false, eligible: false, rewardsOnHold: true,
    eligibilityReason: "insufficient_observed_days", metric: "participation", timeBasis: "observer_brackets" };
  if (!participation || Date.parse(participation.window_start) !== Date.parse(empty.windowStart) ||
      Date.parse(participation.window_end) !== Date.parse(empty.windowEnd) || participation.time_basis !== "observer_brackets" ||
      !Array.isArray(participation.daily) || participation.daily.length > 30) return result;
  const reports = [], dates = new Set();
  for (const row of participation.daily) {
    if (!row || typeof row.date !== "string" || row.date.length !== 10 || !Number.isFinite(Date.parse(row.date)) ||
        new Date(row.date).toISOString().slice(0, 10) !== row.date || dates.has(row.date)) return result;
    dates.add(row.date);
    if (row.complete !== true || row.reported !== true) continue;
    if (!positiveInteger(row.committed_blocks) || !Number.isSafeInteger(row.signed_blocks) || row.signed_blocks < 0 ||
        row.signed_blocks > row.committed_blocks || !positiveInteger(row.from_height) || !positiveInteger(row.to_height) ||
        row.to_height < row.from_height || !Number.isFinite(row.score) ||
        Math.abs(row.score - row.signed_blocks / row.committed_blocks) > 1e-12) return result;
    reports.push({ date: row.date, score: row.signed_blocks / row.committed_blocks });
  }
  const measured = dailyAgreement(reports, asOf);
  const available = participation.available === true && measured.daysReported >= 25;
  const eligible = available && measured.eligible;
  return { ...result, ...measured, available, qualifies: measured.eligible, eligible, rewardsOnHold: !available,
    eligibilityReason: !available ? "insufficient_observed_days" : eligible ? "eligible" : "participation_below_threshold" };
}

export async function l1BindingParticipation(binding, asOf = new Date(), registryOptions) {
  const registry = await fetchL1Registry(registryOptions);
  const row = registeredL1Validator(registry, { validatorId: binding.validator_id, publicKey: binding.ml_dsa_public_key, chainId: binding.chain_id });
  return l1Participation(row.participation, asOf);
}
