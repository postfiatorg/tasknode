import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  DEFAULT_IDENTITY_NAMESPACE,
  IDENTITY_HANDLE_HOLDBACK_BLOCKS,
  IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS,
  IDENTITY_NOSTR_PUBKEY_HEX_LEN,
  IDENTITY_REASSIGN_REASONS,
  classifyReservedHandle,
  isCanonicalL1Account,
  isLowerHexOfLength,
  normalizeCanonicalHandle,
} from "./constants.js";
import {
  buildHandleAttestationMessage,
  buildIdentityLinkOperation,
  computeHandleReservationCommitment,
} from "./payload-builder.js";

const CUSTOM_NIP05_MAX_BYTES = 64 * 1024;
const CUSTOM_NIP05_TIMEOUT_MS = 5000;

function isPrivateOrLocalHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1"
  ) {
    return true;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (ipVersion === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
      return true;
    }
  }
  return false;
}

export function parseCustomNip05Identifier(raw = "", primaryNamespace = DEFAULT_IDENTITY_NAMESPACE) {
  const trimmed = String(raw || "").trim().toLowerCase();
  const atIndex = trimmed.indexOf("@");
  if (atIndex < 1 || atIndex !== trimmed.lastIndexOf("@")) {
    return { ok: false, error: "identity_custom_nip05_invalid" };
  }
  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (!/^[a-z0-9._-]{1,64}$/.test(localPart)) {
    return { ok: false, error: "identity_custom_nip05_invalid" };
  }
  if (
    !domain ||
    domain.length > 253 ||
    !domain.includes(".") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
  ) {
    return { ok: false, error: "identity_custom_nip05_invalid_domain" };
  }
  if (domain === String(primaryNamespace || DEFAULT_IDENTITY_NAMESPACE).toLowerCase()) {
    return { ok: false, error: "identity_custom_nip05_primary_namespace_disallowed" };
  }
  if (isPrivateOrLocalHostname(domain)) {
    return { ok: false, error: "identity_custom_nip05_unsafe_host" };
  }
  return { ok: true, identifier: `${localPart}@${domain}`, localPart, domain };
}

export async function verifyCustomNip05({
  identifier = "",
  expectedNostrPubkeyHex = "",
  primaryNamespace = DEFAULT_IDENTITY_NAMESPACE,
  fetchImpl = fetch,
  dnsTxtResolver = null,
} = {}) {
  const parsed = parseCustomNip05Identifier(identifier, primaryNamespace);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const pubkey = String(expectedNostrPubkeyHex || "").trim().toLowerCase();
  if (!isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
    return { ok: false, status: 400, error: "identity_invalid_nostr_pubkey" };
  }

  const wellKnownUrl = `https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.localPart)}`;
  try {
    const response = await fetchImpl(wellKnownUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(CUSTOM_NIP05_TIMEOUT_MS),
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok && !response.redirected) {
      const contentLength = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(contentLength) && contentLength > CUSTOM_NIP05_MAX_BYTES) {
        return { ok: false, status: 422, error: "identity_custom_nip05_response_too_large" };
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > CUSTOM_NIP05_MAX_BYTES) {
        return { ok: false, status: 422, error: "identity_custom_nip05_response_too_large" };
      }
      const doc = JSON.parse(text);
      const matched = String(doc?.names?.[parsed.localPart] || "").trim().toLowerCase();
      if (matched === pubkey) {
        const relays = Array.isArray(doc?.relays?.[pubkey]) ? doc.relays[pubkey].slice(0, 5) : [];
        return {
          ok: true,
          verified: true,
          method: "well_known_https",
          consensusVerified: false,
          identifier: parsed.identifier,
          localPart: parsed.localPart,
          domain: parsed.domain,
          nostrPubkeyHex: pubkey,
          relays,
          sourceUrl: wellKnownUrl,
        };
      }
      return {
        ok: false,
        status: 422,
        error: "identity_custom_nip05_pubkey_mismatch",
        identifier: parsed.identifier,
        expectedPubkeyHex: pubkey,
        observedPubkeyHex: matched || null,
      };
    }
  } catch {
    // Fall through to optional DNS TXT lookup when provided.
  }

  if (typeof dnsTxtResolver === "function") {
    try {
      const records = await dnsTxtResolver(`_nip05.${parsed.domain}`);
      const flattened = (Array.isArray(records) ? records : [])
        .map((entry) => (Array.isArray(entry) ? entry.join("") : String(entry || "")))
        .map((line) => line.trim().toLowerCase());
      const expectedToken = `${parsed.localPart}=${pubkey}`;
      if (flattened.some((line) => line.includes(expectedToken) || line === `nostr=${pubkey}`)) {
        return {
          ok: true,
          verified: true,
          method: "dns_txt",
          consensusVerified: false,
          identifier: parsed.identifier,
          localPart: parsed.localPart,
          domain: parsed.domain,
          nostrPubkeyHex: pubkey,
          relays: [],
          sourceUrl: `dns://_nip05.${parsed.domain}`,
        };
      }
    } catch {
      // DNS lookup failure falls through to unified verification failure below.
    }
  }

  return {
    ok: false,
    status: 422,
    error: "identity_custom_nip05_verification_failed",
    identifier: parsed.identifier,
  };
}

export function createIdentityRegistrar({
  namespace = DEFAULT_IDENTITY_NAMESPACE,
  founderAccountIds = [],
  agentAccountIds = [],
  hotRegistrarAccount = "",
  hotRegistrarPubkeyHex = "",
  hotSignAttestation = null,
  coldSigners = [],
  store,
  chainLookup = null,
} = {}) {
  const founderSet = new Set(founderAccountIds.map((id) => String(id || "").trim()).filter(Boolean));
  const agentSet = new Set(agentAccountIds.map((id) => String(id || "").trim()).filter(Boolean));
  const coldSignerSet = new Set(coldSigners.filter(isCanonicalL1Account));

  async function inspectHandle({
    handle: rawHandle = "",
    accountId = "",
    identityKind = "human",
    currentHeight = 0,
  } = {}) {
    const classification = classifyReservedHandle(rawHandle);
    if (!classification.valid) {
      return {
        ok: false,
        available: false,
        error: "identity_invalid_handle",
        handle: "",
        namespace,
      };
    }
    const handle = classification.handle;

    if (classification.category === "system") {
      return {
        ok: true,
        available: false,
        reserved: true,
        reservedCategory: "system",
        error: "identity_handle_reserved",
        handle,
        namespace,
      };
    }
    if (classification.category === "founder" && (!accountId || !founderSet.has(accountId))) {
      return {
        ok: true,
        available: false,
        reserved: true,
        reservedCategory: "founder",
        error: "identity_handle_reserved",
        handle,
        namespace,
      };
    }
    if (
      classification.category === "agent" &&
      (!accountId || !agentSet.has(accountId) || identityKind !== "agent")
    ) {
      return {
        ok: true,
        available: false,
        reserved: true,
        reservedCategory: "agent",
        error: "identity_handle_reserved",
        handle,
        namespace,
      };
    }

    const holdbackUntil = await store.getHandleHoldbackUntil({ namespace, handle });
    if (holdbackUntil && Number(currentHeight) < holdbackUntil) {
      return {
        ok: true,
        available: false,
        reserved: false,
        holdbackUntilHeight: holdbackUntil,
        error: "identity_handle_in_holdback",
        handle,
        namespace,
      };
    }

    const onChain = chainLookup ? await chainLookup({ namespace, handle }).catch(() => null) : null;
    if (onChain?.found && onChain.identity?.status === "active") {
      return {
        ok: true,
        available: false,
        reserved: false,
        claimedOnChain: true,
        ownerAccount: onChain.identity.account,
        error: "identity_handle_already_claimed",
        handle,
        namespace,
      };
    }

    const existingReservation = await store.getReservation({ namespace, handle });
    if (existingReservation && existingReservation.accountId !== accountId && existingReservation.status === "reserved") {
      return {
        ok: true,
        available: false,
        reserved: true,
        reservedCategory: existingReservation.reservedCategory || "user",
        error: "identity_handle_already_reserved",
        handle,
        namespace,
      };
    }

    return {
      ok: true,
      available: true,
      reserved: classification.reserved,
      reservedCategory: classification.category,
      handle,
      namespace,
      nip05: `${handle}@${namespace}`,
    };
  }

  // Salted reservation preserving existing v1 npub intact (or opting into v2).
  async function reserveHandle({
    accountId = "",
    l1Account = "",
    handle: rawHandle = "",
    existingV1NostrPubkeyHex = "",
    requestedNostrPubkeyHex = "",
    optIntoV2 = false,
    identityKind = "human",
    currentHeight = 0,
    saltHex = "",
  } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "identity_login_required" };
    const status = await inspectHandle({ handle: rawHandle, accountId, identityKind, currentHeight });
    if (!status.ok) return { ok: false, status: 400, error: status.error };
    if (!status.available) {
      return {
        ok: false,
        status: 409,
        error: status.error || "identity_handle_unavailable",
        reservedCategory: status.reservedCategory || null,
        holdbackUntilHeight: status.holdbackUntilHeight || null,
      };
    }

    const existingV1 = String(existingV1NostrPubkeyHex || "").trim().toLowerCase();
    const requested = String(requestedNostrPubkeyHex || "").trim().toLowerCase();
    const preservesV1 = Boolean(existingV1 && !optIntoV2);
    const nostrPubkeyHex = preservesV1 ? existingV1 : requested;
    const derivationVersion = preservesV1 ? 1 : 2;

    if (!isLowerHexOfLength(nostrPubkeyHex, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
      return { ok: false, status: 400, error: "identity_invalid_nostr_pubkey" };
    }
    if (await store.isCompromisedNostrPubkey(nostrPubkeyHex)) {
      return { ok: false, status: 409, error: "identity_nostr_pubkey_compromised" };
    }

    const secretSaltHex = saltHex
      ? String(saltHex).trim().toLowerCase()
      : randomBytes(24).toString("hex");
    const commitmentHash = computeHandleReservationCommitment({
      handle: status.handle,
      nostrPubkeyHex,
      secretSaltHex,
    });

    const record = await store.saveReservation({
      namespace,
      handle: status.handle,
      accountId,
      l1Account: isCanonicalL1Account(l1Account) ? l1Account : "",
      nostrPubkeyHex,
      derivationVersion,
      commitmentHash,
      saltHex: secretSaltHex,
      reservedCategory: status.reservedCategory || "user",
      status: "reserved",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    });

    return {
      ok: true,
      reservation: {
        namespace: record.namespace,
        handle: record.handle,
        nip05: `${record.handle}@${record.namespace}`,
        nostrPubkeyHex: record.nostrPubkeyHex,
        derivationVersion: record.derivationVersion,
        preservedV1Npub: preservesV1,
        commitmentHash: record.commitmentHash,
        // Delivered ONLY inside the authenticated user's session.
        reservationSaltHex: record.saltHex,
        expiresAt: record.expiresAt,
      },
    };
  }

  // Hot registrar attests UNCLAIMED handles only (never reassigns claimed/holdback handles).
  async function issueHotHandleAttestation({
    accountId = "",
    account = "",
    handle: rawHandle = "",
    nostrPubkeyHex = "",
    reservationSaltHex = "",
    identityKind = "human",
    chainId = "postfiat-wan-devnet-2",
    currentHeight = 1,
    ttlBlocks = 3_600,
  } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "identity_login_required" };
    if (!isCanonicalL1Account(account)) return { ok: false, status: 400, error: "identity_invalid_account" };
    const check = await inspectHandle({ handle: rawHandle, accountId, identityKind, currentHeight });
    if (!check.ok) return { ok: false, status: 400, error: check.error };
    if (!check.available) {
      return { ok: false, status: 409, error: check.error || "identity_handle_already_claimed" };
    }

    const reservation = await store.getReservation({ namespace, handle: check.handle });
    if (reservation && reservation.status === "reserved") {
      if (reservation.accountId !== accountId) {
        return { ok: false, status: 409, error: "identity_handle_reservation_mismatch" };
      }
      const suppliedSalt = String(reservationSaltHex || reservation.saltHex || "").trim().toLowerCase();
      const pubkey = String(nostrPubkeyHex || reservation.nostrPubkeyHex || "").trim().toLowerCase();
      if (!suppliedSalt || !isLowerHexOfLength(pubkey, IDENTITY_NOSTR_PUBKEY_HEX_LEN)) {
        return { ok: false, status: 400, error: "identity_handle_reservation_mismatch" };
      }
      const expected = computeHandleReservationCommitment({
        handle: check.handle,
        nostrPubkeyHex: pubkey,
        secretSaltHex: suppliedSalt,
      });
      if (expected !== reservation.commitmentHash) {
        return { ok: false, status: 403, error: "identity_handle_reservation_mismatch" };
      }
    }

    const expiresAtHeight = Number(currentHeight) + Math.max(60, Number(ttlBlocks) || 3_600);
    const signingMessage = buildHandleAttestationMessage({
      chainId,
      namespace,
      handle: check.handle,
      account,
      expiresAtHeight,
    });
    const signatureHex = typeof hotSignAttestation === "function"
      ? await hotSignAttestation(signingMessage)
      : "";

    return {
      ok: true,
      attestation: {
        namespace,
        handle: check.handle,
        account,
        expires_at_height: expiresAtHeight,
        registrar_account: hotRegistrarAccount,
        registrar_pubkey_hex: hotRegistrarPubkeyHex,
        registrar_signature_hex: signatureHex,
      },
      signingMessage,
      signed: Boolean(signatureHex),
      hotAttestationOnly: true,
    };
  }

  // Validates 2-of-3 cold multisig handle reassignment + 7-day timelock (Pillar 6 §2.4).
  function validateColdReassignmentProposal({
    handle: rawHandle = "",
    fromAccount = "",
    toAccount = "",
    reasonCode = "",
    emergencyCompromise = false,
    approvals = [],
    proposedAtHeight = 0,
    timelockBlocks = IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS,
  } = {}) {
    const handle = normalizeCanonicalHandle(rawHandle);
    if (!handle) return { ok: false, error: "identity_invalid_handle" };
    if (!isCanonicalL1Account(fromAccount) || !isCanonicalL1Account(toAccount)) {
      return { ok: false, error: "identity_invalid_account" };
    }
    if (!IDENTITY_REASSIGN_REASONS.includes(reasonCode)) {
      return { ok: false, error: "identity_invalid_reason_code" };
    }
    const validDistinctSigners = new Set();
    for (const approval of Array.isArray(approvals) ? approvals : []) {
      if (
        approval &&
        coldSignerSet.has(approval.signer_account) &&
        approval.public_key_hex &&
        approval.signature_hex
      ) {
        validDistinctSigners.add(approval.signer_account);
      }
    }
    if (validDistinctSigners.size < 2) {
      return { ok: false, error: "identity_reassign_insufficient_quorum" };
    }
    const effectiveTimelock = Math.max(IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS, Number(timelockBlocks) || 0);
    const effectiveAtHeight = emergencyCompromise
      ? Number(proposedAtHeight)
      : Number(proposedAtHeight) + effectiveTimelock;
    return {
      ok: true,
      namespace,
      handle,
      fromAccount,
      toAccount,
      reasonCode,
      emergencyCompromise: Boolean(emergencyCompromise),
      quorumCount: validDistinctSigners.size,
      effectiveAtHeight,
      ownerCanCancel: !emergencyCompromise,
      holdbackBlocks: IDENTITY_HANDLE_HOLDBACK_BLOCKS,
    };
  }

  async function verifyAndBuildCustomNip05Link({
    accountId = "",
    account = "",
    identifier = "",
    nostrPubkeyHex = "",
    existingLinkCount = 0,
    fetchImpl = fetch,
    dnsTxtResolver = null,
  } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "identity_login_required" };
    const verification = await verifyCustomNip05({
      identifier,
      expectedNostrPubkeyHex: nostrPubkeyHex,
      primaryNamespace: namespace,
      fetchImpl,
      dnsTxtResolver,
    });
    if (!verification.ok) return verification;

    await store.saveCustomNip05Claim({
      accountId,
      identifier: verification.identifier,
      domain: verification.domain,
      localPart: verification.localPart,
      nostrPubkeyHex: verification.nostrPubkeyHex,
      verificationMethod: verification.method,
      status: "verified",
      metadata: {
        relays: verification.relays,
        sourceUrl: verification.sourceUrl,
      },
    });

    const linkTx = isCanonicalL1Account(account)
      ? buildIdentityLinkOperation({
        account,
        kind: "custom_nip05",
        target: verification.identifier,
        existingLinkCount,
      })
      : null;

    return {
      ok: true,
      verification,
      linkTx,
    };
  }

  return {
    namespace,
    inspectHandle,
    reserveHandle,
    issueHotHandleAttestation,
    validateColdReassignmentProposal,
    verifyAndBuildCustomNip05Link,
  };
}
