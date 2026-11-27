import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IDENTITY_NAMESPACE,
  FIRST_PARTY_NOSTR_RELAY,
  IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS,
  IDENTITY_LINK_STATE_EXPANSION_FEE,
  IDENTITY_MAX_LINKS,
  IDENTITY_MAX_RELAYS,
  IDENTITY_MINT_STATE_EXPANSION_FEE,
  classifyReservedHandle,
  normalizeCanonicalHandle,
  normalizeIdentityRelays,
} from "./constants.js";
import {
  buildControllerLinkMessage,
  buildHandleAttestationMessage,
  buildHandleReassignMessage,
  buildIdentityLinkOperation,
  buildIdentityMintOperation,
  buildIdentityRevokeOperation,
  buildIdentityRotateAccountOperation,
  buildIdentityRotateOperation,
  buildIdentityUnlinkOperation,
  buildIdentityUpdateOperation,
  buildNostrProofMessage,
  buildOldChainLinkMessage,
  buildRotateAccountMessage,
  buildSelfUnlinkMessage,
  buildValidatorLinkMessage,
  computeHandleReservationCommitment,
  computeIdentityLinkId,
} from "./payload-builder.js";
import {
  createIdentityRegistrar,
  parseCustomNip05Identifier,
  verifyCustomNip05,
} from "./registrar.js";
import {
  mergeChainBackedNostrDirectory,
  resolveChainBackedWellKnownDirectory,
} from "./nip05-responder.js";
import { createMemoryIdentityStore } from "./store.js";
import { createIdentityRouteHandler } from "./routes.js";
import { identityRoutePolicies } from "./route-policies.js";
import { validateJsonDocument } from "../request-validation.js";

const ALICE_L1 = "pf1111111111111111111111111111111111111111";
const BOB_L1 = "pf2222222222222222222222222222222222222222";
const HOT_REGISTRAR = "pf3333333333333333333333333333333333333333";
const COLD_1 = "pf4444444444444444444444444444444444444444";
const COLD_2 = "pf5555555555555555555555555555555555555555";
const COLD_3 = "pf6666666666666666666666666666666666666666";
const V1_NPUB_HEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const V2_NPUB_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const BIP340_SIG = "ab".repeat(64);
const AVATAR_NFT_ID = "cd".repeat(48);
const XWING_KEY = "ef".repeat(1216);
const LINK_ID = "12".repeat(48);

function makeJsonResponseCapture() {
  let captured = null;
  const json = (_res, status, body, headers = {}) => {
    captured = { status, body, headers };
  };
  return {
    json,
    get result() {
      return captured;
    },
  };
}

test("reserved handle classification protects goodalexander, hive-board, and system names", () => {
  assert.deepEqual(classifyReservedHandle("@GoodAlexander"), {
    valid: true,
    handle: "goodalexander",
    reserved: true,
    category: "founder",
  });
  assert.deepEqual(classifyReservedHandle("hive-board"), {
    valid: true,
    handle: "hive-board",
    reserved: true,
    category: "agent",
  });
  for (const name of ["admin", "postfiat", "tasknode", "registrar", "relay", "navcoin", "treasury", "root"]) {
    const info = classifyReservedHandle(name);
    assert.equal(info.reserved, true, `${name} must be reserved`);
    assert.equal(info.category, "system");
  }
  assert.deepEqual(classifyReservedHandle("alice_01"), {
    valid: true,
    handle: "alice_01",
    reserved: false,
    category: "open",
  });
  // Leading/trailing punctuation and length bounds rejected.
  assert.equal(normalizeCanonicalHandle("a"), "");
  assert.equal(normalizeCanonicalHandle("-alice"), "");
  assert.equal(normalizeCanonicalHandle("alice."), "");
  assert.equal(normalizeCanonicalHandle("a".repeat(33)), "");
});

test("registrar enforces reserved handles, preserves v1 npub by default, and checks salted commitments", async () => {
  const store = createMemoryIdentityStore();
  const registrar = createIdentityRegistrar({
    founderAccountIds: ["acct-founder"],
    agentAccountIds: ["acct-agent"],
    hotRegistrarAccount: HOT_REGISTRAR,
    hotRegistrarPubkeyHex: "aa".repeat(32),
    hotSignAttestation: async (msg) => `sig:${msg.length}`.padEnd(128, "0").replace(/[^0-9a-f]/g, "a"),
    coldSigners: [COLD_1, COLD_2, COLD_3],
    store,
  });

  // Non-founder cannot reserve goodalexander.
  const deniedFounder = await registrar.reserveHandle({
    accountId: "acct-random",
    l1Account: BOB_L1,
    handle: "goodalexander",
    requestedNostrPubkeyHex: V2_NPUB_HEX,
  });
  assert.equal(deniedFounder.ok, false);
  assert.equal(deniedFounder.status, 409);
  assert.equal(deniedFounder.error, "identity_handle_reserved");
  assert.equal(deniedFounder.reservedCategory, "founder");

  // Agent handle requires authorized agent account AND identityKind === "agent".
  const deniedAgentHuman = await registrar.reserveHandle({
    accountId: "acct-agent",
    l1Account: BOB_L1,
    handle: "hive-board",
    requestedNostrPubkeyHex: V2_NPUB_HEX,
    identityKind: "human",
  });
  assert.equal(deniedAgentHuman.ok, false);
  assert.equal(deniedAgentHuman.error, "identity_handle_reserved");

  const allowedAgent = await registrar.reserveHandle({
    accountId: "acct-agent",
    l1Account: BOB_L1,
    handle: "hive-board",
    requestedNostrPubkeyHex: V2_NPUB_HEX,
    identityKind: "agent",
  });
  assert.equal(allowedAgent.ok, true);
  assert.equal(allowedAgent.reservation.nip05, "hive-board@tasknode.postfiat.org");
  assert.equal(allowedAgent.reservation.derivationVersion, 2);

  // System names are never reservable by anyone.
  const deniedSystem = await registrar.reserveHandle({
    accountId: "acct-founder",
    l1Account: ALICE_L1,
    handle: "registrar",
    existingV1NostrPubkeyHex: V1_NPUB_HEX,
  });
  assert.equal(deniedSystem.ok, false);
  assert.equal(deniedSystem.reservedCategory, "system");

  // Founder reserves goodalexander preserving v1 npub intact (even if requestedNostrPubkeyHex differs).
  const founderRes = await registrar.reserveHandle({
    accountId: "acct-founder",
    l1Account: ALICE_L1,
    handle: "goodalexander",
    existingV1NostrPubkeyHex: V1_NPUB_HEX,
    requestedNostrPubkeyHex: V2_NPUB_HEX,
    optIntoV2: false,
  });
  assert.equal(founderRes.ok, true);
  assert.equal(founderRes.reservation.nostrPubkeyHex, V1_NPUB_HEX);
  assert.equal(founderRes.reservation.derivationVersion, 1);
  assert.equal(founderRes.reservation.preservedV1Npub, true);
  assert.equal(
    founderRes.reservation.commitmentHash,
    computeHandleReservationCommitment({
      handle: "goodalexander",
      nostrPubkeyHex: V1_NPUB_HEX,
      secretSaltHex: founderRes.reservation.reservationSaltHex,
    }),
  );

  // Hot attestation fails with wrong salt, succeeds with exact salt.
  const badSaltAttest = await registrar.issueHotHandleAttestation({
    accountId: "acct-founder",
    account: ALICE_L1,
    handle: "goodalexander",
    nostrPubkeyHex: V1_NPUB_HEX,
    reservationSaltHex: "ff".repeat(24),
    currentHeight: 100,
  });
  assert.equal(badSaltAttest.ok, false);
  assert.equal(badSaltAttest.error, "identity_handle_reservation_mismatch");

  const goodAttest = await registrar.issueHotHandleAttestation({
    accountId: "acct-founder",
    account: ALICE_L1,
    handle: "goodalexander",
    nostrPubkeyHex: V1_NPUB_HEX,
    reservationSaltHex: founderRes.reservation.reservationSaltHex,
    currentHeight: 100,
  });
  assert.equal(goodAttest.ok, true);
  assert.equal(goodAttest.hotAttestationOnly, true);
  assert.equal(goodAttest.attestation.handle, "goodalexander");
  assert.equal(goodAttest.attestation.expires_at_height, 3_700);
  assert.ok(goodAttest.signingMessage.startsWith("postfiat-l1-v2/handle-attestation/v1\n"));

  // Existing user can opt straight into v2 on claim when optIntoV2 === true.
  const v2OptIn = await registrar.reserveHandle({
    accountId: "acct-bob",
    l1Account: BOB_L1,
    handle: "bob_builder",
    existingV1NostrPubkeyHex: V1_NPUB_HEX,
    requestedNostrPubkeyHex: V2_NPUB_HEX,
    optIntoV2: true,
  });
  assert.equal(v2OptIn.ok, true);
  assert.equal(v2OptIn.reservation.nostrPubkeyHex, V2_NPUB_HEX);
  assert.equal(v2OptIn.reservation.derivationVersion, 2);
  assert.equal(v2OptIn.reservation.preservedV1Npub, false);

  // Compromised pubkeys are permanently blocked from reservation.
  await store.markCompromisedNostrPubkey(V2_NPUB_HEX);
  const compromisedAttempt = await registrar.reserveHandle({
    accountId: "acct-carol",
    l1Account: BOB_L1,
    handle: "carol",
    requestedNostrPubkeyHex: V2_NPUB_HEX,
  });
  assert.equal(compromisedAttempt.ok, false);
  assert.equal(compromisedAttempt.error, "identity_nostr_pubkey_compromised");

  // Retired handle holdback blocks hot attestation until holdback height passes.
  await store.setHandleHoldbackUntil({ handle: "retired_handle", untilHeight: 900_000 });
  const holdbackCheck = await registrar.inspectHandle({ handle: "retired_handle", currentHeight: 500_000 });
  assert.equal(holdbackCheck.available, false);
  assert.equal(holdbackCheck.error, "identity_handle_in_holdback");
});

test("2-of-3 cold multisig handle reassignment enforces quorum and 7-day timelock", () => {
  const store = createMemoryIdentityStore();
  const registrar = createIdentityRegistrar({
    coldSigners: [COLD_1, COLD_2, COLD_3],
    store,
  });

  // Single signer or duplicate signer fails quorum.
  const insufficient = registrar.validateColdReassignmentProposal({
    handle: "alice",
    fromAccount: ALICE_L1,
    toAccount: BOB_L1,
    reasonCode: "lost_key",
    approvals: [
      { signer_account: COLD_1, public_key_hex: "aa", signature_hex: "bb" },
      { signer_account: COLD_1, public_key_hex: "aa", signature_hex: "bb" },
    ],
    proposedAtHeight: 1000,
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.error, "identity_reassign_insufficient_quorum");

  // Valid 2-of-3 enforces >= 7d timelock and allows owner cancel.
  const normal = registrar.validateColdReassignmentProposal({
    handle: "alice",
    fromAccount: ALICE_L1,
    toAccount: BOB_L1,
    reasonCode: "lost_key",
    emergencyCompromise: false,
    approvals: [
      { signer_account: COLD_1, public_key_hex: "aa", signature_hex: "bb" },
      { signer_account: COLD_2, public_key_hex: "cc", signature_hex: "dd" },
    ],
    proposedAtHeight: 1000,
    timelockBlocks: 10, // Below minimum -> clamped up to 604_800.
  });
  assert.equal(normal.ok, true);
  assert.equal(normal.quorumCount, 2);
  assert.equal(normal.effectiveAtHeight, 1000 + IDENTITY_HANDLE_REASSIGN_MIN_TIMELOCK_BLOCKS);
  assert.equal(normal.ownerCanCancel, true);

  // Emergency compromise takes effect immediately without owner cancel.
  const emergency = registrar.validateColdReassignmentProposal({
    handle: "alice",
    fromAccount: ALICE_L1,
    toAccount: BOB_L1,
    reasonCode: "emergency_compromise",
    emergencyCompromise: true,
    approvals: [
      { signer_account: COLD_2, public_key_hex: "aa", signature_hex: "bb" },
      { signer_account: COLD_3, public_key_hex: "cc", signature_hex: "dd" },
    ],
    proposedAtHeight: 5000,
  });
  assert.equal(emergency.ok, true);
  assert.equal(emergency.effectiveAtHeight, 5000);
  assert.equal(emergency.ownerCanCancel, false);
});

test("custom NIP-05 verification supports HTTPS well-known, DNS TXT fallback, and SSRF protections", async () => {
  assert.equal(
    parseCustomNip05Identifier("alice@tasknode.postfiat.org").error,
    "identity_custom_nip05_primary_namespace_disallowed",
  );
  for (const unsafe of ["a@localhost", "a@127.0.0.1", "a@10.0.0.1", "a@169.254.169.254", "a@foo.internal"]) {
    assert.equal(parseCustomNip05Identifier(unsafe).ok, false, `${unsafe} must be blocked`);
  }

  // Successful HTTPS /.well-known/nostr.json verification.
  const okHttps = await verifyCustomNip05({
    identifier: "alice@example.org",
    expectedNostrPubkeyHex: V1_NPUB_HEX,
    fetchImpl: async (url) => {
      assert.equal(url, "https://example.org/.well-known/nostr.json?name=alice");
      return {
        ok: true,
        redirected: false,
        headers: { get: () => "120" },
        text: async () => JSON.stringify({
          names: { alice: V1_NPUB_HEX },
          relays: { [V1_NPUB_HEX]: [FIRST_PARTY_NOSTR_RELAY] },
        }),
      };
    },
  });
  assert.equal(okHttps.ok, true);
  assert.equal(okHttps.method, "well_known_https");
  assert.equal(okHttps.consensusVerified, false);

  // Pubkey mismatch rejected.
  const mismatch = await verifyCustomNip05({
    identifier: "alice@example.org",
    expectedNostrPubkeyHex: V1_NPUB_HEX,
    fetchImpl: async () => ({
      ok: true,
      redirected: false,
      headers: { get: () => "100" },
      text: async () => JSON.stringify({ names: { alice: V2_NPUB_HEX } }),
    }),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "identity_custom_nip05_pubkey_mismatch");

  // DNS TXT fallback when HTTPS fails.
  const okDns = await verifyCustomNip05({
    identifier: "alice@example.org",
    expectedNostrPubkeyHex: V1_NPUB_HEX,
    fetchImpl: async () => { throw new Error("network_down"); },
    dnsTxtResolver: async (host) => {
      assert.equal(host, "_nip05.example.org");
      return [[`alice=${V1_NPUB_HEX}`]];
    },
  });
  assert.equal(okDns.ok, true);
  assert.equal(okDns.method, "dns_txt");
});

test("identity_set payload builder covers all 7 Train B actions, fees, caps, and kill-switch flags", () => {
  // 1. Mint
  const mint = buildIdentityMintOperation({
    account: ALICE_L1,
    nostrPubkeyHex: V1_NPUB_HEX,
    nostrProofSigHex: BIP340_SIG,
    derivationVersion: 1,
    keyIndex: 0,
    identityKind: "human",
    relays: [FIRST_PARTY_NOSTR_RELAY, "wss://nos.lol"],
    avatarNftId: AVATAR_NFT_ID,
    messageKey: XWING_KEY,
    pqReceiveAddress: "pfpq1exampleaddress",
  });
  assert.equal(mint.operation.operation, "identity_set");
  assert.equal(mint.operation.payload.action, "mint");
  assert.equal(mint.stateExpansionFeeAtoms, IDENTITY_MINT_STATE_EXPANSION_FEE);
  assert.equal(mint.orderedConsensusRequired, true);
  assert.equal(mint.fastPayAllowed, false);

  // Relay cap (> 5 rejected, non-wss rejected).
  assert.throws(
    () => buildIdentityMintOperation({
      account: ALICE_L1,
      nostrPubkeyHex: V1_NPUB_HEX,
      relays: Array.from({ length: IDENTITY_MAX_RELAYS + 1 }, (_, i) => `wss://r${i}.example.org`),
    }),
    (err) => err.code === "identity_invalid_relays",
  );
  assert.deepEqual(normalizeIdentityRelays(["http://bad.example", FIRST_PARTY_NOSTR_RELAY]), [FIRST_PARTY_NOSTR_RELAY]);

  // 2. Update (works under classical kill-switch)
  const update = buildIdentityUpdateOperation({
    account: ALICE_L1,
    relays: [FIRST_PARTY_NOSTR_RELAY],
    avatarNftId: null,
  });
  assert.equal(update.operation.payload.action, "update");
  assert.equal(update.operation.payload.avatar_nft_id, null);
  assert.equal(update.worksUnderClassicalKillSwitch, true);

  // 3. Link (validator consensus-verified vs custom_nip05 client-verified, max 16 cap)
  const valLink = buildIdentityLinkOperation({
    account: ALICE_L1,
    kind: "validator_node",
    target: "validator-01",
    existingLinkCount: 15,
  });
  assert.equal(valLink.consensusVerified, true);
  assert.equal(valLink.stateExpansionFeeAtoms, IDENTITY_LINK_STATE_EXPANSION_FEE);
  assert.equal(valLink.worksUnderClassicalKillSwitch, true);

  const oldChainLink = buildIdentityLinkOperation({
    account: ALICE_L1,
    kind: "old_chain_account",
    target: "rOldChainWallet123",
  });
  assert.equal(oldChainLink.worksUnderClassicalKillSwitch, false);

  assert.throws(
    () => buildIdentityLinkOperation({
      account: ALICE_L1,
      kind: "custom_nip05",
      target: "alice@example.org",
      existingLinkCount: IDENTITY_MAX_LINKS,
    }),
    (err) => err.code === "identity_link_limit_exceeded",
  );

  // 4. Unlink (commits strictly to link_id)
  const unlink = buildIdentityUnlinkOperation({ account: ALICE_L1, linkId: LINK_ID });
  assert.equal(unlink.operation.payload.action, "unlink");
  assert.equal(unlink.operation.payload.link_id, LINK_ID);
  assert.equal(unlink.worksUnderClassicalKillSwitch, true);

  // 5. Rotate (planned vs compromised)
  const planned = buildIdentityRotateOperation({
    account: ALICE_L1,
    mode: "planned",
    newNostrPubkeyHex: V2_NPUB_HEX,
    newNostrProofSigHex: BIP340_SIG,
    derivationVersion: 2,
    keyIndex: 1,
  });
  assert.equal(planned.tombstonesOldPubkey, false);
  assert.equal(planned.preservesHandleAndLinks, true);

  const compromised = buildIdentityRotateOperation({
    account: ALICE_L1,
    mode: "compromised",
    newNostrPubkeyHex: V2_NPUB_HEX,
    newNostrProofSigHex: BIP340_SIG,
  });
  assert.equal(compromised.tombstonesOldPubkey, true);
  assert.equal(compromised.preservesHandleAndLinks, false);

  // 6. RotateAccount (destination co-sig required + pending reconfirmation)
  const rotateAcct = buildIdentityRotateAccountOperation({
    account: ALICE_L1,
    newAccount: BOB_L1,
    newAccountPubkeyHex: "aa",
    newAccountSigHex: "bb",
  });
  assert.equal(rotateAcct.requiresDestinationCosignature, true);
  assert.deepEqual(rotateAcct.linksPendingReconfirmation, ["validator_node", "agent_controller"]);
  assert.equal(rotateAcct.worksUnderClassicalKillSwitch, true);

  // 7. Revoke
  const revoke = buildIdentityRevokeOperation({ account: ALICE_L1, reasonCode: "key_retired" });
  assert.equal(revoke.stripsBadgesImmediately, true);
  assert.equal(revoke.worksUnderClassicalKillSwitch, true);

  // Domain-separated signing messages & deterministic link ID
  const linkId = computeIdentityLinkId({ account: ALICE_L1, kind: "validator_node", target: "val-1", sequence: 2 });
  assert.equal(linkId.length, 96);
  assert.ok(buildNostrProofMessage({ action: "mint", chainId: "devnet-2", account: ALICE_L1, sequence: 1 }).includes("postfiat-l1-v2/identity-nostr/v1"));
  assert.ok(buildValidatorLinkMessage({ chainId: "devnet-2", account: ALICE_L1, nodeId: "val-1", sequence: 2 }).includes("postfiat-l1-v2/identity-link/v1"));
  assert.ok(buildOldChainLinkMessage({ chainId: "devnet-2", account: ALICE_L1, oldChainAccount: "r123", sequence: 2 }).includes("postfiat-l1-v2/identity-old-chain/v1"));
  assert.ok(buildControllerLinkMessage({ chainId: "devnet-2", account: ALICE_L1, controllerAccount: BOB_L1, sequence: 2 }).includes("postfiat-l1-v2/identity-controller/v1"));
  assert.ok(buildSelfUnlinkMessage({ chainId: "devnet-2", account: ALICE_L1, linkId }).includes("postfiat-l1-v2/identity-unlink/v1"));
  assert.ok(buildRotateAccountMessage({ chainId: "devnet-2", oldAccount: ALICE_L1, newAccount: BOB_L1, identitySequence: 3 }).includes("postfiat-l1-v2/identity-rotate-account/v1"));
  assert.ok(buildHandleAttestationMessage({ chainId: "devnet-2", handle: "alice", account: ALICE_L1, expiresAtHeight: 100 }).includes("postfiat-l1-v2/handle-attestation/v1"));
  assert.ok(buildHandleReassignMessage({ chainId: "devnet-2", handle: "alice", fromAccount: ALICE_L1, toAccount: BOB_L1, reasonCode: "lost_key", emergencyCompromise: false }).includes("postfiat-l1-v2/handle-reassign/v1"));
});

test("chain-backed NIP-05 responder preserves unminted v1, overlays minted badges, and strips revoked/compromised", async () => {
  const legacyDirectory = {
    names: {
      unminted_user: V1_NPUB_HEX,
      goodalexander: V1_NPUB_HEX,
      revoked_user: V2_NPUB_HEX,
    },
    relays: {
      [V1_NPUB_HEX]: ["wss://nos.lol"],
      [V2_NPUB_HEX]: ["wss://nos.lol"],
    },
    profiles: {
      [V1_NPUB_HEX]: { displayName: "Legacy User" },
      [V2_NPUB_HEX]: { displayName: "Revoked User" },
    },
  };

  const merged = mergeChainBackedNostrDirectory({
    legacyDirectory,
    namespace: DEFAULT_IDENTITY_NAMESPACE,
    onChainIdentities: [
      {
        account: ALICE_L1,
        nostr_pubkey: V1_NPUB_HEX,
        derivation_version: 1,
        identity_kind: "human",
        registered_namespace: DEFAULT_IDENTITY_NAMESPACE,
        handle: "goodalexander",
        status: "active",
        relays: [FIRST_PARTY_NOSTR_RELAY],
        links: [
          { kind: "validator_node", target: "val-01", consensus_verified: true, status: "active" },
          { kind: "old_chain_account", target: "rOld", consensus_verified: true, status: "active" },
          { kind: "custom_nip05", target: "alex@example.com", consensus_verified: false, status: "active" },
        ],
      },
      {
        account: BOB_L1,
        nostr_pubkey: V2_NPUB_HEX,
        registered_namespace: DEFAULT_IDENTITY_NAMESPACE,
        handle: "revoked_user",
        status: "revoked",
      },
    ],
  });

  // Unminted v1 preserved.
  assert.equal(merged.names.unminted_user, V1_NPUB_HEX);
  // Minted user gets chain-verified badges and first-party relay.
  assert.equal(merged.names.goodalexander, V1_NPUB_HEX);
  assert.equal(merged.profiles[V1_NPUB_HEX].onChainVerified, true);
  assert.deepEqual(merged.profiles[V1_NPUB_HEX].badges, ["Minted", "Validator · val-01", "Old chain"]);
  assert.deepEqual(merged.relays[V1_NPUB_HEX], [FIRST_PARTY_NOSTR_RELAY]);
  // Revoked user is immediately stripped.
  assert.equal(merged.names.revoked_user, undefined);
  assert.equal(merged.profiles[V2_NPUB_HEX], undefined);

  // Live lookup wrapper handles compromised pubkey flag safely.
  const liveResolved = await resolveChainBackedWellKnownDirectory({
    name: "unminted_user",
    getLegacyDirectory: async () => legacyDirectory,
    getOnChainIdentities: async () => [],
    lookupHandleOnChain: async () => ({
      found: true,
      compromised_nostr_pubkey: true,
      identity: { nostr_pubkey: V1_NPUB_HEX, handle: "unminted_user", status: "active", registered_namespace: DEFAULT_IDENTITY_NAMESPACE },
    }),
  });
  assert.deepEqual(liveResolved.names, {});
});

test("identity HTTP route handler enforces auth, policies, and end-to-end flows", async () => {
  const store = createMemoryIdentityStore();
  const registrar = createIdentityRegistrar({
    founderAccountIds: ["acct-founder"],
    hotRegistrarAccount: HOT_REGISTRAR,
    hotRegistrarPubkeyHex: "aa".repeat(32),
    hotSignAttestation: async () => "bb".repeat(64),
    store,
  });
  const handler = createIdentityRouteHandler({
    registrar,
    store,
    getLegacyV1Identity: async () => ({
      nostrPubkeyHex: V1_NPUB_HEX,
      npub: "npub1example",
      nip05: "goodalexander@tasknode.postfiat.org",
      preferredRelays: [FIRST_PARTY_NOSTR_RELAY],
    }),
    fetchImpl: async () => ({
      ok: true,
      redirected: false,
      headers: { get: () => "90" },
      text: async () => JSON.stringify({ names: { alex: V1_NPUB_HEX } }),
    }),
  });

  // Unauthenticated /api/identity/check-handle allowed (auth: optional).
  const checkCap = makeJsonResponseCapture();
  const handledCheck = await handler({
    json: checkCap.json,
    readJson: async () => ({}),
    req: { method: "GET" },
    res: {},
    session: null,
    url: new URL("http://localhost/api/identity/check-handle?handle=goodalexander"),
  });
  assert.equal(handledCheck, true);
  assert.equal(checkCap.result.status, 200);
  assert.equal(checkCap.result.body.available, false);
  assert.equal(checkCap.result.body.reservedCategory, "founder");

  // Unauthenticated /api/identity/status rejected with 401.
  const unauthCap = makeJsonResponseCapture();
  await handler({
    json: unauthCap.json,
    readJson: async () => ({}),
    req: { method: "GET" },
    res: {},
    session: null,
    url: new URL("http://localhost/api/identity/status"),
  });
  assert.equal(unauthCap.result.status, 401);

  // Authenticated reserve -> attest -> build-tx -> custom-nip05/verify.
  const reserveBody = { handle: "goodalexander", l1Account: ALICE_L1, optIntoV2: false };
  const reservePolicy = identityRoutePolicies.find((p) => p.id === "identity_handle_reserve");
  assert.doesNotThrow(() => validateJsonDocument(reserveBody, reservePolicy.body.schema));
  const resCap = makeJsonResponseCapture();
  await handler({
    json: resCap.json,
    readJson: async () => reserveBody,
    req: { method: "POST" },
    res: {},
    session: { accountId: "acct-founder" },
    url: new URL("http://localhost/api/identity/reserve"),
  });
  assert.equal(resCap.result.status, 200);
  assert.equal(resCap.result.body.reservation.preservedV1Npub, true);

  const buildBody = {
    action: "mint",
    account: ALICE_L1,
    nostrPubkeyHex: V1_NPUB_HEX,
    derivationVersion: 1,
    reservationSaltHex: resCap.result.body.reservation.reservationSaltHex,
    relays: [FIRST_PARTY_NOSTR_RELAY],
  };
  const buildPolicy = identityRoutePolicies.find((p) => p.id === "identity_build_tx");
  assert.doesNotThrow(() => validateJsonDocument(buildBody, buildPolicy.body.schema));
  const buildCap = makeJsonResponseCapture();
  await handler({
    json: buildCap.json,
    readJson: async () => buildBody,
    req: { method: "POST" },
    res: {},
    session: { accountId: "acct-founder" },
    url: new URL("http://localhost/api/identity/build-tx"),
  });
  assert.equal(buildCap.result.status, 200);
  assert.equal(buildCap.result.body.operation.operation, "identity_set");
  assert.ok(buildCap.result.body.signingMessages.nostrProof.includes("action=mint"));

  const verifyBody = { identifier: "alex@example.org", nostrPubkeyHex: V1_NPUB_HEX, account: ALICE_L1 };
  const verifyPolicy = identityRoutePolicies.find((p) => p.id === "identity_custom_nip05_verify");
  assert.doesNotThrow(() => validateJsonDocument(verifyBody, verifyPolicy.body.schema));
  const verifyCap = makeJsonResponseCapture();
  await handler({
    json: verifyCap.json,
    readJson: async () => verifyBody,
    req: { method: "POST" },
    res: {},
    session: { accountId: "acct-founder" },
    url: new URL("http://localhost/api/identity/custom-nip05/verify"),
  });
  assert.equal(verifyCap.result.status, 200);
  assert.equal(verifyCap.result.body.verification.verified, true);
  assert.equal(verifyCap.result.body.linkTx.operation.payload.kind, "custom_nip05");
});
