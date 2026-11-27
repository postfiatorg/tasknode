import { createHash } from "node:crypto";
import {
  CONSENSUS_VERIFIED_LINK_KINDS,
  DEFAULT_IDENTITY_NAMESPACE,
  IDENTITY_BIP340_SIG_HEX_LEN,
  IDENTITY_CONTROLLER_LINK_DOMAIN,
  IDENTITY_HANDLE_ATTESTATION_DOMAIN,
  IDENTITY_HANDLE_REASSIGN_DOMAIN,
  IDENTITY_HANDLE_RESERVE_DOMAIN,
  IDENTITY_KINDS,
  IDENTITY_LINK_ID_DOMAIN,
  IDENTITY_LINK_KINDS,
  IDENTITY_LINK_STATE_EXPANSION_FEE,
  IDENTITY_MAX_LINKS,
  IDENTITY_MAX_RELAYS,
  IDENTITY_MAX_RELAY_URL_BYTES,
  IDENTITY_MINT_STATE_EXPANSION_FEE,
  IDENTITY_NAMESPACE_MAX_LEN,
  IDENTITY_NOSTR_PROOF_DOMAIN,
  IDENTITY_NOSTR_PUBKEY_HEX_LEN,
  IDENTITY_OLD_CHAIN_LINK_DOMAIN,
  IDENTITY_PQ_RECEIVE_MAX_LEN,
  IDENTITY_ROTATE_ACCOUNT_DOMAIN,
  IDENTITY_ROTATE_MODES,
  IDENTITY_SET_TRANSACTION_KIND,
  IDENTITY_UNLINK_SELF_DOMAIN,
  IDENTITY_VALIDATOR_LINK_DOMAIN,
  IDENTITY_XWING_PUBKEY_HEX_LEN,
  isCanonicalL1Account,
  isLowerHexOfLength,
  normalizeCanonicalHandle,
  normalizeIdentityRelays,
} from "./constants.js";

function sha384Hex(parts) {
  const hash = createHash("sha3-384");
  for (const part of parts) {
    hash.update(typeof part === "string" ? Buffer.from(part, "utf8") : part);
  }
  return hash.digest("hex");
}

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  error.status = 400;
  throw error;
}

function requirePositiveInt(value, code, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(code, `${label} must be a positive integer.`);
  return n;
}

function requireNonNegativeInt(value, code, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail(code, `${label} must be a non-negative integer.`);
  return n;
}

// SHA3-384("postfiat.identity.handle_reserve.v1\0" || handle || "\0" || npub_hex || "\0" || secret_salt_bytes)
export function computeHandleReservationCommitment({ handle, nostrPubkeyHex, secretSaltHex }) {
  const canonical = normalizeCanonicalHandle(handle);
  if (!canonical) fail("identity_invalid_handle", "Invalid canonical handle.");
  const pubkey = String(nostrPubkeyHex || "").trim().toLowerCase();
  if (!isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
    fail("identity_invalid_nostr_pubkey", "nostr_pubkey must be 64 lowercase hex characters.");
  }
  const saltHex = String(secretSaltHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32,128}$/.test(saltHex) || saltHex.length % 2 !== 0) {
    fail("identity_invalid_reservation_salt", "reservation_salt_hex must be 16..64 bytes of hex.");
  }
  return sha384Hex([
    `${IDENTITY_HANDLE_RESERVE_DOMAIN}\0`,
    `${canonical}\0`,
    `${pubkey}\0`,
    Buffer.from(saltHex, "hex"),
  ]);
}

// SHA3-384(IDENTITY_LINK_ID_DOMAIN || account || kind || target || seq)
export function computeIdentityLinkId({ account, kind, target, sequence }) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  if (!IDENTITY_LINK_KINDS.includes(kind)) fail("identity_invalid_link_kind", "Unsupported link kind.");
  const cleanTarget = String(target || "").trim();
  if (!cleanTarget || cleanTarget.length > 256) fail("identity_invalid_link_target", "Invalid link target.");
  const seq = requirePositiveInt(sequence, "identity_invalid_sequence", "sequence");
  return sha384Hex([
    `${IDENTITY_LINK_ID_DOMAIN}\0`,
    `${account}\0`,
    `${kind}\0`,
    `${cleanTarget}\0`,
    String(seq),
  ]);
}

export function buildNostrProofMessage({ action, chainId, account, sequence }) {
  const op = String(action || "").trim().toLowerCase();
  if (!["mint", "rotate"].includes(op)) fail("identity_invalid_action", "Nostr proof action must be mint or rotate.");
  if (!chainId || typeof chainId !== "string") fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  const seq = requirePositiveInt(sequence, "identity_invalid_sequence", "sequence");
  return `${IDENTITY_NOSTR_PROOF_DOMAIN}\naction=${op}\nchain_id=${chainId}\naccount=${account}\nsequence=${seq}\n`;
}

export function buildValidatorLinkMessage({ chainId, account, nodeId, sequence }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  const target = String(nodeId || "").trim();
  if (!target || target.length > 128) fail("identity_invalid_link_target", "Validator node_id is required.");
  const seq = requirePositiveInt(sequence, "identity_invalid_sequence", "sequence");
  return `${IDENTITY_VALIDATOR_LINK_DOMAIN}\nchain_id=${chainId}\naccount=${account}\nnode_id=${target}\nsequence=${seq}\n`;
}

export function buildOldChainLinkMessage({ chainId, account, oldChainAccount, sequence }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  const target = String(oldChainAccount || "").trim();
  if (!target || target.length > 128) fail("identity_invalid_link_target", "old_chain_account is required.");
  const seq = requirePositiveInt(sequence, "identity_invalid_sequence", "sequence");
  return `${IDENTITY_OLD_CHAIN_LINK_DOMAIN}\nchain_id=${chainId}\naccount=${account}\nold_chain_account=${target}\nsequence=${seq}\n`;
}

export function buildControllerLinkMessage({ chainId, account, controllerAccount, sequence }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  if (!isCanonicalL1Account(controllerAccount)) fail("identity_invalid_link_target", "controller_account must be canonical pf...");
  const seq = requirePositiveInt(sequence, "identity_invalid_sequence", "sequence");
  return `${IDENTITY_CONTROLLER_LINK_DOMAIN}\nchain_id=${chainId}\naccount=${account}\ncontroller_account=${controllerAccount}\nsequence=${seq}\n`;
}

// Linked-key self-unlink commits strictly to link_id (never owner sequence) so it cannot be front-run.
export function buildSelfUnlinkMessage({ chainId, account, linkId }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  if (!isLowerHexOfLength(String(linkId || "").toLowerCase(), 96)) {
    fail("identity_invalid_link_id", "link_id must be 96 lowercase hex characters.");
  }
  return `${IDENTITY_UNLINK_SELF_DOMAIN}\nchain_id=${chainId}\naccount=${account}\nlink_id=${linkId.toLowerCase()}\n`;
}

export function buildRotateAccountMessage({ chainId, oldAccount, newAccount, identitySequence }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  if (!isCanonicalL1Account(oldAccount) || !isCanonicalL1Account(newAccount)) {
    fail("identity_invalid_account", "old_account and new_account must be canonical pf... addresses.");
  }
  if (oldAccount === newAccount) fail("identity_rotate_account_same", "new_account must differ from old_account.");
  const seq = requirePositiveInt(identitySequence, "identity_invalid_sequence", "identity_sequence");
  return `${IDENTITY_ROTATE_ACCOUNT_DOMAIN}\nchain_id=${chainId}\nold_account=${oldAccount}\nnew_account=${newAccount}\nidentity_sequence=${seq}\n`;
}

export function buildHandleAttestationMessage({ chainId, namespace = DEFAULT_IDENTITY_NAMESPACE, handle, account, expiresAtHeight }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  const canonical = normalizeCanonicalHandle(handle);
  if (!canonical) fail("identity_invalid_handle", "Invalid canonical handle.");
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Invalid canonical L1 account.");
  const expiry = requirePositiveInt(expiresAtHeight, "identity_invalid_expiry", "expires_at_height");
  return `${IDENTITY_HANDLE_ATTESTATION_DOMAIN}\nchain_id=${chainId}\nnamespace=${namespace}\nhandle=${canonical}\naccount=${account}\nexpires_at_height=${expiry}\n`;
}

export function buildHandleReassignMessage({ chainId, namespace = DEFAULT_IDENTITY_NAMESPACE, handle, fromAccount, toAccount, reasonCode, emergencyCompromise }) {
  if (!chainId) fail("identity_invalid_chain_id", "chain_id is required.");
  const canonical = normalizeCanonicalHandle(handle);
  if (!canonical) fail("identity_invalid_handle", "Invalid canonical handle.");
  if (!isCanonicalL1Account(fromAccount) || !isCanonicalL1Account(toAccount)) {
    fail("identity_invalid_account", "from_account and to_account must be canonical pf... addresses.");
  }
  return `${IDENTITY_HANDLE_REASSIGN_DOMAIN}\nchain_id=${chainId}\nnamespace=${namespace}\nhandle=${canonical}\nfrom_account=${fromAccount}\nto_account=${toAccount}\nreason_code=${reasonCode}\nemergency_compromise=${Boolean(emergencyCompromise)}\n`;
}

function validateOptionalHandleAttestation(attestation, account) {
  if (!attestation) return undefined;
  const namespace = String(attestation.namespace || "").trim().toLowerCase();
  if (!namespace || namespace.length > IDENTITY_NAMESPACE_MAX_LEN) {
    fail("identity_invalid_registrar_attestation", "Invalid attestation namespace.");
  }
  const handle = normalizeCanonicalHandle(attestation.handle);
  if (!handle) fail("identity_invalid_handle", "Invalid handle in attestation.");
  if (attestation.account !== account) {
    fail("identity_invalid_registrar_attestation", "Handle attestation account does not match sender account.");
  }
  const expiresAtHeight = requirePositiveInt(attestation.expires_at_height, "identity_invalid_registrar_attestation", "expires_at_height");
  if (!isCanonicalL1Account(attestation.registrar_account)) {
    fail("identity_invalid_registrar_attestation", "Invalid registrar_account.");
  }
  const registrarPubkeyHex = String(attestation.registrar_pubkey_hex || "").trim().toLowerCase();
  const registrarSignatureHex = String(attestation.registrar_signature_hex || "").trim().toLowerCase();
  if (!registrarPubkeyHex || !registrarSignatureHex) {
    fail("identity_invalid_registrar_attestation", "Registrar public key and signature are required.");
  }
  return {
    namespace,
    handle,
    account,
    expires_at_height: expiresAtHeight,
    registrar_account: attestation.registrar_account,
    registrar_pubkey_hex: registrarPubkeyHex,
    registrar_signature_hex: registrarSignatureHex,
  };
}

function validateRelaysStrict(relays) {
  if (relays === undefined || relays === null) return [];
  if (!Array.isArray(relays)) fail("identity_invalid_relays", "relays must be an array.");
  if (relays.length > IDENTITY_MAX_RELAYS) {
    fail("identity_invalid_relays", `At most ${IDENTITY_MAX_RELAYS} relays are allowed.`);
  }
  for (const relay of relays) {
    const trimmed = String(relay || "").trim();
    if (Buffer.byteLength(trimmed, "utf8") > IDENTITY_MAX_RELAY_URL_BYTES) {
      fail("identity_invalid_relays", `Relay URL exceeds ${IDENTITY_MAX_RELAY_URL_BYTES} bytes.`);
    }
  }
  const normalized = normalizeIdentityRelays(relays);
  if (normalized.length !== new Set(relays.map((r) => String(r || "").trim().replace(/\/+$/, ""))).size) {
    fail("identity_invalid_relays", "All relays must be valid wss:// URLs.");
  }
  return normalized;
}

function validateOptionalInlineFields({ avatarNftId, messageKey, pqReceiveAddress }) {
  const out = {};
  if (avatarNftId !== undefined && avatarNftId !== null && avatarNftId !== "") {
    const clean = String(avatarNftId).trim().toLowerCase();
    if (!isLowerHexOfLength(clean, 96)) {
      fail("identity_invalid_avatar_nft_id", "avatar_nft_id must be 96 lowercase hex characters.");
    }
    out.avatar_nft_id = clean;
  }
  if (messageKey !== undefined && messageKey !== null && messageKey !== "") {
    const clean = String(messageKey).trim().toLowerCase();
    if (!isLowerHexOfLength(clean, IDENTITY_XWING_PUBKEY_HEX_LEN)) {
      fail("identity_invalid_message_key", `message_key must be ${IDENTITY_XWING_PUBKEY_HEX_LEN} lowercase hex characters (X-Wing).`);
    }
    out.message_key = clean;
  }
  if (pqReceiveAddress !== undefined && pqReceiveAddress !== null && pqReceiveAddress !== "") {
    const clean = String(pqReceiveAddress).trim();
    if (!clean.startsWith("pfpq1") || clean.length > IDENTITY_PQ_RECEIVE_MAX_LEN) {
      fail("identity_invalid_pq_receive_address", "pq_receive_address must start with pfpq1 and be <= 128 bytes.");
    }
    out.pq_receive_address = clean;
  }
  return out;
}

export function buildIdentityMintOperation({
  account,
  nostrPubkeyHex,
  nostrProofSigHex,
  derivationVersion = 1,
  keyIndex = 0,
  identityKind = "human",
  handleAttestation = null,
  reservationSaltHex = "",
  relays = [],
  avatarNftId = null,
  messageKey = null,
  pqReceiveAddress = null,
} = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  const pubkey = String(nostrPubkeyHex || "").trim().toLowerCase();
  if (!isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
    fail("identity_invalid_nostr_pubkey", "nostr_pubkey must be 64 lowercase hex characters.");
  }
  const proofSig = String(nostrProofSigHex || "").trim().toLowerCase();
  if (proofSig && !isLowerHexOfLength(proofSig, IDENTITY_BIP340_SIG_HEX_LEN)) {
    fail("identity_invalid_bip340_proof", "nostr_proof_sig_hex must be 128 lowercase hex characters.");
  }
  const version = Number(derivationVersion);
  if (version !== 1 && version !== 2) {
    fail("identity_invalid_derivation_version", "derivation_version must be 1 (legacy v1 preserved) or 2 (new seed KDF).");
  }
  const index = requireNonNegativeInt(keyIndex, "identity_invalid_key_index", "key_index");
  if (!IDENTITY_KINDS.includes(identityKind)) {
    fail("identity_invalid_kind", `identity_kind must be one of: ${IDENTITY_KINDS.join(", ")}.`);
  }
  const normalizedRelays = validateRelaysStrict(relays);
  const attestation = validateOptionalHandleAttestation(handleAttestation, account);
  const inline = validateOptionalInlineFields({ avatarNftId, messageKey, pqReceiveAddress });

  const payload = {
    action: "mint",
    nostr_pubkey: pubkey,
    nostr_proof_sig_hex: proofSig,
    derivation_version: version,
    key_index: index,
    identity_kind: identityKind,
    ...(attestation ? { handle_attestation: attestation } : {}),
    ...(reservationSaltHex ? { reservation_salt_hex: String(reservationSaltHex).trim().toLowerCase() } : {}),
    ...(normalizedRelays.length ? { relays: normalizedRelays } : {}),
    ...inline,
  };

  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload,
    },
    stateExpansionFeeAtoms: IDENTITY_MINT_STATE_EXPANSION_FEE,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
  };
}

export function buildIdentityUpdateOperation({
  account,
  relays,
  avatarNftId,
  messageKey,
  pqReceiveAddress,
  handleAttestation = null,
  reservationSaltHex = "",
} = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  const payload = { action: "update" };
  if (relays !== undefined) payload.relays = validateRelaysStrict(relays);
  if (avatarNftId !== undefined) {
    payload.avatar_nft_id = avatarNftId === null
      ? null
      : validateOptionalInlineFields({ avatarNftId }).avatar_nft_id;
  }
  if (messageKey !== undefined) {
    payload.message_key = messageKey === null
      ? null
      : validateOptionalInlineFields({ messageKey }).message_key;
  }
  if (pqReceiveAddress !== undefined) {
    payload.pq_receive_address = pqReceiveAddress === null
      ? null
      : validateOptionalInlineFields({ pqReceiveAddress }).pq_receive_address;
  }
  if (handleAttestation) {
    payload.handle_attestation = validateOptionalHandleAttestation(handleAttestation, account);
  }
  if (reservationSaltHex) {
    payload.reservation_salt_hex = String(reservationSaltHex).trim().toLowerCase();
  }
  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload,
    },
    stateExpansionFeeAtoms: 0,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
    worksUnderClassicalKillSwitch: true,
  };
}

export function buildIdentityLinkOperation({
  account,
  kind,
  target,
  proofPubkeyHex = "",
  proofSigHex = "",
  metadataHash = "",
  existingLinkCount = 0,
} = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  if (!IDENTITY_LINK_KINDS.includes(kind)) {
    fail("identity_invalid_link_kind", `kind must be one of: ${IDENTITY_LINK_KINDS.join(", ")}.`);
  }
  if (Number(existingLinkCount) >= IDENTITY_MAX_LINKS) {
    fail("identity_link_limit_exceeded", `Maximum ${IDENTITY_MAX_LINKS} links per identity.`);
  }
  const cleanTarget = String(target || "").trim();
  if (!cleanTarget || cleanTarget.length > 256) {
    fail("identity_invalid_link_target", "target is required and must be <= 256 characters.");
  }
  if (kind === "agent_controller" && !isCanonicalL1Account(cleanTarget)) {
    fail("identity_invalid_link_target", "agent_controller target must be a canonical pf... account.");
  }
  if (kind === "custom_nip05" && !/^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleanTarget)) {
    fail("identity_invalid_link_target", "custom_nip05 target must be a valid name@domain identifier.");
  }
  if (kind === "evm_address" && !/^0x[0-9a-fA-F]{40}$/.test(cleanTarget)) {
    fail("identity_invalid_link_target", "evm_address target must be a 0x-prefixed 20-byte hex address.");
  }

  const consensusVerified = CONSENSUS_VERIFIED_LINK_KINDS.has(kind);
  const cleanPubkey = String(proofPubkeyHex || "").trim().toLowerCase();
  const cleanSig = String(proofSigHex || "").trim().toLowerCase();
  const cleanMeta = String(metadataHash || "").trim().toLowerCase();
  if (cleanMeta && !isLowerHexOfLength(cleanMeta, 96)) {
    fail("identity_invalid_metadata_hash", "metadata_hash must be 96 lowercase hex characters.");
  }

  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload: {
        action: "link",
        kind,
        target: kind === "custom_nip05" ? cleanTarget.toLowerCase() : cleanTarget,
        ...(cleanPubkey ? { proof_pubkey_hex: cleanPubkey } : {}),
        ...(cleanSig ? { proof_sig_hex: cleanSig } : {}),
        ...(cleanMeta ? { metadata_hash: cleanMeta } : {}),
      },
    },
    consensusVerified,
    stateExpansionFeeAtoms: IDENTITY_LINK_STATE_EXPANSION_FEE,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
    worksUnderClassicalKillSwitch: kind !== "old_chain_account",
  };
}

export function buildIdentityUnlinkOperation({
  account,
  linkId,
  selfUnlinkPubkeyHex = "",
  selfUnlinkSigHex = "",
} = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  const cleanLinkId = String(linkId || "").trim().toLowerCase();
  if (!isLowerHexOfLength(cleanLinkId, 96)) {
    fail("identity_invalid_link_id", "link_id must be 96 lowercase hex characters.");
  }
  const cleanPubkey = String(selfUnlinkPubkeyHex || "").trim().toLowerCase();
  const cleanSig = String(selfUnlinkSigHex || "").trim().toLowerCase();
  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload: {
        action: "unlink",
        link_id: cleanLinkId,
        ...(cleanPubkey ? { self_unlink_pubkey_hex: cleanPubkey } : {}),
        ...(cleanSig ? { self_unlink_sig_hex: cleanSig } : {}),
      },
    },
    stateExpansionFeeAtoms: 0,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
    worksUnderClassicalKillSwitch: true,
  };
}

export function buildIdentityRotateOperation({
  account,
  mode = "planned",
  newNostrPubkeyHex,
  newNostrProofSigHex = "",
  derivationVersion = 2,
  keyIndex = 0,
} = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  if (!IDENTITY_ROTATE_MODES.includes(mode)) {
    fail("identity_invalid_rotate_mode", "mode must be planned or compromised.");
  }
  const pubkey = String(newNostrPubkeyHex || "").trim().toLowerCase();
  if (!isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
    fail("identity_invalid_nostr_pubkey", "new_nostr_pubkey must be 64 lowercase hex characters.");
  }
  const proofSig = String(newNostrProofSigHex || "").trim().toLowerCase();
  if (proofSig && !isLowerHexOfLength(proofSig, IDENTITY_BIP340_SIG_HEX_LEN)) {
    fail("identity_invalid_bip340_proof", "new_nostr_proof_sig_hex must be 128 lowercase hex characters.");
  }
  const version = Number(derivationVersion);
  if (version !== 1 && version !== 2) {
    fail("identity_invalid_derivation_version", "derivation_version must be 1 or 2.");
  }
  const index = requireNonNegativeInt(keyIndex, "identity_invalid_key_index", "key_index");
  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload: {
        action: "rotate",
        mode,
        new_nostr_pubkey: pubkey,
        new_nostr_proof_sig_hex: proofSig,
        derivation_version: version,
        key_index: index,
      },
    },
    tombstonesOldPubkey: mode === "compromised",
    preservesHandleAndLinks: mode === "planned",
    stateExpansionFeeAtoms: 0,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
  };
}

export function buildIdentityRotateAccountOperation({
  account,
  newAccount,
  newAccountPubkeyHex = "",
  newAccountSigHex = "",
} = {}) {
  if (!isCanonicalL1Account(account) || !isCanonicalL1Account(newAccount)) {
    fail("identity_invalid_account", "account and new_account must be canonical pf... addresses.");
  }
  if (account === newAccount) {
    fail("identity_rotate_account_same", "new_account must differ from current account.");
  }
  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload: {
        action: "rotate_account",
        new_account: newAccount,
        new_account_pubkey_hex: String(newAccountPubkeyHex || "").trim().toLowerCase(),
        new_account_sig_hex: String(newAccountSigHex || "").trim().toLowerCase(),
      },
    },
    requiresDestinationCosignature: true,
    linksPendingReconfirmation: ["validator_node", "agent_controller"],
    stateExpansionFeeAtoms: 0,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
    worksUnderClassicalKillSwitch: true,
  };
}

export function buildIdentityRevokeOperation({ account, reasonCode = "owner_revoked" } = {}) {
  if (!isCanonicalL1Account(account)) fail("identity_invalid_account", "Valid canonical pf... account is required.");
  const reason = String(reasonCode || "").trim();
  if (!reason || reason.length > 64) fail("identity_invalid_reason_code", "reason_code must be 1..64 characters.");
  return {
    operation: {
      operation: IDENTITY_SET_TRANSACTION_KIND,
      account,
      payload: {
        action: "revoke",
        reason_code: reason,
      },
    },
    stripsBadgesImmediately: true,
    stateExpansionFeeAtoms: 0,
    orderedConsensusRequired: true,
    fastPayAllowed: false,
    worksUnderClassicalKillSwitch: true,
  };
}
