// Pillar 6 — Old-Chain signWalletChallenge Capability & Prefix Guard (Contract C3)
// Enforces explicit allowlisted signing purposes and isolates Nostr v1 derivation
// from collaboration challenges, wallet proofs, wallet login, and task transitions.

export const WALLET_CHALLENGE_PREFIXES = Object.freeze({
  nostr_v1_derivation: "Task Node private messaging identity",
  collaboration_auth: "Task Node collaboration authorization",
  wallet_proof: "Post Fiat Task Node wallet proof",
  wallet_login: "Post Fiat Task Node wallet login",
  task_transition: "Post Fiat Task Node task transition",
});

const WALLET_PROOF_SUBPURPOSES = new Set(["wallet_link", "wallet_create", "password_enable"]);
const CONFUSABLE_MAP = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c",
  "\u0445": "x", "\u0456": "i", "\u0442": "t", "\u043d": "h", "\u043a": "k",
  "\u043c": "m", "\u0443": "y", "\u0455": "s", "\u03b1": "a", "\u03b5": "e",
  "\u03bf": "o", "\u03c1": "p", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v",
};

function signingGuardError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function normalizeForForbiddenScan(value) {
  const folded = String(value || "")
    .normalize("NFKC")
    .replace(/[\uFEFF\u200B-\u200D\u2060\p{Cc}]/gu, "")
    .toLowerCase();
  let mapped = "";
  for (const ch of folded) mapped += CONFUSABLE_MAP[ch] || ch;
  return mapped.replace(/\s+/g, " ").trim();
}

export function parseChallengeFields(message) {
  const lines = String(message || "").split("\n");
  const fields = {};
  for (let i = 1; i < lines.length; i += 1) {
    const idx = lines[i].indexOf(":");
    if (idx > 0) fields[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  return { firstLine: lines[0] || "", lines, fields };
}

export function validateWalletChallengeMessage(message, {
  purpose = "",
  walletAddress = "",
  expectedAccountId = "",
  allowedSubPurposes = null,
  now = Date.now(),
} = {}) {
  if (typeof purpose !== "string" || !Object.hasOwn(WALLET_CHALLENGE_PREFIXES, purpose)) {
    throw signingGuardError("SIGNING_GUARD_UNKNOWN_PURPOSE", `Unsupported signing purpose "${String(purpose || "")}".`);
  }
  if (typeof message !== "string" || !message) {
    throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Challenge message must be a non-empty string.");
  }
  if (
    purpose !== "nostr_v1_derivation" &&
    normalizeForForbiddenScan(message).includes("task node private messaging identity")
  ) {
    throw signingGuardError("SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX", "Forbidden Nostr v1 derivation prefix.");
  }
  if (
    message.includes("\u0000") ||
    message.includes("\r") ||
    message.startsWith("\uFEFF") ||
    /^[\s\p{Cc}]/u.test(message)
  ) {
    throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Challenge message contains forbidden leading or control characters.");
  }
  const requiredPrefix = WALLET_CHALLENGE_PREFIXES[purpose];
  if (!message.startsWith(`${requiredPrefix}\n`)) {
    throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", `Challenge message must start with "${requiredPrefix}".`);
  }
  const parsed = parseChallengeFields(message);
  const { lines, fields } = parsed;
  const checkExpiry = () => {
    const exp = Date.parse(fields.Expires || "");
    if (!Number.isFinite(exp) || exp <= Number(now)) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Challenge message is expired or missing Expires.");
    }
  };
  if (purpose === "nostr_v1_derivation") {
    if (
      lines.length !== 6 ||
      lines[1] !== "Version: 1" ||
      !fields.Account ||
      (expectedAccountId && fields.Account !== String(expectedAccountId).trim()) ||
      !fields.Wallet ||
      (walletAddress && fields.Wallet !== walletAddress) ||
      lines[4] !== "Purpose: tasknode.private-messages.v1" ||
      lines[5] !== "This signature derives a local Nostr key. It is not a transaction."
    ) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Invalid Nostr v1 derivation template.");
    }
  } else if (purpose === "collaboration_auth") {
    if (
      !fields.Action ||
      !fields.Resource ||
      !fields.Account ||
      (expectedAccountId && fields.Account !== String(expectedAccountId).trim()) ||
      !fields.Wallet ||
      (walletAddress && fields.Wallet !== walletAddress) ||
      !/^[0-9a-f]{64}$/i.test(fields["Payload SHA-256"] || "") ||
      !fields.Nonce
    ) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Invalid collaboration authorization fields.");
    }
    checkExpiry();
  } else if (purpose === "wallet_proof") {
    const allowed = Array.isArray(allowedSubPurposes) ? new Set(allowedSubPurposes) : WALLET_PROOF_SUBPURPOSES;
    if (
      !allowed.has(fields.Purpose || "") ||
      !fields.Account ||
      (expectedAccountId && fields.Account !== String(expectedAccountId).trim())
    ) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Invalid wallet proof challenge fields.");
    }
    checkExpiry();
  } else if (purpose === "wallet_login") {
    if (
      fields.Purpose !== "wallet_login" ||
      !fields.Address ||
      (walletAddress && fields.Address !== walletAddress)
    ) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Invalid wallet login challenge fields.");
    }
    checkExpiry();
  } else if (purpose === "task_transition") {
    if (
      fields.Purpose !== "task_transition" ||
      fields.Role !== "actor" ||
      !/^sha256:[0-9a-f]{64}$/i.test(fields["Payload-Digest"] || "")
    ) {
      throw signingGuardError("SIGNING_GUARD_PREFIX_MISMATCH", "Invalid task transition signature fields.");
    }
  }
  return parsed;
}
