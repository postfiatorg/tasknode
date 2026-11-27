// Frozen Pillar 6 constants from Big Milestone 06-hive-identity.md &
// L1 Upgrade Train B Contract (Section 2).

export const PROTOCOL_BLOCKS_PER_DAY = 86_400;
export const PROTOCOL_BLOCKS_PER_7_DAYS = 604_800;
export const PROTOCOL_BLOCKS_PER_30_DAYS = 2_592_000;
export const PROTOCOL_BLOCKS_PER_YEAR = 31_536_000;

export const IDENTITY_SET_TRANSACTION_KIND = "identity_set";
export const IDENTITY_REGISTRAR_REGISTER_TRANSACTION_KIND = "identity_registrar_register";
export const IDENTITY_HANDLE_RESERVE_TRANSACTION_KIND = "identity_handle_reserve";
export const IDENTITY_HANDLE_REASSIGN_PROPOSE_TRANSACTION_KIND = "identity_handle_reassign_propose";
export const IDENTITY_HANDLE_REASSIGN_EXECUTE_TRANSACTION_KIND = "identity_handle_reassign_execute";
export const IDENTITY_HANDLE_REASSIGN_CANCEL_TRANSACTION_KIND = "identity_handle_reassign_cancel";

// Burned state-expansion fees in PFT atoms (locked in Pillar 6).
export const IDENTITY_MINT_STATE_EXPANSION_FEE = 20_000; // 0.02 PFT
export const IDENTITY_LINK_STATE_EXPANSION_FEE = 10_000; // 0.01 PFT per new link

// Strict inline consensus caps.
export const IDENTITY_MAX_LINKS = 16;
export const IDENTITY_MAX_RELAYS = 5;
export const IDENTITY_MAX_RELAY_URL_BYTES = 128;
export const IDENTITY_HANDLE_MIN_LEN = 2;
export const IDENTITY_HANDLE_MAX_LEN = 32;
export const IDENTITY_NAMESPACE_MAX_LEN = 128;
export const IDENTITY_NOSTR_PUBKEY_HEX_LEN = 64;
export const IDENTITY_BIP340_SIG_HEX_LEN = 128;
export const IDENTITY_XWING_PUBKEY_HEX_LEN = 2432;
export const IDENTITY_PQ_RECEIVE_MAX_LEN = 128;
export const IDENTITY_VALIDATOR_COOLDOWN_BLOCKS = PROTOCOL_BLOCKS_PER_30_DAYS;
export const IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS = PROTOCOL_BLOCKS_PER_7_DAYS;
export const IDENTITY_HANDLE_HOLDBACK_BLOCKS = PROTOCOL_BLOCKS_PER_7_DAYS;

// Domain separation prefixes (exact Train B contract values).
export const IDENTITY_LINK_ID_DOMAIN = "postfiat.identity.link_id.v1";
export const IDENTITY_NOSTR_PROOF_DOMAIN = "postfiat-l1-v2/identity-nostr/v1";
export const IDENTITY_VALIDATOR_LINK_DOMAIN = "postfiat-l1-v2/identity-link/v1";
export const IDENTITY_OLD_CHAIN_LINK_DOMAIN = "postfiat-l1-v2/identity-old-chain/v1";
export const IDENTITY_CONTROLLER_LINK_DOMAIN = "postfiat-l1-v2/identity-controller/v1";
export const IDENTITY_UNLINK_SELF_DOMAIN = "postfiat-l1-v2/identity-unlink/v1";
export const IDENTITY_ROTATE_ACCOUNT_DOMAIN = "postfiat-l1-v2/identity-rotate-account/v1";
export const IDENTITY_HANDLE_RESERVE_DOMAIN = "postfiat.identity.handle_reserve.v1";
export const IDENTITY_HANDLE_ATTESTATION_DOMAIN = "postfiat-l1-v2/handle-attestation/v1";
export const IDENTITY_HANDLE_REASSIGN_DOMAIN = "postfiat-l1-v2/handle-reassign/v1";

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
export const IDENTITY_REASSIGN_REASONS = Object.freeze([
  "lost_key",
  "abuse_impersonation",
  "emergency_compromise",
]);
export const IDENTITY_LINK_KINDS = Object.freeze([
  "validator_node",
  "old_chain_account",
  "agent_controller",
  "custom_nip05",
  "evm_address",
  "solana_address",
]);
export const CONSENSUS_VERIFIED_LINK_KINDS = Object.freeze(new Set([
  "validator_node",
  "old_chain_account",
  "agent_controller",
]));
export const CLIENT_VERIFIED_LINK_KINDS = Object.freeze(new Set([
  "custom_nip05",
  "evm_address",
  "solana_address",
]));

// Reserved handles under @tasknode.postfiat.org (Pillar 6).
export const FOUNDER_RESERVED_HANDLES = Object.freeze(new Set(["goodalexander"]));
export const AGENT_RESERVED_HANDLES = Object.freeze(new Set(["hive-board"]));
export const SYSTEM_RESERVED_HANDLES = Object.freeze(new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "postfiat",
  "tasknode",
  "support",
  "security",
  "registrar",
  "validator",
  "validators",
  "governance",
  "treasury",
  "foundation",
  "relay",
  "explorer",
  "wallet",
  "navcoin",
  "navcoins",
  "pfusdc",
  "pftl",
  "official",
  "help",
  "info",
  "noreply",
  "no-reply",
  "postmaster",
  "webmaster",
  "hostmaster",
  "abuse",
  "status",
  "api",
  "www",
  "mail",
  "hive",
  "board",
  "bot",
  "mod",
  "moderator",
  "staff",
  "team",
  "dev",
  "ops",
  "null",
  "undefined",
  "test",
]));

export function isCanonicalL1Account(value) {
  return typeof value === "string" && /^pf[0-9a-f]{40}$/.test(value);
}

export function isLowerHexOfLength(value, length) {
  if (typeof value !== "string" || value.length !== length) return false;
  return /^[0-9a-f]+$/.test(value);
}

export function normalizeCanonicalHandle(raw = "") {
  const cleaned = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
  if (cleaned.length < IDENTITY_HANDLE_MIN_LEN || cleaned.length > IDENTITY_HANDLE_MAX_LEN) {
    return "";
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(cleaned)) {
    return "";
  }
  return cleaned;
}

export function classifyReservedHandle(raw = "") {
  const handle = normalizeCanonicalHandle(raw);
  if (!handle) return { valid: false, handle: "", reserved: false, category: "invalid" };
  if (FOUNDER_RESERVED_HANDLES.has(handle)) {
    return { valid: true, handle, reserved: true, category: "founder" };
  }
  if (AGENT_RESERVED_HANDLES.has(handle)) {
    return { valid: true, handle, reserved: true, category: "agent" };
  }
  if (SYSTEM_RESERVED_HANDLES.has(handle)) {
    return { valid: true, handle, reserved: true, category: "system" };
  }
  return { valid: true, handle, reserved: false, category: "open" };
}

export function normalizeIdentityRelays(relays = []) {
  if (!Array.isArray(relays)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of relays) {
    const candidate = String(raw || "").trim().replace(/\/+$/, "");
    if (!candidate || Buffer.byteLength(candidate, "utf8") > IDENTITY_MAX_RELAY_URL_BYTES) continue;
    if (/\s/.test(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "wss:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
        continue;
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
        if (out.length >= IDENTITY_MAX_RELAYS) break;
      }
    } catch {
      // Ignore malformed relay URLs.
    }
  }
  return out;
}
