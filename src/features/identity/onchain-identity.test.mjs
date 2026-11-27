import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  DEFAULT_IDENTITY_NAMESPACE,
  FIRST_PARTY_NOSTR_RELAY,
  IDENTITY_LINK_FEE_ATOMS,
  IDENTITY_MINT_FEE_ATOMS,
  buildLinkRequestPayload,
  buildMintRequestPayload,
  buildRotateRequestPayload,
  classifyHandle,
  deriveIdentityBadges,
  describeLinkKind,
  formatPftFromAtoms,
  normalizeRelayList,
} from "./onchain-identity-model.js";

const ALICE_L1 = "pf1111111111111111111111111111111111111111";
const V1_NPUB_HEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const V2_NPUB_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("onchain-identity-model classifies reserved handles, derives badges, and builds payloads", () => {
  assert.equal(classifyHandle("goodalexander").category, "founder");
  assert.equal(classifyHandle("hive-board").category, "agent");
  assert.equal(classifyHandle("admin").category, "system");
  assert.equal(classifyHandle("alice_99").reserved, false);
  assert.equal(classifyHandle("!bad!").valid, false);

  assert.equal(formatPftFromAtoms(IDENTITY_MINT_FEE_ATOMS), "0.02 PFT");
  assert.equal(formatPftFromAtoms(IDENTITY_LINK_FEE_ATOMS), "0.01 PFT");

  assert.deepEqual(
    normalizeRelayList(`http://insecure.example\n${FIRST_PARTY_NOSTR_RELAY}\nwss://nos.lol/`),
    [FIRST_PARTY_NOSTR_RELAY, "wss://nos.lol"],
  );

  // Active minted identity derives consensus-verified badges only.
  const badges = deriveIdentityBadges({
    status: "active",
    identity_kind: "agent",
    links: [
      { kind: "validator_node", target: "val-7", consensus_verified: true, status: "active" },
      { kind: "agent_controller", target: ALICE_L1, consensus_verified: true, status: "active" },
      { kind: "custom_nip05", target: "bot@example.org", consensus_verified: false, status: "active" },
    ],
  });
  assert.deepEqual(badges.map((b) => b.label), ["Minted", "Agent", "Validator · val-7", "Controller linked"]);

  // Revoked or compromised identity immediately yields zero badges.
  assert.deepEqual(deriveIdentityBadges({ status: "revoked", links: [] }), []);
  assert.deepEqual(deriveIdentityBadges({ status: "active", compromised: true, links: [] }), []);

  // Mint payload preserves v1 by default.
  const mintReq = buildMintRequestPayload({
    account: ALICE_L1,
    nostrPubkeyHex: V1_NPUB_HEX,
    preserveV1Npub: true,
  });
  assert.equal(mintReq.derivationVersion, 1);
  assert.equal(mintReq.action, "mint");

  // Rotate payload defaults to v2.
  const rotateReq = buildRotateRequestPayload({
    account: ALICE_L1,
    mode: "compromised",
    newNostrPubkeyHex: V2_NPUB_HEX,
  });
  assert.equal(rotateReq.mode, "compromised");
  assert.equal(rotateReq.derivationVersion, 2);

  // Link payload enforces max 16 links.
  assert.throws(
    () => buildLinkRequestPayload({ account: ALICE_L1, kind: "validator_node", target: "val-1", existingLinkCount: 16 }),
    /Maximum 16 links/,
  );
  assert.equal(describeLinkKind("validator_node").consensusVerified, true);
  assert.equal(describeLinkKind("custom_nip05").consensusVerified, false);
});

test("IdentityStatusCard and MintIdentityModal render cleanly across off-chain, minted, revoked, and modal tabs", async () => {
  const vite = await createServer({
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { entries: [], noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { IdentityStatusCard } = await vite.ssrLoadModule("/src/features/identity/IdentityStatusCard.jsx");
    const { MintIdentityModal } = await vite.ssrLoadModule("/src/features/identity/MintIdentityModal.jsx");

    // 1. Off-chain v1 preserved state
    const offChainHtml = renderToStaticMarkup(React.createElement(IdentityStatusCard, {
      status: {
        namespace: DEFAULT_IDENTITY_NAMESPACE,
        legacyV1: {
          nip05: "goodalexander@tasknode.postfiat.org",
          nostrPubkeyHex: V1_NPUB_HEX,
          derivationVersion: 1,
        },
        onChain: null,
        customClaims: [],
      },
    }));
    assert.ok(offChainHtml.includes("Off-chain only"));
    assert.ok(offChainHtml.includes("v1 preserved"));
    assert.ok(offChainHtml.includes("Mint Your Task Node Identity"));
    assert.ok(offChainHtml.includes("0.02 PFT"));

    // 2. Minted active state with validator link & custom claim
    const mintedHtml = renderToStaticMarkup(React.createElement(IdentityStatusCard, {
      status: {
        namespace: DEFAULT_IDENTITY_NAMESPACE,
        onChain: {
          account: ALICE_L1,
          handle: "goodalexander",
          registered_namespace: DEFAULT_IDENTITY_NAMESPACE,
          nostr_pubkey: V1_NPUB_HEX,
          derivation_version: 1,
          status: "active",
          links: [
            { link_id: "a".repeat(96), kind: "validator_node", target: "val-01", consensus_verified: true, status: "active" },
          ],
        },
        customClaims: [{ identifier: "alex@example.org" }],
      },
    }));
    assert.ok(mintedHtml.includes("Minted on chain"));
    assert.ok(mintedHtml.includes("Validator · val-01"));
    assert.ok(mintedHtml.includes("Consensus-verified"));
    assert.ok(mintedHtml.includes("alex@example.org · client-verified"));
    assert.ok(mintedHtml.includes("Rotate Nostr key"));

    // 3. Revoked state strips badges and shows alert
    const revokedHtml = renderToStaticMarkup(React.createElement(IdentityStatusCard, {
      status: {
        onChain: {
          account: ALICE_L1,
          handle: "goodalexander",
          nostr_pubkey: V1_NPUB_HEX,
          status: "revoked",
        },
      },
    }));
    assert.ok(revokedHtml.includes("Revoked"));
    assert.ok(revokedHtml.includes("badges are stripped immediately"));

    // 4. MintIdentityModal tabs (mint, rotate, links)
    const mintTabHtml = renderToStaticMarkup(React.createElement(MintIdentityModal, {
      initialTab: "mint",
      defaultAccount: ALICE_L1,
      defaultHandle: "goodalexander",
      status: {
        namespace: DEFAULT_IDENTITY_NAMESPACE,
        legacyV1: { nostrPubkeyHex: V1_NPUB_HEX, derivationVersion: 1 },
      },
    }));
    assert.ok(mintTabHtml.includes("Preserve existing v1 npub"));
    assert.ok(mintTabHtml.includes("Reserved founder handle"));
    assert.ok(mintTabHtml.includes("Prepare identity_set Mint Transaction"));

    const rotateTabHtml = renderToStaticMarkup(React.createElement(MintIdentityModal, {
      initialTab: "rotate",
      defaultAccount: ALICE_L1,
    }));
    assert.ok(rotateTabHtml.includes("Planned rotation"));
    assert.ok(rotateTabHtml.includes("Compromised rotation"));

    const linksTabHtml = renderToStaticMarkup(React.createElement(MintIdentityModal, {
      initialTab: "links",
      defaultAccount: ALICE_L1,
    }));
    assert.ok(linksTabHtml.includes("Custom NIP-05 domain"));
    assert.ok(linksTabHtml.includes("0.01 PFT"));
  } finally {
    await vite.close();
  }
});
