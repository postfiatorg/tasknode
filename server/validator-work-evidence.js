import { createHash } from "node:crypto";
import * as keypairs from "ripple-keypairs";
import { messageToHex, verifyWalletSignature } from "./wallet-proof.js";

export const validatorWorkEvidenceSchema = "pf.tasknode.validator_work_evidence.v1";
export const validatorTaskNodeBindingSchema = "postfiat.dynamic_unl_validator_binding.v1";
export const validatorWorkPolicy = Object.freeze({
  windowDays: 180,
  workTarget: 40,
  tenureTargetDays: 365,
  disputeTarget: 3,
  weights: Object.freeze({ work: 35, tenure: 25, quality: 20, standing: 10, badge: 10 }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function termsFromMetrics(metrics = {}) {
  const accepted = Number(metrics.accepted_network_tasks);
  const reviewed = Number(metrics.reviewed_network_tasks);
  const tenureDays = Number(metrics.tenure_days);
  const openDisputes = Number(metrics.open_disputes);
  if (![accepted, reviewed, tenureDays, openDisputes].every(Number.isInteger) ||
      [accepted, reviewed, tenureDays, openDisputes].some((value) => value < 0) ||
      accepted > reviewed || typeof metrics.verified_operator_badge !== "boolean") return null;
  return {
    work: clamp(accepted / validatorWorkPolicy.workTarget),
    tenure: clamp(tenureDays / validatorWorkPolicy.tenureTargetDays),
    quality: reviewed ? clamp(accepted / reviewed) : 0,
    standing: clamp(1 - openDisputes / validatorWorkPolicy.disputeTarget),
    badge: metrics.verified_operator_badge ? 1 : 0,
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function payload(event) {
  return event?.payload_json && typeof event.payload_json === "object" ? event.payload_json : {};
}

function eventKind(event) {
  const value = payload(event);
  return text(value?.offer?.task_kind || value.task_kind).toLowerCase();
}

function rewardDecision(event) {
  const value = payload(event);
  return text(value.reward_decision || value?.reward?.decision || value?.decision?.decision).toLowerCase();
}

function isHex(value, length) {
  const candidate = text(value);
  return candidate.length === length && [...candidate].every((character) =>
    (character >= "0" && character <= "9") ||
    (character >= "a" && character <= "f") ||
    (character >= "A" && character <= "F"));
}

function isLedgerDerived(event) {
  return text(event.write_source) === "pointer_derived" &&
    isHex(event.source_tx_hash, 64) &&
    text(event.source_cid) &&
    isHex(event.event_digest, 64) &&
    Number.isFinite(new Date(event.occurred_at).getTime());
}

export function deriveValidatorWorkEvidence({
  accountId,
  walletAddress,
  events = [],
  badges = [],
  openDisputes = 0,
  windowEnd,
  publisherWallet,
} = {}) {
  const end = new Date(windowEnd);
  if (!text(accountId) || !text(walletAddress) || !Number.isFinite(end.getTime())) throw new Error("validator_work_identity_or_window_invalid");
  if (!publisherWallet?.privateKey || !publisherWallet?.publicKey || !publisherWallet?.classicAddress) throw new Error("validator_work_publisher_wallet_required");
  if (!publisherWallet.publicKey.startsWith("02") && !publisherWallet.publicKey.startsWith("03")) throw new Error("validator_work_publisher_must_use_secp256k1");
  const start = new Date(end.getTime() - validatorWorkPolicy.windowDays * 86_400_000);
  const canonical = events
    .filter(isLedgerDerived)
    .filter((event) => text(event.wallet_address) === text(walletAddress))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const offers = new Map();
  for (const event of canonical) if (text(event.event_type) === "pf.task.offer.v1") offers.set(text(event.task_id), eventKind(event));
  const terminal = new Map();
  for (const event of canonical) {
    if (text(event.event_type) !== "pf.reward.v1") continue;
    const at = new Date(event.occurred_at);
    if (!Number.isFinite(at.getTime())) continue;
    const current = terminal.get(text(event.task_id));
    if (!current || new Date(current.occurred_at) < at || (new Date(current.occurred_at).getTime() === at.getTime() && stableJson(current).localeCompare(stableJson(event)) < 0)) {
      terminal.set(text(event.task_id), event);
    }
  }
  const allRewards = [...terminal.values()].sort((a, b) => text(a.task_id).localeCompare(text(b.task_id)));
  const inWindow = allRewards.filter((event) => { const at = new Date(event.occurred_at); return at >= start && at <= end; });
  const network = inWindow.filter((event) => offers.get(text(event.task_id)) === "network");
  const passed = network.filter((event) => ["full_reward", "partial_reward", "reward", "accepted"].includes(rewardDecision(event)));
  const firstReward = allRewards.reduce((first, event) => !first || new Date(event.occurred_at) < first ? new Date(event.occurred_at) : first, null);
  const tenureDays = firstReward ? Math.max(0, Math.floor((end - firstReward) / 86_400_000)) : 0;
  const verifiedBadge = badges.some((badge) => text(badge.status).toLowerCase() === "verified" && (!badge.expires_at || new Date(badge.expires_at) > end));
  const metrics = { accepted_network_tasks: passed.length, reviewed_network_tasks: network.length, tenure_days: tenureDays, open_disputes: Math.max(0, Math.floor(Number(openDisputes) || 0)), verified_operator_badge: verifiedBadge };
  const terms = termsFromMetrics(metrics);
  const accountabilityScore = Math.round(Object.entries(terms).reduce((sum, [name, value]) => sum + value * validatorWorkPolicy.weights[name], 0));
  const sourceEvents = canonical.map((event) => ({
    task_id: text(event.task_id),
    event_type: text(event.event_type),
    tx_hash: text(event.source_tx_hash),
    cid: text(event.source_cid),
    event_digest: text(event.event_digest),
    occurred_at: new Date(event.occurred_at).toISOString(),
    task_kind: eventKind(event) || null,
    reward_decision: rewardDecision(event) || null,
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const unsigned = { schema: validatorWorkEvidenceSchema, mode: "SHADOW_ONLY", account_id: text(accountId), wallet_address: text(walletAddress), window_start: start.toISOString(), window_end: end.toISOString(), policy: validatorWorkPolicy, metrics, terms, accountability_score: accountabilityScore, source_event_root: `sha256:${sha256(sourceEvents)}`, source_events: sourceEvents };
  const evidenceDigest = `sha256:${sha256(unsigned)}`;
  const message = `Post Fiat Task Node validator work evidence\nPurpose: validator_work_evidence\nEvidence-Digest: ${evidenceDigest}`;
  const signature = keypairs.sign(messageToHex(message), publisherWallet.privateKey);
  return { ...unsigned, evidence_digest: evidenceDigest, publisher: { wallet_address: publisherWallet.classicAddress, public_key: publisherWallet.publicKey, algorithm: "ripple-keypairs.secp256k1", message, signature } };
}

export function verifyValidatorWorkEvidence(evidence = {}, { expectedPublisherAddress } = {}) {
  const { evidence_digest: claimed, publisher = {}, ...rest } = evidence;
  const digest = `sha256:${sha256(rest)}`;
  const message = `Post Fiat Task Node validator work evidence\nPurpose: validator_work_evidence\nEvidence-Digest: ${digest}`;
  const sourceEvents = Array.isArray(evidence.source_events) ? evidence.source_events : [];
  const terms = termsFromMetrics(evidence.metrics);
  const accountabilityScore = terms && Math.round(Object.entries(validatorWorkPolicy.weights).reduce((sum, [name, weight]) => sum + terms[name] * weight, 0));
  return Boolean(evidence.schema === validatorWorkEvidenceSchema &&
    evidence.mode === "SHADOW_ONLY" &&
    stableJson(evidence.policy) === stableJson(validatorWorkPolicy) &&
    terms && stableJson(evidence.terms) === stableJson(terms) &&
    evidence.source_event_root === `sha256:${sha256(sourceEvents)}` &&
    evidence.accountability_score === accountabilityScore &&
    (!expectedPublisherAddress || publisher.wallet_address === expectedPublisherAddress) &&
    publisher.algorithm === "ripple-keypairs.secp256k1" &&
    claimed === digest &&
    publisher.message === message &&
    verifyWalletSignature({ message, signature: publisher.signature, publicKey: publisher.public_key, address: publisher.wallet_address }));
}

export function deriveValidatorTaskNodeBinding({
  validatorId,
  l1PublicKeyHash,
  validatorWallet,
  taskNodeWallet,
  issuedAt,
} = {}) {
  const issued = new Date(issuedAt);
  if (!text(validatorId) || !text(l1PublicKeyHash) || !Number.isFinite(issued.getTime())) {
    throw new Error("validator_tasknode_binding_identity_invalid");
  }
  for (const wallet of [validatorWallet, taskNodeWallet]) {
    if (!wallet?.privateKey || !wallet?.publicKey || !wallet?.classicAddress) {
      throw new Error("validator_tasknode_binding_wallet_required");
    }
    if (!wallet.publicKey.startsWith("02") && !wallet.publicKey.startsWith("03")) throw new Error("validator_tasknode_binding_must_use_secp256k1");
  }
  const binding = {
    validator_id: text(validatorId),
    l1_public_key_hash: text(l1PublicKeyHash),
    validator_master_wallet: validatorWallet.classicAddress,
    tasknode_wallet: taskNodeWallet.classicAddress,
    issued_at: issued.toISOString(),
  };
  const bindingDigest = `sha256:${sha256(binding)}`;
  const message = `Post Fiat validator to Task Node binding\nPurpose: validator_tasknode_binding\nBinding-Digest: ${bindingDigest}`;
  const signatureFor = (wallet) => ({
    wallet_address: wallet.classicAddress,
    public_key: wallet.publicKey,
    algorithm: "ripple-keypairs.secp256k1",
    message,
    signature: keypairs.sign(messageToHex(message), wallet.privateKey),
  });
  return {
    schema: validatorTaskNodeBindingSchema,
    mode: "SHADOW_ONLY",
    tasknode_wallet: taskNodeWallet.classicAddress,
    binding,
    binding_digest: bindingDigest,
    signatures: {
      validator: signatureFor(validatorWallet),
      tasknode: signatureFor(taskNodeWallet),
    },
  };
}

export function verifyValidatorTaskNodeBinding(document = {}) {
  const binding = document?.binding && typeof document.binding === "object" ? document.binding : {};
  const digest = `sha256:${sha256(binding)}`;
  const message = `Post Fiat validator to Task Node binding\nPurpose: validator_tasknode_binding\nBinding-Digest: ${digest}`;
  const validator = document?.signatures?.validator || {};
  const tasknode = document?.signatures?.tasknode || {};
  return document.schema === validatorTaskNodeBindingSchema &&
    document.mode === "SHADOW_ONLY" &&
    document.binding_digest === digest &&
    document.tasknode_wallet === binding.tasknode_wallet &&
    validator.wallet_address === binding.validator_master_wallet &&
    tasknode.wallet_address === binding.tasknode_wallet &&
    validator.algorithm === "ripple-keypairs.secp256k1" &&
    tasknode.algorithm === "ripple-keypairs.secp256k1" &&
    validator.message === message &&
    tasknode.message === message &&
    verifyWalletSignature({ message, signature: validator.signature, publicKey: validator.public_key, address: validator.wallet_address }) &&
    verifyWalletSignature({ message, signature: tasknode.signature, publicKey: tasknode.public_key, address: tasknode.wallet_address });
}
