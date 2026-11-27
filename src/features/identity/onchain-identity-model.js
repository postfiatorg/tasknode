// Browser-safe Pillar 6 On-Chain Identity model & payload helpers.
// Mirrors L1 Upgrade Train B Contract Section 2.

export const IDENTITY_MINT_FEE_ATOMS = 20_000; // 0.02 PFT
export const IDENTITY_LINK_FEE_ATOMS = 10_000; // 0.01 PFT
export const IDENTITY_MAX_LINKS = 16;
export const IDENTITY_MAX_RELAYS = 5;
export const IDENTITY_MAX_RELAY_URL_BYTES = 128;
export const IDENTITY_VALIDATOR_COOLDOWN_DAYS = 30;
export const IDENTITY_REASSIGN_TIMELOCK_DAYS = 7;

export const DEFAULT_IDENTITY_NAMESPACE = "tasknode.postfiat.org";
export const FIRST_PARTY_NOSTR_RELAY = "wss://relay.postfiat.org";
export const DEFAULT_IDENTITY_RELAYS = Object.freeze([
  FIRST_PARTY_NOSTR_RELAY,
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
]);

export const IDENTITY_KINDS = Object.freeze(["human", "agent", "service"]);
export const IDENTITY_ROTATE_MODES = Object.freeze(["planned", "compromised"]);
export const CONSENSUS_VERIFIED_LINK_KINDS = Object.freeze(new Set([
  "validator_node",
  "old_chain_account",
  "agent_controller",
]));

export const RESERVED_HANDLE_CATEGORIES = Object.freeze({
  founder: new Set(["goodalexander"]),
  agent: new Set(["hive-board"]),
  system: new Set([
    "admin", "administrator", "root", "system", "postfiat", "tasknode",
    "support", "security", "registrar", "validator", "validators",
    "governance", "treasury", "foundation", "relay", "explorer", "wallet",
    "navcoin", "navcoins", "pfusdc", "pftl", "official", "help", "info",
    "noreply", "no-reply", "postmaster", "webmaster", "hostmaster", "abuse",
    "status", "api", "www", "mail", "hive", "board", "bot", "mod",
    "moderator", "staff", "team", "dev", "ops", "null", "undefined", "test",
  ]),
});

export function isCanonicalL1Account(value) {
  return typeof value === "string" && /^pf[0-9a-f]{40}$/.test(value);
}

export function normalizeCanonicalHandle(raw = "") {
  const cleaned = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
  if (cleaned.length < 2 || cleaned.length > 32) return "";
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(cleaned)) return "";
  return cleaned;
}

export function classifyHandle(raw = "") {
  const handle = normalizeCanonicalHandle(raw);
  if (!handle) return { valid: false, handle: "", reserved: false, category: "invalid" };
  if (RESERVED_HANDLE_CATEGORIES.founder.has(handle)) {
    return { valid: true, handle, reserved: true, category: "founder" };
  }
  if (RESERVED_HANDLE_CATEGORIES.agent.has(handle)) {
    return { valid: true, handle, reserved: true, category: "agent" };
  }
  if (RESERVED_HANDLE_CATEGORIES.system.has(handle)) {
    return { valid: true, handle, reserved: true, category: "system" };
  }
  return { valid: true, handle, reserved: false, category: "open" };
}

export function formatPftFromAtoms(atoms) {
  const value = Number(atoms || 0) / 1_000_000;
  return `${value.toFixed(2)} PFT`;
}

export function normalizeRelayList(relays = []) {
  const input = Array.isArray(relays)
    ? relays
    : String(relays || "").split(/[\n,]+/);
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const url = String(item || "").trim().replace(/\/+$/, "");
    if (!url || url.length > IDENTITY_MAX_RELAY_URL_BYTES || /\s/.test(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "wss:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
        continue;
      }
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
        if (out.length >= IDENTITY_MAX_RELAYS) break;
      }
    } catch {
      // Ignore invalid relay URLs.
    }
  }
  return out;
}

export function deriveIdentityBadges(onChainIdentity) {
  if (!onChainIdentity || onChainIdentity.status !== "active" || onChainIdentity.compromised === true) {
    return [];
  }
  const badges = [{ id: "minted", label: "Minted", tone: "verified" }];
  if (onChainIdentity.identity_kind === "agent") {
    badges.push({ id: "agent", label: "Agent", tone: "neutral" });
  }
  for (const link of Array.isArray(onChainIdentity.links) ? onChainIdentity.links : []) {
    if (!link || link.status !== "active" || link.consensus_verified !== true) continue;
    if (link.kind === "validator_node") {
      badges.push({ id: `val-${link.target}`, label: `Validator · ${link.target}`, tone: "verified" });
    } else if (link.kind === "old_chain_account") {
      badges.push({ id: "old-chain", label: "Old chain", tone: "verified" });
    } else if (link.kind === "agent_controller") {
      badges.push({ id: "controller", label: "Controller linked", tone: "verified" });
    }
  }
  return badges;
}

export function describeLinkKind(kind) {
  switch (kind) {
    case "validator_node":
      return {
        label: "Validator node",
        consensusVerified: true,
        hint: `Co-signed by your validator ML-DSA-65 node key. Globally unique with a ${IDENTITY_VALIDATOR_COOLDOWN_DAYS}-day operator-switch cooldown.`,
      };
    case "old_chain_account":
      return {
        label: "Old-chain wallet",
        consensusVerified: true,
        hint: "Dual-signed with strict low-S DER secp256k1 ECDSA. Globally unique per old-chain account.",
      };
    case "agent_controller":
      return {
        label: "Human controller (agent)",
        consensusVerified: true,
        hint: "Co-signed by the human controller pf... account (used for AI agents such as hive-board@).",
      };
    case "custom_nip05":
      return {
        label: "Custom NIP-05 domain",
        consensusVerified: false,
        hint: "Client-verified live against /.well-known/nostr.json or DNS TXT. Non-unique on chain to prevent domain squatting.",
      };
    case "evm_address":
      return {
        label: "EVM wallet",
        consensusVerified: false,
        hint: "Client-verified external Ethereum/EVM address claim.",
      };
    case "solana_address":
      return {
        label: "Solana wallet",
        consensusVerified: false,
        hint: "Client-verified external Solana address claim.",
      };
    default:
      return { label: kind, consensusVerified: false, hint: "" };
  }
}

export function buildMintRequestPayload({
  account,
  nostrPubkeyHex,
  nostrProofSigHex = "",
  preserveV1Npub = true,
  keyIndex = 0,
  identityKind = "human",
  handleAttestation = null,
  reservationSaltHex = "",
  relays = DEFAULT_IDENTITY_RELAYS,
  avatarNftId = "",
  messageKey = "",
  pqReceiveAddress = "",
  sequence = 1,
  chainId = "postfiat-wan-devnet-2",
} = {}) {
  if (!isCanonicalL1Account(account)) {
    throw new Error("Enter a valid Post Fiat L1 account (pf + 40 lowercase hex).");
  }
  const pubkey = String(nostrPubkeyHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error("Nostr public key must be 64 lowercase hex characters.");
  }
  if (!IDENTITY_KINDS.includes(identityKind)) {
    throw new Error("Choose a valid identity kind (human, agent, or service).");
  }
  const normalizedRelays = normalizeRelayList(relays);
  return {
    action: "mint",
    account,
    chainId,
    sequence: Math.max(1, Number(sequence) || 1),
    nostrPubkeyHex: pubkey,
    ...(nostrProofSigHex ? { nostrProofSigHex: String(nostrProofSigHex).trim().toLowerCase() } : {}),
    derivationVersion: preserveV1Npub ? 1 : 2,
    keyIndex: Math.max(0, Number(keyIndex) || 0),
    identityKind,
    ...(handleAttestation ? { handleAttestation } : {}),
    ...(reservationSaltHex ? { reservationSaltHex: String(reservationSaltHex).trim().toLowerCase() } : {}),
    relays: normalizedRelays,
    ...(avatarNftId ? { avatarNftId: String(avatarNftId).trim().toLowerCase() } : {}),
    ...(messageKey ? { messageKey: String(messageKey).trim().toLowerCase() } : {}),
    ...(pqReceiveAddress ? { pqReceiveAddress: String(pqReceiveAddress).trim() } : {}),
  };
}

export function buildRotateRequestPayload({
  account,
  mode = "planned",
  newNostrPubkeyHex,
  newNostrProofSigHex = "",
  derivationVersion = 2,
  keyIndex = 1,
  sequence = 2,
  chainId = "postfiat-wan-devnet-2",
} = {}) {
  if (!isCanonicalL1Account(account)) {
    throw new Error("Enter a valid Post Fiat L1 account (pf + 40 lowercase hex).");
  }
  if (!IDENTITY_ROTATE_MODES.includes(mode)) {
    throw new Error("Rotation mode must be planned or compromised.");
  }
  const pubkey = String(newNostrPubkeyHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error("New Nostr public key must be 64 lowercase hex characters.");
  }
  return {
    action: "rotate",
    account,
    chainId,
    sequence: Math.max(1, Number(sequence) || 1),
    mode,
    newNostrPubkeyHex: pubkey,
    ...(newNostrProofSigHex ? { newNostrProofSigHex: String(newNostrProofSigHex).trim().toLowerCase() } : {}),
    derivationVersion: Number(derivationVersion) === 1 ? 1 : 2,
    keyIndex: Math.max(0, Number(keyIndex) || 0),
  };
}

export function buildLinkRequestPayload({
  account,
  kind,
  target,
  proofPubkeyHex = "",
  proofSigHex = "",
  existingLinkCount = 0,
  sequence = 2,
  chainId = "postfiat-wan-devnet-2",
} = {}) {
  if (!isCanonicalL1Account(account)) {
    throw new Error("Enter a valid Post Fiat L1 account (pf + 40 lowercase hex).");
  }
  if (Number(existingLinkCount) >= IDENTITY_MAX_LINKS) {
    throw new Error(`Maximum ${IDENTITY_MAX_LINKS} links reached for this identity.`);
  }
  const cleanTarget = String(target || "").trim();
  if (!cleanTarget) throw new Error("Enter a link target.");
  return {
    action: "link",
    account,
    chainId,
    sequence: Math.max(1, Number(sequence) || 1),
    kind,
    target: cleanTarget,
    ...(proofPubkeyHex ? { proofPubkeyHex: String(proofPubkeyHex).trim().toLowerCase() } : {}),
    ...(proofSigHex ? { proofSigHex: String(proofSigHex).trim().toLowerCase() } : {}),
    existingLinkCount: Number(existingLinkCount) || 0,
  };
}
