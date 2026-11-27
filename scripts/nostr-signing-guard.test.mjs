import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { getPublicKey } from "nostr-tools/pure";
import {
  deriveWalletSummary,
  generateTaskNodeMnemonic,
  signWalletChallenge,
  validateWalletChallengeMessage,
} from "../src/wallet-core.js";
import {
  computeCollaborationPayloadDigest,
  signedCollaborationProof,
} from "../src/features/collaboration/collaboration-client.js";
import {
  buildNostrDerivationMessage,
  createDirectMessageEvents,
  deriveNostrMessagingIdentity,
  normalizeMessageRelays,
} from "../src/features/messages/nostr-messages.js";
import {
  buildSigningReviewSummary,
  escapeNostrText,
  isChainBadgeValidForEvent,
  signGuardedNostrEvent,
  validateHiveMindClaimSignaturePayload,
  validateIdentitySetProofPayload,
  validateRelayUrl,
  verifyInboundNostrEvent,
} from "../shared/nostr-signing-guard.js";
import { createHiveGroupEvent } from "../shared/hive-group.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeValidCollaborationMessage({ action, resourceId, accountId, walletAddress, payloadDigest, nonce = "nonce-123", expiresAt }) {
  return [
    "Task Node collaboration authorization",
    `Action: ${action}`,
    `Resource: ${resourceId || "new"}`,
    `Account: ${accountId}`,
    `Wallet: ${walletAddress}`,
    `Payload SHA-256: ${payloadDigest}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

test("wallet-core signWalletChallenge fails closed when purpose is missing or unknown", () => {
  const mnemonic = generateTaskNodeMnemonic();
  assert.throws(
    () => signWalletChallenge(mnemonic, "Arbitrary phishing message"),
    (error) => error.code === "SIGNING_GUARD_UNKNOWN_PURPOSE"
  );
  assert.throws(
    () => signWalletChallenge(mnemonic, "Arbitrary message", { purpose: "custom_unlisted" }),
    (error) => error.code === "SIGNING_GUARD_UNKNOWN_PURPOSE"
  );
});

test("signedCollaborationProof accepts a valid collaboration challenge matching local digest, account, and wallet", async () => {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const now = Date.now();
  const expiresAt = new Date(now + 60_000).toISOString();
  const payload = { nostrPubkeyHex: "a".repeat(64), visibility: "public" };
  const { digest } = await computeCollaborationPayloadDigest({
    action: "nostr_bind",
    resourceId: "acct_alice",
    payload,
  });
  const message = makeValidCollaborationMessage({
    action: "nostr_bind",
    resourceId: "acct_alice",
    accountId: "acct_alice",
    walletAddress: wallet.address,
    payloadDigest: digest,
    expiresAt,
  });

  const proof = await signedCollaborationProof({
    action: "nostr_bind",
    resourceId: "acct_alice",
    payload,
    accountId: "acct_alice",
    walletSecret: { mnemonic, accountId: "acct_alice" },
    now,
    requestImpl: async () => ({
      ok: true,
      body: { challenge: { id: "chal-1", message } },
    }),
  });

  assert.equal(proof.challengeId, "chal-1");
  assert.equal(proof.publicKey, wallet.publicKey);
  assert.ok(proof.signature.length >= 64);
});

test("signedCollaborationProof blocks Nostr v1 derivation spoofing including BOM, whitespace, NFKC, and Cyrillic homoglyphs", async () => {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const genuineDerivation = buildNostrDerivationMessage({ accountId: "acct_victim", walletAddress: wallet.address });

  const hostilePayloads = [
    genuineDerivation,
    `\uFEFF${genuineDerivation}`,
    `   \n${genuineDerivation}`,
    // Unicode NFKC fullwidth trick
    `\uFF34ask Node private messaging identity\nVersion: 1\nAccount: acct_victim\nWallet: ${wallet.address}\nPurpose: tasknode.private-messages.v1\nThis signature derives a local Nostr key. It is not a transaction.`,
    // Cyrillic 'а' (U+0430) and 'е' (U+0435) homoglyph trick
    `T\u0430sk Nod\u0435 priv\u0430t\u0435 m\u0435ss\u0430ging id\u0435ntity\nVersion: 1\nAccount: acct_victim`,
    // Embedded inside another line
    `Task Node collaboration authorization\nAction: Task Node private messaging identity\nResource: new`,
  ];

  for (const hostileMessage of hostilePayloads) {
    await assert.rejects(
      () => signedCollaborationProof({
        action: "nostr_bind",
        resourceId: "acct_victim",
        payload: { test: 1 },
        accountId: "acct_victim",
        walletSecret: { mnemonic, accountId: "acct_victim" },
        requestImpl: async () => ({
          ok: true,
          body: { challenge: { id: "hostile-chal", message: hostileMessage } },
        }),
      }),
      (error) => error.code === "SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX",
      `Hostile challenge must be rejected with SIGNING_GUARD_FORBIDDEN_DERIVATION_PREFIX: ${JSON.stringify(hostileMessage.slice(0, 40))}`
    );
  }
});

test("signedCollaborationProof throws SIGNING_GUARD_PREFIX_MISMATCH on unknown prefix, mismatched digest, or expired challenge", async () => {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const now = Date.now();
  const expiresAt = new Date(now + 60_000).toISOString();
  const payload = { value: "expected" };
  const { digest } = await computeCollaborationPayloadDigest({
    action: "team_invite",
    resourceId: "team-1",
    payload,
  });

  // 1. Unrecognized prefix
  await assert.rejects(
    () => signedCollaborationProof({
      action: "team_invite",
      resourceId: "team-1",
      payload,
      walletSecret: { mnemonic },
      now,
      requestImpl: async () => ({
        ok: true,
        body: { challenge: { id: "c1", message: "Unknown arbitrary server message\nFoo: bar" } },
      }),
    }),
    (error) => error.code === "SIGNING_GUARD_PREFIX_MISMATCH"
  );

  // 2. Tampered Payload SHA-256
  const wrongDigestMsg = makeValidCollaborationMessage({
    action: "team_invite",
    resourceId: "team-1",
    accountId: "acct_1",
    walletAddress: wallet.address,
    payloadDigest: "f".repeat(64),
    expiresAt,
  });
  await assert.rejects(
    () => signedCollaborationProof({
      action: "team_invite",
      resourceId: "team-1",
      payload,
      accountId: "acct_1",
      walletSecret: { mnemonic },
      now,
      requestImpl: async () => ({
        ok: true,
        body: { challenge: { id: "c2", message: wrongDigestMsg } },
      }),
    }),
    (error) => error.code === "SIGNING_GUARD_PREFIX_MISMATCH"
  );

  // 3. Expired challenge
  const expiredMsg = makeValidCollaborationMessage({
    action: "team_invite",
    resourceId: "team-1",
    accountId: "acct_1",
    walletAddress: wallet.address,
    payloadDigest: digest,
    expiresAt: new Date(now - 10_000).toISOString(),
  });
  await assert.rejects(
    () => signedCollaborationProof({
      action: "team_invite",
      resourceId: "team-1",
      payload,
      accountId: "acct_1",
      walletSecret: { mnemonic },
      now,
      requestImpl: async () => ({
        ok: true,
        body: { challenge: { id: "c3", message: expiredMsg } },
      }),
    }),
    (error) => error.code === "SIGNING_GUARD_PREFIX_MISMATCH"
  );
});

test("deriveNostrMessagingIdentity preserves deterministic v1 npub continuity and never accepts arbitrary templates", async () => {
  const id1 = await deriveNostrMessagingIdentity({
    accountId: "account_v1_continuity",
    walletSecret: { mnemonic: TEST_MNEMONIC },
  });
  const id2 = await deriveNostrMessagingIdentity({
    accountId: "account_v1_continuity",
    walletSecret: { mnemonic: TEST_MNEMONIC },
  });
  assert.equal(id1.npub, id2.npub);
  assert.equal(id1.publicKeyHex, id2.publicKeyHex);
  assert.ok(id1.npub.startsWith("npub1"));

  // Direct nostr_v1_derivation guard rejects tampered templates
  assert.throws(
    () => validateWalletChallengeMessage("Task Node private messaging identity\nArbitrary: tamper", {
      purpose: "nostr_v1_derivation",
      walletAddress: id1.walletAddress,
      expectedAccountId: "account_v1_continuity",
    }),
    (error) => error.code === "SIGNING_GUARD_PREFIX_MISMATCH"
  );
});

test("Browser Nostr signing guard enforces kind allowlist, origin/iframe/postMessage blocks, relay hygiene, non-prod kind:0 block, and human review", () => {
  const sk = randomBytes(32);
  const pk = getPublicKey(sk);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const trustedProdContext = {
    source: "hive_ui",
    userInitiated: true,
    origin: "https://tasknode.postfiat.org",
    allowedOrigins: ["https://tasknode.postfiat.org"],
    environment: "production",
    hostname: "tasknode.postfiat.org",
  };

  // 1. Blocks unlisted kinds (30078, 24133 NIP-46, 9734 zap, 27235 HTTP auth)
  for (const blockedKind of [30078, 24133, 9734, 27235, 99999]) {
    assert.throws(
      () => signGuardedNostrEvent({
        eventTemplate: { kind: blockedKind, created_at: nowSec, tags: [], content: "phish" },
        privateKey: sk,
        context: trustedProdContext,
        now,
      }),
      (error) => error.code === "NOSTR_SIGNING_GUARD_KIND_BLOCKED",
      `Unlisted kind:${blockedKind} must be blocked`
    );
  }

  // 2. Blocks postMessage, cross-origin iframe, hub-viewer.postfiat.org, clipboard, URL params
  const untrustedContexts = [
    { ...trustedProdContext, source: "postMessage" },
    { ...trustedProdContext, fromPostMessage: true },
    { ...trustedProdContext, inIframe: true },
    { ...trustedProdContext, isSrcdoc: true },
    { ...trustedProdContext, origin: "https://hub-viewer.postfiat.org" },
    { ...trustedProdContext, origin: "null" },
    { ...trustedProdContext, callerOrigin: "https://evil.example" },
    { ...trustedProdContext, fromClipboard: true },
    { ...trustedProdContext, fromUrlParam: true },
  ];
  for (const badCtx of untrustedContexts) {
    assert.throws(
      () => signGuardedNostrEvent({
        eventTemplate: { kind: 1, created_at: nowSec, tags: [], content: "hello" },
        privateKey: sk,
        context: badCtx,
        now,
      }),
      (error) => error.code === "NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN"
    );
  }

  // 3. Blocks silent/auto signing (userInitiated !== true)
  assert.throws(
    () => signGuardedNostrEvent({
      eventTemplate: { kind: 1, created_at: nowSec, tags: [], content: "silent" },
      privateKey: sk,
      context: { ...trustedProdContext, userInitiated: false },
      now,
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_SILENT_SIGNING_BLOCKED"
  );

  // 4. Blocks caller-supplied sig / id / mismatched pubkey
  assert.throws(
    () => signGuardedNostrEvent({
      eventTemplate: { kind: 1, created_at: nowSec, tags: [], content: "x", sig: "0".repeat(128) },
      privateKey: sk,
      context: trustedProdContext,
      now,
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_EXTERNAL_FIELDS_FORBIDDEN"
  );
  assert.throws(
    () => signGuardedNostrEvent({
      eventTemplate: { kind: 1, created_at: nowSec, tags: [], content: "x", pubkey: "a".repeat(64) },
      privateKey: sk,
      context: trustedProdContext,
      now,
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_EXTERNAL_FIELDS_FORBIDDEN"
  );

  // 5. Blocks kind:0 on non-production builds (dev, localhost, staging)
  for (const nonProdCtx of [
    { ...trustedProdContext, source: "settings_ui", environment: "development", reviewApproved: true },
    { ...trustedProdContext, source: "settings_ui", hostname: "localhost", origin: "http://localhost:5174", allowedOrigins: ["http://localhost:5174"], reviewApproved: true },
    { ...trustedProdContext, source: "settings_ui", hostname: "tasknodeofficial-dev.fly.dev", origin: "https://tasknodeofficial-dev.fly.dev", allowedOrigins: ["https://tasknodeofficial-dev.fly.dev"], reviewApproved: true },
  ]) {
    assert.throws(
      () => signGuardedNostrEvent({
        eventTemplate: { kind: 0, created_at: nowSec, tags: [], content: JSON.stringify({ name: "alice" }) },
        privateKey: sk,
        context: nonProdCtx,
        now,
      }),
      (error) => error.code === "NOSTR_SIGNING_GUARD_NONPROD_KIND0_BLOCKED"
    );
  }

  // 6. Enforces human-readable review guard on kind:0 and kind:10050
  assert.throws(
    () => signGuardedNostrEvent({
      eventTemplate: { kind: 0, created_at: nowSec, tags: [], content: JSON.stringify({ name: "alice" }) },
      privateKey: sk,
      context: { ...trustedProdContext, source: "settings_ui", reviewApproved: false },
      now,
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_REVIEW_REJECTED"
  );
  let capturedReview = null;
  const prodProfile = signGuardedNostrEvent({
    eventTemplate: { kind: 0, created_at: nowSec, tags: [], content: JSON.stringify({ name: "alice" }) },
    privateKey: sk,
    context: {
      ...trustedProdContext,
      source: "settings_ui",
      reviewHandler: (summary) => {
        capturedReview = summary;
        return true;
      },
    },
    now,
  });
  assert.equal(prodProfile.event.kind, 0);
  assert.equal(prodProfile.event.pubkey, pk);
  assert.equal(capturedReview.requiresExplicitReview, true);
  assert.match(capturedReview.actionSummary, /Profile Metadata/);

  // 7. Relay URL hygiene blocks ws://, http://, javascript:, >128 bytes, and prod IP-literal SSRF
  for (const badRelay of [
    "ws://relay.postfiat.org",
    "http://relay.postfiat.org",
    "https://relay.postfiat.org",
    "javascript:alert(1)",
    `wss://relay.postfiat.org/${"a".repeat(120)}`,
  ]) {
    assert.throws(
      () => validateRelayUrl(badRelay, { production: true }),
      (error) => error.code === "NOSTR_SIGNING_GUARD_INVALID_RELAY"
    );
  }
  assert.throws(
    () => validateRelayUrl("wss://127.0.0.1:7777", { production: true }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_INVALID_RELAY"
  );
  assert.deepEqual(
    normalizeMessageRelays(["ws://bad.test", "wss://relay.postfiat.org/", "wss://nos.lol"]),
    ["wss://relay.postfiat.org", "wss://nos.lol"]
  );

  // 8. NIP-42 kind:22242 enforces allowlisted relay + non-empty challenge
  const authResult = signGuardedNostrEvent({
    eventTemplate: {
      kind: 22242,
      created_at: nowSec,
      tags: [["relay", "wss://relay.postfiat.org"], ["challenge", "chal-xyz"]],
      content: "",
    },
    privateKey: sk,
    context: {
      ...trustedProdContext,
      source: "relay_auth",
      userInitiated: false,
      allowlistedRelays: ["wss://relay.postfiat.org"],
    },
    now,
  });
  assert.equal(authResult.event.kind, 22242);
  verifyInboundNostrEvent(authResult.event, { expectedKind: 22242 });

  // 9. Hive group event & DM creation respect signing guard context
  const rootId = "b".repeat(64);
  const hiveEv = createHiveGroupEvent({
    privateKey: sk,
    rootId,
    content: "Hello Hive",
    now,
    signingContext: trustedProdContext,
  });
  assert.equal(hiveEv.kind, 1);
  assert.throws(
    () => createHiveGroupEvent({
      privateKey: sk,
      rootId,
      content: "Phish via postMessage",
      now,
      signingContext: { source: "postMessage" },
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN"
  );

  const bobPk = getPublicKey(randomBytes(32));
  const dm = createDirectMessageEvents({
    privateKey: sk,
    recipientPublicKey: bobPk,
    recipientRelay: "wss://relay.postfiat.org",
    message: "Encrypted DM",
    signingContext: { origin: "https://tasknode.postfiat.org" },
  });
  assert.equal(dm.recipientCopy.kind, 1059);
  assert.throws(
    () => createDirectMessageEvents({
      privateKey: sk,
      recipientPublicKey: bobPk,
      recipientRelay: "ws://insecure.relay",
      message: "Blocked relay",
      signingContext: { origin: "https://tasknode.postfiat.org" },
    }),
    (error) => error.code === "NOSTR_SIGNING_GUARD_INVALID_RELAY"
  );

  // 10. Escaping, review summary escaping, revoked-height badge stripping, identity_set & Hive Mind payload guards
  const xssReview = buildSigningReviewSummary({ kind: 1, content: "<script>alert(1)</script>", tags: [] }, trustedProdContext);
  assert.equal(xssReview.contentPreview, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeNostrText("<b>hi</b>"), "&lt;b&gt;hi&lt;/b&gt;");
  assert.equal(isChainBadgeValidForEvent({ identityStatus: "revoked", revokedAtHeight: 100, eventAnchoredHeight: 99 }), true);
  assert.equal(isChainBadgeValidForEvent({ identityStatus: "revoked", revokedAtHeight: 100, eventAnchoredHeight: 100 }), false);
  assert.equal(isChainBadgeValidForEvent({ identityStatus: "revoked", revokedAtHeight: 100, eventAnchoredHeight: null }), false);

  const idProof = validateIdentitySetProofPayload({
    op: "mint",
    chainId: "postfiat-l1-v2",
    account: "pftl1founder",
    sequence: 0,
    nostrPubkey: pk,
    context: { origin: "https://tasknode.postfiat.org" },
  });
  assert.equal(idProof.authorizesFundMovement, false);

  const claimProof = validateHiveMindClaimSignaturePayload({
    company: "NVDA",
    claimText: "Blackwell rack shipments accelerate in Q4",
    stance: "bullish",
    checkEvent: "Q4 earnings call",
    attestationId: "mnpi-att-1",
    context: { origin: "https://tasknode.postfiat.org" },
  });
  assert.equal(claimProof.attestationId, "mnpi-att-1");
});
